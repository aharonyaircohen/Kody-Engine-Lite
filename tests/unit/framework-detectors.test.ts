import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { detectFrameworks, discoverPayloadCollections, discoverAdminComponents, scanApiRoutes, scanEnvVars } from "../../src/bin/framework-detectors.js"

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-fw-test-"))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeFile(rel: string, content: string): void {
  const full = path.join(tmpDir, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
}

// ─── Framework Detection ──────────────────────────────────────────────────────

describe("detectFrameworks", () => {
  it("detects Payload CMS from dependencies", () => {
    writeFile("package.json", JSON.stringify({
      dependencies: { payload: "^3.0.0", next: "^15.0.0" },
    }))
    const result = detectFrameworks(tmpDir)
    expect(result.some(f => f.name === "payload-cms")).toBe(true)
  })

  it("detects Payload CMS from @payloadcms/next", () => {
    writeFile("package.json", JSON.stringify({
      dependencies: { "@payloadcms/next": "^3.0.0" },
    }))
    const result = detectFrameworks(tmpDir)
    expect(result.some(f => f.name === "payload-cms")).toBe(true)
  })

  it("detects NextAuth", () => {
    writeFile("package.json", JSON.stringify({
      dependencies: { "next-auth": "^5.0.0" },
    }))
    const result = detectFrameworks(tmpDir)
    expect(result.some(f => f.name === "nextauth")).toBe(true)
  })

  it("detects Prisma", () => {
    writeFile("package.json", JSON.stringify({
      devDependencies: { prisma: "^5.0.0" },
    }))
    const result = detectFrameworks(tmpDir)
    expect(result.some(f => f.name === "prisma")).toBe(true)
  })

  it("returns empty array when no frameworks detected", () => {
    writeFile("package.json", JSON.stringify({
      dependencies: { express: "^4.0.0" },
    }))
    const result = detectFrameworks(tmpDir)
    expect(result).toEqual([])
  })

  it("handles missing package.json gracefully", () => {
    const result = detectFrameworks(tmpDir)
    expect(result).toEqual([])
  })
})

// ─── Payload CMS Collections ──────────────────────────────────────────────────

describe("discoverPayloadCollections", () => {
  it("extracts slug and fields from a collection file", () => {
    writeFile("src/server/payload/collections/Courses.ts", `
import type { CollectionConfig } from "payload"

export const Courses: CollectionConfig = {
  slug: "courses",
  admin: { useAsTitle: "title" },
  fields: [
    { name: "title", type: "text", required: true },
    { name: "slug", type: "text" },
    { name: "description", type: "textarea" },
    { name: "chapters", type: "array", fields: [
      { name: "title", type: "text" },
    ]},
  ],
}
`)
    const result = discoverPayloadCollections(tmpDir)
    expect(result).toHaveLength(1)
    expect(result[0].slug).toBe("courses")
    expect(result[0].fields).toContain("title")
    expect(result[0].fields).toContain("slug")
    expect(result[0].fields).toContain("description")
    expect(result[0].fields).toContain("chapters")
    expect(result[0].filePath).toContain("Courses.ts")
  })

  it("discovers collections in multiple directory patterns", () => {
    writeFile("src/collections/Users.ts", `
export const Users = {
  slug: "users",
  fields: [{ name: "email", type: "email" }],
}
`)
    const result = discoverPayloadCollections(tmpDir)
    expect(result).toHaveLength(1)
    expect(result[0].slug).toBe("users")
  })

  it("detects admin component references", () => {
    writeFile("src/server/payload/collections/Courses.ts", `
export const Courses = {
  slug: "courses",
  fields: [
    { name: "title", type: "text" },
    { name: "lessons", type: "ui", admin: {
      components: { Field: "/src/ui/admin/CourseLessonsSorter" },
    }},
  ],
}
`)
    const result = discoverPayloadCollections(tmpDir)
    expect(result).toHaveLength(1)
    expect(result[0].hasAdmin).toBe(true)
  })

  it("handles empty directory", () => {
    const result = discoverPayloadCollections(tmpDir)
    expect(result).toEqual([])
  })

  it("handles malformed collection files gracefully", () => {
    writeFile("src/server/payload/collections/Bad.ts", "this is not valid typescript { {{ {")
    const result = discoverPayloadCollections(tmpDir)
    expect(result).toEqual([])
  })

  it("discovers multiple collections", () => {
    writeFile("src/server/payload/collections/Courses.ts", `
export const Courses = { slug: "courses", fields: [{ name: "title", type: "text" }] }
`)
    writeFile("src/server/payload/collections/Users.ts", `
export const Users = { slug: "users", fields: [{ name: "email", type: "email" }] }
`)
    writeFile("src/server/payload/collections/Lessons.ts", `
export const Lessons = { slug: "lessons", fields: [{ name: "content", type: "richText" }] }
`)
    const result = discoverPayloadCollections(tmpDir)
    expect(result).toHaveLength(3)
    const slugs = result.map(c => c.slug).sort()
    expect(slugs).toEqual(["courses", "lessons", "users"])
  })
})

