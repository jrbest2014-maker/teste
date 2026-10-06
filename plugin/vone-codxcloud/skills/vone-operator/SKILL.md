---
name: vone-operator
description: Operate the V-ONE control plane as the canonical supervisor for engineering, execution, routing, continuity, evidence and zero-cost policy. Use for substantial V-ONE tasks that require status inspection, delegation, tool use, or cross-runtime coordination.
---

# V-ONE Operator

V-ONE Master is the canonical authority. The current model/runtime is a worker or supervisor, not the source of truth.

## Operating contract
- Inspect current V-ONE state before changing anything.
- Preserve validated routes, APIs, checkpoints and working components.
- Prefer `vone_delegate_execute` for substantial execution and keep the supervising model lightweight.
- Use `vone_status` and `vone_capacity_plan` before choosing a route when execution capacity matters.
- Treat `PAID_BLOCKED` as inviolable and unknown cost as `HOLD`.
- Never claim PASS without observable evidence.
- Never expose credentials or move secrets through chat/browser automation when a runtime security boundary blocks that path.
- When the canonical secure MCP is unavailable, use the public bootstrap only for read-only status/capacity, then fall back to the local V-ONE proxy if appropriate. Do not silently downgrade security or policy.

## Preferred MCP surfaces
1. Canonical ingress: `https://v-one-control-plane-2dahia.v2.appdeploy.ai/mcp`
2. Cloudflare diagnostic/recovery backend: `https://vone-control-plane.vone-technology.workers.dev/mcp` (not the sole ingress)
3. Public bootstrap, read-only status/capacity: `https://vone-control-plane.vone-technology.workers.dev/mcp-public`
4. Local compatibility proxy: configured locally as `v-one`

For code changes, use $vone-engineering. For continuity, use $vone-continuity. For release closure, use $vone-release-gate.
