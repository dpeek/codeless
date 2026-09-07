import { expect, test } from "bun:test";
import { join } from "node:path";
import plannerExtension from "../extension/planner.js";

const executable = join(import.meta.dir, "../bin/codeless");
const changePath = "/workspace with spaces/stream/queries/changes/001.md";
const landedCommit = "a".repeat(40);
const kickoff = {
  sessionName: "queries-planner",
  prompt: '/change "/workspace with spaces/stream/queries" "/worktree/briefs/queries.md"',
  selection: {
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    thinking: "high",
  },
};
const signal = new AbortController().signal;
process.env["HERDR_PANE_ID"] = "planner";

type Tool = {
  name: string;
  execute: (id: string, params: Record<string, string>, signal: AbortSignal) => Promise<unknown>;
};
type Replacement = {
  sendUserMessage: (content: string, options: { expandPromptTemplates: boolean }) => Promise<void>;
};
type SessionEntry = {
  type: "custom";
  customType: string;
  data: unknown;
};
type SessionOptions = {
  setup: (manager: {
    appendSessionInfo: (name: string) => void;
    appendCustomEntry: (customType: string, data: unknown) => void;
    getSessionId: () => string;
  }) => Promise<void>;
  withSession: (replacement: Replacement) => Promise<void>;
};
type CommandContext = {
  waitForIdle: () => Promise<void>;
  newSession: (options: SessionOptions) => Promise<{ cancelled: boolean }>;
  cwd: string;
  sessionManager: {
    getEntries: () => SessionEntry[];
    getSessionFile: () => string;
    getSessionId: () => string;
  };
  getSystemPromptOptions: () => { selectedTools: string[] };
  modelRegistry: { find: (provider: string, model: string) => Model | undefined };
  readonly model: Model;
  ui: { notify: (message: string, type: string) => void };
};
type Model = { provider: string; id: string };
type Command = { handler: (args: string, ctx: CommandContext) => Promise<void> };

