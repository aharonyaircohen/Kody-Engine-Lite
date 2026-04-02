/**
 * Simple console logger conforming to the Logger interface.
 * No external dependencies — uses structured console output.
 */

import type { Logger } from "../core/types.js"

export function createConsoleLogger(): Logger {
  const format = (level: string, first: unknown, second?: string): string => {
    const timestamp = new Date().toISOString().slice(11, 19)
    if (typeof first === "string") {
      return `[${timestamp}] ${level}: ${first}`
    }
    const ctx = JSON.stringify(first)
    return `[${timestamp}] ${level}: ${second} ${ctx}`
  }

  return {
    debug(first: unknown, second?: string): void {
      if (process.env.LOG_LEVEL === "debug") {
        console.debug(format("DEBUG", first, second))
      }
    },
    info(first: unknown, second?: string): void {
      console.info(format("INFO", first, second))
    },
    warn(first: unknown, second?: string): void {
      console.warn(format("WARN", first, second))
    },
    error(first: unknown, second?: string): void {
      console.error(format("ERROR", first, second))
    },
  } as Logger
}
