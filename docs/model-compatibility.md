# Testing LLM Model Compatibility

Kody Engine Lite can route pipeline stages through non-Anthropic models via LiteLLM.
The `test-model` command validates whether a given provider/model works with Claude Code
and Kody's pipeline before you commit to a configuration change.

## Quick Start

```bash
kody test-model --provider gemini --model gemini-2.5-flash --key <GEMINI_API_KEY>
```

## Usage

```
kody test-model --provider <provider> --model <model> --key <api-key> [options]

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

## Prerequisites

- **LiteLLM**: `pip install 'litellm[proxy]'`
- **Claude Code CLI**: `claude` must be in PATH (needed for stage simulation tests)

## What It Tests

### Infrastructure (1 test)
- **extended_thinking** — Does the model support the `thinking` parameter?

### Basic Capabilities (3 tests)
- **simple_prompt** — Can the model respond to a basic prompt?
- **json_output** — Can it follow strict JSON-only output constraints?
- **system_prompt_rules** — Does it follow multiple system prompt rules simultaneously?

### Tool Use (5 tests)
- **tool_read** — Can it call the Read tool with correct arguments?
- **tool_edit** — Can it produce correct Edit tool calls (old_string/new_string)?
- **tool_bash** — Can it invoke Bash with the right command?
- **tool_multi_step** — Can it chain multiple tool calls in sequence? (via Claude CLI)
- **image_attachment** — Can it process base64-encoded images?

### Stage Simulation (3 tests)
- **plan_stage** — Does it produce a structured plan WITHOUT modifying files?
  This is the key instruction-following test. Models that implement code instead of
  planning are not suitable for the plan stage.
- **build_stage** — Can it correctly edit files when asked?
- **review_stage** — Does it produce a structured review WITHOUT modifying files?

### Advanced (2 tests)
- **mcp_tools** — Can it use MCP-provided tools (filesystem server)?
- **error_recovery** — Does it handle tool errors gracefully?

## Accuracy Scoring

Each test returns a 0-100 accuracy score measuring how well the model performed:

| Score | Meaning |
|-------|---------|
| 100   | Perfect — exact expected behavior |
| 70-99 | Good — mostly correct with minor issues |
| 30-69 | Partial — notable issues but partially functional |
| 0-29  | Failed — wrong behavior or no response |

### Accuracy Dimensions

For stage simulation tests, accuracy is weighted across dimensions:

- **Boundary Respect** (60% for plan/review) — Did the model stay read-only?
- **Output Format** (40% for plan/review) — Does output match the required structure?
- **Instruction Compliance** — Did it follow specific rules?
- **Tool Selection** — Did it use the correct tools?

## Interpreting Results

### Fully Compatible (90%+ accuracy, 0 failures)
The model can be used for all pipeline stages.

### Partially Compatible (common case)
Check which stages passed:
- **build** and **review-fix** stages typically work with most models
- **plan** and **taskify** stages require strong instruction following
- **review** stage requires read-only discipline

### Known Provider Quirks

#### Gemini (Google)
- Requires `drop_params: true` in LiteLLM config (Claude Code sends `context_management`)
- Plan stage: tends to implement code instead of outputting a plan
- Vision/image support works well
- Tool use works correctly

#### OpenAI
- **gpt-5.3-codex**: Best OpenAI option — 91% accuracy, all stages pass at 100%,
  perfect instruction following (5/5 rules). No vision. No `drop_params` needed.
- **o3-mini**: Reasoning model — rejects `temperature` param (API tests fail) but all
  CLI/stage tests pass at 100%.
- **gpt-4o-mini**: API tests pass but CLI tests fail — Claude Code's request format
  causes issues through LiteLLM. Not recommended for pipeline stages.

#### MiniMax
- No vision support (text-only models)
- Empty response on exact-echo prompts (simple_prompt fails)
- All stage simulations pass at 100%
- M2.7-highspeed slightly better instruction following than M1-80k

## Recommended Model Per Stage

| Stage | Model | Why |
|---|---|---|
| **taskify** | GPT-5.3 Codex | 100% instruction following, structured output |
| **plan** | Claude Opus | Deep reasoning, can't compromise on planning |
| **build** | Gemini 2.5 Flash | Fast, cheap, 100% build accuracy |
| **review** | Claude Sonnet | Judgment-heavy, read-only discipline |
| **review-fix** | Gemini 2.5 Flash | Execution speed, cheap retries |
| **ship** | Gemini 2.5 Flash | Simple PR creation, doesn't need Claude |

```json
{
  "agent": {
    "stages": {
      "taskify":    { "provider": "openai", "model": "gpt-5.3-codex" },
      "plan":       { "provider": "claude", "model": "claude-opus-4-6" },
      "build":      { "provider": "gemini", "model": "gemini-2.5-flash" },
      "review":     { "provider": "claude", "model": "claude-sonnet-4-6" },
      "review-fix": { "provider": "gemini", "model": "gemini-2.5-flash" },
      "ship":       { "provider": "gemini", "model": "gemini-2.5-flash" }
    }
  }
}
```

## Test Results

### Comparison

|                        | Claude Sonnet 4.6 | Gemini 2.5 Flash | GPT-5.3 Codex | MiniMax M2.7-hs | MiniMax M1-80k | Gemini 3.1 Pro* | OpenAI o3-mini | OpenAI gpt-4o-mini |
|------------------------|-------------------|------------------|---------------|-----------------|----------------|-----------------|----------------|---------------------|
| **Tests run**          | 14/14             | 14/14            | 14/14         | 14/14           | 14/14          | 14/14           | 14/14          | 14/14               |
| **Passed**             | 14                | 13               | 12            | 12              | 11             | 11              | 5              | 7                   |
| **Overall accuracy**   | 99%               | 91%              | 91%           | 84%             | 83%            | 77%             | 41%            | 64%                 |
| **Stage simulation**   | 100%              | 100%             | 100%          | 100%            | 100%           | 100%            | 100%           | 41%                 |
| **Tool use**           | 100%              | 80%              | 80%           | 80%             | 80%            | 80%             | 20%            | 84%                 |
| **Vision**             | YES               | YES              | NO            | NO              | NO             | NO              | NO             | YES                 |
| **drop_params needed** | NO                | YES              | NO            | NO              | NO             | YES             | NO             | NO                  |

*\* Preview model — not GA, may have API quirks*

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
  RECOMMENDATION: Fully compatible -- suitable for all pipeline stages
```

