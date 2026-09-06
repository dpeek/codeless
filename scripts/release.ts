#!/usr/bin/env bun

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Manifest = Record<string, unknown> & {
  name: string;
  version: string;
};

type Result = {
  code: number;
  stdout: string;
  stderr: string;
};

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(repository, "package.json");

function execute(command: string, args: string[], capture = false): Result {
  const process = Bun.spawnSync([command, ...args], {
    cwd: repository,
    env: Bun.env,
    stdin: "inherit",
    stdout: capture ? "pipe" : "inherit",
    stderr: capture ? "pipe" : "inherit",
  });

  return {
    code: process.exitCode,
    stdout: capture ? (process.stdout?.toString().trim() ?? "") : "",
    stderr: capture ? (process.stderr?.toString().trim() ?? "") : "",
  };
}

function run(command: string, args: string[]): void {
  const result = execute(command, args);
  if (result.code !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
}

function output(command: string, args: string[]): string {
  const result = execute(command, args, true);
  if (result.code !== 0) {
    throw new Error(result.stderr || `${command} ${args.join(" ")} failed`);
  }
  return result.stdout;
}

function requireClean(): void {
  if (output("git", ["status", "--porcelain"]) !== "") {
    throw new Error("The worktree must be clean before releasing");
  }
}

function nextPatch(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null) {
    throw new Error(`Expected a stable semantic version, received ${version}`);
  }

  const patch = Number(match[3]);
  if (!Number.isSafeInteger(patch) || patch === Number.MAX_SAFE_INTEGER) {
    throw new Error(`Cannot increment patch version ${version}`);
  }

  return `${match[1]}.${match[2]}.${patch + 1}`;
}

if (Bun.argv.length !== 2) {
  throw new Error("Usage: bun run release");
}

const branch = output("git", ["branch", "--show-current"]);
if (branch !== "main") {
  throw new Error(`Releases must run from main, not ${branch || "detached HEAD"}`);
}
requireClean();

const originalManifest = await Bun.file(manifestPath).text();
const manifest = JSON.parse(originalManifest) as Manifest;
if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
  throw new Error("package.json must contain a package name and version");
}

const version = nextPatch(manifest.version);
const tag = version;
if (execute("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`]).code === 0) {
  throw new Error(`Tag ${tag} already exists`);
}

run("npm", ["whoami"]);
const published = execute(
  "npm",
  ["view", `${manifest.name}@${version}`, "version", "--json"],
  true,
);
if (published.code === 0) {
  throw new Error(`${manifest.name}@${version} is already published`);
}
if (!published.stderr.includes("E404")) {
  throw new Error(published.stderr || "Could not check the npm registry");
}

run("bun", ["run", "check"]);
requireClean();
run("npm", ["pack", "--dry-run"]);
requireClean();

manifest.version = version;
await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

let committed = false;
try {
  run("git", ["add", "--", "package.json"]);
  const staged = output("git", ["diff", "--cached", "--name-only"]);
  if (staged !== "package.json") {
    throw new Error(`Expected only package.json to be staged, received: ${staged}`);
  }

  run("git", ["commit", "-m", version]);
  committed = true;
  requireClean();
  run("git", ["tag", tag]);

  const publish = execute("npm", ["publish", "--access", "public"]);
  if (publish.code !== 0) {
    throw new Error(
      `Publishing failed; commit and tag ${version} were retained. Fix npm authentication, then run npm publish --access public without bumping again.`,
    );
  }
} catch (error) {
  if (!committed) {
    execute("git", ["restore", "--staged", "--", "package.json"]);
    await Bun.write(manifestPath, originalManifest);
  }
  throw error;
}

console.log(
  `Published ${manifest.name}@${version} with tag ${tag}. Push the commit and tag when ready.`,
);
