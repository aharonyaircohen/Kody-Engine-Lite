import * as fs from "fs"
import * as path from "path"

export function readProjectMemory(projectDir: string): string {
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
