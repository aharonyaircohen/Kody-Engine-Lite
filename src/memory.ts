import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { MemoryHall, inferHallFromFilename, inferRoomFromFilename } from "./context-tiers.js"
import { compressMemoryContent } from "./compress.js"
import * as graph from "./memory/graph/index.js"

export function readProjectMemory(projectDir: string): string {
  // Try graph store first
  const graphNodes = graph.getCurrentFacts(projectDir)
  if (graphNodes.length > 0) {
    return graph.graphNodesToMarkdown(graphNodes)
  }

  // Fallback: legacy .md files
  const memoryDir = path.join(projectDir, ".kody", "memory")
  if (!fs.existsSync(memoryDir)) return ""

  const files = fs.readdirSync(memoryDir).filter((f) => f.endsWith(".md")).sort()
  if (files.length === 0) return ""

  const sections: string[] = []
  for (const file of files) {
    const content = fs.readFileSync(path.join(memoryDir, file), "utf-8").trim()
    if (content) {
      sections.push(`## ${file.replace(".md", "")}\n${content}`)
    }
  }

  if (sections.length === 0) return ""
  return `# Project Memory\n\n${sections.join("\n\n")}\n`
}

// ─── User Brain ───────────────────────────────────────────────────────────

/** Override for testing only. */
let _testBrainPath: string | undefined

/** Get the brain base path (~/.kody/brain). */
export function getBrainBasePath(): string {
  return _testBrainPath ?? path.join(os.homedir(), ".kody", "brain")
}

/** Override brain path for testing. Call setTestBrainPath(null) to restore. */
export function setTestBrainPath(p: string | null): void {
  _testBrainPath = p ?? undefined
}

/**
 * Read user brain memory from ~/.kody/brain/memory/
 * Mirrors readProjectMemory() with a different base path.
 */
export function readBrainMemory(): string {
  const brainDir = path.join(getBrainBasePath(), "memory")
  if (!fs.existsSync(brainDir)) return ""

  const files = fs.readdirSync(brainDir).filter((f) => f.endsWith(".md")).sort()
  if (files.length === 0) return ""

  const sections: string[] = []
  for (const file of files) {
    const content = fs.readFileSync(path.join(brainDir, file), "utf-8").trim()
    if (content) {
      sections.push(`## ${file.replace(".md", "")}\n${content}`)
    }
  }

  if (sections.length === 0) return ""
  return `# User Brain\n\n${sections.join("\n\n")}\n`
}

/**
 * Write a brain entry to ~/.kody/brain/memory/<hall>_<room>.md
 * Appends to existing file or creates new.
 */
export function writeBrainEntry(hall: MemoryHall, room: string, content: string): void {
  const brainDir = path.join(getBrainBasePath(), "memory")
  if (!fs.existsSync(brainDir)) {
    fs.mkdirSync(brainDir, { recursive: true })
  }
  const filename = `${hall}_${room}.md`
  const filePath = path.join(brainDir, filename)
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, "utf-8").trim()
    fs.writeFileSync(filePath, `${existing}\n- ${content}`, "utf-8")
  } else {
    fs.writeFileSync(filePath, `- ${content}\n`, "utf-8")
  }
}

/**
 * Merge brain + project memory for prompt injection.
 * Brain is prepended first (user context is more relevant than project context).
 */
export function mergeBrainWithProject(projectDir: string): string {
  const project = readProjectMemory(projectDir)
  const brain = readBrainMemory()
  if (!project && !brain) return ""
  if (!project) return brain
  if (!brain) return project
  return `${brain}\n\n---\n\n${project}`
}

// ─── Brain Tiered Read ────────────────────────────────────────────────────

/**
 * Read brain memory with tiered summarization.
 * Mirrors readProjectMemoryTiered() with brain-specific path.
 */
export function readBrainMemoryTiered(
  tier: "L0" | "L1" | "L2",
  hallFilter?: MemoryHall[],
  roomFilter?: string[] | null,
): string {
  const brainDir = path.join(getBrainBasePath(), "memory")
  if (!fs.existsSync(brainDir)) return ""

  let files = fs.readdirSync(brainDir).filter((f) => f.endsWith(".md")).sort()
  if (files.length === 0) return ""

  // Filter by hall
  if (hallFilter && hallFilter.length > 0) {
    files = files.filter((f: string) => hallFilter.includes(inferHallFromFilename(f)))
  }

  // Filter by room
  if (roomFilter && roomFilter.length > 0) {
    files = files.filter((f: string) => {
      const room = inferRoomFromFilename(f)
      return room === null || roomFilter.includes(room)
    })
  }

  if (files.length === 0) return ""

  const sections: string[] = []
  for (const file of files) {
    const content = fs.readFileSync(path.join(brainDir, file), "utf-8").trim()
    if (!content) continue

    if (tier === "L0") {
      const compressed = compressMemoryContent(content, file)
      if (compressed) sections.push(compressed)
    } else {
      sections.push(`## ${file.replace(".md", "")}\n${content}`)
    }
  }

  if (sections.length === 0) return ""
  return `# User Brain\n${sections.join("\n")}\n`
}