`system_prompt_rules` scored 80% (4/5 rules — Claude Code's own system prompt
slightly influences formatting). All other tests at 100%.

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
  RECOMMENDATION: Suitable for plan, build, review stages
```

All stage simulations pass at 100%. `drop_params: true` is auto-detected and applied.
The `image_attachment` failure was a transient network issue, not a model limitation.

### Gemini 3.1 Pro Preview

Tested: 2026-04-01 | `kody test-model --provider gemini --model gemini-3.1-pro-preview --key <KEY>`

```
  INFRASTRUCTURE

  [+] extended_thinking            PASS   100%  5.2s

  BASIC CAPABILITIES

  [x] simple_prompt                FAIL   0%    2.3s
      Expected KODY_TEST_OK, got empty response
  [x] json_output                  FAIL   0%    3.2s
      Invalid JSON: truncated response
  [+] system_prompt_rules          PASS   80%   10.7s

  TOOL USE

  [+] tool_read                    PASS   100%  7.0s
  [+] tool_edit                    PASS   100%  10.9s
  [+] tool_bash                    PASS   100%  6.0s
  [+] tool_multi_step              PASS   100%  21.4s
  [x] image_attachment             FAIL   0%    0.0s
      No vision support (preview limitation)

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
  RECOMMENDATION: Suitable for plan, build, review stages
