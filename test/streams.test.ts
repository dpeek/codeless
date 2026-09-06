import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packageRoot = join(import.meta.dir, "..");
const executable = join(packageRoot, "bin/codeless");
const directories: string[] = [];
const mockPiDirectory = realpathSync(mkdtempSync(join(tmpdir(), "streams-pi ")));
const mockPi = join(mockPiDirectory, "pi");
writeFileSync(
  mockPi,
  `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
if (process.env.STREAMS_TEST_PI_TRACE) appendFileSync(process.env.STREAMS_TEST_PI_TRACE, JSON.stringify({ args }) + "\\n");
if (!args.includes("rpc")) {
  console.log(JSON.stringify(args));
  process.exit(0);
}
const configured = process.env.STREAMS_TEST_PI_MODELS
  ? JSON.parse(process.env.STREAMS_TEST_PI_MODELS)
  : [
      { provider: "openai-codex", id: "gpt-5.6-sol", levels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
      { provider: "openai-codex", id: "gpt-5.6-terra", levels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
    ];
let model = configured[0];
let thinkingLevel = "off";
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (process.env.STREAMS_TEST_PI_TRACE) appendFileSync(process.env.STREAMS_TEST_PI_TRACE, JSON.stringify({ request }) + "\\n");
  let success = true;
  let data;
  let error;
  if (request.type === "get_available_models") {
    data = { models: configured.map(({ levels, ...entry }) => entry) };
  } else if (request.type === "set_model") {
    model = configured.find((entry) => entry.provider === request.provider && entry.id === request.modelId);
    success = model !== undefined;
    data = model;
    if (!success) error = "Model not found";
  } else if (request.type === "get_available_thinking_levels") {
    data = { levels: model?.levels ?? ["off"] };
  } else if (request.type === "set_thinking_level") {
    thinkingLevel = model?.levels.includes(request.level) ? request.level : "off";
  } else if (request.type === "get_commands") {
    data = { commands: process.env.STREAMS_TEST_PI_COMMANDS ? JSON.parse(process.env.STREAMS_TEST_PI_COMMANDS) : [{ name: "streams-activate" }] };
  } else if (request.type === "get_state") {
    const { levels, ...selected } = model;
    data = { model: selected, thinkingLevel };
  }
  console.log(JSON.stringify({ id: request.id, type: "response", command: request.type, success, ...(data === undefined ? {} : { data }), ...(error ? { error } : {}) }));
}
`,
);
chmodSync(mockPi, 0o755);
const environment = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  PATH: `${mockPiDirectory}:${process.env["PATH"]}`,
};

afterAll(() => rmSync(mockPiDirectory, { recursive: true, force: true }));

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const child = Bun.spawnSync(["git", ...args], { cwd, env: environment });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  return child.stdout.toString().trim();
}

function fixture(integrationBranch = "main") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "streams ")));
  directories.push(root);
  const personal = join(root, "project");
  const workspace = join(personal, ".codeless/state");
  const main = join(root, "integration checkout");
  const stream = join(workspace, "worktree", "queries");
  const documents = join(workspace, "stream", "queries");
  mkdirSync(personal);
  git(personal, "init", "--initial-branch=dev");
  git(personal, "config", "user.name", "Codeless test");
  git(personal, "config", "user.email", "streams-test@example.invalid");
  git(personal, "config", "core.hooksPath", "/dev/null");
  mkdirSync(join(personal, "briefs"));
  mkdirSync(join(personal, ".codeless"));
  mkdirSync(join(personal, "instructions"));
  for (const name of ["change", "implement", "review", "commit"]) {
    writeFileSync(join(personal, "instructions", `${name}.md`), `Fixture ${name} prompt.\n`);
  }
  writeFileSync(join(personal, ".gitignore"), ".installed.json\n/.codeless/state/\n");
  writeFileSync(
    join(personal, ".codeless/config.json"),
    JSON.stringify({
      integrationBranch,
      directions: "briefs",
      prompts: "instructions",
      install: [
        process.execPath,
        "-e",
        'await Bun.write(".installed.json", JSON.stringify({cwd: process.cwd(), args: process.argv.slice(1)}))',
        "two words",
      ],
      check: [process.execPath, "run", "check"],
      planner: {
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        thinking: "high",
      },
      implementer: {
        provider: "openai-codex",
        model: "gpt-5.6-terra",
        thinking: "medium",
      },
    }),
  );
  writeFileSync(
    join(personal, "package.json"),
    JSON.stringify({ scripts: { check: "bun -e 'process.exit(0)'" } }),
  );
  writeFileSync(join(personal, "briefs/queries.md"), "# Queries\n\nCurrent direction.\n");
  writeFileSync(join(personal, "value.txt"), "base\n");
  git(personal, "add", ".");
  git(personal, "commit", "-m", "Initial current model");
  git(personal, "branch", integrationBranch);
  git(personal, "worktree", "add", main, integrationBranch);
  git(personal, "worktree", "add", "-b", "stream/queries", stream, integrationBranch);
  mkdirSync(join(documents, "changes"), { recursive: true });
  writeFileSync(join(documents, "planner.md"), "# Planner\n");
  writeFileSync(join(documents, "change.md"), "# Next change\n");
  return { root, personal, workspace, main, stream, documents };
}

function uninitializedFixture() {
  const f = fixture();
  git(f.personal, "worktree", "remove", "--force", f.stream);
  git(f.personal, "worktree", "remove", "--force", f.main);
  rmSync(f.workspace, { recursive: true, force: true });
  writeFileSync(join(f.personal, ".gitignore"), ".installed.json\n");
  return f;
}

