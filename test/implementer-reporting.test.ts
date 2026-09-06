import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import reportingExtension from "../extension/implementer-reporting.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function report(entries: unknown[]) {
  const directory = mkdtempSync(join(tmpdir(), "implementer report "));
  directories.push(directory);
  const path = join(directory, "attempt.json");
  const configuration = JSON.stringify({
    id: "attempt-1",
    stream: "queries",
    change: "001",
    kind: "initial",
    path,
  });
  const handlers = new Map<string, (event: any, context: any) => void>();
  let flagsAvailable = false;
  reportingExtension({
    registerFlag: () => {},
    registerCommand: () => {},
    getFlag: () => (flagsAvailable ? configuration : undefined),
    on: (name: string, handler: (event: any, context: any) => void) => handlers.set(name, handler),
    getThinkingLevel: () => "medium",
  });
  expect(handlers.get("session_start")).toBeDefined();
  flagsAvailable = true;
  handlers.get("session_start")!({}, {});
  handlers.get("agent_start")!({}, {});
  handlers.get("tool_execution_end")!({ isError: false }, {});
  handlers.get("tool_execution_end")!({ isError: true }, {});
  handlers.get("agent_settled")!(
    {},
    { model: { provider: "wrong", id: "wrong" }, sessionManager: { getEntries: () => entries } },
  );
  return JSON.parse(readFileSync(path, "utf8"));
}

test("implementer reporting aggregates complete settled session usage without sensitive content", () => {
  const assistant = {
    role: "assistant",
    provider: "openai-codex",
    model: "gpt-5.6-terra",
    stopReason: "stop",
    content: [
      { type: "thinking", thinking: "secret" },
      { type: "text", text: "Implemented safely." },
    ],
    usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, cost: { total: 0.12 } },
  };
  const reportValue = report([
    {
      type: "message",
      message: {
        role: "user",
        content: "sensitive prompt",
        usage: { input: 100, output: 100, cacheRead: 100, cacheWrite: 100, cost: { total: 100 } },
      },
    },
    { type: "message", message: assistant },
    {
      type: "message",
      message: {
        role: "toolResult",
        usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 0.03 } },
      },
    },
    {
      type: "compaction",
      usage: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8, cost: { total: 0.04 } },
    },
    {
      type: "branch_summary",
      usage: { input: 9, output: 10, cacheRead: 11, cacheWrite: 12, cost: { total: 0.05 } },
    },
  ]);

  expect(reportValue).toMatchObject({
    id: "attempt-1",
    stream: "queries",
    change: "001",
    role: "implementer",
    kind: "initial",
    selection: { provider: "openai-codex", model: "gpt-5.6-terra", thinking: "medium" },
    outcome: "stop",
    text: "Implemented safely.",
    usage: { input: 25, output: 23, cacheRead: 24, cacheWrite: 26 },
    cost: { amount: 0.24, currency: "USD", source: "pi-model-estimate" },
    toolCalls: 2,
    errorCount: 1,
    incomplete: false,
  });
  expect(JSON.stringify(reportValue)).not.toContain("sensitive prompt");
  expect(JSON.stringify(reportValue)).not.toContain("secret");
});

