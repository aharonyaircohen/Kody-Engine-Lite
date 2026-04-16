import { describe, it, expect } from "vitest"
import { secretsToEnvHeredocs } from "../../../src/ci/export-secrets.js"

describe("secretsToEnvHeredocs", () => {
  it("excludes GITHUB_TOKEN", () => {
    const secrets = { GITHUB_TOKEN: "ghp_xxx", OPENAI_API_KEY: "sk-xxx" }
    const result = secretsToEnvHeredocs(secrets)
    expect(result).not.toContain("GITHUB_TOKEN")
    expect(result).toContain("OPENAI_API_KEY")
    expect(result).toContain("sk-xxx")
  })

  it("outputs heredoc format with KODY_EOF_ delimiter", () => {
    const secrets = { MY_SECRET: "secret-value" }
    const result = secretsToEnvHeredocs(secrets)
    expect(result).toBe("MY_SECRET<<KODY_EOF_MY_SECRET\nsecret-value\nKODY_EOF_MY_SECRET\n")
  })

  it("handles multiple secrets", () => {
    const secrets = { KEY1: "val1", KEY2: "val2" }
    const result = secretsToEnvHeredocs(secrets)
    expect(result).toContain("KEY1<<KODY_EOF_KEY1")
    expect(result).toContain("val1")
    expect(result).toContain("KEY2<<KODY_EOF_KEY2")
    expect(result).toContain("val2")
  })

  it("handles empty secrets object", () => {
    const result = secretsToEnvHeredocs({})
    expect(result).toBe("\n")
  })

  it("handles only GITHUB_TOKEN (excluded)", () => {
    const result = secretsToEnvHeredocs({ GITHUB_TOKEN: "xxx" })
    expect(result).toBe("\n")
  })
})
