import * as fs from "fs"
import * as path from "path"
import { readProjectMemory, mergeBrainWithProject, readBrainMemoryTiered, getBrainBasePath } from "./memory.js"
import { getProjectConfig, parseProviderModel } from "./config.js"
import { searchFactsByScope, getRecentlyChangedFacts } from "./memory/graph/queries.js"
import { recentChangesToMarkdown } from "./memory/graph/serialize.js"
import { CITATION_INSTRUCTION } from "./memory/graph/citation.js"
import {
  readProjectMemoryTiered,
  injectTaskContextTiered,
  resolveStagePolicy,
  estimateTokens,
  inferRoomsFromScope,
  type MemoryHall,
} from "./context-tiers.js"
import { isMcpEnabledForStage } from "./mcp-config.js"
import { readRunHistory, formatRunHistoryForPrompt } from "./run-history.js"
import { readStageInsights, formatStageInsightsForPrompt } from "./stage-diary.js"
import { generateL1 } from "./context-tiers.js"

// Safety rails (chars) — not budgets. Only kick in to prevent runaway content
// (e.g. infinite loop appending to context.md). Normal content passes through
// verbatim; generateL1 summarizes only when these limits are breached.
const MAX_TASK_CONTEXT_CHARS = 200_000 // ~50K tokens — virtually unlimited for spec/plan
const MAX_ACCUMULATED_CONTEXT = 400_000 // ~100K tokens — accumulated context from all stages

export function readPromptFile(stageName: string, projectDir?: string): string {
  // Try project-level step file first (.kody/steps/{stageName}.md)
  if (projectDir) {
    const stepFile = path.join(projectDir, ".kody", "steps", `${stageName}.md`)
    if (fs.existsSync(stepFile)) {
      return fs.readFileSync(stepFile, "utf-8")
    }
    console.warn(`  ⚠ No step file at ${stepFile}, falling back to engine defaults. Run 'kody-engine-lite init --force' to generate step files.`)
  }

  // Fallback: engine's built-in prompts
  const scriptDir = new URL(".", import.meta.url).pathname

  // Try multiple resolution paths (dev: src/../prompts, prod: dist/bin/../../prompts)
  const candidates = [
    path.resolve(scriptDir, "..", "prompts", `${stageName}.md`),
    path.resolve(scriptDir, "..", "..", "prompts", `${stageName}.md`),
  ]

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return fs.readFileSync(candidate, "utf-8")
    }
  }

  throw new Error(`Prompt file not found: tried ${candidates.join(", ")}`)
}

