import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/bin/cli.ts", "src/entry.ts"],
  format: ["esm"],
  outDir: "dist",
  splitting: false,
  clean: true,
  dts: false,
  sourcemap: false,
  bundle: true,
  platform: "node",
  target: "node22",
  banner: {
    js: "#!/usr/bin/env node",
  },
})
