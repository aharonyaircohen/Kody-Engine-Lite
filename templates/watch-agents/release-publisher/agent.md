## Release Publisher Watch Agent

This agent automates the full release lifecycle: creates a tracking issue, runs kody release, merges to dev, finalizes (E2E → tag → release → publish → notify), creates promotion PR, and merges to main.

---

## Step 1: Check for existing tracking issue

Before doing anything, check if a release tracking issue already exists for this cycle:

```bash
gh issue list --label "kody:watch:release" --state open --limit 5
```

If an open issue with `kody:watch:release` label already exists, skip to **Step 3**.

---

## Step 2: Create tracking issue

1. Read `package.json` to get the current version (this is the base version — the new version will be determined by `kody release`).
2. Create a GitHub issue with:
   - Title: `Release v{current_version}` (the new version will appear in the PR title)
   - Labels: `kody:watch:release`
   - Body: Brief description stating this issue tracks the release, including the current date.

```bash
gh issue create --title "Release v{version}" --label "kody:watch:release" --body "Release tracking issue — created by kody watch."
```

Save the issue number — all subsequent steps will post comments on this issue.

---

## Step 3: Run kody release

Run the release command to create the release PR targeting `dev`:

```bash
kody release
```

This will:
- Analyze commits since the last tag
- Determine the new version (major/minor/patch)
- Update version files and generate changelog
- Create `release/v{new_version}` branch
- Create a PR `release/v{new_version}` → `dev`
- Label the PR with `kody:release`

After `kody release` completes, extract the **new version** from the PR title (format: `chore: release v1.2.3`).

Post a comment on the tracking issue:
```
✅ Release PR created: {PR_URL}
Version: {new_version}
Waiting for CI to pass before merging...
```

---

## Step 4: Merge release PR to dev

Poll the PR until it is mergeable and CI passes:

```bash
# Find the release PR
gh pr list --head "release/v{new_version}" --state open --json number,title,url,mergeableState

# Check CI status
gh pr checks "release/v{new_version}"

# Check mergeability
gh pr view "release/v{new_version}" --json mergeableState --jq '{mergeableState}'
```

**Keep polling** (with a short delay between checks) until:
- `mergeableState` is `MERGEABLE`
- All CI checks have passed
- The PR state is `OPEN`

Once ready, merge the PR:

```bash
gh pr merge "release/v{new_version}" --squash --auto
```

Post on the tracking issue:
```
✅ Merged to dev: release/v{new_version} → dev
Running finalize...
```

---

## Step 5: Run kody release --finalize --version

Once merged to dev, run finalize:

```bash
kody release --finalize --version {new_version}
```

This will:
1. **E2E gate** — runs e2e tests first (blocks everything if it fails)
2. **Tag** — creates and pushes `v{new_version}` tag
3. **GitHub Release** — creates the GitHub Release
4. **Publish** — runs the publish command
5. **Notify** — runs the notify command

**If finalize fails at any step:**
- Post the error on the tracking issue
- Create a new issue to fix the errors (title: `Fix release v{new_version} finalize failure`)
- Include the error details in the issue body
- Exit — do NOT proceed to Step 6

Post on the tracking issue after finalize succeeds:
```
🚀 Finalize complete!
- Tag: `v{new_version}`
- GitHub Release: {release_url}
- Published
- Notification sent
Creating promotion PR dev → main...
```

---

## Step 6: Create and merge promotion PR dev → main

After finalize succeeds, create a PR to promote dev to main:

```bash
# Create PR dev → main
gh pr create --base main --head dev --title "Publish dev → production" --body "Promotion PR — no code changes, just merge dev to main for production release."
```

Wait for the PR to be mergeable and CI to pass:

```bash
gh pr view {PR_NUMBER} --json mergeableState
gh pr checks {PR_NUMBER}
```

Once ready, merge:

```bash
gh pr merge {PR_NUMBER} --squash --auto
```

Post on the tracking issue:
```
✅ Merged to main: dev → main
Production release v{new_version} complete!
```

---

## Notes

- Always check for existing open `kody:watch:release` issues before creating a new one.
- Extract the new version from the PR title created by `kody release` — do not try to compute it yourself.
- If E2E fails in Step 5, create a fix issue and exit — do NOT proceed to Step 6.
- Use `gh pr view` and `gh pr checks` to monitor status; do not guess or assume.
- The promotion PR (Step 6) has no code changes — it only exists to trigger any CI/CD that runs on merge to main.
