import * as fs from "fs"
import * as path from "path"

import type { PipelineContext } from "../types.js"
import { postComment, setLifecycleLabel } from "../github-api.js"

export function checkForQuestions(ctx: PipelineContext, stageName: string): boolean {
  if (ctx.input.local || !ctx.input.issueNumber) return false

  try {
    if (stageName === "taskify") {
      const taskJsonPath = path.join(ctx.taskDir, "task.json")
      if (!fs.existsSync(taskJsonPath)) return false
      const raw = fs.readFileSync(taskJsonPath, "utf-8")
      const cleaned = raw.replace(/^```json\s*\n?/m, "").replace(/\n?```\s*$/m, "")
      const taskJson = JSON.parse(cleaned)
      if (taskJson.questions && Array.isArray(taskJson.questions) && taskJson.questions.length > 0) {
        const body = `🤔 **Kody has questions before proceeding:**\n\n${taskJson.questions.map((q: string, i: number) => `${i + 1}. ${q}`).join("\n")}\n\nReply with \`@kody approve\` and your answers in the comment body.`
        postComment(ctx.input.issueNumber, body)
        setLifecycleLabel(ctx.input.issueNumber, "waiting")
        return true
      }
    }

    if (stageName === "plan") {
      const planPath = path.join(ctx.taskDir, "plan.md")
      if (!fs.existsSync(planPath)) return false
      const plan = fs.readFileSync(planPath, "utf-8")
      const questionsMatch = plan.match(/## Questions\s*\n([\s\S]*?)(?=\n## |\n*$)/)
      if (questionsMatch) {
        const questionsText = questionsMatch[1].trim()
        const questions = questionsText.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2))
        if (questions.length > 0) {
          const body = `🏗️ **Kody has architecture questions:**\n\n${questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}\n\nReply with \`@kody approve\` and your answers in the comment body.`
          postComment(ctx.input.issueNumber, body)
          setLifecycleLabel(ctx.input.issueNumber, "waiting")
          return true
        }
      }
    }
  } catch {
    // Don't fail pipeline on question parsing errors
  }

  return false
}
