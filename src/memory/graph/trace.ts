/**
 * KODY_MEMORY_TRACE=1 enables per-op timing for graph reads/writes.
 *
 * When on, every instrumented call records { op, durationMs, bytes?, count? }
 * and an aggregate summary can be read via getTraceSummary() at end of run.
 */

export interface TraceEvent {
  op: string
  durationMs: number
  bytes?: number
  count?: number
  at: number
}

export interface TraceSummary {
  [op: string]: {
    calls: number
    totalMs: number
    maxMs: number
    totalBytes: number
    maxBytes: number
  }
}

const TRACE_ENV = "KODY_MEMORY_TRACE"
const events: TraceEvent[] = []

export function traceEnabled(): boolean {
  return process.env[TRACE_ENV] === "1" || process.env[TRACE_ENV] === "true"
}

export function traced<T>(op: string, fn: () => T, meta?: { bytes?: () => number; count?: () => number }): T {
  if (!traceEnabled()) return fn()
  const start = process.hrtime.bigint()
  try {
    const result = fn()
    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000
    events.push({
      op,
      durationMs,
      bytes: meta?.bytes?.(),
      count: meta?.count?.(),
      at: Date.now(),
    })
    return result
  } catch (err) {
    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000
    events.push({ op: `${op}!error`, durationMs, at: Date.now() })
    throw err
  }
}

export function getTraceEvents(): readonly TraceEvent[] {
  return events
}

export function getTraceSummary(): TraceSummary {
  const out: TraceSummary = {}
  for (const e of events) {
    const bucket = (out[e.op] ??= { calls: 0, totalMs: 0, maxMs: 0, totalBytes: 0, maxBytes: 0 })
    bucket.calls += 1
    bucket.totalMs += e.durationMs
    if (e.durationMs > bucket.maxMs) bucket.maxMs = e.durationMs
    if (e.bytes) {
      bucket.totalBytes += e.bytes
      if (e.bytes > bucket.maxBytes) bucket.maxBytes = e.bytes
    }
  }
  return out
}

export function resetTrace(): void {
  events.length = 0
}

export function formatTraceSummary(): string {
  const summary = getTraceSummary()
  const rows = Object.entries(summary).sort((a, b) => b[1].totalMs - a[1].totalMs)
  if (rows.length === 0) return "(no trace events)"
  const header = `${"op".padEnd(28)} ${"calls".padStart(6)} ${"totalMs".padStart(10)} ${"avgMs".padStart(8)} ${"maxMs".padStart(8)} ${"maxBytes".padStart(10)}`
  const lines = [header, "-".repeat(header.length)]
  for (const [op, b] of rows) {
    const avg = b.totalMs / b.calls
    lines.push(
      `${op.padEnd(28)} ${String(b.calls).padStart(6)} ${b.totalMs.toFixed(2).padStart(10)} ${avg.toFixed(2).padStart(8)} ${b.maxMs.toFixed(2).padStart(8)} ${String(b.maxBytes).padStart(10)}`,
    )
  }
  return lines.join("\n")
}
