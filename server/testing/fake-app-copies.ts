// Fake copies of the npm package for the update tests: a tiny CLI that prints its version, or serves /api/health.
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

import { copyCli, realExec, type Exec } from "../app-update.ts";

/** `ok` answers with its version. `exit` stops at once. `wrong` answers with another version. `hang` never answers. */
export type FakeMode = "ok" | "exit" | "wrong" | "hang";

export function fakeCliSource(version: string, mode: FakeMode): string {
  return `const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log(${JSON.stringify(version)}); process.exit(0); }
const at = (name) => args[args.indexOf(name) + 1];
const dataDir = at("--data-dir");
if (dataDir) {
  fs.writeFileSync(path.join(dataDir, "written-by-" + ${JSON.stringify(version)}), "x");
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ migratedBy: ${JSON.stringify(version)} }));
  fs.appendFileSync(path.join(dataDir, "starts.log"), process.env.SEIRA_APP_HANDOFF + " " + ${JSON.stringify(version)} + "\\n");
}
if (${JSON.stringify(mode)} === "exit") setTimeout(() => process.exit(3), 100);
else if (${JSON.stringify(mode)} === "hang") setInterval(() => {}, 1000);
else {
  const server = http.createServer((req, res) => res.end(JSON.stringify({ app: "seira", version: ${JSON.stringify(mode === "wrong" ? "9.9.9" : version)} })));
  server.listen(Number(at("--port")), "127.0.0.1");
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
}
`;
}

/** The folder of one copy, as `npm install --prefix` leaves it. */
export function writeFakeCopy(prefix: string, version: string, mode: FakeMode = "ok"): void {
  const dir = join(prefix, "node_modules", "@seira-bot", "seira");
  mkdirSync(dir, { recursive: true });
  writeFileSync(copyCli(prefix), fakeCliSource(version, mode));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@seira-bot/seira", version }));
}

/** npm writes a fake copy (or fails for the versions named in `fail`); every other command runs for real. */
export function fakeNpmExec(modes: Record<string, FakeMode>, fail: string[] = [], calls: string[][] = []): Exec {
  const real = realExec();
  return async (command, args, options) => {
    if (command !== "npm" && command !== "npm.cmd") return real(command, args, options);
    calls.push(args);
    const prefix = args[args.indexOf("--prefix") + 1]!;
    const version = args.find((arg) => arg.startsWith("@seira-bot/seira@"))!.split("@").pop()!;
    if (fail.includes(version)) return { code: 1, out: "failed" };
    writeFakeCopy(prefix, version, modes[version] ?? "ok");
    return { code: 0, out: "" };
  };
}

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
