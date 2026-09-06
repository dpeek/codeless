# Codeless

Codeless is an attended workflow for parallel capability development. Each stream has one
branch/worktree, one planner, an implementer shell, and at most one approved
change. Work within a stream is sequential: propose, approve, implement, review,
commit, land.

This project owns the executable, Pi extension, Git/Herdr mechanics, and tests.
Project instructions and prompts belong to the consuming project. The package
has its own dependencies, TypeScript configuration, and checks; it imports no
consumer application code. Its tests use independent temporary repositories.

## Installation

Codeless requires Bun, Git, Herdr, and Pi. The scoped package is configured for
public npm access. Once published, install it with either package manager:

```sh
bun add --global @dpeek/codeless
# or
npm install --global @dpeek/codeless
```

The package installs the `codeless` executable:

```sh
codeless --help
```

The implemented workflow contract is in [spec/workflow.md](./spec/workflow.md).
Proposed and missing behavior is kept in [todo/workflow.md](./todo/workflow.md).

## Project configuration

Run `codeless` inside the intended Git checkout. The runner discovers the project
from the current working directory, including when invoked from a subdirectory
or through a linked executable. Its installation location does not select the
project. Help also works outside a repository.

Each project commits `.codeless/config.json`:

```json
{
  "integrationBranch": "main",
  "directions": "todo",
  "prompts": ".codeless/prompts",
  "install": ["bun", "install", "--frozen-lockfile"],
  "check": ["bun", "run", "check"],
  "planner": {
    "provider": "openai-codex",
    "model": "gpt-5.6-sol",
    "thinking": "high"
  },
  "implementer": {
    "provider": "openai-codex",
    "model": "gpt-5.6-terra",
    "thinking": "medium"
  }
}
```

All fields are required. Directory paths are relative to the checkout and must
stay within it. Commands are nonempty argument arrays, executed in the target
worktree without shell interpolation. Each role requires an exact Pi provider
and model ID plus one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or
`max`. Configuration is trusted project code.

Before a role session starts, Codeless launches a short-lived, promptless Pi RPC
process in the target worktree. It requires the exact provider/model in Pi's
available-model response, selects it, requires the configured level in that
model's available-thinking response, and verifies the resulting state. Failure
identifies the role and requested selection; Codeless does not start agent work
with Pi's fallback model or a clamped thinking level. Successful launch output
shows the effective role selection, and the Pi process receives the same exact
model and level.

The invoking checkout selects the integration branch. Keep that setting aligned
across participating worktrees. The runner discovers its checkout from Git's
worktree list. Directions, prompts, and install commands come from the target
worktree; landing reads the check command after rebasing. Creating a stream
first verifies its direction and prompts in the integration checkout.

## Project prompt contract

The configured prompt directory provides `change.md`, `implement.md`,
`review.md`, and `commit.md`, using Pi prompt-template syntax. The runner supplies:

- `/change <stream-directory> <direction-file>` to the planner;
- `/implement <numbered-change-file>` to the implementer;
- `/review <numbered-change-file>` to the planner after successful dispatch.

Path arguments are JSON-quoted. Each direction is `<directions>/<slug>.md`.
The project owns prompt contents, approval rules, review criteria, and the
transition from review to commit. Required prompts and directions must exist;
the runner does not generate or copy project instructions.

The package-owned planner extension activates every planner session. Before its
first project prompt, it requires the exact `<slug>-planner` Pi name, establishes
and verifies the `<slug>_planner` Herdr identity, and confirms `approve_stream_change`,
`dispatch_stream_implementer`, and `next_stream_change` are active. Missing or
incompatible activation, identity mismatch, or inactive tools stops before
`/change`; global Pi extension installation is unnecessary.
The approval tool has no arguments. Its extension derives the active
`<slug>-planner` Pi session and passes it to the backing CLI, which requires it
to match the worktree and branch. The CLI validates the clean current-integration
baseline and proposal, exclusively creates the next monotonic `changes/NNN.md`,
and records one hash-backed journal approval. Exact retries reconcile a missing
file or journal step; conflicting state stops. Approval returns the numbered path
but does not dispatch it. Dispatch uses the package executable, inherits the
planner's worktree, and queues review only on success. Pi loads the extension
explicitly at planner launch.

After landing and recording the full landed commit hash in `planner.md`, the
project's commit prompt calls `next_stream_change` with the completed
`changePath` and `landedCommit`. The tool requests `/streams-next`, an extension
command that waits for the current turn to settle, prepares the next loop, and
replaces the Pi session in the same pane. It preserves the planner name, applies
the planner selection read and validated after the stream fast-forwards to the
captured integration commit, then activates and verifies the replacement before
sending `/change` after resources reload. The previous conversation is not copied; the
journal and project files carry context.

