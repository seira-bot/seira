import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { removeTempDir } from "./cleanup.ts";

type Frame = { type: unknown; message?: { content?: Array<{ type?: string; name?: string; input?: { command?: string } }> } };

const toolUses = async (routes: string | null, prompt: string): Promise<string[]> => {
  const home = mkdtempSync(join(tmpdir(), "seira-claude-routes-"));
  try {
    const routesFile = join(home, "routes.json");
    if (routes !== null) writeFileSync(routesFile, routes);
    const child = spawn(process.execPath, [
      fileURLToPath(new URL("fake-claude-cli.ts", import.meta.url)),
      "--output-format", "stream-json",
    ], {
      cwd: home,
      env: {
        ...process.env, HOME: home, USERPROFILE: home,
        FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_EXIT_AFTER_TURN: "1",
        FAKE_CLAUDE_TOOL_ROUTES: routesFile,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.stdin.end(JSON.stringify({ type: "user", message: { role: "user", content: prompt } }) + "\n");
    await closed;
    const frames: Frame[] = out.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    return frames
      .filter((frame) => frame.type === "assistant")
      .flatMap((frame) => frame.message?.content ?? [])
      .filter((block) => block.type === "tool_use")
      .map((block) => `${block.name}:${block.input?.command ?? ""}`);
  } finally {
    await removeTempDir(home);
  }
};

const routes = JSON.stringify({ "routed marker": [{ name: "Bash", input: { command: "routed" }, output: "done" }] });

it("plays the calls of the marker that the prompt contains", async () => {
  expect(await toolUses(routes, "please use the routed marker now")).toEqual(["Bash:routed"]);
});

it.each([
  ["no marker matches", routes],
  ["the file has bad JSON", "{ not json"],
  ["the file is missing", null],
])("keeps the default calls when %s", async (_label, file) => {
  expect(await toolUses(file, "an ordinary message")).toEqual(["Bash:echo hi"]);
});
