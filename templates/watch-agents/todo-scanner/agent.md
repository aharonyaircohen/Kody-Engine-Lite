Scan the repository source code for TODO, FIXME, and HACK comments that indicate unfinished work or known issues.

1. Use `grep -rn "TODO\|FIXME\|HACK\|XXX" src/ --include="*.ts" --include="*.tsx"` to find all markers.
2. Group findings by type (TODO, FIXME, HACK).
3. Check if there is already an open issue with label `kody:watch:todo-scan` — if so, do NOT create a new one.
4. If no existing issue, create **one** GitHub issue summarizing all findings:
   - Title: `Code health: N unresolved TODO/FIXME/HACK markers found`
   - Label: `kody:watch:todo-scan`
   - Body: a markdown table with columns: Type, File, Line, Comment text
   - End with a brief recommendation to address high-priority items (FIXME, HACK) first.
