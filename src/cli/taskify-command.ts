/**
 * `kody taskify --ticket <ticket-id>` command handler.
 *
 * Fetches a ticket via MCP (or reads a local file) and decomposes it into
 * scoped tasks, then files each task as a GitHub issue and optionally
 * auto-triggers @kody on each.
 */

import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "url"
import { execSync } from "child_process"

import { getProjectConfig, resolveStageConfig, setConfigDir, needsLitellmProxy, anyStageNeedsProxy, getLitellmUrl, providerApiKeyEnvVar, getAnthropicApiKeyOrDummy } from "../config.js"
import { createClaudeCodeRunner } from "../agent-runner.js"
import { buildTaskifyMcpConfigJson } from "../mcp-config.js"
import {
  createIssue,
  getIssue,
  postComment,
  setLifecycleLabel,
  setGhCwd,
} from "../github-api.js"
import { logger } from "../logger.js"
import { generateTaskId } from "./task-resolution.js"
import { checkLitellmHealth, tryStartLitellm, generateLitellmConfig, generateLitellmConfigFromStages } from "./litellm.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export class TaskifyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TaskifyError"
  }
}

const AUTO_TRIGGER_THRESHOLD = 5
const MAX_TASKS_GUARD = 20
const TASKIFY_TIMEOUT_MS = 5 * 60 * 1000  // 5 minutes
const MARKER_FILE = "taskify.marker"
const RESULT_FILE = "taskify-result.json"

export interface TaskifyTask {
  title: string
  body: string
  labels?: string[]
  priority?: "high" | "medium" | "low"
  dependsOn?: number[]
}

export function topoSort(tasks: TaskifyTask[]): TaskifyTask[] {
  const n = tasks.length
  const inDegree = new Array<number>(n).fill(0)
  const adj: number[][] = Array.from({ length: n }, () => [])

  for (let i = 0; i < n; i++) {
    for (const dep of tasks[i].dependsOn ?? []) {
      if (dep >= 0 && dep < n && dep !== i) {
        adj[dep].push(i)
        inDegree[i]++
      }
    }
  }

  const queue: number[] = []
  for (let i = 0; i < n; i++) {
    if (inDegree[i] === 0) queue.push(i)
  }

  const sorted: TaskifyTask[] = []
  while (queue.length > 0) {
    const node = queue.shift()!
    sorted.push(tasks[node])
    for (const neighbor of adj[node]) {
      inDegree[neighbor]--
      if (inDegree[neighbor] === 0) queue.push(neighbor)
    }
  }

  if (sorted.length !== n) {
    logger.warn("[taskify] dependency cycle detected — falling back to original order")
    return [...tasks]
  }

  return sorted
}

export interface TaskifyResult {
  status: "ready" | "questions"
  tasks?: TaskifyTask[]
  questions?: string[]
}

export interface TaskifyOptions {
  /** Ticket ID to fetch via MCP (e.g. "ENG-42"). Mutually exclusive with prdFile. */
  ticketId?: string
  /** Path to a local PRD/spec file. Mutually exclusive with ticketId. */
  prdFile?: string
  issueNumber?: number
  feedback?: string
  local?: boolean
  projectDir: string
  taskId: string
  /** Optional runner override for testing */
  runner?: import("../types.js").AgentRunner
  /** Extra env vars to pass to the runner (e.g. ANTHROPIC_BASE_URL for LiteLLM proxy) */
  runnerEnv?: Record<string, string>
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag)
  return idx !== -1 ? args[idx + 1] : undefined
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag)
}

/**
 * Parse CLI args and env vars, then run the taskify command.
 * Called from src/bin/cli.ts.
 */
