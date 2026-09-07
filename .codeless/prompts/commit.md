---
description: Commit one reviewed stream change
argument-hint: "<numbered-change-file>"
---

Commit the reviewed implementation of `$1` on the current stream branch.

Before committing or landing:

- confirm `planner.md` records review approval for this change;
- inspect the complete diff for unrelated edits;
- confirm every acceptance criterion is met;
- run the relevant checks if their passing result is not current;
- determine whether this reviewed change already has its one commit because a previous landing attempt stopped.

If the change is not committed, create exactly one commit. Use an imperative subject that describes the resulting behaviour. Add a short body only for a non-obvious design decision. If the reviewed change already has its one unlanded commit, do not create another.

Derive `<slug>` from the numbered change path and land it with:

```sh
bun ./bin/codeless land <slug>
```

Replace the placeholder with the literal stream slug and do not include angle brackets. This command owns the shared integration lock, rebases the one stream commit when `main` advanced, runs the Codeless checks, and fast-forwards the worktree checked out on `main`. It does not modify other branches or checkouts.

If landing succeeds, append the full commit hash and subject plus a `landed on main` note to the stream's `planner.md`. Include any decisions the next planner needs before resetting the session.

Then call `next_stream_change` exactly once with `changePath` set to the absolute path of `$1` and `landedCommit` set to that full hash. Finish this turn after requesting the handoff. The tool validates the completed landing, fast-forwards the stream to current `main`, and starts a fresh planner session with the project's `/change` prompt. Do not propose the next change in this session or send `/new` through shell keystrokes.

The next planner proposes one change and waits for the operator's `go`; this handoff does not approve further implementation. If no worthwhile work remains, it reports that and stops. If handoff validation fails or the reset is cancelled, stop and report the state; do not retry automatically. Landing remains complete even if the handoff fails.

There are two expected landing stops:

- If another stream owns the integration slot, leave this stream committed where it is, report the owner, and wait. Do not poll, queue, or retry automatically.
- If this stream owns the slot and the rebase conflicts, keep the slot. Resolve the conflicts in this worktree so both current `main` and the approved change are preserved, stage the resolutions, and continue the rebase with `GIT_EDITOR=true git rebase --continue`. Repeat until the rebase completes. Run focused checks when useful to validate a resolution, then run `bun ./bin/codeless land <slug>` again to finish; `land` alone runs the configured full check. The slot prevents another automated landing from moving `main` while you resolve it.

For any other failure while this stream owns the slot, report the exact state and wait for the operator. The slot remains held for deliberate recovery; never remove the workspace's `.land-lock` automatically or on guesswork. See `.codeless/README.md` for workspace configuration and recovery.
