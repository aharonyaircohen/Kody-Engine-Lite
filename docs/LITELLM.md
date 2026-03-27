# Using Non-Anthropic Models (LiteLLM)

Kody uses Claude Code under the hood, but Claude Code can route API calls through a [LiteLLM](https://litellm.ai/) proxy to use **any LLM**: MiniMax, GPT-4o, Gemini, Llama, local models via Ollama, etc.

## How It Works

1. Kody sets `ANTHROPIC_BASE_URL` to the LiteLLM proxy URL
2. Claude Code sends API calls to the proxy (using Anthropic model names)
3. LiteLLM maps Anthropic model names to your chosen provider
4. LiteLLM translates Anthropic's tool-use protocol to the provider's format
5. No code changes needed — just configuration

> **Important:** Claude Code validates `--model` names client-side — it only accepts Anthropic model names (e.g., `haiku`, `sonnet`, `claude-haiku-4-5-20251001`). The LiteLLM config must use these exact names as `model_name` entries. LiteLLM intercepts the request and routes it to your actual backend.

## Setup

### 1. Create `litellm-config.yaml`

In your project root:

```yaml
model_list:
  # Map Anthropic model IDs to your provider
  - model_name: claude-haiku-4-5-20251001
    litellm_params:
      model: minimax/MiniMax-M2.7-highspeed
      api_key: os.environ/MINIMAX_API_KEY
  - model_name: claude-sonnet-4-6-20250514
    litellm_params:
      model: minimax/MiniMax-M2.7-highspeed
      api_key: os.environ/MINIMAX_API_KEY
  - model_name: claude-opus-4-6-20250514
    litellm_params:
      model: minimax/MiniMax-M2.7-highspeed
      api_key: os.environ/MINIMAX_API_KEY
```

### 2. Add `litellmUrl` to `kody.config.json`

```json
{
  "agent": {
    "litellmUrl": "http://localhost:4000"
  }
}
```

No `modelMap` override needed — Kody uses default Anthropic names which LiteLLM routes to your backend.

### 3. Set API Keys

**Local:** Add to `.env` in your project root:
```
MINIMAX_API_KEY=your-key-here
```

**CI:** Add as a GitHub secret:
```bash
gh secret set MINIMAX_API_KEY --repo owner/repo
```

### 4. CI Workflow

Add to `.github/workflows/kody.yml` before the pipeline step:

```yaml
- name: Install LiteLLM proxy
  if: hashFiles('litellm-config.yaml') != ''
  run: |
    python3 -m venv /tmp/litellm-venv
    /tmp/litellm-venv/bin/pip install 'litellm[proxy]'
    sudo ln -sf /tmp/litellm-venv/bin/litellm /usr/local/bin/litellm

- name: Run Kody pipeline
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    MINIMAX_API_KEY: ${{ secrets.MINIMAX_API_KEY }}
```

> Use a venv to avoid system package conflicts. The symlink makes `litellm` available on PATH for Kody's auto-start.

## Auto-Start

When `litellmUrl` is configured and the proxy isn't already running, Kody automatically:

1. Checks proxy health at the configured URL
2. If not running, looks for `litellm-config.yaml` in the project
3. Detects `litellm` binary (tries `litellm --version`, then `python3 -m litellm --version`)
4. Loads `*_API_KEY` variables from the project's `.env` file into the proxy process
5. Starts the proxy and waits for health check (up to 60 seconds)
6. Falls back to Anthropic models if proxy fails to start

The auto-start loads **only** `*_API_KEY` patterns from `.env` to avoid poisoning the proxy with unrelated variables (e.g., `DATABASE_URL` would trigger Prisma setup in LiteLLM).

## Tested Providers

| Provider | Model | Status |
|----------|-------|--------|
| **MiniMax** | MiniMax-M2.7-highspeed | Full pipeline validated (all 7 stages, autofix, review) |
| **Anthropic** | claude-haiku/sonnet/opus | Default, fully supported |

LiteLLM supports [100+ providers](https://docs.litellm.ai/docs/providers). Any model with tool-use support should work.

## Troubleshooting

**"litellm not installed"**
- Check that `litellm` is on PATH: `litellm --version`
- On CI, the venv install + symlink approach is most reliable

**Proxy starts but agent hangs**
- Check that API keys are available to the proxy process
- Locally: keys must be in `.env` (not just exported in your shell)
- In CI: add keys as env vars in the workflow step

**"Exit code 1" on taskify with no stderr**
- Claude Code likely rejected the model name. Use Anthropic model IDs in litellm-config.yaml (not custom aliases like `minimax-test`)

**Proxy health check fails in compiled CLI but works from source**
- Run `curl http://localhost:4000/health` to verify the proxy is actually running
- The compiled CLI and source use identical health check code

**Timeout on plan/review stages**
- Proxy-routed models add latency. Plan and review have 10-minute timeouts. If your model is slower, increase timeouts in a fork or use faster models for those tiers.
