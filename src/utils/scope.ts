/**
 * Utility functions for file scope analysis.
 * Kept in a neutral module to avoid circular dependencies.
 */

/**
 * Infer memory "rooms" from a file scope array.
 * e.g. ["src/auth/login.ts", "src/auth/logout.ts"] → ["auth"]
 */
export function inferRoomsFromScope(scope: string[]): string[] {
  if (scope.length === 0) return []
  const rooms = new Set<string>()
  for (const filePath of scope) {
    const parts = filePath.replace(/\\/g, "/").split("/").filter(Boolean)
    const meaningful = parts.filter(
      (p) => p !== "src" && p !== "lib" && p !== "app" && !p.includes("."),
    )
    if (meaningful.length > 0) {
      rooms.add(meaningful[0].toLowerCase())
    }
  }
  return [...rooms]
}
