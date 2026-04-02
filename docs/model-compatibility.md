# Model Compatibility

Kody's agent runner is Claude Code CLI, which is built for Claude models.
Non-Claude models work through LiteLLM but degrade on complex tasks.

## What works

| Task type | Recommended model | Notes |
|-----------|------------------|-------|
| MCP tools (Playwright, browser) | Claude | Only Claude orchestrates multi-step tool sessions effectively |
| Full pipeline (taskify → ship) | Claude | Only model to complete end-to-end in live tests |
| Simple build / review-fix | Any compatible model | Single-file edits don't need deep tool orchestration |
| Cost-optimized simple stages | Gemini 2.5 Flash, GPT-5.3 Codex | Good for build/review-fix when budget matters |

### Live pipeline test results

Tested with Playwright MCP E2E generation on a Next.js/Payload CMS app:

| Model | Result | Where it failed |
|-------|--------|-----------------|
| MiniMax M2.7-hs | Failed | Invalid taskify JSON, no useful code |
| Gemini 2.5 Flash | Failed | Wrote invalid code, autofix couldn't resolve (3/3 attempts) |
| **Claude Sonnet 4.6** | **Passed** | 3 E2E test files, PR shipped |

**Synthetic test scores don't predict real pipeline success.** All models above pass
stage simulations at 100% in `test-model`, but only Claude succeeds end-to-end.

## Validating a model

```bash
kody test-model --provider gemini --model gemini-2.5-flash --key <GEMINI_API_KEY>
```

```
Options:
  --provider     LLM provider name (e.g. gemini, openai, mistral, groq, deepseek)
  --model        Model identifier (e.g. gemini-2.5-flash, gpt-4o-mini)
  --key          API key for the provider
  --key-env      Read API key from an environment variable instead
  --skip-proxy   Use an already-running LiteLLM proxy (don't start one)
  --litellm-url  LiteLLM proxy URL (default: http://localhost:4099)
  --filter       Comma-separated test names to run (e.g. --filter simple_prompt,plan_stage)
  --list         List all available tests and exit
```

Prerequisites: `pip install 'litellm[proxy]'` and `claude` CLI in PATH.

### What it tests

- **Infrastructure:** extended thinking support
- **Basic capabilities:** prompt response, JSON output, instruction following
- **Tool use:** Read, Edit, Bash, multi-step chaining, image processing
- **Stage simulation:** plan (read-only), build (file edits), review (read-only)
- **Advanced:** MCP tools, error recovery

### Interpreting scores

| Score | Meaning |
|-------|---------|
| 90%+ | Compatible for all stages |
| 70-89% | Compatible for build/review-fix, test plan/review carefully |
| <70% | Not recommended for pipeline stages |

## Configuring a model

```json
{
  "agent": {
    "default": { "provider": "claude", "model": "claude-sonnet-4-6" },
    "stages": {
      "build": { "provider": "gemini", "model": "gemini-2.5-flash" },
      "review-fix": { "provider": "gemini", "model": "gemini-2.5-flash" }
    }
  }
}
```

Set the API key as `<PROVIDER>_API_KEY` (e.g. `GEMINI_API_KEY`) in your environment
or `.env` file. The engine auto-starts LiteLLM when any stage uses a non-claude provider.

### Provider notes

| Provider | Key notes |
|----------|-----------|
| Gemini | Requires `drop_params: true` (auto-applied). Vision works. |
| OpenAI (GPT-5.3 Codex) | Best non-Claude option. 91% accuracy, no `drop_params` needed. |
| OpenAI (o3-mini) | Works via CLI but rejects `temperature` in direct API tests. |
| OpenAI (gpt-4o-mini) | Not recommended — CLI stage tests fail. |
| MiniMax | No vision. Works for build/review-fix. Struggles with structured output. |

## Test results

### Comparison

|                        | Claude Sonnet 4.6 | Gemini 2.5 Flash | GPT-5.3 Codex | MiniMax M2.7-hs | MiniMax M1-80k | Gemini 3.1 Pro* | OpenAI o3-mini | OpenAI gpt-4o-mini |
|------------------------|-------------------|------------------|---------------|-----------------|----------------|-----------------|----------------|---------------------|
| **Passed**             | 14/14             | 13/14            | 12/14         | 12/14           | 11/14          | 11/14           | 5/14           | 7/14                |
| **Overall accuracy**   | 99%               | 91%              | 91%           | 84%             | 83%            | 77%             | 41%            | 64%                 |
| **Stage simulation**   | 100%              | 100%             | 100%          | 100%            | 100%           | 100%            | 100%           | 41%                 |
| **Tool use**           | 100%              | 80%              | 80%           | 80%             | 80%            | 80%             | 20%            | 84%                 |
| **Vision**             | YES               | YES              | NO            | NO              | NO             | NO              | NO             | YES                 |
| **drop_params needed** | NO                | YES              | NO            | NO              | NO             | YES             | NO             | NO                  |
| **Live pipeline**      | PASS              | FAIL             | —             | FAIL            | —              | —               | —              | —                   |

*\* Preview model — not GA*

<details>
<summary>Full test output per model</summary>

