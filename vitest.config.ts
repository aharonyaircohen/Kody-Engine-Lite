import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    setupFiles: ["tests/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "coverage",
      exclude: [
        "node_modules/**",
        "dist/**",
        "**/*.test.ts",
        "**/*.int.ts",
        "tests/**",
        "scripts/**",
        "demo/**",
        "plans/**",
        "templates/**",
        "prompts/**",
        "*.config.ts",
      ],
      thresholds: {
        lines: 50,
        functions: 55,
        branches: 40,
        statements: 50,
      },
    },
  },
})
