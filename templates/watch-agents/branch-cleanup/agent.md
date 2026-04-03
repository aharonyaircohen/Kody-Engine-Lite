List remote branches and identify stale ones that should be cleaned up.

1. Run `gh api repos/{{repo}}/branches --paginate --jq '.[] | {name: .name, protected: .protected}'` to get all branches.
2. For each non-protected branch, check its last commit date using `gh api repos/{{repo}}/commits?sha=BRANCH_NAME&per_page=1 --jq '.[0].commit.committer.date'`.
3. Flag any branch whose last commit is **older than 30 days**.
4. Ignore these branches: `main`, `dev`, `staging`, `production`, and any branch starting with `release/`.
5. Check if there is already an open issue with label `kody:watch:stale-branches` — if so, do NOT create a new one.
6. If stale branches are found, create **one** GitHub issue:
   - Title: `Branch cleanup: N stale branches older than 30 days`
   - Label: `kody:watch:stale-branches`
   - Body: a markdown table with columns: Branch Name, Last Commit Date, Days Stale. End with the command to delete them: `git push origin --delete branch-name`.

If no stale branches are found, do not create an issue.
