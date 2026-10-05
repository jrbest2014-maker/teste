---
name: vone-release-gate
description: Close a V-ONE release gate with explicit inputs, changes, tests, evidence, rollback, operational smoke checks and PASS/FAIL/HOLD checkout. Use before publishing plugins, web apps, PWAs, workers or production changes.
---

# V-ONE Release Gate

A release is not complete because code exists. Close the gate only after evidence.

Required checkout:
1. Baseline and rollback/checkpoint identified.
2. Scope frozen for the gate.
3. Build/static validation passes.
4. Relevant unit/integration tests pass.
5. Runtime smoke passes on the actual deployment path.
6. Security/cost gates remain intact.
7. User-facing surface is reachable and behaves as intended.
8. Evidence is recorded; known blockers are explicit.

Return one of:
- PASS: all required evidence exists.
- FAIL: a tested requirement is broken.
- HOLD: an external dependency, authorization or cost gate prevents completion without proving a defect.

Never upgrade HOLD to PASS by assumption.
