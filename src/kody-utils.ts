import * as fs from "fs"
import * as path from "path"

export function ensureTaskDir(taskId: string): string {
  const taskDir = path.join(process.cwd(), ".kody", "tasks", taskId)
  if (!fs.existsSync(taskDir)) {
    fs.mkdirSync(taskDir, { recursive: true })
  }
  return taskDir
}
