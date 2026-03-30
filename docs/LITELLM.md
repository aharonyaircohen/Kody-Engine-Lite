# Using Non-Anthropic Models (LiteLLM)

Kody uses Claude Code under the hood, but Claude Code can route API calls through a [LiteLLM](https://litellm.ai/) proxy to use **any LLM**: MiniMax, GPT-4o, Gemini, Llama, local models via Ollama, etc.

## How It Works

1. Kody sets `ANTHROPIC_BASE_URL` to the LiteLLM proxy URL
2. Claude Code sends API calls to the proxy (using Anthropic model names)
3. LiteLLM maps Anthropic model names to your chosen provider
4. LiteLLM translates Anthropic's tool-use protocol to the provider's format
5. No code changes needed — just configuration

> **Critical:** Claude Code only accepts Anthropic model names (e.g., `haiku`, `sonnet`). When you use LiteLLM, your config must use these same Anthropic names as `model_name` entries. Here's the flow: Kody passes `--model haiku` to Claude Code → Claude Code sends an API call to `localhost:4000` (LiteLLM proxy) → LiteLLM translates the request to your actual provider (e.g., MiniMax) → response comes back in Anthropic format. Claude Code never knows the difference.

## Setup

### Simple: Use the `provider` field (recommended)

Set the `provider` in `kody.config.json` and Kody handles everything — auto-generates the LiteLLM config, starts the proxy, and routes all stages:

```json
{
  "agent": {
    "provider": "minimax"
  }
}
```

Kody auto-generates the LiteLLM routing config mapping all Anthropic model IDs to your provider. No `litellm-config.yaml` needed.

### Advanced: Custom `litellm-config.yaml`

For fine-grained control (different models per tier, custom parameters), create `litellm-config.yaml` in your project root:

```yaml
model_list:
  # Map Anthropic model IDs to your provider
  - model_name: claude-haiku-4-5-20251001
    litellm_params:
      model: minimax/MiniMax-M2.7-highspeed
      api_key: os.environ/ANTHROPIC_COMPATIBLE_API_KEY
  - model_name: claude-sonnet-4-6-20250514
    litellm_params:
      model: minimax/MiniMax-M2.7-highspeed
      api_key: os.environ/ANTHROPIC_COMPATIBLE_API_KEY
  - model_name: claude-opus-4-6-20250514
    litellm_params:
      model: minimax/MiniMax-M2.7-highspeed
      api_key: os.environ/ANTHROPIC_COMPATIBLE_API_KEY
```

When a `litellm-config.yaml` exists, Kody uses it instead of auto-generating config from the `provider` field.

### Set API Keys

**Local:** Add to `.env` in your project root:
```
ANTHROPIC_COMPATIBLE_API_KEY=your-key-here
```

**CI:** Add as a GitHub secret:
```bash
gh secret set ANTHROPIC_COMPATIBLE_API_KEY --repo owner/repo
```

### CI Workflow

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
    ANTHROPIC_COMPATIBLE_API_KEY: ${{ secrets.ANTHROPIC_COMPATIBLE_API_KEY }}
```

> Use a venv to avoid system package conflicts. The symlink makes `litellm` available on PATH for Kody's auto-start.

## Auto-Start

When `provider` is set (or a `litellm-config.yaml` exists) and the proxy isn't already running, Kody automatically:

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

## Common Gotchas

**Model names must be Anthropic IDs.** Claude Code validates `--model` client-side. You can't pass `minimax-test` or `gpt-4o` — Claude Code will reject it silently (exit code 1, no stderr). Always use Anthropic model IDs (`claude-haiku-4-5-20251001`, etc.) in your litellm-config.yaml `model_name` fields. LiteLLM intercepts the API call and routes it.

**Don't use custom model names in `modelMap`.** If you set `modelMap: { cheap: "minimax-test" }`, Kody passes `--model minimax-test` to Claude Code, which rejects it. Keep the defaults (`haiku`/`sonnet`/`opus`) and let LiteLLM handle the routing.

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

**"Exit code 1" on taskify with no stderr**
- Claude Code likely rejected the model name. Use Anthropic model IDs in litellm-config.yaml (not custom aliases like `minimax-test`)

**Proxy health check fails in compiled CLI but works from source**
- Run `curl http://localhost:4000/health` to verify the proxy is actually running
- The compiled CLI and source use identical health check code

**Timeout on plan/review stages**
- Proxy-routed models add latency. Plan and review have 10-minute timeouts. If your model is slower, use faster models for those tiers. Stage timeouts are defined in `src/definitions.ts` if you need to adjust them.
