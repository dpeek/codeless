# Workflow

## Outcome

Make the attended planner/implementer loop easier to operate without adding a
supervisor. Implemented behavior belongs in [the workflow contract](../spec/workflow.md).
Everything below is proposed or missing behavior; command names are design
recommendations until implemented.

## Explicit operator synchronization

Add one operator-only `sync` command with explicit direction. Resolve the
integration branch from configuration; `dev` below names the operator branch:

| Proposed command         | Effect                                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `codeless sync from dev` | Fast-forward integration to the captured `dev` commit, then eligible managed streams to that integration commit |
| `codeless sync to dev`   | Fast-forward the registered `dev` checkout to the captured integration commit                                   |

Accept an explicit local operator branch rather than adding a second required
branch setting. Discover registered checkouts through Git; never switch branches,
create missing checkouts, reset, stash, rebase, push, or make merge commits.
This moves committed operator work and already-landed stream work. Unlanded
stream commits must still pass through normal review and landing.

For `sync from`, validate the operator and integration checkouts, clean state,
and ancestry before mutation. Acquire the existing shared landing slot with an
unambiguous operator-sync owner, capture and recheck both heads under the lock,
and fast-forward integration with `git merge --ff-only`. Refuse any existing
landing/recovery lock; sync cannot resume or steal a stream's slot. Operator sync
is explicit integration of operator-reviewed commits and does not pretend those
commits completed the stream review/check lifecycle.

Update only registered Codeless stream worktrees with no unresolved approved
change, no worktree edits or Git operation in progress, and a head that can
fast-forward to the captured integration commit. Require a quiescent planner and
implementer before changing their checkout; clean files alone do not establish
that agents are idle. Use Herdr's process and lifecycle state for this decision,
not correlation with its eventually consistent native-session restore metadata.
Skip active, dirty, diverged, missing, or uncertain streams and report each
reason. A planner with an existing proposal must reread changed
direction/code and refresh the proposal before requesting approval.

For `sync to`, require a clean operator checkout and a fast-forwardable head.
Refuse unresolved integration recovery, capture a stable integration commit,
and leave stream worktrees untouched. Report divergence so the operator can
reconcile it deliberately; the shortcut cannot resolve independently advanced
`dev` and integration histories with a fast-forward.

Report each branch as updated, already current, skipped, or failed. Multiple
worktree updates are not atomic: retain successful fast-forwards, never roll
back, and show exactly what remains. Expected stream skips release the slot;
unexpected failures after mutation retain ownership for deliberate inspection.
Provide a read-only preview using the same eligibility checks. Verify both
directions, custom integration names, busy/approved/dirty/diverged streams,
existing locks, changed heads, and partial failure in self-contained Git tests.

## Reduce the public command surface

Keep operator commands for initialization, stream creation/reopening, sync,
metrics, and deliberate landing recovery. Keep `create` and `open` distinct:
accidental reuse and accidental creation should still fail.

Move `approve`, `dispatch`, `rework`, `finish`, and `next` out of the public CLI
into a package-private runner used by the extension. Preserve one implementation
of each transition and its structured result. Remove the old public routes and
help/documentation entries together; do not add compatibility aliases. An
internal runner is a surface boundary, not a security boundary.

Add planner-only `land_stream_change(changePath)` around the shared landing
implementation. Derive the stream from its verified change and current planner,
return the actual post-rebase commit hash, and make that result the input to
journal recording and `next_stream_change`. Retain `codeless land <slug>` for
operator recovery. A tool call does not itself certify review: establish the
reviewed change association before landing and preserve the one-commit and lock
checks. Keep commit contents/message and review judgment under project guidance.

Keep `/change`, `/implement`, `/review`, and `/commit` as project templates.
Retain package Pi commands where they provide activation, idle-boundary session
replacement, reporting rearm, or graceful shutdown. They currently back tools;
they are not redundant operator features. Use a consistent `codeless-` prefix
for retained internal commands, updating registration, callers, preflight, and
tests together. Inspect installed Pi/Herdr APIs before attempting to hide or
replace these bridges; do not invent a command-visibility API.

A later `prepare_stream_change` tool could own the clean-baseline fast-forward
currently described in `/change`, returning changed files and recovery state.
Keep proposal writing and human approval conversational. Do not add generic Git,
file-editing, review, commit, or cross-stream sync tools without a concrete
workflow invariant for them to own.

## Enforce the active-change boundary

Before broadening synchronization, give completion/active-change state one
canonical workflow owner. Currently `approve` can allocate a different proposal
while the preceding approval remains unimplemented, and `dispatch` accepts a
numbered file without checking its recorded approval hash or latest-change status.
A clean Git worktree does not resolve either ambiguity.

Require approval to reconcile the current change before allocating another.
Require dispatch to match the current approved file, its recorded hash, and the
active planner/stream identity. Associate landing/completion with that exact
change rather than inferring it solely from the greatest numbered filename.
Keep these checks stream-local: integration advancement after planning belongs
to locked landing and must not become an approval prerequisite.
Keep recovery and repeated calls explicit and idempotent. Metrics must remain
optional observations, never the source of approval or completion truth.

Choose the smallest canonical completion record that supports both next-change
validation and sync eligibility; keep narrative decisions in `planner.md`.
Test a second proposal before completion, altered or unapproved input, stale
numbered changes, mismatched identities, and interrupted transition recovery.

## Delivery order and boundaries

Close the active-change/completion gap, then add sync using that same state owner.
The landing tool and public-surface reduction form separate bounded changes;
neither requires a general orchestration framework.

For each implementation, update code, focused tests, README, and the implemented
contract together; remove satisfied intentions from this file. Keep approvals,
numbered changes, and execution history in the shared local workspace.

Preserve attended approval, one active change per stream, the landing lock,
and deliberate recovery. Automatic model routing, budgets, dashboards, remote
telemetry, unattended approval, queues, and background workflow retries remain
outside this direction. Usage and cost totals alone do not establish quality or model
superiority.
