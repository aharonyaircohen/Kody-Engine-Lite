import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import fs from "fs"
import os from "os"
import path from "path"

// Mock child_process before importing modules that use it
vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
}))

vi.mock("../../src/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

import { execFileSync } from "child_process"
import {
  getIssue,
  downloadIssueAttachments,
} from "../../src/github-api.js"

const mockExecFileSync = vi.mocked(execFileSync)

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// getIssue — enriched fields (labels, comments, assignees, milestone)
// ---------------------------------------------------------------------------
describe("getIssue enriched response", () => {
  it("returns labels alongside body and title", () => {
    mockExecFileSync.mockReturnValue(
      JSON.stringify({
        title: "Bug: button misaligned",
        body: "The submit button is off by 10px",
        labels: [{ name: "bug" }, { name: "ui" }],
        comments: [],
        assignees: [],
        milestone: null,
      })
    )

    const issue = getIssue(42)

    expect(issue).not.toBeNull()
    expect(issue!.title).toBe("Bug: button misaligned")
    expect(issue!.body).toBe("The submit button is off by 10px")
    expect(issue!.labels).toEqual(["bug", "ui"])
  })

  it("returns empty labels array when issue has no labels", () => {
    mockExecFileSync.mockReturnValue(
      JSON.stringify({
        title: "Add feature",
        body: "Please add dark mode",
        labels: [],
        comments: [],
        assignees: [],
        milestone: null,
      })
    )

    const issue = getIssue(10)

    expect(issue).not.toBeNull()
    expect(issue!.labels).toEqual([])
  })

  it("returns comments when present", () => {
    mockExecFileSync.mockReturnValue(
      JSON.stringify({
        title: "Feature request",
        body: "Need a search bar",
        labels: [],
        comments: [
          { body: "Agreed, this is needed", createdAt: "2026-03-01T10:00:00Z", author: { login: "alice" } },
          { body: "I can work on this", createdAt: "2026-03-02T14:00:00Z", author: { login: "bob" } },
        ],
        assignees: [],
        milestone: null,
      })
    )

    const issue = getIssue(55)

    expect(issue).not.toBeNull()
    expect(issue!.comments).toHaveLength(2)
    expect(issue!.comments![0]).toEqual({
      body: "Agreed, this is needed",
      author: "alice",
      createdAt: "2026-03-01T10:00:00Z",
    })
  })

  it("returns empty comments when none exist", () => {
    mockExecFileSync.mockReturnValue(
      JSON.stringify({
        title: "Empty issue",
        body: "",
        labels: [],
        comments: [],
        assignees: [],
        milestone: null,
      })
    )

    const issue = getIssue(1)

    expect(issue).not.toBeNull()
    expect(issue!.comments).toEqual([])
  })

  it("returns assignees as login strings", () => {
    mockExecFileSync.mockReturnValue(
      JSON.stringify({
        title: "Assigned task",
        body: "Fix the thing",
        labels: [],
        comments: [],
        assignees: [{ login: "alice" }, { login: "bob" }],
        milestone: null,
      })
    )

    const issue = getIssue(30)

    expect(issue).not.toBeNull()
    expect(issue!.assignees).toEqual(["alice", "bob"])
  })

  it("returns empty assignees when none assigned", () => {
    mockExecFileSync.mockReturnValue(
      JSON.stringify({
        title: "Unassigned",
        body: "",
        labels: [],
        comments: [],
        assignees: [],
        milestone: null,
      })
    )

    const issue = getIssue(31)

    expect(issue).not.toBeNull()
    expect(issue!.assignees).toEqual([])
  })

  it("returns milestone title when set", () => {
    mockExecFileSync.mockReturnValue(
      JSON.stringify({
        title: "Sprint task",
        body: "Implement feature",
        labels: [],
        comments: [],
        assignees: [],
        milestone: { title: "v2.0 Release" },
      })
    )

    const issue = getIssue(40)

    expect(issue).not.toBeNull()
    expect(issue!.milestone).toBe("v2.0 Release")
  })

  it("returns null milestone when not set", () => {
    mockExecFileSync.mockReturnValue(
      JSON.stringify({
        title: "No milestone",
        body: "",
        labels: [],
        comments: [],
        assignees: [],
        milestone: null,
      })
    )

    const issue = getIssue(41)

    expect(issue).not.toBeNull()
    expect(issue!.milestone).toBeNull()
  })

  it("requests all enriched fields in --json", () => {
    mockExecFileSync.mockReturnValue(
      JSON.stringify({ title: "T", body: "B", labels: [], comments: [], assignees: [], milestone: null })
    )

    getIssue(99)

    const call = mockExecFileSync.mock.calls[0]
    const jsonArg = call[1]![call[1]!.indexOf("--json") + 1] as string
    expect(jsonArg).toContain("labels")
    expect(jsonArg).toContain("comments")
    expect(jsonArg).toContain("assignees")
    expect(jsonArg).toContain("milestone")
  })
})

// ---------------------------------------------------------------------------
// downloadIssueAttachments — extract & download GitHub asset URLs
// ---------------------------------------------------------------------------
describe("downloadIssueAttachments", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-attach-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("extracts GitHub user-content image URLs from markdown body", () => {
    const body = [
      "Here is the bug:",
      "![screenshot](https://github.com/user-attachments/assets/abc-123/screenshot.png)",
      "And another:",
      "![design](https://user-images.githubusercontent.com/12345/abcdef.jpg)",
    ].join("\n")

    // Mock gh api calls for downloading
    mockExecFileSync.mockReturnValue(Buffer.from("fake-image-data") as any)

    const result = downloadIssueAttachments(body, tmpDir)

    expect(result.downloadedFiles).toHaveLength(2)
    expect(result.downloadedFiles[0]).toMatch(/attachments\//)
    expect(result.downloadedFiles[1]).toMatch(/attachments\//)
  })

  it("returns updated body with local paths replacing remote URLs", () => {
    const body =
      "Bug: ![img](https://github.com/user-attachments/assets/abc-123/shot.png)"

    mockExecFileSync.mockReturnValue(Buffer.from("fake-image") as any)

    const result = downloadIssueAttachments(body, tmpDir)

    expect(result.updatedBody).toContain("attachments/")
    expect(result.updatedBody).not.toContain("https://github.com/user-attachments")
  })

  it("returns body unchanged when no attachment URLs found", () => {
    const body = "Just a plain text issue with no images."

    const result = downloadIssueAttachments(body, tmpDir)

    expect(result.updatedBody).toBe(body)
    expect(result.downloadedFiles).toEqual([])
    // Should not call gh at all
    expect(mockExecFileSync).not.toHaveBeenCalled()
  })

  it("handles download failure gracefully — keeps original URL", () => {
    const body =
      "![broken](https://github.com/user-attachments/assets/bad-id/missing.png)"

    mockExecFileSync.mockImplementation(() => {
      throw new Error("HTTP 404")
    })

    const result = downloadIssueAttachments(body, tmpDir)

    // Original URL preserved on failure
    expect(result.updatedBody).toContain("https://github.com/user-attachments/assets/bad-id/missing.png")
    expect(result.downloadedFiles).toEqual([])
  })

  it("creates attachments subdirectory in task dir", () => {
    const body =
      "![img](https://github.com/user-attachments/assets/abc/photo.png)"

    mockExecFileSync.mockReturnValue(Buffer.from("data") as any)

    downloadIssueAttachments(body, tmpDir)

    expect(fs.existsSync(path.join(tmpDir, "attachments"))).toBe(true)
  })

  it("handles multiple images with same filename by deduplicating", () => {
    const body = [
      "![a](https://github.com/user-attachments/assets/id1/image.png)",
      "![b](https://github.com/user-attachments/assets/id2/image.png)",
    ].join("\n")

    mockExecFileSync.mockReturnValue(Buffer.from("data") as any)

    const result = downloadIssueAttachments(body, tmpDir)

    // Both should be downloaded with unique names
    expect(result.downloadedFiles).toHaveLength(2)
    expect(new Set(result.downloadedFiles).size).toBe(2)
  })

  it("matches GitHub asset URLs in various markdown formats", () => {
    const body = [
      // Standard markdown image
      "![alt](https://github.com/user-attachments/assets/uuid/file.png)",
      // HTML img tag (GitHub sometimes renders these)
      '<img src="https://github.com/user-attachments/assets/uuid2/file2.jpg" />',
      // Bare URL on its own line
      "https://github.com/user-attachments/assets/uuid3/file3.gif",
    ].join("\n")

    mockExecFileSync.mockReturnValue(Buffer.from("data") as any)

    const result = downloadIssueAttachments(body, tmpDir)

    expect(result.downloadedFiles.length).toBeGreaterThanOrEqual(2)
  })
})
