import { describe, expect, it } from "vitest";

import { laptopLines, laptopLinesHere } from "./cli-devices.ts";

describe("the laptop lines", () => {
  it("print the ssh -L line, then the step that signs the browser in", () => {
    const lines = laptopLines({ port: 8799, user: "alice", host: "box", prefix: "seira" });
    expect(lines[0]).toBe("Laptop   ssh -L 8799:127.0.0.1:8799 alice@box");
    expect(lines[1]).toContain("`seira pair`");
    expect(lines[1]).toContain("Browser on this machine");
    expect(lines).toHaveLength(2);
  });

  it("use the port and the way the CLI was started", () => {
    const lines = laptopLines({ port: 18451, user: "alice", host: "box", prefix: "npx @seira-bot/seira" });
    expect(lines.join("\n")).toContain("-L 18451:127.0.0.1:18451");
    expect(lines[1]).toContain("`npx @seira-bot/seira pair`");
  });

  it("read this machine's user and host when it runs", () => {
    expect(laptopLinesHere(8799, "seira")[0]).toMatch(/^Laptop {3}ssh -L 8799:127\.0\.0\.1:8799 \S+@\S+$/);
  });
});