```

Preview model — scores lower than GA 2.5 Flash (77% vs 91%). API-level failures
(`simple_prompt`, `json_output`) suggest LiteLLM response translation issues with the
preview API, not model capability problems — all stage simulations pass at 100%.
Slower than 2.5 Flash (~30s per stage vs ~15s). **Use 2.5 Flash instead until 3.1 Pro
reaches GA.**

### OpenAI GPT-5.3 Codex

Tested: 2026-04-01 | `kody test-model --provider openai --model gpt-5.3-codex --key <KEY>`

```
  INFRASTRUCTURE

  [!] extended_thinking            WARN   70%   1.1s
      Response OK but no thinking block

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
      No vision support

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
  RECOMMENDATION: Suitable for plan, build, review stages
```

Strong results — ties with Gemini 2.5 Flash at 91%. Perfect 100% on basic capabilities,
stage simulation, and advanced tests. `system_prompt_rules` scored 100% (5/5 rules).
Only failure is vision (text-only model). No `drop_params` needed.

### MiniMax M1-80k

Tested: 2026-04-01 | `kody test-model --provider minimax --model MiniMax-M1-80k --key <KEY>`

```
  INFRASTRUCTURE

  [+] extended_thinking            PASS   100%  2.9s

  BASIC CAPABILITIES

  [x] simple_prompt                FAIL   0%    4.2s
      Expected KODY_TEST_OK, got empty response
  [+] json_output                  PASS   100%  2.2s
  [!] system_prompt_rules          WARN   60%   7.2s
      3/5 rules followed: no-the, under-50-words, all-lowercase

  TOOL USE

  [+] tool_read                    PASS   100%  6.4s
  [+] tool_edit                    PASS   100%  6.4s
  [+] tool_bash                    PASS   100%  6.2s
  [+] tool_multi_step              PASS   100%  11.9s
  [x] image_attachment             FAIL   0%    0.0s
      No vision support (text-only model)

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
  RECOMMENDATION: Suitable for plan, build, review stages
```

All stage simulations pass at 100%. No vision support. `simple_prompt` fails because
MiniMax returns empty text for exact-echo instructions.

### MiniMax M2.7-highspeed

Tested: 2026-04-01 | `kody test-model --provider minimax --model MiniMax-M2.7-highspeed --key <KEY>`

```
  INFRASTRUCTURE

  [+] extended_thinking            PASS   100%  1.3s

  BASIC CAPABILITIES

  [x] simple_prompt                FAIL   0%    1.7s
      Expected KODY_TEST_OK, got empty response
  [+] json_output                  PASS   100%  2.1s
  [+] system_prompt_rules          PASS   80%   3.7s

  TOOL USE

  [+] tool_read                    PASS   100%  3.2s
  [+] tool_edit                    PASS   100%  4.5s
  [+] tool_bash                    PASS   100%  2.6s
  [+] tool_multi_step              PASS   100%  14.1s
  [x] image_attachment             FAIL   0%    0.0s
      No vision support (text-only model)

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
  RECOMMENDATION: Suitable for plan, build, review stages
