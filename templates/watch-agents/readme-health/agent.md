Check the repository's README.md for completeness and essential documentation.

1. Read `README.md` from the repository root. If it does not exist, that is a critical finding.
2. Check for the presence of these essential sections (look for headings or keywords):
   - **Project description** — what the project does (first paragraph or a "## About" section)
   - **Getting started / Installation** — how to install and set up
   - **Usage / Running** — how to run the project (e.g. dev server, scripts)
   - **Environment variables** — required env vars or reference to .env.example
   - **Tech stack** — frameworks, languages, databases used
3. Also read `package.json` to understand what scripts are available and cross-reference with the README.
4. Check if there is already an open issue with label `kody:watch:readme-health` — if so, do NOT create a new one.
5. If any essential sections are missing, create **one** GitHub issue:
   - Title: `README health: N missing sections`
   - Label: `kody:watch:readme-health`
   - Body: list which sections are present (with a checkmark) and which are missing, with a brief suggestion for each missing section.

If README is complete with all essential sections, do not create an issue.
