import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { discoverQaContext, generateQaGuide, generateQaGuideFallback, serializeDiscoveryForLLM } from "../../src/bin/qa-guide.js"

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-qa-test-"))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeFile(rel: string, content: string): void {
  const full = path.join(tmpDir, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
}

// ─── Enriched Discovery ───────────────────────────────────────────────────────

describe("discoverQaContext — enriched fields", () => {
  it("includes framework detection results", () => {
    writeFile("package.json", JSON.stringify({
      dependencies: { payload: "^3.0.0", next: "^15.0.0" },
      scripts: { dev: "next dev" },
    }))
    writeFile("pnpm-lock.yaml", "")
    const result = discoverQaContext(tmpDir)
    expect(result.frameworks).toBeDefined()
    expect(result.frameworks.some(f => f.name === "payload-cms")).toBe(true)
  })

  it("includes collections when Payload CMS detected", () => {
    writeFile("package.json", JSON.stringify({
      dependencies: { payload: "^3.0.0" },
      scripts: { dev: "next dev" },
    }))
    writeFile("pnpm-lock.yaml", "")
    writeFile("src/server/payload/collections/Posts.ts", `
export const Posts = { slug: "posts", fields: [{ name: "title", type: "text" }] }
`)
    const result = discoverQaContext(tmpDir)
    expect(result.collections).toBeDefined()
    expect(result.collections.length).toBeGreaterThan(0)
    expect(result.collections[0].slug).toBe("posts")
  })

  it("includes API routes", () => {
    writeFile("package.json", JSON.stringify({
      dependencies: { next: "^15.0.0" },
      scripts: { dev: "next dev" },
    }))
    writeFile("pnpm-lock.yaml", "")
    writeFile("src/app/api/health/route.ts", `
export async function GET() { return Response.json({ ok: true }) }
`)
    const result = discoverQaContext(tmpDir)
    expect(result.apiRoutes).toBeDefined()
    expect(result.apiRoutes.length).toBeGreaterThan(0)
    expect(result.apiRoutes[0].methods).toContain("GET")
  })

  it("includes admin components", () => {
    writeFile("package.json", JSON.stringify({
      dependencies: { payload: "^3.0.0" },
    }))
    writeFile("src/ui/admin/MyWidget/index.tsx", "export default function MyWidget() {}")
    const result = discoverQaContext(tmpDir)
    expect(result.adminComponents).toBeDefined()
    expect(result.adminComponents.length).toBeGreaterThan(0)
  })

  it("includes env vars from .env.example", () => {
    writeFile("package.json", JSON.stringify({ dependencies: {} }))
    writeFile(".env.example", "DATABASE_URL=pg://localhost/db\nAPI_KEY=xxx\n")
    const result = discoverQaContext(tmpDir)
    expect(result.envVars).toBeDefined()
    expect(result.envVars).toContain("DATABASE_URL")
    expect(result.envVars).toContain("API_KEY")
  })

  it("preserves existing fields (routes, auth, roles)", () => {
    writeFile("package.json", JSON.stringify({
      dependencies: { next: "^15.0.0" },
      scripts: { dev: "next dev" },
    }))
    writeFile("pnpm-lock.yaml", "")
    writeFile("src/app/(main)/login/page.tsx", "export default function Login() {}")
    writeFile("middleware.ts", "export function middleware() {}")
    const result = discoverQaContext(tmpDir)
    expect(result.loginPage).toBe("/login")
    expect(result.authFiles).toContain("middleware.ts")
    expect(result.routes.some(r => r.path === "/login")).toBe(true)
  })
})

// ─── Fallback Generator ───────────────────────────────────────────────────────

describe("generateQaGuideFallback", () => {
  it("produces valid markdown with all sections", () => {
    const discovery = discoverQaContext(tmpDir)
    // Inject some data for a richer test
    discovery.routes = [{ path: "/", group: "frontend" }]
    discovery.loginPage = "/login"
    discovery.devCommand = "pnpm dev"
    const guide = generateQaGuideFallback(discovery)
    expect(guide).toContain("# QA Guide")
    expect(guide).toContain("## Authentication")
    expect(guide).toContain("## Dev Server")
    expect(guide).toContain("pnpm dev")
  })

  it("includes collection info when present", () => {
    const discovery = discoverQaContext(tmpDir)
    discovery.collections = [
      { name: "Courses", slug: "courses", filePath: "src/collections/Courses.ts", fields: ["title", "slug"], hasAdmin: true },
    ]
    const guide = generateQaGuideFallback(discovery)
    expect(guide).toContain("courses")
    expect(guide).toContain("/admin/collections/courses")
  })

  it("includes API routes when present", () => {
    const discovery = discoverQaContext(tmpDir)
    discovery.apiRoutes = [
      { path: "/api/users", methods: ["GET", "POST"], filePath: "src/app/api/users/route.ts" },
    ]
    const guide = generateQaGuideFallback(discovery)
    expect(guide).toContain("/api/users")
    expect(guide).toContain("GET")
    expect(guide).toContain("POST")
  })
})

// ─── Backward Compatibility ───────────────────────────────────────────────────

describe("generateQaGuide (backward compat)", () => {
  it("delegates to generateQaGuideFallback", () => {
    const discovery = discoverQaContext(tmpDir)
    expect(generateQaGuide(discovery)).toBe(generateQaGuideFallback(discovery))
  })
})

// ─── Discovery Serialization ──────────────────────────────────────────────────

describe("serializeDiscoveryForLLM", () => {
  it("produces a readable string from discovery data", () => {
    writeFile("package.json", JSON.stringify({
      dependencies: { payload: "^3.0.0", next: "^15.0.0" },
      scripts: { dev: "next dev" },
    }))
    writeFile("pnpm-lock.yaml", "")
    writeFile("src/server/payload/collections/Courses.ts", `
export const Courses = { slug: "courses", fields: [{ name: "title", type: "text" }] }
`)
    writeFile("src/app/api/lessons/route.ts", `export async function GET() {}`)
    writeFile("src/ui/admin/Sorter/index.tsx", "export default function() {}")

    const discovery = discoverQaContext(tmpDir)
    const serialized = serializeDiscoveryForLLM(discovery)

    expect(typeof serialized).toBe("string")
    expect(serialized.length).toBeGreaterThan(0)
    expect(serialized).toContain("courses")
    expect(serialized).toContain("/api/lessons")
    expect(serialized).toContain("Sorter")
  })

  it("stays under 8000 chars", () => {
    // Create a large project with many collections
    writeFile("package.json", JSON.stringify({
      dependencies: { payload: "^3.0.0" },
    }))
    for (let i = 0; i < 30; i++) {
      writeFile(`src/server/payload/collections/Col${i}.ts`, `
export const Col${i} = { slug: "col-${i}", fields: [${Array.from({ length: 25 }, (_, j) => `{ name: "field${j}", type: "text" }`).join(",")}] }
`)
    }
    const discovery = discoverQaContext(tmpDir)
    const serialized = serializeDiscoveryForLLM(discovery)
    expect(serialized.length).toBeLessThanOrEqual(8000)
  })
})
