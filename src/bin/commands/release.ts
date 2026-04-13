/**
 * Release command — automates version bump, changelog, release PR, tagging, and publish.
 *
 * Two modes:
 *   kody-engine release             — pre-merge: checks → bump → changelog → PR
 *   kody-engine release --finalize  — post-merge: tag → GitHub release → publish → notify → cleanup
 */

import * as fs from "fs"
import * as path from "path"
import { execSync } from "child_process"
import { logger } from "../../logger.js"
import { getProjectConfig, type KodyConfig } from "../../config.js"
import {
  getDefaultBranch,
  getCurrentBranch,
  getLatestTag,
  getLogSince,
  createTag,
  pushTags,
  createBranch,
  checkoutBranch,
  commitAll,
  pushBranch,
} from "../../git-utils.js"
import {
  createPR,
  setLabel,
  postComment,
  postPRComment,
  createGitHubRelease,
  isCIGreenOnBranch,
  getBlockingPRs,
  deleteRemoteBranch,
  findMergedPRByHead,
} from "../../github-api.js"

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ReleaseInput {
  bump?: "major" | "minor" | "patch"
  dryRun: boolean
  finalize: boolean
  noPublish?: boolean
  noNotify?: boolean
  issueNumber?: number
  cwd?: string
}

export interface ReleaseConfig {
  versionFiles: string[]
  publishCommand: string
  notifyCommand: string
  releaseBranch: string
  labels: string[]
  draftRelease: boolean
}

export interface ConventionalCommit {
  hash: string
  type: string
  scope?: string
  breaking: boolean
  subject: string
  prNumber?: number
}

// ─── Constants ──────────────────────────────────────────────────────────────

const CONVENTIONAL_RE = /^(\w+)(?:\(([^)]+)\))?(!)?\s*:\s*(.+)$/

const CHANGELOG_SECTIONS: Record<string, string> = {
  feat: "Features",
  fix: "Bug Fixes",
  perf: "Performance",
  refactor: "Refactoring",
  docs: "Documentation",
  test: "Tests",
  chore: "Maintenance",
  ci: "CI/CD",
}

const MAX_COMMITS_FIRST_RELEASE = 100

// ─── Pure functions ─────────────────────────────────────────────────────────

export function getReleaseConfig(config: KodyConfig): ReleaseConfig {
  const defaults: ReleaseConfig = {
    versionFiles: ["package.json"],
    publishCommand: "",
    notifyCommand: "",
    releaseBranch: config.git.defaultBranch,
    labels: ["kody:release"],
    draftRelease: false,
  }
  if (!config.release) return defaults
  return {
    versionFiles: config.release.versionFiles ?? defaults.versionFiles,
    // Read from env vars — these override any kody.yml value
    publishCommand: process.env.KODY_PUBLISH_COMMAND ?? config.release.publishCommand ?? defaults.publishCommand,
    notifyCommand: process.env.KODY_NOTIFY_COMMAND ?? config.release.notifyCommand ?? defaults.notifyCommand,
    releaseBranch: config.release.releaseBranch ?? defaults.releaseBranch,
    labels: config.release.labels ?? defaults.labels,
    draftRelease: config.release.draftRelease ?? defaults.draftRelease,
  }
}