export async function runTaskifyCommand(): Promise<void> {
  const args = process.argv.slice(3)

  const cwdArg = getArg(args, "--cwd") ?? process.cwd()
  const projectDir = path.resolve(cwdArg)
  const ticketId = getArg(args, "--ticket") ?? process.env.TICKET_ID
  const prdFileArg = getArg(args, "--file") ?? process.env.PRD_FILE
  const prdFile = prdFileArg ? path.resolve(projectDir, prdFileArg) : undefined
  const issueNumberStr = getArg(args, "--issue-number") ?? process.env.ISSUE_NUMBER ?? ""
  const issueNumber = issueNumberStr ? parseInt(issueNumberStr, 10) : undefined
  const feedback = getArg(args, "--feedback") ?? process.env.FEEDBACK
  const local = hasFlag(args, "--local") || !process.env.CI

  const taskIdArg = getArg(args, "--task-id") ?? process.env.TASK_ID
  const taskId = taskIdArg ?? (issueNumber ? `taskify-${issueNumber}-${generateTaskId()}` : `taskify-${generateTaskId()}`)

  if (!ticketId && !prdFile && !issueNumber) {
    logger.error("Usage: kody taskify --ticket <ticket-id>  OR  kody taskify --file <prd.md>  OR  kody taskify --issue-number <n>")
    process.exit(1)
  }
  // If only issue-number is provided, taskify will use the issue body as the description

  if (prdFile && !fs.existsSync(prdFile)) {
    logger.error(`File not found: ${prdFile}`)
    process.exit(1)
  }

  setConfigDir(projectDir)
  setGhCwd(projectDir)

  // Start LiteLLM proxy if needed (e.g. ANTHROPIC_COMPATIBLE_API_KEY provider)
  const config = getProjectConfig()
  let litellmProcess: { kill: () => void } | null = null
  let runnerEnv: Record<string, string> | undefined
  if (anyStageNeedsProxy(config)) {
    const litellmUrl = getLitellmUrl()
    const proxyRunning = await checkLitellmHealth(litellmUrl)
    if (!proxyRunning) {
      let generatedConfig: string | undefined
      if (config.agent.stages || config.agent.default) {
        generatedConfig = generateLitellmConfigFromStages(config.agent.default, config.agent.stages)
      } else if (config.agent.provider && config.agent.provider !== "anthropic") {
        generatedConfig = generateLitellmConfig(config.agent.provider, config.agent.modelMap)
      }
      litellmProcess = await tryStartLitellm(litellmUrl, projectDir, generatedConfig)
    }
    runnerEnv = {
      ANTHROPIC_BASE_URL: litellmUrl,
      ANTHROPIC_API_KEY: getAnthropicApiKeyOrDummy(),
    }
  }

  try {
    await taskifyCommand({ ticketId, prdFile, issueNumber, feedback, local, projectDir, taskId, runnerEnv })
  } catch (err) {
    if (err instanceof TaskifyError) {
      logger.error(`[taskify] ${err.message}`)
      process.exit(1)
    }
    throw err
  } finally {
    litellmProcess?.kill()
  }
}

