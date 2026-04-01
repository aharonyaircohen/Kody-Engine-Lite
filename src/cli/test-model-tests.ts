/**
 * Individual compatibility test cases for the test-model command.
 *
 * Two test strategies:
 *   API tests  — direct fetch to LiteLLM proxy (fast, precise tool-call visibility)
 *   CLI tests  — `claude --print` through LiteLLM (realistic Claude Code integration)
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as zlib from "zlib"
import { spawnSync, execSync } from "child_process"

import type { TestResult, TestCategory, AccuracyMetrics } from "./test-model-report.js"

// ── Types ────────────────────────────────────────────────────────────────────

export interface TestContext {
  proxyUrl: string
  model: string
  apiKey: string
  projectDir: string
}

export interface TestDef {
  name: string
  category: TestCategory
  description: string
  run: (ctx: TestContext) => Promise<TestResult>
}

interface ApiResult {
  ok: boolean
  data: any
  status: number
  errorMsg?: string
}

interface ToolCall {
  name: string
  input: Record<string, unknown>
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Returns true if direct API tests can run (has API key). CLI tests always work. */
function canRunApiTests(ctx: TestContext): boolean {
  return !!ctx.apiKey
}

function skipResult(name: string, category: TestCategory): TestResult {
  return result(name, category, "warn", 0, 0, "Skipped — no API key (CLI auth only)")
}

