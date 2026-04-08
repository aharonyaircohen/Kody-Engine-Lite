import * as fs from "fs"
import * as path from "path"

import type { StageName } from "./types.js"
import { readRunHistory, formatRunHistoryForPrompt, formatRunHistoryCompressed } from "./run-history.js"
import { compressMemoryContent } from "./compress.js"

// --- Types ---

export type ContextTier = "L0" | "L1" | "L2"

export interface TieredContent {
  source: string
  L0: string
  L1: string
  L2: string
}

/** Memory hall types for categorized filtering */
export type MemoryHall = "facts" | "conventions" | "events" | "preferences" | "thoughts"

export interface StageContextPolicy {
  memory: ContextTier
  taskDescription: ContextTier
  taskClassification: ContextTier
  spec: ContextTier
  plan: ContextTier
  accumulatedContext: ContextTier
  /** Which memory halls to include. Undefined = all halls. */
  memoryHalls?: MemoryHall[]
}

// --- Token Estimation ---

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) + "\n...(truncated)"
}

// --- Default Policies ---

const DEFAULT_STAGE_POLICIES: Record<string, StageContextPolicy> = {
  taskify: {
    memory: "L1",
    taskDescription: "L2",
    taskClassification: "L0",
    spec: "L0",
    plan: "L0",
    accumulatedContext: "L0",
    memoryHalls: ["facts"],
  },
  plan: {
    memory: "L1",
    taskDescription: "L2",
    taskClassification: "L2",
    spec: "L0",
    plan: "L0",
    accumulatedContext: "L1",
    memoryHalls: ["facts", "conventions", "events"],
  },
  build: {
    memory: "L1",
    taskDescription: "L1",
    taskClassification: "L1",
    spec: "L1",
    plan: "L2",
    accumulatedContext: "L1",
    memoryHalls: ["facts", "conventions", "preferences"],
  },
  autofix: {
    memory: "L0",
    taskDescription: "L0",
    taskClassification: "L0",
    spec: "L0",
    plan: "L1",
    accumulatedContext: "L2",
    memoryHalls: ["conventions"],
  },
  review: {
    memory: "L1",
    taskDescription: "L1",
    taskClassification: "L1",
    spec: "L0",
    plan: "L2",
    accumulatedContext: "L1",
    memoryHalls: ["facts", "conventions", "preferences"],
  },
  "review-fix": {
    memory: "L0",
    taskDescription: "L0",
    taskClassification: "L0",
    spec: "L0",
    plan: "L1",
    accumulatedContext: "L2",
    memoryHalls: ["conventions"],
  },
}

export function resolveStagePolicy(
  stageName: string,
  stageOverrides?: Partial<Record<string, Partial<StageContextPolicy>>>,
): StageContextPolicy {
  const defaults = DEFAULT_STAGE_POLICIES[stageName] ?? DEFAULT_STAGE_POLICIES.build
  const overrides = stageOverrides?.[stageName]
  return overrides ? { ...defaults, ...overrides } : { ...defaults }
}

// --- Summary Generation ---

const L0_MAX_CHARS = 400
const L1_MAX_CHARS = 1600

/**
 * L0: ~100 tokens abstract. First heading + first paragraph sentence.
 */
export function generateL0(content: string, filename: string): string {
  if (!content.trim()) return ""

  // For JSON files, extract key fields
  if (filename.endsWith(".json")) {
    return generateL0Json(content)
  }

  const lines = content.split("\n")
  const parts: string[] = []

  // Extract first heading
  const headingLine = lines.find((l) => l.startsWith("#"))
  if (headingLine) parts.push(headingLine)

  // Extract first non-empty, non-heading paragraph sentence
  for (const line of lines) {
    if (!line.trim() || line.startsWith("#")) continue
    if (line.startsWith("-") || line.startsWith("*")) continue
    const sentence = line.split(/\.\s/)[0]
    if (sentence && sentence.length > 10) {
      parts.push(sentence.endsWith(".") ? sentence : sentence + ".")
      break
    }
  }

  const result = parts.join("\n")
  return result.slice(0, L0_MAX_CHARS)
}

