import { describe, expect, it } from "vitest";

import { cliCommand, cliPrefix } from "./cli-invocation.ts";

describe("cliPrefix", () => {
  it("prints commands the way the CLI was started", () => {
    expect(cliPrefix({}, "/home/me/.npm/_npx/1a2b/node_modules/@seira-bot/seira/dist-server/seira.js")).toBe("npx @seira-bot/seira");
    expect(cliPrefix({ npm_command: "exec" }, "/repo/node_modules/vitest/vitest.mjs"), "another tool run by npx").toBe("seira");
    expect(cliPrefix({ npm_lifecycle_event: "seira" }, "/repo/server/seira.ts")).toBe("pnpm seira");
    expect(cliPrefix({ SEIRA_CLI_PREFIX: "docker compose exec seira seira" }, "/app/dist-server/seira.js")).toBe("docker compose exec seira seira");
    expect(cliPrefix({}, "/usr/lib/node_modules/@seira-bot/seira/dist-server/seira.js")).toBe("seira");
    expect(cliCommand("pair", {}, "C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\9\\node_modules\\seira\\x.js")).toBe("npx @seira-bot/seira pair");
  });
});
