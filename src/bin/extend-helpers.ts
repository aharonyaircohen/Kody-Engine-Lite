const MAX_EXISTING_CONTENT_LENGTH = 6000

/**
 * Build an "extend" instruction block for the LLM.
 * When existing content is provided, instructs the LLM to preserve manual edits
 * and extend with new findings. Returns empty string when no existing content.
 */
export function buildExtendInstruction(existingContent: string, fileDescription: string): string {
  if (!existingContent.trim()) return ""

  let content = existingContent
  if (content.length > MAX_EXISTING_CONTENT_LENGTH) {
    const cutoff = content.lastIndexOf("\n", MAX_EXISTING_CONTENT_LENGTH)
    content = content.slice(0, cutoff > 0 ? cutoff : MAX_EXISTING_CONTENT_LENGTH) + "\n... (truncated)"
  }

  return `
## Existing ${fileDescription} (EXTEND, do not replace)
You are UPDATING an existing ${fileDescription}. Follow these rules strictly:
- PRESERVE all existing sections and content that are still accurate — keep them verbatim
- PRESERVE any manually-added sections, custom notes, or user edits
- REMOVE only lines that reference files, patterns, or dependencies that no longer exist in the project
- APPEND new sections or lines for newly discovered patterns, files, or conventions
- Do NOT rewrite sections that are still correct

### Existing content:
${content}
`
}
