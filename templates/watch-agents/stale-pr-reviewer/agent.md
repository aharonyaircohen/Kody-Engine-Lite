List all open pull requests. For each PR, check the last activity date (most recent of: last commit, last comment, last review).

Flag any PR that has had **no activity in the last 7 days** as stale.

For each stale PR:
1. First, check if there is already an open issue with the label `kody:watch:stale-pr` that mentions this PR number. If so, skip it.
2. Create a GitHub issue with:
   - Title: `Stale PR #<number>: <pr-title>`
   - Label: `kody:watch:stale-pr`
   - Body containing: PR number, author, days since last activity, a link to the PR, and a suggested action (ping author, close, or merge)

Ignore PRs that have any of these labels: `on-hold`, `wip`, `draft`.
Do not flag draft PRs.