```

Slightly better than M1-80k on instruction following (`system_prompt_rules` 80% vs 60%).
Same failure pattern: no vision, empty response on exact-echo prompts. All stage
simulations at 100%.

### OpenAI o3-mini

Tested: 2026-04-01 | `kody test-model --provider openai --model o3-mini --key <KEY>`

```
  INFRASTRUCTURE

  [!] extended_thinking            WARN   70%   1.9s
      Response OK but no thinking block

  BASIC CAPABILITIES

  [x] simple_prompt                FAIL   0%    0.3s
      API error: OpenAI BadRequestError (temperature not supported)
  [x] json_output                  FAIL   0%    0.3s
      API error: OpenAI BadRequestError (temperature not supported)
  [x] system_prompt_rules          FAIL   0%    0.2s
      API error: OpenAI BadRequestError (temperature not supported)

  TOOL USE

  [x] tool_read                    FAIL   0%    1.9s
      API error: OpenAI BadRequestError (temperature not supported)
  [x] tool_edit                    FAIL   0%    0.3s
      API error: OpenAI BadRequestError (temperature not supported)
  [x] tool_bash                    FAIL   0%    0.3s
      API error: OpenAI BadRequestError (temperature not supported)
  [+] tool_multi_step              PASS   100%  37.8s
  [x] image_attachment             FAIL   0%    0.0s
      No vision support

  STAGE SIMULATION

  [+] plan_stage                   PASS   100%  16.4s
  [+] build_stage                  PASS   100%  51.3s
  [+] review_stage                 PASS   100%  20.7s

  ADVANCED

  [+] mcp_tools                    PASS   100%  14.1s
  [x] error_recovery               FAIL   0%    0.3s
      API error: OpenAI BadRequestError (temperature not supported)

  RESULTS: 5/14 PASS | 8 FAIL | 1 WARN
  OVERALL ACCURACY: 41%
  drop_params required: NO
  RECOMMENDATION: Suitable for plan, build, review stages
```

o3-mini is a reasoning model that rejects `temperature` parameter — all direct API tests
fail. However, **all CLI tests pass at 100%** (Claude Code handles the translation).
The 41% accuracy is misleading: through Claude Code (which is how Kody runs), o3-mini
works perfectly for all stage simulations.

### OpenAI gpt-4o-mini

Tested: 2026-04-01 | `kody test-model --provider openai --model gpt-4o-mini --key <KEY>`

```
  INFRASTRUCTURE

  [!] extended_thinking            WARN   50%   0.2s
      Thinking param not supported

  BASIC CAPABILITIES

  [+] simple_prompt                PASS   100%  1.0s
  [+] json_output                  PASS   100%  1.3s
  [+] system_prompt_rules          PASS   100%  1.6s

  TOOL USE

  [+] tool_read                    PASS   100%  3.2s
  [+] tool_edit                    PASS   100%  4.3s
  [+] tool_bash                    PASS   100%  8.4s
  [x] tool_multi_step              FAIL   20%   3.3s
      Claude Code CLI error via LiteLLM
  [+] image_attachment             PASS   100%  1.5s

  STAGE SIMULATION

  [!] plan_stage                   WARN   72%   3.2s
      Output lacks expected ## Step structure
  [x] build_stage                  FAIL   0%    3.4s
      File was not modified as expected
  [!] review_stage                 WARN   50%   3.3s
      No summary/verdict structure, but no files modified

  ADVANCED

  [x] mcp_tools                    FAIL   0%    3.5s
      MCP test failed via CLI
  [x] error_recovery               FAIL   0%    0.0s
      Proxy connection lost

  RESULTS: 7/14 PASS | 4 FAIL | 3 WARN
  OVERALL ACCURACY: 64%
  drop_params required: NO
  RECOMMENDATION: Not recommended for plan, build, review stages
```

Opposite pattern from o3-mini: API tests pass (basic, tool use, vision) but CLI tests
fail. gpt-4o-mini has issues with Claude Code's request format through LiteLLM,
causing stage simulation failures. Not recommended for Kody pipeline stages.

## Configuring a Model After Testing

Once you've verified compatibility, configure the model in `kody.config.json`:

```json
{
  "agent": {
    "stages": {
      "build": { "provider": "gemini", "model": "gemini-2.5-flash" },
      "review-fix": { "provider": "gemini", "model": "gemini-2.5-flash" },
      "plan": { "provider": "claude", "model": "claude-opus-4-6" }
    }
  }
}
```

Set the API key as `ANTHROPIC_COMPATIBLE_API_KEY` in your environment or `.env` file.
The engine auto-starts LiteLLM when any stage uses a non-claude provider.