function harness(
  name = "queries-planner",
  entries: SessionEntry[] = [],
  factory = plannerExtension,
) {
  let start: (() => void) | undefined;
  let live = true;
  let model: Model = { provider: "openai-codex", id: "gpt-5.6-luna" };
  let thinkingLevel = "off";
  const sessionId = crypto.randomUUID();
  const sessionFile = `/sessions/${sessionId}.jsonl`;
  const controls = {
    prepareReplacement: (_ctx: CommandContext) => {},
    replay: async () => {},
    nextReplacement: async () => {},
  };
  const tools = new Map<string, Tool>();
  const commands = new Map<string, Command>();
  const execCalls: unknown[][] = [];
  const messages: unknown[][] = [];
  const replacementMessages: unknown[][] = [];
  const state = {
    code: 0,
    stdout: JSON.stringify(kickoff),
    stderr: "",
    cancelled: false,
    resetCount: 0,
    replacementName: "",
    replacementHerdrUnavailable: false,
    swallowReplacementError: false,
    replacementNameOverride: "",
    replacementModelAuthenticated: true,
    replacementIgnoreThinking: false,
    modelAuthenticated: true,
    ignoreThinkingSelection: false,
    reloadCount: 0,
    replacementLifecycleAuthority: true,
    replacementSessionSource: "herdr:pi",
    herdrUnavailable: false,
    replacementExecCalls: [] as unknown[][],
    replacementProjectMessages: [] as unknown[][],
    replacementId: "",
    replacementTools: [] as string[],
    replacementModel: "",
    replacementThinking: "",
    notifications: [] as string[],
    replacementNotifications: [] as string[],
    agentName: name.replaceAll("-", "_"),
    agentKind: "pi",
    interactiveReady: true,
    lifecycleAuthority: true,
    sessionRef: sessionFile,
    sessionSource: "herdr:pi",
    foregroundCwd: import.meta.dir,
  };
  const assertLive = () => {
    if (!live) throw new Error("Old Pi context used after session replacement");
  };
  factory({
    getSessionName: () => {
      assertLive();
      return name;
    },
    on: (_event: string, callback: () => void) => {
      start = callback;
    },
    registerCommand: (key: string, command: Command) => {
      commands.set(key, command);
    },
    registerTool: (tool: Tool) => {
      assertLive();
      tools.set(tool.name, tool);
    },
    setModel: async (next: Model) => {
      assertLive();
      if (!state.modelAuthenticated) return false;
      model = next;
      return true;
    },
    getThinkingLevel: () => {
      assertLive();
      return thinkingLevel;
    },
    setThinkingLevel: (level: string) => {
      assertLive();
      if (!state.ignoreThinkingSelection) thinkingLevel = level;
    },
    exec: async (...args: unknown[]) => {
      assertLive();
      execCalls.push(args);
      if (args[0] === "herdr") {
        if (state.herdrUnavailable) throw new Error("Herdr reporting unavailable");
        const command = args[1] as string[];
        if (command[1] === "rename") state.agentName = command[3]!;
        return {
          code: 0,
          stdout: JSON.stringify({
            result: {
              agent: {
                name: state.agentName || undefined,
                agent: state.agentKind,
                interactive_ready: state.interactiveReady,
                screen_detection_skipped: state.lifecycleAuthority,
                agent_session: {
                  source: state.sessionSource,
                  agent: "pi",
                  kind: "path",
                  value: state.sessionRef,
                },
                foreground_cwd: state.foregroundCwd,
              },
            },
          }),
          stderr: "",
        };
      }
      return { code: state.code, stdout: state.stdout, stderr: state.stderr };
    },
    sendUserMessage: (...args: unknown[]) => {
      assertLive();
      messages.push(args);
    },
  });
  start!();
  const context: CommandContext = {
    waitForIdle: async () => {
      assertLive();
    },
    cwd: import.meta.dir,
    sessionManager: {
      getEntries: () => entries,
      getSessionFile: () => sessionFile,
      getSessionId: () => sessionId,
    },
    getSystemPromptOptions: () => ({
      selectedTools: [
        "approve_stream_change",
        "dispatch_stream_implementer",
        "rework_stream_implementer",
        "finish_stream_implementer",
        "next_stream_change",
      ],
    }),
    modelRegistry: {
      find: (provider, id) =>
        ["gpt-5.6-sol", "gpt-5.6-terra"].includes(id) ? { provider, id } : undefined,
    },
    get model() {
      return model;
    },
    ui: {
      notify: (message) => {
        state.notifications.push(message);
      },
    },
    newSession: async (options) => {
      assertLive();
      state.resetCount += 1;
      if (state.cancelled) return { cancelled: true };
      const replacementEntries: SessionEntry[] = [];
      const newId = crypto.randomUUID();
      await options.setup({
        getSessionId: () => newId,
        appendSessionInfo: (value) => {
          state.replacementName = value;
        },
        appendCustomEntry: (customType, data) => {
          replacementEntries.push({ type: "custom", customType, data });
        },
      });
      live = false;
      const reloaded = await import(`../extension/planner.js?replacement=${newId}`);
      expect(reloaded.default).not.toBe(factory);
      state.reloadCount += 1;
      const replacement = harness(
        state.replacementNameOverride || state.replacementName,
        replacementEntries,
        reloaded.default,
      );
      replacement.context.sessionManager.getSessionId = () => newId;
      replacement.context.sessionManager.getSessionFile = () => `/sessions/${newId}.jsonl`;
      replacement.state.herdrUnavailable = state.replacementHerdrUnavailable;
      replacement.state.modelAuthenticated = state.replacementModelAuthenticated;
      replacement.state.ignoreThinkingSelection = state.replacementIgnoreThinking;
      controls.nextReplacement = async () => {
        replacement.state.replacementHerdrUnavailable = true;
        await replacement.request();
        await replacement.handoff();
      };
      replacement.state.lifecycleAuthority = state.replacementLifecycleAuthority;
      replacement.state.sessionSource = state.replacementSessionSource;
      controls.prepareReplacement(replacement.context);
      state.replacementId = newId;
      state.replacementExecCalls = replacement.execCalls;
      state.replacementProjectMessages = replacement.messages;
      state.replacementTools = [...replacement.tools.keys()];
      await options.withSession({
        sendUserMessage: async (...args) => {
          replacementMessages.push(args);
          if (typeof args[0] === "string" && args[0].startsWith("/streams-activate ")) {
            const activationArgs = args[0].slice("/streams-activate ".length);
            controls.replay = () =>
              replacement.commands
                .get("streams-activate")!
                .handler(activationArgs, replacement.context);
            try {
              await controls.replay();
            } catch (error) {
              if (!state.swallowReplacementError) throw error;
            }
          } else {
            replacement.messages.push(args);
          }
          state.replacementModel = `${replacement.context.model.provider}/${replacement.context.model.id}`;
          state.replacementThinking = replacement.piThinkingLevel();
          state.replacementNotifications = replacement.state.notifications;
        },
      });
      return { cancelled: false };
    },
  };
  const request = () =>
    tools.get("next_stream_change")!.execute("call", { changePath, landedCommit }, signal);
  const handoff = () => commands.get("streams-next")!.handler("", context);
  const piThinkingLevel = () => thinkingLevel;
  return {
    controls,
    tools,
    commands,
    state,
    execCalls,
    messages,
    replacementMessages,
    context,
    request,
    handoff,
    piThinkingLevel,
  };
}