### Claude Sonnet 4.6 (baseline)

Tested: 2026-04-01 | `kody test-model --provider claude --model claude-sonnet-4-6`

```
  INFRASTRUCTURE

  [+] extended_thinking            PASS   100%  9.1s

  BASIC CAPABILITIES

  [+] simple_prompt                PASS   100%  6.2s
  [+] json_output                  PASS   100%  5.7s
  [+] system_prompt_rules          PASS   80%   6.5s

  TOOL USE

  [+] tool_read                    PASS   100%  9.3s
  [+] tool_edit                    PASS   100%  12.8s
  [+] tool_bash                    PASS   100%  10.5s
  [+] tool_multi_step              PASS   100%  9.2s
  [+] image_attachment             PASS   100%  8.7s

  STAGE SIMULATION

  [+] plan_stage                   PASS   100%  33.5s
  [+] build_stage                  PASS   100%  14.1s
  [+] review_stage                 PASS   100%  17.0s

  ADVANCED

  [+] mcp_tools                    PASS   100%  16.0s
  [+] error_recovery               PASS   100%  9.0s

  RESULTS: 14/14 PASS | 0 FAIL | 0 WARN
  OVERALL ACCURACY: 99%
  drop_params required: NO
```

### Gemini 2.5 Flash

Tested: 2026-04-01 | `kody test-model --provider gemini --model gemini-2.5-flash --key <KEY>`

```
  INFRASTRUCTURE

  [+] extended_thinking            PASS   100%  3.6s

  BASIC CAPABILITIES

  [+] simple_prompt                PASS   100%  0.9s
  [+] json_output                  PASS   100%  0.8s
  [+] system_prompt_rules          PASS   80%   1.3s

  TOOL USE

  [+] tool_read                    PASS   100%  1.3s
  [+] tool_edit                    PASS   100%  2.1s
  [+] tool_bash                    PASS   100%  1.5s
  [+] tool_multi_step              PASS   100%  11.4s
  [x] image_attachment             FAIL   0%    0.0s
      API error (transient fetch failure)

  STAGE SIMULATION

  [+] plan_stage                   PASS   100%  13.6s
  [+] build_stage                  PASS   100%  18.7s
  [+] review_stage                 PASS   100%  23.0s

  ADVANCED

  [+] mcp_tools                    PASS   100%  13.7s
  [+] error_recovery               PASS   100%  2.1s

  RESULTS: 13/14 PASS | 1 FAIL | 0 WARN
  OVERALL ACCURACY: 91%
  drop_params required: YES
```

### Gemini 3.1 Pro Preview

Tested: 2026-04-01 | `kody test-model --provider gemini --model gemini-3.1-pro-preview --key <KEY>`

```
  INFRASTRUCTURE

  [+] extended_thinking            PASS   100%  5.2s

  BASIC CAPABILITIES

  [x] simple_prompt                FAIL   0%    2.3s
  [x] json_output                  FAIL   0%    3.2s
  [+] system_prompt_rules          PASS   80%   10.7s

  TOOL USE

  [+] tool_read                    PASS   100%  7.0s
  [+] tool_edit                    PASS   100%  10.9s
  [+] tool_bash                    PASS   100%  6.0s
  [+] tool_multi_step              PASS   100%  21.4s
  [x] image_attachment             FAIL   0%    0.0s

  STAGE SIMULATION

  [+] plan_stage                   PASS   100%  27.2s
  [+] build_stage                  PASS   100%  30.9s
  [+] review_stage                 PASS   100%  30.3s

  ADVANCED

  [+] mcp_tools                    PASS   100%  17.7s
  [+] error_recovery               PASS   100%  5.2s

  RESULTS: 11/14 PASS | 3 FAIL | 0 WARN
  OVERALL ACCURACY: 77%
  drop_params required: YES
```

### OpenAI GPT-5.3 Codex

Tested: 2026-04-01 | `kody test-model --provider openai --model gpt-5.3-codex --key <KEY>`

```
  INFRASTRUCTURE

  [!] extended_thinking            WARN   70%   1.1s

  BASIC CAPABILITIES

  [+] simple_prompt                PASS   100%  1.0s
  [+] json_output                  PASS   100%  1.1s
  [+] system_prompt_rules          PASS   100%  1.8s

  TOOL USE

  [+] tool_read                    PASS   100%  2.3s
  [+] tool_edit                    PASS   100%  3.7s
  [+] tool_bash                    PASS   100%  2.4s
  [+] tool_multi_step              PASS   100%  12.2s
  [x] image_attachment             FAIL   0%    0.0s

  STAGE SIMULATION

  [+] plan_stage                   PASS   100%  45.7s
  [+] build_stage                  PASS   100%  27.5s
  [+] review_stage                 PASS   100%  28.2s

  ADVANCED

  [+] mcp_tools                    PASS   100%  13.1s
  [+] error_recovery               PASS   100%  2.8s

  RESULTS: 12/14 PASS | 1 FAIL | 1 WARN
  OVERALL ACCURACY: 91%
  drop_params required: NO
```

### MiniMax M2.7-highspeed

