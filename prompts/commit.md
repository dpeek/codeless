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

If the change is not committed, create exactly one commit. Use an imperative subject that describes the resulting behavior. Add a short body only for a non-obvious design decision. If the reviewed change already has its one unlanded commit, do not create another.

Read `.codeless/config.json` to resolve the configured integration branch. Derive `<slug>` from the numbered change path and land it with:

```sh
codeless land <slug>
```

Replace the placeholder with the literal stream slug and do not include angle brackets. This command owns the shared integration lock, rebases the one stream commit when the configured integration branch advanced, runs the configured checks, and fast-forwards the dedicated integration checkout. It does not modify other branches or checkouts.

If landing succeeds, append the full commit hash and subject plus a `landed on <configured-integration-branch>` note to the stream's `planner.md`. Include any decisions the next planner needs before resetting the session.

Then call `next_stream_change` exactly once with `changePath` set to the absolute path of `$1` and `landedCommit` set to that full hash. Finish this turn after requesting the handoff. The tool validates the completed landing, fast-forwards the stream to the current configured integration branch, and starts a fresh planner session with the project's `/change` prompt. Do not propose the next change in this session or send `/new` through shell keystrokes.

The next planner proposes one change and waits for the operator's `go`; this handoff does not approve further implementation. If no worthwhile work remains, it reports that and stops. If handoff validation fails or the reset is cancelled, stop and report the state; do not retry automatically. Landing remains complete even if the handoff fails.

There are two expected landing stops:

- If another stream owns the integration slot, leave this stream committed where it is, report the owner, and wait. Do not poll, queue, or retry automatically.
- If this stream owns the slot and the rebase conflicts, keep the slot. Resolve the conflicts in this worktree so both the current configured integration branch and the approved change are preserved, stage the resolutions, and continue the rebase with `GIT_EDITOR=true git rebase --continue`. Repeat until the rebase completes, run the relevant checks, then run `codeless land <slug>` again to finish. The slot prevents another automated landing from moving the integration branch while you resolve it.

For any other failure while this stream owns the slot, report the exact state and wait for the operator. The slot remains held for deliberate recovery; never remove the workspace's landing lock automatically or on guesswork.
