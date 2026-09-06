---
description: Review the worktree against one approved stream change
argument-hint: "<numbered-change-file>"
---

You are the planner reviewing the implementation of `$1`.

Read the approved change and repository guidance. Inspect the complete worktree diff and relevant surrounding code. Review for:

1. correctness and regressions;
2. unmet acceptance criteria;
3. missing or weak tests;
4. accidental scope growth;
5. inconsistency with the repository's domain model and style.

Run focused checks when the implementation report is insufficient evidence.

If remediation is required, give the `<slug>_impl` Herdr agent a short, actionable list that references `$1`, then wait for it to settle and review again. Send the feedback as one quoted argument:

```sh
herdr agent prompt <slug>_impl "Review feedback for $1: <concise-actionable-feedback>" --wait
```

Replace both placeholders. Do not ask for cleanup that is unrelated to the approved change.

If operator judgment is required, stop and ask one concrete question. If the change is ready:

1. append a compact approval and verification summary to the stream's `planner.md`;
2. after the implementer is idle, execute `herdr agent send-keys <slug>_impl ctrl+d` so Pi exits and the right pane returns to its shell;
3. read `.codeless/prompts/commit.md` in the current worktree and immediately carry out its commit-and-land instructions for `$1`; do not wait for another operator command.

Do not exit the implementer before approval because remediation for this numbered change should retain its context. If graceful exit does not return the pane to a shell, stop and report the observed state.
