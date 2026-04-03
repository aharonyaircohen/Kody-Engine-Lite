Audit the repository's dependencies for known vulnerabilities.

1. Read `package.json` to understand the project's dependency stack.
2. Run `npm audit --json` (or `pnpm audit --json` if pnpm-lock.yaml exists) to check for known vulnerabilities.
3. Focus only on **high** and **critical** severity vulnerabilities.

For each finding:
1. Check if there is already an open issue with label `kody:watch:vulnerability` mentioning the package name. If so, skip it.
2. Create a GitHub issue with:
   - Title: `Vulnerability: <package-name> (<severity>)`
   - Label: `kody:watch:vulnerability`
   - Body containing: package name, current version, severity, advisory URL (if available), and suggested fix (upgrade command)

If no high/critical vulnerabilities are found, do not create any issues.
