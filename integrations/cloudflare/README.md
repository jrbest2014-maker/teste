# V-ONE Workers AI — isolated zero-cost candidate

**Status: HOLD / NOT DEPLOYED.** This is not the V-ONE Master, not an active executor, and does not authorize changing `PAID_BLOCKED`.

## Provider evidence
Cloudflare Workers AI Free: 10,000 Neurons/day; over-limit requests fail rather than bill on Workers Free. GLM-4.7-Flash is listed as eligible on Workers Free.
- https://developers.cloudflare.com/workers-ai/platform/pricing/
- https://developers.cloudflare.com/changelog/post/2026-07-28-models-require-workers-paid/

## Prerequisites before deploying or enabling
1. Verify the **actual account** is Workers Free, not Paid; capture a dated evidence record without exposing tokens.
2. Verify the deployed Worker has AI binding `AI` and the selected model is accessible in the account.
3. Provision `VONE_GATEWAY_TOKEN` as a secret (never commit its value).
4. Keep `VONE_FREE_ONLY=false` and `VONE_ACCOUNT_PLAN=unverified` until checks 1–3 PASS. These variables are only gates; setting them is NOT proof of plan.
5. Verify response parsing, free quota failure handling, and live inference. Ensure no paid fallback or AI Gateway unified paid billing.
6. Add Master-owned route registration/heartbeat/capability and authenticated server-to-server calls from V-ONE Chat. Do not let browser clients call this gateway directly.
7. Run CI and E2E, then seek explicit deployment authorization if credits could be charged.

## Contract
`POST /infer` requires `Authorization: Bearer <secret>` and JSON `{"message":"..."}`. Never log or expose token. `GET /health` returns `UNVERIFIED` regardless of process liveness and is not an inference PASS.

## Deployment guard
`wrangler.jsonc` ships with inference disabled. No production change or live deployment is performed by committing this branch.
