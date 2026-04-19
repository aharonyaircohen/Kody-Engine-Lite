import * as fs from "fs"
import * as path from "path"
import { execFileSync, spawnSync } from "child_process"
import { loadConfig } from "../config.js"
import { gh, truncate } from "../issue.js"

export type BumpType = "patch" | "minor" | "major"

export interface ReleaseOptions {
  bump: BumpType
  cwd?: string
  verbose?: boolean
  dryRun?: boolean
}

export interface ReleaseResult {
  exitCode: number
  version?: string
  tag?: string
  releaseUrl?: string
  reason?: string
}

interface ReleaseConfig {
  versionFiles: string[]
  publishCommand: string
  notifyCommand: string
  timeoutMs: number
  draftRelease: boolean
}

function readReleaseConfig(cwd: string): ReleaseConfig {
  const raw = fs.readFileSync(path.join(cwd, "kody.config.json"), "utf-8")
  const parsed = JSON.parse(raw) as { release?: Partial<ReleaseConfig> }
  const r = parsed.release ?? {}
  return {
    versionFiles: Array.isArray(r.versionFiles) && r.versionFiles.length > 0 ? r.versionFiles : ["package.json"],
    publishCommand: typeof r.publishCommand === "string" ? r.publishCommand : "",
    notifyCommand: typeof r.notifyCommand === "string" ? r.notifyCommand : "",
    timeoutMs: typeof r.timeoutMs === "number" ? r.timeoutMs : 600_000,
    draftRelease: Boolean(r.draftRelease),
  }
}

function git(args: string[], cwd: string, opts: { timeout?: number } = {}): string {
  return execFileSync("git", args, {
    encoding: "utf-8",
    timeout: opts.timeout ?? 60_000,
    cwd,
    env: { ...process.env, HUSKY: "0", SKIP_HOOKS: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  }).trim()
}

export function bumpVersion(current: string, bump: BumpType): string {
  const m = current.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/)
  if (!m) throw new Error(`cannot parse version '${current}' (expected x.y.z[-suffix])`)
  let [major, minor, patch] = [parseInt(m[1]!, 10), parseInt(m[2]!, 10), parseInt(m[3]!, 10)]
  if (bump === "major") { major++; minor = 0; patch = 0 }
  else if (bump === "minor") { minor++; patch = 0 }
  else patch++
  return `${major}.${minor}.${patch}`
}

function updateVersionInFile(file: string, newVersion: string, cwd: string): boolean {
  const abs = path.join(cwd, file)
  if (!fs.existsSync(abs)) return false
  const content = fs.readFileSync(abs, "utf-8")
  // Replace only the first "version": "x.y.z" line (typical package.json / manifest shape).
  const updated = content.replace(/"version"\s*:\s*"[^"]+"/, `"version": "${newVersion}"`)
  if (updated === content) return false
  fs.writeFileSync(abs, updated)
  return true
}

function runShell(cmd: string, cwd: string, timeoutMs: number): { exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync(cmd, {
    cwd,
    shell: true,
    env: { ...process.env, HUSKY: "0", SKIP_HOOKS: "1", CI: process.env.CI ?? "1" },
    encoding: "utf-8",
    timeout: timeoutMs,
  })
  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  }
}

