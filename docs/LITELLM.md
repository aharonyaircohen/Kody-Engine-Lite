# Using Non-Anthropic Models (LiteLLM)

Kody uses Claude Code under the hood, but Claude Code can route API calls through a [LiteLLM](https://litellm.ai/) proxy to use **any LLM**: MiniMax, GPT-4o, Gemini, Llama, local models via Ollama, etc.

## How It Works

1. Kody sets `ANTHROPIC_BASE_URL` to the LiteLLM proxy URL when any configured model uses a non-Anthropic provider
2. Claude Code sends API calls to the proxy (using the bare model name from your `provider/model` spec)
3. LiteLLM maps each registered `model_name` to the actual `provider/model` upstream
4. LiteLLM translates Anthropic's tool-use protocol to the provider's format
5. No code changes needed — just configuration

> Kody passes the bare model name (the part after the slash) to Claude Code. The proxy registers each model under that bare name and routes upstream using `provider/model`. Claude Code never knows the difference.

## Setup

### Spec format: `provider/model`

Every model entry in `kody.config.json` is a `provider/model` string. There is no separate `provider` field — it's encoded in the spec.

`claude/...` and `anthropic/...` mean "talk to the Anthropic API directly" — no proxy, no LiteLLM. Anything else is treated as a LiteLLM-routed model and Kody auto-starts the proxy.

```json
{
  "agent": {
    "modelMap": {
      "cheap":  "minimax/MiniMax-M2.7-highspeed",
      "mid":    "minimax/MiniMax-M2.7-highspeed",
      "strong": "minimax/MiniMax-M2.7-highspeed"
    }
  }
}
```

### Mix providers across stages

Per-stage overrides take precedence over `modelMap`:

```json
{
  "agent": {
    "default": "minimax/MiniMax-M2.7-highspeed",
    "stages": {
      "plan":   "claude/claude-opus-4-7",
      "review": "claude/claude-opus-4-7"
    }
  }
}
```

Plan and review go straight to Anthropic; every other stage runs through MiniMax via LiteLLM.

### Set API Keys

**Local:** Add to `.env` in your project root (use your provider's key name):
```
MINIMAX_API_KEY=your-key-here      # for minimax provider
OPENAI_API_KEY=your-key-here       # for openai provider
GEMINI_API_KEY=your-key-here       # for google/gemini provider
```

**CI:** Add as a GitHub secret:
```bash
gh secret set MINIMAX_API_KEY --repo owner/repo
```

### CI Workflow

When using a non-Anthropic provider, ensure LiteLLM is installed and API keys are passed in your workflow:

```yaml
- name: Install LiteLLM proxy
  run: |
    python3 -m venv /tmp/litellm-venv
    /tmp/litellm-venv/bin/pip install 'litellm[proxy]'
    sudo ln -sf /tmp/litellm-venv/bin/litellm /usr/local/bin/litellm

- name: Run Kody pipeline
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    MINIMAX_API_KEY: ${{ secrets.MINIMAX_API_KEY }}  # match your provider
```

> Use a venv to avoid system package conflicts. The symlink makes `litellm` available on PATH for Kody's auto-start.

## Auto-Start

When any configured model has a non-`claude`/`anthropic` provider and the proxy isn't already running, Kody automatically:

1. Checks proxy health at the configured URL
2. Generates a LiteLLM `model_list` from every `provider/model` entry in `agent.modelMap`, `agent.default`, and `agent.stages`
3. Detects `litellm` binary (tries `which litellm`, then `python3 -c "import litellm"`)
4. Loads `*_API_KEY` variables from the project's `.env` file into the proxy process
5. Starts the proxy and waits for health check (up to 60 seconds)

The auto-start loads **only** `*_API_KEY` patterns from `.env` to avoid poisoning the proxy with unrelated variables (e.g., `DATABASE_URL` would trigger Prisma setup in LiteLLM).

## Tested Providers

| Provider | Model | Status |
|----------|-------|--------|
| **MiniMax** | MiniMax-M2.7-highspeed | Full pipeline validated (all 7 stages, autofix, review) |
| **Anthropic** | claude-haiku/sonnet/opus | Default, fully supported |

LiteLLM supports [100+ providers](https://docs.litellm.ai/docs/providers). Models must support tool-use and be routable through LiteLLM's Anthropic-compatible translation layer.

## Common Gotchas

**Format your specs as `provider/model`.** A bare value like `MiniMax-M1` (no slash) is rejected at config load with a clear error message.

**Bare model names go to Claude Code.** Kody passes the part *after* the slash (`MiniMax-M2.7-highspeed`) to Claude Code, and the proxy is responsible for routing that name upstream. The provider in the spec only drives which LiteLLM entry gets generated.

**CI pip install needs a venv.** `sudo pip install` fails on Ubuntu runners due to system package conflicts (`typing_extensions`). User-level `pip install` puts the binary in `~/.local/bin` which isn't on PATH. The venv + symlink pattern is the most reliable:

```yaml
- run: |
    python3 -m venv /tmp/litellm-venv
    /tmp/litellm-venv/bin/pip install 'litellm[proxy]'
    sudo ln -sf /tmp/litellm-venv/bin/litellm /usr/local/bin/litellm
```

**`.env` API keys are loaded automatically.** The auto-start reads `*_API_KEY` patterns from your project's `.env` file and injects them into the litellm process. But it only loads `*_API_KEY` patterns — not `DATABASE_URL` or other vars (which would trigger Prisma setup in LiteLLM and crash).

## Troubleshooting

**"litellm not installed"**
- Check that `litellm` is on PATH: `litellm --version`
- On CI, the venv install + symlink approach is most reliable

**Proxy starts but agent hangs**
- Check that API keys are available to the proxy process
- Locally: keys must be in `.env` (not just exported in your shell)
- In CI: add keys as env vars in the workflow step

**"Invalid model spec '…' — expected 'provider/model'"**
- A `modelMap`, `default`, or `stages` entry is missing the `/`. Convert it to `provider/model` form (e.g. `minimax/MiniMax-M2.7-highspeed`).

**Proxy health check fails in compiled CLI but works from source**
- Run `curl http://localhost:4000/health` to verify the proxy is actually running
- The compiled CLI and source use identical health check code

**Timeout on plan/review stages**
- Proxy-routed models add latency. Plan and review have 10-minute timeouts. If your model is slower, use faster models for those tiers. Stage timeouts are defined in `src/definitions.ts` if you need to adjust them.
