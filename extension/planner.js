import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { validAttempt } from "../src/attempt.ts";

const codeless = fileURLToPath(new URL("../bin/codeless", import.meta.url));
const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const requiredTools = [
  "approve_stream_change",
  "dispatch_stream_implementer",
  "rework_stream_implementer",
  "finish_stream_implementer",
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

// Pi reloads extension modules when replacing a session. Keep only in-flight
// tickets on the process global; neither persisted entries nor a module cache
// can establish handoff provenance. Every ticket is removed on consume/finally.
const handoffKey = Symbol.for("@dpeek/codeless/planner-handoffs");
const handoffs = (globalThis[handoffKey] ??= new Map());

function worktree(cwd) {
  try {
    return realpathSync(cwd);
  } catch {
    throw new Error("Codeless could not resolve the planner worktree");
  }
}

export default function plannerExtension(pi) {
  let registered = false;
  let pending;
  let admitted;

  pi.registerCommand("streams-activate", {
    description: "Verify this planner session before starting its project prompt",
    handler: async (args, ctx) => {
      let input;
      try {
        input = JSON.parse(args);
      } catch {
        throw new Error("Codeless activation requires a JSON prompt or handoff ticket");
      }
      const replacement = typeof input === "object" && input !== null;
      const ticket = replacement ? handoffs.get(input.handoff) : undefined;
      if (replacement) {
        handoffs.delete(input.handoff);
        if (!ticket) throw new Error("Codeless handoff is missing, expired, or already consumed");
      } else if (typeof input !== "string" || !input.startsWith("/change ")) {
        throw new Error("Codeless activation requires a /change project prompt");
      }
      if (admitted) throw new Error("Codeless planner session is already activated");
      const sessionName = pi.getSessionName();
      const match = /^([a-z][a-z0-9-]{0,23})-planner$/.exec(sessionName ?? "");
      if (!match)
        throw new Error("Codeless activation requires an exact <slug>-planner Pi session name");
      const expectedPlanner = `${match[1].replaceAll("-", "_")}_planner`;
      const pane = process.env.HERDR_PANE_ID;
      if (!pane) throw new Error("Codeless activation requires a Herdr-managed planner pane");
      const cwd = worktree(ctx.cwd);
      const sessionId = ctx.sessionManager.getSessionId();
      if (replacement) {
        if (
          ticket.binding.pid !== process.pid ||
          ticket.binding.pane !== pane ||
          ticket.binding.cwd !== cwd ||
          ticket.binding.sessionName !== sessionName ||
          ticket.sessionId !== sessionId ||
          ticket.binding.sessionId === sessionId
        ) {
          throw new Error(
            "Codeless handoff does not match this planner process, pane, worktree, or session",
          );
        }
        const requested = ticket.selection;
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
          throw new Error(
            `Codeless planner could not apply ${reference} at thinking level ${requested.thinking}`,
          );
        }
      } else {
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
        const agent = await plannerIdentity();
        if (agent?.name !== expectedPlanner) {
          throw new Error(
            `Codeless planner identity is ${agent?.name ?? "missing"}, expected ${expectedPlanner}; exit this agent and run codeless open ${match[1]} from another Herdr shell`,
          );
        }
        if (agent.agent !== "pi" || agent.interactive_ready !== true) {
          throw new Error("Codeless requires a Herdr-managed Pi planner started by codeless open");
        }
        if (typeof agent.foreground_cwd !== "string" || worktree(agent.foreground_cwd) !== cwd) {
          throw new Error("Codeless planner worktree does not match Herdr's foreground cwd");
        }
        const session = agent.agent_session;
        if (
          agent.screen_detection_skipped !== true ||
          session?.source !== "herdr:pi" ||
          session.agent !== "pi"
        ) {
          throw new Error("Codeless planner requires Herdr's Pi lifecycle integration");
        }
      }
      const activeTools = ctx.getSystemPromptOptions().selectedTools ?? [];
      const missing = requiredTools.filter((tool) => !activeTools.includes(tool));
      if (missing.length > 0) {
        throw new Error(
          `Codeless planner activation is missing required tools: ${missing.join(", ")}`,
        );
      }
      admitted = { pid: process.pid, pane, cwd, sessionName, sessionId };
      ctx.ui.notify(`Planner activated: ${sessionName} / ${expectedPlanner}`, "info");
      if (ticket) ticket.activated = true;
      else pi.sendUserMessage(input, { expandPromptTemplates: true });
    },
  });

  pi.registerCommand("streams-next", {
    description: "Finish a requested stream handoff and start a fresh planner session",
    handler: async (_args, ctx) => {
      if (!pending || pending.running) throw new Error("No pending Codeless handoff");
      const request = pending;
      request.running = true;
      let token;
      try {
        await ctx.waitForIdle();
        if (
          !admitted ||
          admitted.pid !== process.pid ||
          admitted.pane !== process.env.HERDR_PANE_ID ||
          admitted.cwd !== worktree(ctx.cwd) ||
          admitted.sessionId !== ctx.sessionManager.getSessionId() ||
          admitted.sessionName !== pi.getSessionName()
        )
          throw new Error("Codeless handoff requires the activated planner session");
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
        token = randomUUID();
        const ticket = {
          binding: admitted,
          selection: requested,
          sessionId: undefined,
          activated: false,
        };
        handoffs.set(token, ticket);
        const result = await ctx.newSession({
          setup: async (sm) => {
            sm.appendSessionInfo(sessionName);
            ticket.sessionId = sm.getSessionId();
          },
          withSession: async (replacement) => {
            await replacement.sendUserMessage(
              `/streams-activate ${JSON.stringify({ handoff: token })}`,
              {
                expandPromptTemplates: true,
              },
            );
            // Pi displays command errors instead of rejecting sendUserMessage.
            // Require an explicit receipt before submitting the project prompt.
            if (!ticket.activated)
              throw new Error(
                "Codeless replacement activation failed; exit Pi and reopen the stream",
              );
            await replacement.sendUserMessage(prompt, { expandPromptTemplates: true });
          },
        });
        if (result.cancelled)
          throw new Error("Codeless handoff cancelled; the current session was retained");
      } finally {
        if (token) handoffs.delete(token);
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
        if (!admitted) throw new Error("Codeless handoff requires an activated planner");
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
      name: "rework_stream_implementer",
      label: "Remediate stream implementation",
      description:
        "Reuse the idle implementer for this approved change, submit one actionable feedback turn, collect its rework attempt, and queue review again.",
      promptSnippet: "Send one concise remediation request to the existing stream implementer",
      promptGuidelines: [
        "Call rework_stream_implementer only when review finds actionable defects in the approved change. Use its approved changePath and concise feedback; never reproduce Herdr commands.",
        "The tool queues review only after a settled rework attempt. Stop on any error and do not retry automatically.",
      ],
      parameters: {
        type: "object",
        properties: {
          changePath: {
            type: "string",
            description: "Absolute path to the approved changes/NNN.md file",
          },
          feedback: { type: "string", description: "Concise actionable review feedback" },
        },
        required: ["changePath", "feedback"],
        additionalProperties: false,
      },
      async execute(_toolCallId, params, signal) {
        const changePath = params.changePath.replace(/^@/, "");
        const execution = await pi.exec("bun", [codeless, "rework", changePath, params.feedback], {
          signal,
          timeout: 3_700_000,
        });
        const output = [execution.stdout.trim(), execution.stderr.trim()]
          .filter(Boolean)
          .join("\n");
        if (execution.code !== 0)
          throw new Error(output || `codeless rework failed with exit code ${execution.code}`);
        let attempt;
        try {
          attempt = JSON.parse(execution.stdout);
        } catch {
          throw new Error("Codeless returned an invalid rework attempt");
        }
        if (!validAttempt(attempt, attempt?.stream, attempt?.change) || attempt.kind !== "rework")
          throw new Error("Codeless returned an invalid rework attempt");
        pi.sendUserMessage(`/review ${JSON.stringify(changePath)}`, {
          deliverAs: "steer",
          expandPromptTemplates: true,
        });
        return {
          content: [{ type: "text", text: attempt.text || "Implementer rework settled." }],
          details: { changePath, attempt },
        };
      },
    });

    pi.registerTool({
      name: "finish_stream_implementer",
      label: "Finish stream implementer",
      description:
        "Gracefully exit the verified idle implementer after review approval and confirm its right-hand pane returned to the stream shell.",
      promptSnippet: "Finish the approved stream implementer before commit and landing",
      promptGuidelines: [
        "Call finish_stream_implementer exactly once after recording review approval and before following commit-and-land instructions.",
        "Stop on failure; do not use Herdr commands or continue to commit and land.",
      ],
      parameters: {
        type: "object",
        properties: {
          changePath: {
            type: "string",
            description: "Absolute path to the approved changes/NNN.md file",
          },
        },
        required: ["changePath"],
        additionalProperties: false,
      },
      async execute(_toolCallId, params, signal) {
        const changePath = params.changePath.replace(/^@/, "");
        const execution = await pi.exec("bun", [codeless, "finish", changePath], {
          signal,
          timeout: 35_000,
        });
        const output = [execution.stdout.trim(), execution.stderr.trim()]
          .filter(Boolean)
          .join("\n");
        if (execution.code !== 0)
          throw new Error(output || `codeless finish failed with exit code ${execution.code}`);
        return {
          content: [
            { type: "text", text: "Implementer exited and its pane returned to the stream shell." },
          ],
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
        let attempt;
        try {
          attempt = JSON.parse(execution.stdout);
        } catch {
          throw new Error("Codeless returned an invalid implementer attempt");
        }
        if (!validAttempt(attempt, attempt?.stream, attempt?.change)) {
          throw new Error("Codeless returned an invalid implementer attempt");
        }
        pi.sendUserMessage(`/review ${JSON.stringify(changePath)}`, {
          deliverAs: "steer",
          expandPromptTemplates: true,
        });
        return {
          content: [{ type: "text", text: attempt.text || "Implementer settled." }],
          details: { changePath, attempt },
        };
      },
    });
  });
}
