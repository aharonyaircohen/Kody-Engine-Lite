# Templates

This directory contains the canonical source for all GitHub Actions workflows shipped with the `@kody-ade/engine` package.

## Workflow Templates

| File | Purpose |
|------|---------|
| `kody.yml` | Main engine pipeline — handles issue comments, PR reviews, CI failures, chat sessions, and manual dispatch |
| `kody-watch.yml` | Watch agents — scheduled monitoring for health checks, stale PRs, etc. |

## How It Works

The `bootstrap` command copies these templates into a target repository's `.github/workflows/` directory. The engine installs them as symlinks pointing back here so they stay in sync with the package version.

## File Organization

The `.github/workflows/kody.yml` file is the **canonical source**. The `templates/kody.yml` is a **symlink** pointing to `../.github/workflows/kody.yml`. This is inverted from the typical pattern because:

- GitHub Actions requires real files in `.github/workflows/` (symlinks are not followed)
- When the npm package is published, `templates/` ships the symlink
- When `kody-engine init` runs in a target repo, `fs.copyFileSync` follows the symlink and writes the **real file content** into the target's `.github/workflows/kody.yml`

This means:
- Edit `.github/workflows/kody.yml` directly — it's the one place to change the workflow
- The symlink in `templates/` keeps them in sync for npm packaging
- No manual copying needed — `init` handles it automatically

## Repo-Specific Workflows

Workflows that are specific to the engine repo (not shipped to consumers) belong in `.github/workflows/` and should **not** be symlinks. Examples:
- `ci.yml` — this repo's own test/build pipeline

## Contributing

When adding a new workflow to the engine:
1. Create it in `templates/`
2. If it applies to the engine repo itself, create a symlink in `.github/workflows/`
3. If it's repo-specific only, put it directly in `.github/workflows/` (not a symlink)
