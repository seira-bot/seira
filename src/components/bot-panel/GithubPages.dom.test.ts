// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bot } from "@/state/store";
import type { GithubAppStatus, GithubBotPolicy } from "../../../shared/github-app";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), api: vi.fn(), open: vi.fn(async (_url: string) => true) }));

vi.mock("@/state/store", () => ({ useStore: () => ({ state: {}, dispatch: fixture.dispatch }), api: fixture.api }));
vi.mock("@/lib/connector-oauth", () => ({ reserveConnectionPage: () => ({ open: fixture.open, cancel: () => {} }) }));

import { resetGithubApp } from "@/lib/github-app";
import { GithubBotFlow, GithubRepositoriesBlock, GithubRepositoriesRow } from "./GithubPages";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const bot = { id: "scout", name: "Scout", color: "blue", modelSelection: { instanceId: "claude", model: "m" } } as unknown as Bot;
const repos = [
  { id: 7, name: "api", fullName: "acme/api", private: true, defaultBranch: "main" },
  { id: 8, name: "web", fullName: "acme/web", private: false, defaultBranch: "main" },
];
const policy: GithubBotPolicy = { repos: [{ installationId: 1, repositoryId: 7, fullName: "acme/api", level: "read" }], askBeforeBigChanges: true, ownBranchesOnly: true };
const status = (extra: Partial<GithubAppStatus> = {}): GithubAppStatus => ({
  enabled: true, connected: true, canEdit: true, ownedByYou: true, ownerLabel: "Rama",
  accounts: [{ installationId: 1, login: "acme", type: "Organization", repositorySelection: "selected", suspended: false, repositories: repos }],
  pending: [], bots: { scout: policy }, ...extra,
});

let host: HTMLDivElement;
let root: Root;
const flush = () => act(async () => { await Promise.resolve(); });
const render = async (node: ReturnType<typeof createElement>) => { await act(async () => root.render(node)); await flush(); };
const click = async (el: Element | null | undefined) => { await act(async () => { (el as HTMLElement).click(); }); await flush(); };
const byText = (selector: string, text: string) => Array.from(host.querySelectorAll<HTMLElement>(selector)).find((el) => el.textContent?.includes(text));
const puts = () => fixture.api.mock.calls.filter(([, init]) => init?.method === "PUT").map(([path, init]) => [path, JSON.parse(init.body)]);

