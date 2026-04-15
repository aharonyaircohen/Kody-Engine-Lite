# Templates

This directory contains the canonical source for all GitHub Actions workflows shipped with the `@kody-ade/engine` package.

## Workflow Templates

| File | Purpose |
|------|---------|
| `kody.yml` | Main engine pipeline — handles issue comments, PR reviews, CI failures, chat sessions, and manual dispatch |
| `kody-watch.yml` | Watch agents — scheduled monitoring for health checks, stale PRs, etc. |

## How It Works

The `bootstrap` command copies these templates into a target repository's `.github/workflows/` directory. The engine installs them as symlinks pointing back here so they stay in sync with the package version.

## Symlink Rule

`.github/workflows/*.yml` files in the engine repo itself are **symlinks** to `../templates/`, not copies. This ensures:

- `templates/` is the **single source of truth** for all shipped workflows
- Changes to templates are immediately reflected without manual copying
- No drift between what's shipped and what's in the repo

If you need to edit a workflow, edit the file in `templates/`. The symlink in `.github/workflows/` will automatically reflect the change.

## Repo-Specific Workflows

Workflows that are specific to the engine repo (not shipped to consumers) belong in `.github/workflows/` and should **not** be symlinks. Examples:
- `ci.yml` — this repo's own test/build pipeline

## Contributing

When adding a new workflow to the engine:
1. Create it in `templates/`
2. If it applies to the engine repo itself, create a symlink in `.github/workflows/`
3. If it's repo-specific only, put it directly in `.github/workflows/` (not a symlink)
