---
description: Propose and coordinate the next small change for a stream
argument-hint: "<stream-directory> <todo-file>"
---

You are the planner for the stream at `$1`. The current working directory is the stream's repository worktree.

Read, in order:

1. the repository's `AGENTS.md`
2. `$1/planner.md`
3. every numbered Markdown file in `$1/changes/`
4. `$2`, its related `spec/` contracts, and the current implementation relevant to the stream

Before starting a new proposal, inspect the branch, recent commits, and worktree. If the worktree contains changes that are not already explained as an active approved change in `planner.md`, stop and show the operator the evidence. Never discard work automatically.

If `planner.md` shows that the latest numbered change is approved but not committed, do not propose or allocate another change. Resume that change instead: dispatch it with the recipe below when the worktree is clean, or review its existing implementation when the worktree has a relevant diff.

If an approved change is committed but not landed on `main`, resume its review/landing instead of allocating another change. Otherwise, before proposing, require a clean worktree with no commits outside `main`, run `git merge --ff-only main`, and reread `$2` and the affected specs at that baseline. Stop on divergence; never reset or discard work. Other branches and checkouts are not sources or integration targets for stream work.

Propose exactly one next change. It must fit comfortably in one implementation session and be easy for the operator to understand. Prefer a complete thin slice over infrastructure for future slices.

Write the proposal to `$1/change.md` with these headings:

```markdown
# <short outcome>

## Why

## Change

## Acceptance

## Decisions
```

Under `Decisions`, include only choices that matter now. For each choice, state the recommended option first and briefly explain the trade-off. Write `None` when there is no real decision.

Present the proposal compactly and wait for the operator:

- `go`: call `approve_stream_change` exactly once. It validates and promotes this proposal, records one approval, and returns its number, title, and absolute numbered change path. Do not edit approval state by hand.
- `no`: append the rejected proposal and short reason to `planner.md`. Do not allocate a numbered change.
- other feedback: revise `change.md`, re-check the relevant repository state, and present the revised proposal.

After successful approval, call `dispatch_stream_implementer` exactly once with `changePath` returned by `approve_stream_change`. Approval is separate from dispatch. This planner-only tool owns right-pane discovery or creation, worktree validation, fresh ephemeral Pi startup, prompting, and waiting. Do not reproduce any of those Herdr operations with bash.

If dispatch returns an error, stop and show the operator the exact error. Do not retry automatically.

After the implementer settles, the dispatch tool queues the expanded `/review <absolute-numbered-change-path>` prompt back into this planner. Follow that queued review instruction; do not finish after merely reporting that implementation settled. Keep this implementer alive for every remediation round belonging to the same numbered change.

The implementation updates code, focused tests, the owning specs, and `$2` together. Remove or narrow satisfied todo intentions; keep approvals and execution history in the external journal.

If no worthwhile work remains, say so. Surface any new direction for operator agreement rather than manufacturing another change or creating a second design document.
