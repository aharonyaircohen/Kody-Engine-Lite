# Minimal Kody Setup

This is the simplest possible Kody Engine Lite configuration for a TypeScript project using pnpm.

## Steps

1. Install Kody Engine Lite globally:

   ```bash
   npm install -g @kody-ade/kody-engine-lite
   ```

2. Run init in your project root:

   ```bash
   cd your-project
   kody-engine-lite init
   ```

   This copies `kody.config.json`, `.github/workflows/kody.yml`, and seeds `.kody/memory/`.

3. Edit `kody.config.json` — update `github.owner` and `github.repo` to match your repository.

4. Add your Anthropic API key as a GitHub secret:

   ```bash
   gh secret set ANTHROPIC_API_KEY --repo your-org/your-repo
   ```

5. Enable write permissions in **Settings → Actions → General → Workflow permissions**:
   - "Read and write permissions"
   - "Allow GitHub Actions to create and approve pull requests"

6. Push and trigger:

   ```bash
   git add .github/workflows/kody.yml kody.config.json .kody/
   git commit -m "chore: add kody engine"
   git push
   ```

   Then comment on any issue: `@kody`

## Configuration notes

- Change `agent.modelMap` to use different Claude models per stage tier
- Set `git.defaultBranch` to `dev` or `master` if you don't use `main`
- Leave quality commands empty (`""`) to skip checks you don't have set up
