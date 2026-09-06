# Codeless workflow

Codeless is an attended workflow for delivering independent capability changes
through a project's integration branch. This contract owns the implemented
workflow; the [project guide](../README.md) explains installation, operation,
and reusable execution mechanics. Missing workflow behavior belongs in
[the workflow todo](../todo/workflow.md).

## Stream and change lifecycle

A stream has one lowercase kebab-case slug, one `stream/<slug>` branch and
worktree, one planner, one implementer pane, and at most one approved change in
progress. Work inside a stream is sequential:

1. create or reopen the stream from the configured integration branch;
2. propose one small change and wait for operator approval;
3. preserve the approved proposal as a numbered change;
4. dispatch a fresh implementer, review, and remediate in the same implementer
   session when necessary;
5. create exactly one reviewed commit and land it through the shared integration
   slot; and
6. replace the planner session before proposing another change.

Automated landing updates only the configured integration branch's dedicated
clean checkout. Other branches and checkouts are neither stream sources nor
landing targets. Codeless does not push.

Each project supplies `.codeless/config.json`, a direction at
`todo/<slug>.md`, and `change`, `implement`, `review`, and `commit` prompt
templates. Creation refuses a missing direction or prompt and an existing
stream. Opening requires the existing branch, worktree, journal, proposal file,
direction, and prompts. Both install dependencies before starting the planner.

## Shared local state

Codeless keeps workflow state outside tracked project documents in a shared
workspace selected by the local Git `codeless.workspaceRoot` setting or, by
default, at `.codeless/state/` in the primary checkout. The default directory is
Git-ignored, and every linked worktree resolves the same primary-checkout state:

```text
<primary-checkout>/.codeless/state/
  stream/<slug>/
    planner.md
    change.md
    changes/NNN.md
  worktree/<slug>/
  .land-lock/
  metrics/<slug>/NNN.json
```

`codeless init` is the explicit, idempotent bootstrap for a configured project.
It requires the configured integration branch to exist and creates the shared
state directories plus that branch's worktree only at
`<workspace>/worktree/<integration-branch>`. It reuses only the exact registered
canonical checkout. An occupied target, a branch registered elsewhere, invalid
checkout, or ambiguous Git registration stops unchanged; init never switches
branches, moves worktrees, or repairs conflicts. With the default workspace,
it accepts a repository ignore rule only when it ignores the state path without
covering configuration or configured prompts, otherwise appending the narrow
`/.codeless/state/` rule. An absolute workspace never changes repository
ignores. No other command bootstraps this layout.

`planner.md` owns decisions, approvals, review outcomes, landing history, and
the context needed by a fresh planner. `change.md` is the editable current
proposal. `changes/NNN.md` is the immutable-by-policy approved input to one
implementation loop. These documents are local workflow state, not product
contracts, and are never copied into `spec/`.

After operator `go`, the argument-free planner-only `approve_stream_change` tool
promotes the current proposal before any dispatch. It derives the active planner
session and passes it to the backing CLI, which requires its `<slug>-planner`
identity to match the clean `stream/<slug>` worktree and branch exactly at the
current integration branch. The proposal needs one usable H1 title plus the `Why`, `Change`,
`Acceptance`, and `Decisions` headings; titles must be representable by the
canonical record. The CLI writes `changes/NNN.md` exclusively, where `NNN` is
the successor of the greatest existing three-digit number (and stops after
`999`), then appends a canonical journal approval containing the file, title,
and proposal hash. Repeated calls reconcile that exact file and entry, completing
one missing step without another number; conflicting or ambiguous partial state
stops unchanged. Rejection and ordinary feedback allocate nothing. Dispatch
remains a separate explicit tool call using the returned absolute path.

## Role sessions and configuration

Project configuration selects an exact Pi provider, model, and thinking level
independently for planner and implementer roles.

Before starting either role, Codeless uses Pi's machine-readable APIs to require
the configured model, authentication, supported thinking level, and effective
selection. It fails before agent work rather than accepting a fallback model or
clamped thinking level. The validated selection is displayed and passed to the
role process.

Configuration changes take effect only at a new role-session boundary. An
active review or remediation keeps its implementer setting. A successful
post-landing handoff rereads and validates planner configuration from the
fast-forwarded stream worktree before the replacement session receives its
first project prompt.

Every planner launch—creation, reopening, direct `planner` restart, and
post-landing replacement—uses the package-owned extension as its activation
boundary. Before its first project prompt, activation requires the exact
`<slug>-planner` Pi session name, establishes and verifies Herdr reports
`<slug-with-hyphens-replaced>_planner`, and verifies
`approve_stream_change`, `dispatch_stream_implementer`, and
`next_stream_change` are active. Missing or incompatible activation, identity
mismatch, or an incomplete tool set stops visibly before `/change`. A direct
restart may begin with Herdr's `pi` fallback identity; activation renames and
rereads only that fallback. Any other identity mismatch stops. Implementers use
the corresponding `_impl` and `-impl` forms. The package loads its planner
extension explicitly; global Pi extension installation is not required.

