import * as fs from "fs"
import * as path from "path"
import { readProjectMemory } from "./memory.js"
import { getProjectConfig } from "./config.js"
import {
  readProjectMemoryTiered,
  injectTaskContextTiered,
  resolveStagePolicy,
  estimateTokens,
} from "./context-tiers.js"
import { isMcpEnabledForStage } from "./mcp-config.js"


const MAX_TASK_CONTEXT_PLAN = 1500
const MAX_TASK_CONTEXT_SPEC = 2000
const MAX_ACCUMULATED_CONTEXT = 4000

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
    const truncated = spec.slice(0, MAX_TASK_CONTEXT_SPEC)
    context += `\n## Spec Summary\n${truncated}${spec.length > MAX_TASK_CONTEXT_SPEC ? "\n..." : ""}\n`
  }

  const planPath = path.join(taskDir, "plan.md")
  if (fs.existsSync(planPath)) {
    const plan = fs.readFileSync(planPath, "utf-8")
    const truncated = plan.slice(0, MAX_TASK_CONTEXT_PLAN)
    context += `\n## Plan Summary\n${truncated}${plan.length > MAX_TASK_CONTEXT_PLAN ? "\n..." : ""}\n`
  }

  // Accumulated context from previous stages
  const contextMdPath = path.join(taskDir, "context.md")
  if (fs.existsSync(contextMdPath)) {
    const accumulated = fs.readFileSync(contextMdPath, "utf-8")
    const truncated = accumulated.slice(-MAX_ACCUMULATED_CONTEXT)
    const prefix = accumulated.length > MAX_ACCUMULATED_CONTEXT ? "...(earlier context truncated)\n" : ""
    context += `\n## Previous Stage Context\n${prefix}${truncated}\n`
  }

  if (feedback) {
    context += `\n## Human Feedback\n${feedback}\n`
  }

  return prompt.replace("{{TASK_CONTEXT}}", context)
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

export function buildFullPrompt(
  stageName: string,
  taskId: string,
  taskDir: string,
  projectDir: string,
  feedback?: string,
): string {
  const config = getProjectConfig()

  let assembled: string
  if (config.contextTiers?.enabled) {
    assembled = buildFullPromptTiered(stageName, taskId, taskDir, projectDir, feedback)
  } else {
    const memory = readProjectMemory(projectDir)
    const promptTemplate = readPromptFile(stageName, projectDir)
    const prompt = injectTaskContext(promptTemplate, taskId, taskDir, feedback)
    assembled = memory ? `${memory}\n---\n\n${prompt}` : prompt
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
): string {
  const config = getProjectConfig()
  const policy = resolveStagePolicy(stageName, config.contextTiers?.stageOverrides)
  const tokenBudget = config.contextTiers?.tokenBudget ?? 8000

  const memory = readProjectMemoryTiered(projectDir, policy.memory)
  const promptTemplate = readPromptFile(stageName, projectDir)
  const prompt = injectTaskContextTiered(promptTemplate, taskId, taskDir, policy, feedback)

  let assembled = memory ? `${memory}\n---\n\n${prompt}` : prompt

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

export function resolveModel(modelTier: string, stageName?: string): string {
  const config = getProjectConfig()

  // Config modelMap is the single source of truth for model names.
  const mapped = config.agent.modelMap[modelTier]
  if (!mapped) {
    throw new Error(`No model configured for tier '${modelTier}'. Set agent.modelMap.${modelTier} in kody.config.json`)
  }
  return mapped
}