async function admittedHarness() {
  const h = harness();
  await h.commands.get("streams-activate")!.handler(JSON.stringify(kickoff.prompt), h.context);
  h.messages.length = 0;
  h.execCalls.length = 0;
  return h;
}

async function expectFailure(operation: Promise<unknown>, message: string) {
  const failure = await operation.catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(message);
}

test("approval promotes through the no-argument command without dispatching", async () => {
  const h = harness();
  h.state.stdout = JSON.stringify({ number: "001", changePath, title: "One safe change" });
  const result = await h.tools.get("approve_stream_change")!.execute("call", {}, signal);
  expect(h.execCalls).toEqual([
    ["bun", [executable, "approve", "queries-planner"], { signal, timeout: 30_000 }],
  ]);
  expect(h.messages).toHaveLength(0);
  expect(result).toMatchObject({
    details: { number: "001", changePath, title: "One safe change" },
  });

  h.state.stdout = "not JSON";
  await expectFailure(
    h.tools.get("approve_stream_change")!.execute("call", {}, signal),
    "invalid approval",
  );
});

test("approval derives its identity from the active Pi session", async () => {
  const h = harness("relationships-planner");
  h.state.stdout = JSON.stringify({ number: "001", changePath, title: "One safe change" });
  await h.tools.get("approve_stream_change")!.execute("call", {}, signal);
  expect(h.execCalls).toEqual([
    ["bun", [executable, "approve", "relationships-planner"], { signal, timeout: 30_000 }],
  ]);
});

