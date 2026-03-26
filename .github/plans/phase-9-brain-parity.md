# Phase 9 — Brain Server Feature Parity

## Goal
Close the remaining feature gaps between Kody-Brain (as designed in Phase 7) and the existing brain-server implementation at `/Users/aguy/projects/brain/brain-server/`. The existing brain-server is a working system with agent execution, LiteLLM integration, MCP support, token management, deployment scripts, and monitoring. Phase 7 designed a clean API contract — Phase 9 ensures nothing valuable from the existing implementation is lost.

## Prerequisite
Phase 8 complete — Kody-Engine-Lite has feature parity with Kody-Engine.

## Reference codebase
`/Users/aguy/projects/brain/brain-server/` — the existing brain server implementation.

---

## Step 0: Run live gap analysis (MANDATORY before any implementation)

**Do NOT assume the known gaps listed below are complete or current.** The implementer MUST read the actual brain-server codebase and discover gaps themselves.

### Instructions for the implementer

1. **Read every file in the brain-server codebase.** Do not skip files.

   ```
   Existing brain-server:
     /Users/aguy/projects/brain/brain-server/
     ├── brain-agent/
     │   ├── brain-agent.js              — core agent execution
     │   ├── brain-agent-mcp.js          — agent with MCP integration
     │   ├── index.js                    — entry point / HTTP server
     │   └── .env.example                — environment config
     ├── litellm/
     │   └── config.yaml                 — LiteLLM proxy configuration
     ├── skills/
     │   └── claude-delegation/          — delegation skills
     ├── claude-gateway.js               — Claude API gateway/proxy
     ├── dashboard.js                    — monitoring dashboard
     ├── token-manager.js               — API token/key management
     ├── sync-to-ob1.js                 — state sync to external system
     ├── local-mcp-proxy.ts             — local MCP proxy
     ├── watchdog.sh                    — process monitoring
     ├── brain-watchdog.service         — systemd service for watchdog
     ├── brain-env.sh                   — environment setup script
     ├── setup-vps.sh                   — VPS provisioning script
     ├── setup-claude.sh                — Claude Code setup on VPS
     ├── deploy-brain-agent.sh          — deployment automation
     ├── deploy-openclaw.sh             — openclaw deployment
     ├── setup-openclaw.sh              — openclaw setup
     ├── openclaw-compose.yml           — Docker compose for openclaw
     ├── openclaw-standalone.yml        — standalone openclaw config
     ├── openclaw-setup.md              — openclaw documentation
     ├── build-openclaw.md              — build instructions
     ├── test-openclaw.sh               — openclaw tests
     ├── test-sync.js                   — sync tests
     ├── AGENT.md                       — agent documentation
     ├── README.md                      — project documentation
     ├── PLAN-openclaw.md               — openclaw planning doc
     └── PLAN-openclaw-memory.md        — memory system planning doc
   ```

2. **Read each file completely** and understand:
   - What does this file do?
   - What capabilities does it provide?
   - What external systems does it integrate with?
   - What operational patterns does it implement (monitoring, deployment, recovery)?

3. **Compare against Phase 7 Brain design.** Phase 7 specifies:
   - HTTP server with `POST /run/:stage` and `GET /health`
   - Claude Code spawned with read-only tools
   - Own LiteLLM proxy instance
   - Stateless per request
   - Docker deployment

   For each feature in the existing brain-server, check:
   - [ ] Is it covered by the Phase 7 design?
   - [ ] Is it something the Phase 7 Brain should have?
   - [ ] Is it specific to openclaw/ob1 and not relevant to Kody?

4. **Pay special attention to:**

   **`brain-agent/brain-agent.js`** — Core agent execution logic
   - How does it spawn Claude Code?
   - What tools/permissions does it grant?
   - How does it handle timeouts and errors?
   - What context does it inject?
   - Compare with Phase 7's BrainRunner

   **`brain-agent/brain-agent-mcp.js`** — MCP integration
   - What MCP servers does it connect to?
   - What capabilities does MCP add?
   - Is MCP needed for Kody-Brain's read-only analysis?

   **`brain-agent/index.js`** — HTTP server
   - What endpoints exist beyond /run and /health?
   - How does it handle auth?
   - Rate limiting? Request validation?
   - Compare with Phase 7's API contract

   **`claude-gateway.js`** — API gateway
   - What does it proxy?
   - Why is there a separate gateway layer?
   - Does Kody-Brain need this?

   **`token-manager.js`** — Token management
   - How are API keys managed?
   - Key rotation? Multiple keys? Rate limit tracking?
   - Does Kody-Brain need this beyond env vars?

   **`dashboard.js`** — Monitoring
   - What metrics does it track?
   - Is there a health dashboard?
   - Does Kody-Brain need monitoring beyond /health?

   **`litellm/config.yaml`** — Model routing
   - What models are configured?
   - How does it differ from Kody-Engine-Lite's litellm-config.yaml?
   - Fallback patterns? Custom routing rules?

   **`watchdog.sh` + `brain-watchdog.service`** — Process monitoring
   - How does it detect failures?
   - Auto-restart logic?
   - Does Kody-Brain need a watchdog?

   **Deployment scripts** (`setup-vps.sh`, `deploy-brain-agent.sh`, `setup-claude.sh`, `brain-env.sh`)
   - What VPS setup is required?
   - What system dependencies?
   - How is Claude Code installed on the VPS?
   - Compare with Phase 7's Docker deployment

   **`sync-to-ob1.js`** — External sync
   - What does it sync and where?
   - Is this Kody-relevant or ob1-specific?

   **`skills/claude-delegation/`** — Delegation skills
   - What delegation patterns exist?
   - Are these relevant for Kody-Brain's analysis stages?

   **`local-mcp-proxy.ts`** — MCP proxy
   - What does the local proxy do?
   - Is this for development only or production?

