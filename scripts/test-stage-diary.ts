#!/usr/bin/env tsx
/**
 * Live harness for the stage-diary distiller.
 *
 * Replays artifacts modeled on PR A-Guy-educ/A-Guy#1266 (Instructor role +
 * per-course permissions) through the real Haiku-backed distiller and prints
 * the resulting insights. Also writes them to a tmp graph and reads them
 * back so you can see the full round-trip.
 *
 * Usage (run from a directory with a valid kody.config.json — e.g. the
 * Kody-Engine-Tester repo):
 *
 *   tsx scripts/test-stage-diary.ts                 # uses CWD as config source
 *   tsx scripts/test-stage-diary.ts /path/to/proj   # uses given dir as config source
 *
 * The harness writes artifacts to a fresh temp project, so it won't touch
 * any real .kody/ directory. Set KODY_TEST_KEEP=1 to preserve the tmp dir
 * for manual inspection.
 */

import * as fs from "fs"
import * as path from "path"
import * as os from "os"

import { createRunners } from "../src/agent-runner.js"
import { getProjectConfig, setConfigDir } from "../src/config.js"
import {
  distillStageInsights,
  appendStageInsights,
  readStageInsights,
  formatStageInsightsForPrompt,
} from "../src/stage-diary.js"
import type { PipelineContext } from "../src/types.js"

const TASK_ID = "1244-260416-172516"

const TASK_MD = `# feat(LMS): Instructor role + per-course permissions

## Context

The platform has four account roles (Admin, Student, ContentEditor, AdvancedContentEditor)
and no Instructor role. TeacherProfiles control AI chat behavior but are not a system role.
Instructors are a fundamental LMS concept: they create/teach courses and see student progress.

## What Is Missing

1. No Instructor role in AccountRole — cannot distinguish instructors from content editors.
2. No per-course permissions — ContentEditors have access to ALL courses.
3. No instructor dashboard.
4. No course-instructor assignment.
5. No role request/approval workflow.

## Implementation Approach

- Add 'instructor' to AccountRole enum in src/infra/auth/roles.ts.
- Create CourseInstructors Payload collection linking users (role=instructor) to courses.
- Add instructorAccess hook (src/server/payload/hooks/auth/instructorAccess.ts).
- API routes: /api/instructor/dashboard, /api/instructor/gradebook/[courseId].
- Frontend: app/(frontend)/instructor/page.tsx + InstructorDashboardContent.
- i18n: add lms.instructor namespace to en.json and he.json.
- Tests: unit (instructorAccess) + e2e (lms-instructor-role).

## Acceptance Criteria

- 'instructor' exists in AccountRole enum.
- CourseInstructors collection exists in Payload admin.
- Instructors cannot access other instructors' courses (403).
- Instructor dashboard shows courses, total students, pending grading.
`

const PLAN_MD = `## Implementation Summary

The Instructor role and per-course permissions feature is fully implemented:

- src/infra/auth/roles.ts — added Instructor role + isInstructor()
- src/server/payload/collections/CourseInstructors.ts — created
- src/server/payload/hooks/auth/instructorAccess.ts — created
  * Note: mcp-api-key users have no 'role' property; the hook must guard
    user.collection !== 'users' before reading user.role. Use the AccountRole
    enum rather than string literals for role comparisons.
- src/app/api/instructor/dashboard/route.ts — created
- src/app/api/instructor/gradebook/[courseId]/route.ts — created
- src/app/(frontend)/instructor/page.tsx — created
- tests/unit/hooks/instructorAccess/instructorAccess.test.ts — created
- tests/e2e/lms-instructor-role.e2e.spec.ts — created

### Acceptance Criteria Met

- instructor role exists in AccountRole enum
- CourseInstructors collection exists in Payload admin
- Instructors can be assigned to specific courses
- Instructors cannot access other instructors' courses (403)
- Instructor dashboard shows stats
`

const CONTEXT_MD = `### taskify
Implemented the Instructor role and per-course permissions for the LMS. Added AccountRole.Instructor,
a CourseInstructors collection, and the instructorAccess hook. Wired dashboard + gradebook API routes
and a frontend page behind the new role.

### build
TypeScript compiles cleanly. Lint passes. Ran into a typecheck error in the access hook: the
mcp-api-key collection uses a different User type without a 'role' property. Added a
'user.collection !== "users"' guard before reading user.role to satisfy the type narrowing.
Also replaced string literal role checks with AccountRole enum values for consistency.

### review
Integration tests pass. Missing lms.instructor i18n namespace was flagged and fixed.
`

const REVIEW_MD = `## Review

verdict: FAIL (resolved in review-fix)

Findings:
1. Missing lms.instructor i18n namespace in src/i18n/en.json and he.json — breaks the
   Instructor dashboard rendering.
2. CourseInstructors access-control hook originally read user.role directly, which fails
   for mcp-api-key users (different User type, no 'role' property). Needs collection guard.

Critical fix required: add translation keys, guard user.collection in instructorAccess.ts,
and standardize on AccountRole enum rather than string literals.
`