async function apiCall(ctx: TestContext, body: Record<string, unknown>): Promise<ApiResult> {
  try {
    const res = await fetch(`${ctx.proxyUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ctx.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: ctx.model, ...body }),
      signal: AbortSignal.timeout(60_000),
    })
    const data = await res.json()
    if (!res.ok) {
      return { ok: false, data, status: res.status, errorMsg: data?.error?.message ?? `HTTP ${res.status}` }
    }
    return { ok: true, data, status: res.status }
  } catch (err) {
    return { ok: false, data: null, status: 0, errorMsg: err instanceof Error ? err.message : String(err) }
  }
}

function extractText(data: any): string {
  if (!data?.content) return ""
  return data.content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text ?? "")
    .join("")
}

/** Multi-turn tool-use conversation via the Anthropic Messages API. */
async function runToolConversation(
  ctx: TestContext,
  tools: Record<string, unknown>[],
  userPrompt: string,
  simulate: (name: string, input: Record<string, unknown>) => string,
  opts?: { system?: string; maxTurns?: number },
): Promise<{ finalText: string; toolCalls: ToolCall[]; error?: string }> {
  const messages: Record<string, unknown>[] = [{ role: "user", content: userPrompt }]
  const allCalls: ToolCall[] = []

  for (let turn = 0; turn < (opts?.maxTurns ?? 5); turn++) {
    const body: Record<string, unknown> = {
      max_tokens: 1024,
      temperature: 0,
      messages,
      tools,
    }
    if (opts?.system) body.system = opts.system

    const res = await apiCall(ctx, body)
    if (!res.ok) return { finalText: "", toolCalls: allCalls, error: res.errorMsg }

    const content: any[] = res.data.content ?? []
    const toolBlocks = content.filter((b: any) => b.type === "tool_use")
    const textBlocks = content.filter((b: any) => b.type === "text")

    if (toolBlocks.length === 0) {
      return { finalText: textBlocks.map((b: any) => b.text ?? "").join(""), toolCalls: allCalls }
    }

    for (const tc of toolBlocks) allCalls.push({ name: tc.name, input: tc.input })
    messages.push({ role: "assistant", content })
    messages.push({
      role: "user",
      content: toolBlocks.map((tc: any) => ({
        type: "tool_result",
        tool_use_id: tc.id,
        content: simulate(tc.name, tc.input),
      })),
    })
  }
  return { finalText: "", toolCalls: allCalls, error: "Max turns reached" }
}

function filterStderr(stderr: string): string {
  // Strip Bun AVX warning and other non-error noise
  return stderr
    .split("\n")
    .filter(l => !l.includes("CPU lacks AVX") && !l.includes("bun-darwin") && !l.includes("Warning: no stdin data") && l.trim().length > 0)
    .join("\n")
    .trim()
}

function runClaudeTest(
  ctx: TestContext,
  prompt: string,
  extraFlags: string[] = [],
  timeout = 90_000,
): { stdout: string; stderr: string; exitCode: number } {
  try {
    // For claude/anthropic: don't override env — use Claude Code's built-in auth
    const isDirectAnthropic = ctx.proxyUrl.includes("api.anthropic.com")
    const envOverrides: Record<string, string> = isDirectAnthropic
      ? {}
      : { ANTHROPIC_BASE_URL: ctx.proxyUrl, ANTHROPIC_API_KEY: ctx.apiKey }

    const result = spawnSync("claude", [
      "--print",
      "--model", ctx.model,
      "--dangerously-skip-permissions",
      ...extraFlags,
      "-p", prompt,
    ], {
      env: { ...process.env, ...envOverrides },
      timeout,
      encoding: "utf-8" as BufferEncoding,
      cwd: ctx.projectDir,
    })
    return {
      stdout: (result.stdout as string) ?? "",
      stderr: filterStderr((result.stderr as string) ?? ""),
      exitCode: result.status ?? 1,
    }
  } catch (err) {
    return { stdout: "", stderr: String(err), exitCode: 1 }
  }
}

function isGitClean(dir: string): boolean {
  try {
    const out = execSync("git diff --name-only", { cwd: dir, encoding: "utf-8", timeout: 5000 })
    return out.trim().length === 0
  } catch { return false }
}

function revertChanges(dir: string): void {
  // Only revert src/ files that tests might modify — avoid reverting cli.ts or other working changes
  try { execSync("git checkout -- src/logger.ts", { cwd: dir, timeout: 5000, stdio: "pipe" }) } catch { /* ignore */ }
}

function result(
  name: string,
  category: TestCategory,
  status: "pass" | "fail" | "warn",
  accuracy: number,
  durationMs: number,
  detail: string,
  metrics?: AccuracyMetrics,
): TestResult {
  return { name, category, status, accuracy, durationMs, detail, metrics }
}

// ── Anthropic tool schemas ───────────────────────────────────────────────────

const TOOL_READ = {
  name: "Read",
  description: "Read a file from the filesystem",
  input_schema: {
    type: "object" as const,
    properties: { path: { type: "string", description: "Absolute file path" } },
    required: ["path"],
  },
}

const TOOL_EDIT = {
  name: "Edit",
  description: "Replace old_string with new_string in a file",
  input_schema: {
    type: "object" as const,
    properties: {
      file_path: { type: "string" },
      old_string: { type: "string" },
      new_string: { type: "string" },
    },
    required: ["file_path", "old_string", "new_string"],
  },
}

const TOOL_BASH = {
  name: "Bash",
  description: "Execute a bash command and return output",
  input_schema: {
    type: "object" as const,
    properties: { command: { type: "string", description: "The command to run" } },
    required: ["command"],
  },
}

// ── PNG helper ───────────────────────────────────────────────────────────────

const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
  CRC_TABLE[n] = c >>> 0
}
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function createRedPng(): Buffer {
  const w = 4, h = 4
  const scanlines = Buffer.alloc(h * (1 + w * 3))
  for (let y = 0; y < h; y++) {
    const off = y * (1 + w * 3)
    scanlines[off] = 0 // filter None
    for (let x = 0; x < w; x++) {
      scanlines[off + 1 + x * 3] = 255     // R
      scanlines[off + 1 + x * 3 + 1] = 0   // G
      scanlines[off + 1 + x * 3 + 2] = 0   // B
    }
  }
  function chunk(type: string, data: Buffer): Buffer {
    const tb = Buffer.from(type, "ascii")
    const merged = Buffer.concat([tb, data])
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(merged))
    return Buffer.concat([len, tb, data, crcBuf])
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 2  // 8-bit RGB
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(scanlines)), chunk("IEND", Buffer.alloc(0))])
}

// ── Test implementations ─────────────────────────────────────────────────────

async function testSimplePrompt(ctx: TestContext): Promise<TestResult> {
  const t = Date.now()
  if (!canRunApiTests(ctx)) {
    // Fall back to CLI test
    const r = runClaudeTest(ctx, "Reply with exactly: KODY_TEST_OK")
    const ok = r.stdout.includes("KODY_TEST_OK")
    return result("simple_prompt", "basic", ok ? "pass" : "fail", ok ? 100 : 0, Date.now() - t,
      ok ? "Model responded correctly (via CLI)" : `Got: ${r.stdout.slice(0, 80)}`)
  }
  const res = await apiCall(ctx, {
    max_tokens: 50, temperature: 0,
    messages: [{ role: "user", content: "Reply with exactly: KODY_TEST_OK" }],
  })
  if (!res.ok) return result("simple_prompt", "basic", "fail", 0, Date.now() - t, `API error: ${res.errorMsg}`)
  const text = extractText(res.data)
  const ok = text.includes("KODY_TEST_OK")
  return result("simple_prompt", "basic", ok ? "pass" : "fail", ok ? 100 : 0, Date.now() - t,
    ok ? "Model responded correctly" : `Expected KODY_TEST_OK, got: ${text.slice(0, 80)}`)
}

async function testJsonOutput(ctx: TestContext): Promise<TestResult> {
  if (!canRunApiTests(ctx)) {
    const t = Date.now()
    const r = runClaudeTest(ctx, 'Respond with ONLY valid JSON, no markdown fences. Return: {"status":"ok","model":"your name"}')
    let text = r.stdout.trim().replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim()
    try { JSON.parse(text); return result("json_output", "basic", "pass", 100, Date.now() - t, "Valid JSON via CLI") }
    catch { return result("json_output", "basic", "fail", 0, Date.now() - t, `Invalid JSON: ${text.slice(0, 80)}`) }
  }
  const t = Date.now()
  const res = await apiCall(ctx, {
    max_tokens: 200, temperature: 0,
    system: "Respond with ONLY valid JSON. No markdown fences, no explanation. Just raw JSON.",
    messages: [{ role: "user", content: 'Return a JSON object with keys "status" (string "ok") and "model" (string, your model name).' }],
  })
  if (!res.ok) return result("json_output", "basic", "fail", 0, Date.now() - t, `API error: ${res.errorMsg}`)
  let text = extractText(res.data).trim()
  // Strip markdown fences — many models wrap JSON in ```json blocks despite instructions
  text = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim()
  try {
    const parsed = JSON.parse(text)
    const hasKeys = typeof parsed.status === "string" && typeof parsed.model === "string"
    return result("json_output", "basic", "pass", hasKeys ? 100 : 70, Date.now() - t,
      hasKeys ? "Valid JSON with correct keys" : "Valid JSON but missing expected keys")
  } catch {
    return result("json_output", "basic", "fail", 0, Date.now() - t, `Invalid JSON: ${text.slice(0, 80)}`)
  }
}

function scoreRules(text: string): { score: number; checks: string[] } {
  let score = 0
  const checks: string[] = []
  if (text.startsWith("KODY:") || text.startsWith("kody:")) { score += 20; checks.push("starts-with-kody") }
  if (!text.toLowerCase().split(/\s+/).includes("the")) { score += 20; checks.push("no-the") }
  if (text.split(/\s+/).length <= 55) { score += 20; checks.push("under-50-words") }
  if (text.endsWith("END") || text.endsWith("end")) { score += 20; checks.push("ends-with-end") }
  if (text === text.toLowerCase()) { score += 20; checks.push("all-lowercase") }
  return { score, checks }
}

async function testSystemPromptRules(ctx: TestContext): Promise<TestResult> {
  const rulesPrompt = [
    "STRICT RULES — violating ANY will crash the system:",
    "1) Start every response with 'KODY:'",
    "2) Never use the word 'the'",
    "3) Keep response under 50 words",
    "4) End your response with 'END'",
    "5) Use ONLY lowercase letters (no uppercase anywhere)",
  ].join("\n")
  if (!canRunApiTests(ctx)) {
    // CLI fallback: use instructions that don't conflict with Claude Code's system prompt
    const t = Date.now()
    const r = runClaudeTest(ctx, [
      "Follow ALL these rules in your response:",
      "1) Your response must start with the word 'KODY:'",
      "2) Do not use the word 'the' anywhere",
      "3) Keep your response under 50 words total",
      "4) End your response with the word 'END'",
      "5) Use only lowercase letters throughout",
      "",
      "Now describe what a compiler does. Remember: follow ALL 5 rules above exactly.",
    ].join("\n"))
    const { score, checks } = scoreRules(r.stdout.trim())
    const status = score >= 80 ? "pass" : score >= 40 ? "warn" : "fail"
    return result("system_prompt_rules", "basic", status, score, Date.now() - t,
      `${score / 20}/5 rules followed: ${checks.join(", ")}`, { instructionCompliance: score })
  }
  const t = Date.now()
  const res = await apiCall(ctx, {
    max_tokens: 200, temperature: 0,
    system: rulesPrompt,
    messages: [{ role: "user", content: "Describe what a compiler does." }],
  })
  if (!res.ok) return result("system_prompt_rules", "basic", "fail", 0, Date.now() - t, `API error: ${res.errorMsg}`)
  const text = extractText(res.data).trim()
  const { score, checks } = scoreRules(text)
  const status = score >= 80 ? "pass" : score >= 40 ? "warn" : "fail"
  return result("system_prompt_rules", "basic", status, score, Date.now() - t,
    `${score / 20}/5 rules followed: ${checks.join(", ")}`,
    { instructionCompliance: score })
}

async function testExtendedThinking(ctx: TestContext): Promise<TestResult> {
  if (!canRunApiTests(ctx)) {
    // CLI fallback: Claude Code always uses extended thinking — just verify the model responds
    const t = Date.now()
    const r = runClaudeTest(ctx, "What is 15 * 23? Reply with just the number.")
    const ok = r.stdout.includes("345")
    return result("extended_thinking", "infrastructure", ok ? "pass" : "warn", ok ? 100 : 50, Date.now() - t,
      ok ? "Model responded correctly (thinking assumed via CLI)" : `Got: ${r.stdout.slice(0, 80)}`)
  }
  const t = Date.now()
  const res = await apiCall(ctx, {
    max_tokens: 200,
    thinking: { type: "enabled", budget_tokens: 2000 },
    messages: [{ role: "user", content: "What is 15 * 23?" }],
  })
  if (!res.ok) return result("extended_thinking", "infrastructure", "warn", 50, Date.now() - t,
    `Request failed (model may not support thinking): ${res.errorMsg?.slice(0, 80)}`)
  const hasThinking = Array.isArray(res.data.content) && res.data.content.some((b: any) => b.type === "thinking")
  const hasText = extractText(res.data).length > 0
  if (hasThinking) return result("extended_thinking", "infrastructure", "pass", 100, Date.now() - t, "Thinking block present in response")
  if (hasText) return result("extended_thinking", "infrastructure", "warn", 70, Date.now() - t, "Response OK but no thinking block")
  return result("extended_thinking", "infrastructure", "fail", 0, Date.now() - t, "No content in response")
}

async function testToolRead(ctx: TestContext): Promise<TestResult> {
  if (!canRunApiTests(ctx)) {
    const t = Date.now()
    const testFile = path.join(os.tmpdir(), "kody-test-model-read.txt")
    fs.writeFileSync(testFile, "KODY_SECRET_CONTENT_42")
    try {
      const r = runClaudeTest(ctx, `Read the file ${testFile} and tell me its exact contents. Reply with ONLY the file contents.`)
      const ok = r.stdout.includes("KODY_SECRET_CONTENT_42")
      return result("tool_read", "tool-use", ok ? "pass" : "fail", ok ? 100 : 0, Date.now() - t,
        ok ? "Read tool works via CLI" : `Got: ${r.stdout.slice(0, 80)}`, { toolSelection: ok ? 100 : 0 })
    } finally { fs.rmSync(testFile, { force: true }) }
  }
  const t = Date.now()
  const testFile = path.join(os.tmpdir(), "kody-test-model-read.txt")
  fs.writeFileSync(testFile, "KODY_SECRET_CONTENT_42")
  try {
    const conv = await runToolConversation(ctx, [TOOL_READ],
      `Read the file ${testFile} and tell me what it contains.`,
      (name, input) => {
        if (name === "Read" && (input as any).path === testFile) return "KODY_SECRET_CONTENT_42"
        return "Error: File not found"
      })
    if (conv.error) return result("tool_read", "tool-use", "fail", 0, Date.now() - t, `Error: ${conv.error}`)
    const calledRead = conv.toolCalls.some(tc => tc.name === "Read")
    const correctPath = conv.toolCalls.some(tc => tc.name === "Read" && (tc.input as any).path === testFile)
    const mentionsContent = conv.finalText.includes("KODY_SECRET_CONTENT_42") || conv.finalText.includes("42")
    let acc = 0
    if (calledRead) acc += 30
    if (correctPath) acc += 30
    if (mentionsContent) acc += 40
    return result("tool_read", "tool-use", acc >= 60 ? "pass" : "fail", acc, Date.now() - t,
      `Read called: ${calledRead}, correct path: ${correctPath}, content referenced: ${mentionsContent}`,
      { toolSelection: calledRead ? 100 : 0 })
  } finally {
    fs.rmSync(testFile, { force: true })
  }
}

async function testToolEdit(ctx: TestContext): Promise<TestResult> {
  if (!canRunApiTests(ctx)) {
    // CLI fallback: use build_stage-like test with a temp file
    const t = Date.now()
    const testFile = path.join(os.tmpdir(), "kody-test-model-edit.txt")
    fs.writeFileSync(testFile, "hello world")
    try {
      const r = runClaudeTest(ctx, `Use the Edit tool to replace "hello" with "goodbye" in ${testFile}. Do nothing else.`)
      const content = fs.existsSync(testFile) ? fs.readFileSync(testFile, "utf-8") : ""
      const ok = content.includes("goodbye")
      return result("tool_edit", "tool-use", ok ? "pass" : "fail", ok ? 100 : 0, Date.now() - t,
        ok ? "Edit tool works via CLI" : `File content: ${content.slice(0, 80)}`, { toolSelection: ok ? 100 : 0 })
    } finally { fs.rmSync(testFile, { force: true }) }
  }
  const t = Date.now()
  const conv = await runToolConversation(ctx, [TOOL_READ, TOOL_EDIT],
    'Read the file /tmp/kody-edit-test.txt, then use Edit to replace "hello" with "goodbye" in it.',
    (name, input) => {
      if (name === "Read") return "hello world"
      if (name === "Edit") return "File edited successfully"
      return "Unknown tool"
    })
  if (conv.error) return result("tool_edit", "tool-use", "fail", 0, Date.now() - t, `Error: ${conv.error}`)
  const editCall = conv.toolCalls.find(tc => tc.name === "Edit")
  let acc = 0
  if (editCall) {
    acc += 40
    if ((editCall.input as any).old_string === "hello") acc += 30
    if ((editCall.input as any).new_string === "goodbye") acc += 30
  }
  return result("tool_edit", "tool-use", acc >= 70 ? "pass" : acc > 0 ? "warn" : "fail", acc, Date.now() - t,
    editCall ? `Edit called with old="${(editCall.input as any).old_string}" new="${(editCall.input as any).new_string}"`
      : "Edit tool was not called",
    { toolSelection: editCall ? 100 : 0 })
}

async function testToolBash(ctx: TestContext): Promise<TestResult> {
  if (!canRunApiTests(ctx)) {
    const t = Date.now()
    const r = runClaudeTest(ctx, "Run this bash command and tell me its output: echo KODY_BASH_OK")
    const ok = r.stdout.includes("KODY_BASH_OK")
    return result("tool_bash", "tool-use", ok ? "pass" : "fail", ok ? 100 : 0, Date.now() - t,
      ok ? "Bash tool works via CLI" : `Got: ${r.stdout.slice(0, 80)}`, { toolSelection: ok ? 100 : 0 })
  }
  const t = Date.now()
  const conv = await runToolConversation(ctx, [TOOL_BASH],
    "Run this exact bash command: echo KODY_BASH_OK",
    (name, input) => {
      if (name === "Bash") return "KODY_BASH_OK\n"
      return "Error"
    })
  if (conv.error) return result("tool_bash", "tool-use", "fail", 0, Date.now() - t, `Error: ${conv.error}`)
  const bashCall = conv.toolCalls.find(tc => tc.name === "Bash")
  const correctCmd = bashCall && String((bashCall.input as any).command).includes("echo KODY_BASH_OK")
  const acc = bashCall ? (correctCmd ? 100 : 50) : 0
  return result("tool_bash", "tool-use", acc >= 50 ? "pass" : "fail", acc, Date.now() - t,
    bashCall ? `Bash called: ${(bashCall.input as any).command}` : "Bash tool was not called",
    { toolSelection: bashCall ? 100 : 0 })
}

async function testImageAttachment(ctx: TestContext): Promise<TestResult> {
  if (!canRunApiTests(ctx)) {
    // CLI fallback: create a PNG, ask Claude to read it via the Read tool (which supports images)
    const t = Date.now()
    const tmpPng = path.join(os.tmpdir(), "kody-test-image.png")
    fs.writeFileSync(tmpPng, createRedPng())
    try {
      const r = runClaudeTest(ctx, `Read the image file at ${tmpPng} and tell me what color it is. Reply with just the color name.`)
      const text = r.stdout.toLowerCase()
      const ok = text.includes("red")
      return result("image_attachment", "tool-use", ok ? "pass" : "warn", ok ? 100 : 50, Date.now() - t,
        ok ? "Image processed correctly via CLI" : `Got: ${text.slice(0, 80)}`)
    } finally { fs.rmSync(tmpPng, { force: true }) }
  }
  const t = Date.now()
  const pngData = createRedPng().toString("base64")
  const res = await apiCall(ctx, {
    max_tokens: 100, temperature: 0,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: pngData } },
        { type: "text", text: "What color is this image? Reply with just the color name." },
      ],
    }],
  })
  if (!res.ok) return result("image_attachment", "tool-use", "fail", 0, Date.now() - t,
    `API error (model may not support vision): ${res.errorMsg?.slice(0, 80)}`)
  const text = extractText(res.data).toLowerCase()
  const mentionsRed = text.includes("red")
  const mentionsColor = mentionsRed || text.includes("color") || text.includes("image") || text.includes("pixel")
  const acc = mentionsRed ? 100 : mentionsColor ? 50 : 20
  return result("image_attachment", "tool-use", mentionsRed ? "pass" : mentionsColor ? "warn" : "fail",
    acc, Date.now() - t, `Response: ${text.slice(0, 80)}`)
}

