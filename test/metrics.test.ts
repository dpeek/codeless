import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { metricReport, recordAttempt, recordDispatch, recordLanding } from "../src/metrics.ts";
import { validAttempt } from "../src/attempt.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

test("attempt ingestion is idempotent and preserves the first dispatch timestamp", () => {
  const workspace = mkdtempSync(join(tmpdir(), "streams metrics "));
  directories.push(workspace);
  recordDispatch(workspace, "queries", "001");
  const path = join(workspace, "metrics/queries/001.json");
  const dispatchedAt = JSON.parse(readFileSync(path, "utf8")).dispatchedAt;
  const attempt = {
    id: "attempt-1",
    stream: "queries",
    change: "001",
    role: "implementer" as const,
    kind: "initial" as const,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.000Z",
    outcome: "stop",
    toolCalls: 0,
    errorCount: 0,
    incomplete: true,
  };
  expect(
    validAttempt(
      { ...attempt, selection: { provider: "", model: "m", thinking: "low" } },
      "queries",
      "001",
    ),
  ).toBe(false);
  expect(validAttempt({ ...attempt, kind: "unknown" }, "queries", "001")).toBe(false);
  recordAttempt(workspace, "queries", "001", attempt);
  const first = readFileSync(path, "utf8");
  recordAttempt(workspace, "queries", "001", attempt);
  expect(readFileSync(path, "utf8")).toBe(first);
  expect(() =>
    recordAttempt(workspace, "queries", "001", { ...attempt, outcome: "error" }),
  ).toThrow("conflicts");
  expect(() =>
    recordAttempt(workspace, "queries", "001", { ...attempt, id: "malformed", startedAt: "nope" }),
  ).toThrow("not a valid");
  recordAttempt(workspace, "queries", "001", { ...attempt, id: "attempt-2" });
  const metric = JSON.parse(readFileSync(path, "utf8"));
  expect(metric.dispatchedAt).toBe(dispatchedAt);
  expect(Object.keys(metric.attempts)).toEqual(["attempt-1", "attempt-2"]);
  writeFileSync(path, JSON.stringify({ ...metric, attempts: { wrong: attempt } }));
  expect(() => metricReport(workspace)).toThrow("not a metric record");
});

test("complete attempts require final implementer text and full-session usage", () => {
  const complete = {
    id: "attempt-1",
    stream: "queries",
    change: "001",
    role: "implementer" as const,
    kind: "initial" as const,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.000Z",
    selection: { provider: "openai-codex", model: "gpt-5.6-terra", thinking: "medium" },
    outcome: "stop",
    text: "Implemented.",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    toolCalls: 0,
    errorCount: 0,
    incomplete: false,
  };
  expect(validAttempt(complete, "queries", "001")).toBe(true);
  expect(validAttempt({ ...complete, text: undefined }, "queries", "001")).toBe(false);
  expect(validAttempt({ ...complete, usage: undefined }, "queries", "001")).toBe(false);
});

test("landing creates an unavailable record and preserves existing canonical records", () => {
  const workspace = mkdtempSync(join(tmpdir(), "streams metrics "));
  directories.push(workspace);
  const firstCommit = "a".repeat(40);
  recordLanding(workspace, "queries", "002", firstCommit);
  const landedPath = join(workspace, "metrics/queries/002.json");
  const landed = readFileSync(landedPath, "utf8");
  expect(JSON.parse(landed)).toMatchObject({
    stream: "queries",
    change: "002",
    landedCommit: firstCommit,
  });
  expect(JSON.parse(landed)).not.toHaveProperty("dispatchedAt");
  recordLanding(workspace, "queries", "002", "b".repeat(40));
  expect(readFileSync(landedPath, "utf8")).toBe(landed);

  recordDispatch(workspace, "queries", "001");
  const dispatchedPath = join(workspace, "metrics/queries/001.json");
  const dispatched = JSON.parse(readFileSync(dispatchedPath, "utf8"));
  recordLanding(workspace, "queries", "001", firstCommit);
  expect(JSON.parse(readFileSync(dispatchedPath, "utf8"))).toMatchObject({
    ...dispatched,
    landedCommit: firstCommit,
  });
});