This uses Pi's `newSession({ setup, withSession })` command API, verified with
Pi 0.84.3. Only the replacement context activates the selection and sends the
new prompt. Configuration changes take effect at the next role-session boundary,
not during an active planner or implementer. Review and remediation therefore
continue with their existing session's selection. Duplicate requests
while a handoff is pending are rejected. Ordinary session startup, waiting for
approval, failed validation, and cancelled replacement do not schedule another
loop. The project prompt still owns approval and stopping when no work remains.

## Shared local state

Worktrees, proposals, numbered changes, and journals live in one shared local
workspace. By default it is `.codeless/state/` in the primary checkout. That
directory is Git-ignored while `.codeless/config.json`, prompts, and guidance
remain tracked. Every linked worktree resolves the same primary-checkout state.

To put the state elsewhere, configure an absolute path once from any checkout:

```sh
git config --local codeless.workspaceRoot /absolute/path/to/workspace
```

This local Git setting is shared by all worktrees. Keep the path stable while
planners or worktree shells are running.

```text
<primary-checkout>/.codeless/state/
  stream/<slug>/
    planner.md        # decisions and outcomes
    change.md         # editable current proposal
    changes/NNN.md    # approved proposals
  worktree/<slug>/    # stream/<slug> branch
  worktree/main/      # example integration checkout location
  .land-lock/         # shared landing owner and recorded integration commit
  metrics/<slug>/NNN.json # first dispatch, landing time, and landed commit
```

Normal `git clean -fd` preserves ignored state. `git clean -fdx` removes ignored
files and can therefore destroy local Codeless journals, metrics, and worktrees;
inspect its targets before using it.

## Commands

Run creation, opening, and planner launch from a Herdr-managed shell. Landing
needs no Herdr session.

```sh
codeless create <slug>
codeless open <slug>
codeless planner <slug>
codeless approve <planner-session>
codeless dispatch <numbered-change-file>
codeless land <slug>
codeless next <numbered-change-file> <landed-commit>
codeless metrics
```

Slugs are lowercase kebab-case, at most 24 characters. `create` starts
`stream/<slug>` from the integration branch and creates its local documents;
it refuses existing streams. `open` resumes a stream. Both run the configured
install command, then validate and open a planner beside an idle shell. `planner`
starts Pi in an existing stream's lone shell after the same role preflight. Its
activation establishes the same identity as creation and reopening.
Dispatch validates the implementer selection before touching the planner's
right-hand pane, starts a fresh ephemeral implementer, and waits for completion.

The first valid dispatch creates one atomic local JSON metric record for its
stream and numbered change. Retries preserve its original dispatch time. After a
successful integration fast-forward, Codeless records the landed time and commit
on that change's canonical record, creating a landed record without elapsed time
when dispatch collection was unavailable; collection warnings never alter
dispatch or landing.
`codeless metrics` prints every recorded stream and a project total. Its elapsed
columns are dispatch-to-land wall-clock time; among landed changes, records
without a measured duration are explicitly unavailable. Dispatched-but-unlanded
changes remain a separate count. Metrics are prospective local observations, not
journal state or a recovery mechanism.

Landing requires clean stream and integration worktrees and exactly one stream
commit outside their merge base. It acquires `.land-lock` atomically, recording
the owner and integration commit. It rebases if necessary, runs the configured
check command, requires the checked worktree to remain clean, and fast-forwards
the integration checkout. Success releases the lock. Other branches and
checkouts are untouched; no push is performed.

Another lock owner causes a stop, without queuing or polling. Rebase conflicts
or failed checks retain ownership. Resolve the existing failure, then rerun
`land`; it verifies the recorded integration commit has not changed. To abandon
a landing, inspect the owner/base and Git state before manually removing the
lock. There is no automatic stale-lock removal or retry.

`next` is the session handoff's preparation command. It requires the stream's
own clean worktree and latest numbered change, a full commit hash present in its
journal, that commit in the stream's history, and all stream commits included
in the configured integration branch. A landing lock owned by this stream or
with an unknown owner stops preparation; another stream's lock does not block
planning. It fast-forwards to a captured integration commit, verifies project
prompts, direction, and planner selection, and returns JSON containing
`sessionName`, `prompt`, and the validated `selection`. It does not modify
journals, allocate a change, approve implementation, or
control Pi itself. Preparation can be repeated safely after inspecting a failure.

If validation or session replacement fails, the planner stops for operator
attention. Landing is already complete, and any preparation fast-forward remains
applied. There is no background retry; restarting the planner recovers from the
journal and Git state.

## Package development

From this package directory, run `bun run check` for formatting, lint, types,
and tests, or `bun run test` for tests alone. The integration tests use real Git
worktrees and mock Herdr/Pi commands; they never launch actual agents.

`npm publish` runs the full check through `prepublishOnly` and publishes
`@dpeek/codeless` with public access.

Keep source, tests, executable, extension, and dependencies inside this project.
Keep project policies and real prompts outside it. Add automation only for
concrete needs; this package has no supervisor, project registry, queue, or
automatic recovery service.
