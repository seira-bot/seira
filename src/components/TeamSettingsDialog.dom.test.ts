// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, InstanceInfo } from "@/state/store";

const fixture = vi.hoisted(() => ({
  dispatch: vi.fn(),
  state: null as unknown,
  calls: [] as Array<[string, RequestInit | undefined]>,
  refuse: new Set<string>(),
}));
const api = vi.hoisted(() => async (path: string, init?: RequestInit) => {
  fixture.calls.push([path, init]);
  const id = path.split("/").pop() ?? "";
  if (path.startsWith("/api/bots/") && fixture.refuse.has(id)) throw new Error("Custom approval cannot move to another provider");
  return path.startsWith("/api/bots/") ? { bot: { id } } : { saved: true };
});
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, api, useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }) };
});
vi.mock("@/state/team-people", () => ({ useTeamPeople: () => null }));
vi.mock("./bot-access/ShareBotButton", () => ({ useTeamName: () => null }));

const { initialState } = await import("@/state/store");
const { TeamSettingsDialog } = await import("./TeamSettingsDialog");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const engine = (instanceId: string, models: string[]) => ({
  instanceId, driverKind: instanceId, displayName: instanceId.toUpperCase(), snapshot: { state: "available" },
  models: { default: models[0]!, options: models.map((id) => ({ id, label: id })) },
}) as unknown as InstanceInfo;
const bot = (id: string, instanceId: string, extra: Partial<Bot> = {}) =>
  ({ id, name: id, threadId: `${id}-t`, modelSelection: { instanceId, model: instanceId === "claude" ? "opus" : "gpt-5" }, ...extra }) as unknown as Bot;

let root: Root;
let host: HTMLElement;
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
const field = (label: string) => document.body.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
const choose = (label: string, value: string) => {
  const select = field(label);

  act(() => { select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); });
};
const dialog = () => document.body.querySelector<HTMLElement>("[data-testid=team-settings-dialog]")!;
const bodyText = () => dialog().textContent ?? "";

beforeEach(() => {
  fixture.calls.length = 0;
  fixture.refuse.clear();
  fixture.dispatch.mockReset();
  fixture.state = {
    ...initialState,
    instances: [engine("claude", ["opus", "sonnet"]), engine("codex", ["gpt-5", "gpt-5-mini"])],
    bots: [bot("a", "claude"), bot("b", "claude"), bot("c", "codex"), bot("h", "claude", { hidden: true })],
  } as AppState;
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root.render(createElement(TeamSettingsDialog, { scope: { all: true }, onClose: () => {} })));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("changing the model of every bot", () => {
  it("shows only the model step, with every provider to move from and models of the chosen target", () => {
    expect(document.body.querySelector("[role=tablist]")).toBeNull();
    expect([...field("From").options].map((option) => option.textContent)).toEqual(["All providers", "CLAUDE", "CODEX"]);
    choose("To", "codex");
    expect([...field("Model").options].map((option) => option.value)).toEqual(["", "gpt-5", "gpt-5-mini"]);
  });

  it("applies to every visible bot one at a time, lists a refusal as skipped and carries on", async () => {
    fixture.refuse.add("b");
    choose("To", "codex");
    choose("Model", "gpt-5");
    expect(bodyText()).toContain("Apply to 2 bots");
    act(() => { [...dialog().querySelectorAll("button")].find((button) => button.textContent === "Apply to 2 bots")!.click(); });
    await settle();
    const patches = fixture.calls.filter(([path]) => path.startsWith("/api/bots/"));
    expect(patches.map(([path]) => path)).toEqual(["/api/bots/a", "/api/bots/b"]);
    expect(JSON.parse(String(patches[0]![1]!.body))).toEqual({ modelSelection: { instanceId: "codex", model: "gpt-5" }, keepThreadModels: true });
    expect(bodyText()).toContain("1 applied · 1 already set · 1 skipped");
    expect(bodyText()).toContain("Skipped: Custom approval cannot move to another provider");
    expect(fixture.calls.some(([path]) => path === "/api/config")).toBe(false);
  });

  it("changes only the bots on the provider chosen in From", () => {
    choose("From", "codex");
    choose("To", "claude");
    choose("Model", "sonnet");
    expect(bodyText()).toContain("Apply to 1 bot");
  });

  it("saves the model new bots start on only when asked to", async () => {
    choose("To", "codex");
    choose("Model", "gpt-5-mini");
    act(() => { document.body.querySelector<HTMLInputElement>("input[type=checkbox]")!.click(); });
    act(() => { [...dialog().querySelectorAll("button")].find((button) => button.textContent?.startsWith("Apply to"))!.click(); });
    await settle();
    const saved = fixture.calls.filter(([path]) => path === "/api/config");
    expect(saved).toHaveLength(1);
    expect(saved[0]![1]!.method).toBe("PUT");
    expect(JSON.parse(String(saved[0]![1]!.body))).toEqual({ defaultModelSelection: { instanceId: "codex", model: "gpt-5-mini" } });
  });
});
