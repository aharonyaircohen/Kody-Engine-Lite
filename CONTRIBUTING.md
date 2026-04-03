# Contributing to Kody Engine Lite

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

```bash
git clone https://github.com/aharonyaircohen/Kody-Engine-Lite.git
cd Kody-Engine-Lite
pnpm install
```

### Commands

```bash
pnpm typecheck    # TypeScript type check
pnpm test         # Run tests
pnpm build        # Build npm package
pnpm kody run ... # Dev mode (runs from source via tsx)
```

## How to Contribute

### Reporting Bugs

Open an issue with:
- Steps to reproduce
- Expected vs actual behavior
- Pipeline stage where it failed (if applicable)
- Task artifacts from `.kody/tasks/<task-id>/` (redact any sensitive content)

### Suggesting Features

Open an issue describing:
- The problem you're trying to solve
- Your proposed solution
- How it fits with the existing pipeline stages

### Submitting Changes

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Run `pnpm typecheck && pnpm test` — all checks must pass
4. Write a clear commit message following [conventional commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `refactor:`, etc.)
5. Open a PR against `main`

### Adding a New Pipeline Stage

See [Architecture docs — Adding a New Stage](docs/ARCHITECTURE.md#adding-a-new-stage) for the step-by-step guide.

## Code Style

- TypeScript with strict mode
- Immutable patterns (no mutation)
- Functions under 50 lines, files under 800 lines
- No `console.log` in production code — use the logger

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
