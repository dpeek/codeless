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
  let startedAt;
  let toolCalls = 0;
  let errorCount = 0;
  pi.on("session_start", () => {
    try {
      const value = JSON.parse(pi.getFlag("codeless-attempt") ?? "");
      if (
        typeof value?.path === "string" &&
        typeof value?.id === "string" &&
        typeof value?.stream === "string" &&
        typeof value?.change === "string"
      )
        configuration = value;
    } catch {}
  });
  pi.on("agent_start", () => {
    startedAt ??= new Date().toISOString();
  });
  pi.on("tool_execution_end", (event) => {
    toolCalls += 1;
    if (event.isError) errorCount += 1;
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (configuration === undefined) return;
    const report = configuration;
    configuration = undefined;
    const settledMessages = messages(ctx.sessionManager.getEntries());
    const final = [...settledMessages].reverse().find((message) => message.role === "assistant");
    const totals = sessionUsage(ctx.sessionManager.getEntries());
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
