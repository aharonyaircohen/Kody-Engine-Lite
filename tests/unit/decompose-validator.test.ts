import { describe, it, expect } from "vitest"
import { validateDecomposeJson, hasCyclicDependencies } from "../../src/validators.js"

describe("validateDecomposeJson", () => {
  const validDecomposable = JSON.stringify({
    decomposable: true,
    reason: "Plan steps cluster into 2 groups",
    complexity_score: 7,
    recommended_subtasks: 2,
    sub_tasks: [
      {
        id: "part-1",
        title: "API layer",
        description: "Implement API endpoints",
        scope: ["src/api/endpoint.ts", "src/api/types.ts"],
        plan_steps: [1, 2],
        depends_on: [],
        shared_context: "Uses shared types",
      },
      {
        id: "part-2",
        title: "UI layer",
        description: "Implement frontend components",
        scope: ["src/components/Form.tsx"],
        plan_steps: [3, 4],
        depends_on: [],
        shared_context: "Calls API from part-1",
      },
    ],
  })

  const validNotDecomposable = JSON.stringify({
    decomposable: false,
    reason: "All steps share the same file",
    complexity_score: 3,
    recommended_subtasks: 1,
    sub_tasks: [],
  })

  it("passes valid decomposable output", () => {
    expect(validateDecomposeJson(validDecomposable)).toEqual({ valid: true })
  })

  it("passes valid non-decomposable output", () => {
    expect(validateDecomposeJson(validNotDecomposable)).toEqual({ valid: true })
  })

  it("passes JSON wrapped in markdown fences", () => {
    expect(validateDecomposeJson(`\`\`\`json\n${validDecomposable}\n\`\`\``)).toEqual({ valid: true })
  })

  it("fails on invalid JSON", () => {
    const result = validateDecomposeJson("not json")
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/Invalid JSON/)
  })

  it("fails when decomposable is not boolean", () => {
    const result = validateDecomposeJson(JSON.stringify({
      decomposable: "yes",
      reason: "test",
      complexity_score: 5,
      recommended_subtasks: 1,
      sub_tasks: [],
    }))
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/decomposable/)
  })

  it("fails when complexity_score is out of range", () => {
    const result = validateDecomposeJson(JSON.stringify({
      decomposable: false,
      reason: "test",
      complexity_score: 11,
      recommended_subtasks: 1,
      sub_tasks: [],
    }))
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/complexity_score/)
  })

  it("fails when complexity_score is 0", () => {
    const result = validateDecomposeJson(JSON.stringify({
      decomposable: false,
      reason: "test",
      complexity_score: 0,
      recommended_subtasks: 1,
      sub_tasks: [],
    }))
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/complexity_score/)
  })

  it("fails when complexity_score is not integer", () => {
    const result = validateDecomposeJson(JSON.stringify({
      decomposable: false,
      reason: "test",
      complexity_score: 5.5,
      recommended_subtasks: 1,
      sub_tasks: [],
    }))
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/complexity_score/)
  })

  it("fails when reason is empty", () => {
    const result = validateDecomposeJson(JSON.stringify({
      decomposable: false,
      reason: "",
      complexity_score: 5,
      recommended_subtasks: 1,
      sub_tasks: [],
    }))
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/reason/)
  })

  it("fails with fewer than 2 sub-tasks when decomposable", () => {
    const result = validateDecomposeJson(JSON.stringify({
      decomposable: true,
      reason: "test",
      complexity_score: 7,
      recommended_subtasks: 1,
      sub_tasks: [{
        id: "part-1", title: "t", description: "d",
        scope: ["a.ts"], plan_steps: [1], depends_on: [], shared_context: "",
      }],
    }))
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/at least 2/)
  })

  it("fails with more than 4 sub-tasks", () => {
    const tasks = Array.from({ length: 5 }, (_, i) => ({
      id: `part-${i + 1}`, title: `t${i}`, description: `d${i}`,
      scope: [`file${i}.ts`], plan_steps: [i + 1], depends_on: [], shared_context: "",
    }))
    const result = validateDecomposeJson(JSON.stringify({
      decomposable: true,
      reason: "test",
      complexity_score: 10,
      recommended_subtasks: 5,
      sub_tasks: tasks,
    }))
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/Maximum 4/)
  })

  it("fails on scope overlap between sub-tasks", () => {
    const result = validateDecomposeJson(JSON.stringify({
      decomposable: true,
      reason: "test",
      complexity_score: 7,
      recommended_subtasks: 2,
      sub_tasks: [
        { id: "part-1", title: "t1", description: "d1", scope: ["shared.ts", "a.ts"], plan_steps: [1], depends_on: [], shared_context: "" },
        { id: "part-2", title: "t2", description: "d2", scope: ["shared.ts", "b.ts"], plan_steps: [2], depends_on: [], shared_context: "" },
      ],
    }))
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/shared\.ts.*multiple/)
  })

  it("fails on plan_steps overlap", () => {
    const result = validateDecomposeJson(JSON.stringify({
      decomposable: true,
      reason: "test",
      complexity_score: 7,
      recommended_subtasks: 2,
      sub_tasks: [
        { id: "part-1", title: "t1", description: "d1", scope: ["a.ts"], plan_steps: [1, 2], depends_on: [], shared_context: "" },
        { id: "part-2", title: "t2", description: "d2", scope: ["b.ts"], plan_steps: [2, 3], depends_on: [], shared_context: "" },
      ],
    }))
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/step 2.*multiple/)
  })

  it("fails on invalid depends_on reference", () => {
    const result = validateDecomposeJson(JSON.stringify({
      decomposable: true,
      reason: "test",
      complexity_score: 7,
      recommended_subtasks: 2,
      sub_tasks: [
        { id: "part-1", title: "t1", description: "d1", scope: ["a.ts"], plan_steps: [1], depends_on: ["part-99"], shared_context: "" },
        { id: "part-2", title: "t2", description: "d2", scope: ["b.ts"], plan_steps: [2], depends_on: [], shared_context: "" },
      ],
    }))
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/unknown sub-task/)
  })

  it("fails on self-dependency", () => {
    const result = validateDecomposeJson(JSON.stringify({
      decomposable: true,
      reason: "test",
      complexity_score: 7,
      recommended_subtasks: 2,
      sub_tasks: [
        { id: "part-1", title: "t1", description: "d1", scope: ["a.ts"], plan_steps: [1], depends_on: ["part-1"], shared_context: "" },
        { id: "part-2", title: "t2", description: "d2", scope: ["b.ts"], plan_steps: [2], depends_on: [], shared_context: "" },
      ],
    }))
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/depends on itself/)
  })

  it("fails on empty scope", () => {
    const result = validateDecomposeJson(JSON.stringify({
      decomposable: true,
      reason: "test",
      complexity_score: 7,
      recommended_subtasks: 2,
      sub_tasks: [
        { id: "part-1", title: "t1", description: "d1", scope: [], plan_steps: [1], depends_on: [], shared_context: "" },
        { id: "part-2", title: "t2", description: "d2", scope: ["b.ts"], plan_steps: [2], depends_on: [], shared_context: "" },
      ],
    }))
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/non-empty scope/)
  })
})

