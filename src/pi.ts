import type { RoleSelection } from "./project.ts";

type Role = "planner" | "implementer";
type JsonObject = Record<string, unknown>;

const validationTimeoutMs = 30_000;

function object(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Pi RPC response omitted ${label}`);
  }
  return value as JsonObject;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`Pi RPC response omitted ${label}`);
  }
  return value;
}

export function roleSelectionReference(selection: RoleSelection): string {
  return `${selection.provider}/${selection.model}`;
}

export function roleSelectionSummary(role: Role, selection: RoleSelection): string {
  const label = role === "planner" ? "Planner" : "Implementer";
  return `${label}: ${roleSelectionReference(selection)} (thinking: ${selection.thinking})`;
}

export function roleSelectionArguments(selection: RoleSelection): string[] {
  return ["--model", roleSelectionReference(selection), "--thinking", selection.thinking];
}

export async function validateRoleSelection(
  role: Role,
  selection: RoleSelection,
  worktree: string,
  extension?: string,
): Promise<void> {
  const reference = roleSelectionReference(selection);
  const label = role === "planner" ? "Planner" : "Implementer";
  const child = Bun.spawn(
    [
      "pi",
      "--mode",
      "rpc",
      "--no-session",
      "--approve",
      ...(extension === undefined ? [] : ["--extension", extension]),
    ],
    {
      cwd: worktree,
      env: process.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let requestNumber = 0;
  const timeout = setTimeout(() => child.kill(), validationTimeoutMs);

  async function line(): Promise<string> {
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        const value = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        return value;
      }
      const chunk = await reader.read();
      if (chunk.done) {
        buffer += decoder.decode();
        if (buffer.length > 0) {
          const value = buffer.replace(/\r$/, "");
          buffer = "";
          return value;
        }
        const diagnostic = (await stderr).trim();
        throw new Error(
          diagnostic || `Pi RPC exited with code ${await child.exited} before responding`,
        );
      }
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  }

  async function request(type: string, fields: JsonObject = {}): Promise<unknown> {
    const id = `streams-${++requestNumber}`;
    await child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
    await child.stdin.flush();
    while (true) {
      const output = await line();
      let response: JsonObject;
      try {
        response = object(JSON.parse(output), "object");
      } catch (error) {
        throw new Error(
          `Pi RPC returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (response["type"] !== "response" || response["id"] !== id) continue;
      if (response["success"] !== true) {
        throw new Error(
          typeof response["error"] === "string"
            ? response["error"]
            : `Pi RPC ${type} request failed`,
        );
      }
      return response["data"];
    }
  }

  try {
    const available = object(await request("get_available_models"), "data")["models"];
    if (!Array.isArray(available)) throw new Error("Pi RPC response omitted data.models");
    const model = available
      .map((value, index) => object(value, `data.models[${index}]`))
      .find((value) => value["provider"] === selection.provider && value["id"] === selection.model);
    if (model === undefined) {
      throw new Error(
        `${reference} is not available; check the exact provider/model and Pi authentication`,
      );
    }

    await request("set_model", { provider: selection.provider, modelId: selection.model });
    const levels = strings(
      object(await request("get_available_thinking_levels"), "data")["levels"],
      "data.levels",
    );
    if (!levels.includes(selection.thinking)) {
      throw new Error(
        `${reference} does not support thinking level ${selection.thinking}; supported levels: ${levels.join(", ")}`,
      );
    }

    await request("set_thinking_level", { level: selection.thinking });
    if (extension !== undefined) {
      const commands = object(await request("get_commands"), "data")["commands"];
      if (
        !Array.isArray(commands) ||
        !commands.some((command) => object(command, "command")["name"] === "streams-activate")
      ) {
        throw new Error("the Codeless planner extension did not register streams-activate");
      }
    }

    const state = object(await request("get_state"), "data");
    const effectiveModel = object(state["model"], "data.model");
    if (
      effectiveModel["provider"] !== selection.provider ||
      effectiveModel["id"] !== selection.model ||
      state["thinkingLevel"] !== selection.thinking
    ) {
      const effectiveReference = `${String(effectiveModel["provider"])}/${String(effectiveModel["id"])}`;
      throw new Error(
        `Pi applied ${effectiveReference} at ${String(state["thinkingLevel"])} instead of the requested selection`,
      );
    }
  } catch (error) {
    throw new Error(
      `${label} requested ${reference} at thinking level ${selection.thinking}, but validation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timeout);
    await child.stdin.end();
    await child.exited;
    reader.releaseLock();
  }
}
