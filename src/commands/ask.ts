import { readProjectMemory } from "../memory.js"
import { readPromptFile } from "../context.js"
import { getProjectConfig, resolveStageConfig, stageNeedsProxy, getLitellmUrl } from "../config.js"
import { getIssue, postComment } from "../github-api.js"
import { logger } from "../logger.js"
import type { AgentRunner } from "../types.js"

const ASK_TIMEOUT = 300_000 // 5 minutes
const ASK_MODEL_TIER = "mid"

export interface AskOptions {
  issueNumber?: number
  question: string
  projectDir: string
  runners: Record<string, AgentRunner>
  taskId: string
  local?: boolean
}

export interface AskResult {
  outcome: "completed" | "failed"
  answer?: string
  error?: string
}

function buildAskPrompt(
  question: string,
  projectDir: string,
  issueNumber?: number,
): string {
  const memory = readProjectMemory(projectDir)

  // Fetch issue context if an issue number is provided
  let issueContext = ""
  if (issueNumber) {
    const issue = getIssue(issueNumber)
    if (issue) {
      issueContext += `## Issue #${issueNumber}: ${issue.title}\n\n${issue.body ?? ""}\n`
      if (issue.labels.length > 0) {
        issueContext += `\nLabels: ${issue.labels.join(", ")}\n`
      }
      if (issue.comments.length > 0) {
        issueContext += `\n## Recent Comments\n`
        const recent = issue.comments.slice(-10)
        for (const c of recent) {
          issueContext += `\n**@${c.author}** (${c.createdAt}):\n${c.body}\n`
        }
      }
    }
  }

  // Load the ask prompt template
  let promptTemplate: string
  try {
    promptTemplate = readPromptFile("ask", projectDir)
  } catch {
    promptTemplate = `You are a helpful assistant answering questions about this codebase.

Research the codebase to answer the question below. Be thorough but concise.
Do NOT modify any files. Only read, search, and analyze.

{{QUESTION}}

{{ISSUE_CONTEXT}}`
  }

  let prompt = promptTemplate
    .replace("{{QUESTION}}", `## Question\n\n${question}`)
    .replace("{{ISSUE_CONTEXT}}", issueContext)

  if (memory) {
    prompt = `${memory}\n---\n\n${prompt}`
  }

  return prompt
}

export async function runAsk(options: AskOptions): Promise<AskResult> {
  const { issueNumber, question, projectDir, runners, taskId, local } = options

  if (!question.trim()) {
    const msg = "No question provided. Usage: `kody-engine --ask \"<question>\"`"
    if (!local && issueNumber) {
      postComment(issueNumber, msg)
    }
    return { outcome: "failed", error: msg }
  }

  if (issueNumber) {
    logger.info(`Ask: answering question on issue #${issueNumber}`)
  } else {
    logger.info(`Ask: answering question locally`)
  }
  logger.info(`  Question: ${question.slice(0, 200)}${question.length > 200 ? "..." : ""}`)

  const prompt = buildAskPrompt(question, projectDir, issueNumber)

  const config = getProjectConfig()
  const sc = resolveStageConfig(config, "ask", ASK_MODEL_TIER)
  const model = sc.model
  const useProxy = stageNeedsProxy(sc)

  const extraEnv: Record<string, string> = {}
  if (useProxy) {
    extraEnv.ANTHROPIC_BASE_URL = getLitellmUrl()
  }

  const defaultRunnerName = config.agent.defaultRunner ?? Object.keys(runners)[0] ?? "claude"
  const runner = runners[defaultRunnerName]
  if (!runner) {
    return { outcome: "failed", error: `Runner "${defaultRunnerName}" not found` }
  }

  logger.info(`  runner=${defaultRunnerName} model=${model} timeout=${ASK_TIMEOUT / 1000}s`)

  const result = await runner.run("ask", prompt, model, ASK_TIMEOUT, projectDir, {
    cwd: projectDir,
    env: extraEnv,
  })

  if (result.outcome !== "completed" || !result.output) {
    const error = result.error ?? "No output from agent"
    logger.error(`  Ask failed: ${error}`)
    if (!local && issueNumber) {
      postComment(issueNumber, `❌ Failed to answer: ${error.slice(0, 200)}`)
    }
    return { outcome: "failed", error }
  }

  const answer = result.output.trim()
  logger.info(`  Answer generated (${answer.length} chars)`)

  if (!local && issueNumber) {
    postComment(issueNumber, formatAskComment(answer, taskId))
  } else {
    console.log("\n--- Answer ---\n")
    console.log(answer)
  }

  return { outcome: "completed", answer }
}

function formatAskComment(answer: string, taskId: string): string {
  return `${answer}\n\n---\n<sub>🤖 Kody Ask \`${taskId}\`</sub>`
}