export function injectTaskContext(
  prompt: string,
  taskId: string,
  taskDir: string,
  feedback?: string,
  options?: { projectDir?: string; issueNumber?: number },
): string {
  let context = `## Task Context\n`
  context += `Task ID: ${taskId}\n`
  context += `Task Directory: ${taskDir}\n`

  const taskMdPath = path.join(taskDir, "task.md")
  if (fs.existsSync(taskMdPath)) {
    const taskMd = fs.readFileSync(taskMdPath, "utf-8")
    context += `\n## Task Description\n${taskMd}\n`
  }

  const taskJsonPath = path.join(taskDir, "task.json")
  if (fs.existsSync(taskJsonPath)) {
    try {
      const taskDef = JSON.parse(fs.readFileSync(taskJsonPath, "utf-8"))
      context += `\n## Task Classification\n`
      context += `Type: ${taskDef.task_type ?? "unknown"}\n`
      context += `Title: ${taskDef.title ?? "unknown"}\n`
      context += `Risk: ${taskDef.risk_level ?? "unknown"}\n`
    } catch {
      // Ignore parse errors
    }
  }

  const specPath = path.join(taskDir, "spec.md")
  if (fs.existsSync(specPath)) {
    const spec = fs.readFileSync(specPath, "utf-8")
    const summarized = spec.length > MAX_TASK_CONTEXT_CHARS ? generateL1(spec, "spec.md", MAX_TASK_CONTEXT_CHARS) : spec
    context += `\n## Spec${spec.length > MAX_TASK_CONTEXT_CHARS ? " Summary" : ""}\n${summarized}\n`
  }

  const planPath = path.join(taskDir, "plan.md")
  if (fs.existsSync(planPath)) {
    const plan = fs.readFileSync(planPath, "utf-8")
    const summarized = plan.length > MAX_TASK_CONTEXT_CHARS ? generateL1(plan, "plan.md", MAX_TASK_CONTEXT_CHARS) : plan
    context += `\n## Plan${plan.length > MAX_TASK_CONTEXT_CHARS ? " Summary" : ""}\n${summarized}\n`
  }

  // Accumulated context from previous stages
  const contextMdPath = path.join(taskDir, "context.md")
  if (fs.existsSync(contextMdPath)) {
    const accumulated = fs.readFileSync(contextMdPath, "utf-8")
    const truncated = accumulated.slice(-MAX_ACCUMULATED_CONTEXT)
    const prefix = accumulated.length > MAX_ACCUMULATED_CONTEXT ? "...(earlier context truncated)\n" : ""
    context += `\n## Previous Stage Context\n${prefix}${truncated}\n`
  }

  // File scope constraints (from decompose sub-tasks)
  const constraintsPath = path.join(taskDir, "constraints.json")
  if (fs.existsSync(constraintsPath)) {
    try {
      const c = JSON.parse(fs.readFileSync(constraintsPath, "utf-8"))
      if (Array.isArray(c.allowedFiles) && c.allowedFiles.length > 0) {
        context += `\n## File Scope Constraints (MANDATORY)\n`
        context += `You MUST only modify files in: ${c.allowedFiles.join(", ")}\n`
        if (Array.isArray(c.forbiddenFiles) && c.forbiddenFiles.length > 0) {
          context += `You MUST NOT modify: ${c.forbiddenFiles.join(", ")}\n`
        }
      }
    } catch { /* ignore parse errors */ }
  }

  // Run history context (previous attempts on this issue)
  if (options?.projectDir && options?.issueNumber) {
    const records = readRunHistory(options.projectDir, options.issueNumber)
    const runHistorySection = formatRunHistoryForPrompt(records)
    if (runHistorySection) {
      context += `\n${runHistorySection}\n`
    }
  }

  if (feedback) {
    context += `\n## Human Feedback\n${feedback}\n`
  }

  return prompt.replace("{{TASK_CONTEXT}}", context)
}

/**
 * Read task.json scope and infer rooms for memory filtering.
 * Returns null when task.json doesn't exist or has no scope (e.g. taskify stage).
 */
function inferRoomsFromTaskJson(taskDir: string): string[] | null {
  const taskJsonPath = path.join(taskDir, "task.json")
  if (!fs.existsSync(taskJsonPath)) return null
  try {
    const raw = fs.readFileSync(taskJsonPath, "utf-8")
    const cleaned = raw.replace(/^```json\s*\n?/m, "").replace(/\n?```\s*$/m, "")
    const task = JSON.parse(cleaned)
    const scope: string[] = Array.isArray(task.scope) ? task.scope : []
    return inferRoomsFromScope(scope)
  } catch {
    return null
  }
}

const UI_EXTENSIONS = new Set([
  ".tsx", ".jsx", ".vue", ".svelte",
  ".css", ".scss", ".sass", ".less",
  ".html",
])

const UI_PATH_SEGMENTS = [
  "/components/", "/pages/", "/layouts/", "/styles/", "/views/",
]

/**
 * Determine if a scope array contains frontend/UI files.
 * Returns true if any file has a UI extension or lives in a UI directory.
 */
export function inferHasUIFromScope(scope: string[]): boolean {
  return scope.some((filePath) => {
    const ext = path.extname(filePath).toLowerCase()
    if (UI_EXTENSIONS.has(ext)) return true
    const normalized = filePath.replace(/\\/g, "/")
    return UI_PATH_SEGMENTS.some((seg) => normalized.includes(seg))
  })
}

/**
 * Read task.json and check if the task involves UI.
 * Derives hasUI deterministically from the scope array.
 * Returns true (safe default) when scope is empty, missing, or task.json is absent.
 */
export function taskHasUI(taskDir: string): boolean {
  const taskJsonPath = path.join(taskDir, "task.json")
  if (!fs.existsSync(taskJsonPath)) return true // no task.json yet → safe default
  try {
    const taskDef = JSON.parse(fs.readFileSync(taskJsonPath, "utf-8"))
    const scope: string[] = Array.isArray(taskDef.scope) ? taskDef.scope : []
    if (scope.length === 0) return true // no scope info → safe default
    return inferHasUIFromScope(scope)
  } catch {
    return true
  }
}

function getDevServerInfo(taskDir: string): { command: string; url: string; readyPattern: string; readyTimeout: number } | undefined {
  const config = getProjectConfig()
  const ds = config.devServer
  if (!ds) return undefined
  return {
    command: ds.command,
    url: ds.url,
    readyPattern: ds.readyPattern ?? "Ready in|compiled|started server|Local:",
    readyTimeout: ds.readyTimeout ?? 180,
  }
}

