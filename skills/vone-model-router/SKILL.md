---
name: vone-model-router
description: "Selects a model route for a job under strict cost gates: PAID_BLOCKED=INVIOLABLE never lets a paid route run unselected by the owner, and UNKNOWN_COST=HOLD stops the job rather than guess at a route whose state is not freshly known. Use whenever a task needs to pick between local (Ollama) and Cloudflare Workers AI free-tier inference."
version: "1.0.0"
triggers: ["model route", "select route", "which model", "inference backend", "ollama or cloudflare"]
implemented-by: ["src/server/vone_model_router.ts"]
---

# V-ONE Model Router

Route selection order:

1. Read the configured routes and their live state (FREE_AVAILABLE, OFFLINE, STALE).
2. Reject any route in OFFLINE or STALE state outright - it never wins.
3. Reject any route tier other than "free" - PAID_BLOCKED=INVIOLABLE means a
   paid route is never auto-selected, only ever a deliberate, separately
   authorized choice by the owner.
4. Among the remaining eligible free routes, pick by the router's configured
   preference (local Ollama first when a fresh heartbeat proves it eligible,
   otherwise the Cloudflare Workers AI free tier).
5. If no route is eligible, return HOLD with the exact reason (no silent
   fallback to a paid or stale route).

This mirrors VONE_MCP_EVAL_R1 rules 2-4 from the control-plane side: COST,
OFFLINE and LOCAL_TRUTH all apply at the router boundary, not just upstream.
