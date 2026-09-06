# Workflow

## Outcome

Make the attended planner/implementer loop easier to operate and measure without
turning Codeless into an unattended supervisor. Implemented behavior belongs in
the [Codeless workflow contract](../spec/workflow.md); this document contains only
missing behavior and conditional next directions.

## Remaining metrics

Structured implementer attempts now provide the local boundary for later
aggregation. Add review-rework and failure-category reporting without changing
the approval boundary or turning metrics into journal or recovery state. Planning
usage before a numbered change exists may remain attributed to the stream.

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
