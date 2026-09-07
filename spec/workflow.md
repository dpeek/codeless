# Codeless workflow

Codeless is an attended workflow for delivering independent capability changes through a
project's integration branch. This contract owns the implemented workflow; the [project
guide](../README.md) explains installation, operation, and reusable execution mechanics.
Missing workflow behavior belongs in [the workflow todo](../todo/workflow.md).

## Ownership and lifecycle

Codeless owns reusable execution mechanics and shared local state. Projects own
directions, prompt contents, model choices, and approval/review policy. Pi and Herdr own
their runtime APIs and process behavior.

A stream has one lowercase kebab-case slug, one `stream/<slug>` branch and worktree, one
planner, one implementer pane, and at most one approved change in progress. Work inside
a stream is sequential:

1. create or reopen the stream from the configured integration branch;
2. propose one small change and wait for operator approval;
3. preserve the approved proposal as a numbered change;
4. dispatch a fresh implementer, review, and remediate in the same implementer
   session when necessary;
5. create exactly one reviewed commit and land it through the shared integration
   slot; and
6. replace the planner session before proposing another change.

Automated landing updates only the configured integration branch's dedicated clean
checkout. Other branches and checkouts are neither stream sources nor landing targets.
Codeless does not push.

Each project supplies `.codeless/config.json`, a direction at `<directions>/<slug>.md`, and
`change`, `implement`, `review`, and `commit` prompt templates. Creation refuses a
missing direction or prompt and an existing stream. Opening requires the existing
branch, worktree, journal, proposal file, direction, and prompts. Both install
dependencies before starting a new planner. Reopening a running managed planner
only focuses its workspace and preserves its conversation.

## Command and tool boundaries

The executable currently exposes both operator commands and subprocess entrypoints used
by planner tools:

| Surface                                           | Responsibility                                                                |
| ------------------------------------------------- | ----------------------------------------------------------------------------- |
| `init`, `create`, `open`, `metrics`               | Operator setup, session management, and observation                           |
| `approve`, `dispatch`, `rework`, `finish`, `next` | Backing commands for the corresponding planner tools                          |
| `land`                                            | Commit integration, invoked by the project prompt or operator during recovery |
| `/change`, `/implement`, `/review`, `/commit`     | Project-owned prompt templates                                                |
| `/streams-activate`, `/streams-next`              | Package-owned planner activation and session replacement                      |
| `/codeless-rework`, `/codeless-finish`            | Package-owned commands delivered to the existing implementer                  |

The Pi commands bridge session/process operations. In particular, `next_stream_change`
queues a command so session replacement occurs after the current turn settles. Surface
reductions and additional tools belong in the workflow todo; all backing CLI commands
remain callable today.

## Shared local state

Codeless keeps workflow state outside tracked project documents in a shared workspace
selected by the local Git `codeless.workspaceRoot` setting or, by default, at
`.codeless/state/` in the primary checkout. The default directory is Git-ignored, and
every linked worktree resolves the same primary-checkout state:

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

`codeless init` is the explicit, idempotent bootstrap for a configured project. It
requires the configured integration branch and creates missing copies of the four
package-owned generic prompt starters in the invoking checkout's configured in-project
prompt directory. It validates every template and destination before mutation, reports
each absolute path as created or preserved, and never replaces an existing prompt file.
A non-directory ancestor or non-file prompt collision stops without prompt, state, ignore,
or worktree mutation. Missing prompts are not generated when init is invoked from the
dedicated integration checkout; the operator must initialize from an editable checkout.

Init creates the shared state directories plus that branch's worktree only at
`<workspace>/worktree/<integration-branch>`. It reuses only the exact registered
canonical checkout. An occupied target, a branch registered elsewhere, invalid checkout,
or ambiguous Git registration stops unchanged; init never switches branches, moves
worktrees, or repairs conflicts. With the default workspace, it accepts a repository
ignore rule only when it ignores the state path without covering configuration or
configured prompts, otherwise appending the narrow `/.codeless/state/` rule. An absolute
workspace never changes repository ignores. No other command bootstraps this layout.

`planner.md` owns decisions, approvals, review outcomes, landing history, and the
context needed by a fresh planner. `change.md` is the editable current proposal.
`changes/NNN.md` is the immutable-by-policy approved input to one implementation loop.
These documents are local workflow state, not product contracts, and are never copied
into `spec/`.