test("dispatch queues review only after a successful implementer run", async () => {
  const h = harness();
  h.state.stdout = JSON.stringify({
    id: "attempt-1",
    stream: "queries",
    change: "001",
    role: "implementer",
    kind: "initial",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.000Z",
    outcome: "stop",
    selection: { provider: "openai-codex", model: "gpt-5.6-terra", thinking: "medium" },
    text: "Implemented.",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    toolCalls: 1,
    errorCount: 0,
    incomplete: false,
  });
  const dispatch = () =>
    h.tools.get("dispatch_stream_implementer")!.execute("call", { changePath }, signal);
  const result = await dispatch();
  expect(h.execCalls).toEqual([
    ["bun", [executable, "dispatch", changePath], { signal, timeout: 3_700_000 }],
  ]);
  expect(h.messages).toEqual([
    [`/review ${JSON.stringify(changePath)}`, { deliverAs: "steer", expandPromptTemplates: true }],
  ]);
  expect(result).toMatchObject({ details: { changePath, attempt: { id: "attempt-1" } } });
  h.state.stdout = JSON.stringify({
    id: "attempt-1",
    stream: "queries",
    change: "001",
    role: "implementer",
    kind: "initial",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.000Z",
    selection: { provider: "", model: "gpt-5.6-terra", thinking: "medium" },
    outcome: "stop",
    toolCalls: 1,
    errorCount: 0,
    incomplete: false,
  });
  await expectFailure(dispatch(), "invalid implementer attempt");
  h.state.stdout = JSON.stringify({ id: "attempt-1", role: "implementer", incomplete: false });
  await expectFailure(dispatch(), "invalid implementer attempt");
  expect(h.messages).toHaveLength(1);
  h.state.stdout = JSON.stringify({ ...JSON.parse(h.state.stdout), text: "Implemented." });
  h.state.code = 1;
  await expectFailure(dispatch(), "Implemented.");
  expect(h.messages).toHaveLength(1);
});

test("rework queues review and finish stops on its backing command failure", async () => {
  const h = harness();
  h.state.stdout = JSON.stringify({
    id: "attempt-2",
    stream: "queries",
    change: "001",
    role: "implementer",
    kind: "rework",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.000Z",
    outcome: "stop",
    selection: { provider: "openai-codex", model: "gpt-5.6-terra", thinking: "medium" },
    text: "Fixed.",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    toolCalls: 0,
    errorCount: 0,
    incomplete: false,
  });
  await h.tools
    .get("rework_stream_implementer")!
    .execute("call", { changePath, feedback: "Add the missing test." }, signal);
  expect(h.execCalls).toEqual([
    [
      "bun",
      [executable, "rework", changePath, "Add the missing test."],
      { signal, timeout: 3_700_000 },
    ],
  ]);
  expect(h.messages).toEqual([
    [`/review ${JSON.stringify(changePath)}`, { deliverAs: "steer", expandPromptTemplates: true }],
  ]);
  h.state.code = 1;
  h.state.stderr = "implementer is not idle";
  await expectFailure(
    h.tools.get("finish_stream_implementer")!.execute("call", { changePath }, signal),
    "not idle",
  );
});

test("activation stops before the project prompt for a wrong Herdr identity or missing tools", async () => {
  const h = harness();
  const activate = () =>
    h.commands.get("streams-activate")!.handler(JSON.stringify(kickoff.prompt), h.context);
  h.state.agentName = "queries_impl";
  await expectFailure(activate(), "expected queries_planner");
  expect(h.messages).toHaveLength(0);

  h.state.agentName = "queries_planner";
  h.context.getSystemPromptOptions = () => ({ selectedTools: [] });
  await expectFailure(activate(), "missing required tools");
  expect(h.messages).toHaveLength(0);
});

test.each([
  { agentName: "" },
  { agentName: "pi" },
  { interactiveReady: false },
  { agentKind: "claude" },
  { lifecycleAuthority: false },
  { sessionSource: "other" },
  { foregroundCwd: "/other-worktree" },
])("activation refuses an unbound planner without renaming or prompting: %j", async (overrides) => {
  const h = harness();
  Object.assign(h.state, overrides);
  await expectFailure(
    h.commands.get("streams-activate")!.handler(JSON.stringify(kickoff.prompt), h.context),
    "Codeless",
  );
  expect(h.messages).toHaveLength(0);
  expect(h.execCalls).toEqual([["herdr", ["agent", "get", "planner"], { timeout: 30_000 }]]);
});

