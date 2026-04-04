import * as fs from "fs"
import * as path from "path"

import type {
  PipelineContext,
  SubTaskDefinition,
  SubPipelineResult,
} from "../types.js"
import { STAGES } from "../definitions.js"
import { executeAgentStage } from "../stages/agent.js"
import { commitAll } from "../git-utils.js"
import { logger } from "../logger.js"

/**
 * Extract specific plan steps from the full plan markdown.
 * Looks for `## Step N` headings and includes content until the next step heading.
 */
function slicePlanSteps(fullPlan: string, stepNumbers: number[]): string {
  const stepSet = new Set(stepNumbers)
  const lines = fullPlan.split("\n")
  const sliced: string[] = []
  let capturing = false

  for (const line of lines) {
    // Match headings like "## Step 1:", "## Step 2 -", "## 1.", "## 1:"
    const stepMatch = line.match(/^##\s+(?:Step\s+)?(\d+)[\s:.—-]/)
    if (stepMatch) {
      const num = parseInt(stepMatch[1], 10)
      capturing = stepSet.has(num)
    }

    if (capturing) {
      sliced.push(line)
    }
  }

  // If no structured steps found, return the full plan (agent will figure it out)
  if (sliced.length === 0) {
    return fullPlan
  }

  return sliced.join("\n")
}

/**
 * Run a single sub-task's build stage in its own worktree.
 */
export async function runSubPipeline(
  parentCtx: PipelineContext,
  subTask: SubTaskDefinition,
  fullPlan: string,
  worktreePath: string,
): Promise<SubPipelineResult> {
  const subTaskDir = path.join(parentCtx.taskDir, "subtasks", subTask.id)
  fs.mkdirSync(subTaskDir, { recursive: true })

  try {
    // 1. Write sub-task's task.md
    const taskMd = `# ${subTask.title}\n\n${subTask.description}\n\n## Shared Context\n${subTask.shared_context}\n`
    fs.writeFileSync(path.join(subTaskDir, "task.md"), taskMd)

    // 2. Write sub-task's task.json (inherit parent's classification)
    const parentTaskJsonPath = path.join(parentCtx.taskDir, "task.json")
    let parentTask: Record<string, unknown> = {}
    if (fs.existsSync(parentTaskJsonPath)) {
      try {
        parentTask = JSON.parse(fs.readFileSync(parentTaskJsonPath, "utf-8"))
      } catch { /* use empty */ }
    }
    const subTaskJson = {
      task_type: parentTask.task_type ?? "feature",
      title: subTask.title,
      description: subTask.description,
      scope: subTask.scope,
      risk_level: parentTask.risk_level ?? "medium",
    }
    fs.writeFileSync(path.join(subTaskDir, "task.json"), JSON.stringify(subTaskJson, null, 2))

    // 3. Write sliced plan.md (only assigned steps)
    const slicedPlan = slicePlanSteps(fullPlan, subTask.plan_steps)
    fs.writeFileSync(path.join(subTaskDir, "plan.md"), slicedPlan)

    // 4. Write constraints.json (exclusive file ownership)
    const constraints = {
      allowedFiles: subTask.scope,
      forbiddenFiles: [] as string[], // populated by caller if needed
    }
    fs.writeFileSync(path.join(subTaskDir, "constraints.json"), JSON.stringify(constraints, null, 2))

    // 5. Build sub-pipeline context
    const subCtx: PipelineContext = {
      taskId: `${parentCtx.taskId}/${subTask.id}`,
      taskDir: subTaskDir,
      projectDir: worktreePath,
      runners: parentCtx.runners,
      sessions: {}, // fresh sessions for each sub-task
      tools: parentCtx.tools,
      input: {
        ...parentCtx.input,
        mode: "full",
        fromStage: undefined,
        feedback: undefined,
      },
    }

    // 6. Run build stage
    const buildDef = STAGES.find((s) => s.name === "build")!
    logger.info(`  [${subTask.id}] building in worktree: ${worktreePath}`)
    const buildResult = await executeAgentStage(subCtx, buildDef)

    if (buildResult.outcome !== "completed") {
      return {
        subTaskId: subTask.id,
        outcome: "failed",
        branchName: "",
        error: buildResult.error ?? "Build failed",
      }
    }

    // 7. Commit changes in the worktree
    const commitResult = commitAll(
      `feat(${subTask.id}): ${subTask.title}`,
      worktreePath,
    )

    if (!commitResult.success) {
      logger.warn(`  [${subTask.id}] no changes to commit`)
    }

    // Derive branch name from the worktree
    const branchName = path.basename(worktreePath)

    return {
      subTaskId: subTask.id,
      outcome: "completed",
      branchName,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error(`  [${subTask.id}] sub-pipeline error: ${msg}`)
    return {
      subTaskId: subTask.id,
      outcome: "failed",
      branchName: "",
      error: msg,
    }
  }
}

/**
 * Run multiple sub-pipelines with concurrency limit.
 */
export async function runSubPipelinesParallel(
  parentCtx: PipelineContext,
  subTasks: SubTaskDefinition[],
  fullPlan: string,
  worktreePaths: Map<string, string>,
  maxConcurrent: number,
): Promise<SubPipelineResult[]> {
  const results: SubPipelineResult[] = []
  const pending = [...subTasks]

  // Write forbidden files (sibling scopes) into each sub-task's constraints
  for (const subTask of subTasks) {
    const siblingFiles = subTasks
      .filter((st) => st.id !== subTask.id)
      .flatMap((st) => st.scope)

    const subTaskDir = path.join(parentCtx.taskDir, "subtasks", subTask.id)
    const constraintsPath = path.join(subTaskDir, "constraints.json")
    // Only update if dir exists (it's created in runSubPipeline, but we set up constraints pre-emptively)
    if (fs.existsSync(subTaskDir)) {
      const constraints = {
        allowedFiles: subTask.scope,
        forbiddenFiles: siblingFiles,
      }
      fs.writeFileSync(constraintsPath, JSON.stringify(constraints, null, 2))
    }
  }

  while (pending.length > 0) {
    const batch = pending.splice(0, maxConcurrent)
    const batchPromises = batch.map((subTask) => {
      const wtPath = worktreePaths.get(subTask.id)
      if (!wtPath) {
        return Promise.resolve({
          subTaskId: subTask.id,
          outcome: "failed" as const,
          branchName: "",
          error: "No worktree path assigned",
        })
      }
      return runSubPipeline(parentCtx, subTask, fullPlan, wtPath)
    })

    const batchResults = await Promise.allSettled(batchPromises)
    for (const settled of batchResults) {
      if (settled.status === "fulfilled") {
        results.push(settled.value)
      } else {
        results.push({
          subTaskId: "unknown",
          outcome: "failed",
          branchName: "",
          error: settled.reason instanceof Error ? settled.reason.message : String(settled.reason),
        })
      }
    }
  }

  return results
}
