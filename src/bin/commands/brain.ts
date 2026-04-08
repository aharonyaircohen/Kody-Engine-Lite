/**
 * `kody brain` — User brain memory management.
 *
 * Usage:
 *   kody brain set <hall> <room> <content>  — write a brain entry
 *   kody brain list                            — list all brain entries
 *   kody brain show                            — show all brain content
 *   kody brain clear                           — clear all brain entries
 *
 * Halls: facts, preferences, thoughts
 *   facts        — who they are, what they work on
 *   preferences  — how they like to work
 *   thoughts     — notable session insights
 */

import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { readBrainMemory, writeBrainEntry, getBrainBasePath } from "../../memory.js"
import { MemoryHall } from "../../context-tiers.js"

const VALID_HALLS: MemoryHall[] = ["facts", "preferences", "thoughts"]

export async function runBrainCommand(args: string[]): Promise<void> {
  const sub = args[0]

  if (sub === "set") {
    const hall = args[1] as MemoryHall | undefined
    const room = args[2]
    const content = args.slice(3).join(" ")

    if (!hall || !VALID_HALLS.includes(hall)) {
      console.error("Invalid hall. Valid halls: " + VALID_HALLS.join(", "))
      console.error("Usage: kody brain set <hall> <room> <content>")
      console.error("  e.g. kody brain set facts user 'Yair works on Kody-Engine-Lite'")
      process.exit(1)
    }
    if (!room) {
      console.error("Room is required.")
      console.error("Usage: kody brain set <hall> <room> <content>")
      process.exit(1)
    }
    if (!content) {
      console.error("Content is required.")
      console.error("Usage: kody brain set <hall> <room> <content>")
      process.exit(1)
    }

    writeBrainEntry(hall, room, content)
    const brainDir = getBrainBasePath()
    console.log(`\n✓ Written to ${brainDir}/memory/${hall}_${room}.md`)
    console.log(`  [${hall}] ${room}: ${content}`)
  } else if (sub === "list") {
    const brainDir = path.join(getBrainBasePath(), "memory")
    if (!fs.existsSync(brainDir)) {
      console.log("\nNo brain entries found. Run 'kody brain set' to add entries.")
      return
    }

    const files = fs.readdirSync(brainDir).filter((f) => f.endsWith(".md")).sort()
    if (files.length === 0) {
      console.log("\nNo brain entries found. Run 'kody brain set' to add entries.")
      return
    }

    console.log(`\nBrain entries (${files.length} file(s)):`)
    console.log(`  ${getBrainBasePath()}/memory/`)
    for (const file of files) {
      const filePath = path.join(brainDir, file)
      const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n")
      console.log(`  ${file}  (${lines.length} entries)`)
    }
  } else if (sub === "show") {
    const content = readBrainMemory()
    if (!content) {
      console.log("\nNo brain entries found.")
      return
    }
    console.log(content)
  } else if (sub === "clear") {
    if (!args.includes("--confirm")) {
      console.log("\nThis will delete all brain entries. Add --confirm to proceed:")
      console.log("  kody brain clear --confirm")
      return
    }

    const brainDir = getBrainBasePath()
    if (fs.existsSync(brainDir)) {
      fs.rmSync(brainDir, { recursive: true, force: true })
    }
    console.log("\n✓ Brain cleared.")
  } else if (!sub) {
    console.log(`
kody brain — User brain memory management

Usage:
  kody brain set <hall> <room> <content>  Write a brain entry
  kody brain list                         List all brain entries
  kody brain show                         Show all brain content
  kody brain clear                        Clear all brain entries (requires --confirm)

Halls:
  facts        — who they are, what they work on
  preferences  — how they like to work
  thoughts     — notable session insights

Examples:
  kody brain set facts user 'Yair works on Kody-Engine-Lite'
  kody brain set preferences workflow 'always ask before acting'
  kody brain set thoughts discovery 'exploring unified memory system'
  kody brain list
  kody brain show
  kody brain clear --confirm
`)
  } else {
    console.error(`Unknown subcommand: ${sub}`)
    console.error("Run 'kody brain' without args to see usage.")
    process.exit(1)
  }
}
