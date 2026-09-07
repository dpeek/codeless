---
description: Implement one approved stream change
argument-hint: "<numbered-change-file>"
---

You are the implementer. Implement only the approved change in `$1` in the current worktree.

Read the numbered change, repository guidance, and the smallest relevant part of the codebase. Preserve unrelated work.

- Do not edit the planner journal, current proposal, or numbered changes beside `$1`.
- Do not commit, rebase, merge, switch branches, or reset files.
- Update the owning contracts and todo with the implementation.
- Add or update focused tests for changed behavior.
- Run the smallest useful checks.
- If the change cannot be completed safely, stop and explain the blocker with evidence.

When finished, report what changed, checks run and their results, and assumptions or remaining concerns.
