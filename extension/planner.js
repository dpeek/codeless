import { fileURLToPath } from "node:url";

const codeless = fileURLToPath(new URL("../bin/codeless", import.meta.url));
const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const requiredTools = [
  "approve_stream_change",
  "dispatch_stream_implementer",
  "next_stream_change",
];

function selection(value) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof value.provider !== "string" ||
    value.provider.length === 0 ||
    typeof value.model !== "string" ||
    value.model.length === 0 ||
    !thinkingLevels.has(value.thinking)
  ) {
    throw new Error("Codeless returned an invalid planner selection");
  }
  return { provider: value.provider, model: value.model, thinking: value.thinking };
}

export default function plannerExtension(pi) {
  let registered = false;
  let pending;

  pi.registerCommand("streams-activate", {
    description: "Verify this planner session before starting its project prompt",
    handler: async (args, ctx) => {
      let prompt;
      try {
        prompt = JSON.parse(args);
      } catch {
        throw new Error("Codeless activation requires one JSON-quoted project prompt");
      }
      if (typeof prompt !== "string" || !prompt.startsWith("/change ")) {
        throw new Error("Codeless activation requires a /change project prompt");
      }
      const activation = ctx.sessionManager
        .getEntries()
        .findLast(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === "streams-role-selection" &&
            entry.data?.role === "planner",
        );
      if (activation) {
        const requested = selection(activation.data.selection);
        const reference = `${requested.provider}/${requested.model}`;
        const model = ctx.modelRegistry.find(requested.provider, requested.model);
        if (!model) throw new Error(`Planner requested ${reference}, but Pi could not find it`);
        if (!(await pi.setModel(model))) {
          throw new Error(`Planner requested ${reference}, but Pi authentication is unavailable`);
        }
        pi.setThinkingLevel(requested.thinking);
        if (
          ctx.model?.provider !== requested.provider ||
          ctx.model.id !== requested.model ||
          pi.getThinkingLevel() !== requested.thinking
        ) {
          const effective = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model";
          throw new Error(
            `Planner requested ${reference} at thinking level ${requested.thinking}, but Pi applied ${effective} at ${pi.getThinkingLevel()}`,
          );
        }
      }
      const sessionName = pi.getSessionName();
      const match = /^([a-z][a-z0-9-]{0,23})-planner$/.exec(sessionName ?? "");
      if (!match)
        throw new Error("Codeless activation requires an exact <slug>-planner Pi session name");
      const expectedPlanner = `${match[1].replaceAll("-", "_")}_planner`;
      const pane = process.env.HERDR_PANE_ID;
      if (!pane) throw new Error("Codeless activation requires a Herdr-managed planner pane");
      const plannerIdentity = async () => {
        const identity = await pi.exec("herdr", ["agent", "get", pane], { timeout: 30_000 });
        if (identity.code !== 0) {
          throw new Error(
            identity.stderr.trim() ||
              identity.stdout.trim() ||
              "Codeless could not verify Herdr planner identity",
          );
        }
        try {
          return JSON.parse(identity.stdout).result?.agent;
        } catch {
          throw new Error("Herdr returned an invalid planner identity response");
        }
      };
      let agent = await plannerIdentity();
      if (agent?.name === "pi") {
        const renamed = await pi.exec("herdr", ["agent", "rename", pane, expectedPlanner], {
          timeout: 30_000,
        });
        if (renamed.code !== 0) {
          throw new Error(
            renamed.stderr.trim() ||
              renamed.stdout.trim() ||
              "Codeless could not establish Herdr planner identity",
          );
        }
        agent = await plannerIdentity();
      }
      if (agent?.name !== expectedPlanner) {
        throw new Error(
          `Codeless planner identity is ${agent?.name ?? "missing"}, expected ${expectedPlanner}`,
        );
      }
      const activeTools = ctx.getSystemPromptOptions().selectedTools ?? [];
      const missing = requiredTools.filter((tool) => !activeTools.includes(tool));
      if (missing.length > 0) {
        throw new Error(
          `Codeless planner activation is missing required tools: ${missing.join(", ")}`,
        );
      }
      ctx.ui.notify(`Planner activated: ${sessionName} / ${expectedPlanner}`, "info");
      pi.sendUserMessage(prompt, { expandPromptTemplates: true });
    },
  });

  pi.registerCommand("streams-next", {
    description: "Finish a requested stream handoff and start a fresh planner session",
    handler: async (_args, ctx) => {
      if (!pending || pending.running) throw new Error("No pending Codeless handoff");
      const request = pending;
      request.running = true;
      try {
        await ctx.waitForIdle();
        const execution = await pi.exec(
          "bun",
          [codeless, "next", request.changePath, request.landedCommit],
          {
            timeout: 30_000,
          },
        );
        if (execution.code !== 0) {
          throw new Error(
            execution.stderr.trim() ||
              execution.stdout.trim() ||
              "Codeless handoff validation failed",
          );
        }
        const { sessionName, prompt, selection: requestedValue } = JSON.parse(execution.stdout);
        if (
          sessionName !== pi.getSessionName() ||
          typeof prompt !== "string" ||
          !prompt.startsWith("/change ")
        ) {
          throw new Error("Codeless returned an invalid planner handoff");
        }
        const requested = selection(requestedValue);
        const result = await ctx.newSession({
          setup: async (sm) => {
            sm.appendSessionInfo(sessionName);
            sm.appendCustomEntry("streams-role-selection", {
              role: "planner",
              selection: requested,
            });
          },
          withSession: async (replacement) => {
            await replacement.sendUserMessage(`/streams-activate ${JSON.stringify(prompt)}`, {
              expandPromptTemplates: true,
            });
          },
        });
        if (result.cancelled)
          throw new Error("Codeless handoff cancelled; the current session was retained");
      } finally {
        pending = undefined;
      }
    },
  });

  pi.on("session_start", () => {
    if (registered || !pi.getSessionName()?.endsWith("-planner")) return;
    registered = true;

    pi.registerTool({
      name: "next_stream_change",
      label: "Start next stream change",
      description:
        "After a successful landing and journal update, start a fresh planner session to propose the next change.",
      promptSnippet: "Start the next planning loop after recording a successful landing",
      promptGuidelines: [
        "Call next_stream_change exactly once after landing the latest approved change and recording its full commit hash in the planner journal.",
        "Finish this turn after requesting the handoff. The replacement planner proposes the next change and waits for approval. Stop on failure or cancellation; do not retry automatically.",
      ],
      parameters: {
        type: "object",
        properties: {
          changePath: {
            type: "string",
            description: "Absolute path to the completed changes/NNN.md file",
          },
          landedCommit: {
            type: "string",
            description: "Full landed commit hash recorded in planner.md",
          },
        },
        required: ["changePath", "landedCommit"],
        additionalProperties: false,
      },
      async execute(_toolCallId, params) {
        if (pending) throw new Error("A Codeless handoff is already pending");
        pending = {
          changePath: params.changePath.replace(/^@/, ""),
          landedCommit: params.landedCommit,
          running: false,
        };
        try {
          pi.sendUserMessage("/streams-next", {
            deliverAs: "followUp",
            expandPromptTemplates: true,
          });
        } catch (error) {
          pending = undefined;
          throw error;
        }
        return {
          content: [
            {
              type: "text",
              text: "Requested the next planning loop. Finish this turn so the handoff can validate the landing and start a fresh session.",
            },
          ],
        };
      },
    });

    pi.registerTool({
      name: "approve_stream_change",
      label: "Approve stream change",
      description:
        "Promote this planner's current proposal exactly once into an immutable numbered change and record its approval before dispatch.",
      promptSnippet: "Approve the current stream proposal after the operator says go",
      promptGuidelines: [
        "After an operator says go, call approve_stream_change exactly once. It allocates and records the approval but does not dispatch implementation.",
        "Use the returned changePath for one explicit dispatch_stream_implementer call. Keep rejection and revision conversational.",
      ],
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      async execute(_toolCallId, _params, signal) {
        const sessionName = pi.getSessionName();
        const session = /^([a-z][a-z0-9-]{0,23})-planner$/.exec(sessionName ?? "");
        if (!session) throw new Error("Approval requires an active <slug>-planner Pi session");
        const execution = await pi.exec("bun", [codeless, "approve", sessionName], {
          signal,
          timeout: 30_000,
        });
        const output = [execution.stdout.trim(), execution.stderr.trim()]
          .filter(Boolean)
          .join("\n");
        if (execution.code !== 0) {
          throw new Error(output || `codeless approve failed with exit code ${execution.code}`);
        }
        let approval;
        try {
          approval = JSON.parse(execution.stdout);
        } catch {
          throw new Error("Codeless returned an invalid approval");
        }
        if (
          typeof approval !== "object" ||
          approval === null ||
          typeof approval.number !== "string" ||
          !/^\d{3}$/.test(approval.number) ||
          typeof approval.changePath !== "string" ||
          !approval.changePath.startsWith("/") ||
          typeof approval.title !== "string" ||
          !approval.title
        ) {
          throw new Error("Codeless returned an invalid approval");
        }
        return {
          content: [
            {
              type: "text",
              text: `Approved ${approval.number}: ${approval.title}. Dispatch requires a separate explicit call.`,
            },
          ],
          details: approval,
        };
      },
    });

    pi.registerTool({
      name: "dispatch_stream_implementer",
      label: "Dispatch stream implementer",
      description:
        "Create or reuse this stream planner's right-hand Herdr pane, start a fresh Pi implementer in the correct worktree, submit one approved numbered change, wait for it to settle, and queue this planner's review.",
      promptSnippet: "Dispatch one approved stream change to a fresh Pi implementer",
      promptGuidelines: [
        "Use dispatch_stream_implementer exactly once after the operator approves and the numbered stream change file is created; never reproduce its Herdr pane or agent commands with bash.",
        "After successful dispatch, the tool queues the expanded review prompt for the planner; follow that queued instruction instead of ending the workflow after reporting implementation completion.",
      ],
      parameters: {
        type: "object",
        properties: {
          changePath: {
            type: "string",
            description: "Absolute path to an approved changes/NNN.md stream change file",
          },
        },
        required: ["changePath"],
        additionalProperties: false,
      },
      async execute(_toolCallId, params, signal) {
        const changePath = params.changePath.replace(/^@/, "");
        const execution = await pi.exec("bun", [codeless, "dispatch", changePath], {
          signal,
          timeout: 3_700_000,
        });
        const output = [execution.stdout.trim(), execution.stderr.trim()]
          .filter(Boolean)
          .join("\n");
        if (execution.code !== 0) {
          throw new Error(output || `codeless dispatch failed with exit code ${execution.code}`);
        }
        pi.sendUserMessage(`/review ${JSON.stringify(changePath)}`, {
          deliverAs: "steer",
          expandPromptTemplates: true,
        });
        return {
          content: [{ type: "text", text: output || "Implementer settled." }],
          details: { changePath },
        };
      },
    });
  });
}