function generateL0Json(content: string): string {
  try {
    const cleaned = content.replace(/^```json\s*\n?/m, "").replace(/\n?```\s*$/m, "")
    const obj = JSON.parse(cleaned)
    const fields: string[] = []
    if (obj.title) fields.push(`Title: ${obj.title}`)
    if (obj.task_type) fields.push(`Type: ${obj.task_type}`)
    if (obj.risk_level) fields.push(`Risk: ${obj.risk_level}`)
    if (obj.estimated_complexity) fields.push(`Complexity: ${obj.estimated_complexity}`)
    return fields.join(" | ") || content.slice(0, L0_MAX_CHARS)
  } catch {
    return content.slice(0, L0_MAX_CHARS)
  }
}

/**
 * L1: ~300-500 tokens overview. All headings + first sentence of each section + bullet items.
 */
export function generateL1(content: string, filename: string, maxChars = L1_MAX_CHARS): string {
  if (!content.trim()) return ""

  // For JSON files, extract structured overview
  if (filename.endsWith(".json")) {
    return generateL1Json(content)
  }

  const lines = content.split("\n")
  const parts: string[] = []
  let inSection = false

  for (const line of lines) {
    // Always include headings
    if (line.startsWith("#")) {
      parts.push(line)
      inSection = true
      continue
    }

    // Include bullet items (up to 5 per section)
    if (line.match(/^\s*[-*]\s/)) {
      const recentBullets = parts.slice(-5).filter((p) => p.match(/^\s*[-*]\s/)).length
      if (recentBullets < 5) {
        parts.push(line)
      }
      continue
    }

    // Include first non-empty line after heading
    if (inSection && line.trim()) {
      parts.push(line)
      inSection = false
    }
  }

  const result = parts.join("\n")
  return result.slice(0, maxChars)
}

function generateL1Json(content: string): string {
  try {
    const cleaned = content.replace(/^```json\s*\n?/m, "").replace(/\n?```\s*$/m, "")
    const obj = JSON.parse(cleaned)
    const lines: string[] = []

    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        lines.push(`- ${key}: ${value}`)
      } else if (Array.isArray(value)) {
        lines.push(`- ${key}: [${value.length} items] ${value.slice(0, 3).join(", ")}`)
      }
    }

    return lines.join("\n").slice(0, L1_MAX_CHARS)
  } catch {
    return content.slice(0, L1_MAX_CHARS)
  }
}

export function getTieredContent(
  filePath: string,
  content: string,
): TieredContent {
  const key = path.basename(filePath)
  return {
    source: filePath,
    L0: generateL0(content, key),
    L1: generateL1(content, key),
    L2: content,
  }
}

// --- Tiered Content Selection ---

export function selectTier(tiered: TieredContent, tier: ContextTier): string {
  return tiered[tier]
}

// --- Tiered Memory Reader ---

// ─── Hall Detection ─────────────────────────────────────────────────────────

/**
 * Infer the memory hall type from a filename.
 *
 * Convention: prefix with hall name (e.g. "facts_architecture.md", "conventions_eslint.md").
 * Legacy files without prefix default to "conventions".
 */
export function inferHallFromFilename(filename: string): MemoryHall {
  const name = filename.replace(/\.md$/, "").toLowerCase()
  if (name.startsWith("facts_") || name === "architecture") return "facts"
  if (name.startsWith("events_") || name === "observer-log") return "events"
  if (name.startsWith("preferences_")) return "preferences"
  if (name.startsWith("thoughts_")) return "thoughts"
  // Default: conventions (covers "conventions.md" and untagged legacy files)
  return "conventions"
}

// ─── Room Detection ─────────────────────────────────────────────────────────

