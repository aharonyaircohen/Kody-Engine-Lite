import * as fs from "fs"
import * as path from "path"

import type { PipelineContext } from "../types.js"
import { postComment, setLifecycleLabel } from "../github-api.js"
import { logger } from "../logger.js"

const TRIVIAL_PATTERNS = [
  /^none\.?$/i,
  /^no questions\.?$/i,
  /^n\/a\.?$/i,
  /^not applicable\.?$/i,
  /requirements are clear/i,
  /no (?:additional|further|open) questions/i,
  /nothing to (?:ask|clarify)/i,
  /^no (?:clarification|ambiguity)/i,
  /task (?:is )?(?:clear|straightforward|well.defined)/i,
]

export function isTrivialQuestion(q: string): boolean {
  const trimmed = q.trim()
  if (!trimmed) return true
  return TRIVIAL_PATTERNS.some((p) => p.test(trimmed))
}

export function checkForQuestions(ctx: PipelineContext, stageName: string): boolean {
  if (ctx.input.local || !ctx.input.issueNumber) return false

  try {
    if (stageName === "taskify") {
      const taskJsonPath = path.join(ctx.taskDir, "task.json")
      if (!fs.existsSync(taskJsonPath)) return false
      const raw = fs.readFileSync(taskJsonPath, "utf-8")
      const cleaned = raw.replace(/^```json\s*\n?/m, "").replace(/\n?```\s*$/m, "")
      const taskJson = JSON.parse(cleaned)
      if (taskJson.questions && Array.isArray(taskJson.questions)) {
        const realQuestions = taskJson.questions.filter((q: string) => !isTrivialQuestion(q))
        if (realQuestions.length > 0) {
          const body = `🤔 **Kody has questions before proceeding:**\n\n${realQuestions.map((q: string, i: number) => `${i + 1}. ${q}`).join("\n")}\n\nReply with \`@kody approve\` and your answers in the comment body.`
          postComment(ctx.input.issueNumber, body)
          setLifecycleLabel(ctx.input.issueNumber, "paused")
          return true
        }
        if (taskJson.questions.length > 0) {
          logger.info(`  Filtered ${taskJson.questions.length} trivial question(s) — continuing`)
        }
      }
    }

    if (stageName === "plan") {
      const planPath = path.join(ctx.taskDir, "plan.md")
      if (!fs.existsSync(planPath)) return false
      const plan = fs.readFileSync(planPath, "utf-8")
      const questionsMatch = plan.match(/## Questions\s*\n([\s\S]*?)(?=\n## |\n*$)/)
      if (questionsMatch) {
        const questionsText = questionsMatch[1].trim()
        const allQuestions = questionsText.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2))
        const realQuestions = allQuestions.filter((q) => !isTrivialQuestion(q))
        if (realQuestions.length > 0) {
          const body = `🏗️ **Kody has architecture questions:**\n\n${realQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n")}\n\nReply with \`@kody approve\` and your answers in the comment body.`
          postComment(ctx.input.issueNumber, body)
          setLifecycleLabel(ctx.input.issueNumber, "paused")
          return true
        }
        if (allQuestions.length > 0) {
          logger.info(`  Filtered ${allQuestions.length} trivial question(s) — continuing`)
        }
      }
    }
  } catch {
    // Don't fail pipeline on question parsing errors
  }

  return false
}