function getBrowserToolGuidance(stageName: string, taskDir: string): string {
  const devServer = getDevServerInfo(taskDir)

  // Check if the engine already started the dev server (KODY_DEV_SERVER_READY env var)
  const engineManagedServer = process.env.KODY_DEV_SERVER_READY !== undefined
  const serverReady = process.env.KODY_DEV_SERVER_READY === "true"
  const serverUrl = process.env.KODY_DEV_SERVER_URL ?? devServer?.url

  const devServerBlock = engineManagedServer
    ? (serverReady
      ? `
### Dev Server
The dev server is already running at ${serverUrl}. Do NOT start it yourself.
You can use browser tools to navigate to ${serverUrl} directly.`
      : `
### Dev Server
The dev server failed to start (e.g. DB connection issues). Skip browser verification and proceed with code-only changes. Do NOT attempt to start the dev server yourself — it will hang.`)
    : devServer
    ? `
### Dev Server Setup (REQUIRED before browsing)
You MUST start the dev server before using any browser navigation tools:
\`\`\`bash
# Start the dev server in the background with output redirected to a log file
nohup ${devServer.command} > /tmp/dev-server.log 2>&1 &
DEV_PID=$!

# Wait up to ${devServer.readyTimeout}s for the server to be ready
for i in $(seq 1 ${devServer.readyTimeout}); do
  if curl -s -o /dev/null -w "%{http_code}" ${devServer.url} 2>/dev/null | grep -qE "^[23]"; then
    echo "Dev server is ready"
    break
  fi
  if ! kill -0 $DEV_PID 2>/dev/null; then
    echo "Dev server process died. Last 20 lines:"
    tail -20 /tmp/dev-server.log
    break
  fi
  sleep 1
done
\`\`\`
The dev server URL is: ${devServer.url}
If the dev server fails to start (e.g. DB connection issues), skip browser verification and proceed with code-only changes. Do NOT hang waiting for it.
After you are done browsing, kill the dev server: \`kill $DEV_PID 2>/dev/null || true\``
    : `
### Dev Server Setup (REQUIRED before browsing)
You MUST start the project's dev server before using any browser navigation tools.
Check package.json for the dev command (usually \`pnpm dev\` or \`npm run dev\`).
\`\`\`bash
# Start the dev server in the background with output redirected
nohup pnpm dev > /tmp/dev-server.log 2>&1 &
DEV_PID=$!

# Wait up to 30s for the server to be ready
for i in $(seq 1 30); do
  if curl -s -o /dev/null -w "%{http_code}" http://localhost:3000 2>/dev/null | grep -qE "^[23]"; then
    echo "Dev server is ready"
    break
  fi
  if ! kill -0 $DEV_PID 2>/dev/null; then
    echo "Dev server process died. Last 20 lines:"
    tail -20 /tmp/dev-server.log
    break
  fi
  sleep 1
done
\`\`\`
If the dev server fails to start (e.g. DB connection issues), skip browser verification and proceed with code-only changes. Do NOT hang waiting for it.
After you are done browsing, kill the dev server: \`kill $DEV_PID 2>/dev/null || true\``

  // Determine if MCP Playwright is available or if we're using CLI-based tools
  const config = getProjectConfig()
  const hasMcpPlaywright = isMcpEnabledForStage(stageName, config.mcp)

  const mcpTools = `### Available Browser Tools
- \`mcp__playwright__browser_navigate\` — go to a URL
- \`mcp__playwright__browser_snapshot\` — capture accessibility tree (shows all elements, text, roles)
- \`mcp__playwright__browser_take_screenshot\` — take a visual screenshot
- \`mcp__playwright__browser_click\` — click an element (by text, role, or ref from snapshot)
- \`mcp__playwright__browser_type\` — type text into an input field
- \`mcp__playwright__browser_fill_form\` — fill multiple form fields at once
- \`mcp__playwright__browser_hover\` — hover over an element (test hover states)
- \`mcp__playwright__browser_select_option\` — select a dropdown option
- \`mcp__playwright__browser_press_key\` — press keyboard keys (Enter, Escape, Tab, etc.)
- \`mcp__playwright__browser_resize\` — resize viewport (test responsive layouts)
- \`mcp__playwright__browser_wait_for\` — wait for text to appear/disappear
- \`mcp__playwright__browser_evaluate\` — run JavaScript on the page`

  const cliTools = `### Browser Verification via Playwright CLI
Use the \`playwright-cli\` commands in your bash tool to interact with the browser:
\`\`\`bash
# Take a screenshot of a page
playwright-cli screenshot ${serverUrl ?? "http://localhost:3000"} --output /tmp/screenshot.png

# Navigate and interact
playwright-cli open ${serverUrl ?? "http://localhost:3000"}

# Run a quick verification script
npx playwright test --grep "homepage" --reporter=list
\`\`\`

Alternatively, write and run a short Playwright script to verify the UI:
\`\`\`bash
node -e "
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('${serverUrl ?? "http://localhost:3000"}');
  await page.screenshot({ path: '/tmp/verify.png', fullPage: true });
  console.log('Title:', await page.title());
  await browser.close();
})();
"
\`\`\`
Use the screenshot output and page title to verify the UI is rendering correctly.`

  const toolsBlock = hasMcpPlaywright ? mcpTools : cliTools

  if (stageName === "build" || stageName === "review-fix") {
    return `## Browser Visual Verification (MANDATORY for UI tasks)

This task involves UI changes. You MUST visually verify your implementation using the browser tools.
${devServerBlock}

${toolsBlock}

### Verification Steps (DO ALL OF THESE)
1. Start the dev server (see above)
2. Navigate to the affected page(s)
3. Take a screenshot or snapshot to verify elements are present
4. **Test interactions**: if the task involves buttons, forms, search, toggles, or any interactive elements — click them, type into them, and verify the result
5. If the task mentions responsive behavior, test at different viewport widths (e.g., 1200px, 768px, 480px)
6. Kill the dev server when done

Do NOT skip the browser verification. The visual check AND interaction testing are required parts of implementing UI changes.`
  }

  if (stageName === "review") {
    return `## Browser Visual Verification (MANDATORY for UI review)

This task involves UI changes. You MUST visually verify the implementation using the browser tools before giving your verdict.
${devServerBlock}

${toolsBlock}

### Review Verification Steps (DO ALL OF THESE)
1. Start the dev server (see above)
2. Navigate to the affected page(s)
3. Take a screenshot or snapshot to verify elements, layout, and text content
4. **Test interactions**: click buttons, fill forms, test search — verify the UI responds correctly
5. If the task mentions responsive behavior, test at different viewport widths
6. Include your browser verification findings in the review (what you saw, what you interacted with, what worked/failed)
7. Kill the dev server when done

Do NOT skip the browser verification. A review of UI changes without visual AND interaction verification is incomplete.`
  }

  return `## Browser Tools Available

You have access to browser tools for visual verification.
${devServerBlock}

${toolsBlock}

Use browser tools to navigate to pages and take screenshots to verify UI output.`
}