/**
 * Infer the room (topic) from a memory filename.
 *
 * Examples:
 *   "conventions_auth.md"  → "auth"
 *   "facts_architecture.md" → "architecture"
 *   "conventions.md"       → null (global, no room)
 *   "architecture.md"      → "architecture" (legacy)
 */
export function inferRoomFromFilename(filename: string): string | null {
  const name = filename.replace(/\.md$/, "").toLowerCase()
  // Hall-prefixed: "conventions_auth" → "auth"
  const prefixMatch = name.match(/^(?:facts|conventions|events|preferences)_(.+)$/)
  if (prefixMatch) return prefixMatch[1]
  // Legacy named files: "architecture" → "architecture", "conventions" → null (global)
  if (name === "conventions" || name === "observer-log") return null
  if (name === "architecture") return "architecture"
  // Other legacy files without prefix: "domain" → "domain", "patterns" → "patterns"
  return name
}

/**
 * Infer relevant rooms from task scope (file paths).
 *
 * Extracts the first significant directory from each scope path.
 * Returns null if scope is empty (no room filtering).
 */
export function inferRoomsFromScope(scope: string[]): string[] | null {
  if (scope.length === 0) return null

  const rooms = new Set<string>()
  for (const filePath of scope) {
    // "src/auth/withAuth.ts" → ["src", "auth", "withAuth.ts"]
    const parts = filePath.replace(/\\/g, "/").split("/").filter(Boolean)
    // Skip "src" as it's not meaningful, take the next directory
    const meaningful = parts.filter((p) => p !== "src" && p !== "lib" && p !== "app" && !p.includes("."))
    if (meaningful.length > 0) {
      rooms.add(meaningful[0].toLowerCase())
    }
  }

  return rooms.size > 0 ? [...rooms] : null
}

// ─── Tiered Memory Reader ────────────────────────────────────────────────

export function readProjectMemoryTiered(
  projectDir: string,
  tier: ContextTier,
  hallFilter?: MemoryHall[],
  roomFilter?: string[] | null,
): string {
  const memoryDir = path.join(projectDir, ".kody", "memory")
  if (!fs.existsSync(memoryDir)) return ""

  let files = fs
    .readdirSync(memoryDir)
    .filter((f) => f.endsWith(".md"))
    .sort()
  if (files.length === 0) return ""

  // Filter by hall type when specified
  if (hallFilter && hallFilter.length > 0) {
    files = files.filter((f) => hallFilter.includes(inferHallFromFilename(f)))
  }

  // Filter by room when specified — keep global files (no room) + matching rooms
  if (roomFilter && roomFilter.length > 0) {
    files = files.filter((f) => {
      const room = inferRoomFromFilename(f)
      return room === null || roomFilter.includes(room)
    })
  }

  if (files.length === 0) return ""

  const tierLabel = tier === "L2" ? "full" : tier === "L1" ? "overview" : "abstract"
  const sections: string[] = []

  for (const file of files) {
    const filePath = path.join(memoryDir, file)
    const content = fs.readFileSync(filePath, "utf-8").trim()
    if (!content) continue

    // L0 with compression: use AAAK-style shorthand
    if (tier === "L0") {
      const compressed = compressMemoryContent(content, file)
      if (compressed) {
        sections.push(compressed)
      }
      continue
    }

    const tiered = getTieredContent(filePath, content)
    const selected = selectTier(tiered, tier)
    if (selected) {
      sections.push(`## ${file.replace(".md", "")}\n${selected}`)
    }
  }

  if (sections.length === 0) return ""

  // L0: compact single-line format
  if (tier === "L0") {
    return `# Memory(compact)\n${sections.join("\n")}\n`
  }

  const header =
    tier === "L2"
      ? "# Project Memory\n"
      : `# Project Memory (${tierLabel} — use Read tool for full details)\n`

  return `${header}\n${sections.join("\n\n")}\n`
}

// --- Tiered Task Context Injection ---