export async function taskifyCommand(opts: TaskifyOptions): Promise<void> {
  const { ticketId, prdFile, issueNumber, feedback, local, projectDir, taskId } = opts

  const config = getProjectConfig()
  const taskDir = path.join(projectDir, ".kody", "tasks", taskId)
  fs.mkdirSync(taskDir, { recursive: true })

  const mode = prdFile ? "file" : ticketId ? "ticket" : "issue"
  logger.info(`[taskify] mode=${mode} source=${ticketId ?? prdFile ?? `issue#${issueNumber}`} issue=${issueNumber ?? "none"} task=${taskId}`)

  // MCP config — only required for ticket mode
  let mcpConfigJson: string | undefined
  if (mode === "ticket") {
    try {
      mcpConfigJson = buildTaskifyMcpConfigJson(config)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (issueNumber && !local) {
        postComment(issueNumber,
          `Kody could not start the taskify command:\n\n> ${msg}\n\nAdd the required MCP server config to \`kody.config.json\` and try again.`,
        )
      }
      throw new TaskifyError(`MCP config error: ${msg}`)
    }
  }

  // Resolve model for taskify: use "strong" tier
  const sc = resolveStageConfig(config, "taskify", "strong")
  const model = sc.model

  // Read PRD file content if in file mode
  const fileContent = prdFile ? fs.readFileSync(prdFile, "utf-8") : undefined

  // Fetch issue body if in issue mode (no ticket or file provided)
  let issueBody: string | undefined
  if (mode === "issue" && issueNumber) {
    const issue = getIssue(issueNumber)
    if (issue) {
      issueBody = `# ${issue.title}\n\n${issue.body}`
      logger.info(`  Fetched issue #${issueNumber} body (${issueBody.length} chars)`)
    } else {
      throw new TaskifyError(`Could not fetch issue #${issueNumber}`)
    }
  }

  // Build project context: memory file + git file tree
  let projectContext: string | undefined
  {
    const parts: string[] = []

    const memoryPath = path.join(projectDir, ".kody", "memory.md")
    if (fs.existsSync(memoryPath)) {
      try {
        const content = fs.readFileSync(memoryPath, "utf-8").slice(0, 2000)
        if (content.trim()) parts.push(`### Project Memory\n${content}`)
      } catch { /* ignore */ }
    }

    try {
      const output = execSync("git ls-files", { cwd: projectDir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
      const lines = output.split("\n").filter(Boolean).slice(0, 150)
      if (lines.length > 0) parts.push(`### File Tree\n\`\`\`\n${lines.join("\n")}\n\`\`\``)
    } catch { /* not a git repo or git unavailable */ }

    if (parts.length > 0) projectContext = parts.join("\n\n")
  }

  // Build prompt from template
  const prompt = buildPrompt({ ticketId, fileContent, issueBody, taskDir, feedback, projectContext })

  // Post starting comment
  if (issueNumber && !local) {
    const src = mode === "file" ? `file \`${path.basename(prdFile!)}\`` : mode === "ticket" ? `ticket **${ticketId}**` : `issue #${issueNumber} description`
    const runUrl = process.env.RUN_URL ? ` ([logs](${process.env.RUN_URL}))` : ""
    postComment(issueNumber, `🚀 Kody pipeline started: \`${taskId}\`${runUrl}\n\nKody is decomposing ${src} into tasks...`)
    setLifecycleLabel(issueNumber, "planning")
  }

  // Write marker file so the approve-resume path can identify this as a taskify run
  fs.writeFileSync(path.join(taskDir, MARKER_FILE), JSON.stringify({ ticketId, prdFile, issueNumber }))

  // Run Claude Code
  const runner = opts.runner ?? createClaudeCodeRunner()
  logger.info(`  model=${model} timeout=${TASKIFY_TIMEOUT_MS / 1000}s`)
  const result = await runner.run("taskify", prompt, model, TASKIFY_TIMEOUT_MS, taskDir, {
    cwd: projectDir,
    mcpConfigJson,
    env: opts.runnerEnv,
  })

  if (result.outcome !== "completed") {
    const errMsg = result.outcome === "timed_out"
      ? "Taskify timed out after 5 minutes."
      : `Taskify failed: ${result.error}`
    if (issueNumber && !local) {
      postComment(issueNumber, `Kody taskify failed:\n\n> ${errMsg}`)
      setLifecycleLabel(issueNumber, "failed")
    }
    throw new TaskifyError(errMsg)
  }

  // Parse result file
  const resultPath = path.join(taskDir, RESULT_FILE)
  if (!fs.existsSync(resultPath)) {
    const errMsg = `Claude did not write ${RESULT_FILE}. Output:\n\n${result.output?.slice(0, 500) ?? "(none)"}`
    if (issueNumber && !local) {
      postComment(issueNumber, `Kody taskify failed: result file not found.\n\n${errMsg}`)
      setLifecycleLabel(issueNumber, "failed")
    }
    throw new TaskifyError(errMsg)
  }

  let parsed: TaskifyResult
  try {
    parsed = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as TaskifyResult
  } catch {
    const errMsg = `Could not parse ${RESULT_FILE} as JSON.`
    if (issueNumber && !local) {
      postComment(issueNumber, `Kody taskify failed: ${errMsg}`)
      setLifecycleLabel(issueNumber, "failed")
    }
    throw new TaskifyError(errMsg)
  }

  const sourceLabel = ticketId ?? (prdFile ? path.basename(prdFile) : issueNumber ? `issue #${issueNumber}` : "spec")

  if (parsed.status === "questions") {
    handleQuestions(parsed, sourceLabel, issueNumber, local ?? false)
  } else if (parsed.status === "ready") {
    await handleTasks(parsed, sourceLabel, issueNumber, local ?? false)
  } else {
    const errMsg = `Unexpected status in ${RESULT_FILE}: ${JSON.stringify(parsed)}`
    if (issueNumber && !local) {
      postComment(issueNumber, `Kody taskify failed: ${errMsg}`)
      setLifecycleLabel(issueNumber, "failed")
    }
    throw new TaskifyError(errMsg)
  }
}

function handleQuestions(
  parsed: TaskifyResult,
  ticketId: string,
  issueNumber: number | undefined,
  local: boolean,
): void {
  const questions = parsed.questions ?? []
  const numbered = questions.map((q, i) => `${i + 1}. ${q}`).join("\n")
  const comment = `Kody has questions before decomposing **${ticketId}**:\n\n${numbered}\n\nReply with \`@kody approve\` and your answers to proceed.`

  logger.info(`[taskify] posting ${questions.length} question(s)`)
  if (issueNumber && !local) {
    postComment(issueNumber, comment)
    setLifecycleLabel(issueNumber, "waiting")
  } else {
    logger.info(`[taskify] questions:\n${comment}`)
  }
}

async function handleTasks(
  parsed: TaskifyResult,
  ticketId: string,
  issueNumber: number | undefined,
  local: boolean,
): Promise<void> {
  const tasks = topoSort(parsed.tasks ?? [])

  if (tasks.length === 0) {
    logger.warn("[taskify] no tasks in result — nothing to file")
    if (issueNumber && !local) {
      postComment(issueNumber, `Kody taskify completed but found no tasks to file for **${ticketId}**.`)
      setLifecycleLabel(issueNumber, "done")
    }
    return
  }

  const tooMany = tasks.length > MAX_TASKS_GUARD
  if (tooMany) {
    logger.warn(`[taskify] ${tasks.length} tasks exceeds MAX_TASKS_GUARD (${MAX_TASKS_GUARD}) — filing issues but skipping auto-trigger`)
  }

  logger.info(`[taskify] filing ${tasks.length} issue(s)`)

  const filed: { number: number; url: string; title: string }[] = []

  for (const task of tasks) {
    if (local) {
      logger.info(`  [local] would create issue: ${task.title}`)
      filed.push({ number: 0, url: "#", title: task.title })
      continue
    }
    // Only apply labels known to exist in most repos (priority:*).
    // Custom category labels (e.g. "backend") may not exist and would cause
    // issue creation to fail entirely.
    const safeLabels = [
      ...(task.labels ?? []).filter((l) => l.startsWith("priority:") || l.startsWith("kody:")),
      ...(task.priority ? [`priority:${task.priority}`] : []),
    ]
    let issue = createIssue(task.title, task.body, safeLabels)
    if (!issue && safeLabels.length > 0) {
      // Retry without labels in case any priority label is missing
      issue = createIssue(task.title, task.body, [])
    }
    if (issue) {
      filed.push({ number: issue.number, url: issue.url, title: task.title })
    } else {
      logger.warn(`  failed to create issue: ${task.title}`)
    }
  }

  const autoTrigger = !tooMany && filed.length <= AUTO_TRIGGER_THRESHOLD

  // Auto-comment @kody on each filed issue
  if (autoTrigger && !local) {
    for (const issue of filed) {
      if (issue.number > 0) {
        postComment(issue.number, "@kody")
        logger.info(`  auto-triggered @kody on issue #${issue.number}`)
      }
    }
  }

  // Post summary on originating issue
  if (issueNumber && !local) {
    const links = filed.map((i) => `- [#${i.number}](${i.url}) — ${i.title}`).join("\n")
    const triggerNote = tooMany
      ? `\n\n> **${tasks.length} tasks filed** — auto-trigger is disabled for large epics. Comment \`@kody\` on each issue to start the pipeline.`
      : autoTrigger
        ? `\n\n> Auto-triggered \`@kody\` on each issue.`
        : `\n\n> Comment \`@kody\` on each issue to start the pipeline.`
    postComment(issueNumber,
      `Kody decomposed **${ticketId}** into ${filed.length} task(s):\n\n${links}${triggerNote}`,
    )
    setLifecycleLabel(issueNumber, "done")
  } else if (local) {
    logger.info(`[taskify] local mode — would file ${filed.length} issue(s)`)
  }
}

interface BuildPromptOpts {
  ticketId?: string
  fileContent?: string
  issueBody?: string
  taskDir: string
  feedback?: string
  projectContext?: string
}

function buildPrompt(opts: BuildPromptOpts): string {
  const { ticketId, fileContent, issueBody, taskDir, feedback, projectContext } = opts

  const scriptDir = new URL(".", import.meta.url).pathname
  const candidates = [
    path.resolve(scriptDir, "..", "prompts", "taskify-ticket.md"),
    path.resolve(scriptDir, "..", "..", "prompts", "taskify-ticket.md"),
    path.resolve(__dirname, "..", "..", "prompts", "taskify-ticket.md"),
    path.resolve(__dirname, "..", "prompts", "taskify-ticket.md"),
  ]

  let template = ""
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      template = fs.readFileSync(candidate, "utf-8")
      break
    }
  }

  if (!template) {
    throw new Error(`Could not find prompts/taskify-ticket.md. Searched: ${candidates.join(", ")}`)
  }

  // Handle conditional blocks
  const resolveBlock = (name: string, value: string | undefined) => {
    if (value) {
      template = template.replace(new RegExp(`\\{\\{#if ${name}\\}\\}\\n?([\\s\\S]*?)\\{\\{\\/if\\}\\}`, "g"), "$1")
      template = template.replace(new RegExp(`\\{\\{${name}\\}\\}`, "g"), value)
    } else {
      template = template.replace(new RegExp(`\\{\\{#if ${name}\\}\\}\\n?[\\s\\S]*?\\{\\{\\/if\\}\\}\\n?`, "g"), "")
    }
  }

  resolveBlock("PROJECT_CONTEXT", projectContext)
  resolveBlock("TICKET_ID", ticketId)
  resolveBlock("FILE_CONTENT", fileContent)
  resolveBlock("ISSUE_BODY", issueBody)
  resolveBlock("FEEDBACK", feedback)

  template = template.replace(/\{\{TASK_DIR\}\}/g, taskDir)

  return template
}

/**
 * Check if a task directory belongs to a taskify run.
 * Used by entry.ts to detect approve-resume flow.
 */
export function isTaskifyRun(taskDir: string): boolean {
  return fs.existsSync(path.join(taskDir, MARKER_FILE))
}

/**
 * Read the ticketId from the marker file in a taskify task dir.
 */
export function readTaskifyMarker(taskDir: string): { ticketId?: string; prdFile?: string; issueNumber?: number } | null {
  const markerPath = path.join(taskDir, MARKER_FILE)
  if (!fs.existsSync(markerPath)) return null
  try {
    return JSON.parse(fs.readFileSync(markerPath, "utf-8")) as { ticketId?: string; prdFile?: string; issueNumber?: number }
  } catch {
    return null
  }
}