function change(cwd: string, file: string, content: string, message = "One change"): string {
  writeFileSync(join(cwd, file), content);
  git(cwd, "add", file);
  git(cwd, "commit", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

function streams(cwd: string, args: string[], extraEnv: Record<string, string> = {}) {
  const child = Bun.spawnSync([process.execPath, executable, ...args], {
    cwd,
    env: { ...environment, ...extraEnv },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
}

describe("Codeless integration", () => {
  test("init bootstraps and reuses the default shared workspace without Herdr", () => {
    const f = uninitializedFixture();
    const result = streams(f.personal, ["init"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain(`Integration branch: main`);
    expect(result.stdout).toContain(`Primary checkout: ${f.personal}`);
    expect(result.stdout).toContain(`Workspace: ${f.workspace}`);
    expect(result.stdout).toContain(`Integration worktree: ${join(f.workspace, "worktree/main")}`);
    expect(readFileSync(join(f.personal, ".gitignore"), "utf8")).toBe(
      ".installed.json\n/.codeless/state/\n",
    );
    for (const directory of ["stream", "worktree", "metrics", "worktree/main"]) {
      expect(statSync(join(f.workspace, directory)).isDirectory()).toBe(true);
    }
    const before = readFileSync(join(f.personal, ".gitignore"), "utf8");
    const head = git(join(f.workspace, "worktree/main"), "rev-parse", "HEAD");
    expect(streams(f.personal, ["init"])).toMatchObject({ code: 0, stderr: "" });
    expect(readFileSync(join(f.personal, ".gitignore"), "utf8")).toBe(before);
    expect(git(join(f.workspace, "worktree/main"), "rev-parse", "HEAD")).toBe(head);
  });

  test("init supports an absolute workspace without changing repository ignores", () => {
    const f = uninitializedFixture();
    const workspace = join(f.root, "custom workspace");
    const ignore = readFileSync(join(f.personal, ".gitignore"), "utf8");
    git(f.personal, "config", "codeless.workspaceRoot", workspace);
    const result = streams(f.personal, ["init"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain(`Workspace: ${workspace}`);
    expect(existsSync(join(workspace, "worktree/main"))).toBe(true);
    expect(readFileSync(join(f.personal, ".gitignore"), "utf8")).toBe(ignore);
  });

  test("init does not inspect repository ignores for a custom workspace", () => {
    const f = uninitializedFixture();
    const workspace = join(f.root, "custom workspace");
    rmSync(join(f.personal, ".gitignore"));
    mkdirSync(join(f.personal, ".gitignore"));
    git(f.personal, "config", "codeless.workspaceRoot", workspace);
    expect(streams(f.personal, ["init"])).toMatchObject({ code: 0, stderr: "" });
    expect(statSync(join(f.personal, ".gitignore")).isDirectory()).toBe(true);
  });

  test("init leaves occupied or incompatible integration worktrees untouched", () => {
    const occupied = uninitializedFixture();
    const target = join(occupied.workspace, "worktree/main");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "user-file"), "keep\n");
    const ignore = readFileSync(join(occupied.personal, ".gitignore"), "utf8");
    const blocked = streams(occupied.personal, ["init"]);
    expect(blocked.stderr).toContain("Integration worktree target is occupied");
    expect(readFileSync(join(target, "user-file"), "utf8")).toBe("keep\n");
    expect(readFileSync(join(occupied.personal, ".gitignore"), "utf8")).toBe(ignore);

    const incompatible = uninitializedFixture();
    const elsewhere = join(incompatible.root, "elsewhere");
    git(incompatible.personal, "worktree", "add", elsewhere, "main");
    const rejected = streams(incompatible.personal, ["init"]);
    expect(rejected.stderr).toContain(`main is checked out at ${elsewhere}`);
    expect(existsSync(join(incompatible.workspace, "worktree/main"))).toBe(false);
    expect(readFileSync(join(incompatible.personal, ".gitignore"), "utf8")).toBe(
      ".installed.json\n",
    );
  });

  test("init rejects invalid setup before changing repository state", () => {
    const missingBranch = uninitializedFixture();
    git(missingBranch.personal, "branch", "-D", "main");
    const before = readFileSync(join(missingBranch.personal, ".gitignore"), "utf8");
    expect(streams(missingBranch.personal, ["init"]).stderr).toContain("refs/heads/main");
    expect(existsSync(missingBranch.workspace)).toBe(false);
    expect(readFileSync(join(missingBranch.personal, ".gitignore"), "utf8")).toBe(before);

    const broadIgnore = uninitializedFixture();
    writeFileSync(join(broadIgnore.personal, ".gitignore"), "/.codeless/\n");
    const blocked = streams(broadIgnore.personal, ["init"]);
    expect(blocked.stderr).toContain("conflicts with Codeless configuration or prompts");
    expect(existsSync(broadIgnore.workspace)).toBe(false);
    expect(readFileSync(join(broadIgnore.personal, ".gitignore"), "utf8")).toBe("/.codeless/\n");

    const invalidConfig = uninitializedFixture();
    rmSync(join(invalidConfig.personal, ".codeless/config.json"));
    expect(streams(invalidConfig.personal, ["init"]).stderr).toContain(
      "Invalid Codeless project configuration",
    );
    expect(existsSync(invalidConfig.workspace)).toBe(false);
  });

  test("init recognizes effective ignore rules and protects configured prompt files", () => {
    const valid = uninitializedFixture();
    writeFileSync(join(valid.personal, ".gitignore"), "/.codeless/state/\n");
    expect(streams(valid.personal, ["init"])).toMatchObject({ code: 0, stderr: "" });
    expect(readFileSync(join(valid.personal, ".gitignore"), "utf8")).toBe("/.codeless/state/\n");

    const negated = uninitializedFixture();
    writeFileSync(
      join(negated.personal, ".gitignore"),
      "/.codeless/*\n!/.codeless/config.json\n!/.codeless/state/\n",
    );
    expect(streams(negated.personal, ["init"])).toMatchObject({ code: 0, stderr: "" });
    expect(readFileSync(join(negated.personal, ".gitignore"), "utf8")).toBe(
      "/.codeless/*\n!/.codeless/config.json\n!/.codeless/state/\n/.codeless/state/\n",
    );

    const ignoredPrompts = uninitializedFixture();
    writeFileSync(join(ignoredPrompts.personal, ".gitignore"), "/instructions/*.md\n");
    const blocked = streams(ignoredPrompts.personal, ["init"]);
    expect(blocked.stderr).toContain("conflicts with Codeless configuration or prompts");
    expect(existsSync(ignoredPrompts.workspace)).toBe(false);
  });

  test("approval exclusively promotes a valid current proposal and reconciles retries", () => {
    const f = fixture();
    const proposal = `# Safe approval\n\n## Why\n\nBecause.\n\n## Change\n\nDo it.\n\n## Acceptance\n\nIt works.\n\n## Decisions\n\nNone.\n`;
    writeFileSync(join(f.documents, "change.md"), proposal);
    const mockBin = join(f.root, "approve-mock-bin");
    mkdirSync(mockBin);
    writeFileSync(
      join(mockBin, "herdr"),
      `#!/usr/bin/env bun
const args = process.argv.slice(2);
let result = {};
if (args[0] === "agent" && args[1] === "get") result = { agent: { name: process.env.STREAMS_TEST_AGENT_NAME ?? "queries_planner" } };
if (args[0] === "pane" && args[1] === "process-info") result = { process_info: { foreground_processes: [{ argv0: "pi", cwd: process.cwd() }] } };
console.log(JSON.stringify({ result }));
`,
    );
    chmodSync(join(mockBin, "herdr"), 0o755);
    const env = {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "planner",
      PATH: `${mockBin}:${environment.PATH}`,
    };
    const approve = (session = "queries-planner", extraEnv: Record<string, string> = {}) =>
      streams(f.stream, ["approve", session], { ...env, ...extraEnv });
    const first = approve();
    expect(first.code).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({
      number: "001",
      changePath: join(f.documents, "changes/001.md"),
      title: "Safe approval",
    });
    const journal = readFileSync(join(f.documents, "planner.md"), "utf8");
    expect(journal).toContain("Approved `changes/001.md` — “Safe approval”");
    expect(readFileSync(join(f.documents, "changes/001.md"), "utf8")).toBe(proposal);
    expect(approve().stdout).toBe(first.stdout);
    expect(readFileSync(join(f.documents, "planner.md"), "utf8")).toBe(journal);

    rmSync(join(f.documents, "changes/001.md"));
    expect(approve().stdout).toBe(first.stdout);
    expect(readFileSync(join(f.documents, "changes/001.md"), "utf8")).toBe(proposal);
    writeFileSync(join(f.documents, "planner.md"), "# Planner\n");
    const fileOnly = approve();
    expect(fileOnly.code).toBe(0);
    expect(fileOnly.stdout).toBe(first.stdout);
    expect(readFileSync(join(f.documents, "planner.md"), "utf8")).toContain(
      "Approved `changes/001.md` — “Safe approval”",
    );

    const malformed = fixture();
    const before = readFileSync(join(malformed.documents, "planner.md"), "utf8");
    expect(streams(malformed.stream, ["approve", "queries-planner"], env).code).toBe(1);
    expect(readFileSync(join(malformed.documents, "planner.md"), "utf8")).toBe(before);
    expect(existsSync(join(malformed.documents, "changes/001.md"))).toBe(false);

    const unchangedJournal = readFileSync(join(f.documents, "planner.md"), "utf8");
    expect(approve("relationships-planner").stderr).toContain("does not match queries-planner");
    expect(
      approve("queries-planner", { STREAMS_TEST_AGENT_NAME: "queries_impl" }).stderr,
    ).toContain("planner queries_planner");
    expect(readFileSync(join(f.documents, "planner.md"), "utf8")).toBe(unchangedJournal);

    const dirty = fixture();
    writeFileSync(join(dirty.documents, "change.md"), proposal);
    const dirtyJournal = readFileSync(join(dirty.documents, "planner.md"), "utf8");
    writeFileSync(join(dirty.stream, "value.txt"), "dirty\n");
    expect(streams(dirty.stream, ["approve", "queries-planner"], env).stderr).toContain(
      "not clean",
    );
    expect(readFileSync(join(dirty.documents, "planner.md"), "utf8")).toBe(dirtyJournal);

    const diverged = fixture();
    writeFileSync(join(diverged.documents, "change.md"), proposal);
    const divergedJournal = readFileSync(join(diverged.documents, "planner.md"), "utf8");
    change(diverged.stream, "feature.txt", "unlanded\n");
    expect(streams(diverged.stream, ["approve", "queries-planner"], env).stderr).toContain(
      "current main baseline",
    );
    expect(readFileSync(join(diverged.documents, "planner.md"), "utf8")).toBe(divergedJournal);

    const conflicting = fixture();
    writeFileSync(join(conflicting.documents, "change.md"), proposal);
    expect(streams(conflicting.stream, ["approve", "queries-planner"], env).code).toBe(0);
    writeFileSync(
      join(conflicting.documents, "changes/001.md"),
      proposal.replace("Safe approval", "Conflicting approval"),
    );
    const conflictJournal = readFileSync(join(conflicting.documents, "planner.md"), "utf8");
    expect(streams(conflicting.stream, ["approve", "queries-planner"], env).stderr).toContain(
      "conflicts",
    );
    expect(readFileSync(join(conflicting.documents, "planner.md"), "utf8")).toBe(conflictJournal);

    const partial = fixture();
    writeFileSync(join(partial.documents, "change.md"), proposal);
    expect(streams(partial.stream, ["approve", "queries-planner"], env).code).toBe(0);
    appendFileSync(join(partial.documents, "planner.md"), "\n## 2026-01-01 — Change approved\n");
    const partialJournal = readFileSync(join(partial.documents, "planner.md"), "utf8");
    expect(streams(partial.stream, ["approve", "queries-planner"], env).stderr).toContain(
      "malformed approval entry",
    );
    expect(readFileSync(join(partial.documents, "planner.md"), "utf8")).toBe(partialJournal);

    const unsupportedTitle = fixture();
    writeFileSync(
      join(unsupportedTitle.documents, "change.md"),
      proposal.replace("Safe approval", "Bad ” title"),
    );
    const titleJournal = readFileSync(join(unsupportedTitle.documents, "planner.md"), "utf8");
    expect(streams(unsupportedTitle.stream, ["approve", "queries-planner"], env).stderr).toContain(
      "closing quotation mark",
    );
    expect(readFileSync(join(unsupportedTitle.documents, "planner.md"), "utf8")).toBe(titleJournal);

    const gapped = fixture();
    writeFileSync(join(gapped.documents, "change.md"), proposal);
    writeFileSync(join(gapped.documents, "changes/001.md"), "old\n");
    writeFileSync(join(gapped.documents, "changes/003.md"), "old\n");
    expect(
      JSON.parse(streams(gapped.stream, ["approve", "queries-planner"], env).stdout).number,
    ).toBe("004");

    const exhausted = fixture();
    writeFileSync(join(exhausted.documents, "change.md"), proposal);
    writeFileSync(join(exhausted.documents, "changes/999.md"), "old\n");
    const exhaustedBefore = readFileSync(join(exhausted.documents, "planner.md"), "utf8");
    const exhaustion = streams(exhausted.stream, ["approve", "queries-planner"], env);
    expect(exhaustion.stderr).toContain("after 999");
    expect(readFileSync(join(exhausted.documents, "planner.md"), "utf8")).toBe(exhaustedBefore);
  });

  test("prepares the next loop from the current integration commit without replacing the journal", () => {
    const f = fixture("integration");
    const approved = join(f.documents, "changes/001.md");
    writeFileSync(approved, "# Approved change\n");
    const commit = change(f.stream, "feature.txt", "completed change\n");
    expect(streams(f.stream, ["land", "queries"]).code).toBe(0);
    const journal = `# Planner\n\nLanded 001.md on integration at ${commit}.\n`;
    writeFileSync(join(f.documents, "planner.md"), journal);
    const config = JSON.parse(readFileSync(join(f.main, ".codeless/config.json"), "utf8"));
    config.directions = "new-briefs";
    config.planner = {
      provider: "openai-codex",
      model: "gpt-5.6-terra",
      thinking: "medium",
    };
    mkdirSync(join(f.main, "new-briefs"));
    writeFileSync(join(f.main, "new-briefs/queries.md"), "# Next direction\n");
    writeFileSync(join(f.main, ".codeless/config.json"), JSON.stringify(config));
    git(f.main, "add", ".");
    git(f.main, "commit", "-m", "Update project direction");
    const current = git(f.main, "rev-parse", "HEAD");
    const lock = join(f.workspace, ".land-lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), "relationships\n");
    const result = streams(f.stream, ["next", approved, commit]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      sessionName: "queries-planner",
      prompt: `/change ${JSON.stringify(f.documents)} ${JSON.stringify(join(f.stream, "new-briefs/queries.md"))}`,
      selection: {
        provider: "openai-codex",
        model: "gpt-5.6-terra",
        thinking: "medium",
      },
    });
    expect(git(f.stream, "rev-parse", "HEAD")).toBe(current);
    expect(git(f.personal, "rev-parse", "HEAD")).not.toBe(current);
    expect(readFileSync(join(f.documents, "planner.md"), "utf8")).toBe(journal);
    expect(readFileSync(join(lock, "owner"), "utf8")).toBe("relationships\n");
    expect(streams(f.stream, ["next", approved, commit]).code).toBe(0);
  });

  test("next-loop preparation refuses incomplete landing, unsaved outcomes, and unresolved locks", () => {
    const f = fixture();
    const approved = join(f.documents, "changes/001.md");
    writeFileSync(approved, "# Approved change\n");
    const commit = change(f.stream, "feature.txt", "change\n");
    expect(streams(f.stream, ["next", approved, commit]).stderr).toContain(
      "Record the landed commit",
    );
    writeFileSync(join(f.documents, "planner.md"), `Landed ${commit}\n`);
    expect(streams(f.stream, ["next", approved, commit]).stderr).toContain("unlanded or diverged");
    expect(git(f.stream, "rev-parse", "HEAD")).toBe(commit);
    expect(streams(f.stream, ["land", "queries"]).code).toBe(0);
    writeFileSync(join(f.stream, "dirty.txt"), "active work\n");
    expect(streams(f.stream, ["next", approved, commit]).stderr).toContain("not clean");
    rmSync(join(f.stream, "dirty.txt"));
    const lock = join(f.workspace, ".land-lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), "queries\n");
    expect(streams(f.stream, ["next", approved, commit]).stderr).toContain(
      "still needs resolution",
    );
    expect(existsSync(lock)).toBe(true);
  });

  test("next-loop preparation cannot target another worktree or an older approved change", () => {
    const f = fixture();
    const approved = join(f.documents, "changes/001.md");
    writeFileSync(approved, "# Approved change\n");
    const commit = git(f.stream, "rev-parse", "HEAD");
    expect(streams(f.personal, ["next", approved, commit]).stderr).toContain("Next-loop cwd");
    writeFileSync(join(f.documents, "changes/002.md"), "# Active approved change\n");
    expect(streams(f.stream, ["next", approved, commit]).stderr).toContain(
      "latest approved change",
    );
  });

  test("next-loop preparation stops if the updated project no longer supplies a required prompt", () => {
    const f = fixture();
    const approved = join(f.documents, "changes/001.md");
    writeFileSync(approved, "# Approved change\n");
    const commit = git(f.stream, "rev-parse", "HEAD");
    writeFileSync(join(f.documents, "planner.md"), `Landed ${commit}\n`);
    rmSync(join(f.main, "instructions/change.md"));
    git(f.main, "add", ".");
    git(f.main, "commit", "-m", "Remove project prompt");
    const result = streams(f.stream, ["next", approved, commit]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Missing project prompt");
    expect(result.stdout).toBe("");
  });

  test("dispatch records valid requests before an unavailable model preflight", () => {
    const f = fixture();
    const approved = join(f.documents, "changes/001.md");
    writeFileSync(approved, "# Approved change\n");
    const unavailable = streams(f.stream, ["dispatch", approved], {
      HERDR_ENV: "1",
      STREAMS_TEST_PI_MODELS: JSON.stringify([
        { provider: "openai-codex", id: "gpt-5.6-sol", levels: ["off", "high"] },
      ]),
    });
    expect(unavailable.code).toBe(1);
    expect(unavailable.stderr).toContain("is not available");
    expect(
      JSON.parse(readFileSync(join(f.workspace, "metrics/queries/001.json"), "utf8")),
    ).toMatchObject({
      stream: "queries",
      change: "001",
    });

    const rejected = fixture();
    const rejectedChange = join(rejected.documents, "changes/001.md");
    writeFileSync(rejectedChange, "# Approved change\n");
    expect(
      streams(rejected.personal, ["dispatch", rejectedChange], { HERDR_ENV: "1" }).stderr,
    ).toContain("Dispatch cwd");
    expect(existsSync(join(rejected.workspace, "metrics/queries/001.json"))).toBe(false);

    const malformed = fixture();
    const malformedChange = join(malformed.documents, "changes/001.md");
    writeFileSync(malformedChange, "# Approved change\n");
    const configPath = join(malformed.stream, ".codeless/config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    delete config.implementer;
    writeFileSync(configPath, JSON.stringify(config));
    expect(streams(malformed.stream, ["dispatch", malformedChange], { HERDR_ENV: "1" }).code).toBe(
      1,
    );
    expect(existsSync(join(malformed.workspace, "metrics/queries/001.json"))).toBe(false);
  });

  test("dispatch loads target project prompts and rejects missing prompts before touching panes", () => {
    const f = fixture();
    const approved = join(f.documents, "changes/001.md");
    writeFileSync(approved, "# Approved change\n");
    const mockBin = join(f.root, "mock-bin");
    const trace = join(f.root, "dispatch.jsonl");
    mkdirSync(mockBin);
    writeFileSync(
      join(mockBin, "herdr"),
      `#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.STREAMS_TEST_TRACE, JSON.stringify(args) + "\\n");
let result = {};
if (args[0] === "pane" && args[1] === "process-info") {
  result = { process_info: { foreground_processes: [{ argv0: args.at(-1) === "planner" ? "pi" : "zsh", cwd: process.cwd() }] } };
} else if (args[0] === "pane" && args[1] === "layout") {
  result = { layout: { panes: [{ pane_id: "planner", rect: { x: 0, y: 0, width: 100, height: 100 } }] } };
} else if (args[0] === "pane" && args[1] === "split") {
  result = { pane: { pane_id: "implementer" } };
} else if (args[0] === "agent" && args[1] === "start") {
  result = { agent: { foreground_cwd: process.cwd() } };
} else if (args[0] === "agent" && args[1] === "prompt") {
  const calls = readFileSync(process.env.STREAMS_TEST_TRACE, "utf8").trim().split("\\n").map(JSON.parse);
  const start = calls.find((call) => call[0] === "agent" && call[1] === "start");
  const configuration = JSON.parse(start[start.indexOf("--codeless-attempt") + 1]);
  try {
    writeFileSync(configuration.path, JSON.stringify({
      id: configuration.id,
      stream: configuration.stream,
      change: configuration.change,
      role: "implementer",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:01.000Z",
      selection: { provider: "openai-codex", model: "gpt-5.6-terra", thinking: "medium" },
      outcome: "stop",
      text: "Implemented.",
      usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
      toolCalls: 1,
      errorCount: 0,
      incomplete: false,
      ...(process.env.STREAMS_TEST_MALFORMED_REPORT ? { prompt: "must not persist" } : {}),
    }) + "\\n");
  } catch {}
}
console.log(JSON.stringify({ result }));
`,
    );
    chmodSync(join(mockBin, "herdr"), 0o755);
    const env = {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "planner",
      PATH: `${mockBin}:${environment.PATH}`,
      STREAMS_TEST_TRACE: trace,
    };
    const dispatched = streams(f.stream, ["dispatch", approved], env);
    expect(dispatched.code).toBe(0);
    expect(JSON.parse(dispatched.stdout)).toMatchObject({
      stream: "queries",
      change: "001",
      role: "implementer",
      incomplete: false,
      text: "Implemented.",
      usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
      selection: { provider: "openai-codex", model: "gpt-5.6-terra", thinking: "medium" },
    });
    const metricPath = join(f.workspace, "metrics/queries/001.json");
    const metric = JSON.parse(readFileSync(metricPath, "utf8"));
    expect(metric).toMatchObject({ stream: "queries", change: "001" });
    expect(typeof metric.dispatchedAt).toBe("string");
    expect(streams(f.stream, ["dispatch", approved], env).code).toBe(0);
    const retriedMetric = JSON.parse(readFileSync(metricPath, "utf8"));
    expect(retriedMetric.dispatchedAt).toBe(metric.dispatchedAt);
    expect(Object.keys(retriedMetric.attempts)).toHaveLength(2);
    const logged = readFileSync(trace, "utf8");
    const calls = logged
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const start = calls.find((args) => args[0] === "agent" && args[1] === "start")!;
    expect(start).toContain(join(f.stream, "instructions"));
    expect(JSON.parse(start[start.indexOf("--codeless-attempt") + 1]!)).toMatchObject({
      stream: "queries",
      change: "001",
      path: expect.stringContaining(".attempt-"),
    });
    expect(start.slice(start.indexOf("--model"), start.indexOf("--model") + 4)).toEqual([
      "--model",
      "openai-codex/gpt-5.6-terra",
      "--thinking",
      "medium",
    ]);
    expect(calls.find((args) => args[0] === "agent" && args[1] === "prompt")).toContain(
      `/implement ${JSON.stringify(approved)}`,
    );
    const unavailable = streams(f.stream, ["dispatch", approved], {
      ...env,
      STREAMS_TEST_PI_MODELS: JSON.stringify([
        {
          provider: "openai-codex",
          id: "gpt-5.6-sol",
          levels: ["off", "high"],
        },
      ]),
    });
    expect(unavailable.stderr).toContain(
      "Implementer requested openai-codex/gpt-5.6-terra at thinking level medium",
    );
    expect(readFileSync(trace, "utf8")).toBe(logged);
    expect(JSON.parse(readFileSync(metricPath, "utf8"))).toEqual(retriedMetric);

    const malformedReport = streams(f.stream, ["dispatch", approved], {
      ...env,
      STREAMS_TEST_MALFORMED_REPORT: "1",
    });
    expect(malformedReport.code).toBe(0);
    expect(malformedReport.stderr).toContain("could not collect implementer attempt");
    expect(JSON.parse(malformedReport.stdout)).toMatchObject({ incomplete: true });

    rmSync(join(f.workspace, "metrics/queries"), { recursive: true });
    writeFileSync(join(f.workspace, "metrics/queries"), "not a directory\n");
    const collectionFailure = streams(f.stream, ["dispatch", approved], env);
    expect(collectionFailure.code).toBe(0);
    expect(collectionFailure.stderr).toContain("warning: could not collect dispatch metrics");
    const loggedAfterCollectionFailure = readFileSync(trace, "utf8");

    rmSync(join(f.stream, "instructions/implement.md"));
    git(f.stream, "add", ".");
    git(f.stream, "commit", "-m", "Remove project prompt");
    expect(streams(f.stream, ["dispatch", approved], env).stderr).toContain(
      "Missing project prompt",
    );
    expect(readFileSync(trace, "utf8")).toBe(loggedAfterCollectionFailure);
  });

  test("metrics aggregate streams and count elapsed coverage only for landed changes", () => {
    const f = fixture();
    const directory = join(f.workspace, "metrics/queries");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "001.json"),
      JSON.stringify({
        stream: "queries",
        change: "001",
        dispatchedAt: "2026-03-01T10:00:00.000Z",
        landedAt: "2026-03-01T10:02:30.000Z",
        landedCommit: "a".repeat(40),
      }),
    );
    writeFileSync(
      join(directory, "002.json"),
      JSON.stringify({
        stream: "queries",
        change: "002",
        dispatchedAt: "2026-03-01T11:00:00.000Z",
      }),
    );
    const other = join(f.workspace, "metrics/relationships");
    mkdirSync(other, { recursive: true });
    writeFileSync(
      join(other, "001.json"),
      JSON.stringify({
        stream: "relationships",
        change: "001",
        landedAt: "2026-03-01T12:00:00.000Z",
        landedCommit: "b".repeat(40),
      }),
    );
    const result = streams(f.personal, ["metrics"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("queries\t1\t1\t1 measured, 0 unavailable\t2m 30s\t2m 30s");
    expect(result.stdout).toContain(
      "relationships\t1\t0\t0 measured, 1 unavailable\tunavailable\tunavailable",
    );
    expect(result.stdout).toContain(
      "Project total\t2\t1\t1 measured, 1 unavailable\t2m 30s\t2m 30s",
    );
  });

  test("an absolute workspace override replaces primary-checkout state", () => {
    const f = fixture();
    const override = join(f.root, "workspace override");
    git(f.personal, "config", "codeless.workspaceRoot", override);
    const directory = join(override, "metrics/queries");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "001.json"),
      JSON.stringify({
        stream: "queries",
        change: "001",
        landedAt: "2026-03-01T10:00:00.000Z",
        landedCommit: "a".repeat(40),
      }),
    );

    const result = streams(f.stream, ["metrics"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain(
      "queries\t1\t0\t0 measured, 1 unavailable\tunavailable\tunavailable",
    );
  });

  test("landing marks the latest change while older unlanded records remain visible", () => {
    const f = fixture();
    writeFileSync(join(f.documents, "changes/001.md"), "# Earlier approved change\n");
    writeFileSync(join(f.documents, "changes/002.md"), "# Current approved change\n");
    const metricDirectory = join(f.workspace, "metrics/queries");
    mkdirSync(metricDirectory, { recursive: true });
    const oldMetricPath = join(metricDirectory, "001.json");
    const landedMetricPath = join(metricDirectory, "002.json");
    writeFileSync(
      oldMetricPath,
      JSON.stringify({
        stream: "queries",
        change: "001",
        dispatchedAt: "2026-03-01T10:00:00.000Z",
      }),
    );
    const base = git(f.main, "rev-parse", "HEAD");
    change(
      f.stream,
      "package.json",
      JSON.stringify({ scripts: { check: "bun -e 'process.exit(7)'" } }),
    );
    expect(streams(f.stream, ["land", "queries"]).code).toBe(1);
    expect(existsSync(landedMetricPath)).toBe(false);
    expect(JSON.parse(readFileSync(oldMetricPath, "utf8"))).not.toHaveProperty("landedAt");
    expect(git(f.main, "rev-parse", "HEAD")).toBe(base);
    writeFileSync(
      join(f.stream, "package.json"),
      JSON.stringify({ scripts: { check: "bun -e 'process.exit(0)'" } }),
    );
    writeFileSync(join(f.stream, "feature.txt"), "completed change\n");
    git(f.stream, "add", "package.json", "feature.txt");
    git(f.stream, "commit", "--amend", "--no-edit");
    expect(streams(f.stream, ["land", "queries"]).code).toBe(0);
    expect(JSON.parse(readFileSync(oldMetricPath, "utf8"))).not.toHaveProperty("landedAt");
    const metric = JSON.parse(readFileSync(landedMetricPath, "utf8"));
    expect(metric).toMatchObject({ stream: "queries", change: "002" });
    expect(metric).not.toHaveProperty("dispatchedAt");
    expect(metric.landedCommit).toBe(git(f.main, "rev-parse", "HEAD"));
    expect(typeof metric.landedAt).toBe("string");
  });

  test("a landing metric failure warns without reversing the landing", () => {
    const f = fixture();
    writeFileSync(join(f.documents, "changes/001.md"), "# Approved change\n");
    mkdirSync(join(f.workspace, "metrics"));
    writeFileSync(join(f.workspace, "metrics/queries"), "not a directory\n");
    const commit = change(f.stream, "feature.txt", "completed change\n");
    const result = streams(f.stream, ["land", "queries"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("warning: could not collect landing metrics");
    expect(git(f.main, "rev-parse", "HEAD")).toBe(commit);
  });

  test("invalid role settings fail schema validation", () => {
    const f = fixture();
    const path = join(f.stream, ".codeless/config.json");
    const config = JSON.parse(readFileSync(path, "utf8"));
    config.planner.thinking = "ultra";
    writeFileSync(path, JSON.stringify(config));
    const malformed = streams(f.stream, ["planner", "queries"], { HERDR_ENV: "1" });
    expect(malformed.code).toBe(1);
    expect(malformed.stderr).toContain(`Invalid Codeless project configuration at ${path}`);
    expect(malformed.stderr).toContain(
      'Expected "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"',
    );
    expect(malformed.stderr).toContain('["planner"]["thinking"]');

    delete config.planner;
    writeFileSync(path, JSON.stringify(config));
    const missing = streams(f.stream, ["planner", "queries"], { HERDR_ENV: "1" }).stderr;
    expect(missing).toContain("Missing key");
    expect(missing).toContain('["planner"]');
  });

  test("unavailable or model-incompatible planner selections fail before launch", () => {
    const f = fixture();
    const trace = join(f.root, "pi.jsonl");
    const unavailable = streams(f.stream, ["planner", "queries"], {
      HERDR_ENV: "1",
      STREAMS_TEST_PI_TRACE: trace,
      STREAMS_TEST_PI_MODELS: JSON.stringify([
        {
          provider: "openai-codex",
          id: "gpt-5.6-terra",
          levels: ["off", "medium"],
        },
      ]),
    });
    expect(unavailable.code).toBe(1);
    expect(unavailable.stderr).toContain(
      "Planner requested openai-codex/gpt-5.6-sol at thinking level high",
    );
    expect(unavailable.stderr).toContain("is not available");
    expect(
      readFileSync(trace, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.args),
    ).toEqual([
      {
        args: [
          "--mode",
          "rpc",
          "--no-session",
          "--approve",
          "--extension",
          join(packageRoot, "extension/planner.js"),
        ],
      },
    ]);

    const incompatible = streams(f.stream, ["planner", "queries"], {
      HERDR_ENV: "1",
      STREAMS_TEST_PI_MODELS: JSON.stringify([
        {
          provider: "openai-codex",
          id: "gpt-5.6-sol",
          levels: ["off", "low"],
        },
      ]),
    });
    expect(incompatible.code).toBe(1);
    expect(incompatible.stderr).toContain("does not support thinking level high");
    expect(incompatible.stderr).toContain("supported levels: off, low");

    const activationFailure = streams(f.stream, ["planner", "queries"], {
      HERDR_ENV: "1",
      STREAMS_TEST_PI_COMMANDS: "[]",
    });
    expect(activationFailure.code).toBe(1);
    expect(activationFailure.stderr).toContain("did not register streams-activate");
  });

  test("invalid project commands fail before landing acquires a lock", () => {
    const f = fixture();
    const path = join(f.personal, ".codeless/config.json");
    const config = JSON.parse(readFileSync(path, "utf8"));
    config.check = "bun run check";
    writeFileSync(path, JSON.stringify(config));
    const result = streams(f.personal, ["land", "queries"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`Invalid Codeless project configuration at ${path}`);
    expect(existsSync(join(f.workspace, ".land-lock"))).toBe(false);
  });

  test("the package executable works outside a repository and follows a caller's configured branch", () => {
    const f = fixture("integration");
    expect(streams(f.root, ["--help"])).toMatchObject({ code: 0, stderr: "" });
    const commit = change(f.stream, "feature.txt", "one change\n");
    const result = streams(join(f.personal, "briefs"), ["land", "queries"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Landed stream/queries on integration");
    expect(git(f.main, "rev-parse", "HEAD")).toBe(commit);
  });

  test("landing uses the target worktree's check command after rebasing", () => {
    const f = fixture();
    const config = JSON.parse(readFileSync(join(f.main, ".codeless/config.json"), "utf8"));
    config.check = [
      process.execPath,
      "-e",
      'if (process.argv[1] !== "two words") process.exit(1); console.log("configured check")',
      "two words",
    ];
    change(f.main, ".codeless/config.json", JSON.stringify(config));
    change(f.stream, "feature.txt", "one change\n");
    const result = streams(f.personal, ["land", "queries"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("configured check");
  });

  test("lands on the discovered main checkout without changing dirty personal dev", () => {
    const f = fixture();
    const dev = git(f.personal, "rev-parse", "dev");
    writeFileSync(join(f.personal, "value.txt"), "personal work\n");
    const commit = change(f.stream, "feature.txt", "one capability\n");
    const result = streams(f.stream, ["land", "queries"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Landed stream/queries on main");
    expect(git(f.main, "rev-parse", "HEAD")).toBe(commit);
    expect(git(f.personal, "rev-parse", "dev")).toBe(dev);
    expect(readFileSync(join(f.personal, "value.txt"), "utf8")).toBe("personal work\n");
    expect(existsSync(join(f.workspace, ".land-lock"))).toBe(false);
  });

  test("rebases one change onto advanced main and shares the lock from another checkout", () => {
    const f = fixture();
    change(f.main, "other.txt", "other stream\n");
    const base = git(f.main, "rev-parse", "HEAD");
    change(f.stream, "feature.txt", "this stream\n");
    const lock = join(f.workspace, ".land-lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), "relationships\n");
    writeFileSync(join(lock, "base"), `${base}\n`);
    expect(streams(f.personal, ["land", "queries"]).stderr).toContain("held by relationships");
    expect(git(f.main, "rev-parse", "HEAD")).toBe(base);
    rmSync(lock, { recursive: true });
    const result = streams(f.personal, ["land", "queries"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Rebasing stream/queries onto current main");
    expect(git(f.main, "rev-parse", "HEAD^")).toBe(base);
    expect(git(f.stream, "rev-parse", "HEAD")).toBe(git(f.main, "rev-parse", "HEAD"));
    expect(readFileSync(join(f.main, "other.txt"), "utf8")).toBe("other stream\n");
  });

  test("refuses dirty main and multiple unlanded commits before acquiring a lock", () => {
    const f = fixture();
    change(f.stream, "feature.txt", "first\n");
    writeFileSync(join(f.main, "value.txt"), "integration edit\n");
    expect(streams(f.stream, ["land", "queries"]).stderr).toContain(
      "main integration worktree is not clean",
    );
    expect(existsSync(join(f.workspace, ".land-lock"))).toBe(false);
    writeFileSync(join(f.main, "value.txt"), "base\n");
    change(f.stream, "feature.txt", "second\n");
    expect(streams(f.stream, ["land", "queries"]).stderr).toContain(
      "exactly one change commit, found 2",
    );
    expect(existsSync(join(f.workspace, ".land-lock"))).toBe(false);
  });

  test("retains the integration owner after conflicts and rejects a changed recorded base", () => {
    const f = fixture();
    change(f.main, "value.txt", "main change\n");
    const base = git(f.main, "rev-parse", "HEAD");
    change(f.stream, "value.txt", "stream change\n");
    const result = streams(f.stream, ["land", "queries"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Integration slot remains held by queries");
    const lock = join(f.workspace, ".land-lock");
    expect(readFileSync(join(lock, "owner"), "utf8").trim()).toBe("queries");
    expect(git(f.main, "rev-parse", "HEAD")).toBe(base);
    git(f.stream, "rebase", "--abort");
    change(f.main, "independent.txt", "manual main advancement\n");
    expect(streams(f.stream, ["land", "queries"]).stderr).toContain("but main is now");
    expect(existsSync(lock)).toBe(true);
  });

  test("failed checks keep main unchanged and the landing can resume after correction", () => {
    const f = fixture();
    const base = git(f.main, "rev-parse", "HEAD");
    change(
      f.stream,
      "package.json",
      JSON.stringify({ scripts: { check: "bun -e 'process.exit(7)'" } }),
    );
    expect(streams(f.stream, ["land", "queries"]).stderr).toContain(
      "Integration slot remains held by queries",
    );
    expect(git(f.main, "rev-parse", "HEAD")).toBe(base);
    writeFileSync(
      join(f.stream, "package.json"),
      JSON.stringify({ scripts: { check: "bun -e 'process.exit(0)'" } }),
    );
    writeFileSync(join(f.stream, "feature.txt"), "corrected change\n");
    git(f.stream, "add", ".");
    git(f.stream, "commit", "--amend", "--no-edit");
    expect(streams(f.stream, ["land", "queries"]).stdout).toContain("Resumed integration slot");
    expect(git(f.main, "rev-parse", "HEAD")).toBe(git(f.stream, "rev-parse", "HEAD"));
  });

  test("planner restart launches Pi in its current shell and activates before its project prompt", () => {
    const f = fixture();
    const trace = join(f.root, "planner-pi.jsonl");
    const result = streams(f.stream, ["planner", "queries"], {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "planner",
      STREAMS_TEST_PI_TRACE: trace,
    });
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("Planner: openai-codex/gpt-5.6-sol (thinking: high)");
    const calls = readFileSync(trace, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const launch = calls.find((entry) => entry.args && !entry.args.includes("rpc"))
      .args as string[];
    expect(launch).not.toContain("herdr");
    expect(launch).toContain(join(packageRoot, "extension/planner.js"));
    expect(launch).toContain(join(f.stream, "instructions"));
    expect(launch.slice(launch.indexOf("--model"), launch.indexOf("--model") + 4)).toEqual([
      "--model",
      "openai-codex/gpt-5.6-sol",
      "--thinking",
      "high",
    ]);
    expect(launch.at(-1)).toBe(
      `/streams-activate ${JSON.stringify(`/change ${JSON.stringify(f.documents)} ${JSON.stringify(join(f.stream, "briefs/queries.md"))}`)}`,
    );
    expect(existsSync(join(f.documents, "design.md"))).toBe(false);
    rmSync(join(f.stream, "briefs/queries.md"));
    expect(
      streams(f.stream, ["planner", "queries"], {
        HERDR_ENV: "1",
        HERDR_PANE_ID: "planner",
        STREAMS_TEST_PI_TRACE: trace,
      }).stderr,
    ).toContain("Missing stream direction");
  });

  test("creation takes its direction and branch baseline from main and passes project tooling to Herdr", () => {
    const f = fixture();
    const main = change(f.main, "briefs/relationships.md", "# Relationships\n");
    const personalConfig = JSON.parse(
      readFileSync(join(f.personal, ".codeless/config.json"), "utf8"),
    );
    personalConfig.prompts = "personal-prompts";
    personalConfig.directions = "personal-briefs";
    personalConfig.install = [process.execPath, "-e", "process.exit(99)"];
    writeFileSync(join(f.personal, ".codeless/config.json"), JSON.stringify(personalConfig));
    const mockBin = join(f.root, "mock-bin");
    const trace = join(f.root, "herdr-calls.jsonl");
    mkdirSync(mockBin);
    writeFileSync(
      join(mockBin, "herdr"),
      `#!/usr/bin/env bun
import { appendFileSync, mkdirSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.STREAMS_TEST_TRACE, JSON.stringify(args) + "\\n");
if (args[0] === "worktree" && args[1] === "create") {
  const option = (key) => args[args.indexOf(key) + 1];
  const path = option("--path");
  const git = Bun.spawnSync(["git", "worktree", "add", "-b", option("--branch"), path, option("--base")], { cwd: option("--cwd") });
  if (git.exitCode !== 0) throw new Error(git.stderr.toString());
  console.log(JSON.stringify({ result: { workspace: { workspace_id: "test-workspace" }, root_pane: { pane_id: "test-planner" } } }));
} else if (args[0] === "pane") {
  console.log(JSON.stringify({ result: { pane: { pane_id: "test-implementer" } } }));
} else console.log(JSON.stringify({ result: {} }));
`,
    );
    chmodSync(join(mockBin, "herdr"), 0o755);
    const result = streams(f.personal, ["create", "relationships"], {
      HERDR_ENV: "1",
      PATH: `${mockBin}:${environment.PATH}`,
      STREAMS_TEST_TRACE: trace,
    });
    expect(result).toMatchObject({ code: 0, stderr: "" });
    const created = join(f.workspace, "worktree/relationships");
    const documents = join(f.workspace, "stream/relationships");
    expect(git(created, "rev-parse", "HEAD")).toBe(main);
    expect(git(created, "branch", "--show-current")).toBe("stream/relationships");
    expect(existsSync(join(documents, "design.md"))).toBe(false);
    expect(readFileSync(join(documents, "planner.md"), "utf8")).toContain("created from main");
    const calls = readFileSync(trace, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const start = calls.find((args) => args[0] === "agent" && args[1] === "start")!;
    expect(start).toContain(join(packageRoot, "extension/planner.js"));
    expect(start).toContain(join(created, "instructions"));
    expect(start.slice(start.indexOf("--model"), start.indexOf("--model") + 4)).toEqual([
      "--model",
      "openai-codex/gpt-5.6-sol",
      "--thinking",
      "high",
    ]);
    expect(JSON.parse(readFileSync(join(created, ".installed.json"), "utf8"))).toEqual({
      cwd: created,
      args: ["two words"],
    });
    expect(calls.find((args) => args[0] === "agent" && args[1] === "prompt")?.at(-1)).toBe(
      `/streams-activate ${JSON.stringify(`/change ${JSON.stringify(documents)} ${JSON.stringify(join(created, "briefs/relationships.md"))}`)}`,
    );
  });

  test("reopening starts the canonical planner and sends activation before /change", () => {
    const f = fixture();
    const mockBin = join(f.root, "open-mock-bin");
    const trace = join(f.root, "open-calls.jsonl");
    mkdirSync(mockBin);
    writeFileSync(
      join(mockBin, "herdr"),
      `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.STREAMS_TEST_TRACE, JSON.stringify(args) + "\\n");
if (args[0] === "worktree" && args[1] === "open") {
  console.log(JSON.stringify({ result: { workspace: { workspace_id: "workspace" }, root_pane: { pane_id: "planner" } } }));
} else if (args[0] === "pane" && args[1] === "split") {
  console.log(JSON.stringify({ result: { pane: { pane_id: "implementer" } } }));
} else console.log(JSON.stringify({ result: {} }));
`,
    );
    chmodSync(join(mockBin, "herdr"), 0o755);
    const result = streams(f.personal, ["open", "queries"], {
      HERDR_ENV: "1",
      PATH: `${mockBin}:${environment.PATH}`,
      STREAMS_TEST_TRACE: trace,
    });
    expect(result).toMatchObject({ code: 0, stderr: "" });
    const calls = readFileSync(trace, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const start = calls.find((args) => args[0] === "agent" && args[1] === "start")!;
    expect(start).toContain("queries_planner");
    expect(start).toContain("--name");
    expect(start).toContain("queries-planner");
    expect(calls.find((args) => args[0] === "agent" && args[1] === "prompt")?.at(-1)).toBe(
      `/streams-activate ${JSON.stringify(`/change ${JSON.stringify(f.documents)} ${JSON.stringify(join(f.stream, "briefs/queries.md"))}`)}`,
    );
  });

  test("creation rejects missing direction or a relative shared workspace before invoking Herdr", () => {
    const f = fixture();
    expect(streams(f.personal, ["create", "missing"], { HERDR_ENV: "1" }).stderr).toContain(
      "Missing stream direction",
    );
    expect(existsSync(join(f.workspace, "stream/missing"))).toBe(false);
    git(f.personal, "config", "codeless.workspaceRoot", "relative-workspace");
    expect(streams(f.personal, ["create", "queries"], { HERDR_ENV: "1" }).stderr).toContain(
      "must be an absolute path",
    );
  });
});
