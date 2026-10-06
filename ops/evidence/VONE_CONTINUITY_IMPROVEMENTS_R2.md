# V-ONE continuity improvements R2

Date: 2026-10-06, São Paulo.

## Baseline and scope

- Isolated branch: `codex/vone-continuity-improvements-r2`.
- Git baseline: `e3ddb23bc6503e6582f6c7abab9e08b94d471fe4` from the existing local skill-registry worktree. This is the source baseline, not a claim that all production release gates passed.
- Absolute user rule: preserve everything already working; future changes are implementations and improvements.
- The live Control Plane broker, installed operator skill, credential bridge, other worktrees and deployments were preserved.
- The imported broker's original hash and promotion conditions are recorded in `ops/control-plane/README.md`.

## Changes

1. Missing route observations no longer become fresh heartbeats; invalid/future observations are OFFLINE and are not selected by the planner. Missing/invalid database heartbeat values use zero without inventing evidence.
2. The executor capacity validator rejects future route observations with the existing error code, preserving APIs and valid TTL behavior.
3. Skill source, registry and candidate plugin preserve the current AppDeploy ingress, Cloudflare diagnostics, public read-only recovery, local compatibility route, six skills, transport and prompt values. Both plugin manifests use version 1.0.1.

## Verification

- Reproduction: the new heartbeat contract failed against the original broker before the change.
- After change: new heartbeat contract and five unchanged Control Plane regressions passed.
- Existing capacity snapshot, executor and owned-worker tests passed using ts-node with already installed dependencies.
- Targeted strict TypeScript check passed with no output artifacts.
- Plugin structure/preservation/hash validation passed; ZIP and validation report are delivered separately.
- Independent review found a missing public recovery reference in the packaged skill; restored before final packaging.
- Existing bridge is text-identical after newline normalization; it was not modified.
- Commands were lightweight, sequential and BelowNormal; no local model inference or new persistent service was started.

## Release checkout

`PASS_LOCAL_VALIDATION`, `HOLD_PRODUCTION_RELEASE`.

The live Master status reported ACTIVE, R4, revision 87. A read-only MCP client through the existing credential bridge still discovered only `vone_status` and `vone_capacity_plan`; `vone_resume_mission` was not exposed. No protected execution, canonical checkpoint, artifact registration, learning write or production promotion was performed.

Restoring the authenticated protected surface, recording the canonical checkpoint and validating the actual host/deployment smoke are still required before promotion. Runtime behavior of the plugin candidate has not been verified by installation.

## Audited learning

Decision: preserve the working runtime and reconcile source against newer installed contracts instead of running an older synchronization script.

Finding: normalization can manufacture availability evidence when it fills missing heartbeat timestamps with the current time; a truthy fallback can also replace epoch zero.

Correction: preserve absent observations, reject future observations, persist a zero sentinel, and regression-test the complete planner/database path alongside valid capacity behavior.

Outcome: local regressions and preservation checks passed; the production gate remains HOLD until protected continuity and runtime evidence exist. This record is local evidence pending registration in the Master, not a canonical learning/checkpoint write.