/**
 * Build a memory context section for the plan stage by querying graph memory
 * for facts relevant to the current task scope.
 */
function buildMemoryContext(projectDir: string, taskDir: string): string {
  const taskJsonPath = path.join(taskDir, "task.json")
  if (!fs.existsSync(taskJsonPath)) return ""

  try {
    const raw = fs.readFileSync(taskJsonPath, "utf-8")
    const cleaned = raw.replace(/^```json\s*\n?/m, "").replace(/\n?```\s*$/m, "")
    const task = JSON.parse(cleaned)
    const scope: string[] = Array.isArray(task.scope) ? task.scope : []
    if (scope.length === 0) return ""

    const facts = searchFactsByScope(projectDir, scope, 5)
    if (facts.length === 0) return ""

    const lines = facts.map(
      (n) =>
        `- **${n.room ?? n.hall}**: ${n.content.length > 300 ? n.content.slice(0, 300) + "..." : n.content}`,
    )
    return `## Relevant Project Memory\n\n${lines.join("\n")}`
  } catch {
    return ""
  }
}

export function buildFullPrompt(
  stageName: string,
  taskId: string,
  taskDir: string,
  projectDir: string,
  feedback?: string,
  issueNumber?: number,
): string {
  const config = getProjectConfig()

  let assembled: string
  if (config.contextTiers?.enabled) {
    assembled = buildFullPromptTiered(stageName, taskId, taskDir, projectDir, feedback, issueNumber)
  } else {
    const memory = mergeBrainWithProject(projectDir)
    const promptTemplate = readPromptFile(stageName, projectDir)
    const prompt = injectTaskContext(promptTemplate, taskId, taskDir, feedback, { projectDir, issueNumber })
    assembled = memory ? `${memory}\n---\n\n${prompt}` : prompt
  }

  // Inject graph memory for the plan stage
  if (stageName === "plan") {
    const memoryBlock = buildMemoryContext(projectDir, taskDir)
    if (memoryBlock) {
      assembled = assembled + "\n\n" + memoryBlock
    }

    // W-5: surface facts updated/retracted in the last 14 days so the LLM
    // sees reversed conventions rather than treating them as eternal truth.
    try {
      const changes = getRecentlyChangedFacts(projectDir, 14)
      const changesBlock = recentChangesToMarkdown(changes)
      if (changesBlock) {
        assembled = assembled + "\n\n" + changesBlock
      }
    } catch {
      // Best-effort — never break a stage if recent-changes rendering fails.
    }
  }

  // Citation hint: if any memory was injected and the output is expected to
  // cite (non-gate stages), remind the LLM to quote fact ids inline.
  if (assembled.includes("fact_") && stageName !== "verify") {
    assembled = assembled + `\n\n${CITATION_INSTRUCTION}\n`
  }

  // Append browser tool guidance when browser verification is available (MCP or CLI-based)
  const browserStages = ["build", "review", "review-fix"]
  const hasBrowserTools = isMcpEnabledForStage(stageName, config.mcp) || (config.devServer && browserStages.includes(stageName))
  if (hasBrowserTools && taskHasUI(taskDir)) {
    assembled = assembled + "\n\n" + getBrowserToolGuidance(stageName, taskDir)

    // Inject QA guide if it exists
    const qaGuidePath = path.join(projectDir, ".kody", "qa-guide.md")
    if (fs.existsSync(qaGuidePath)) {
      const qaGuide = fs.readFileSync(qaGuidePath, "utf-8").trim()
      assembled = assembled + "\n\n" + qaGuide
    }
  }

  return assembled
}

