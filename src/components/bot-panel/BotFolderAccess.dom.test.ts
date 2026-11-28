// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fixture = vi.hoisted(() => ({ admin: true as boolean | null, api: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: (...args: unknown[]) => fixture.api(...args),
}));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.admin }));

const { BotFolderAccess } = await import("./BotFolderAccess");
const { SectionFoldersDialog } = await import("../SectionFoldersDialog");

const departments = { Finance: { limited: false, folders: [{ path: "/srv/shared/ledger", write: false }] } };
let host: HTMLDivElement;
let root: Root;
const bot = { id: "scout", section: " Finance ", folderAccess: undefined };
const mount = async (node: ReturnType<typeof createElement>) => { await act(async () => { root.render(node); }); };

beforeEach(() => {
  fixture.admin = true;
  fixture.api.mockReset();
  fixture.api.mockImplementation(async (path: string) => {
    if (path === "/api/department-folders") return { departments, enforcement: "box", setHere: true };
    return {};
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

describe("BotFolderAccess", () => {
  it("shows the department's folders and saves the bot's own list through its settings", async () => {
    await mount(createElement(BotFolderAccess, { bot, variant: "card" }));
    expect(host.textContent).toContain("From Finance");
    const input = host.querySelector<HTMLInputElement>('[aria-label="Folder path"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "/srv/shared/reports");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { host.querySelector<HTMLButtonElement>('form button[type="submit"]')!.click(); });
    expect(fixture.api).toHaveBeenCalledWith("/api/bots/scout", { method: "PATCH", body: JSON.stringify({ folderAccess: { limited: false, folders: [{ path: "/srv/shared/reports", write: false }] } }) });
    expect(host.textContent).toContain("/srv/shared/reports");
  });

  it("is not shown to someone who is not an admin, and loads nothing for them", async () => {
    fixture.admin = false;
    await mount(createElement(BotFolderAccess, { bot, variant: "panel" }));
    expect(host.textContent).toBe("");
    expect(fixture.api).not.toHaveBeenCalled();
  });

  it("tells an admin who limited a bot to chosen folders that bubblewrap is missing", async () => {
    fixture.api.mockResolvedValue({ departments: {}, enforcement: "ai", boxMissing: "no-bwrap", setHere: true });
    await mount(createElement(BotFolderAccess, { bot: { ...bot, folderAccess: { limited: true, folders: [] } }, variant: "card" }));
    expect(host.textContent).toContain("bubblewrap is not installed");
    expect(host.querySelector("code")?.textContent).toBe("sudo apt install bubblewrap");
  });

  it("hides the editor where this server cannot set folders", async () => {
    fixture.api.mockResolvedValue({ departments: {}, enforcement: "ai", setHere: false });
    await mount(createElement(BotFolderAccess, { bot, variant: "panel" }));
    expect(host.querySelector("[data-folder-access]")).toBeNull();
    expect(host.textContent).toContain("Folders are set on the computer where Seira runs.");
  });
});

describe("SectionFoldersDialog", () => {
  it("saves a department's folders with PUT", async () => {
    await mount(createElement(SectionFoldersDialog, { section: "Finance", label: "Finance", onClose: vi.fn() }));
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Folders for Finance");
    expect(dialog.textContent).not.toContain("From ");
    await act(async () => { dialog.querySelector<HTMLElement>('[data-folder-mode="chosen"]')!.click(); });
    expect(fixture.api).toHaveBeenCalledWith("/api/department-folders?section=Finance", {
      method: "PUT",
      body: JSON.stringify({ limited: true, folders: [{ path: "/srv/shared/ledger", write: false }] }),
    });
  });
});