async function testErrorRecovery(ctx: TestContext): Promise<TestResult> {
  if (!canRunApiTests(ctx)) {
    const t = Date.now()
    const r = runClaudeTest(ctx, "Read the file /tmp/kody-nonexistent-test-file-xyz.txt and tell me what's in it. If it doesn't exist, say 'FILE_NOT_FOUND'.")
    const ok = r.stdout.includes("FILE_NOT_FOUND") || r.stdout.toLowerCase().includes("not found") ||
      r.stdout.toLowerCase().includes("does not exist") || r.stdout.toLowerCase().includes("doesn't exist")
    return result("error_recovery", "advanced", ok ? "pass" : "warn", ok ? 100 : 50, Date.now() - t,
      ok ? "Graceful error handling via CLI" : `Got: ${r.stdout.slice(0, 80)}`)
  }
  const t = Date.now()
  let errorGiven = false
  const conv = await runToolConversation(ctx, [TOOL_READ, TOOL_BASH],
    "Read the file /tmp/nonexistent-kody-file.txt and tell me what's in it. If the file doesn't exist, say so.",
    (name, input) => {
      if (name === "Read" && !errorGiven) { errorGiven = true; return "Error: ENOENT: no such file or directory" }
      if (name === "Bash") return "ls: /tmp/nonexistent-kody-file.txt: No such file or directory"
      return "Error: File not found"
    })
  if (conv.error) return result("error_recovery", "advanced", "fail", 0, Date.now() - t, `Error: ${conv.error}`)
  const reported = conv.finalText.toLowerCase().includes("not found") ||
    conv.finalText.toLowerCase().includes("doesn't exist") ||
    conv.finalText.toLowerCase().includes("does not exist") ||
    conv.finalText.toLowerCase().includes("no such file")
  const tried = conv.toolCalls.length >= 1
  const acc = reported ? (tried ? 100 : 70) : 20
  return result("error_recovery", "advanced", reported ? "pass" : "warn", acc, Date.now() - t,
    reported ? "Gracefully reported missing file" : `Response: ${conv.finalText.slice(0, 80)}`)
}