After operator `go`, the argument-free planner-only `approve_stream_change` tool
promotes the current proposal before any dispatch. It derives the active planner session
and passes it to the backing CLI, which requires its `<slug>-planner` identity to match
the clean `stream/<slug>` worktree and branch. The stream commit established for
planning is the proposal's base; approval does not compare it with the moving
integration branch. Landing alone acquires the integration lock and rebases that
stream change when integration has advanced. The proposal needs one usable H1 title plus
the `Why`, `Change`, `Acceptance`, and
`Decisions` headings in that order; titles must be representable by the canonical
record. The CLI writes `changes/NNN.md` exclusively, where `NNN` is the successor of the
greatest existing three-digit number (and stops after `999`), then appends a canonical
journal approval containing the file, title, and proposal hash. Repeated calls reconcile
that exact file and entry, completing one missing step without another number;
conflicting or ambiguous partial state stops unchanged. Rejection and ordinary feedback
allocate nothing. Dispatch remains a separate explicit tool call using the returned
absolute path.

## Role sessions and configuration

Project configuration selects an exact Pi provider, model, and thinking level
independently for planner and implementer roles.

Before starting either role, Codeless uses Pi's machine-readable APIs to require the
configured model, authentication, supported thinking level, and effective selection. It
fails before agent work rather than accepting a fallback model or clamped thinking
level. The validated selection is displayed and passed to the role process.

Configuration changes take effect only at a new role-session boundary. An active review
or remediation keeps its implementer setting. A successful post-landing handoff rereads
and validates planner configuration from the fast-forwarded stream worktree before the
replacement session receives its first project prompt.

Every new planner process uses `herdr agent start`, which owns its managed name
and waits for interactive readiness before Codeless sends activation. `open`
reuses the stream workspace and its root planner pane, adding a right-hand shell
only when absent. It accepts only a lone planner pane or a planner with one
right-hand pane. Starting a planner requires both existing panes to be shells in
the stream worktree; occupied, mismatched, or ambiguous layouts stop unchanged.
The operator must invoke opening from outside those target panes. Reopening an
existing managed planner focuses it without installation or another prompt.

The package-owned extension activates creation, reopening, and post-landing
replacement. Before the first project prompt it requires the exact
`<slug>-planner` Pi name, `<slug-with-hyphens-replaced>_planner` Herdr name,
managed interactive readiness, matching foreground worktree, and the current
native Pi session ID/file reported by Herdr's official Pi lifecycle integration.
It verifies `approve_stream_change`, `dispatch_stream_implementer`,
`rework_stream_implementer`, `finish_stream_implementer`, and `next_stream_change`
are active. During replacement, an otherwise-valid previous native session
reference receives a brief bounded synchronization wait; a wrong name, process,
lifecycle source, or worktree fails immediately. Any binding that remains missing
or incompatible stops visibly before `/change`. Activation never repairs names.
The direct `planner` command is removed;
recovery exits Pi deliberately and reopens from another Herdr shell.

Pi session replacement keeps the managed process and Herdr name while changing
its native conversation reference. Codeless revalidates that new binding before
prompting the replacement. Implementers use the corresponding `_impl` and
`-impl` names. Codeless loads its own extension explicitly; Herdr's official Pi
integration supplies lifecycle and native-session reporting. This boundary was
verified against Herdr 0.8.2 and Pi 0.85.1.

## Dispatch and review

The planner-only `dispatch_stream_implementer` tool accepts an absolute approved
`changes/NNN.md` path. Dispatch verifies the stream branch, clean worktree, planner
pane, prompts, and implementer selection. It creates or reuses the right-hand Herdr pane
only when that pane is an available shell or the expected idle implementer, starts a
fresh ephemeral Pi implementer in the stream worktree, submits `/implement`, and waits
for at most one hour.

Successful dispatch loads the package-owned reporting extension while retaining
`--no-session` and passes its report configuration through that extension's explicit Pi
string flag, then returns one normalized attempt to the planner tool before it queues
the expanded `/review` prompt. Attempts have a stable ID and capture only
stream/change/role, start and settlement timestamps, Pi's actual settled
provider/model/thinking selection, terminal outcome and final text, Pi
input/output/cache usage over the collected attempt (including tool results, compaction,
and branch summaries), available Pi model cost estimate with USD currency and source,
and tool/error counts. Cost is omitted when Pi did not supply valid cost totals.
Collection stores final assistant text and aggregate measurements, not a transcript or
separate prompt, source, credential, or thinking fields. Final assistant text is not
redacted. The extension writes its report atomically once, then remains disarmed for
remediation; Codeless atomically deduplicates it inside the per-change metric record,
rejecting a conflicting duplicate ID. Missing, malformed, or unwritable collection warns
and yields an explicitly incomplete attempt when possible without failing or repeating a
settled implementation.

