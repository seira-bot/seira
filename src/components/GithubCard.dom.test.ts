// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bot, InstanceInfo } from "@/state/store";
import type { GithubAppStatus, GithubBotPolicy } from "../../shared/github-app";

const fixture = vi.hoisted(() => ({
  state: { bots: [] as unknown[], instances: [] as unknown[], config: null as unknown },
  dispatch: vi.fn(),
  api: vi.fn(),
}));

vi.mock("@/state/store", () => ({ useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }), api: fixture.api }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("@/lib/connector-oauth", () => ({ reserveConnectionPage: () => ({ open: async () => true, cancel: () => {} }) }));
vi.mock("./Avatar", () => ({ BotAvatar: () => null }));

import { completeGithub, resetGithubApp } from "@/lib/github-app";
import { GithubCard } from "./GithubCard";
import { GithubGrantPrompt } from "./GithubGrantPrompt";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const instance = { instanceId: "claude", capabilities: { composioMcp: true } } as unknown as InstanceInfo;
const bot = (id: string, extra: Partial<Bot> = {}) => ({ id, name: id, color: "blue", modelSelection: { instanceId: "claude", model: "m" }, ...extra }) as unknown as Bot;
const policy: GithubBotPolicy = { repos: [{ installationId: 1, repositoryId: 7, fullName: "acme/api", level: "read" }], askBeforeBigChanges: true, ownBranchesOnly: true };
const status = (extra: Partial<GithubAppStatus> = {}): GithubAppStatus => ({
  enabled: true, connected: true, canEdit: true, ownedByYou: true, ownerLabel: "Rama",
  accounts: [{ installationId: 1, login: "acme", type: "Organization", repositorySelection: "selected", suspended: false, repositories: [{ id: 7, name: "api", fullName: "acme/api", private: true, defaultBranch: "main" }] }],
  pending: [], bots: { scout: policy }, ...extra,
});

let host: HTMLDivElement;
let root: Root;
const flush = () => act(async () => { await Promise.resolve(); });
const render = async (node: ReturnType<typeof createElement>) => { await act(async () => root.render(node)); await flush(); };
const text = () => host.textContent ?? "";
const dialog = () => document.body.querySelector<HTMLElement>("[data-app-grant-prompt]");