// ─── Admin Components ─────────────────────────────────────────────────────────

describe("discoverAdminComponents", () => {
  it("finds components in src/ui/admin/", () => {
    writeFile("src/ui/admin/CourseLessonsSorter/index.tsx", `
export const CourseLessonsSorter = () => <div>Sorter</div>
`)
    const result = discoverAdminComponents(tmpDir)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("CourseLessonsSorter")
  })

  it("finds components in src/components/admin/", () => {
    writeFile("src/components/admin/DashboardWidget.tsx", `
export const DashboardWidget = () => <div>Widget</div>
`)
    const result = discoverAdminComponents(tmpDir)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("DashboardWidget")
  })

  it("maps component to collection when referenced", () => {
    writeFile("src/ui/admin/CourseLessonsSorter/index.tsx", "export default function() {}")
    writeFile("src/server/payload/collections/Courses.ts", `
export const Courses = {
  slug: "courses",
  fields: [{ name: "lessons", admin: { components: { Field: "/src/ui/admin/CourseLessonsSorter" }}}],
}
`)
    const collections = discoverPayloadCollections(tmpDir)
    const result = discoverAdminComponents(tmpDir, collections)
    expect(result).toHaveLength(1)
    expect(result[0].usedInCollection).toBe("courses")
  })

  it("returns empty for no admin components", () => {
    const result = discoverAdminComponents(tmpDir)
    expect(result).toEqual([])
  })
})

// ─── API Route Scanner ────────────────────────────────────────────────────────

describe("scanApiRoutes", () => {
  it("detects exported HTTP methods from route.ts", () => {
    writeFile("src/app/api/lessons/[id]/route.ts", `
import { NextResponse } from "next/server"
export async function GET(req: Request) { return NextResponse.json({}) }
export async function PATCH(req: Request) { return NextResponse.json({}) }
export async function DELETE(req: Request) { return NextResponse.json({}) }
`)
    const result = scanApiRoutes(tmpDir)
    expect(result).toHaveLength(1)
    expect(result[0].path).toBe("/api/lessons/:id")
    expect(result[0].methods).toContain("GET")
    expect(result[0].methods).toContain("PATCH")
    expect(result[0].methods).toContain("DELETE")
    expect(result[0].methods).not.toContain("POST")
  })

  it("handles multiple API routes", () => {
    writeFile("src/app/api/users/route.ts", `
export async function GET() {}
export async function POST() {}
`)
    writeFile("src/app/api/auth/login/route.ts", `
export async function POST() {}
`)
    const result = scanApiRoutes(tmpDir)
    expect(result).toHaveLength(2)
    const paths = result.map(r => r.path).sort()
    expect(paths).toEqual(["/api/auth/login", "/api/users"])
  })

  it("returns empty when no API routes exist", () => {
    const result = scanApiRoutes(tmpDir)
    expect(result).toEqual([])
  })
})

// ─── Env Var Scanner ──────────────────────────────────────────────────────────

describe("scanEnvVars", () => {
  it("extracts vars from .env.example", () => {
    writeFile(".env.example", `
DATABASE_URL=postgresql://localhost/mydb
PAYLOAD_SECRET=your-secret-here
# Comment
NEXT_PUBLIC_SERVER_URL=http://localhost:3000
`)
    const result = scanEnvVars(tmpDir)
    expect(result).toContain("DATABASE_URL")
    expect(result).toContain("PAYLOAD_SECRET")
    expect(result).toContain("NEXT_PUBLIC_SERVER_URL")
  })

  it("returns empty when no .env.example", () => {
    const result = scanEnvVars(tmpDir)
    expect(result).toEqual([])
  })

  it("filters out common Node.js built-ins", () => {
    writeFile(".env.example", `
NODE_ENV=development
HOME=/home/user
DATABASE_URL=postgres://localhost/db
`)
    const result = scanEnvVars(tmpDir)
    expect(result).toContain("DATABASE_URL")
    expect(result).not.toContain("NODE_ENV")
    expect(result).not.toContain("HOME")
  })
})
