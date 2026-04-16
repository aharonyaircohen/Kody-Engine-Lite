import { runCloseIssue } from "../ci/close-issue.js"

runCloseIssue().catch((err) => {
  console.error(err)
  process.exit(1)
})