beforeEach(() => {
  resetGithubApp();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  fixture.state = { bots: [bot("scout"), bot("free")], instances: [instance], config: null };
  fixture.dispatch.mockReset();
  fixture.api.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

describe("the GitHub tile in Apps", () => {
  it("shows nothing while the server does not offer GitHub", async () => {
    fixture.api.mockResolvedValue(status({ enabled: false }));
    await render(createElement(GithubCard, { onChange: () => {} }));
    expect(host.querySelector("[data-app-tile=github]")).toBeNull();
  });

  it("offers Connect before anyone connected", async () => {
    fixture.api.mockResolvedValue(status({ connected: false, accounts: [], bots: {} }));
    await render(createElement(GithubCard, { onChange: () => {} }));
    expect(host.querySelector("[data-github-state=idle]")).not.toBeNull();
    expect(host.querySelector("button[aria-label='Connect GitHub']")).not.toBeNull();
  });

  it("lets the owner add an account, disconnect and change which bots use it", async () => {
    fixture.api.mockResolvedValue(status());
    const onChange = vi.fn();
    await render(createElement(GithubCard, { onChange }));
    expect(host.querySelector("[data-github-summary]")?.textContent).toBe("acme · 1 repository");
    expect(host.querySelector("[data-app-bots=github_app]")?.textContent).toContain("Change");
    expect(text()).not.toContain("Connected by you");
    const manage = host.querySelector("details[data-github-manage]")!;
    expect(manage.querySelector("summary")?.textContent).toBe("Manage");
    expect(manage.textContent).toContain("Add account");
    expect(manage.querySelector("[data-github-account=acme]")?.textContent).toContain("Disconnect");
    expect(host.querySelectorAll("details")).toHaveLength(1);
    const header = host.querySelector("[data-app-tile=github] > div")!;
    expect(header.textContent).not.toContain("Add account");
  });

  it("joins the logins and adds the repositories of several accounts", async () => {
    const [first] = status().accounts;
    fixture.api.mockResolvedValue(status({ accounts: [first!, { ...first!, installationId: 2, login: "beta", repositories: [...first!.repositories, { ...first!.repositories[0]!, id: 8 }] }] }));
    await render(createElement(GithubCard, { onChange: () => {} }));
    expect(host.querySelector("[data-github-summary]")?.textContent).toBe("acme, beta · 3 repositories");
  });

  it("is read-only for a person who did not connect it", async () => {
    fixture.api.mockResolvedValue(status({ ownedByYou: false, canEdit: false }));
    await render(createElement(GithubCard, { onChange: () => {} }));
    expect(text()).not.toContain("Add account");
    expect(text()).not.toContain("Disconnect");
    expect(host.querySelector("[data-github-readonly]")?.textContent).toContain("Rama");
    expect(host.querySelector("[data-app-bots=github_app]")?.textContent).toContain("View");
  });
});

describe("Which bots can use GitHub?", () => {
  const open = async () => {
    await render(createElement(GithubGrantPrompt, { bots: fixture.state.bots as Bot[], onDismiss: () => {} }));
    return Array.from(dialog()!.querySelectorAll<HTMLButtonElement>("[role=switch]"));
  };

  it("turns a bot on with an empty policy, and off with null", async () => {
    fixture.api.mockResolvedValue(status());
    const [, free] = await open();
    expect(free).toBeTruthy();
    fixture.api.mockResolvedValue(status({ bots: { scout: policy, free: { ...policy, repos: [] } } }));
    await act(async () => { free!.click(); });
    await flush();
    const put = fixture.api.mock.calls.find(([path]) => path === "/api/github-app/bots/free")!;
    expect(put[1].method).toBe("PUT");
    expect(JSON.parse(put[1].body)).toEqual({ repos: [], askBeforeBigChanges: true, ownBranchesOnly: true });

    fixture.api.mockClear();
    fixture.api.mockResolvedValue(status());
    const [scout] = Array.from(dialog()!.querySelectorAll<HTMLButtonElement>("[role=switch]"));
    await act(async () => { scout!.click(); });
    await flush();
    const off = fixture.api.mock.calls.find(([path]) => path === "/api/github-app/bots/scout")!;
    expect(off[1].body).toBe("null");
  });

  it("disables every switch for a person who did not connect GitHub", async () => {
    fixture.api.mockResolvedValue(status({ ownedByYou: false, canEdit: false }));
    const switches = await open();
    expect(switches.length).toBe(2);
    expect(switches.every((item) => item.disabled)).toBe(true);
    expect(dialog()?.textContent).toContain("Only Rama can change which bots use it.");
  });
});

describe("after a connect", () => {
  it("opens the bot dialog once for the person who owns the connection", async () => {
    fixture.api.mockResolvedValue(status({ connected: false, accounts: [], bots: {} }));
    const onChange = vi.fn();
    await render(createElement(GithubCard, { onChange }));
    expect(onChange).not.toHaveBeenCalled();
    fixture.api.mockResolvedValue(status());
    await act(async () => { await completeGithub("abcde-12345"); });
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);
    await render(createElement(GithubCard, { onChange }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("never opens the dialog by itself for a person who does not own the connection", async () => {
    fixture.api.mockResolvedValue(status({ connected: false, accounts: [], bots: {}, ownedByYou: false, canEdit: false }));
    const onChange = vi.fn();
    await render(createElement(GithubCard, { onChange }));
    fixture.api.mockResolvedValue(status({ ownedByYou: false, canEdit: false }));
    await act(async () => { await completeGithub("abcde-12345"); });
    await flush();
    expect(onChange).not.toHaveBeenCalled();
  });
});