Tested: 2026-04-01 | `kody test-model --provider minimax --model MiniMax-M2.7-highspeed --key <KEY>`

```
  INFRASTRUCTURE

  [+] extended_thinking            PASS   100%  1.3s

  BASIC CAPABILITIES

  [x] simple_prompt                FAIL   0%    1.7s
  [+] json_output                  PASS   100%  2.1s
  [+] system_prompt_rules          PASS   80%   3.7s

  TOOL USE

  [+] tool_read                    PASS   100%  3.2s
  [+] tool_edit                    PASS   100%  4.5s
  [+] tool_bash                    PASS   100%  2.6s
  [+] tool_multi_step              PASS   100%  14.1s
  [x] image_attachment             FAIL   0%    0.0s

  STAGE SIMULATION

  [+] plan_stage                   PASS   100%  37.8s
  [+] build_stage                  PASS   100%  13.1s
  [+] review_stage                 PASS   100%  19.6s

  ADVANCED

  [+] mcp_tools                    PASS   100%  11.2s
  [+] error_recovery               PASS   100%  2.7s

  RESULTS: 12/14 PASS | 2 FAIL | 0 WARN
  OVERALL ACCURACY: 84%
  drop_params required: NO
```

### MiniMax M1-80k

Tested: 2026-04-01 | `kody test-model --provider minimax --model MiniMax-M1-80k --key <KEY>`

```
  INFRASTRUCTURE

  [+] extended_thinking            PASS   100%  2.9s

  BASIC CAPABILITIES

  [x] simple_prompt                FAIL   0%    4.2s
  [+] json_output                  PASS   100%  2.2s
  [!] system_prompt_rules          WARN   60%   7.2s

  TOOL USE

  [+] tool_read                    PASS   100%  6.4s
  [+] tool_edit                    PASS   100%  6.4s
  [+] tool_bash                    PASS   100%  6.2s
  [+] tool_multi_step              PASS   100%  11.9s
  [x] image_attachment             FAIL   0%    0.0s

  STAGE SIMULATION

  [+] plan_stage                   PASS   100%  36.6s
  [+] build_stage                  PASS   100%  15.9s
  [+] review_stage                 PASS   100%  20.9s

  ADVANCED

  [+] mcp_tools                    PASS   100%  11.1s
  [+] error_recovery               PASS   100%  4.1s

  RESULTS: 11/14 PASS | 2 FAIL | 1 WARN
  OVERALL ACCURACY: 83%
  drop_params required: NO
```

### OpenAI o3-mini

Tested: 2026-04-01 | `kody test-model --provider openai --model o3-mini --key <KEY>`

```
  INFRASTRUCTURE

  [!] extended_thinking            WARN   70%   1.9s

  BASIC CAPABILITIES

  [x] simple_prompt                FAIL   0%    0.3s
  [x] json_output                  FAIL   0%    0.3s
  [x] system_prompt_rules          FAIL   0%    0.2s

  TOOL USE

  [x] tool_read                    FAIL   0%    1.9s
  [x] tool_edit                    FAIL   0%    0.3s
  [x] tool_bash                    FAIL   0%    0.3s
  [+] tool_multi_step              PASS   100%  37.8s
  [x] image_attachment             FAIL   0%    0.0s

  STAGE SIMULATION

  [+] plan_stage                   PASS   100%  16.4s
  [+] build_stage                  PASS   100%  51.3s
  [+] review_stage                 PASS   100%  20.7s

  ADVANCED

  [+] mcp_tools                    PASS   100%  14.1s
  [x] error_recovery               FAIL   0%    0.3s

  RESULTS: 5/14 PASS | 8 FAIL | 1 WARN
  OVERALL ACCURACY: 41%
  drop_params required: NO
```

Note: o3-mini rejects `temperature` param — API tests fail but all CLI stage tests pass at 100%.

### OpenAI gpt-4o-mini

Tested: 2026-04-01 | `kody test-model --provider openai --model gpt-4o-mini --key <KEY>`

```
  INFRASTRUCTURE

  [!] extended_thinking            WARN   50%   0.2s

  BASIC CAPABILITIES

  [+] simple_prompt                PASS   100%  1.0s
  [+] json_output                  PASS   100%  1.3s
  [+] system_prompt_rules          PASS   100%  1.6s

  TOOL USE

  [+] tool_read                    PASS   100%  3.2s
  [+] tool_edit                    PASS   100%  4.3s
  [+] tool_bash                    PASS   100%  8.4s
  [x] tool_multi_step              FAIL   20%   3.3s
  [+] image_attachment             PASS   100%  1.5s

  STAGE SIMULATION

  [!] plan_stage                   WARN   72%   3.2s
  [x] build_stage                  FAIL   0%    3.4s
  [!] review_stage                 WARN   50%   3.3s

  ADVANCED

  [x] mcp_tools                    FAIL   0%    3.5s
  [x] error_recovery               FAIL   0%    0.0s

  RESULTS: 7/14 PASS | 4 FAIL | 3 WARN
  OVERALL ACCURACY: 64%
  drop_params required: NO
```

Not recommended — CLI stage tests fail through LiteLLM.

</details>