## Dispatch and review

The planner-only `dispatch_stream_implementer` tool accepts an absolute approved
`changes/NNN.md` path. Dispatch verifies the stream branch, clean worktree,
planner pane, prompts, and implementer selection. It creates or reuses the
right-hand Herdr pane only when that pane is an available shell or the expected
idle implementer, starts a fresh ephemeral Pi implementer in the stream
worktree, submits `/implement`, and waits for at most one hour.

Successful dispatch loads the package-owned reporting extension while retaining
`--no-session` and passes its report configuration through that extension's
explicit Pi string flag, then returns one normalized attempt to the planner tool
before it queues the expanded `/review` prompt. Attempts have a stable ID and
capture only stream/change/role, start and settlement timestamps, Pi's actual
settled provider/model/thinking selection, terminal outcome and final text,
full-session Pi input/output/cache usage (including tool results, compaction,
and branch summaries), available Pi model cost estimate with USD currency and
source, and tool/error counts. Cost is omitted when Pi did not supply valid
cost totals. They do not retain prompts, source, credentials, thinking, or a
transcript. The extension writes its narrow report atomically once, then
remains disarmed for remediation; Codeless atomically deduplicates it inside the
per-change metric record, rejecting a
conflicting duplicate ID. Missing, malformed, or unwritable collection warns
and yields an explicitly incomplete attempt when possible without failing or
repeating a settled implementation.

The planner inspects the full diff and relevant code, checks the approved
acceptance criteria, and runs focused checks when the implementation output is
insufficient. Remediation reuses the same implementer context. Once approved,
the planner records the review result, exits the implementer so its pane returns
to a shell, and follows the commit-and-land prompt without another approval
round.

Dispatch and remediation do not retry automatically. Remediation and implementer
shutdown are still performed through prompt-owned Herdr commands.

## Commit and landing

A reviewed change produces exactly one commit outside the merge base with the
configured integration branch. `codeless land <slug>` requires clean stream and integration worktrees,
then atomically acquires the shared `.land-lock` with its owner and captured
integration commit.

If the integration branch advanced, landing rebases the single stream commit. It then rereads and
runs the configured project check in the stream worktree, requires checks to
leave the worktree clean, and fast-forwards the dedicated `main` checkout. Only
successful completion releases the lock.

A lock owned by another stream stops landing without polling. A rebase conflict,
failed check, or other error after acquisition retains this stream's lock for
deliberate recovery. Rerunning landing for the same owner is allowed only while
the recorded integration commit still matches. Codeless never removes a stale or
ambiguous lock automatically.

## Fresh planner handoff

After landing, the planner records the full landed commit hash and calls the
planner-only `next_stream_change` tool exactly once. The handoff requires the
latest numbered change, its full hash in the journal and stream history, no
unlanded stream commit, a clean worktree, and no unresolved lock owned by this
stream or by an unknown owner.

Codeless captures the current integration branch, fast-forwards the stream worktree, validates
the updated direction, prompts, and planner selection, and returns the next
session name and `/change` prompt. The extension replaces the Pi session in the
same pane, preserves its name, activates the validated selection and planner
identity, and only then sends the project prompt. Conversation history is not copied; the journal and
project files carry durable context.

A cancelled or failed replacement stops for operator attention. Landing remains
complete, and any successful preparation fast-forward remains applied. There is
no background retry. The replacement planner still needs a new operator `go`
before another implementation.

## Local workflow metrics

The first dispatch for a stream and numbered change creates one atomic local
metric record. Every accepted dispatch creates a new attempt ID; re-ingesting an
attempt ID is atomic and idempotent, while the original dispatch timestamp stays
unchanged. Successful landing adds its timestamp and commit, or creates a landed
record with unavailable elapsed time when dispatch collection was unavailable.
Collection warnings do not change dispatch or landing outcomes.

`codeless metrics` reports every recorded stream and a project total with:

- landed and dispatched-but-unlanded change counts;
- measured versus unavailable elapsed coverage; and
- total and average dispatch-to-land wall-clock time.

The measurements are prospective, local observations. They are not journal
state, an approval source, or a recovery mechanism. Attempt usage and cost are
stored for later aggregation; `codeless metrics`, review rework, and failure
breakdowns do not yet report them.

## Limits

Codeless is attended and intentionally has no supervisor, project registry,
queue, automatic landing retry, stale-lock recovery, or unattended approval.
Planner startup reads every numbered change, and conflict recovery currently
causes the configured landing check to run twice. Because the default state is
ignored, `git clean -fdx` can delete it.

## References

- Configuration, commands, workspace, and recovery mechanics:
  [project guide](../README.md)
- Runner and metrics implementation:
  [cli.ts](../src/cli.ts) and [metrics.ts](../src/metrics.ts)
- Planner tools and session handoff:
  [planner.js](../extension/planner.js)
- Integration and extension evidence:
  [streams.test.ts](../test/streams.test.ts),
  [metrics.test.ts](../test/metrics.test.ts), and
  [planner.test.ts](../test/planner.test.ts)
