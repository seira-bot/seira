import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("one call control at a time", () => {
  it("keeps the call pill out of the sidebar and the call chip out of the chat", () => {
    expect(() => read("src/components/LiveCallPill.tsx")).toThrow();
    for (const path of ["src/components/Sidebar.tsx", "src/components/ChatView.tsx", "src/components/GroupView.tsx", "src/App.tsx"]) {
      expect(read(path), path).not.toMatch(/LiveCallPill|LiveCallChip/);
    }
  });

  it("mounts the call surface in the chat and the room, and the call host once", () => {
    expect(read("src/components/ChatView.tsx")).toMatch(/<CallSurface botId=\{bot\.id\} \/>/);
    expect(read("src/components/GroupView.tsx")).toMatch(/<CallSurface \/>/);
    expect(read("src/App.tsx").match(/<CallHost \/>/g)).toHaveLength(1);
  });

  it("leaves only a phone's call and a call notice to the bar above the composer", () => {
    const bar = read("src/components/LiveCallBar.tsx");
    expect(bar).not.toMatch(/setLiveMuted|hangUpLiveCall\(|kind: "local"/);
  });
});
