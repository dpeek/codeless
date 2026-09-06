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

If remediation is required, call `rework_stream_implementer` once with `$1` as `changePath` and a concise actionable `feedback` list. The tool reuses the verified idle implementer, waits for its one feedback turn, returns its rework attempt, and queues review again. Do not reproduce Herdr commands, retry automatically, or ask for unrelated cleanup.

If operator judgment is required, stop and ask one concrete question. If the change is ready:

1. append a compact approval and verification summary to the stream's `planner.md`;
2. call `finish_stream_implementer` once with `$1` as `changePath`; it gracefully exits the verified implementer and confirms its pane returned to the stream shell;
3. only after that tool succeeds, read `.codeless/prompts/commit.md` in the current worktree and immediately carry out its commit-and-land instructions for `$1`; do not wait for another operator command.

Do not finish the implementer before approval because remediation for this numbered change retains its context. If the finish tool fails, stop and report its error.