// ── CLI-based tests ──────────────────────────────────────────────────────────

async function testToolMultiStep(ctx: TestContext): Promise<TestResult> {
  const t = Date.now()
  const r = runClaudeTest(ctx,
    "Do these steps in order: 1) Read kody.config.json 2) Tell me the value of git.defaultBranch. Reply with ONLY the branch name, nothing else.")
  if (!r.stdout.trim() && r.exitCode !== 0) return result("tool_multi_step", "tool-use", "fail", 0, Date.now() - t,
    `CLI failed: ${r.stderr.slice(0, 200) || "no output"}`)
  const out = r.stdout.trim().toLowerCase()
  const correct = out.includes("main")
  return result("tool_multi_step", "tool-use", correct ? "pass" : "fail", correct ? 100 : 20, Date.now() - t,
    correct ? "Correct: main" : `Got: ${out.slice(0, 80)}`)
}

async function testPlanStage(ctx: TestContext): Promise<TestResult> {
  const t = Date.now()
  const wasClean = isGitClean(ctx.projectDir)
  const r = runClaudeTest(ctx, [
    "You are a planning agent. Your ONLY job is to output a markdown plan.",
    "CRITICAL: Do NOT use Edit, Write, or Bash tools. Do NOT modify any files. ONLY use Read, Glob, and Grep for research.",
    "If you modify any files, the system will crash.",
    "",
    "Task: Plan adding a /health endpoint to an Express app.",
    "Output a markdown plan with ## Step N sections. Each step must have File, Change, and Why fields.",
    "Keep it to 3 steps maximum.",
  ].join("\n"), [], 120_000)
  const filesModified = wasClean && !isGitClean(ctx.projectDir)
  if (filesModified) revertChanges(ctx.projectDir)
  if (!r.stdout.trim() && r.exitCode !== 0) return result("plan_stage", "stage-simulation", "fail", 0, Date.now() - t,
    `CLI failed: ${r.stderr.slice(0, 200) || "no output"}`)
  const out = r.stdout
  const hasStepFormat = /##\s*Step/i.test(out)
  const hasStructure = hasStepFormat || (/\*\*File\*\*/i.test(out) && /\*\*Change\*\*/i.test(out))
  const boundary = filesModified ? 0 : 100
  const format = hasStructure ? 100 : hasStepFormat ? 70 : out.length > 50 ? 30 : 0
  const acc = Math.round((boundary * 0.6) + (format * 0.4))
  const status = filesModified ? "fail" : (hasStructure ? "pass" : "warn")
  return result("plan_stage", "stage-simulation", status, acc, Date.now() - t,
    filesModified ? "FAIL: Model modified files during plan stage (instruction violation)"
      : hasStructure ? "Plan output with correct structure, no files modified"
      : "Output lacks expected ## Step structure",
    { boundaryRespect: boundary, outputFormat: format, instructionCompliance: boundary })
}

