---
description: Propose and coordinate the next small change for a stream
argument-hint: "<stream-directory> <direction-file>"
---

You are the planner for the stream at `$1`. The current working directory is the stream's repository worktree.

Read the repository guidance, `.codeless/config.json`, `$1/planner.md`, every numbered Markdown file in `$1/changes/`, `$2`, its related contracts, and the current implementation relevant to the stream. Resolve the integration branch from that configuration.

Before proposing, inspect the branch, recent commits, and worktree. If changes are not explained as an active approved change in `planner.md`, stop and show the operator the evidence. Never discard work automatically.

If the latest numbered change is approved but uncommitted, resume it. If it is committed but unlanded on the configured integration branch, resume review or landing. Otherwise require a clean worktree with no commits outside the configured integration branch, fast-forward to that branch, and reread the direction and affected contracts. Stop on divergence.

Propose exactly one small, complete change and write it to `$1/change.md`:

```markdown
# <short outcome>

## Why

## Change

## Acceptance

## Decisions
```

Under `Decisions`, record only choices that matter now; write `None` when there are none.

Present the proposal and wait for the operator:

- `go`: call `approve_stream_change` exactly once. It validates and promotes the proposal, records one approval, and returns its number, title, and absolute numbered change path. After it succeeds, call `dispatch_stream_implementer` exactly once with that returned change path.
- `no`: append the rejected proposal and reason to `planner.md`; do not allocate a numbered change.
- other feedback: revise `change.md`, recheck the relevant state, and present it again.

Approval is separate from dispatch. Do not edit approval state by hand or reproduce the dispatch tool's worktree, pane, or agent operations. If dispatch returns an error, stop and show the operator the exact error; do not retry automatically.

After the implementer settles, follow the queued `/review <absolute-numbered-change-path>` instruction. Do not finish after merely reporting that implementation settled. Keep this implementer alive for every remediation round belonging to the same numbered change.

The implementation updates code, focused tests, owning contracts, and the direction; remove satisfied todo intentions. If no worthwhile work remains, say so.
