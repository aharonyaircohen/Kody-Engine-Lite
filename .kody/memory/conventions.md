# Conventions

## Code

- **TypeScript strict mode**: Full type safety, no implicit any
- **ES2022 modules**: Top-level await, import.meta
- **Immutability**: Spread operators for state updates
- **Error handling**: Try-catch with detailed logging
- **Process lifecycle**: Spawn → writeStdin → waitForProcess → cleanup on timeout

## Execution & Configuration

- **Tier-based model routing**: cheap/mid/strong tiers map to provider models via `TIER_TO_ANTHROPIC_IDS`
- **LiteLLM config generation**: Dynamic YAML from provider + modelMap, supports provider-specific API key env vars
- **Task ID pattern**: Standardized generation via `generateTaskId()` for state persistence

## Git & Testing

- **Commits**: Conventional format (feat, fix, refactor, docs, test, chore)
- **Tests**: Vitest unit tests, aim for high coverage
- **Type checking**: Required before commit (tsc --noEmit)

## Project Organization

- **src/**: Source TypeScript (bin/, cli/, learning/, pipeline/, stages/)
- **dist/**: Published npm package
- **prompts/**: Claude instructions per stage
- **.kody/tasks/**: Task state persistence (committed to git)

Refer to ONBOARDING.md for full architecture, design decisions, and pipeline internals.
