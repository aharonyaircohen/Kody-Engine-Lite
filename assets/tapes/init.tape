# VHS tape: kody-engine-lite init demo
# Run: vhs assets/tapes/init.tape
# Prerequisites: kody-engine-lite installed globally, gh authenticated
# Produces: assets/demo-init.gif
# Docs: https://github.com/charmbracelet/vhs

Output assets/demo-init.gif

Set Shell "bash"
Set FontSize 14
Set Width 880
Set Height 600
Set Padding 16
Set TypingSpeed 40ms
Set Theme { "name": "Kody", "black": "#0f172a", "red": "#ef4444", "green": "#4ade80", "yellow": "#fbbf24", "blue": "#818cf8", "magenta": "#c084fc", "cyan": "#38bdf8", "white": "#e2e8f0", "brightBlack": "#64748b", "brightRed": "#f87171", "brightGreen": "#86efac", "brightYellow": "#fde68a", "brightBlue": "#a5b4fc", "brightMagenta": "#d8b4fe", "brightCyan": "#7dd3fc", "brightWhite": "#f8fafc", "background": "#0f172a", "foreground": "#e2e8f0", "selection": "#334155", "cursor": "#38bdf8" }

# Setup: create a temp project that mimics a real repo
Hide
Type "cd $(mktemp -d) && git init -q && npm init -y -q > /dev/null 2>&1"
Enter
Sleep 1s
Type "git add -A && git commit -q -m 'init' > /dev/null 2>&1"
Enter
Sleep 500ms
Show

Sleep 500ms

# Run the init command
Type "npx @kody-ade/kody-engine-lite init"
Sleep 500ms
Enter

# Wait for full output
Sleep 12s

# Pause on the summary
Sleep 3s
