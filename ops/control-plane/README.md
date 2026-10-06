# Control Plane capacity evidence candidate

This directory versions a candidate copied from the existing local Control Plane. It is not a deployment entrypoint and does not replace the running service.

Source: `V-ONE-CLOUDFLARE-CONTROL/src/capacity-broker.mjs`, inspected on 2026-10-06. Original SHA-256: `1ad83eda7bcd2b67f1e9dd6355a14754a8ba7d8c6edee05a03f38175492c31d7`. The source had no owning Git history in the inspected repository. Five existing offline regression scripts were copied unchanged alongside it.

The candidate preserves valid routes and the existing cost, privacy, quota, ranking, queue, session and verification contracts. Missing heartbeat evidence stays missing, malformed or future observations are OFFLINE, and a missing/invalid database heartbeat uses the existing integer field with zero as a sentinel. Epoch zero is no longer replaced with the current time. The executor's existing capacity validator also rejects future route observations.

## Offline checks

Run each check sequentially with Node; no server, model inference or remote capacity is needed:

```text
node ops/control-plane/test-heartbeat-contract.mjs
node ops/control-plane/test-capacity-broker.mjs
node ops/control-plane/test-capacity-p2.mjs
node ops/control-plane/test-capacity-p3.mjs
node ops/control-plane/test-capacity-p4.mjs
node ops/control-plane/test-capacity-p5.mjs
```

The new contract check failed against the unmodified imported broker (`FREE_AVAILABLE` instead of `OFFLINE`) and passed after the change. Valid fresh observations, the exact TTL boundary, database reconstruction, ranking and the zero sentinel are covered.

## Promotion and rollback

Keep this candidate isolated until the protected Master resume/checkpoint surface and the actual deployment smoke are available. Compare the original source hash immediately before any later integration and reconcile any changes instead of overwriting a newer implementation. Record a new backup/checkpoint and apply only the reviewed timestamp changes through the existing deployment process.

The live local source and installed runtimes were not changed by this candidate. Local review can discard the isolated branch without affecting them. A later deployed release requires its own rollback evidence and E2E gate.
