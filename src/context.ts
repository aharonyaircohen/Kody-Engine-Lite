import * as fs from "fs"
import * as path from "path"
import { readProjectMemory } from "./memory.js"
import { getProjectConfig } from "./config.js"

const DEFAULT_MODEL_MAP: Record<string, string> = {
  cheap: "haiku",
  mid: "sonnet",
  strong: "opus",
}

const MAX_TASK_CONTEXT_PLAN = 1500
const MAX_TASK_CONTEXT_SPEC = 2000

export function readPromptFile(stageName: string): string {
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

  if (feedback) {
    context += `\n## Human Feedback\n${feedback}\n`
  }

  return prompt.replace("{{TASK_CONTEXT}}", context)
}

export function buildFullPrompt(
  stageName: string,
  taskId: string,
  taskDir: string,
  projectDir: string,
  feedback?: string,
): string {
  const memory = readProjectMemory(projectDir)
  const promptTemplate = readPromptFile(stageName)
  const prompt = injectTaskContext(promptTemplate, taskId, taskDir, feedback)
  return memory ? `${memory}\n---\n\n${prompt}` : prompt
}

export function resolveModel(modelTier: string, stageName?: string): string {
  const config = getProjectConfig()

  // Per-stage routing: use stage name as LiteLLM alias
  if (config.agent.usePerStageRouting && stageName) {
    return stageName
  }

  // Config model map (may be LiteLLM aliases or direct model names)
  const mapped = config.agent.modelMap[modelTier as keyof typeof config.agent.modelMap]
  if (mapped) return mapped

  // Fallback to defaults
  return DEFAULT_MODEL_MAP[modelTier] ?? "sonnet"
}
