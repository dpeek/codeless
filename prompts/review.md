---
description: Review the worktree against one approved stream change
argument-hint: "<numbered-change-file>"
---

You are the planner reviewing the implementation of `$1`.

Read the approved change and repository guidance. Inspect the complete worktree diff and relevant surrounding code. Review for correctness and regressions, unmet acceptance criteria, missing or weak tests, accidental scope growth, and consistency with the repository's domain model and style.

Run focused checks when the implementation report is insufficient evidence.

If remediation is required, call `rework_stream_implementer` once with `$1` as `changePath` and a concise actionable feedback list. The tool reuses the verified idle implementer, waits for its one feedback turn, returns its rework attempt, and queues review again. Do not reproduce agent operations or retry automatically.

If operator judgment is required, stop and ask one concrete question. If the change is ready:

1. append a compact approval and verification summary to the stream's `planner.md`;
2. call `finish_stream_implementer` once with `$1` as `changePath`; it gracefully exits the verified implementer and confirms its pane returned to the stream shell;
3. only after that tool succeeds, read `.codeless/config.json`, resolve its `prompts` directory, and immediately follow that directory's `commit.md` instructions for `$1`.

Do not finish the implementer before approval because remediation for this numbered change retains its context. If the finish tool fails, stop and report its error.
