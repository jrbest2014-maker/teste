# V-ONE POWER LADDER R1

Status: candidate implementation validated locally; AppDeploy production promotion pending daily deployment-credit reset.

## Invariants

- Zero-cost is mandatory.
- Paid routes are always BLOCKED.
- Unknown cost is HOLD.
- Unknown capability is HOLD.
- A failover must never select a route below the current capability floor.
- With an explicit current capability, strict failover selects only a strictly stronger route.
- PRIVATE workloads never leave trusted V-ONE/Owned capacity without explicit authorization.
- A provider quota failure changes execution capacity, never the control-plane health.

## Initial ladder

| Route | Model / class | Comparable capability | Cost gate | Role |
| --- | --- | ---: | --- | --- |
| Owned Fabric | active local model | profile/current floor | owned | primary when fresh |
| Cloudflare | Qwen 2.5 Coder 32B | 32B | verified free budget | FAST cloud rung |
| Groq | GPT-OSS 120B | 120B | Free-tier proof required | high-speed external rung |
| OpenRouter | Nemotron 3 Ultra 550B free | 550B | live zero-price model verification | higher-power external rung |

Profile floors: FAST 20B, SMART 70B, MAX 120B.

Examples:
- Current 20B/FAST -> 32B -> 120B -> 550B.
- Current 70B/SMART -> 120B -> 550B.
- Current 120B/MAX -> 550B only. 32B and 120B are rejected as downgrade/equal under strict upgrade.
- If no stronger verified-free route exists -> HOLD.

## Production promotion gate

1. Add secure backend secrets for OpenRouter and Groq; never place keys in code/chat.
2. Verify OpenRouter target model is still zero-price at dispatch time.
3. Verify Groq account is Free tier before enabling automatic dispatch.
4. Extend Capacity Hub planner and Control Plane delegate executor with POWER_LADDER_R1.
5. Run unit tests, build, AppDeploy QA and live E2E.
6. Prove paid_fallback=false and monotonic route evidence in every result.
