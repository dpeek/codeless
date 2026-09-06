export type Attempt = {
  id: string;
  stream: string;
  change: string;
  role: "implementer";
  startedAt: string;
  endedAt: string;
  selection?: { provider: string; model: string; thinking: string };
  outcome: string;
  text?: string;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  cost?: { amount: number; currency: string; source: string };
  toolCalls: number;
  errorCount: number;
  incomplete: boolean;
};

export function validAttempt(value: unknown, stream: string, change: string): value is Attempt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const attempt = value as Record<string, unknown>;
  const allowed = new Set([
    "id",
    "stream",
    "change",
    "role",
    "startedAt",
    "endedAt",
    "selection",
    "outcome",
    "text",
    "usage",
    "cost",
    "toolCalls",
    "errorCount",
    "incomplete",
  ]);
  const strings = ["id", "stream", "change", "role", "startedAt", "endedAt", "outcome"];
  if (
    !Object.keys(attempt).every((key) => allowed.has(key)) ||
    !strings.every((key) => typeof attempt[key] === "string" && attempt[key].length > 0) ||
    !Number.isFinite(Date.parse(attempt["startedAt"] as string)) ||
    !Number.isFinite(Date.parse(attempt["endedAt"] as string)) ||
    attempt["stream"] !== stream ||
    attempt["change"] !== change ||
    attempt["role"] !== "implementer" ||
    !Number.isSafeInteger(attempt["toolCalls"]) ||
    (attempt["toolCalls"] as number) < 0 ||
    !Number.isSafeInteger(attempt["errorCount"]) ||
    (attempt["errorCount"] as number) < 0 ||
    typeof attempt["incomplete"] !== "boolean"
  )
    return false;
  const selection = attempt["selection"];
  if (
    selection !== undefined &&
    (typeof selection !== "object" ||
      selection === null ||
      ["provider", "model", "thinking"].some(
        (key) =>
          typeof (selection as Record<string, unknown>)[key] !== "string" ||
          !(selection as Record<string, unknown>)[key],
      ))
  )
    return false;
  const usage = attempt["usage"];
  if (
    usage !== undefined &&
    (typeof usage !== "object" ||
      usage === null ||
      ["input", "output", "cacheRead", "cacheWrite"].some(
        (key) =>
          !Number.isSafeInteger((usage as Record<string, unknown>)[key]) ||
          ((usage as Record<string, unknown>)[key] as number) < 0,
      ))
  )
    return false;
  if (
    attempt["incomplete"] === false &&
    (selection === undefined ||
      usage === undefined ||
      attempt["outcome"] === "unknown" ||
      typeof attempt["text"] !== "string" ||
      attempt["text"].length === 0)
  )
    return false;
  const cost = attempt["cost"];
  if (
    cost !== undefined &&
    (usage === undefined ||
      typeof cost !== "object" ||
      cost === null ||
      !Number.isFinite((cost as Record<string, unknown>)["amount"]) ||
      ((cost as Record<string, unknown>)["amount"] as number) < 0 ||
      typeof (cost as Record<string, unknown>)["currency"] !== "string" ||
      !(cost as Record<string, unknown>)["currency"] ||
      typeof (cost as Record<string, unknown>)["source"] !== "string" ||
      !(cost as Record<string, unknown>)["source"])
  )
    return false;
  return attempt["text"] === undefined || typeof attempt["text"] === "string";
}
