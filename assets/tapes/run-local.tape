# VHS tape: kody-engine-lite run --local demo
# Run: vhs assets/tapes/run-local.tape
# Prerequisites: kody-engine-lite installed, ANTHROPIC_API_KEY set, a repo with an issue
# Produces: assets/demo-run.gif
# NOTE: This runs a REAL pipeline — it will use API credits and take several minutes.
#       For a shorter demo, use --complexity low to skip plan and review stages.
# Docs: https://github.com/charmbracelet/vhs

Output assets/demo-run.gif

Set Shell "bash"
Set FontSize 14
Set Width 880
Set Height 600
Set Padding 16
Set TypingSpeed 40ms
Set Theme { "name": "Kody", "black": "#0f172a", "red": "#ef4444", "green": "#4ade80", "yellow": "#fbbf24", "blue": "#818cf8", "magenta": "#c084fc", "cyan": "#38bdf8", "white": "#e2e8f0", "brightBlack": "#64748b", "brightRed": "#f87171", "brightGreen": "#86efac", "brightYellow": "#fde68a", "brightBlue": "#a5b4fc", "brightMagenta": "#d8b4fe", "brightCyan": "#7dd3fc", "brightWhite": "#f8fafc", "background": "#0f172a", "foreground": "#e2e8f0", "selection": "#334155", "cursor": "#38bdf8" }

Sleep 500ms

# Show the issue we're about to work on
Type "gh issue view 1 --json title,body --jq '.title'"
Sleep 300ms
Enter
Sleep 2s

# Run the pipeline
Type "kody-engine-lite run --issue-number 1 --local --complexity low"
Sleep 500ms
Enter

# Pipeline runs: taskify → build → verify → ship (low complexity)
# This takes several minutes with real API calls.
# Adjust timeout based on your typical run duration.
Sleep 300s

# Pause on the final summary
Sleep 5s