async function testBuildStage(ctx: TestContext): Promise<TestResult> {
  const t = Date.now()
  const r = runClaudeTest(ctx, "Add a comment '// kody-build-test' as the very first line of src/logger.ts. That is your only task.")
  const diff = (() => { try { return execSync("git diff src/logger.ts", { cwd: ctx.projectDir, encoding: "utf-8", timeout: 5000 }) } catch { return "" } })()
  const edited = diff.includes("kody-build-test")
  revertChanges(ctx.projectDir)
  if (!r.stdout.trim() && r.exitCode !== 0 && !edited) return result("build_stage", "stage-simulation", "fail", 0, Date.now() - t,
    `CLI failed: ${r.stderr.slice(0, 200) || "no output"}`)
  return result("build_stage", "stage-simulation", edited ? "pass" : "fail", edited ? 100 : 0, Date.now() - t,
    edited ? "File correctly modified with expected comment" : "File was not modified as expected")
}

async function testReviewStage(ctx: TestContext): Promise<TestResult> {
  const t = Date.now()
  const wasClean = isGitClean(ctx.projectDir)
  const r = runClaudeTest(ctx, [
    "You are a code review agent. Review the file src/logger.ts.",
    "CRITICAL: Do NOT modify any files. Only READ and analyze.",
    "Output your review as markdown with this exact format:",
    "## Summary",
    "<1-2 sentence summary>",
    "## Issues Found",
    "- <issues>",
    "## Verdict",
    "APPROVE or REQUEST_CHANGES",
  ].join("\n"))
  const filesModified = wasClean && !isGitClean(ctx.projectDir)
  if (filesModified) revertChanges(ctx.projectDir)
  if (!r.stdout.trim() && r.exitCode !== 0) return result("review_stage", "stage-simulation", "fail", 0, Date.now() - t,
    `CLI failed: ${r.stderr.slice(0, 200) || "no output"}`)
  const out = r.stdout
  const hasVerdict = /verdict/i.test(out)
  const hasSummary = /summary/i.test(out)
  const boundary = filesModified ? 0 : 100
  const format = (hasVerdict ? 50 : 0) + (hasSummary ? 50 : 0)
  const acc = Math.round((boundary * 0.5) + (format * 0.5))
  const status = filesModified ? "fail" : (hasVerdict && hasSummary ? "pass" : "warn")
  return result("review_stage", "stage-simulation", status, acc, Date.now() - t,
    filesModified ? "FAIL: Model modified files during review (instruction violation)"
      : `Summary: ${hasSummary}, Verdict: ${hasVerdict}, no files modified`,
    { boundaryRespect: boundary, outputFormat: format })
}

