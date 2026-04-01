import * as fs from "fs"
import { execFileSync } from "child_process"

export interface CheckResult {
  name: string
  ok: boolean
  detail?: string
  fix?: string
}

export function checkCommand(name: string, args: string[], fix: string): CheckResult {
  try {
    const output = execFileSync(name, args, {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim()
    return { name: `${name} CLI`, ok: true, detail: output.split("\n")[0] }
  } catch {
    return { name: `${name} CLI`, ok: false, fix }
  }
}

export function checkFile(filePath: string, description: string, fix: string): CheckResult {
  if (fs.existsSync(filePath)) {
    return { name: description, ok: true, detail: filePath }
  }
  return { name: description, ok: false, fix }
}

export function checkGhAuth(cwd: string): CheckResult {
  try {
    const output = execFileSync("gh", ["auth", "status"], {
      encoding: "utf-8",
      timeout: 10_000,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim()
    const account = output.match(/Logged in to .* account (\S+)/)?.[1]
    return { name: "gh auth", ok: true, detail: account ?? "authenticated" }
  } catch (err) {
    const stderr = (err instanceof Error && "stderr" in err) ? String((err as Record<string, unknown>).stderr ?? "") : ""
    if (stderr.includes("not logged")) {
      return { name: "gh auth", ok: false, fix: "Run: gh auth login" }
    }
    return { name: "gh auth", ok: true, detail: "authenticated (partial check)" }
  }
}

export function checkGhRepoAccess(cwd: string): CheckResult {
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf-8",
      timeout: 5_000,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim()
    const match = remote.match(/github\.com[/:]([^/]+)\/([^/.]+)/)
    if (!match) {
      return { name: "GitHub repo", ok: false, fix: "Set git remote origin to a GitHub URL" }
    }
    const repoSlug = `${match[1]}/${match[2]}`

    execFileSync("gh", ["repo", "view", repoSlug, "--json", "name"], {
      encoding: "utf-8",
      timeout: 10_000,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    })
    return { name: "GitHub repo access", ok: true, detail: repoSlug }
  } catch {
    return { name: "GitHub repo access", ok: false, fix: "Verify gh auth and repo permissions" }
  }
}

export function checkGhSecret(repoSlug: string, secretName: string): CheckResult {
  try {
    const output = execFileSync("gh", ["secret", "list", "--repo", repoSlug], {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim()
    if (output.includes(secretName)) {
      return { name: `Secret: ${secretName}`, ok: true, detail: "configured" }
    }
    return {
      name: `Secret: ${secretName}`,
      ok: false,
      fix: `Run: gh secret set ${secretName} --repo ${repoSlug}`,
    }
  } catch {
    return {
      name: `Secret: ${secretName}`,
      ok: false,
      fix: `Run: gh secret set ${secretName} --repo ${repoSlug} (or check permissions)`,
    }
  }
}
