import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recordDispatch, recordLanding } from "../src/metrics.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
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
