import { main } from "../src-v2/entry.js"

main().then((code) => {
  process.exit(code)
}).catch((err) => {
  process.stderr.write(`[kody-lean] fatal: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(99)
})