5. **Categorize each finding:**
   - **ALREADY IN PHASE 7** — covered by the Phase 7 design
   - **MISSING FROM PHASE 7** — valuable feature that should be added to Kody-Brain
   - **BRAIN-SERVER SPECIFIC** — specific to openclaw/ob1, not relevant to Kody
   - **OPERATIONAL** — deployment/monitoring pattern that should be adopted
   - **DEFERRED** — known gap, not needed now

6. **Write findings to a file:** Create `PHASE-9-BRAIN-GAP-ANALYSIS.md` in the project root with:
   - Date of analysis
   - Per-file analysis (what it does, relevance to Kody-Brain)
   - List of MISSING features with severity (P0/P1/P2)
   - List of OPERATIONAL patterns to adopt
   - Recommended implementation order

7. **Only after the analysis is complete**, implement the MISSING items in priority order.

### Key questions the analysis must answer

1. **Does the existing brain-agent have capabilities beyond what Phase 7 designed?** (e.g., MCP tools, delegation, advanced context management)
2. **Is the token management pattern needed?** (beyond simple env vars)
3. **Is the monitoring/watchdog pattern needed?** (beyond /health endpoint)
4. **Are there deployment patterns we should adopt?** (VPS setup, systemd services, auto-restart)
5. **Is MCP integration valuable for Kody-Brain?** (read-only analysis with MCP tools)
6. **What LiteLLM configuration patterns exist?** (beyond what's in Phase 5)
7. **Are there operational runbooks or recovery procedures?** (not just code)

---

## Known gaps (reference — verify these are still accurate)

### 1. MCP Integration

**brain-server:** `brain-agent-mcp.js` (~34k lines) — agent with MCP server connections for extended tool access.

**Phase 7 Brain:** No MCP. Claude Code spawned with basic read-only tools only.

**Question:** Does Kody-Brain benefit from MCP tools for code analysis? (e.g., database schema reading, API spec parsing, documentation indexing)

### 2. Claude Gateway / API Proxy

**brain-server:** `claude-gateway.js` — proxies/manages Claude API calls.

**Phase 7 Brain:** Calls Claude Code directly as subprocess.

**Question:** Is a gateway needed for rate limiting, key rotation, or request logging?

### 3. Token Management

**brain-server:** `token-manager.js` — manages API tokens/keys.

**Phase 7 Brain:** Uses `ANTHROPIC_API_KEY` env var directly.

**Question:** Does Kody-Brain need multi-key management, rotation, or rate limit tracking?

### 4. Monitoring Dashboard

**brain-server:** `dashboard.js` — monitoring/metrics UI.

**Phase 7 Brain:** Only `/health` endpoint.

**Question:** Does Kody-Brain need request metrics, latency tracking, cost tracking, or error rate dashboards?

### 5. Process Watchdog

**brain-server:** `watchdog.sh` + `brain-watchdog.service` — systemd service that auto-restarts brain on failure.

**Phase 7 Brain:** Docker container (Docker's restart policy handles this).

**Question:** Is Docker restart sufficient, or does the watchdog pattern add value (e.g., health checking, graceful shutdown)?

### 6. VPS Provisioning

**brain-server:** `setup-vps.sh`, `setup-claude.sh`, `brain-env.sh` — automated VPS setup scripts.

**Phase 7 Brain:** Dockerfile only.

**Question:** Should Kody-Brain have provisioning scripts for non-Docker deployments? Or is Docker-only sufficient?

### 7. External State Sync

**brain-server:** `sync-to-ob1.js`, `test-sync.js` — syncs state to external system.

**Phase 7 Brain:** Stateless per request.

**Question:** Is this ob1-specific, or does Kody-Brain need state sync (e.g., memory sync, task history)?

### 8. Skills / Delegation

**brain-server:** `skills/claude-delegation/` — delegation patterns for Claude.

**Phase 7 Brain:** No delegation — single Claude Code call per stage.

**Question:** Does Kody-Brain benefit from delegating sub-tasks (e.g., plan stage delegates to multiple specialized agents)?

### 9. LiteLLM Configuration Differences

**brain-server:** `litellm/config.yaml` — may have different models, routing rules, or fallback patterns.

**Phase 7 Brain:** Uses same LiteLLM config pattern as Kody-Engine-Lite.

**Question:** Are there brain-specific model routing patterns (e.g., cheaper models for taskify, stronger for review)?

---

## Priority framework

### P0 — Required for production Brain deployment
- Any security/auth patterns from brain-server
- Any reliability patterns (watchdog, health checking, graceful shutdown)
- Any token management needed for multi-key scenarios

### P1 — Improves Brain quality
- MCP integration (if analysis stages benefit)
- Monitoring/metrics beyond /health
- Deployment automation

### P2 — Nice to have
- Dashboard
- Skills/delegation patterns
- Advanced LiteLLM routing

### Not applicable
- ob1-specific sync
- openclaw-specific features

## Verification
```bash
# After Phase 9 implementation:

# 1. Brain server has all valuable patterns from brain-server
diff <(grep -r "export\|module.exports" /Users/aguy/projects/brain/brain-server/*.js | grep -oP '\w+(?=\s*[=(])' | sort -u) \
     <(grep -r "export" /path/to/kody-brain/src/*.ts | grep -oP '\w+(?=\s*[=(])' | sort -u)

# 2. Operational features work
curl https://brain.kody.dev/health       # Health check
curl https://brain.kody.dev/metrics      # Metrics (if added)

# 3. Deployment is automated
# Run deployment script → brain updates without downtime

# 4. Monitoring catches failures
# Kill brain process → watchdog restarts → health returns 200 within 30s
```
