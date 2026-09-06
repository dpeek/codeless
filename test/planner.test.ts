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
  }) => Promise<void>;
  withSession: (replacement: Replacement) => Promise<void>;
};
type CommandContext = {
  waitForIdle: () => Promise<void>;
  newSession: (options: SessionOptions) => Promise<{ cancelled: boolean }>;
  sessionManager: { getEntries: () => SessionEntry[] };
  getSystemPromptOptions: () => { selectedTools: string[] };
  modelRegistry: { find: (provider: string, model: string) => Model | undefined };
  readonly model: Model;
  ui: { notify: (message: string, type: string) => void };
};
type Model = { provider: string; id: string };
type Command = { handler: (args: string, ctx: CommandContext) => Promise<void> };

function harness(name = "queries-planner", entries: SessionEntry[] = []) {
  let start: (() => void) | undefined;
  let live = true;
  let model: Model = { provider: "openai-codex", id: "gpt-5.6-luna" };
  let thinkingLevel = "off";
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
    replacementTools: [] as string[],
    replacementModel: "",
    replacementThinking: "",
    notifications: [] as string[],
    replacementNotifications: [] as string[],
    agentName: "",
  };
  const assertLive = () => {
    if (!live) throw new Error("Old Pi context used after session replacement");
  };
  plannerExtension({
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
      model = next;
      return true;
    },
    getThinkingLevel: () => {
      assertLive();
      return thinkingLevel;
    },
    setThinkingLevel: (level: string) => {
      assertLive();
      thinkingLevel = level;
    },
    exec: async (...args: unknown[]) => {
      assertLive();
      execCalls.push(args);
      if (args[0] === "herdr") {
        const command = args[1] as string[];
        if (command[1] === "rename") state.agentName = command[3]!;
        return {
          code: 0,
          stdout: JSON.stringify({
            result: { agent: { name: state.agentName || name.replaceAll("-", "_") } },
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
    sessionManager: { getEntries: () => entries },
    getSystemPromptOptions: () => ({
      selectedTools: ["approve_stream_change", "dispatch_stream_implementer", "next_stream_change"],
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
      await options.setup({
        appendSessionInfo: (value) => {
          state.replacementName = value;
        },
        appendCustomEntry: (customType, data) => {
          replacementEntries.push({ type: "custom", customType, data });
        },
      });
      live = false;
      const replacement = harness(state.replacementName, replacementEntries);
      state.replacementTools = [...replacement.tools.keys()];
      await options.withSession({
        sendUserMessage: async (...args) => {
          replacementMessages.push(args);
          if (typeof args[0] === "string" && args[0].startsWith("/streams-activate ")) {
            await replacement.commands
              .get("streams-activate")!
              .handler(args[0].slice("/streams-activate ".length), replacement.context);
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
  h.state.stdout = "settled";
  const dispatch = () =>
    h.tools.get("dispatch_stream_implementer")!.execute("call", { changePath }, signal);
  await dispatch();
  expect(h.execCalls).toEqual([
    ["bun", [executable, "dispatch", changePath], { signal, timeout: 3_700_000 }],
  ]);
  expect(h.messages).toEqual([
    [`/review ${JSON.stringify(changePath)}`, { deliverAs: "steer", expandPromptTemplates: true }],
  ]);
  h.state.code = 1;
  await expectFailure(dispatch(), "settled");
  expect(h.messages).toHaveLength(1);
});

test("activation stops before the project prompt for a wrong Herdr identity or missing tools", async () => {
  const h = harness();
  const activate = () =>
    h.commands.get("streams-activate")!.handler(JSON.stringify(kickoff.prompt), h.context);
  h.state.agentName = "queries_impl";
  await expectFailure(activate(), "expected queries_planner");
  expect(h.messages).toHaveLength(0);

  h.state.agentName = "";
  h.context.getSystemPromptOptions = () => ({ selectedTools: [] });
  await expectFailure(activate(), "missing required tools");
  expect(h.messages).toHaveLength(0);
});

test("activation replaces only Herdr's fallback pi identity before the project prompt", async () => {
  const h = harness();
  h.state.agentName = "pi";
  await h.commands.get("streams-activate")!.handler(JSON.stringify(kickoff.prompt), h.context);
  expect(h.execCalls.slice(-3)).toEqual([
    ["herdr", ["agent", "get", "planner"], { timeout: 30_000 }],
    ["herdr", ["agent", "rename", "planner", "queries_planner"], { timeout: 30_000 }],
    ["herdr", ["agent", "get", "planner"], { timeout: 30_000 }],
  ]);
  expect(h.messages).toEqual([[kickoff.prompt, { expandPromptTemplates: true }]]);
});

test("handoff activates the validated planner selection before prompting the replacement", async () => {
  const h = harness();
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
  expect(h.replacementMessages).toEqual([
    [`/streams-activate ${JSON.stringify(kickoff.prompt)}`, { expandPromptTemplates: true }],
  ]);
  expect(h.state.replacementModel).toBe("openai-codex/gpt-5.6-sol");
  expect(h.state.replacementThinking).toBe("high");
  expect(h.state.replacementNotifications).toEqual([
    "Planner activated: queries-planner / queries_planner",
  ]);
  await expectFailure(h.handoff(), "No pending");
});

test("handoff does not prompt when the replacement cannot apply its selection", async () => {
  const h = harness();
  h.state.stdout = JSON.stringify({
    ...kickoff,
    selection: { ...kickoff.selection, model: "missing-model" },
  });
  await h.request();
  await expectFailure(h.handoff(), "Pi could not find it");
  expect(h.replacementMessages).toEqual([
    [`/streams-activate ${JSON.stringify(kickoff.prompt)}`, { expandPromptTemplates: true }],
  ]);
});

test("failed validation or cancelled replacement stops without sending a next proposal", async () => {
  const h = harness();
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
  const h = harness();
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