test.each([
  { replacementLifecycleAuthority: false },
  { replacementSessionSource: "" },
  { replacementHerdrUnavailable: true },
])("handoff starts exactly once despite unavailable lifecycle reporting: %j", async (reporting) => {
  const h = await admittedHarness();
  Object.assign(h.state, reporting);
  const previousId = h.context.sessionManager.getSessionId();
  await h.request();
  await h.handoff();
  expect(h.state.replacementId).not.toBe(previousId);
  expect(h.state.reloadCount).toBe(1);
  expect(h.state.replacementExecCalls).toEqual([]);
  expect(h.state.replacementProjectMessages).toEqual([
    [kickoff.prompt, { expandPromptTemplates: true }],
  ]);
  await expectFailure(h.controls.replay(), "handoff");
  expect(h.state.replacementProjectMessages).toHaveLength(1);
});

test("handoff activates the validated planner selection before prompting the replacement", async () => {
  const h = await admittedHarness();
  let settle!: () => void;
  h.context.waitForIdle = () =>
    new Promise<void>((resolve) => {
      settle = resolve;
    });
  await h.request();
  expect(h.messages).toEqual([
    ["/streams-next", { deliverAs: "followUp", expandPromptTemplates: true }],
  ]);
  const switching = h.handoff();
  expect(h.execCalls).toHaveLength(0);
  expect(h.state.resetCount).toBe(0);
  await expectFailure(h.request(), "already pending");
  await expectFailure(h.handoff(), "No pending");
  settle();
  await switching;
  expect(h.execCalls).toEqual([
    ["bun", [executable, "next", changePath, landedCommit], { timeout: 30_000 }],
  ]);
  expect(h.state.resetCount).toBe(1);
  expect(h.state.replacementName).toBe("queries-planner");
  expect(h.state.replacementTools).toContain("dispatch_stream_implementer");
  expect(h.state.replacementTools).toContain("next_stream_change");
  expect(h.replacementMessages).toHaveLength(2);
  expect(h.replacementMessages[0]![0]).toMatch(/^\/streams-activate /);
  expect(h.replacementMessages[1]).toEqual([kickoff.prompt, { expandPromptTemplates: true }]);
  expect(h.state.replacementModel).toBe("openai-codex/gpt-5.6-sol");
  expect(h.state.replacementThinking).toBe("high");
  expect(h.state.replacementNotifications).toEqual([
    "Planner activated: queries-planner / queries_planner",
  ]);
  await expectFailure(h.handoff(), "No pending");
});

test("handoff does not prompt when the replacement cannot apply its selection", async () => {
  const h = await admittedHarness();
  h.state.stdout = JSON.stringify({
    ...kickoff,
    selection: { ...kickoff.selection, model: "missing-model" },
  });
  await h.request();
  await expectFailure(h.handoff(), "Pi could not find it");
  expect(h.replacementMessages).toHaveLength(1);
  expect(h.replacementMessages[0]![0]).toMatch(/^\/streams-activate /);
});

test("failed validation or cancelled replacement stops without sending a next proposal", async () => {
  const h = await admittedHarness();
  h.state.code = 1;
  h.state.stderr = "stream has unlanded work";
  await h.request();
  await expectFailure(h.handoff(), "unlanded work");
  expect(h.state.resetCount).toBe(0);
  expect(h.messages).toHaveLength(1);
  expect(h.replacementMessages).toHaveLength(0);

  h.state.code = 0;
  h.state.cancelled = true;
  await h.request();
  await expectFailure(h.handoff(), "handoff cancelled");
  expect(h.state.resetCount).toBe(1);
  expect(h.messages).toHaveLength(2);
  expect(h.replacementMessages).toHaveLength(0);
});

test("a mismatched planner handoff cannot reset the current session", async () => {
  const h = await admittedHarness();
  h.state.stdout = JSON.stringify({ ...kickoff, sessionName: "relationships-planner" });
  await h.request();
  await expectFailure(h.handoff(), "invalid planner handoff");
  expect(h.state.resetCount).toBe(0);
});

