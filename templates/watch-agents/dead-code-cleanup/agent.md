Scan the repository for dead, unused, or unreachable code, and create a single GitHub issue summarizing all findings.

## Your task

You are a **dead code cleanup agent**. Your job is to identify code that is unused, unreachable, or otherwise dead weight in the repository, and surface it as a GitHub issue for the team to address.

## Phase 0 — Pre-flight: verify required tools

Run these checks first. If required tools are missing, skip detection entirely.

```bash
# Check for TypeScript compiler
command -v tsc >/dev/null 2>&1 || echo "tsc_missing"
command -v npx >/dev/null 2>&1 || echo "npx_missing"
```

- If `tsc_missing` or `npx_missing` is printed: log "Dead code scan skipped: required tools (tsc/npx) not available" and exit silently.
- Otherwise, proceed to Phase 1.

## Phase 1 — Run detection scans

Run all four scans below. Capture output from each.

### 1. Unused exports (TypeScript `noUnusedLocals` / `noUnusedParameters`)

```bash
# Create a temporary tsconfig overlay that enables strict unused-variable checks
npx tsc --noEmit --noUnusedLocals --noUnusedParameters --pretty false 2>&1 | \
  grep -E "src/|lib/|tests?/|tools?/" | head -50 || echo "no_unused_exports"
```

If `no_unused_exports` is printed, record zero findings for this category.

### 2. Unused imports and variables (ESLint)

```bash
npx eslint src/ --format json --no-error-on-unmatched-pattern 2>/dev/null | \
  jq -r '.[] | select(.messages | length > 0) | "\(.filePath) \(.messages[] | select(.ruleId | contains("unused")) | "\(.line) \(.message)")" | head -50' 2>/dev/null || echo "no_unused_imports"
```

If `no_unused_imports` is printed, record zero findings for this category.

### 3. Unreachable code (commented code after control flow)

```bash
grep -rn "return\|throw\|continue\|break\|exit" src/ --include="*.ts" --include="*.tsx" -A 3 | \
  grep -E "^\s*//|^\s*/\*|^\s*\*" | head -30 || echo "no_unreachable"
```

If `no_unreachable` is printed, record zero findings for this category.

### 4. Dead files (files with no exports, not imported by anything)

```bash
# Files tracked in git but not exported by any package.json export map
# and not referenced in any import/require statement
grep -rE "^export |^export\{|^export \*|module\.exports|export default" \
  src/ --include="*.ts" --include="*.tsx" -l 2>/dev/null | while read f; do
  basename "$f" .ts | sed 's/\..*//' | tr '[:upper:]' '[:lower:]'
done > /tmp/exports_tmp.txt

grep -rE "from ['\"]\.\.?/|require\(['\"]\.\.?/" src/ --include="*.ts" --include="*.tsx" -h 2>/dev/null | \
  sed "s/.*from ['\"]\.\.?\///g" | sed "s/['\"]//g" | sed 's/\.ts$//' | sed 's/\.tsx$//' > /tmp/imports_tmp.txt

# Find files that have exports but are never imported
comm -23 /tmp/exports_tmp.txt /tmp/imports_tmp.txt 2>/dev/null | head -20 || echo "no_dead_files"
```

If `no_dead_files` is printed, record zero findings for this category.

### 5. Git-inactive files (not touched in 90 days, no exports)

```bash
git log --since="90 days ago" --name-only --pretty=format: -- src/ | sort -u > /tmp/git_active.txt
find src/ -name "*.ts" -o -name "*.tsx" | sed 's|src/||' | sed 's|\.tsx$||' | sed 's|\.ts$||' > /tmp/all_src.txt
comm -23 /tmp/all_src.txt /tmp/git_active.txt 2>/dev/null | head -20 || echo "no_git_inactive"
```

If `no_git_inactive` is printed, record zero findings for this category.

## Phase 2 — Check for existing issue

Before creating anything, check if there is already an open issue with the label `kody:watch:dead-code`:

```bash
gh issue list --repo {{repo}} --state open --label kody:watch:dead-code --json number,title --jq '.[] | "\(.number) \(.title)"'
```

- If an open issue exists: append your findings as a comment to the existing issue instead of creating a new one.
- If no open issue exists: proceed to Phase 3.

## Phase 3 — Aggregate findings

Count findings per category:

| Category | Count |
|----------|-------|
| Unused exports | N |
| Unused imports/vars | N |
| Unreachable code | N |
| Dead files | N |
| Git-inactive files | N |

If **all counts are zero**: log "No dead code found" and exit silently. Do NOT create an issue.

## Phase 4 — Create consolidated issue

Create **one GitHub issue** containing all findings.

**Title:** `Dead code cleanup: N unused exports, N dead files, N unreachable blocks`

**Labels:** `kody:watch:dead-code`

**Body:**

```markdown
## Summary

| Category | Count |
|----------|-------|
| Unused exports | N |
| Unused imports/variables | N |
| Unreachable code | N |
| Dead files (not imported) | N |
| Git-inactive files (no commits in 90d) | N |

## Unused Exports

<!-- Table of unused exports: File | Export | Type | Line -->

## Unused Imports / Variables

<!-- Table of unused imports: File | Line | Message -->

## Unreachable Code

<!-- Table: File | Line | Code snippet -->

## Dead Files

<!-- Table: File | Reason (e.g., no exports, not imported) -->

## Git-Inactive Files

<!-- Table: File | Last commit date -->

## Recommendations

1. Remove unused exports and imports to reduce bundle size and improve tree-shaking
2. Delete dead files or move them to a `archive/` folder if they may be needed later
3. Remove commented-out code blocks that follow `return`/`throw` statements
4. Review git-inactive files — delete if obsolete, or add exports to re-integrate

---
*Generated by dead-code-cleanup watch agent*
```

## Edge cases

- **Tool scan errors:** If a scan command exits non-zero for reasons other than no findings, log the error and skip that category. Do not fail the entire agent run.
- **Very large repos:** Cap each category at 50 findings. If truncated, add a note: "(showing first 50 of N total)"
- **No findings:** Do nothing. No issue to create.
- **Binary/non-text files:** Skip detection on binary files (images, compiled assets, etc.)
