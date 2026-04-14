## Release Publisher Watch Agent

This agent automates the full release lifecycle: creates a tracking issue, kicks off the release process, monitors until ready, merges to main, and finalizes.

---

## Step 1: Check for existing tracking issue

Before doing anything, check if a release tracking issue already exists for this cycle:

```bash
gh issue list --label "kody:watch:release" --state open --search "Release v" --limit 5
```

If an open issue with `kody:watch:release` label and a version title already exists, skip to **Step 3** (monitor the existing PR).

---

## Step 2: Create tracking issue

1. Read `package.json` to get the current version (this is the base version — the new version will be determined by `kody release`).
2. Create a GitHub issue with:
   - Title: `Release v{current_version}` (use current version from package.json — the new version will be in the PR title)
   - Labels: `kody:watch:release`
   - Body: Brief description stating this issue tracks the release, including the current date.

```bash
gh issue create --title "Release v{version}" --label "kody:watch:release" --body "Release tracking issue — created by kody watch."
```

Save the issue number — all subsequent steps will post comments on this issue.

---

## Step 3: Run kody release

Run the release command to create the release PR:

```bash
kody release
```

This will:
- Analyze commits since the last tag
- Determine the new version (major/minor/patch)
- Update version files and generate changelog
- Create `release/v{new_version}` branch
- Create a PR `release/v{new_version}` → `main`
- Label the PR with `kody:release`

After `kody release` completes, extract the **new version** from the PR title (format: `chore: release v1.2.3`).

Post a comment on the tracking issue:
```
✅ Release PR created: {PR_URL}
Version: {new_version}
Waiting for CI to pass before merging...
```

---

## Step 4: Monitor PR until ready

Poll the PR until all checks pass and it is mergeable:

1. Get the PR number and branch name:

```bash
# Find the release PR
gh pr list --head "release/v{new_version}" --state open --json number,title,url,mergeable,headRefName
```

2. Check CI status:

```bash
# Check if CI is green
gh pr checks "release/v{new_version}"
```

3. Check mergeability:

```bash
gh pr view "release/v{new_version}" --json mergeable,state,number --jq '{mergeable, state, number}'
```

**Keep polling** (with a short delay between checks) until:
- `mergeable` is `true`
- All CI checks have passed
- The PR state is `OPEN`

If CI fails or the PR has merge conflicts, post a comment on the tracking issue explaining the issue and exit — do not attempt to merge.

Post status updates on the tracking issue periodically (e.g. every few minutes while waiting).

---

## Step 5: Run kody release --finalize --version --merge

Once the PR is ready (mergeable + CI green):

```bash
kody release --finalize --version {new_version} --merge
```

This will:
1. **E2E gate** — runs e2e tests first (blocks everything if it fails)
2. **Tag** — creates and pushes `v{new_version}` tag
3. **GitHub Release** — creates the GitHub Release
4. **Merge PR** — squashes and merges `release/v{new_version}` → `main`
5. **Publish** — runs the publish command
6. **Notify** — runs the notify command
7. **Cleanup** — deletes the release branch

Post the final status on the tracking issue:
```
🚀 Release v{new_version} complete!
- Tag: `v{new_version}`
- GitHub Release: {release_url}
- Merged to main
- Published: {publish_status}
- Notification sent: {notify_status}
```

If `--finalize` fails, post the error on the tracking issue and exit.

---

## Notes

- Always check for existing open `kody:watch:release` issues before creating a new one.
- Extract the new version from the PR title created by `kody release` — do not try to compute it yourself.
- The `--merge` flag tells finalize to merge the PR after E2E passes and the tag/release are created.
- If E2E fails, the PR is NOT merged — post the failure on the tracking issue.
- Use `gh pr view` and `gh pr checks` to monitor status; do not guess or assume.