function writeArtifacts(taskDir: string): void {
  fs.mkdirSync(taskDir, { recursive: true })
  fs.writeFileSync(path.join(taskDir, "task.md"), TASK_MD)
  fs.writeFileSync(path.join(taskDir, "plan.md"), PLAN_MD)
  fs.writeFileSync(path.join(taskDir, "context.md"), CONTEXT_MD)
  fs.writeFileSync(path.join(taskDir, "review.md"), REVIEW_MD)
  fs.writeFileSync(
    path.join(taskDir, "task.json"),
    JSON.stringify({
      taskId: TASK_ID,
      title: "Instructor role + per-course permissions",
      scope: ["src/server/payload", "src/infra/auth", "src/app/api/instructor"],
      risk_level: "medium",
      questions: [],
    }, null, 2),
  )
}

function buildCtx(projectDir: string, taskDir: string): PipelineContext {
  const config = getProjectConfig()
  const runners = createRunners(config)
  return {
    taskId: TASK_ID,
    taskDir,
    projectDir,
    runners,
    input: { mode: "full" },
  }
}

async function runStage(ctx: PipelineContext, stageName: string): Promise<void> {
  process.stdout.write(`\n━━━ ${stageName} ━━━\n`)
  const t0 = Date.now()
  const insights = await distillStageInsights(stageName, ctx)
  const ms = Date.now() - t0
  process.stdout.write(`distilled ${insights.length} insight(s) in ${ms}ms\n`)
  for (const ins of insights) {
    const scope = ins.scope ? ` [${ins.scope}]` : ""
    process.stdout.write(`  - ${ins.kind}${scope}: ${ins.text}\n`)
  }
  if (insights.length > 0) {
    appendStageInsights(ctx, stageName, insights, "auth")
  }
}

async function main(): Promise<void> {
  const configSource = process.argv[2] ?? process.cwd()
  if (!fs.existsSync(path.join(configSource, "kody.config.json"))) {
    process.stderr.write(
      `error: no kody.config.json at ${configSource}\n` +
        `Run from a directory that has one (e.g. Kody-Engine-Tester), ` +
        `or pass a path:\n  tsx scripts/test-stage-diary.ts /path/to/proj\n`,
    )
    process.exit(1)
  }
  setConfigDir(configSource)

  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-diary-live-"))
  const taskDir = path.join(projectDir, ".kody", "tasks", TASK_ID)
  writeArtifacts(taskDir)

  process.stdout.write(`config source:  ${configSource}\n`)
  process.stdout.write(`tmp project:    ${projectDir}\n`)
  process.stdout.write(`task artifacts: ${taskDir}\n`)

  const ctx = buildCtx(projectDir, taskDir)

  for (const stage of ["build", "review", "review-fix"] as const) {
    await runStage(ctx, stage)
  }

  process.stdout.write(`\n━━━ graph readback ━━━\n`)
  for (const stage of ["build", "review", "review-fix"] as const) {
    const rows = readStageInsights(projectDir, stage, 10)
    const block = formatStageInsightsForPrompt(stage, rows)
    if (block) {
      process.stdout.write(`\n${block}\n`)
    }
  }

  const nodesPath = path.join(projectDir, ".kody", "graph", "nodes.json")
  if (fs.existsSync(nodesPath)) {
    const nodes = JSON.parse(fs.readFileSync(nodesPath, "utf-8")) as Record<string, unknown>
    process.stdout.write(`\ngraph wrote ${Object.keys(nodes).length} node(s) → ${nodesPath}\n`)
  }

  process.stdout.write(`\n━━━ novelty gate ━━━\n`)
  process.stdout.write(`Re-running review stage — duplicates should be skipped...\n`)
  const before = fs.existsSync(nodesPath)
    ? Object.keys(JSON.parse(fs.readFileSync(nodesPath, "utf-8"))).length
    : 0
  await runStage(ctx, "review")
  const after = fs.existsSync(nodesPath)
    ? Object.keys(JSON.parse(fs.readFileSync(nodesPath, "utf-8"))).length
    : 0
  process.stdout.write(`nodes before: ${before}, after: ${after} (delta ${after - before})\n`)

  if (process.env.KODY_TEST_KEEP) {
    process.stdout.write(`\nKeeping ${projectDir} (KODY_TEST_KEEP=1)\n`)
  } else {
    fs.rmSync(projectDir, { recursive: true, force: true })
    process.stdout.write(`\nCleaned up ${projectDir}. Set KODY_TEST_KEEP=1 to preserve.\n`)
  }
}

main().catch((err) => {
  process.stderr.write(`harness failed: ${err instanceof Error ? err.stack : String(err)}\n`)
  process.exit(1)
})
