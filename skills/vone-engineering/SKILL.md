---
name: vone-engineering
description: Execute V-ONE software engineering work with baseline preservation, isolated changes, tests, diffs, rollback and evidence. Use for repository inspection, implementation, debugging, refactoring, build/test work, and executor-driven coding tasks.
---

# V-ONE Engineering

Operate: inspect -> understand -> plan -> checkpoint -> patch -> test -> diff -> verify -> document -> continue.

- Work from the current validated baseline. Do not rewrite working subsystems without a concrete reason.
- Use an isolated branch/worktree when the active tree is dirty or the change is substantial.
- Preserve public APIs and valid contracts unless the requested change explicitly requires a migration.
- Prefer the V-ONE native executor through `vone_delegate_execute` for substantial tasks when it is available.
- Before declaring PASS, record the command/test evidence and verify regressions relevant to the changed scope.
- Keep secrets out of Git, patches, logs and generated artifacts.
- If a tool/security boundary prevents a step, change the mechanism rather than weakening the boundary.
