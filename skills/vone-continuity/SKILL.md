---
name: vone-continuity
description: Resume, checkpoint and preserve V-ONE missions, artifacts and handoffs without restarting completed work. Use when continuing prior work, recovering state, handing work between workers, or recording canonical evidence.
---

# V-ONE Continuity

Use the Master continuity state as canonical.

- Recover with `vone_resume_mission` before restarting work.
- Inspect with `vone_list_missions` and `vone_list_artifacts`.
- Persist meaningful milestones with `vone_checkpoint`.
- Register evidence metadata/hashes with `vone_register_artifact`.
- Do not create checkpoints merely to generate activity; checkpoint after a verified state transition.
- Preserve the gates `PAID_BLOCKED`, unknown-cost `HOLD`, and physical-output lock.