test("implementer reporting scopes and measures only its queued rework turn", async () => {
  const directory = mkdtempSync(join(tmpdir(), "implementer report "));
  directories.push(directory);
  const path = join(directory, "rework.json");
  const handlers = new Map<string, (event: any, context: any) => void>();
  const commands = new Map<string, { handler: (args: string, context: any) => Promise<void> }>();
  const entries: any[] = [];
  const sent: string[] = [];
  let shutdowns = 0;
  reportingExtension({
    registerFlag: () => {},
    registerCommand: (
      name: string,
      command: { handler: (args: string, context: any) => Promise<void> },
    ) => commands.set(name, command),
    getFlag: () =>
      JSON.stringify({ id: "initial", stream: "queries", change: "001", kind: "initial", path }),
    on: (name: string, handler: (event: any, context: any) => void) => handlers.set(name, handler),
    getThinkingLevel: () => "medium",
    sendUserMessage: (message: string) => sent.push(message),
  });
  handlers.get("session_start")!({}, {});
  const request = {
    id: "rework",
    stream: "queries",
    change: "001",
    kind: "rework",
    path,
    feedback: "Add a regression test.",
  };
  await commands
    .get("codeless-rework")!
    .handler(JSON.stringify(request), { sessionManager: { getEntries: () => entries } });
  expect(sent).toEqual(["Review feedback: Add a regression test."]);
  let scopeError: unknown;
  try {
    await commands
      .get("codeless-finish")!
      .handler(JSON.stringify({ stream: "other", change: "001" }), {
        shutdown: async () => shutdowns++,
      });
  } catch (error) {
    scopeError = error;
  }
  expect(scopeError).toBeInstanceOf(Error);
  expect((scopeError as Error).message).toContain("scope does not match");
  expect(shutdowns).toBe(0);
  await commands
    .get("codeless-finish")!
    .handler(JSON.stringify({ stream: "queries", change: "001" }), {
      shutdown: async () => shutdowns++,
    });
  expect(shutdowns).toBe(1);
  handlers.get("agent_settled")!({}, { sessionManager: { getEntries: () => entries } });
  handlers.get("agent_start")!({}, {});
  entries.push({
    type: "message",
    message: {
      role: "assistant",
      provider: "openai-codex",
      model: "gpt-5.6-terra",
      stopReason: "stop",
      content: [{ type: "text", text: "Fixed." }],
      usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5 },
    },
  });
  handlers.get("agent_settled")!(
    {},
    { model: { provider: "wrong", id: "wrong" }, sessionManager: { getEntries: () => entries } },
  );
  expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
    id: "rework",
    kind: "rework",
    usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5 },
  });
});

test("implementer reporting disarms after its first settled write", () => {
  const directory = mkdtempSync(join(tmpdir(), "implementer report "));
  directories.push(directory);
  const path = join(directory, "attempt.json");
  const handlers = new Map<string, (event: any, context: any) => void>();
  reportingExtension({
    registerFlag: () => {},
    registerCommand: () => {},
    getFlag: () =>
      JSON.stringify({ id: "attempt-1", stream: "queries", change: "001", kind: "initial", path }),
    on: (name: string, handler: (event: any, context: any) => void) => handlers.set(name, handler),
    getThinkingLevel: () => "medium",
  });
  handlers.get("session_start")!({}, {});
  const context = {
    model: { provider: "openai-codex", id: "gpt-5.6-terra" },
    sessionManager: {
      getEntries: () => [
        {
          type: "message",
          message: {
            role: "assistant",
            provider: "openai-codex",
            model: "gpt-5.6-terra",
            stopReason: "stop",
            content: [],
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
          },
        },
      ],
    },
  };
  handlers.get("agent_settled")!({}, context);
  expect(existsSync(path)).toBe(true);
  unlinkSync(path);
  handlers.get("agent_settled")!({}, context);
  expect(existsSync(path)).toBe(false);
});

test("implementer reporting omits unavailable cost rather than reporting zero", () => {
  const reportValue = report([
    {
      type: "message",
      message: {
        role: "assistant",
        provider: "openai-codex",
        model: "gpt-5.6-terra",
        stopReason: "stop",
        content: [],
        usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
      },
    },
  ]);
  expect(reportValue.usage).toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
  expect(reportValue).not.toHaveProperty("cost");
  expect(reportValue.incomplete).toBe(true);
});

test("implementer reporting marks a missing final assistant result incomplete", () => {
  const reportValue = report([
    {
      type: "message",
      message: {
        role: "toolResult",
        usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 0 } },
      },
    },
  ]);
  expect(reportValue).toMatchObject({ outcome: "unknown", incomplete: true });
  expect(reportValue).not.toHaveProperty("text");
});
