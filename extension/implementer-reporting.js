import { existsSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

function text(message) {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return undefined;
  const value = message.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
  return value || undefined;
}

function validUsage(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    ["input", "output", "cacheRead", "cacheWrite"].every(
      (key) => Number.isFinite(value[key]) && value[key] >= 0,
    )
  );
}

function sessionUsage(entries) {
  const usages = [];
  for (const entry of entries) {
    if (
      entry?.type === "message" &&
      (entry.message?.role === "assistant" || entry.message?.role === "toolResult") &&
      validUsage(entry.message.usage)
    )
      usages.push(entry.message.usage);
    if (
      (entry?.type === "compaction" || entry?.type === "branch_summary") &&
      validUsage(entry.usage)
    )
      usages.push(entry.usage);
  }
  if (usages.length === 0) return undefined;
  const total = (key) => usages.reduce((sum, usage) => sum + usage[key], 0);
  const costs = usages.map((usage) => usage.cost?.total);
  return {
    input: total("input"),
    output: total("output"),
    cacheRead: total("cacheRead"),
    cacheWrite: total("cacheWrite"),
    ...(costs.every((cost) => Number.isFinite(cost) && cost >= 0)
      ? {
          cost: {
            amount: costs.reduce((sum, cost) => sum + cost, 0),
            currency: "USD",
            source: "pi-model-estimate",
          },
        }
      : {}),
  };
}

function messages(entries) {
  return entries
    .filter((entry) => entry?.type === "message")
    .map((entry) => entry.message)
    .filter((message) => message?.role === "assistant" || message?.role === "toolResult");
}

function write(path, value) {
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: "wx" });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export default function implementerReportingExtension(pi) {
  pi.registerFlag("codeless-attempt", { type: "string" });
  let configuration;
  let startupScope;
  let rearm;
  let startedAt;
  let entryOffset = 0;
  let toolCalls = 0;
  let errorCount = 0;

  function configure(value, offset = 0) {
    if (
      typeof value?.path !== "string" ||
      typeof value?.id !== "string" ||
      typeof value?.stream !== "string" ||
      typeof value?.change !== "string" ||
      !["initial", "rework"].includes(value?.kind)
    )
      throw new Error("Codeless attempt configuration is invalid");
    return { value, offset };
  }
  pi.on("session_start", () => {
    try {
      const value = JSON.parse(pi.getFlag("codeless-attempt") ?? "");
      configuration = configure(value).value;
      startupScope = { stream: configuration.stream, change: configuration.change };
    } catch {}
  });
  function requireScope(value) {
    if (
      startupScope === undefined ||
      value?.stream !== startupScope.stream ||
      value?.change !== startupScope.change
    )
      throw new Error("Codeless stream/change scope does not match this implementer session");
  }

  pi.registerCommand("codeless-rework", {
    description: "Submit one scope-verified Codeless implementer rework turn",
    handler: async (args, ctx) => {
      let value;
      try {
        value = JSON.parse(args);
      } catch {
        throw new Error("Codeless rework requires one JSON-quoted request");
      }
      requireScope(value);
      if (typeof value?.feedback !== "string" || value.feedback.trim().length === 0)
        throw new Error("Codeless rework requires concise non-empty feedback");
      const next = configure(value, ctx.sessionManager.getEntries().length);
      if (next.value.kind !== "rework") throw new Error("Codeless rework attempt must be rework");
      configuration = undefined;
      rearm = next;
      try {
        pi.sendUserMessage(`Review feedback: ${value.feedback.trim()}`, { deliverAs: "followUp" });
      } catch (error) {
        rearm = undefined;
        throw error;
      }
    },
  });

  pi.registerCommand("codeless-finish", {
    description: "Gracefully finish a scope-verified Codeless implementer",
    handler: async (args, ctx) => {
      let value;
      try {
        value = JSON.parse(args);
      } catch {
        throw new Error("Codeless finish requires one JSON-quoted scope");
      }
      requireScope(value);
      await ctx.shutdown();
    },
  });
  pi.on("agent_start", () => {
    if (rearm !== undefined) {
      configuration = rearm.value;
      entryOffset = rearm.offset;
      rearm = undefined;
      startedAt = new Date().toISOString();
      toolCalls = 0;
      errorCount = 0;
    } else {
      startedAt ??= new Date().toISOString();
    }
  });
  pi.on("tool_execution_end", (event) => {
    toolCalls += 1;
    if (event.isError) errorCount += 1;
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (configuration === undefined) return;
    const report = configuration;
    configuration = undefined;
    const entries = ctx.sessionManager.getEntries().slice(entryOffset);
    const settledMessages = messages(entries);
    const final = [...settledMessages].reverse().find((message) => message.role === "assistant");
    const totals = sessionUsage(entries);
    const model = final?.responseModel ?? final?.model ?? ctx.model?.id;
    const provider = final?.provider ?? ctx.model?.provider;
    const selection =
      typeof provider === "string" &&
      typeof model === "string" &&
      typeof pi.getThinkingLevel() === "string"
        ? { provider, model, thinking: pi.getThinkingLevel() }
        : undefined;
    const finalText = text(final);
    const complete =
      selection !== undefined &&
      typeof final?.stopReason === "string" &&
      final.stopReason.length > 0 &&
      finalText !== undefined &&
      totals !== undefined;
    write(report.path, {
      id: report.id,
      stream: report.stream,
      change: report.change,
      role: "implementer",
      kind: report.kind,
      startedAt: startedAt ?? new Date().toISOString(),
      endedAt: new Date().toISOString(),
      ...(selection === undefined ? {} : { selection }),
      outcome: final?.stopReason ?? "unknown",
      ...(finalText === undefined ? {} : { text: finalText }),
      ...(totals === undefined
        ? {}
        : {
            usage: {
              input: totals.input,
              output: totals.output,
              cacheRead: totals.cacheRead,
              cacheWrite: totals.cacheWrite,
            },
            ...(totals.cost === undefined ? {} : { cost: totals.cost }),
          }),
      toolCalls,
      errorCount,
      incomplete: !complete,
    });
  });
}
