// @vitest-environment happy-dom
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FolderAccess } from "@/lib/folder-access";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { FolderAccessEditor } = await import("./FolderAccessEditor");

const reports: FolderAccess = { limited: false, folders: [{ path: "/srv/shared/reports", write: false }] };
let host: HTMLDivElement;
let root: Root;
const save = vi.fn<(next: FolderAccess | null) => Promise<void>>();

type Props = Parameters<typeof FolderAccessEditor>[0];
const render = async (props: Partial<Props> = {}) => {
  await act(async () => {
    root.render(createElement(FolderAccessEditor, { access: null, save, subject: "bot", enforcement: "box", ...props }));
  });
};
const byLabel = (label: string) => host.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
const click = async (element: HTMLElement) => { await act(async () => { element.click(); }); };
const typePath = async (value: string) => {
  const input = byLabel("Folder path") as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

beforeEach(() => {
  save.mockReset();
  save.mockResolvedValue(undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (window as { ogb?: unknown }).ogb;
});

describe("FolderAccessEditor", () => {
  it("says what happens with no folders", async () => {
    await render();
    expect(host.textContent).toContain("No folders yet. The bot uses its working folder.");
    await render({ subject: "department" });
    expect(host.textContent).toContain("No folders yet. Bots here use their working folders.");
  });

  it("switches to only chosen folders and back", async () => {
    await render();
    await click(host.querySelector<HTMLElement>('[data-folder-mode="chosen"]')!);
    expect(save).toHaveBeenLastCalledWith({ limited: true, folders: [] });
    await render({ access: { limited: true, folders: [] } });
    await click(host.querySelector<HTMLElement>('[data-folder-mode="all"]')!);
    expect(save).toHaveBeenLastCalledWith(null);
  });

  it("adds a typed folder as read-only", async () => {
    await render();
    await typePath("  /srv/shared/reports ");
    await click(host.querySelector<HTMLElement>('form button[type="submit"]')!);
    expect(save).toHaveBeenCalledWith({ limited: false, folders: [{ path: "/srv/shared/reports", write: false }] });
  });

  it("adds the folder a desktop picker returns", async () => {
    (window as { ogb?: unknown }).ogb = { pickFolder: vi.fn().mockResolvedValue("/srv/shared/media") };
    await render();
    expect(byLabel("Folder path")).toBeNull();
    const add = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Add folder…"))!;
    await click(add);
    expect(save).toHaveBeenCalledWith({ limited: false, folders: [{ path: "/srv/shared/media", write: false }] });
  });

  it("turns Can change on and removes a folder", async () => {
    await render({ access: reports });
    const toggle = byLabel("Can change /srv/shared/reports");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await click(toggle);
    expect(save).toHaveBeenLastCalledWith({ limited: false, folders: [{ path: "/srv/shared/reports", write: true }] });
    await click(byLabel("Remove /srv/shared/reports"));
    expect(save).toHaveBeenLastCalledWith(null);
  });

  it("shortens a long path in the middle and keeps the full path in the title", async () => {
    const long = `/srv/shared/${"a".repeat(30)}/${"b".repeat(30)}/reports`;
    await render({ access: { limited: false, folders: [{ path: long, write: false }] } });
    const shown = host.querySelector<HTMLElement>(`[title="${long}"]`)!;
    expect(shown.textContent).toContain("…");
    expect(shown.textContent!.startsWith("/srv/shared/")).toBe(true);
    expect(shown.textContent!.endsWith("/reports")).toBe(true);
    expect(shown.className).toContain("truncate");
    expect(host.querySelector("[data-folder-name]")!.textContent).toBe("reports");
  });

  it("marks folders from the department and does not let the bot change them", async () => {
    const department = { name: "Finance", access: { limited: false, folders: [{ path: "/srv/shared/ledger", write: true }, { path: "/srv/shared/reports", write: false }] } };
    await render({ access: { limited: false, folders: [{ path: "/srv/shared/reports", write: true }] }, department });
    expect(host.textContent).toContain("From Finance");
    expect(byLabel("Can change /srv/shared/ledger").hasAttribute("disabled")).toBe(true);
    expect(byLabel("Remove /srv/shared/ledger")).toBeNull();
    expect(host.querySelectorAll('[aria-label="Can change /srv/shared/reports"]')).toHaveLength(1);
    expect(byLabel("Can change /srv/shared/reports").hasAttribute("disabled")).toBe(false);
    expect(host.textContent).toContain("A folder listed here replaces the same folder from Finance.");
  });

  it("shows only chosen folders as on and locked when the department sets it", async () => {
    await render({ access: null, department: { name: "Finance", access: { limited: true, folders: [] } } });
    const chosen = host.querySelector<HTMLElement>('[data-folder-mode="chosen"]')!;
    expect(chosen.getAttribute("aria-pressed")).toBe("true");
    expect(chosen.hasAttribute("disabled")).toBe(true);
    expect(host.querySelector<HTMLElement>('[data-folder-mode="all"]')!.hasAttribute("disabled")).toBe(true);
    expect(host.textContent).toContain("Set by Finance");
  });

  it("shows the sentence from the server when a folder is refused", async () => {
    save.mockRejectedValue(new Error("That folder isn't on this computer."));
    await render();
    await typePath("/nowhere");
    await click(host.querySelector<HTMLElement>('form button[type="submit"]')!);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("That folder isn't on this computer.");
  });

  it("warns that a command can still open other files only when commands are not confined", async () => {
    const note = "To check each command first, set approval to Ask for approval.";
    await render({ access: { limited: true, folders: [] }, enforcement: "ai" });
    expect(host.textContent).toContain(note);
    await render({ access: reports, enforcement: "ai" });
    expect(host.textContent).toContain(note);
    await render({ access: { limited: false, folders: [{ path: "/srv/shared/reports", write: true }] }, enforcement: "ai" });
    expect(host.textContent).not.toContain(note);
    await render({ access: { limited: true, folders: [] }, enforcement: "box" });
    expect(host.textContent).not.toContain(note);
  });
});
