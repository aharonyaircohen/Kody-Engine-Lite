/**
 * Report types and formatting for the test-model command.
 */

export type TestCategory = "infrastructure" | "basic" | "tool-use" | "stage-simulation" | "advanced"

export interface AccuracyMetrics {
  instructionCompliance?: number
  outputFormat?: number
  toolSelection?: number
  boundaryRespect?: number
}

export interface TestResult {
  name: string
  category: TestCategory
  status: "pass" | "fail" | "warn"
  accuracy: number  // 0-100
  durationMs: number
  detail: string
  metrics?: AccuracyMetrics
}

export interface TestReport {
  provider: string
  model: string
  results: TestResult[]
  totalDurationMs: number
  dropParamsRequired: boolean
  timestamp: string
}

const CATEGORY_ORDER: TestCategory[] = ["infrastructure", "basic", "tool-use", "stage-simulation", "advanced"]

const CATEGORY_LABELS: Record<TestCategory, string> = {
  infrastructure: "INFRASTRUCTURE",
  basic: "BASIC CAPABILITIES",
  "tool-use": "TOOL USE",
  "stage-simulation": "STAGE SIMULATION",
  advanced: "ADVANCED",
}

function pad(str: string, len: number): string {
  return str.padEnd(len)
}

function fmtDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

export function formatReport(report: TestReport): string {
  const W = 74
  const lines: string[] = []

  lines.push("=" .repeat(W))
  lines.push("")
  lines.push("  Model Compatibility Report")
  lines.push(`  Provider: ${report.provider} | Model: ${report.model}`)
  lines.push(`  Date: ${report.timestamp}`)
  lines.push(`  Duration: ${fmtDuration(report.totalDurationMs)}`)
  lines.push("")
  lines.push("-".repeat(W))

  for (const cat of CATEGORY_ORDER) {
    const catResults = report.results.filter(r => r.category === cat)
    if (catResults.length === 0) continue

    lines.push("")
    lines.push(`  ${CATEGORY_LABELS[cat]}`)
    lines.push("")

    for (const r of catResults) {
      const icon = r.status === "pass" ? "+" : r.status === "fail" ? "x" : "!"
      const name = pad(r.name, 28)
      const status = pad(r.status.toUpperCase(), 6)
      const acc = pad(`${r.accuracy}%`, 5)
      const dur = fmtDuration(r.durationMs)
      lines.push(`  [${icon}] ${name} ${status} ${acc} ${dur}`)
      if (r.status !== "pass" && r.detail) {
        lines.push(`      ${r.detail.slice(0, W - 8)}`)
      }
    }
  }

  // Summary — exclude skipped tests (0ms duration, 0 accuracy, warn) from accuracy calculation
  const passed = report.results.filter(r => r.status === "pass").length
  const failed = report.results.filter(r => r.status === "fail").length
  const skipped = report.results.filter(r => r.status === "warn" && r.durationMs === 0 && r.detail.includes("Skipped")).length
  const warned = report.results.filter(r => r.status === "warn").length - skipped
  const total = report.results.length
  const scored = report.results.filter(r => !(r.status === "warn" && r.durationMs === 0 && r.detail.includes("Skipped")))
  const avgAccuracy = scored.length > 0
    ? Math.round(scored.reduce((s, r) => s + r.accuracy, 0) / scored.length)
    : 0

  lines.push("")
  lines.push("-".repeat(W))
  lines.push("")
  lines.push(`  RESULTS: ${passed}/${total - skipped} PASS | ${failed} FAIL | ${warned} WARN${skipped > 0 ? ` | ${skipped} SKIPPED` : ""}`)
  lines.push(`  OVERALL ACCURACY: ${avgAccuracy}%`)
  lines.push(`  drop_params required: ${report.dropParamsRequired ? "YES" : "NO"}`)

  // Per-category accuracy (exclude skipped)
  lines.push("")
  lines.push("  ACCURACY BY CATEGORY:")
  for (const cat of CATEGORY_ORDER) {
    const cr = report.results.filter(r => r.category === cat && !(r.status === "warn" && r.durationMs === 0 && r.detail.includes("Skipped")))
    if (cr.length === 0) continue
    const avg = Math.round(cr.reduce((s, r) => s + r.accuracy, 0) / cr.length)
    lines.push(`    ${pad(CATEGORY_LABELS[cat], 22)} ${avg}%`)
  }

  // Recommendation
  lines.push("")
  lines.push("  RECOMMENDATION:")
  for (const line of getRecommendation(report)) {
    lines.push(`  ${line}`)
  }

  lines.push("")
  lines.push("=".repeat(W))
  return lines.join("\n")
}

function getRecommendation(report: TestReport): string[] {
  const lines: string[] = []
  const failedTests = report.results.filter(r => r.status === "fail")
  const avg = report.results.length > 0
    ? Math.round(report.results.reduce((s, r) => s + r.accuracy, 0) / report.results.length)
    : 0

  if (avg >= 90 && failedTests.length === 0) {
    lines.push("[+] Fully compatible -- suitable for all pipeline stages")
    return lines
  }

  const stageResults = report.results.filter(r => r.category === "stage-simulation")
  const workingStages = stageResults.filter(r => r.status === "pass").map(r => r.name.replace("_stage", ""))
  const failingStages = stageResults.filter(r => r.status !== "pass").map(r => r.name.replace("_stage", ""))

  if (workingStages.length > 0) {
    lines.push(`[+] Suitable for: ${workingStages.join(", ")} stages`)
  }
  if (failingStages.length > 0) {
    lines.push(`[x] Not recommended for: ${failingStages.join(", ")} stages`)
  }

  if (failedTests.length > 0) {
    lines.push("")
    lines.push("Failed tests:")
    for (const t of failedTests) {
      lines.push(`  - ${t.name}: ${t.detail.slice(0, 60)}`)
    }
  }

  return lines
}
