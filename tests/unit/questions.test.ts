import { describe, it, expect } from "vitest"
import { isTrivialQuestion } from "../../src/pipeline/questions.js"

describe("isTrivialQuestion", () => {
  const trivialCases = [
    "None",
    "none.",
    "No questions",
    "No questions.",
    "N/A",
    "n/a.",
    "Not applicable",
    "Requirements are clear",
    "No additional questions",
    "No further questions",
    "Nothing to ask",
    "Nothing to clarify",
    "No clarification needed",
    "Task is clear",
    "Task is straightforward",
    "Task is well-defined",
    "The task is well defined and clear",
    "  None  ",
    "",
  ]

  it.each(trivialCases)("filters trivial question: %s", (q) => {
    expect(isTrivialQuestion(q)).toBe(true)
  })

  const realCases = [
    "Should we use JWT or session-based auth?",
    "Which database should we use for caching?",
    "Should the API return paginated results by default?",
    "None of the existing endpoints handle file uploads — should we add multipart support?",
    "Is there a preferred error format for the API?",
  ]

  it.each(realCases)("keeps real question: %s", (q) => {
    expect(isTrivialQuestion(q)).toBe(false)
  })
})
