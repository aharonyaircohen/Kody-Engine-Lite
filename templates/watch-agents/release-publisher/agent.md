Read `package.json` to extract the current version.

Create a GitHub issue for the release:

1. First, check if there is already an open issue with the label `kody:watch:release` that contains the current version in the title (e.g. `Release v1.2.3`). If one already exists, skip creating a new issue.
2. If no existing issue is found, create one with:
   - Title: `Release v{version}`
   - Labels: `kody:watch:release`
   - Body: Brief description stating this issue tracks the release for v{version}, including the current date.

Once the issue is created (or confirmed to exist), run `@kody release --issue-number {issue_number}` to open the release PR.

After the PR is created, post a comment on the issue with a link to the PR.

Use `gh issue list` to check for existing release issues before creating a new one.
Use `gh issue create` to create the issue.
Use `gh pr create` if you need to create a PR manually (e.g. if @kody release doesn't create one automatically).
Use `gh issue comment` to post the PR link on the issue.