export function getCurrentVersion(cwd: string, versionFiles: string[]): string {
  for (const file of versionFiles) {
    const filePath = path.resolve(cwd, file)
    if (!fs.existsSync(filePath)) continue

    if (file.endsWith(".json")) {
      const content = JSON.parse(fs.readFileSync(filePath, "utf-8"))
      if (content.version) return content.version
    } else {
      // Generic: look for a version-like pattern
      const text = fs.readFileSync(filePath, "utf-8")
      const match = text.match(/\bversion\s*[:=]\s*["']?(\d+\.\d+\.\d+)["']?/i)
      if (match) return match[1]
    }
  }
  throw new Error(`No version found in: ${versionFiles.join(", ")}`)
}

export function parseConventionalCommits(lines: string[]): ConventionalCommit[] {
  return lines.map((line) => {
    const spaceIdx = line.indexOf(" ")
    if (spaceIdx === -1) return { hash: line, type: "other", breaking: false, subject: line }

    const hash = line.slice(0, spaceIdx)
    const subject = line.slice(spaceIdx + 1)

    const match = subject.match(CONVENTIONAL_RE)
    if (!match) {
      return { hash, type: "other", breaking: false, subject }
    }

    const [, type, scope, bang, msg] = match
    const prMatch = msg.match(/\(#(\d+)\)\s*$/)

    return {
      hash,
      type: type.toLowerCase(),
      scope: scope || undefined,
      breaking: !!bang,
      subject: msg,
      prNumber: prMatch ? parseInt(prMatch[1], 10) : undefined,
    }
  })
}

export function determineBumpType(
  commits: ConventionalCommit[],
  override?: "major" | "minor" | "patch",
): "major" | "minor" | "patch" {
  if (override) return override

  const hasBreaking = commits.some((c) => c.breaking)
  if (hasBreaking) return "major"

  const hasFeat = commits.some((c) => c.type === "feat")
  if (hasFeat) return "minor"

  return "patch"
}

export function bumpVersion(
  current: string,
  bump: "major" | "minor" | "patch",
): string {
  const parts = current.split(".").map(Number)
  if (parts.length !== 3 || parts.some(isNaN)) {
    throw new Error(`Invalid semver: ${current}`)
  }
  const [major, minor, patch] = parts
  switch (bump) {
    case "major": return `${major + 1}.0.0`
    case "minor": return `${major}.${minor + 1}.0`
    case "patch": return `${major}.${minor}.${patch + 1}`
  }
}

export function updateVersionFiles(
  cwd: string,
  versionFiles: string[],
  oldVersion: string,
  newVersion: string,
  dryRun: boolean,
): string[] {
  const updated: string[] = []

  for (const file of versionFiles) {
    const filePath = path.resolve(cwd, file)
    if (!fs.existsSync(filePath)) {
      logger.warn(`  Version file not found, skipping: ${file}`)
      continue
    }

    if (file.endsWith(".json")) {
      const content = JSON.parse(fs.readFileSync(filePath, "utf-8"))
      if (content.version === oldVersion) {
        content.version = newVersion
        if (!dryRun) {
          fs.writeFileSync(filePath, JSON.stringify(content, null, 2) + "\n")
        }
        updated.push(file)
      }
    } else {
      const text = fs.readFileSync(filePath, "utf-8")
      const newText = text.replace(oldVersion, newVersion)
      if (newText !== text) {
        if (!dryRun) {
          fs.writeFileSync(filePath, newText)
        }
        updated.push(file)
      }
    }
  }

  return updated
}

export function generateChangelog(
  commits: ConventionalCommit[],
  version: string,
  date: string,
): string {
  const sections: Record<string, string[]> = {}
  const breaking: string[] = []

  for (const commit of commits) {
    if (commit.breaking) {
      breaking.push(`- ${commit.subject} (${commit.hash})`)
    }

    const sectionName = CHANGELOG_SECTIONS[commit.type] ?? "Other Changes"
    if (!sections[sectionName]) sections[sectionName] = []

    const scope = commit.scope ? `**${commit.scope}:** ` : ""
    const pr = commit.prNumber ? ` (#${commit.prNumber})` : ""
    sections[sectionName].push(`- ${scope}${commit.subject}${pr}`)
  }

  const lines: string[] = [`## [${version}] - ${date}`, ""]

  if (breaking.length > 0) {
    lines.push("### BREAKING CHANGES", "", ...breaking, "")
  }

  // Ordered: Features first, then Bug Fixes, then alphabetical
  const orderedSections = ["Features", "Bug Fixes", "Performance"]
  const remaining = Object.keys(sections)
    .filter((s) => !orderedSections.includes(s))
    .sort()

  for (const section of [...orderedSections, ...remaining]) {
    if (!sections[section] || sections[section].length === 0) continue
    lines.push(`### ${section}`, "", ...sections[section], "")
  }

  return lines.join("\n")
}

export function updateChangelogFile(
  cwd: string,
  changelogContent: string,
  dryRun: boolean,
): void {
  const changelogPath = path.resolve(cwd, "CHANGELOG.md")

  if (dryRun) {
    logger.info("  [dry-run] Would update CHANGELOG.md")
    return
  }

  if (fs.existsSync(changelogPath)) {
    const existing = fs.readFileSync(changelogPath, "utf-8")
    // Insert after the first heading line (# Changelog)
    const headerMatch = existing.match(/^#[^\n]*\n/)
    if (headerMatch) {
      const insertPoint = headerMatch[0].length
      const newContent =
        existing.slice(0, insertPoint) +
        "\n" +
        changelogContent +
        "\n" +
        existing.slice(insertPoint)
      fs.writeFileSync(changelogPath, newContent)
    } else {
      fs.writeFileSync(changelogPath, changelogContent + "\n\n" + existing)
    }
  } else {
    fs.writeFileSync(
      changelogPath,
      `# Changelog\n\nAll notable changes to this project will be documented in this file.\n\n${changelogContent}\n`,
    )
  }

  logger.info("  CHANGELOG.md updated")
}

export function runShellHook(
  command: string,
  version: string,
  label: string,
  dryRun: boolean,
): boolean {
  if (!command) return true

  const interpolated = command.replace(/\$VERSION/g, version)

  if (dryRun) {
    logger.info(`  [dry-run] Would run ${label}: ${interpolated}`)
    return true
  }

  try {
    logger.info(`  Running ${label}: ${interpolated}`)
    execSync(interpolated, { stdio: "inherit", timeout: 300_000 })
    return true
  } catch (err) {
    logger.error(`  ${label} failed: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

// ─── Pre-release checks ────────────────────────────────────────────────────

export function runPreReleaseChecks(
  cwd: string,
  defaultBranch: string,
  testCommand: string,
  dryRun: boolean,
): { passed: boolean; failures: string[] } {
  const failures: string[] = []

  // 1. CI green on default branch (warning only — test suite in step 3 is the real gate)
  // Skip this check when running in GitHub Actions — the release workflow itself may still be
  // in-progress, so isCIGreenOnBranch will often return false incorrectly.
  if (process.env.GITHUB_ACTIONS !== "true") {
    logger.info("  Checking CI status...")
    if (!isCIGreenOnBranch(defaultBranch)) {
      logger.warn(`  CI may not be green on ${defaultBranch} (could be in-progress or from another workflow)`)
    }
  }

  // 2. No draft/WIP PRs
  logger.info("  Checking for blocking PRs...")
  const blocking = getBlockingPRs(defaultBranch)
  if (blocking.length > 0) {
    const list = blocking.map((p) => `#${p.number} (${p.title})`).join(", ")
    failures.push(`Draft/WIP PRs targeting ${defaultBranch}: ${list}`)
  }

  // 3. Run test suite
  if (testCommand && !dryRun) {
    logger.info(`  Running test suite: ${testCommand}`)
    try {
      execSync(testCommand, { cwd, stdio: "inherit", timeout: 600_000 })
    } catch {
      failures.push("Test suite failed")
    }
  }

  return { passed: failures.length === 0, failures }
}

// ─── Orchestration: pre-merge ───────────────────────────────────────────────

export async function releaseCommand(input: ReleaseInput): Promise<void> {
  const cwd = input.cwd ?? process.cwd()
  const config = getProjectConfig()
  const rc = getReleaseConfig(config)
  const defaultBranch = getDefaultBranch(cwd)
  const prefix = input.dryRun ? "[dry-run] " : ""

  logger.info(`${prefix}Starting release from ${defaultBranch}...`)

  // 1. Pre-release checks
  logger.info("Step 1/4: Pre-release checks")
  const checks = runPreReleaseChecks(cwd, defaultBranch, config.quality.testUnit, input.dryRun)
  if (!checks.passed) {
    logger.error("Pre-release checks failed:")
    for (const f of checks.failures) logger.error(`  - ${f}`)
    if (!input.dryRun) {
      process.exit(1)
    }
    logger.warn("  [dry-run] Continuing despite failures...")
  }

  // 2. Version bump
  logger.info("Step 2/4: Version bump")
  const currentVersion = getCurrentVersion(cwd, rc.versionFiles)
  const lastTag = getLatestTag(cwd)
  let logLines = getLogSince(lastTag, cwd)
  if (!lastTag && logLines.length > MAX_COMMITS_FIRST_RELEASE) {
    logger.warn(`  First release: capping changelog at ${MAX_COMMITS_FIRST_RELEASE} commits`)
    logLines = logLines.slice(0, MAX_COMMITS_FIRST_RELEASE)
  }
  const commits = parseConventionalCommits(logLines)

  if (commits.length === 0) {
    logger.warn("No commits found since last release. Nothing to release.")
    return
  }

  const bump = determineBumpType(commits, input.bump)
  const newVersion = bumpVersion(currentVersion, bump)
  logger.info(`  ${currentVersion} → ${newVersion} (${bump})`)
  logger.info(`  ${commits.length} commits since ${lastTag ?? "beginning"}`)

  const updatedFiles = updateVersionFiles(cwd, rc.versionFiles, currentVersion, newVersion, input.dryRun)
  if (updatedFiles.length > 0) {
    logger.info(`  Updated: ${updatedFiles.join(", ")}`)
  }

  // 3. Changelog
  logger.info("Step 3/4: Changelog generation")
  const today = new Date().toISOString().slice(0, 10)
  const changelog = generateChangelog(commits, newVersion, today)
  updateChangelogFile(cwd, changelog, input.dryRun)

  if (input.dryRun) {
    logger.info("\n--- Changelog preview ---")
    logger.info(changelog)
    logger.info("--- End preview ---\n")
  }

  // 4. Create release PR
  logger.info("Step 4/4: Create release PR")
  const releaseBranch = `release/v${newVersion}`

  if (input.dryRun) {
    logger.info(`  [dry-run] Would create branch: ${releaseBranch}`)
    logger.info(`  [dry-run] Would commit: chore: release v${newVersion}`)
    logger.info(`  [dry-run] Would create PR: ${releaseBranch} → ${rc.releaseBranch}`)
    logger.info(`  [dry-run] Would add labels: ${rc.labels.join(", ")}`)
    logger.info("\nDry run complete.")
    return
  }

  // Ensure we're on the default branch before creating release branch
  const currentBranch = getCurrentBranch(cwd)
  if (currentBranch !== defaultBranch) {
    checkoutBranch(defaultBranch, cwd)
  }

  createBranch(releaseBranch, cwd)

  // Re-apply version bump and changelog on the release branch
  // (they were already computed but files might need re-writing after branch switch)
  updateVersionFiles(cwd, rc.versionFiles, currentVersion, newVersion, false)
  updateChangelogFile(cwd, changelog, false)

  const commitResult = commitAll(`chore: release v${newVersion}`, cwd)
  if (!commitResult.success) {
    logger.error("  Failed to commit release changes")
    process.exit(1)
  }

  pushBranch(cwd)

  const prBody = `## Release v${newVersion}\n\n${changelog}\n\n---\n*Generated by \`kody-engine release\`*`
  const pr = createPR(releaseBranch, rc.releaseBranch, `chore: release v${newVersion}`, prBody)

  if (pr) {
    for (const label of rc.labels) {
      setLabel(pr.number, label)
    }
    logger.info(`\nRelease PR created: ${pr.url}`)
    logger.info(`Merge it to trigger: kody-engine release --finalize`)

    if (input.issueNumber) {
      postComment(input.issueNumber,
        `📦 **Release PR created:** ${pr.url}\n\n` +
        `**Version:** ${currentVersion} → ${newVersion} (${bump})\n` +
        `**Commits:** ${commits.length} since ${lastTag ?? "beginning"}\n\n` +
        `After merging, run \`@kody release --finalize\` to tag and publish.`,
      )
    }
  } else {
    logger.error("Failed to create release PR")
    if (input.issueNumber) {
      postComment(input.issueNumber, `❌ Release failed: could not create PR for v${newVersion}`)
    }
    process.exit(1)
  }
}

// ─── Orchestration: post-merge (finalize) ───────────────────────────────────

export async function releaseFinalizeCommand(input: ReleaseInput): Promise<void> {
  const cwd = input.cwd ?? process.cwd()
  const config = getProjectConfig()
  const rc = getReleaseConfig(config)
  const prefix = input.dryRun ? "[dry-run] " : ""

  logger.info(`${prefix}Finalizing release...`)

  // Read version from the (now merged) version file
  const version = getCurrentVersion(cwd, rc.versionFiles)
  const tag = `v${version}`
  const releaseBranch = `release/v${version}`

  logger.info(`  Version: ${version}`)
  logger.info(`  Tag: ${tag}`)

  // 1. Create and push tag
  logger.info("Step 1/5: Create git tag")
  if (input.dryRun) {
    logger.info(`  [dry-run] Would create tag: ${tag}`)
  } else {
    createTag(tag, `Release ${version}`, cwd)
    pushTags(cwd)
    logger.info(`  Tag ${tag} created and pushed`)
  }

  // 2. Create GitHub Release
  logger.info("Step 2/5: Create GitHub Release")
  const mergedPR = findMergedPRByHead(releaseBranch)
  const releaseBody = mergedPR?.body ?? `Release ${version}`

  if (input.dryRun) {
    logger.info(`  [dry-run] Would create GitHub Release for ${tag}`)
  } else {
    const url = createGitHubRelease(tag, `v${version}`, releaseBody, rc.draftRelease)
    if (url) {
      logger.info(`  GitHub Release: ${url}`)
    }
  }

  // 3. Publish
  logger.info("Step 3/5: Publish")
  if (input.noPublish || !rc.publishCommand) {
    logger.info("  Publish skipped")
  } else {
    runShellHook(rc.publishCommand, version, "publish", input.dryRun)
  }

  // 4. Notify
  logger.info("Step 4/5: Notify")
  if (input.noNotify || !rc.notifyCommand) {
    logger.info("  Notifications skipped")
  } else {
    runShellHook(rc.notifyCommand, version, "notify", input.dryRun)
  }

  // 5. Cleanup
  logger.info("Step 5/5: Cleanup")
  if (input.dryRun) {
    logger.info(`  [dry-run] Would delete branch: ${releaseBranch}`)
  } else {
    deleteRemoteBranch(releaseBranch)
    if (mergedPR) {
      postPRComment(mergedPR.number, `Released in v${version}`)
    }
  }

  // 6. Sync dev branch
  const devBranch = process.env.KODY_DEV_BRANCH ?? "dev"
  logger.info(`Step 6/6: Sync dev branch (${devBranch})`)
  if (input.dryRun) {
    logger.info(`  [dry-run] Would merge ${rc.releaseBranch} → ${devBranch} and create sync PR`)
  } else {
    try {
      checkoutBranch(devBranch, cwd)
      logger.info(`  Checked out ${devBranch}`)
    } catch {
      logger.warn(`  Branch '${devBranch}' not found — skipping dev sync`)
    }
    try {
      execSync(`git fetch origin ${rc.releaseBranch} && git merge --no-edit origin/${rc.releaseBranch}`, {
        cwd,
        stdio: "pipe",
        timeout: 60_000,
        env: { ...process.env, HUSKY: "0", SKIP_HOOKS: "1" },
      })
      pushBranch(cwd)
      logger.info(`  Merged ${rc.releaseBranch} into ${devBranch} and pushed`)
      const syncPr = createPR(rc.releaseBranch, devBranch, `chore: sync ${devBranch} from ${rc.releaseBranch}`, `Sync ${devBranch} with latest release v${version} from ${rc.releaseBranch}.\n\n*Generated by \`kody-engine release --finalize\`*`)
      if (syncPr) {
        logger.info(`  Sync PR created: ${syncPr.url}`)
        for (const label of rc.labels) {
          setLabel(syncPr.number, label)
        }
      }
    } catch (err) {
      logger.warn(`  Dev sync failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  logger.info(`\n${prefix}Release v${version} complete!`)

  if (input.issueNumber && !input.dryRun) {
    postComment(input.issueNumber,
      `🚀 **Release v${version} finalized!**\n\n` +
      `- Tag: \`${tag}\`\n` +
      `- [GitHub Release](https://github.com/${config.github.owner}/${config.github.repo}/releases/tag/${tag})\n` +
      (rc.publishCommand ? `- Published\n` : "") +
      (rc.notifyCommand ? `- Notification sent\n` : ""),
    )
  }
}
