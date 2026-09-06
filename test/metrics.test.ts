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

test("attempt report keeps attempt IDs scoped to their stream/change and reports coverage", () => {
  const workspace = mkdtempSync(join(tmpdir(), "streams metrics "));
  directories.push(workspace);
  const base = {
    stream: "queries",
    change: "001",
    role: "implementer" as const,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.000Z",
    toolCalls: 0,
  };
  recordAttempt(workspace, "queries", "001", {
    ...base,
    id: "initial",
    kind: "initial",
    outcome: "stop",
    text: "Implemented.",
    selection: { provider: "openai-codex", model: "gpt-5.6-terra", thinking: "medium" },
    usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 },
    cost: { amount: 1.25, currency: "USD", source: "pi" },
    errorCount: 2,
    incomplete: false,
  });
  recordAttempt(workspace, "queries", "001", {
    ...base,
    id: "rework",
    kind: "rework",
    outcome: "error",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    cost: { amount: 3, currency: "EUR", source: "pi" },
    errorCount: 0,
    incomplete: true,
  });
  recordAttempt(workspace, "relationships", "002", {
    ...base,
    stream: "relationships",
    change: "002",
    id: "initial",
    kind: "initial",
    outcome: "unknown",
    errorCount: 4,
    incomplete: true,
  });

  recordAttempt(workspace, "empty", "001", {
    ...base,
    stream: "empty",
    id: "zero",
    kind: "initial",
    outcome: "unknown",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    errorCount: 0,
    incomplete: true,
  });
  recordAttempt(workspace, "queries", "001", {
    ...base,
    id: "fractional-cost",
    kind: "rework",
    outcome: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    cost: { amount: 0.1, currency: "AUD", source: "pi" },
    errorCount: 0,
    incomplete: true,
  });
  recordAttempt(workspace, "queries", "001", {
    ...base,
    id: "fractional-cost-2",
    kind: "rework",
    outcome: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    cost: { amount: 0.2, currency: "AUD", source: "pi" },
    errorCount: 0,
    incomplete: true,
  });

  const report = metricReport(workspace);
  expect(report).toContain(
    "queries\t1\t1\t3\t3\terror: 1, stop: 3\t2\t4 measured, 0 unavailable\t10\t20\t30\t40\t4 measured, 0 unavailable\tAUD 0.3, EUR 3, USD 1.25",
  );
  expect(report).toContain(
    "relationships\t0\t1\t0\t1\tunknown: 1\t4\t0 measured, 1 unavailable\tunavailable\tunavailable\tunavailable\tunavailable\t0 measured, 1 unavailable\tunavailable",
  );
  expect(report).toContain(
    "empty\t0\t1\t0\t1\tunknown: 1\t0\t1 measured, 0 unavailable\t0\t0\t0\t0\t0 measured, 1 unavailable\tunavailable",
  );
  expect(report).toContain(
    "Project total\t1\t3\t3\t5\terror: 1, stop: 3, unknown: 2\t6\t5 measured, 1 unavailable\t10\t20\t30\t40\t4 measured, 2 unavailable\tAUD 0.3, EUR 3, USD 1.25",
  );
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
