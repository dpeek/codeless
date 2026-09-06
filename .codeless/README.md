# Codeless development workflow

Codeless uses its own executable for its attended stream workflow. This
directory owns the project's [configuration](./config.json) and
[agent prompts](./prompts/); [the workflow contract](../spec/workflow.md) owns
implemented behavior and [the workflow todo](../todo/workflow.md) owns remaining
direction.

`main` is the integration branch; keep a dedicated clean worktree on it.
Automated landing updates only the integration checkout. Codeless keeps journals
and worktrees in `.codeless/state/` under this primary checkout. That directory
is ignored; configuration, prompts, and this guide remain tracked. An absolute
local Git `codeless.workspaceRoot` setting can override the default.

## Start and resume

Install dependencies, then run these from a Herdr-managed shell in the intended
Codeless checkout:

```sh
bun install
```

Start or resume a stream with:

```sh
bun ./bin/codeless create workflow
bun ./bin/codeless open workflow
```

Creation requires an existing `todo/<slug>.md` on `main`. From an existing
stream's lone shell, `bun ./bin/codeless planner <slug>` starts Pi in that shell.
The package-owned extension is the activation boundary on creation, reopening,
direct restart, and replacement: it requires `<slug>-planner` in Pi, establishes
and verifies `<slug>_planner` in Herdr, and verifies its planner tools before any
project prompt. Activation failure stops visibly without sending `/change`. The
runner loads prompts from the stream worktree and explicitly loads its own Pi
extension. Planner sessions use `openai-codex/gpt-5.6-sol` at `high` thinking;
implementer sessions use `openai-codex/gpt-5.6-terra` at `medium`. Codeless
validates and displays each exact selection before starting agent work. Planners
reload guidance and prompts when the next loop starts; restart an existing
planner to pick up changes sooner.

The [change prompt](./prompts/change.md) owns proposal and approval instructions.
The planner reads repository guidance, its journal and numbered changes, the
selected todo, related specs, and implementation. Completed streams
fast-forward to `main`; active approved or unlanded changes resume. Unexplained
dirty or diverged work causes a stop rather than being discarded.

After operator approval, the planner calls the tool-owned approval transition
once, then separately dispatches the returned numbered change to an implementer.
[Implementation](./prompts/implement.md) updates code, focused tests, owning
specs, and todo together. [Review](./prompts/review.md) reuses the implementer
for remediation, then follows [commit](./prompts/commit.md).
After a successful landing, the planner records the outcome and full commit hash
in its journal and calls `next_stream_change`. Codeless fast-forwards, rereads and
validates the planner setting from the updated worktree, starts a fresh Pi session
in the same pane, establishes and verifies that setting and planner identity,
and only then sends `/change` to propose
the next small change. Configuration edits do not change an active role session;
review and remediation retain their session's setting. Each new proposal still
waits for `go`. If no worthwhile work remains, the planner stops.
Failed landing, failed handoff validation, or a cancelled reset requires operator
attention and does not automatically start another loop.
Approvals, numbered changes, and execution history remain in the shared local
workspace. `todo/` owns direction; `spec/` owns implemented product contracts.

For execution changes, update source, focused tests, the project guide, the
workflow contract, and the todo together. For workflow policy changes, update
this directory and repository guidance together.

## Land and verify

The commit prompt creates one reviewed change commit, then runs:

```sh
bun ./bin/codeless land <slug>
```

The configured install command is `bun install --frozen-lockfile`; the landing
check is `bun run check`, which checks Codeless. Codeless owns landing safeguards
and recovery behavior.

`bun ./bin/codeless metrics` reports prospective local landed counts and
first-dispatch-to-land wall-clock time. Records live in the shared Codeless
workspace, outside project documents; unavailable elapsed measurements apply to
landed changes, while dispatched-but-unlanded changes remain separate. See the
package guide for the storage and retry boundary.