export async function runRelease(opts: ReleaseOptions): Promise<ReleaseResult> {
  const cwd = opts.cwd ?? process.cwd()

  let config: ReturnType<typeof loadConfig>
  try { config = loadConfig(cwd) } catch (err) {
    return finishRelease({ exitCode: 99, reason: `config error: ${errMsg(err)}` })
  }

  let releaseCfg: ReleaseConfig
  try { releaseCfg = readReleaseConfig(cwd) } catch (err) {
    return finishRelease({ exitCode: 99, reason: `could not read kody.config.json release section: ${errMsg(err)}` })
  }

  const pkgPath = path.join(cwd, "package.json")
  if (!fs.existsSync(pkgPath)) {
    return finishRelease({ exitCode: 99, reason: `package.json not found at ${pkgPath}` })
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { version?: string }
  if (typeof pkg.version !== "string") {
    return finishRelease({ exitCode: 99, reason: `package.json has no 'version' field` })
  }

  const oldVersion = pkg.version
  const newVersion = bumpVersion(oldVersion, opts.bump)
  const tag = `v${newVersion}`

  // Fail early if tag already exists.
  try {
    git(["rev-parse", "--verify", tag], cwd)
    return finishRelease({ exitCode: 1, reason: `tag ${tag} already exists — bump to a higher version or delete the tag` })
  } catch { /* tag doesn't exist — good */ }

  process.stdout.write(`→ kody2 release: ${oldVersion} → ${newVersion} (${opts.bump})\n`)

  // Dry-run: stop before writing.
  if (opts.dryRun) {
    return finishRelease({ exitCode: 0, version: newVersion, tag, reason: "dry-run — no files changed" })
  }

  // Update version files.
  const touched: string[] = []
  for (const f of releaseCfg.versionFiles) {
    if (updateVersionInFile(f, newVersion, cwd)) touched.push(f)
  }
  if (touched.length === 0) {
    return finishRelease({ exitCode: 1, reason: `no version strings updated (configured files: ${releaseCfg.versionFiles.join(", ")})` })
  }
  process.stdout.write(`→ updated version in: ${touched.join(", ")}\n`)

  // Commit version bump.
  try {
    for (const f of touched) git(["add", "--", f], cwd)
    git(["commit", "--no-gpg-sign", "-m", `chore: release ${tag}`], cwd)
  } catch (err) {
    return finishRelease({ exitCode: 4, reason: `commit failed: ${errMsg(err)}` })
  }

  // Tag.
  try {
    git(["tag", "-a", tag, "-m", `Release ${tag}`], cwd)
  } catch (err) {
    return finishRelease({ exitCode: 4, reason: `tag failed: ${errMsg(err)}` })
  }

  // Push commits + tag.
  try {
    git(["push", "--follow-tags"], cwd, { timeout: 120_000 })
  } catch (err) {
    return finishRelease({ exitCode: 4, reason: `push failed: ${errMsg(err)}` })
  }

  // Run publishCommand if configured.
  let publishStatus: "skipped" | "ok" | "failed" = "skipped"
  if (releaseCfg.publishCommand.trim().length > 0) {
    const interp = releaseCfg.publishCommand.replace(/\$VERSION/g, newVersion)
    process.stdout.write(`→ publishCommand: ${interp}\n`)
    const r = runShell(interp, cwd, releaseCfg.timeoutMs)
    if (r.exitCode !== 0) {
      process.stderr.write(`[kody2 release] publishCommand exit ${r.exitCode}\n${r.stderr.slice(-2000)}\n`)
      publishStatus = "failed"
    } else {
      publishStatus = "ok"
    }
  }

  // Create GitHub release.
  let releaseUrl: string | undefined
  try {
    const body = `Release ${tag}\n\nAutomated release by kody2.`
    const args = ["release", "create", tag, "--title", tag, "--notes", body]
    if (releaseCfg.draftRelease) args.push("--draft")
    releaseUrl = gh(args, { cwd })
  } catch (err) {
    process.stderr.write(`[kody2 release] gh release create failed: ${errMsg(err)}\n`)
  }

  // Run notifyCommand if configured.
  if (releaseCfg.notifyCommand.trim().length > 0) {
    const interp = releaseCfg.notifyCommand.replace(/\$VERSION/g, newVersion)
    runShell(interp, cwd, releaseCfg.timeoutMs)
  }

  if (publishStatus === "failed") {
    return finishRelease({
      exitCode: 1,
      version: newVersion,
      tag,
      releaseUrl,
      reason: `tag + GH release created, but publishCommand failed — see stderr`,
    })
  }

  return finishRelease({ exitCode: 0, version: newVersion, tag, releaseUrl })
}

function finishRelease(r: ReleaseResult): ReleaseResult {
  if (r.tag) process.stdout.write(`RELEASE_TAG=${r.tag}\n`)
  if (r.releaseUrl) process.stdout.write(`RELEASE_URL=${r.releaseUrl}\n`)
  if (r.reason) process.stdout.write(`RELEASE_INFO=${truncate(r.reason, 500)}\n`)
  return r
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
