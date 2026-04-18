import { defineConfig } from "tsup"

export default defineConfig([
  {
    entry: ["src/bin/cli.ts"],
    format: ["esm"],
    outDir: "dist/bin",
    splitting: false,
    clean: true,
    dts: false,
    sourcemap: false,
    bundle: true,
    platform: "node",
    target: "node22",
    banner: { js: "#!/usr/bin/env node" },
  },
  {
    entry: ["bin-v2/kody-lean.ts"],
    format: ["esm"],
    outDir: "dist/bin-v2",
    splitting: false,
    clean: false,
    dts: false,
    sourcemap: false,
    bundle: true,
    platform: "node",
    target: "node22",
    banner: { js: "#!/usr/bin/env node" },
  },
])
