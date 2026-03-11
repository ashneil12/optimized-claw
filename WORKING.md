# WORKING.md

> This file tracks your current task state and open loops. Read it first on wake, update it before compaction.

## Current Task

[What you're actively working on — one sentence]

## Status

[Where you are — what's done, what's pending]

## Next Steps

1. [Immediate next action]
2. [Following action]
3. [After that]

## Blockers

- [Anything preventing progress, or "None"]

## Open Loops

> Things to follow up on. Review during heartbeat.

- [ ] [Example: Check if deployment succeeded — added DATE]

**Rules (ENFORCED — not guidelines):**

- **When you finish a task, mark it `[x]` immediately.** Do not leave completed work as `[ ]`. The pruner reads `[x]` to archive completed items.
- **Every open loop MUST include `— added YYYY-MM-DD`** so the pruner can detect and evict stale items after 7 days. Example: `- [ ] Confirm Stripe webhook is live — added 2026-03-11`
- **Add loops when you say "I'll check on this later"** or when waiting for external response.
- **Review during heartbeat** — close loops you can verify, escalate ones that are blocked.
- Loops without a date annotation will never be auto-evicted. Add the date or they stay forever.

---

Last updated: [timestamp]
