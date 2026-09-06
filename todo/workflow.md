# Workflow

## Outcome

Make the attended planner/implementer loop easier to operate and measure without
turning Codeless into an unattended supervisor. Implemented behavior belongs in
the [Codeless workflow contract](../spec/workflow.md); this document contains only
missing behavior and conditional next directions.

## Project initialization

A newly configured consumer currently has to create its integration worktree by
hand before `codeless create` can run. The failure is safe but leaves routine
local setup outside the tool that owns the workspace layout.

Add `codeless init` as an idempotent bootstrap for an existing configured
project. It should:

- require a valid `.codeless/config.json` and existing configured integration
  branch;
- resolve the primary checkout and selected workspace using the same rules as
  every other command;
- when using the default workspace, ensure `/.codeless/state/` is ignored
  without ignoring tracked configuration or prompts;
- create the local state directories and add the integration worktree at
  `.codeless/state/worktree/<integration-branch>` when that branch is not already
  checked out;
- treat an existing valid integration worktree and ignore rule as success; and
- report the resulting configuration and paths clearly.

Initialization must not create or replace project configuration, prompts, or
directions; move an existing worktree; change branches; overwrite files; or
repair ambiguous Git state. Stop with actionable evidence when the intended path
is occupied or the integration branch is checked out incompatibly. Keep
worktree creation explicit to `init`; ordinary workflow commands should continue
to validate their prerequisites without mutating setup implicitly.

## Structured attempt reports and remaining metrics

The current local metrics cover landed-change counts and dispatch-to-land wall
clock. Dispatch still runs the implementer with `--no-session` and returns
Herdr's command output rather than a stable implementation report, so the
planner cannot reliably see the implementer's final summary or attribute effort
and failures.

Record one structured attempt result with stable retry deduplication and expose
it to the planner after dispatch. Include only the fields needed to answer the
workflow questions:

| Measure               | Required boundary                                                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Role usage            | Report input, output, and cache counters using Pi's own semantics, attributed to stream, change, role, attempt, and the actual model/thinking selection. |
| Cost                  | Preserve a runtime-supplied estimate, currency, and source; never invent prices or present unavailable cost as zero.                                     |
| Implementation result | Preserve timestamps, final implementer report, outcome, and tool-call/error counts without copying prompts, source, credentials, or a full transcript.   |
| Review rework         | Count each request for another implementation pass, not every review message or tool call.                                                               |
| Failed attempts       | Distinguish implementation failure, failed landing checks, rebase conflict, and failed session handoff. Waiting for approval is not failure.             |

Planning usage before a numbered change exists may remain attributed to the
stream rather than an unrelated change. Failed and abandoned attempts must stay
visible. Collection failure should warn and mark data incomplete without
undoing a successful dispatch or landing or causing an agent run to repeat.

Keep records in the shared local Codeless workspace. Journals remain the owner of
decisions and execution history; metrics are not another approval or recovery
state machine. Inspect the installed Pi lifecycle and usage APIs before choosing
collection points because saved transcripts do not cover ephemeral implementers.

## Tool-owned remediation

Review currently sends remediation through a handwritten `herdr agent prompt`
command with Herdr's default wait behavior. This duplicates pane/session
knowledge already owned by dispatch and can time out while the implementer is
still doing useful work.

Add a planner-only remediation tool that accepts the approved change path and
concise feedback, verifies and reuses that change's implementer, waits with the
same bounded long-running policy as dispatch, records one rework attempt, and
queues review again on success. It should return the structured implementer
result and stop visibly on timeout or identity/worktree mismatch. Do not add an
automatic retry loop.

If graceful implementer shutdown continues to require pane/session knowledge,
give that transition the same tool-owned treatment rather than leaving a second
manual Herdr recipe in the review prompt.

## Planner startup efficiency

Fresh planners currently reread every numbered change before deciding whether
work is available. As histories grow, this spends context reconstructing facts
already summarized by the journal and can encourage mining obsolete documents.

Narrow startup reads while preserving recovery:

- read repository guidance, `planner.md`, and the todo first;
- stop early when the todo says all remaining work is gated and there is no new
  operator direction;
- read the latest numbered change when recovering active or ambiguous work;
- read older changes only when the journal points to an unresolved decision;
- inspect related specs and implementation after selecting an ungated candidate;
  and
- after a fast-forward, reread only documents or code affected by the new
  commits.

Do not use deleted or historical documents to manufacture direction when the
current todo and specs are clear.

## Landing recovery efficiency

The conflict-recovery prompt asks the planner to run checks after completing a
rebase and then rerun `codeless land`, which runs the configured checks again.
Let `land` own the post-rebase check unless a future design introduces a
specific, verifiable check attestation. Retain focused checks while resolving a
conflict when they help establish correctness.

## Choosing the next change

Fix planner identity and activation first. Then make dispatch return a structured
attempt report before extending aggregate usage, rework, and failure metrics. Add
remediation after that result boundary exists. Startup and duplicate-check
reductions are smaller independent changes.

Counts and token totals do not establish change quality or model superiority.
Use them alongside review outcomes and the work delivered. Automatic model
routing, budgets, dashboards, remote telemetry, unattended approval, queues,
and background retries remain outside this direction.

## Dependencies and boundaries

- Keep reusable implementation, tests, and execution contracts in this project.
  Model choices, approval policy, and prompts belong to each consuming project.
- Pi and Herdr own their runtime APIs. Verify installed versions before relying
  on new usage, identity, or completion behavior.
- Consumer runtime diagnostics remain separate from Codeless's local workflow
  metrics.
- Preserve the approval boundary, single-change stream invariant, landing lock,
  and deliberate recovery rules while improving the mechanics.

## Keeping this stream useful

For each completed change, update code, focused tests, the project guide, and
[the implemented Codeless contract](../spec/workflow.md) together. Remove the
satisfied intention from this file instead of retaining a current-state recap.
Keep approvals, numbered changes, and execution history in the shared Codeless
workspace rather than either repository document.