function buildFullPromptTiered(
  stageName: string,
  taskId: string,
  taskDir: string,
  projectDir: string,
  feedback?: string,
  issueNumber?: number,
): string {
  const config = getProjectConfig()
  const policy = resolveStagePolicy(stageName, config.contextTiers?.stageOverrides)
  const tokenBudget = config.contextTiers?.tokenBudget ?? 8000

  // Infer rooms from task scope for memory filtering
  const roomFilter = inferRoomsFromTaskJson(taskDir)
  const brainMemory = readBrainMemoryTiered(policy.memory, policy.memoryHalls, roomFilter)
  const projectMemory = readProjectMemoryTiered(projectDir, policy.memory, policy.memoryHalls, roomFilter)
  const memory = brainMemory && projectMemory
    ? `${brainMemory}\n\n---\n\n${projectMemory}`
    : (brainMemory || projectMemory)
  const promptTemplate = readPromptFile(stageName, projectDir)
  const prompt = injectTaskContextTiered(promptTemplate, taskId, taskDir, policy, feedback, { projectDir, issueNumber })

  let assembled = memory ? `${memory}\n---\n\n${prompt}` : prompt

  // Inject stage diary (LLM-distilled insights from past runs, stored in the graph)
  const insights = readStageInsights(projectDir, stageName)
  const diaryBlock = formatStageInsightsForPrompt(stageName, insights)
  if (diaryBlock) {
    assembled += `\n\n${diaryBlock}\n`
  }

  // Token budget enforcement: truncate if over budget
  const tokens = estimateTokens(assembled)
  if (tokens > tokenBudget) {
    const maxChars = tokenBudget * 4
    assembled = assembled.slice(0, maxChars) + "\n...(context truncated to fit token budget)"
  }

  return assembled
}

const TIER_ESCALATION: Record<string, string> = {
  cheap: "mid",
  mid: "strong",
  strong: "strong",
}

export function escalateModelTier(currentTier: string): string {
  return TIER_ESCALATION[currentTier] ?? "strong"
}

export function resolveModel(modelTier: string, _stageName?: string): string {
  const config = getProjectConfig()

  // Config modelMap is the single source of truth. Values are "provider/model" strings;
  // return the bare model name (the provider drives proxy routing elsewhere).
  const mapped = config.agent.modelMap[modelTier]
  if (!mapped) {
    throw new Error(`No model configured for tier '${modelTier}'. Set agent.modelMap.${modelTier} in kody.config.json (format: 'provider/model')`)
  }
  return parseProviderModel(mapped).model
}
