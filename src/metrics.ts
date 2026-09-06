import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export type Metric = {
  stream: string;
  change: string;
  dispatchedAt?: string;
  landedAt?: string;
  landedCommit?: string;
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
    (metric["landedCommit"] !== undefined && typeof metric["landedCommit"] !== "string")
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
  return [
    "Stream\tLanded\tNot landed\tElapsed coverage\tDispatch-to-land wall clock total\tAverage",
    ...rows.map(({ stream, records }) => row(stream, records)),
    row(
      "Project total",
      rows.flatMap(({ records }) => records),
    ),
  ];
}
