import { runFixCiTrigger } from "../ci/fix-ci-trigger.js"

runFixCiTrigger().catch((err) => {
  console.error(err)
  process.exit(1)
})
