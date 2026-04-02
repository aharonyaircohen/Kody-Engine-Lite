# Playwright CLI

You have Playwright CLI installed and available. Use it for running E2E and integration tests.

## When to Use

- Run the full test suite to verify changes don't break existing functionality
- Run specific tests related to the files you modified
- Debug test failures by re-running with verbose output

## Running Tests

```bash
# Run all tests
npx playwright test

# Run specific test file
npx playwright test tests/e2e/login.spec.ts

# Run tests matching a pattern
npx playwright test --grep "checkout"

# Run in a specific browser
npx playwright test --project=chromium

# Run with verbose output for debugging
npx playwright test --reporter=list

# Run a single test by title
npx playwright test -g "should display error message"
```

## Reading Failures

When tests fail, Playwright outputs:
- **Test name** and file location
- **Expected vs received** values for assertions
- **Call log** showing what Playwright did before failure
- **Screenshot/trace paths** if configured

Focus on the assertion diff first — it usually tells you exactly what's wrong.

## Debugging

```bash
# Show detailed trace on failure
npx playwright test --trace on

# Run headed (visible browser) for debugging
npx playwright test --headed

# Run in debug mode with inspector
npx playwright test --debug

# Retry failed tests
npx playwright test --retries=1
```

## Common Patterns

- If a test fails due to timing, check for missing `await` or add `expect().toBeVisible()` waits
- If selectors break, use `getByRole()`, `getByText()`, or `getByTestId()` — they're more stable than CSS selectors
- After fixing code, re-run only the failing test first before running the full suite
