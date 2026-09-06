import { Schema } from "effect";
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export const ThinkingLevel = Schema.Literals([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export const RoleSelection = Schema.Struct({
  provider: Schema.NonEmptyString,
  model: Schema.NonEmptyString,
  thinking: ThinkingLevel,
});

export type RoleSelection = typeof RoleSelection.Type;

const Project = Schema.Struct({
  integrationBranch: Schema.NonEmptyString,
  directions: Schema.NonEmptyString,
  prompts: Schema.NonEmptyString,
  install: Schema.NonEmptyArray(Schema.String),
  check: Schema.NonEmptyArray(Schema.String),
  planner: RoleSelection,
  implementer: RoleSelection,
});

export function readProject(worktree: string) {
  const path = join(worktree, ".codeless/config.json");
  try {
    const project = Schema.decodeUnknownSync(Project, { onExcessProperty: "error" })(
      JSON.parse(readFileSync(path, "utf8")),
    );
    for (const field of ["directions", "prompts"] as const) {
      const value = project[field];
      const local = relative(worktree, resolve(worktree, value));
      if (isAbsolute(value) || local === ".." || local.startsWith("../")) {
        throw new Error(`${field} must be a path inside the project`);
      }
    }
    for (const field of ["install", "check"] as const) {
      if (!project[field][0].trim()) throw new Error(`${field} needs an executable`);
    }
    return project;
  } catch (error) {
    throw new Error(
      `Invalid Codeless project configuration at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
