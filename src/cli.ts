#!/usr/bin/env bun

import {
  existsSync,
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { metricReport, recordAttempt, recordDispatch, recordLanding } from "./metrics.ts";
import { type Attempt, validAttempt } from "./attempt.ts";
import { roleSelectionArguments, roleSelectionSummary, validateRoleSelection } from "./pi.ts";
import { readProject } from "./project.ts";

const usage = `Usage:
  codeless init
  codeless create <slug>
  codeless open <slug>
  codeless approve <planner-session>
  codeless dispatch <numbered-change-file>
  codeless rework <numbered-change-file> <feedback>
  codeless finish <numbered-change-file>
  codeless land <slug>
  codeless next <numbered-change-file> <landed-commit>
  codeless metrics`;

export async function runCodeless(args: string[]): Promise<void> {
  const [action, target, ...details] = args;
  if (action === undefined || action === "--help" || action === "-h") {
    console.log(usage);
    return;
  }
  const repository = canonicalPath(run("git", ["rev-parse", "--show-toplevel"]).trim());
  const project = readProject(repository);
  const { integrationBranch } = project;
  run("git", ["check-ref-format", "--branch", integrationBranch], repository);
  const plannerExtension = resolve(import.meta.dir, "../extension/planner.js");
  const implementerReportingExtension = resolve(
    import.meta.dir,
    "../extension/implementer-reporting.js",
  );
  const configuredWorkspace = Bun.spawnSync(
    ["git", "config", "--local", "--get", "codeless.workspaceRoot"],
    { cwd: repository },
  );
  if (![0, 1].includes(configuredWorkspace.exitCode))
    throw new Error(configuredWorkspace.stderr.toString());
  const workspacePath =
    configuredWorkspace.exitCode === 0
      ? configuredWorkspace.stdout.toString().trim()
      : join(primaryWorktree(), ".codeless", "state");
  if (!isAbsolute(workspacePath))
    throw new Error("codeless.workspaceRoot must be an absolute path");
  const workspaceRoot = canonicalPath(workspacePath);

  function canonicalPath(path: string): string {
    return existsSync(path)
      ? realpathSync(path)
      : join(canonicalPath(dirname(path)), basename(path));
  }

  function run(command: string, args: string[], cwd: string = process.cwd()): string {
    const child = Bun.spawnSync([command, ...args], {
      cwd,
      env: process.env,
      stdin: "inherit",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = child.stdout.toString();
    const stderr = child.stderr.toString();
    if (child.exitCode !== 0) {
      throw new Error(stderr.trim() || stdout.trim() || `${command} failed`);
    }
    return stdout;
  }

  function runVisible(command: string, args: string[], cwd: string = process.cwd()): void {
    const child = Bun.spawnSync([command, ...args], {
      cwd,
      env: process.env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    if (child.exitCode !== 0) throw new Error(`${command} failed with exit code ${child.exitCode}`);
  }

  function succeeds(command: string, args: string[], cwd: string = process.cwd()): boolean {
    return (
      Bun.spawnSync([command, ...args], {
        cwd,
        env: process.env,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }).exitCode === 0
    );
  }

  function herdr(args: string[]): Record<string, unknown> {
    try {
      return JSON.parse(run("herdr", args)) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("Herdr returned invalid JSON");
      throw error;
    }
  }

  function id(response: Record<string, unknown>, parent: string, key: string): string {
    const result = response["result"] as Record<string, unknown> | undefined;
    const value = (result?.[parent] as Record<string, unknown> | undefined)?.[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`Herdr response omitted result.${parent}.${key}`);
    }
    return value;
  }

  function date(): string {
    const now = new Date();
    return [now.getFullYear(), now.getMonth() + 1, now.getDate()]
      .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, "0"))
      .join("-");
  }

  type Worktree = { path: string; branch?: string };

  function registeredWorktrees(): Worktree[] {
    return run("git", ["worktree", "list", "--porcelain", "-z"], repository)
      .split("\0\0")
      .filter(Boolean)
      .map((entry) => {
        const fields = entry.split("\0");
        const path = fields.find((field) => field.startsWith("worktree "))?.slice(9);
        if (path === undefined) throw new Error("Git did not report a worktree path");
        const branch = fields.find((field) => field.startsWith("branch "))?.slice(7);
        return { path: canonicalPath(path), ...(branch === undefined ? {} : { branch }) };
      });
  }

  function integrationWorktree(): string {
    const matches = registeredWorktrees().filter(
      (worktree) => worktree.branch === `refs/heads/${integrationBranch}`,
    );
    if (matches.length !== 1)
      throw new Error(`${integrationBranch} needs exactly one dedicated integration worktree`);
    return matches[0]!.path;
  }

  function primaryWorktree(): string {
    const path = registeredWorktrees()[0]?.path;
    if (path === undefined) throw new Error("Git did not report a primary worktree");
    return path;
  }

  function init(): void {
    run("git", ["show-ref", "--verify", `refs/heads/${integrationBranch}`], repository);
    const primary = primaryWorktree();
    const target = canonicalPath(join(workspaceRoot, "worktree", integrationBranch));
    const matchingBranch = registeredWorktrees().filter(
      (worktree) => worktree.branch === `refs/heads/${integrationBranch}`,
    );
    const targetExists = existsSync(target);

    let workspaceParent = workspaceRoot;
    while (!existsSync(workspaceParent)) workspaceParent = dirname(workspaceParent);
    if (!statSync(workspaceParent).isDirectory()) {
      throw new Error(`Workspace parent is not a directory: ${workspaceParent}`);
    }
    const worktreeRoot = join(workspaceRoot, "worktree");
    const stateDirectories: [string, string][] = [
      ["Workspace", workspaceRoot],
      ["Workspace stream path", join(workspaceRoot, "stream")],
      ["Workspace worktree path", worktreeRoot],
      ["Workspace metrics path", join(workspaceRoot, "metrics")],
    ];
    for (const [label, path] of stateDirectories) {
      if (existsSync(path) && !statSync(path).isDirectory()) {
        throw new Error(`${label} is not a directory: ${path}`);
      }
    }
    const defaultWorkspace = workspaceRoot === canonicalPath(join(primary, ".codeless", "state"));
    const ignoreFile = join(primary, ".gitignore");
    let stateIgnored = false;
    if (defaultWorkspace) {
      if (existsSync(ignoreFile) && !statSync(ignoreFile).isFile()) {
        throw new Error(`Repository ignore file is not a file: ${ignoreFile}`);
      }

      function ignoredByRepository(path: string): boolean {
        const effective = Bun.spawnSync(["git", "check-ignore", "-q", "--no-index", path], {
          cwd: primary,
          env: process.env,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "pipe",
        });
        if (effective.exitCode === 1) return false;
        if (effective.exitCode !== 0) {
          throw new Error(
            effective.stderr.toString().trim() || "Could not inspect repository ignores",
          );
        }
        const source = run("git", ["check-ignore", "-v", "--no-index", path], primary).split(
          ":",
          1,
        )[0];
        return source === ".gitignore" || source === ignoreFile;
      }

      const protectedPaths = [
        ".codeless/config.json",
        ...["change", "implement", "review", "commit"].map((name) =>
          join(project.prompts, `${name}.md`),
        ),
      ];
      if (protectedPaths.some((path) => ignoredByRepository(path))) {
        throw new Error(
          `Repository ignore rule conflicts with Codeless configuration or prompts; narrow ${ignoreFile} to /.codeless/state/`,
        );
      }
      stateIgnored = ignoredByRepository(join(".codeless", "state", ".codeless-init-probe"));
    }

    if (matchingBranch.length > 1) {
      throw new Error(`Git reports ${integrationBranch} checked out in multiple worktrees`);
    }
    if (matchingBranch.length === 1 && matchingBranch[0]!.path !== target) {
      throw new Error(
        `${integrationBranch} is checked out at ${matchingBranch[0]!.path}, expected ${target}`,
      );
    }
    if (matchingBranch.length === 1 && (!targetExists || !statSync(target).isDirectory())) {
      throw new Error(
        `Git registers ${integrationBranch} at invalid integration worktree ${target}`,
      );
    }
    if (
      matchingBranch.length === 1 &&
      run("git", ["branch", "--show-current"], target).trim() !== integrationBranch
    ) {
      throw new Error(`Integration worktree is not on ${integrationBranch}: ${target}`);
    }
    if (matchingBranch.length === 0 && targetExists) {
      throw new Error(`Integration worktree target is occupied: ${target}`);
    }

    if (defaultWorkspace && !stateIgnored) {
      const currentIgnore = existsSync(ignoreFile) ? readFileSync(ignoreFile, "utf8") : "";
      appendFileSync(
        ignoreFile,
        `${currentIgnore.length > 0 && !currentIgnore.endsWith("\n") ? "\n" : ""}/.codeless/state/\n`,
      );
    }
    mkdirSync(join(workspaceRoot, "stream"), { recursive: true });
    mkdirSync(worktreeRoot, { recursive: true });
    mkdirSync(join(workspaceRoot, "metrics"), { recursive: true });
    if (matchingBranch.length === 0) {
      run("git", ["worktree", "add", target, integrationBranch], repository);
    }

    console.log(`Integration branch: ${integrationBranch}`);
    console.log(`Primary checkout: ${primary}`);
    console.log(`Workspace: ${workspaceRoot}`);
    console.log(`Integration worktree: ${target}`);
  }

  function requireDirection(slug: string, worktree: string): string {
    const path = join(worktree, readProject(worktree).directions, `${slug}.md`);
    if (!existsSync(path)) throw new Error(`Missing stream direction: ${path}`);
    return path;
  }

  function promptDirectory(worktree: string): string {
    const directory = join(worktree, readProject(worktree).prompts);
    for (const name of ["change", "implement", "review", "commit"]) {
      const path = join(directory, `${name}.md`);
      if (!existsSync(path)) throw new Error(`Missing project prompt: ${path}`);
    }
    return directory;
  }

  function changePrompt(slug: string, documents: string, worktree: string): string {
    return `/change ${JSON.stringify(documents)} ${JSON.stringify(requireDirection(slug, worktree))}`;
  }

  function activationPrompt(prompt: string): string {
    return `/streams-activate ${JSON.stringify(prompt)}`;
  }

  async function createDocuments(slug: string, directory: string, worktree: string): Promise<void> {
    const project = readProject(worktree);
    const title = slug
      .split("-")
      .map((part) => part[0]!.toUpperCase() + part.slice(1))
      .join(" ");
    await mkdir(join(directory, "changes"), { recursive: true });
    await writeFile(
      join(directory, "planner.md"),
      `# ${title} planner journal\n\n## ${date()} — Stream created\n\nThe stream was created from ${project.integrationBranch}. Direction is owned by ${project.directions}/${slug}.md. No proposal has been approved and no numbered change has been allocated.\n`,
      { flag: "wx" },
    );
    await writeFile(
      join(directory, "change.md"),
      "# No current proposal\n\nThe planner replaces this file when proposing the next change.\n",
      { flag: "wx" },
    );
  }

  function requireClean(directory: string, label: string): void {
    const status = run("git", ["status", "--porcelain"], directory).trim();
    if (status) throw new Error(`${label} is not clean:\n${status}`);
  }

  type JsonObject = Record<string, unknown>;

  function object(value: unknown, label: string): JsonObject {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`Herdr response omitted ${label}`);
    }
    return value as JsonObject;
  }

  function string(value: unknown, label: string): string {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`Herdr response omitted ${label}`);
    }
    return value;
  }

  function result(response: JsonObject): JsonObject {
    return object(response["result"], "result");
  }

  function paneProcessInfo(pane: string): JsonObject {
    return object(
      result(herdr(["pane", "process-info", "--pane", pane]))["process_info"],
      "result.process_info",
    );
  }

  function foregroundProcesses(info: JsonObject): JsonObject[] {
    if (!Array.isArray(info["foreground_processes"])) {
      throw new Error("Herdr response omitted result.process_info.foreground_processes");
    }
    return info["foreground_processes"].map((process, index) =>
      object(process, `result["process_info"]["foreground_processes"][${index}]`),
    );
  }

  function isShell(process: JsonObject): boolean {
    const argv0 = typeof process["argv0"] === "string" ? process["argv0"].replace(/^-/, "") : "";
    return ["bash", "fish", "sh", "zsh"].includes(argv0);
  }

  function rightPane(layout: JsonObject, plannerPane: string): string | undefined {
    if (!Array.isArray(layout["panes"]))
      throw new Error("Herdr response omitted result.layout.panes");
    const panes = layout["panes"].map((pane, index) =>
      object(pane, `result["layout"]["panes"][${index}]`),
    );
    const planner = panes.find((pane) => pane["pane_id"] === plannerPane);
    if (planner === undefined)
      throw new Error(`Planner pane ${plannerPane} is absent from its layout`);
    const plannerRect = object(planner["rect"], `layout rect for ${plannerPane}`);
    const rightEdge = Number(plannerRect["x"]) + Number(plannerRect["width"]);
    const top = Number(plannerRect["y"]);
    const bottom = top + Number(plannerRect["height"]);
    const candidates = panes
      .filter((pane) => pane["pane_id"] !== plannerPane)
      .map((pane) => ({
        pane,
        rect: object(pane["rect"], `layout rect for ${string(pane["pane_id"], "pane ID")}`),
      }))
      .filter(({ rect }) => {
        const candidateTop = Number(rect["y"]);
        const candidateBottom = candidateTop + Number(rect["height"]);
        return Number(rect["x"]) >= rightEdge && candidateTop < bottom && candidateBottom > top;
      })
      .sort((left, right) => Number(left["rect"]["x"]) - Number(right["rect"]["x"]));
    if (candidates.length === 0) return undefined;
    if (candidates.length > 1) throw new Error("Planner layout has an ambiguous right-hand pane");
    return string(candidates[0]!.pane["pane_id"], "right-hand pane id");
  }

  function requirePaneShell(pane: string, worktree: string): void {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const info = paneProcessInfo(pane);
      const processes = foregroundProcesses(info);
      if (processes.length === 1 && isShell(processes[0]!)) {
        const cwd = string(processes[0]!["cwd"], `shell cwd in ${pane}`);
        if (canonicalPath(cwd) !== worktree) {
          throw new Error(`Right-hand shell ${pane} is in ${cwd}, expected ${worktree}`);
        }
        return;
      }
      if (attempt < 29) Bun.sleepSync(100);
    }
    throw new Error(`Pane ${pane} did not return to an available shell`);
  }

  function requireChange(changeArgument: string) {
    const change = canonicalPath(resolve(changeArgument.replace(/^@/, "")));
    const streamRoot = join(workspaceRoot, "stream");
    const match = relative(streamRoot, change).match(
      /^([a-z][a-z0-9-]{0,23})\/changes\/(\d{3})\.md$/,
    );
    if (match === null || !existsSync(change)) {
      throw new Error(`Expected an existing numbered change under ${streamRoot}`);
    }

    const slug = match[1]!;
    const worktree = join(workspaceRoot, "worktree", slug);
    return {
      change,
      slug,
      number: match[2]!,
      worktree,
      documents: join(streamRoot, slug),
      branch: `stream/${slug}`,
    };
  }

  function observe(event: string, collect: () => void): void {
    try {
      collect();
    } catch (error) {
      console.error(
        `codeless: warning: could not collect ${event}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  function incompleteAttempt(
    id: string,
    slug: string,
    number: string,
    selection: { provider: string; model: string; thinking: string } | undefined,
    kind: "initial" | "rework",
  ): Attempt {
    const timestamp = new Date().toISOString();
    return {
      id,
      stream: slug,
      change: number,
      role: "implementer",
      kind,
      startedAt: timestamp,
      endedAt: timestamp,
      ...(selection === undefined ? {} : { selection }),
      outcome: "unknown",
      toolCalls: 0,
      errorCount: 0,
      incomplete: true,
    };
  }

  function collectedAttempt(value: unknown, fallback: Attempt): Attempt {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return fallback;
    const attempt = value as Partial<Attempt>;
    if (
      attempt.id !== fallback.id ||
      attempt.stream !== fallback.stream ||
      attempt.change !== fallback.change ||
      attempt.role !== "implementer" ||
      attempt.kind !== fallback.kind ||
      typeof attempt.startedAt !== "string" ||
      typeof attempt.endedAt !== "string" ||
      typeof attempt.outcome !== "string" ||
      typeof attempt.toolCalls !== "number" ||
      typeof attempt.errorCount !== "number" ||
      attempt.incomplete !== false ||
      !validAttempt(attempt, fallback.stream, fallback.change)
    )
      return fallback;
    return attempt;
  }

  function latestChangeNumber(slug: string): string {
    const change = readdirSync(join(workspaceRoot, "stream", slug, "changes"))
      .filter((file) => /^\d{3}\.md$/.test(file))
      .sort()
      .at(-1);
    if (change === undefined) throw new Error(`Missing numbered change for ${slug}`);
    return basename(change, ".md");
  }

  async function nextChange(changeArgument: string, landedCommit: string): Promise<void> {
    const { change, slug, worktree, documents, branch } = requireChange(changeArgument);
    if (canonicalPath(process.cwd()) !== worktree) {
      throw new Error(`Next-loop cwd is ${process.cwd()}, expected ${worktree}`);
    }
    if (run("git", ["branch", "--show-current"], worktree).trim() !== branch) {
      throw new Error(`${worktree} is not on ${branch}`);
    }
    requireClean(worktree, branch);
    const latest = readdirSync(join(documents, "changes"))
      .filter((file) => /^\d{3}\.md$/.test(file))
      .sort()
      .at(-1);
    if (basename(change) !== latest)
      throw new Error("Only the latest approved change can start the next loop");
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(landedCommit)) {
      throw new Error("Supply the full landed commit hash");
    }
    const journal = join(documents, "planner.md");
    if (!readFileSync(journal, "utf8").includes(landedCommit)) {
      throw new Error(`Record the landed commit in ${journal} before starting the next loop`);
    }
    const lock = join(workspaceRoot, ".land-lock");
    if (existsSync(lock)) {
      const ownerFile = join(lock, "owner");
      const owner = existsSync(ownerFile) ? readFileSync(ownerFile, "utf8").trim() : "";
      if (!owner || owner === slug) {
        throw new Error(`Integration slot ${lock} still needs resolution before the next loop`);
      }
    }
    const base = run("git", ["rev-parse", integrationBranch], worktree).trim();
    if (!succeeds("git", ["merge-base", "--is-ancestor", landedCommit, "HEAD"], worktree)) {
      throw new Error(`${landedCommit} is not included in this stream`);
    }
    if (!succeeds("git", ["merge-base", "--is-ancestor", "HEAD", base], worktree)) {
      throw new Error(
        `${branch} has unlanded or diverged commits; finish landing before the next loop`,
      );
    }
    run("git", ["merge", "--ff-only", base], worktree);
    requireClean(worktree, branch);
    promptDirectory(worktree);
    const selection = readProject(worktree).planner;
    await validateRoleSelection("planner", selection, worktree, plannerExtension);
    console.log(
      JSON.stringify({
        sessionName: `${slug}-planner`,
        prompt: changePrompt(slug, documents, worktree),
        selection,
      }),
    );
  }

  function proposal(content: string): { title: string; hash: string } {
    const title = /^# ([^\r\n]+)\r?\n/.exec(content)?.[1]?.trim();
    const headings = ["Why", "Change", "Acceptance", "Decisions"].map((heading) => {
      const matches = [...content.matchAll(new RegExp(`^## ${heading}\\s*$`, "gm"))];
      return matches.length === 1 ? matches[0]!.index! : -1;
    });
    if (
      !title ||
      title.toLowerCase() === "no current proposal" ||
      headings.some((position) => position < 0) ||
      headings.some((position, index) => index > 0 && position < headings[index - 1]!)
    ) {
      throw new Error("change.md must contain one title and the required proposal headings");
    }
    return { title, hash: createHash("sha256").update(content).digest("hex") };
  }

  type Approval = { number: string; title: string; hash: string };

  function approvalEntry(approval: Approval): string {
    return `## ${date()} — Change approved\n\nApproved \`changes/${approval.number}.md\` — “${approval.title}” (\`sha256:${approval.hash}\`).\n`;
  }

  function approvals(journal: string): Approval[] {
    const header = /^## \d{4}-\d{2}-\d{2} — Change approved$/gm;
    const entry =
      /^## \d{4}-\d{2}-\d{2} — Change approved\n\nApproved `changes\/(\d{3})\.md` — “([^”\n]+)” \(`sha256:([0-9a-f]{64})`\)\.\n/;
    const records: Approval[] = [];
    for (const match of journal.matchAll(header)) {
      const record = entry.exec(journal.slice(match.index));
      if (record === null) throw new Error("planner.md has a malformed approval entry");
      records.push({ number: record[1]!, title: record[2]!, hash: record[3]! });
    }
    return records;
  }

  function approve(sessionName: string): void {
    if (process.env["HERDR_ENV"] !== "1")
      throw new Error("Approval must run from a Herdr-managed planner");
    const worktree = canonicalPath(process.cwd());
    const match = relative(join(workspaceRoot, "worktree"), worktree).match(
      /^([a-z][a-z0-9-]{0,23})$/,
    );
    if (match === null) throw new Error(`Approval cwd is ${process.cwd()}, not a stream worktree`);
    const slug = match[1]!;
    if (sessionName !== `${slug}-planner`)
      throw new Error(`Approval Pi session ${sessionName} does not match ${slug}-planner`);
    const branch = `stream/${slug}`;
    if (run("git", ["branch", "--show-current"], worktree).trim() !== branch)
      throw new Error(`${worktree} is not on ${branch}`);
    requireClean(worktree, branch);
    if (
      run("git", ["rev-parse", "HEAD"], worktree).trim() !==
      run("git", ["rev-parse", integrationBranch], worktree).trim()
    )
      throw new Error(`${branch} is not at the current ${integrationBranch} baseline`);

    const plannerPane = string(process.env["HERDR_PANE_ID"], "HERDR_PANE_ID");
    const agent = object(result(herdr(["agent", "get", plannerPane]))["agent"], "result.agent");
    const expectedPlanner = `${slug.replaceAll("-", "_")}_planner`;
    if (string(agent["name"], "result.agent.name") !== expectedPlanner)
      throw new Error(`Approval must run from planner ${expectedPlanner}`);
    const processes = foregroundProcesses(paneProcessInfo(plannerPane));
    if (
      !processes.some(
        (process) => canonicalPath(string(process["cwd"], "planner cwd")) === worktree,
      )
    )
      throw new Error(`Planner pane ${plannerPane} is not running in ${worktree}`);

    const documents = join(workspaceRoot, "stream", slug);
    const proposalPath = join(documents, "change.md");
    const journalPath = join(documents, "planner.md");
    const changes = join(documents, "changes");
    const current = proposal(readFileSync(proposalPath, "utf8"));
    if (current.title.includes("”"))
      throw new Error("change.md title cannot contain a closing quotation mark");
    const journal = readFileSync(journalPath, "utf8");
    const recorded = approvals(journal);
    const files = readdirSync(changes).filter((file) => /^\d{3}\.md$/.test(file));

    for (const record of recorded) {
      const path = join(changes, `${record.number}.md`);
      if (!existsSync(path)) {
        if (record.hash !== current.hash || record.title !== current.title)
          throw new Error(
            `planner.md approval for changes/${record.number}.md has no approved file`,
          );
        continue;
      }
      const approved = proposal(readFileSync(path, "utf8"));
      if (approved.hash !== record.hash || approved.title !== record.title)
        throw new Error(`planner.md approval conflicts with changes/${record.number}.md`);
    }

    const matchingRecords = recorded.filter((record) => record.hash === current.hash);
    if (
      matchingRecords.some((record) => record.title !== current.title) ||
      matchingRecords.length > 1
    )
      throw new Error("planner.md has an ambiguous approval for change.md");
    const matchingFiles = files.filter(
      (file) =>
        createHash("sha256")
          .update(readFileSync(join(changes, file), "utf8"))
          .digest("hex") === current.hash,
    );
    if (matchingFiles.length > 1) throw new Error("Multiple approved files match change.md");

    let approval: Approval;
    if (matchingRecords.length === 1) {
      approval = matchingRecords[0]!;
      if (matchingFiles.length === 1 && matchingFiles[0] !== `${approval.number}.md`)
        throw new Error("planner.md approval conflicts with the approved change file");
      const path = join(changes, `${approval.number}.md`);
      if (!existsSync(path)) writeFileSync(path, readFileSync(proposalPath), { flag: "wx" });
    } else if (matchingFiles.length === 1) {
      const number = basename(matchingFiles[0]!, ".md");
      if (`${number}.md` !== files.sort().at(-1))
        throw new Error("Approved file matching change.md is ambiguous");
      approval = { number, ...current };
      appendFileSync(
        journalPath,
        `${journal.endsWith("\n") ? "\n" : "\n\n"}${approvalEntry(approval)}`,
      );
    } else {
      const greatest = files
        .map((file) => Number(basename(file, ".md")))
        .reduce((max, number) => Math.max(max, number), 0);
      if (greatest >= 999) throw new Error("Cannot approve another change after 999");
      approval = { number: String(greatest + 1).padStart(3, "0"), ...current };
      writeFileSync(join(changes, `${approval.number}.md`), readFileSync(proposalPath), {
        flag: "wx",
      });
      appendFileSync(
        journalPath,
        `${journal.endsWith("\n") ? "\n" : "\n\n"}${approvalEntry(approval)}`,
      );
    }
    console.log(
      JSON.stringify({
        number: approval.number,
        changePath: join(changes, `${approval.number}.md`),
        title: approval.title,
      }),
    );
  }

  async function dispatch(changeArgument: string): Promise<void> {
    if (process.env["HERDR_ENV"] !== "1")
      throw new Error("Dispatch must run from a Herdr-managed planner");

    const { change, slug, number, worktree, branch } = requireChange(changeArgument);
    const implementerName = `${slug.replaceAll("-", "_")}_impl`;
    if (canonicalPath(process.cwd()) !== worktree) {
      throw new Error(`Dispatch cwd is ${process.cwd()}, expected ${worktree}`);
    }
    if (run("git", ["branch", "--show-current"], worktree).trim() !== branch) {
      throw new Error(`${worktree} is not on ${branch}`);
    }
    requireClean(worktree, branch);
    const prompts = promptDirectory(worktree);
    const selection = readProject(worktree).implementer;
    const attemptId = crypto.randomUUID();
    const reportPath = join(workspaceRoot, "metrics", slug, `.attempt-${attemptId}.json`);
    const fallbackAttempt = incompleteAttempt(attemptId, slug, number, selection, "initial");
    observe("dispatch metrics", () => recordDispatch(workspaceRoot, slug, number));
    await validateRoleSelection("implementer", selection, worktree);

    const plannerPane = string(process.env["HERDR_PANE_ID"], "HERDR_PANE_ID");
    const plannerProcesses = foregroundProcesses(paneProcessInfo(plannerPane));
    if (
      !plannerProcesses.some(
        (process) => canonicalPath(string(process["cwd"], "planner cwd")) === worktree,
      )
    ) {
      throw new Error(`Planner pane ${plannerPane} is not running in ${worktree}`);
    }

    const layout = object(
      result(herdr(["pane", "layout", "--pane", plannerPane]))["layout"],
      "result.layout",
    );
    let implementerPane = rightPane(layout, plannerPane);
    if (implementerPane === undefined) {
      const split = herdr([
        "pane",
        "split",
        "--pane",
        plannerPane,
        "--direction",
        "right",
        "--ratio",
        "0.5",
        "--cwd",
        worktree,
        "--no-focus",
      ]);
      implementerPane = id(split, "pane", "pane_id");
    } else {
      const info = paneProcessInfo(implementerPane);
      const processes = foregroundProcesses(info);
      if (!(processes.length === 1 && isShell(processes[0]!))) {
        const occupant = object(
          result(herdr(["agent", "get", implementerPane]))["agent"],
          "result.agent",
        );
        const occupantName = string(occupant["name"], "result.agent.name");
        const occupantStatus = string(occupant["agent_status"], "result.agent.agent_status");
        if (occupantName !== implementerName || !["idle", "done"].includes(occupantStatus)) {
          throw new Error(
            `Right-hand pane ${implementerPane} is occupied by ${occupantName} in ${occupantStatus} state`,
          );
        }
        herdr(["agent", "send-keys", implementerName, "ctrl+d"]);
      }
    }
    requirePaneShell(implementerPane, worktree);

    const collection = JSON.stringify({
      id: attemptId,
      stream: slug,
      change: number,
      kind: "initial",
      path: reportPath,
    });
    const started = herdr([
      "agent",
      "start",
      implementerName,
      "--kind",
      "pi",
      "--pane",
      implementerPane,
      "--",
      "--no-session",
      "--extension",
      implementerReportingExtension,
      "--codeless-attempt",
      collection,
      "--name",
      `${slug}-impl`,
      ...roleSelectionArguments(selection),
      "--prompt-template",
      prompts,
      "--approve",
    ]);
    const startedAgent = object(result(started)["agent"], "result.agent");
    const startedCwd = string(
      startedAgent["foreground_cwd"] ?? startedAgent["cwd"],
      "started agent cwd",
    );
    if (canonicalPath(startedCwd) !== worktree) {
      throw new Error(`${implementerName} started in ${startedCwd}, expected ${worktree}`);
    }

    run("herdr", [
      "agent",
      "prompt",
      implementerName,
      `/implement ${JSON.stringify(change)}`,
      "--wait",
      "--timeout",
      "3600000",
    ]);
    let attempt = fallbackAttempt;
    try {
      attempt = collectedAttempt(JSON.parse(readFileSync(reportPath, "utf8")), fallbackAttempt);
      if (attempt === fallbackAttempt) throw new Error("report did not match its dispatch attempt");
    } catch (error) {
      console.error(
        `codeless: warning: could not collect implementer attempt: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (existsSync(reportPath)) unlinkSync(reportPath);
    }
    observe("implementer attempt", () => recordAttempt(workspaceRoot, slug, number, attempt));
    console.log(JSON.stringify(attempt));
  }

  function activeImplementer(changeArgument: string): {
    change: string;
    slug: string;
    number: string;
    worktree: string;
    implementerName: string;
    pane: string;
  } {
    if (process.env["HERDR_ENV"] !== "1")
      throw new Error("Implementer control must run from a Herdr-managed planner");
    const { change, slug, number, worktree, branch } = requireChange(changeArgument);
    if (canonicalPath(process.cwd()) !== worktree)
      throw new Error(`Implementer control cwd is ${process.cwd()}, expected ${worktree}`);
    if (run("git", ["branch", "--show-current"], worktree).trim() !== branch)
      throw new Error(`${worktree} is not on ${branch}`);
    const plannerPane = string(process.env["HERDR_PANE_ID"], "HERDR_PANE_ID");
    const plannerProcesses = foregroundProcesses(paneProcessInfo(plannerPane));
    if (
      !plannerProcesses.some(
        (process) => canonicalPath(string(process["cwd"], "planner cwd")) === worktree,
      )
    )
      throw new Error(`Planner pane ${plannerPane} is not running in ${worktree}`);
    const layout = object(
      result(herdr(["pane", "layout", "--pane", plannerPane]))["layout"],
      "result.layout",
    );
    const pane = rightPane(layout, plannerPane);
    if (pane === undefined) throw new Error("Planner has no right-hand implementer pane");
    const implementerName = `${slug.replaceAll("-", "_")}_impl`;
    const agent = object(result(herdr(["agent", "get", pane]))["agent"], "result.agent");
    if (string(agent["name"], "result.agent.name") !== implementerName)
      throw new Error(`Right-hand pane ${pane} is not implementer ${implementerName}`);
    if (!["idle", "done"].includes(string(agent["agent_status"], "result.agent.agent_status")))
      throw new Error(`Implementer ${implementerName} is not settled`);
    const agentCwd = string(agent["foreground_cwd"] ?? agent["cwd"], "result.agent.foreground_cwd");
    if (canonicalPath(agentCwd) !== worktree)
      throw new Error(`Implementer ${implementerName} is in ${agentCwd}, expected ${worktree}`);
    const processes = foregroundProcesses(paneProcessInfo(pane));
    if (
      !processes.some(
        (process) => canonicalPath(string(process["cwd"], "implementer cwd")) === worktree,
      )
    )
      throw new Error(`Implementer pane ${pane} is not running in ${worktree}`);
    return { change, slug, number, worktree, implementerName, pane };
  }

  async function rework(changeArgument: string, feedback: string): Promise<void> {
    if (feedback.trim().length === 0 || feedback.trim().length > 2_000)
      throw new Error("Rework feedback must be concise non-empty text");
    const { slug, number, implementerName } = activeImplementer(changeArgument);
    const attemptId = crypto.randomUUID();
    const reportPath = join(workspaceRoot, "metrics", slug, `.attempt-${attemptId}.json`);
    const fallbackAttempt = incompleteAttempt(attemptId, slug, number, undefined, "rework");
    const collection = JSON.stringify({
      id: attemptId,
      stream: slug,
      change: number,
      kind: "rework",
      path: reportPath,
      feedback: feedback.trim(),
    });
    run("herdr", [
      "agent",
      "prompt",
      implementerName,
      `/codeless-rework ${collection}`,
      "--wait",
      "--timeout",
      "3600000",
    ]);
    let attempt = fallbackAttempt;
    try {
      attempt = collectedAttempt(JSON.parse(readFileSync(reportPath, "utf8")), fallbackAttempt);
      if (attempt === fallbackAttempt) throw new Error("report did not match its rework attempt");
    } catch (error) {
      console.error(
        `codeless: warning: could not collect implementer attempt: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (existsSync(reportPath)) unlinkSync(reportPath);
    }
    observe("implementer attempt", () => recordAttempt(workspaceRoot, slug, number, attempt));
    console.log(JSON.stringify(attempt));
  }

  function finish(changeArgument: string): void {
    const { slug, number, worktree, implementerName, pane } = activeImplementer(changeArgument);
    run("herdr", [
      "agent",
      "prompt",
      implementerName,
      `/codeless-finish ${JSON.stringify({ stream: slug, change: number })}`,
      "--wait",
      "--timeout",
      "30000",
    ]);
    requirePaneShell(pane, worktree);
    console.log(JSON.stringify({ pane, worktree }));
  }

  function acquireLandSlot(lock: string, slug: string, base: string): "acquired" | "resumed" {
    let acquired = false;
    try {
      mkdirSync(lock);
      acquired = true;
    } catch {
      if (!existsSync(lock)) throw new Error(`Could not create integration slot ${lock}`);
    }

    const ownerFile = join(lock, "owner");
    const baseFile = join(lock, "base");
    if (acquired) {
      writeFileSync(ownerFile, `${slug}\n`, { flag: "wx" });
      writeFileSync(baseFile, `${base}\n`, { flag: "wx" });
      return "acquired";
    }

    const owner = existsSync(ownerFile) ? readFileSync(ownerFile, "utf8").trim() : "";
    if (owner !== slug) {
      throw new Error(
        owner
          ? `Integration slot is held by ${owner}; ${slug} remains committed and must try again later`
          : `Integration slot ${lock} has no owner; inspect it manually`,
      );
    }

    const recordedBase = existsSync(baseFile) ? readFileSync(baseFile, "utf8").trim() : "";
    if (recordedBase !== base) {
      throw new Error(
        `Integration slot for ${slug} recorded ${integrationBranch} at ${recordedBase || "<missing>"}, but ${integrationBranch} is now ${base}; inspect it manually`,
      );
    }
    return "resumed";
  }

  function releaseLandSlot(lock: string, slug: string): void {
    const ownerFile = join(lock, "owner");
    const owner = existsSync(ownerFile) ? readFileSync(ownerFile, "utf8").trim() : "";
    if (owner !== slug)
      throw new Error(`Refusing to release integration slot owned by ${owner || "<unknown>"}`);
    for (const name of ["owner", "base"]) {
      const file = join(lock, name);
      if (existsSync(file)) unlinkSync(file);
    }
    rmdirSync(lock);
  }

  function land(slug: string): void {
    const worktree = join(workspaceRoot, "worktree", slug);
    const integrationCheckout = integrationWorktree();
    const branch = `stream/${slug}`;
    const lock = join(workspaceRoot, ".land-lock");

    if (!existsSync(worktree)) throw new Error(`Missing ${worktree}`);
    if (!existsSync(integrationCheckout)) throw new Error(`Missing ${integrationCheckout}`);
    if (run("git", ["branch", "--show-current"], worktree).trim() !== branch) {
      throw new Error(`${worktree} is not on ${branch}`);
    }
    if (
      run("git", ["branch", "--show-current"], integrationCheckout).trim() !== integrationBranch
    ) {
      throw new Error(`${integrationCheckout} is not on ${integrationBranch}`);
    }
    requireClean(worktree, branch);

    requireClean(integrationCheckout, `${integrationBranch} integration worktree`);
    const mergeBase = run("git", ["merge-base", integrationBranch, branch], repository).trim();
    const streamCommits = Number(
      run("git", ["rev-list", "--count", `${mergeBase}..${branch}`], repository).trim(),
    );
    if (streamCommits !== 1) {
      throw new Error(`${branch} must contain exactly one change commit, found ${streamCommits}`);
    }

    const base = run("git", ["rev-parse", integrationBranch], repository).trim();
    const slot = acquireLandSlot(lock, slug, base);
    console.log(
      `${slot === "acquired" ? "Acquired" : "Resumed"} integration slot for ${slug} at ${base}`,
    );

    try {
      if (
        !succeeds("git", ["merge-base", "--is-ancestor", integrationBranch, branch], repository)
      ) {
        console.log(`Rebasing ${branch} onto current ${integrationBranch}...`);
        runVisible("git", ["rebase", integrationBranch], worktree);
      }

      if (
        run(
          "git",
          ["rev-list", "--count", `${integrationBranch}..${branch}`],
          repository,
        ).trim() !== "1"
      ) {
        throw new Error(
          `${branch} is not exactly one commit ahead of ${integrationBranch} after rebase`,
        );
      }

      console.log("Running project checks...");
      const [command, ...args] = readProject(worktree).check;
      runVisible(command, args, worktree);
      requireClean(worktree, branch);
      run("git", ["merge", "--ff-only", branch], integrationCheckout);
      const commit = run("git", ["rev-parse", integrationBranch], repository).trim();
      observe("landing metrics", () =>
        recordLanding(workspaceRoot, slug, latestChangeNumber(slug), commit),
      );
      releaseLandSlot(lock, slug);
      console.log(`Landed ${branch} on ${integrationBranch} at ${commit}`);
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nIntegration slot remains held by ${slug}; resolve the problem in its worktree, then run codeless land ${slug} again`,
      );
    }
  }

  if (action === "init") {
    if (target !== undefined || details.length > 0) throw new Error(usage);
    init();
    return;
  }
  if (action === "metrics") {
    if (target !== undefined || details.length > 0) throw new Error(usage);
    for (const line of metricReport(workspaceRoot)) console.log(line);
    return;
  }
  if (action === "approve") {
    if (target === undefined || details.length > 0) throw new Error(usage);
    approve(target);
    return;
  }
  if (action === "dispatch") {
    if (target === undefined || details.length > 0) throw new Error(usage);
    await dispatch(target);
    return;
  }
  if (action === "rework") {
    if (target === undefined || details.length !== 1) throw new Error(usage);
    await rework(target, details[0]!);
    return;
  }
  if (action === "finish") {
    if (target === undefined || details.length > 0) throw new Error(usage);
    finish(target);
    return;
  }
  if (action === "next") {
    if (target === undefined || details.length !== 1) throw new Error(usage);
    await nextChange(target, details[0]!);
    return;
  }
  const slug = target;
  if (
    (action !== "create" && action !== "open" && action !== "land") ||
    slug === undefined ||
    !/^[a-z][a-z0-9-]{0,23}$/.test(slug) ||
    details.length > 0
  ) {
    throw new Error(`${usage}\n\nSlug must be lowercase kebab-case and at most 24 characters.`);
  }
  if (action === "land") {
    land(slug);
    return;
  }
  if (process.env["HERDR_ENV"] !== "1") {
    throw new Error("Run codeless from a Herdr-managed shell pane");
  }

  const documents = join(workspaceRoot, "stream", slug);
  const worktree = join(workspaceRoot, "worktree", slug);
  const branch = `stream/${slug}`;
  let opened: Record<string, unknown>;
  if (action === "open") {
    requireDirection(slug, worktree);
    promptDirectory(worktree);
  }

  if (action === "create") {
    if (existsSync(documents) || existsSync(worktree)) {
      throw new Error(`Stream already exists: ${slug}`);
    }
    requireDirection(slug, integrationWorktree());
    promptDirectory(integrationWorktree());
    run("git", ["show-ref", "--verify", `refs/heads/${integrationBranch}`], repository);
    opened = herdr([
      "worktree",
      "create",
      "--cwd",
      repository,
      "--branch",
      branch,
      "--base",
      integrationBranch,
      "--path",
      worktree,
      "--label",
      slug,
      "--no-focus",
    ]);
    await createDocuments(slug, documents, worktree);
  } else {
    for (const file of ["planner.md", "change.md"]) {
      if (!existsSync(join(documents, file))) throw new Error(`Missing ${join(documents, file)}`);
    }
    if (!existsSync(worktree)) throw new Error(`Missing ${worktree}`);
    const actualBranch = run("git", ["branch", "--show-current"], worktree).trim();
    if (actualBranch !== branch)
      throw new Error(`${worktree} is on ${actualBranch}, expected ${branch}`);
    opened = herdr(["worktree", "open", "--path", worktree, "--label", slug, "--no-focus"]);
  }

  const workspace = id(opened, "workspace", "workspace_id");
  const plannerPane = id(opened, "root_pane", "pane_id");
  if (plannerPane === process.env["HERDR_PANE_ID"]) {
    throw new Error(
      "Run codeless open from another Herdr shell; the planner pane must be available",
    );
  }
  const planner = `${slug.replaceAll("-", "_")}_planner`;
  const layout = object(
    result(herdr(["pane", "layout", "--pane", plannerPane]))["layout"],
    "result.layout",
  );
  const implementerPane = rightPane(layout, plannerPane);
  const panes = layout["panes"] as JsonObject[];
  if (panes.length !== (implementerPane === undefined ? 1 : 2)) {
    throw new Error(
      "Stream layout must contain only the planner and an optional right-hand implementer pane",
    );
  }

  function requireLaunchShell(pane: string): void {
    const processes = foregroundProcesses(paneProcessInfo(pane));
    if (processes.length !== 1 || !isShell(processes[0]!)) {
      throw new Error(`Pane ${pane} must be an available shell before opening the stream`);
    }
    if (canonicalPath(string(processes[0]!["cwd"], "shell cwd")) !== worktree) {
      throw new Error(`Pane ${pane} shell is not in ${worktree}`);
    }
  }

  function requireManagedPlanner(agent: JsonObject): void {
    if (
      agent["name"] !== planner ||
      agent["agent"] !== "pi" ||
      agent["interactive_ready"] !== true
    ) {
      throw new Error(
        `Planner pane ${plannerPane} must contain the Herdr-managed ${planner}; exit an unmanaged agent before reopening`,
      );
    }
    if (canonicalPath(string(agent["foreground_cwd"], "planner foreground cwd")) !== worktree) {
      throw new Error(`Planner ${planner} is not in ${worktree}`);
    }
    const session = object(agent["agent_session"], "planner agent_session");
    if (
      agent["screen_detection_skipped"] !== true ||
      session["source"] !== "herdr:pi" ||
      session["agent"] !== "pi"
    ) {
      throw new Error(
        "Planner requires Herdr's official Pi lifecycle integration; run herdr integration install pi before reopening",
      );
    }
  }

  if (action === "create" || result(opened)["already_open"] === false) {
    requirePaneShell(plannerPane, worktree);
  }
  const plannerProcesses = foregroundProcesses(paneProcessInfo(plannerPane));
  if (!(plannerProcesses.length === 1 && isShell(plannerProcesses[0]!))) {
    requireManagedPlanner(
      object(result(herdr(["agent", "get", plannerPane]))["agent"], "result.agent"),
    );
    run("herdr", ["workspace", "focus", workspace]);
    console.log(`Focused existing planner ${planner}; its session and work remain unchanged.`);
    return;
  }
  requireLaunchShell(plannerPane);
  if (implementerPane !== undefined) requireLaunchShell(implementerPane);

  console.log("Installing project dependencies...");
  const [install, ...installArgs] = readProject(worktree).install;
  run(install, installArgs, worktree);
  const selection = readProject(worktree).planner;
  await validateRoleSelection("planner", selection, worktree, plannerExtension);
  console.log(roleSelectionSummary("planner", selection));

  // Recheck after installation/preflight; Herdr owns final interactive readiness.
  requireLaunchShell(plannerPane);
  if (implementerPane === undefined) {
    const split = herdr([
      "pane",
      "split",
      "--pane",
      plannerPane,
      "--direction",
      "right",
      "--ratio",
      "0.5",
      "--cwd",
      worktree,
      "--no-focus",
    ]);
    requirePaneShell(id(split, "pane", "pane_id"), worktree);
  } else {
    requireLaunchShell(implementerPane);
  }
  const started = herdr([
    "agent",
    "start",
    planner,
    "--kind",
    "pi",
    "--pane",
    plannerPane,
    "--",
    "--name",
    `${slug}-planner`,
    ...roleSelectionArguments(selection),
    "--extension",
    plannerExtension,
    "--prompt-template",
    promptDirectory(worktree),
    "--approve",
  ]);
  requireManagedPlanner(object(result(started)["agent"], "result.agent"));
  run("herdr", [
    "agent",
    "prompt",
    plannerPane,
    activationPrompt(changePrompt(slug, documents, worktree)),
  ]);
  run("herdr", ["workspace", "focus", workspace]);
  console.log(`Opened ${slug}: planner on the left, implementer shell on the right.`);
}