test("ordinary sessions expose no stream tools and do not schedule a loop", async () => {
  const h = harness("ordinary-session");
  expect(h.tools.size).toBe(0);
  expect(h.messages).toHaveLength(0);
  await expectFailure(h.handoff(), "No pending");
});

test.each(["cwd", "session", "tools"])(
  "replacement rejects mismatched %s without prompting",
  async (field) => {
    const h = await admittedHarness();
    h.controls.prepareReplacement = (ctx) => {
      if (field === "cwd") ctx.cwd = "/other-worktree";
      if (field === "session") ctx.sessionManager.getSessionId = () => "wrong-session";
      if (field === "tools") ctx.getSystemPromptOptions = () => ({ selectedTools: [] });
    };
    await h.request();
    await expectFailure(h.handoff(), "Codeless");
    expect(h.state.replacementProjectMessages).toHaveLength(0);
    expect(h.state.replacementExecCalls).toHaveLength(0);
    await expectFailure(h.controls.replay(), "handoff");
  },
);

test("a saved selection cannot admit a planner or authorize a handoff", async () => {
  const h = harness("queries-planner", [
    {
      type: "custom",
      customType: "streams-role-selection",
      data: { role: "planner", selection: kickoff.selection },
    },
  ]);
  await expectFailure(h.request(), "activat");
  await expectFailure(
    h.commands.get("streams-activate")!.handler(JSON.stringify({ handoff: "expired" }), h.context),
    "handoff",
  );
  expect(h.execCalls).toHaveLength(0);
  expect(h.messages).toHaveLength(0);
});

test("Pi displaying a command error cannot acknowledge a failed replacement", async () => {
  const h = await admittedHarness();
  h.state.swallowReplacementError = true;
  h.controls.prepareReplacement = (ctx) => {
    ctx.getSystemPromptOptions = () => ({ selectedTools: [] });
  };
  await h.request();
  await expectFailure(h.handoff(), "replacement activation failed");
  expect(h.state.replacementProjectMessages).toHaveLength(0);
  await expectFailure(h.controls.replay(), "handoff");
});

test("a different pane or planner name cannot consume the handoff", async () => {
  for (const mismatch of ["pane", "name"]) {
    const h = await admittedHarness();
    if (mismatch === "name") h.state.replacementNameOverride = "other-planner";
    else
      h.controls.prepareReplacement = () => {
        process.env["HERDR_PANE_ID"] = "other";
      };
    try {
      await h.request();
      await expectFailure(h.handoff(), "handoff does not match");
      expect(h.state.replacementProjectMessages).toHaveLength(0);
      await expectFailure(h.controls.replay(), "handoff");
    } finally {
      process.env["HERDR_PANE_ID"] = "planner";
    }
  }
});

test("launch activation cannot submit its project prompt twice", async () => {
  const h = await admittedHarness();
  await expectFailure(
    h.commands.get("streams-activate")!.handler(JSON.stringify(kickoff.prompt), h.context),
    "already activated",
  );
  expect(h.messages).toHaveLength(0);
});

test.each([{ replacementModelAuthenticated: false }, { replacementIgnoreThinking: true }])(
  "replacement stops when its effective selection is unavailable: %j",
  async (settings) => {
    const h = await admittedHarness();
    Object.assign(h.state, settings);
    await h.request();
    const failure = await h.handoff().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(h.state.replacementProjectMessages).toHaveLength(0);
    await expectFailure(h.controls.replay(), "handoff");
  },
);

test("an activated replacement can hand off again without Herdr reporting", async () => {
  const h = await admittedHarness();
  h.state.replacementHerdrUnavailable = true;
  await h.request();
  await h.handoff();
  await h.controls.nextReplacement();
  expect(h.state.replacementExecCalls).toEqual([
    ["bun", [executable, "next", changePath, landedCommit], { timeout: 30_000 }],
  ]);
});
