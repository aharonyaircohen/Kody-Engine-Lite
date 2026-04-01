import { describe, it, expect } from "vitest"
import { execSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

/**
 * Tests the shell parser logic from templates/kody.yml.
 * Writes a bash script to a temp file and executes it.
 */
function parseComment(body: string): Record<string, string> {
  const script = `#!/bin/bash
set -e
BODY='${body.replace(/'/g, "'\\''")}'
KODY_ARGS=$(echo "$BODY" | grep -oP '(?:@kody|/kody)\\s+\\K.*' || echo "")

FROM_STAGE=$(echo "$KODY_ARGS" | grep -oP '(?<=--from )\\S+' || echo "")
FEEDBACK=$(echo "$KODY_ARGS" | grep -oP '(?<=--feedback ")[^"]*' || echo "")
COMPLEXITY=""
if echo "$KODY_ARGS" | grep -q -- '--complexity'; then
  COMPLEXITY=$(echo "$KODY_ARGS" | tr ' ' '\\n' | grep -A1 -- '--complexity' | tail -1)
fi
DRY_RUN="false"
if echo "$KODY_ARGS" | grep -q -- '--dry-run'; then
  DRY_RUN="true"
fi

POSITIONAL=$(echo "$KODY_ARGS" | sed -E \\
  -e 's/--from\\s+\\S+//g' \\
  -e 's/--feedback\\s+"[^"]*"//g' \\
  -e 's/--complexity\\s+\\S+//g' \\
  -e 's/--dry-run//g' \\
  -e 's/--ci-run-id\\s+\\S+//g' \\
  -e 's/\\s+/ /g' -e 's/^ //' -e 's/ $//')

MODE=$(echo "$POSITIONAL" | awk '{print $1}')
TASK_ID=$(echo "$POSITIONAL" | awk '{print $2}')

case "$MODE" in
  full|rerun|fix|fix-ci|status|approve|review|resolve|bootstrap) ;;
  *)
    if [ -n "$MODE" ]; then
      TASK_ID="$MODE"
    fi
    MODE="full"
    ;;
esac

echo "MODE=$MODE"
echo "TASK_ID=$TASK_ID"
echo "FROM_STAGE=$FROM_STAGE"
echo "FEEDBACK=$FEEDBACK"
echo "COMPLEXITY=$COMPLEXITY"
echo "DRY_RUN=$DRY_RUN"
`
  const tmpFile = path.join(os.tmpdir(), `kody-parse-test-${Date.now()}.sh`)
  fs.writeFileSync(tmpFile, script, { mode: 0o755 })
  try {
    const output = execSync(`bash ${tmpFile}`, { encoding: "utf-8" })
    const result: Record<string, string> = {}
    for (const line of output.trim().split("\n")) {
      const eq = line.indexOf("=")
      if (eq !== -1) {
        result[line.slice(0, eq)] = line.slice(eq + 1)
      }
    }
    return result
  } finally {
    fs.unlinkSync(tmpFile)
  }
}

describe("workflow parse step", () => {
  it("parses bare @kody", () => {
    const r = parseComment("@kody")
    expect(r.MODE).toBe("full")
    expect(r.TASK_ID).toBe("")
  })

  it("parses @kody full", () => {
    const r = parseComment("@kody full")
    expect(r.MODE).toBe("full")
    expect(r.TASK_ID).toBe("")
  })

  it("parses @kody rerun with task-id and --from", () => {
    const r = parseComment("@kody rerun 226-260401-063126 --from verify")
    expect(r.MODE).toBe("rerun")
    expect(r.TASK_ID).toBe("226-260401-063126")
    expect(r.FROM_STAGE).toBe("verify")
  })

  it("parses @kody --complexity low (flag-only command)", () => {
    const r = parseComment("@kody --complexity low")
    expect(r.MODE).toBe("full")
    expect(r.TASK_ID).toBe("")
    expect(r.COMPLEXITY).toBe("low")
  })

  it("parses @kody full --complexity high", () => {
    const r = parseComment("@kody full --complexity high")
    expect(r.MODE).toBe("full")
    expect(r.TASK_ID).toBe("")
    expect(r.COMPLEXITY).toBe("high")
  })

  it("parses @kody --feedback with quoted text", () => {
    const r = parseComment('@kody --feedback "Use functional style"')
    expect(r.MODE).toBe("full")
    expect(r.TASK_ID).toBe("")
    expect(r.FEEDBACK).toBe("Use functional style")
  })

  it("parses @kody full --dry-run", () => {
    const r = parseComment("@kody full --dry-run")
    expect(r.MODE).toBe("full")
    expect(r.DRY_RUN).toBe("true")
  })

  it("parses @kody fix", () => {
    const r = parseComment("@kody fix")
    expect(r.MODE).toBe("fix")
  })

  it("parses @kody review", () => {
    const r = parseComment("@kody review")
    expect(r.MODE).toBe("review")
  })

  it("parses @kody resolve", () => {
    const r = parseComment("@kody resolve")
    expect(r.MODE).toBe("resolve")
  })

  it("parses @kody status", () => {
    const r = parseComment("@kody status")
    expect(r.MODE).toBe("status")
  })

  it("parses @kody with multiple flags", () => {
    const r = parseComment('@kody full --complexity medium --feedback "Be concise" --dry-run')
    expect(r.MODE).toBe("full")
    expect(r.COMPLEXITY).toBe("medium")
    expect(r.FEEDBACK).toBe("Be concise")
    expect(r.DRY_RUN).toBe("true")
  })

  it("parses @kody rerun --from build (no task-id)", () => {
    const r = parseComment("@kody rerun --from build")
    expect(r.MODE).toBe("rerun")
    expect(r.TASK_ID).toBe("")
    expect(r.FROM_STAGE).toBe("build")
  })

  it("treats unknown first positional as task-id", () => {
    const r = parseComment("@kody my-task-123")
    expect(r.MODE).toBe("full")
    expect(r.TASK_ID).toBe("my-task-123")
  })

  it("parses /kody prefix", () => {
    const r = parseComment("/kody --complexity low")
    expect(r.MODE).toBe("full")
    expect(r.COMPLEXITY).toBe("low")
  })
})
