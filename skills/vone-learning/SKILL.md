---
name: vone-learning
description: Record and retrieve audited V-ONE operational learning from decisions, outcomes, corrections and evidence. Use after meaningful execution outcomes, regressions, fixes or architecture decisions that should survive across agents and runtimes.
---

# V-ONE Operational Learning

- Read prior learning with `vone_learning_summary` when it can materially prevent repeated mistakes.
- Record only meaningful, evidence-backed events with `vone_learning_record`.
- Learning is operational memory; it does not change model weights.
- Distinguish decision, outcome and correction.
- Reference checkpoint/artifact hashes when available.
- Do not store credentials, raw secrets or unnecessary personal data.
