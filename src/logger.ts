const isCI = !!process.env.GITHUB_ACTIONS

type LogLevel = "debug" | "info" | "warn" | "error"

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

function getLevel(): number {
  const env = process.env.LOG_LEVEL as LogLevel | undefined
  return LEVELS[env ?? "info"] ?? LEVELS.info
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 19)
}

function log(level: LogLevel, msg: string): void {
  if (LEVELS[level] < getLevel()) return
  const prefix = `[${timestamp()}] ${level.toUpperCase().padEnd(5)}`
  if (level === "error") {
    console.error(`${prefix} ${msg}`)
  } else if (level === "warn") {
    console.warn(`${prefix} ${msg}`)
  } else {
    console.log(`${prefix} ${msg}`)
  }
}

export const logger = {
  debug: (msg: string) => log("debug", msg),
  info: (msg: string) => log("info", msg),
  warn: (msg: string) => log("warn", msg),
  error: (msg: string) => log("error", msg),
}

export function createStageLogger(stage: string, taskId?: string) {
  const prefix = taskId ? `[${stage}:${taskId}]` : `[${stage}]`
  return {
    debug: (msg: string) => logger.debug(`${prefix} ${msg}`),
    info: (msg: string) => logger.info(`${prefix} ${msg}`),
    warn: (msg: string) => logger.warn(`${prefix} ${msg}`),
    error: (msg: string) => logger.error(`${prefix} ${msg}`),
  }
}

export function ciGroup(title: string): void {
  if (isCI) process.stdout.write(`::group::${title}\n`)
}

export function ciGroupEnd(): void {
  if (isCI) process.stdout.write(`::endgroup::\n`)
}