export function injectTaskContextTiered(
  prompt: string,
  taskId: string,
  taskDir: string,
  policy: StageContextPolicy,
  feedback?: string,
  options?: { projectDir?: string; issueNumber?: number },
): string {
  let context = `## Task Context\n`
  context += `Task ID: ${taskId}\n`
  context += `Task Directory: ${taskDir}\n`

  // Task description (task.md)
  const taskMdPath = path.join(taskDir, "task.md")
  if (fs.existsSync(taskMdPath)) {
    const content = fs.readFileSync(taskMdPath, "utf-8")
    const selected = selectContent(taskMdPath, content, policy.taskDescription)
    const label = tierLabel("Task Description", policy.taskDescription)
    context += `\n## ${label}\n${selected}\n`
  }

  // Task classification (task.json)
  const taskJsonPath = path.join(taskDir, "task.json")
  if (fs.existsSync(taskJsonPath)) {
    const content = fs.readFileSync(taskJsonPath, "utf-8")
    if (policy.taskClassification === "L2") {
      // Full: parse and format like original
      try {
        const taskDef = JSON.parse(content.replace(/^```json\s*\n?/m, "").replace(/\n?```\s*$/m, ""))
        context += `\n## Task Classification\n`
        context += `Type: ${taskDef.task_type ?? "unknown"}\n`
        context += `Title: ${taskDef.title ?? "unknown"}\n`
        context += `Risk: ${taskDef.risk_level ?? "unknown"}\n`
      } catch {
        // Ignore
      }
    } else {
      const selected = selectContent(taskJsonPath, content, policy.taskClassification)
      if (selected) {
        const label = tierLabel("Task Classification", policy.taskClassification)
        context += `\n## ${label}\n${selected}\n`
      }
    }
  }

  // Spec (spec.md)
  const specPath = path.join(taskDir, "spec.md")
  if (fs.existsSync(specPath)) {
    const content = fs.readFileSync(specPath, "utf-8")
    const selected = selectContent(specPath, content, policy.spec)
    const label = tierLabel("Spec", policy.spec)
    context += `\n## ${label}\n${selected}\n`
  }

  // Plan (plan.md)
  const planPath = path.join(taskDir, "plan.md")
  if (fs.existsSync(planPath)) {
    const content = fs.readFileSync(planPath, "utf-8")
    const selected = selectContent(planPath, content, policy.plan)
    const label = tierLabel("Plan", policy.plan)
    context += `\n## ${label}\n${selected}\n`
  }

  // Accumulated context (context.md)
  const contextMdPath = path.join(taskDir, "context.md")
  if (fs.existsSync(contextMdPath)) {
    const content = fs.readFileSync(contextMdPath, "utf-8")
    const selected = selectContent(contextMdPath, content, policy.accumulatedContext)
    const label = tierLabel("Previous Stage Context", policy.accumulatedContext)
    context += `\n## ${label}\n${selected}\n`
  }

  // Run history context (previous attempts on this issue) — compressed format
  if (options?.projectDir && options?.issueNumber) {
    const records = readRunHistory(options.projectDir, options.issueNumber)
    const runHistorySection = formatRunHistoryCompressed(records)
    if (runHistorySection) {
      context += `\n${runHistorySection}\n`
    }
  }

  // Feedback is never tiered — always full
  if (feedback) {
    context += `\n## Human Feedback\n${feedback}\n`
  }

  return prompt.replace("{{TASK_CONTEXT}}", context)
}

function selectContent(
  filePath: string,
  content: string,
  tier: ContextTier,
): string {
  if (tier === "L2") return content
  const tiered = getTieredContent(filePath, content)
  return selectTier(tiered, tier)
}

function tierLabel(sectionName: string, tier: ContextTier): string {
  if (tier === "L2") return sectionName
  if (tier === "L1") return `${sectionName} (overview)`
  return `${sectionName} (abstract)`
}
