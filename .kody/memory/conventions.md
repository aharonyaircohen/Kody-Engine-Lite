# Conventions

## Code
- **TypeScript strict mode**: Full type safety, no implicit any
- **ES2022 modules**: Top-level await, import.meta
- **Immutability**: Spread operators for state updates
- **Error handling**: Try-catch with detailed logging

## Git & Testing
- **Commits**: Conventional format (feat, fix, refactor, docs, test, chore)
- **Tests**: Vitest unit tests, aim for high coverage
- **Type checking**: Required before commit (tsc --noEmit)

## Project Organization
- **src/**: Source TypeScript
- **dist/**: Published npm package
- **prompts/**: Claude instructions per stage
- **.kody/tasks/**: Task state persistence (committed to git)

Refer to ONBOARDING.md for full architecture, design decisions, and pipeline internals.