describe("hasCyclicDependencies", () => {
  it("returns false for no dependencies", () => {
    expect(hasCyclicDependencies([
      { id: "a", depends_on: [] },
      { id: "b", depends_on: [] },
    ])).toBe(false)
  })

  it("returns false for valid chain", () => {
    expect(hasCyclicDependencies([
      { id: "a", depends_on: [] },
      { id: "b", depends_on: ["a"] },
      { id: "c", depends_on: ["b"] },
    ])).toBe(false)
  })

  it("detects direct cycle (A→B→A)", () => {
    expect(hasCyclicDependencies([
      { id: "a", depends_on: ["b"] },
      { id: "b", depends_on: ["a"] },
    ])).toBe(true)
  })

  it("detects indirect cycle (A→B→C→A)", () => {
    expect(hasCyclicDependencies([
      { id: "a", depends_on: ["b"] },
      { id: "b", depends_on: ["c"] },
      { id: "c", depends_on: ["a"] },
    ])).toBe(true)
  })

  it("returns false for diamond dependency (no cycle)", () => {
    expect(hasCyclicDependencies([
      { id: "a", depends_on: [] },
      { id: "b", depends_on: ["a"] },
      { id: "c", depends_on: ["a"] },
      { id: "d", depends_on: ["b", "c"] },
    ])).toBe(false)
  })
})