The planner inspects the full diff and relevant code, checks the approved acceptance
criteria, and runs focused checks when the implementation output is insufficient. The
planner-only `rework_stream_implementer` tool accepts that approved path and concise
feedback, verifies the expected idle implementer, its right-hand pane and worktree, then
invokes one package-owned Pi command. That command verifies the immutable startup
stream/change scope, arms package reporting in the existing conversation, and submits
one bounded feedback turn. It records usage from that remediation turn, excluding
earlier conversation entries, and returns one `rework` attempt before queueing review
again; missing or malformed reports warn and yield an incomplete attempt after
settlement. Prompt rejection, timeout, blocked state, identity/worktree/change mismatch,
or ambiguous pane stops without a completed attempt or queued review. The separate
planner-only `finish_stream_implementer` tool first verifies that immutable
stream/change scope in the same idle implementer, then gracefully exits it and waits for
its pane to become the stream-worktree shell. Its failure stops before commit or landing
instructions continue.

Dispatch, remediation, and shutdown do not retry automatically or replace an implementer
session or its selected model.

## Commit and landing

A reviewed change produces exactly one commit outside the merge base with the configured
integration branch. `codeless land <slug>` requires clean stream and integration
worktrees, then atomically acquires the shared `.land-lock` with its owner and captured
integration commit.

If the integration branch advanced, landing rebases the single stream commit. It then
rereads and runs the configured project check in the stream worktree, requires checks to
leave the worktree clean, and fast-forwards the dedicated integration checkout. Only
successful completion releases the lock. Conflict recovery may run focused checks to
validate resolutions, but only `land` runs the configured full check after rebase.

A lock owned by another stream stops landing without polling. A rebase conflict, failed
check, or other error after acquisition retains this stream's lock for deliberate
recovery. Rerunning landing for the same owner is allowed only while the recorded
integration commit still matches. Codeless never removes a stale or ambiguous lock
automatically.

## Fresh planner handoff

After landing, the planner records the full landed commit hash and calls the
planner-only `next_stream_change` tool exactly once. The handoff requires the latest
numbered change, the full landed commit hash in the journal and stream history, no unlanded stream
commit, a clean worktree, and no unresolved lock owned by this stream or by an unknown
owner.

Codeless captures the current integration branch, fast-forwards the stream worktree,
validates the updated direction, prompts, and planner selection, and returns the next
session name and `/change` prompt. The extension replaces the Pi session in the same
pane, preserves its name, activates the validated selection and planner identity, and
only then sends the project prompt. Conversation history is not copied; the journal and
project files carry durable context. The prompt first reads repository guidance, the
journal, and current direction; it stops when work is wholly gated. It reads the latest
numbered change only for active or ambiguous recovery and older changes only for
journal-identified unresolved decisions. Current direction selects candidates before
relevant contracts and implementation are inspected. After a baseline fast-forward, it
rereads current direction plus files affected by incoming commits, affected contracts,
and code, without mining deleted or historical documents for work.

A cancelled or failed replacement stops for operator attention. Landing remains
complete, and any successful preparation fast-forward remains applied. There is no
background retry. The replacement planner still needs a new operator `go` before another
implementation.

## Local workflow metrics

The first dispatch for a stream and numbered change creates one atomic local metric
record. Every accepted dispatch creates a new attempt ID; re-ingesting an attempt ID is
atomic and idempotent, while the original dispatch timestamp stays unchanged. Successful
landing adds its timestamp and commit, or creates a landed record with unavailable
elapsed time when dispatch collection was unavailable. Collection warnings do not change
dispatch or landing outcomes.

`codeless metrics` reports every recorded stream and a project total in two tables. The
elapsed table reports landed and dispatched-but-unlanded change counts, measured versus
unavailable elapsed coverage, and total and average dispatch-to-land wall-clock time.
The attempt table aggregates only validated canonical attempt records and reports
distinct changes with rework, initial and rework turns, incomplete collection, exact
stored terminal-outcome labels, and summed tool errors.

Usage coverage is measured versus unavailable attempts; input, output, cache-read, and
cache-write totals include only attempts with recorded usage. Cost coverage follows the
same rule, and totals are grouped by recorded currency without conversion. Missing usage
or cost is unavailable, never zero. These measurements do not establish implementation
quality or review success. They are prospective local observations, not journal state,
an approval source, or a recovery mechanism.

## Limits

Codeless is attended and intentionally has no supervisor, project registry, queue,
automatic landing retry, stale-lock recovery, or unattended approval. Because the
default state is ignored, `git clean -fdx` can delete it.

The single-active-change rule and the requirement to dispatch only approved input still
partly depend on planner instructions. Approval reconciles records and hashes but does
not require the previous approved change to be complete before allocating a different
proposal. Dispatch requires an existing numbered file, but does not validate its
approval record/hash or require it to be the latest change. These are implementation
gaps, not additional permissions.

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
