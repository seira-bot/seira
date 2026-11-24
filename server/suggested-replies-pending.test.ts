import { describe, expect, it } from "vitest";
import { PendingSuggestedReplies } from "./suggested-replies-pending.ts";

const chip = (n: number) => ({ title: `Chip ${n}`, prompt: `Please do thing ${n}.` });

describe("chips held for a running turn", () => {
  it("keeps at most 4 cleaned entries and hands them over once", () => {
    const pending = new PendingSuggestedReplies();
    expect(pending.offer("t", [chip(1), chip(2), { title: "", prompt: "empty title" }, chip(3), chip(4), chip(5)])).toBe(4);
    expect(pending.take("t")).toEqual([chip(1), chip(2), chip(3), chip(4)]);
    expect(pending.take("t")).toBeUndefined();
  });

  it("drops links, commands, shell text and oversized text", () => {
    const pending = new PendingSuggestedReplies();
    const bad = [
      { title: "Link", prompt: "Open https://example.test now." }, { title: "Slash", prompt: "/clear everything" },
      { title: "Shell", prompt: "git push --force" }, { title: "Long", prompt: "x".repeat(501) },
      { title: "T".repeat(41), prompt: "Fine prompt." }, { title: "Run it", prompt: "sudo rm -rf /" },
    ];
    expect(pending.offer("t", bad)).toBe(0);
    expect(pending.take("t")).toBeUndefined();
  });

  it("drops an entry that holds a secret instead of changing what a tap sends", () => {
    const pending = new PendingSuggestedReplies();
    expect(pending.offer("t", [{ title: "Use key", prompt: "Use the key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 for it." }, chip(1)])).toBe(1);
    expect(pending.take("t")).toEqual([chip(1)]);
  });

  it("keeps each thread apart, replaces an earlier offer and forgets when a turn starts", () => {
    const pending = new PendingSuggestedReplies();
    pending.offer("a", [chip(1)]);
    pending.offer("b", [chip(2)]);
    pending.offer("a", [chip(3)]);
    expect(pending.take("a")).toEqual([chip(3)]);
    pending.clear("b");
    expect(pending.take("b")).toBeUndefined();
    pending.offer("c", [chip(1)]);
    pending.offer("c", "not a list");
    expect(pending.take("c")).toBeUndefined();
  });
});
