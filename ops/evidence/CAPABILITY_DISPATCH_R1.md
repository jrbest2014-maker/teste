# V-ONE Capability Dispatch R1 — Evidence

Date: 2026-10-04
Baseline commit: a43283e8be7eab51e9307bfc497c1cdfcb023f68
Cloudflare Worker: vone-control-plane
Deployed version: baef91b3-90c1-4da3-b98c-2c7ca5e43d6e

## Change

Worker claim is capability-aware when the worker heartbeat advertises capabilities.
Legacy workers without advertised capabilities retain the existing fallback behavior.

This preserves all validated routes and prevents heterogeneous workers from stealing unsupported jobs.

## Validation

- node --check: PASS
- wrangler deploy --dry-run: PASS
- D1 binding preserved: vone-control-plane
- Workers AI binding preserved: AI
- production deploy: PASS
- V-ONE Master live after deploy: PASS
- YELLOW worker online with capabilities:
  - ask_yellow
  - yellow_route_preview
  - yellow_status
- Native executor online with capabilities:
  - vone_executor_execute
  - vone_inference_execute

### Native executor smoke with YELLOW simultaneously online

- route: OWNED_VONE_EXECUTOR
- execution_status: DONE
- task_id: task_01c42d83-08af-4c3c-8efa-56a20cf15956
- run_id: b20c0809-d61b-4471-98ef-a74b1e67f702
- capacity_selected_route: local-ollama-vone-fallback
- model: v-one-coder:fast
- gates:
  - paid_blocked: INVIOLABLE
  - unknown_cost: HOLD
  - physical_output: LOCKED

### YELLOW-only queue smoke

Diagnostic job: diag_capability_yellow_r1
- tool_name: yellow_status
- status: done
- claimed worker: DESKTOP_445339E_OLLAMA_01
- result backend: ollama
- result model: qwen2.5-coder:3b
- error: null
- diagnostic row consumed after verification

## Partner integration state

- Claude MCP local proxy: Connected
- Claude central HTTP MCP: configured, OAuth pending interactive TTY
- Codex CLI: authenticated using ChatGPT
- Codex MCP v-one stdio proxy: enabled
- No partner route was removed or replaced.

## Rollback

Local pre-change Worker source:
C:\Users\User\V-ONE-CLOUDFLARE-CONTROL\src\index.js.bak-capability-dispatch-r1

## Verdict

CAPABILITY_DISPATCH_R1 = PASS
No evidence, no PASS rule satisfied.
