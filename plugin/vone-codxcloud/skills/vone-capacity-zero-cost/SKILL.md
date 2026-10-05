---
name: vone-capacity-zero-cost
description: Plan and validate V-ONE compute routes under the zero-cost policy. Use when selecting workers/models, evaluating cloud/local availability, handling quota or cost uncertainty, or verifying that paid routes cannot execute.
---

# V-ONE Capacity and Zero-Cost Routing

- Call `vone_capacity_plan` before dispatch when route eligibility is uncertain.
- A route is eligible only when its capability matches and its cost state is verified under V-ONE policy.
- `PAID_BLOCKED` can never win.
- Unknown or unverified cost is `HOLD`, not an invitation to test with live spend.
- Offline/stale workers must not be reported as usable merely because they were registered previously.
- Cloud, desktop and local routes are capacity providers; none of them replaces the Master.
- Prefer reversible, zero-cost alternatives rather than disabling safety gates.
