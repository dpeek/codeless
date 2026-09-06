import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { type Attempt, validAttempt } from "./attempt.ts";

export type Metric = {
  stream: string;
  change: string;
  dispatchedAt?: string;
  landedAt?: string;
  landedCommit?: string;
  attempts?: Record<string, Attempt>;
};

function metricPath(workspaceRoot: string, stream: string, change: string): string {
  return join(workspaceRoot, "metrics", stream, `${change}.json`);
}

function readMetric(path: string): Metric {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${path} is not a metric record`);
  const metric = value as Record<string, unknown>;
  if (
    typeof metric["stream"] !== "string" ||
    typeof metric["change"] !== "string" ||
    (metric["dispatchedAt"] !== undefined && typeof metric["dispatchedAt"] !== "string") ||
    (metric["landedAt"] !== undefined && typeof metric["landedAt"] !== "string") ||
    (metric["landedCommit"] !== undefined && typeof metric["landedCommit"] !== "string") ||
    (metric["attempts"] !== undefined &&
      (typeof metric["attempts"] !== "object" ||
        metric["attempts"] === null ||
        Array.isArray(metric["attempts"]) ||
        !Object.entries(metric["attempts"] as Record<string, unknown>).every(
          ([id, attempt]) =>
            validAttempt(attempt, metric["stream"] as string, metric["change"] as string) &&
            attempt.id === id,
        )))
  )
    throw new Error(`${path} is not a metric record`);
  return metric as Metric;
}

function writeMetric(path: string, metric: Metric): void {
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(metric)}\n`, { flag: "wx" });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function recordDispatch(workspaceRoot: string, stream: string, change: string): void {
  const path = metricPath(workspaceRoot, stream, change);
  if (existsSync(path)) {
    const metric = readMetric(path);
    if (metric.stream !== stream || metric.change !== change)
      throw new Error(`${path} does not match ${stream} change ${change}`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}`;
  writeFileSync(
    temporary,
    `${JSON.stringify({ stream, change, dispatchedAt: new Date().toISOString() })}\n`,
    { flag: "wx" },
  );
  try {
    linkSync(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    unlinkSync(temporary);
  }
  readMetric(path);
}

function withMetricLock(path: string, action: () => void): void {
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      mkdirSync(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      Bun.sleepSync(10);
      continue;
    }
    try {
      action();
    } finally {
      rmdirSync(lock);
    }
    return;
  }
  throw new Error(`could not acquire metric lock ${lock}`);
}

export function recordAttempt(
  workspaceRoot: string,
  stream: string,
  change: string,
  attempt: Attempt,
): void {
  if (!validAttempt(attempt, stream, change))
    throw new Error("attempt is not a valid metric attempt");
  const path = metricPath(workspaceRoot, stream, change);
  withMetricLock(path, () => {
    const metric = existsSync(path) ? readMetric(path) : { stream, change };
    if (metric.stream !== stream || metric.change !== change)
      throw new Error(`${path} does not match ${stream} change ${change}`);
    const existing = metric.attempts?.[attempt.id];
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(attempt))
        throw new Error(`attempt ${attempt.id} conflicts with its existing metric record`);
      return;
    }
    writeMetric(path, { ...metric, attempts: { ...metric.attempts, [attempt.id]: attempt } });
  });
}

export function recordLanding(
  workspaceRoot: string,
  stream: string,
  change: string,
  commit: string,
): void {
  const path = metricPath(workspaceRoot, stream, change);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeMetric(path, { stream, change, landedAt: new Date().toISOString(), landedCommit: commit });
    return;
  }
  const metric = readMetric(path);
  if (metric.stream !== stream || metric.change !== change)
    throw new Error(`${path} does not match ${stream} change ${change}`);
  if (metric.landedAt !== undefined) return;
  writeMetric(path, { ...metric, landedAt: new Date().toISOString(), landedCommit: commit });
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0
    ? `${hours}h ${String(minutes).padStart(2, "0")}m`
    : `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export function metricReport(workspaceRoot: string): string[] {
  const root = join(workspaceRoot, "metrics");
  const byStream = new Map<string, Metric[]>();
  if (existsSync(root)) {
    for (const stream of readdirSync(root).sort()) {
      const directory = join(root, stream);
      if (!/^[a-z][a-z0-9-]{0,23}$/.test(stream) || !existsSync(directory)) continue;
      const records = readdirSync(directory)
        .filter((file) => /^\d{3}\.json$/.test(file))
        .sort()
        .map((file) => readMetric(join(directory, file)));
      if (records.length > 0) byStream.set(stream, records);
    }
  }
  const summary = (records: Metric[]) => {
    const landed = records.filter((record) => record.landedAt !== undefined);
    const elapsed = landed
      .map((record) => {
        const start = record.dispatchedAt === undefined ? NaN : Date.parse(record.dispatchedAt);
        const end = Date.parse(record.landedAt!);
        return Number.isFinite(start) && Number.isFinite(end) && end >= start
          ? end - start
          : undefined;
      })
      .filter((value): value is number => value !== undefined);
    const unavailable = landed.length - elapsed.length;
    return {
      landed: landed.length,
      unlanded: records.length - landed.length,
      coverage: `${elapsed.length} measured, ${unavailable} unavailable`,
      total:
        elapsed.length === 0 ? "unavailable" : formatElapsed(elapsed.reduce((a, b) => a + b, 0)),
      average:
        elapsed.length === 0
          ? "unavailable"
          : formatElapsed(elapsed.reduce((a, b) => a + b, 0) / elapsed.length),
    };
  };
  const row = (name: string, records: Metric[]) => {
    const value = summary(records);
    return `${name}\t${value.landed}\t${value.unlanded}\t${value.coverage}\t${value.total}\t${value.average}`;
  };
  const rows = [...byStream.entries()].map(([stream, records]) => ({ stream, records }));
  const allRecords = rows.flatMap(({ records }) => records);
  const formatCost = (amounts: number[]) => {
    const parts = amounts.map((amount) => {
      const [coefficient, exponent = "0"] = String(amount).toLowerCase().split("e");
      const [whole, fraction = ""] = coefficient!.split(".");
      return { digits: BigInt(`${whole}${fraction}`), scale: fraction.length - Number(exponent) };
    });
    const scale = Math.max(0, ...parts.map((part) => part.scale));
    const total = parts.reduce(
      (sum, part) => sum + part.digits * 10n ** BigInt(scale - part.scale),
      0n,
    );
    const digits = total.toString().padStart(scale + 1, "0");
    if (scale === 0) return digits;
    const fraction = digits.slice(-scale).replace(/0+$/, "");
    return fraction.length === 0
      ? digits.slice(0, -scale)
      : `${digits.slice(0, -scale)}.${fraction}`;
  };
  const attemptSummary = (records: Metric[]) => {
    const attempts = records.flatMap((record) => Object.values(record.attempts ?? {}));
    const usage = attempts.filter((attempt) => attempt.usage !== undefined);
    const costs = attempts.filter((attempt) => attempt.cost !== undefined);
    const outcomes = new Map<string, number>();
    const currencies = new Map<string, number[]>();
    for (const attempt of attempts) {
      outcomes.set(attempt.outcome, (outcomes.get(attempt.outcome) ?? 0) + 1);
      if (attempt.cost !== undefined)
        currencies.set(attempt.cost.currency, [
          ...(currencies.get(attempt.cost.currency) ?? []),
          attempt.cost.amount,
        ]);
    }
    const coverage = (measured: number) =>
      `${measured} measured, ${attempts.length - measured} unavailable`;
    return {
      reworkedChanges: new Set(
        records
          .filter((record) =>
            Object.values(record.attempts ?? {}).some((attempt) => attempt.kind === "rework"),
          )
          .map((record) => `${record.stream}\0${record.change}`),
      ).size,
      initial: attempts.filter((attempt) => attempt.kind === "initial").length,
      rework: attempts.filter((attempt) => attempt.kind === "rework").length,
      incomplete: attempts.filter((attempt) => attempt.incomplete).length,
      outcomes:
        outcomes.size === 0
          ? "none"
          : [...outcomes.entries()]
              .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
              .map(([outcome, count]) => `${outcome}: ${count}`)
              .join(", "),
      toolErrors: attempts.reduce((total, attempt) => total + attempt.errorCount, 0),
      usageCoverage: coverage(usage.length),
      input:
        usage.length === 0
          ? "unavailable"
          : usage.reduce((total, attempt) => total + attempt.usage!.input, 0),
      output:
        usage.length === 0
          ? "unavailable"
          : usage.reduce((total, attempt) => total + attempt.usage!.output, 0),
      cacheRead:
        usage.length === 0
          ? "unavailable"
          : usage.reduce((total, attempt) => total + attempt.usage!.cacheRead, 0),
      cacheWrite:
        usage.length === 0
          ? "unavailable"
          : usage.reduce((total, attempt) => total + attempt.usage!.cacheWrite, 0),
      costCoverage: coverage(costs.length),
      costs:
        currencies.size === 0
          ? "unavailable"
          : [...currencies.entries()]
              .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
              .map(([currency, amounts]) => `${currency} ${formatCost(amounts)}`)
              .join(", "),
    };
  };
  const attemptRow = (name: string, records: Metric[]) => {
    const value = attemptSummary(records);
    return `${name}\t${value.reworkedChanges}\t${value.initial}\t${value.rework}\t${value.incomplete}\t${value.outcomes}\t${value.toolErrors}\t${value.usageCoverage}\t${value.input}\t${value.output}\t${value.cacheRead}\t${value.cacheWrite}\t${value.costCoverage}\t${value.costs}`;
  };
  return [
    "Stream\tLanded\tNot landed\tElapsed coverage\tDispatch-to-land wall clock total\tAverage",
    ...rows.map(({ stream, records }) => row(stream, records)),
    row("Project total", allRecords),
    "",
    "Stream\tChanges with rework\tInitial attempts\tRework attempts\tIncomplete collection\tTerminal outcomes\tTool errors\tUsage coverage\tInput tokens\tOutput tokens\tCache-read tokens\tCache-write tokens\tCost coverage\tCost totals",
    ...rows.map(({ stream, records }) => attemptRow(stream, records)),
    attemptRow("Project total", allRecords),
  ];
}
