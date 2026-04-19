import { execFileSync } from "child_process"

export interface TestRequirement {
  /** Glob-style pattern (limited: only `**` and `*` wildcards). */
  pattern: string
  /** Sibling-file template; tokens: `{name}` (filename without .ts), `{ext}` (.ts). */
  requireSibling: string
}

export interface MissingTest {
  file: string
  expectedTest: string
}

/**
 * Convert a glob-ish pattern to a RegExp.
 *   `**`  → match any number of path segments
 *   `*`   → match any chars except `/`
 *   any other regex meta → escaped
 */
export function patternToRegex(pattern: string): RegExp {
  // Escape regex metas EXCEPT `*` and `/`
  let s = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
  // `**/` matches zero or more path segments; `**` matches anything across slashes;
  // `*` matches any chars within a single segment.
  s = s.replace(/\*\*\//g, "§S").replace(/\*\*/g, "§A").replace(/\*/g, "[^/]*")
  s = s.replace(/§S/g, "(?:.*/)?").replace(/§A/g, ".*")
  return new RegExp(`^${s}$`)
}

/**
 * Render the sibling-test path for a given source file.
 *   `src/app/api/x/route.ts` + `requireSibling: "{name}.test.ts"` →
 *   `src/app/api/x/route.test.ts`
 */
export function renderSiblingPath(file: string, requireSibling: string): string {
  const lastSlash = file.lastIndexOf("/")
  const dir = lastSlash === -1 ? "" : file.slice(0, lastSlash + 1)
  const base = lastSlash === -1 ? file : file.slice(lastSlash + 1)
  const name = base.replace(/\.[^.]+$/, "")
  const ext = base.match(/\.[^.]+$/)?.[0] ?? ""
  const sibling = requireSibling.replace(/\{name\}/g, name).replace(/\{ext\}/g, ext)
  return dir + sibling
}

function safeGit(args: string[], cwd?: string): string {
  try {
    return execFileSync("git", args, { encoding: "utf-8", cwd, env: { ...process.env, HUSKY: "0" } }).trim()
  } catch { return "" }
}

/**
 * Files the agent added this run: new files committed since `origin/<base>`
 * + untracked files in the worktree. Does NOT include modifications to
 * existing files (those don't need a fresh test added).
 */
export function getAddedFiles(baseBranch: string, cwd?: string): string[] {
  const committed = safeGit(["diff", "--name-only", "--diff-filter=A", `origin/${baseBranch}...HEAD`], cwd)
  const untracked = safeGit(["ls-files", "--others", "--exclude-standard"], cwd)
  const set = new Set<string>()
  for (const f of committed.split("\n")) if (f) set.add(f)
  for (const f of untracked.split("\n")) if (f) set.add(f)
  return [...set]
}

/**
 * For each newly added file matching a pattern, check that the required
 * sibling test file is ALSO in the added-files set. Return the list of
 * misses.
 */
export function checkCoverage(
  addedFiles: string[],
  requirements: TestRequirement[],
): MissingTest[] {
  if (requirements.length === 0) return []
  const addedSet = new Set(addedFiles)
  const misses: MissingTest[] = []

  for (const file of addedFiles) {
    // Skip files that are themselves test files
    if (/\.(test|spec)\./.test(file)) continue
    for (const req of requirements) {
      const re = patternToRegex(req.pattern)
      if (!re.test(file)) continue
      const expected = renderSiblingPath(file, req.requireSibling)
      if (!addedSet.has(expected)) {
        misses.push({ file, expectedTest: expected })
      }
      break
    }
  }
  return misses
}

export function formatMissesForFeedback(misses: MissingTest[]): string {
  if (misses.length === 0) return ""
  const lines = ["The following files were added without a sibling test file:"]
  for (const m of misses) lines.push(`- \`${m.file}\` → expected \`${m.expectedTest}\``)
  lines.push("")
  lines.push("Add the missing test files. Each should cover the new file's public API with at least a happy path and one failure path. Then re-emit DONE / COMMIT_MSG / PR_SUMMARY.")
  return lines.join("\n")
}