beforeEach(() => {
  resetGithubApp();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  fixture.dispatch.mockReset();
  fixture.api.mockReset();
  fixture.api.mockResolvedValue(status());
  fixture.open.mockReset();
  fixture.open.mockResolvedValue(true);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("a bot's GitHub pages", () => {
  const flow = () => render(createElement(GithubBotFlow, { bot, backLabel: "Apps it can use", onExit: () => {} }));

  it("lists the bot's repositories with their level", async () => {
    await flow();
    const row = host.querySelector("[data-panel-row=repo]");
    expect(row?.textContent).toContain("api");
    expect(row?.textContent).toContain("Read");
    expect(host.textContent).toContain("Ask before big changes");
  });

  it("changes the level of a repository", async () => {
    await flow();
    await click(host.querySelector("[data-panel-row=repo]"));
    expect(host.querySelector("[data-github-page=level]")).not.toBeNull();
    await click(host.querySelector("[data-panel-choice=pull_requests]"));
    expect(puts()[0]![0]).toBe("/api/github-app/bots/scout");
    expect((puts()[0]![1] as GithubBotPolicy).repos[0]!.level).toBe("pull_requests");
  });

  describe("when the person cannot find a repository", () => {
    const openAdd = async () => {
      await flow();
      await click(host.querySelector("[data-panel-link=add-repos]"));
    };
    const missing = () => host.querySelector("[data-panel-link=missing-repo]");

    it("shows the error when GitHub cannot be reached", async () => {
      await openAdd();
      fixture.api.mockRejectedValueOnce(new Error("down"));
      await click(missing());
      expect(host.querySelector("[data-github-page=add] [role=alert]")?.textContent).toBe("Something went wrong with GitHub. Try again.");
    });

    it("offers the link when the browser blocked the page", async () => {
      await openAdd();
      fixture.open.mockResolvedValueOnce(false);
      fixture.api.mockResolvedValueOnce({ url: "https://github.com/apps/seira/installations/new", codeEntry: false });
      await click(missing());
      const link = byText("a", "Open GitHub to continue");
      expect(link?.getAttribute("href")).toBe("https://github.com/apps/seira/installations/new");
      expect(host.querySelector("[data-github-page=add] [role=alert]")).toBeNull();
    });
  });

  it("adds a repository at Read and marks the ones already added", async () => {
    await flow();
    await click(host.querySelector("[data-panel-link=add-repos]"));
    expect(host.querySelector("[data-github-repo='acme/api'] input")).toHaveProperty("disabled", true);
    expect(host.querySelector("[data-github-repo='acme/api']")?.textContent).toContain("Added");
    await click(host.querySelector("[data-github-repo='acme/web'] input"));
    await click(byText("button", "Add 1"));
    const sent = puts()[0]![1] as GithubBotPolicy;
    expect(sent.repos.map((grant) => [grant.fullName, grant.level])).toEqual([["acme/api", "read"], ["acme/web", "read"]]);
  });

  it("is read-only for a person who did not connect GitHub", async () => {
    fixture.api.mockResolvedValue(status({ ownedByYou: false, canEdit: false }));
    await flow();
    expect(host.querySelector("[data-panel-link=add-repos]")).toBeNull();
    expect(host.querySelector("[data-github-readonly]")?.textContent).toContain("Rama");
    const switches = Array.from(host.querySelectorAll<HTMLButtonElement>("[role=switch]"));
    expect(switches.length).toBe(2);
    expect(switches.every((item) => item.disabled)).toBe(true);
    await click(host.querySelector("[data-panel-row=repo]"));
    expect(host.querySelector("[data-panel-choice=write]")).toHaveProperty("disabled", true);
    expect(host.querySelector("[data-panel-row=remove-repo]")).toBeNull();
  });

  it("shows a Repositories row under GitHub's switch only for a bot that uses it", async () => {
    const opened = vi.fn();
    await render(createElement(GithubRepositoriesRow, { bot, onOpen: opened }));
    expect(host.querySelector("[data-panel-page=github]")?.textContent).toContain("Repositories");
    await click(host.querySelector("[data-panel-page=github]"));
    expect(opened).toHaveBeenCalled();
    fixture.api.mockResolvedValue(status({ bots: {} }));
    resetGithubApp();
    await render(createElement(GithubRepositoriesRow, { bot: { ...bot, id: "free" }, onOpen: opened }));
    expect(host.querySelector("[data-panel-page=github]")).toBeNull();
  });
});

describe("the Repositories block in Per-app tools", () => {
  it("lists the repositories and the line about the tools", async () => {
    await render(createElement(GithubRepositoriesBlock, { bot }));
    const block = host.querySelector("[data-github-block=summary]");
    expect(block?.textContent).toContain("acme/api");
    expect(block?.textContent).toContain("Read");
    expect(block?.textContent).toContain("The tools below work only in these repositories.");
    expect(block?.textContent).toContain("Change");
  });

  it("offers View instead of Change to a person who did not connect GitHub", async () => {
    fixture.api.mockResolvedValue(status({ ownedByYou: false, canEdit: false }));
    await render(createElement(GithubRepositoriesBlock, { bot }));
    const block = host.querySelector("[data-github-block=summary]");
    expect(block?.textContent).toContain("View");
    expect(block?.textContent).not.toContain("Change");
    expect(block?.querySelector("[data-github-readonly]")).not.toBeNull();
  });

  it("draws nothing for a bot that does not use GitHub", async () => {
    fixture.api.mockResolvedValue(status({ bots: {} }));
    await render(createElement(GithubRepositoriesBlock, { bot }));
    expect(host.querySelector("[data-github-block]")).toBeNull();
  });
});
