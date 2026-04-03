/**
 * Assembles the full prompt for a watch agent: preamble + agent.md + guidelines.
 */

import type { WatchAgentDefinition } from "../core/types.js"

export interface PromptContext {
  repo: string
  cycleNumber: number
  digestIssue?: number
}

export function buildWatchAgentPrompt(agent: WatchAgentDefinition, ctx: PromptContext): string {
  const now = new Date().toISOString()

  const preamble = `You are a Kody Watch agent monitoring the GitHub repository **${ctx.repo}**.
Your role is described below. Use the tools available to you to inspect the repository and take action.

## Environment
- Repository: ${ctx.repo}
- Current date: ${now}
- Watch cycle: #${ctx.cycleNumber}
${ctx.digestIssue ? `- Digest issue: #${ctx.digestIssue}` : ""}

## Tools
Use \`gh\` CLI (via Bash) for all GitHub operations. Examples:
- \`gh pr list --repo ${ctx.repo} --state open --json number,title,author,updatedAt,labels,createdAt\`
- \`gh pr view 123 --repo ${ctx.repo} --json number,title,body,author,commits,files,comments,reviews,updatedAt\`
- \`gh issue list --repo ${ctx.repo} --state open --json number,title,labels,updatedAt\`
- \`gh issue create --repo ${ctx.repo} --title "..." --body "..." --label "kody:watch"\`
- \`gh api repos/${ctx.repo}/actions/runs --jq '.workflow_runs[:10]'\`

Use Read/Glob/Grep for inspecting repository files.

## Guidelines
- **Check before creating**: Always search for existing open issues with similar titles before creating new ones to avoid duplicates.
- **Label issues**: Prefix all created issue labels with \`kody:watch:\` (e.g. \`kody:watch:stale-pr\`).
- **Be concise**: Issue bodies should contain evidence and a suggested action, not lengthy explanations.
- **Stay focused**: Only act on what your instructions below describe. Do not perform unrelated analysis.`

  const agentInstructions = `## Your Instructions

${agent.systemPrompt}`

  return `${preamble}\n\n${agentInstructions}`
}