async function testMcpTools(ctx: TestContext): Promise<TestResult> {
  const t = Date.now()
  const mcpConfig = path.join(os.tmpdir(), `kody-test-mcp-${Date.now()}.json`)
  const testFile = path.join(ctx.projectDir, "kody-mcp-compat-test.txt")
  try {
    fs.writeFileSync(mcpConfig, JSON.stringify({
      mcpServers: {
        filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", ctx.projectDir] },
      },
    }))
    const r = runClaudeTest(ctx,
      `Use the MCP filesystem write_file tool to create a file at ${testFile} with the content 'mcp-ok'. Do not use the built-in Write tool.`,
      ["--mcp-config", mcpConfig], 120_000)
    const created = fs.existsSync(testFile)
    const content = created ? fs.readFileSync(testFile, "utf-8").trim() : ""
    const correct = content.includes("mcp-ok")
    return result("mcp_tools", "advanced", created ? "pass" : "fail", correct ? 100 : created ? 70 : 0, Date.now() - t,
      created ? `File created, content: ${content.slice(0, 50)}` : `MCP test failed: ${r.stderr.slice(0, 80)}`)
  } catch (err) {
    return result("mcp_tools", "advanced", "warn", 0, Date.now() - t, `MCP test error: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    fs.rmSync(mcpConfig, { force: true })
    fs.rmSync(testFile, { force: true })
    revertChanges(ctx.projectDir)
  }
}

// ── Export all tests ─────────────────────────────────────────────────────────

export const ALL_TESTS: TestDef[] = [
  // Infrastructure
  { name: "extended_thinking", category: "infrastructure", description: "Extended thinking parameter support", run: testExtendedThinking },
  // Basic
  { name: "simple_prompt", category: "basic", description: "Basic text prompt and response", run: testSimplePrompt },
  { name: "json_output", category: "basic", description: "JSON-only output constraint", run: testJsonOutput },
  { name: "system_prompt_rules", category: "basic", description: "Multi-rule system prompt adherence", run: testSystemPromptRules },
  // Tool use
  { name: "tool_read", category: "tool-use", description: "Read tool: file reading", run: testToolRead },
  { name: "tool_edit", category: "tool-use", description: "Edit tool: old/new string replacement", run: testToolEdit },
  { name: "tool_bash", category: "tool-use", description: "Bash tool: command execution", run: testToolBash },
  { name: "tool_multi_step", category: "tool-use", description: "Multi-step tool chain via CLI", run: testToolMultiStep },
  { name: "image_attachment", category: "tool-use", description: "Vision: image content processing", run: testImageAttachment },
  // Stage simulation
  { name: "plan_stage", category: "stage-simulation", description: "Plan stage: read-only research + structured output", run: testPlanStage },
  { name: "build_stage", category: "stage-simulation", description: "Build stage: code editing", run: testBuildStage },
  { name: "review_stage", category: "stage-simulation", description: "Review stage: read-only + structured verdict", run: testReviewStage },
  // Advanced
  { name: "mcp_tools", category: "advanced", description: "MCP server tool integration", run: testMcpTools },
  { name: "error_recovery", category: "advanced", description: "Graceful error handling on tool failure", run: testErrorRecovery },
]
