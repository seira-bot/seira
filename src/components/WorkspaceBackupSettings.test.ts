import { Children, createElement, isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceBackupSummary } from "../../shared/workspace-backup";

const fixture = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[], api: vi.fn() }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = typeof initial === "function" ? initial() : initial;
    return [fixture.values[index], (next: unknown) => { fixture.values[index] = typeof next === "function" ? next(fixture.values[index]) : next; }];
  },
  useEffect: (effect: EffectCallback) => { fixture.effects.push(effect); },
}));
vi.mock("@/state/store", () => ({ api: fixture.api }));
import { WorkspaceBackupRecovery, WorkspaceBackupRestartNotice, WorkspaceBackupSettings, WorkspaceBackupSummaryView } from "./WorkspaceBackupSettings";

type Node = ReactElement<{ children?: ReactNode; type?: string; disabled?: boolean; value?: string; onChange?: (event: unknown) => void; onSubmit?: (event: unknown) => void; onClick?: () => void }>;
function nodes(value: ReactNode): Node[] {
  if (!isValidElement(value)) return [];
  const node = value as Node;
  // A row's description and message lines hold controls too (Learn more).
  const extra = node.props as { subtitle?: ReactNode; message?: ReactNode };
  return [node, ...Children.toArray(node.props.children).flatMap(nodes), ...Children.toArray(extra.subtitle).flatMap(nodes), ...Children.toArray(extra.message).flatMap(nodes)];
}
function render(recovery: boolean | "restart" | "cloud" = false) {
  fixture.index = 0; fixture.effects = [];
  let tree: ReactNode;
  function Capture() { tree = recovery === "restart" ? WorkspaceBackupRestartNotice() : recovery === "cloud" ? WorkspaceBackupRestartNotice({ serverRestarts: true }) : recovery ? WorkspaceBackupRecovery({ children: createElement("p", null, "Normal app") }) : WorkspaceBackupSettings(); return tree; }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, nodes: nodes(tree) };
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const submit = (form: Node) => form.props.onSubmit!({ preventDefault: vi.fn() });
const change = (input: Node, value: string) => input.props.onChange!({ target: { value } });
const summary: WorkspaceBackupSummary = { format: "seira.workspace-backup", version: 1, id: "archive-id", createdAt: "2026-09-11T00:00:00Z", appVersion: "0.1.71", files: 9, directories: 3, bytes: 1234, bots: 2, groups: 1, threads: 4, messages: 8, warnings: ["Fixture warning"], exclusions: ["Saved account credentials and connections", "External CLI sign-ins"] };
let storage: Map<string, string>;
beforeEach(() => {
  fixture.values = []; fixture.index = 0; fixture.effects = []; fixture.api.mockReset();
  storage = new Map();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  vi.stubGlobal("window", { location: { reload: vi.fn() } });
});
afterEach(() => vi.unstubAllGlobals());
async function ready() { fixture.api.mockResolvedValueOnce({ busy: false }); render(); fixture.effects[0](); await flush(); }
/** Each backup action is a row whose button opens its own small dialog. */
const open = (which: "export" | "import") => { render().nodes.find((node) => (node.props as Record<string, unknown>)[`data-backup-${which}`] === "")!.props.onClick!(); };
const formOf = (id: string) => render().nodes.find((node) => node.type === "form" && (node.props as { id?: string }).id === id)!;

describe("Settings full backups", () => {
  it("shows two rows, each opening a dialog with its file input or password fields, the details behind Learn more, and a validated summary with warnings", async () => {
    await ready();
    let html = render().html;
    expect(html).toContain("Password-protected. Saved logins are not included.");
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain('type="file"');
    render().nodes.find((node) => (node.type as { name?: string }).name === "LearnMore")!.props.onClick!();
    open("export"); open("import");
    html = render().html;
    expect(html).toContain('type="file" accept=".seirabackup,.ombbackup"');
    expect(html.match(/type="password"/g)).toHaveLength(3);
    expect(html).toContain("the disks of remote desktops");
    expect(html).toContain("Saved account credentials and connections are not included");
    expect(html).toContain("existing credentials on the destination stay unchanged");
    expect(html).toContain("not automatically redacted");
    expect(html).not.toContain("Replace installation");
    const preview = renderToStaticMarkup(createElement(WorkspaceBackupSummaryView, { summary }));
    for (const text of ["Validated backup", "0.1.71", "Bots", "Threads", "Messages", "Fixture warning", "External CLI sign-ins"]) expect(preview).toContain(text);
  });

  it("exports encrypted state by POST and downloads without putting the password in a URL or storage", async () => {
    await ready();
    storage.set("seira-drafts", "private draft"); storage.set("auth-token", "not exported"); storage.set("seira-webhook-credentials", "not exported either");
    open("export");
    let view = render();
    const passwords = view.nodes.filter((node) => node.type === "input" && node.props.type === "password");
    change(passwords[0], "correct horse battery"); change(passwords[1], "correct horse battery");
    view = render();
    const link = { href: "", download: "", click: vi.fn(), remove: vi.fn() };
    vi.stubGlobal("document", { createElement: () => link, body: { append: vi.fn() } });
    fixture.api.mockResolvedValueOnce({ id: "download-id", filename: "fixture.seirabackup" });
    const form = formOf("backup-export");
    submit(form); submit(form); await flush();
    expect(fixture.api).toHaveBeenCalledTimes(3); // one status, one size report, one export
    const [path, init] = fixture.api.mock.calls[2];
    expect(path).toBe("/api/workspace-backup/export");
    expect(JSON.parse(init.body)).toEqual({ password: "correct horse battery", clientState: { "seira-drafts": "private draft" } });
    expect(link.href).toBe("/api/workspace-backup/download/download-id");
    expect(link.click).toHaveBeenCalledOnce();
    expect([...storage.values()]).not.toContain("correct horse battery");
    expect(render().html).not.toContain('value="correct horse battery"');
    expect(render().html).not.toContain('id="backup-export"');
  });

  describe("size of each part and the leave-out switch", () => {
    // The shape of GET /api/workspace-backup/sizes (seira#513).
    const sizesReply = { parts: { chats: 1200, memory: 3000, attachments: 5_000_000, "work-folders": 2_000_000_000, other: 500 }, total: 2_005_004_700, canLeaveOut: ["work-folders"] };
    const leaveOutSwitch = () => render().nodes.find((node) => (node.props as Record<string, unknown>)["data-backup-leave-out"] === "work-folders")!;
    async function openWithSizes(reply: unknown) {
      await ready();
      if (reply instanceof Error) fixture.api.mockRejectedValueOnce(reply); else fixture.api.mockResolvedValueOnce(reply);
      open("export"); await flush();
    }
    async function exportNow() {
      const passwords = render().nodes.filter((node) => node.type === "input" && node.props.type === "password");
      change(passwords[0], "correct horse battery"); change(passwords[1], "correct horse battery");
      vi.stubGlobal("document", { createElement: () => ({ click: vi.fn(), remove: vi.fn() }), body: { append: vi.fn() } });
      fixture.api.mockResolvedValueOnce({ id: "download-id", filename: "fixture.seirabackup" });
      submit(formOf("backup-export")); await flush();
      return JSON.parse(fixture.api.mock.calls.at(-1)![1].body) as Record<string, unknown>;
    }

    it("reads the size report when the export form opens and shows each part, the total and that sizes are an upper bound", async () => {
      await openWithSizes(sizesReply);
      expect(fixture.api.mock.calls[1][0]).toBe("/api/workspace-backup/sizes");
      const html = render().html;
      for (const text of ["Conversations and settings", "Bot memory", "Attachments", "Conversation work folders", "Other files", "1.2 KB", "2.9 KB", "4.8 MB", "1.9 GB", "500 B", "Sizes are an upper bound", "more than twice the total"]) expect(html).toContain(text);
      expect(html).toMatch(/data-backup-total=""[^>]*>1\.9 GB</);
      expect(html).not.toContain("Left-out files are not in the backup.");
    });

    it("lowers the shown total and warns when work folders are switched off, and sends only that part name", async () => {
      await openWithSizes(sizesReply);
      leaveOutSwitch().props.onClick!();
      const html = render().html;
      expect(html).toMatch(/data-backup-total=""[^>]*>4\.8 MB</);
      expect(html).toContain("Left-out files are not in the backup.");
      expect(html).toContain('aria-checked="true"');
      expect(await exportNow()).toEqual({ password: "correct horse battery", clientState: {}, leaveOut: ["work-folders"] });
    });

    it("switches the part on again, and a default export has no left-out part", async () => {
      await openWithSizes(sizesReply);
      expect(leaveOutSwitch().props).toMatchObject({ checked: false });
      leaveOutSwitch().props.onClick!(); leaveOutSwitch().props.onClick!();
      expect(render().html).toMatch(/data-backup-total=""[^>]*>1\.9 GB</);
      expect(render().html).not.toContain("Left-out files are not in the backup.");
      const body = await exportNow();
      expect(body).toEqual({ password: "correct horse battery", clientState: {} });
      expect(body).not.toHaveProperty("leaveOut");
    });

    it("starts with the switch off each time the form opens", async () => {
      await openWithSizes(sizesReply);
      leaveOutSwitch().props.onClick!();
      render().nodes.find((node) => node.type === "button" && node.props.children === "Cancel")?.props.onClick?.();
      fixture.api.mockResolvedValueOnce(sizesReply);
      open("export"); await flush();
      expect(render().html).not.toContain("Left-out files are not in the backup.");
      expect(render().html).toMatch(/data-backup-total=""[^>]*>1\.9 GB</);
    });

    it("works as today, with no sizes and no switch, on an older server that has no size report", async () => {
      await openWithSizes(Object.assign(new Error("Not found"), { status: 404 }));
      const html = render().html;
      expect(html).not.toContain("data-backup-sizes");
      expect(html).not.toContain("Sizes are an upper bound");
      expect(html).toContain('id="backup-export"');
      expect(await exportNow()).toEqual({ password: "correct horse battery", clientState: {} });
    });

    it("shows no sizes when the reply has a shape this app does not know", async () => {
      await openWithSizes({ parts: { chats: "big" }, total: 1, canLeaveOut: ["work-folders"] });
      expect(render().html).not.toContain("data-backup-sizes");
    });

    it("never sends a part that the server did not list as one it can leave out", async () => {
      await openWithSizes({ ...sizesReply, canLeaveOut: [] });
      expect(render().nodes.some((node) => (node.props as Record<string, unknown>)["data-backup-leave-out"] !== undefined)).toBe(false);
      expect(await exportNow()).not.toHaveProperty("leaveOut");
    });

    it("shows a line and no numbers, no switch and a normal export when the server answers 403 (Team Cloud)", async () => {
      await openWithSizes(Object.assign(new Error("Backup sizes are not available on a Team Cloud"), { status: 403 }));
      const html = render().html;
      expect(html).toContain("data-backup-sizes-unavailable");
      expect(html).toContain("Sizes are not shown here");
      expect(html).not.toContain("data-backup-sizes=");
      expect(html).not.toContain("data-backup-total");
      expect(html).not.toMatch(/\d+(\.\d)? (B|KB|MB|GB)/);
      expect(render().nodes.some((node) => (node.props as Record<string, unknown>)["data-backup-leave-out"] !== undefined)).toBe(false);
      expect(await exportNow()).toEqual({ password: "correct horse battery", clientState: {} });
    });

    it("drops the late size reply of an earlier opening of the form and keeps the choice the person made", async () => {
      await ready();
      let lateReply!: (value: unknown) => void;
      fixture.api.mockReturnValueOnce(new Promise((resolve) => { lateReply = resolve; }));
      open("export");
      render().nodes.find((node) => node.type === "button" && node.props.children === "Cancel")?.props.onClick?.();
      fixture.api.mockResolvedValueOnce(sizesReply);
      open("export"); await flush();
      leaveOutSwitch().props.onClick!();
      lateReply({ parts: { chats: 1, memory: 1, attachments: 1, "work-folders": 1, other: 1 }, total: 5, canLeaveOut: [] }); await flush();
      const html = render().html;
      expect(html).toMatch(/data-backup-total=""[^>]*>4\.8 MB</);
      expect(leaveOutSwitch().props).toMatchObject({ checked: true });
      expect(await exportNow()).toEqual({ password: "correct horse battery", clientState: {}, leaveOut: ["work-folders"] });
    });

    it("drops a size reply that arrives after the form was closed", async () => {
      await ready();
      let lateReply!: (value: unknown) => void;
      fixture.api.mockReturnValueOnce(new Promise((resolve) => { lateReply = resolve; }));
      open("export");
      render().nodes.find((node) => node.type === "button" && node.props.children === "Cancel")?.props.onClick?.();
      lateReply(sizesReply); await flush();
      expect(render().html).not.toContain("data-backup-sizes");
    });

    it("stops with a message, and sends nothing, when the chosen part can no longer be left out", async () => {
      await openWithSizes(sizesReply);
      leaveOutSwitch().props.onClick!();
      const slot = fixture.values.findIndex((value) => !!value && typeof value === "object" && "request" in (value as object));
      const state = fixture.values[slot] as { sizes: { canLeaveOut: string[] } };
      fixture.values[slot] = { ...state, sizes: { ...state.sizes, canLeaveOut: [] } };
      const passwords = render().nodes.filter((node) => node.type === "input" && node.props.type === "password");
      change(passwords[0], "correct horse battery"); change(passwords[1], "correct horse battery");
      const calls = fixture.api.mock.calls.length;
      submit(formOf("backup-export")); await flush();
      expect(fixture.api.mock.calls.length).toBe(calls);
      const html = render().html;
      expect(html).toMatch(/role="alert"[^>]*>The server can no longer leave out the part you chose, so no backup was made/);
      expect(html).toContain('id="backup-export"');
    });

    it("lists the parts that a backup left out in the restore preview, and nothing when it left none out", () => {
      const left = renderToStaticMarkup(createElement(WorkspaceBackupSummaryView, { summary: { ...summary, leftOut: ["work-folders"] } }));
      expect(left).toContain("Left out on purpose");
      expect(left).toContain("Conversation work folders");
      expect(renderToStaticMarkup(createElement(WorkspaceBackupSummaryView, { summary }))).not.toContain("Left out on purpose");
      expect(renderToStaticMarkup(createElement(WorkspaceBackupSummaryView, { summary: { ...summary, leftOut: [] } }))).not.toContain("Left out on purpose");
    });
  });

  it("keeps the export dialog open with its reason when the export fails, so it can be tried again", async () => {
    await ready();
    open("export");
    const passwords = render().nodes.filter((node) => node.type === "input" && node.props.type === "password");
    change(passwords[0], "correct horse battery"); change(passwords[1], "correct horse battery");
    fixture.api.mockRejectedValueOnce(new Error("Disk full"));
    submit(formOf("backup-export")); await flush();
    const html = render().html;
    expect(html).toContain('id="backup-export"');
    expect(html).toMatch(/role="alert"[^>]*>Disk full</);
  });

  it("uploads a raw file, validates it, and requires exact REPLACE with the staged ID", async () => {
    await ready();
    const file = new File(["encrypted fixture"], "fixture.seirabackup");
    open("import");
    render().nodes.find((node) => node.props.type === "file")!.props.onChange!({ target: { files: [file] } });
    let view = render();
    change(view.nodes.filter((node) => node.props.type === "password")[0], "correct horse battery");
    fixture.api.mockResolvedValueOnce({ id: "upload-id", chunkBytes: 1024 }).mockResolvedValueOnce({ received: file.size }).mockResolvedValueOnce({ id: "upload-id" }).mockResolvedValueOnce({ id: "stage-id", summary });
    submit(formOf("backup-import")); await flush();
    expect(fixture.api.mock.calls.slice(1, 4).map(([path]) => path)).toEqual(["/api/workspace-backup/upload/start", "/api/workspace-backup/upload/upload-id/chunk?offset=0&bytes=17", "/api/workspace-backup/upload/upload-id/finish"]);
    expect(fixture.api.mock.calls[2][1]).toMatchObject({ method: "POST", headers: { "content-type": "application/octet-stream" } });
    expect(JSON.parse(fixture.api.mock.calls[4][1].body)).toEqual({ id: "upload-id", password: "correct horse battery" });
    view = render();
    const replace = () => render().nodes.find((node) => node.type === "button" && node.props.children === "Replace installation")!;
    expect(replace().props.disabled).toBe(true);
    const confirm = view.nodes.filter((node) => node.type === "input" && !node.props.type)[0];
    change(confirm, "replace"); expect(replace().props.disabled).toBe(true);
    change(confirm, "REPLACE"); expect(replace().props.disabled).toBe(false);
    fixture.api.mockResolvedValueOnce({ restartRequired: true, restoreId: "stage-id" });
    replace().props.onClick!(); await flush();
    expect(JSON.parse(fixture.api.mock.calls[5][1].body)).toEqual({ id: "stage-id", confirmation: "REPLACE" });
    expect(storage.get("seira-pending-workspace-restore")).toBe("stage-id");
    expect(render().html).toContain("Fully quit Seira");
  });

  it("does not offer a replacement after failed password validation", async () => {
    await ready();
    open("import");
    render().nodes.find((node) => node.props.type === "file")!.props.onChange!({ target: { files: [new File(["archive"], "file.seirabackup")] } });
    change(render().nodes.filter((node) => node.props.type === "password")[0], "wrong password");
    fixture.api.mockResolvedValueOnce({ id: "upload" }).mockResolvedValueOnce({ received: 7 }).mockResolvedValueOnce({ id: "upload" }).mockRejectedValueOnce(new Error("Wrong password"));
    submit(formOf("backup-import")); await flush();
    const html = render().html;
    expect(html).toContain('role="alert"'); expect(html).toContain("Wrong password"); expect(html).not.toContain("Replace installation");
  });

  it("shows an error with a Retry button when the upload fails, and the retry resumes the same upload", async () => {
    await ready();
    const file = new File(["archive"], "file.seirabackup");
    open("import");
    render().nodes.find((node) => node.props.type === "file")!.props.onChange!({ target: { files: [file] } });
    change(render().nodes.filter((node) => node.props.type === "password")[0], "correct horse battery");
    const refusal = Object.assign(new Error("The backup is too large."), { status: 413 });
    fixture.api.mockResolvedValueOnce({ id: "upload-id" }).mockRejectedValueOnce(refusal);
    submit(formOf("backup-import")); await flush();
    let html = render().html;
    expect(html).toMatch(/role="alert"[^>]*>The backup is too large\./);
    expect(html).not.toContain("Validating backup");
    const retry = render().nodes.find((node) => node.type === "button" && node.props.type === "submit")!;
    expect(retry.props.children).toContain("Retry");
    fixture.api.mockResolvedValueOnce({ received: 0 }).mockResolvedValueOnce({ received: 7 }).mockResolvedValueOnce({ id: "upload-id" }).mockResolvedValueOnce({ id: "stage-id", summary });
    submit(formOf("backup-import")); await flush();
    expect(fixture.api.mock.calls.filter(([path]) => path.endsWith("/upload/start"))).toHaveLength(1);
    expect(fixture.api.mock.calls.map(([path]) => path)).toContain("/api/workspace-backup/upload/upload-id");
    expect(render().html).toContain("Validated backup");
  });

  it("shows the percent sent while the file uploads, before validation", async () => {
    await ready();
    const file = new File(["archive"], "file.seirabackup");
    open("import");
    render().nodes.find((node) => node.props.type === "file")!.props.onChange!({ target: { files: [file] } });
    change(render().nodes.filter((node) => node.props.type === "password")[0], "correct horse battery");
    let release!: (value: unknown) => void;
    fixture.api.mockResolvedValueOnce({ id: "upload-id" }).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    submit(formOf("backup-import")); await flush();
    expect(render().html).toContain("Uploading backup… 0%");
    expect(render().html).not.toContain("Validating backup");
    release({ received: 7 });
    fixture.api.mockResolvedValueOnce({ id: "upload-id" }).mockResolvedValueOnce({ id: "stage-id", summary });
    await flush();
    expect(render().html).toContain("Validated backup");
  });

  it("reuploads the selected file if its upload or validated stage expires", async () => {
    await ready();
    const file = new File(["archive"], "file.seirabackup");
    open("import");
    render().nodes.find((node) => node.props.type === "file")!.props.onChange!({ target: { files: [file] } });
    const validate = async () => { change(render().nodes.filter((node) => node.props.type === "password")[0], "correct horse battery"); submit(formOf("backup-import")); await flush(); };
    const expired = Object.assign(new Error("Backup expired; upload again"), { status: 404 });
    fixture.api.mockResolvedValueOnce({ id: "upload-old" }).mockResolvedValueOnce({ received: 7 }).mockResolvedValueOnce({ id: "upload-old" }).mockRejectedValueOnce(expired);
    await validate();
    fixture.api.mockResolvedValueOnce({ id: "upload-new" }).mockResolvedValueOnce({ received: 7 }).mockResolvedValueOnce({ id: "upload-new" }).mockResolvedValueOnce({ id: "stage-old", summary });
    await validate();
    change(render().nodes.find((node) => node.type === "input" && !node.props.type)!, "REPLACE");
    fixture.api.mockRejectedValueOnce(expired);
    render().nodes.find((node) => node.type === "button" && node.props.children === "Replace installation")!.props.onClick!(); await flush();
    expect(render().html).not.toContain("Validated backup");
    fixture.api.mockResolvedValueOnce({ id: "upload-final" }).mockResolvedValueOnce({ received: 7 }).mockResolvedValueOnce({ id: "upload-final" }).mockResolvedValueOnce({ id: "stage-final", summary });
    await validate();
    expect(fixture.api.mock.calls.filter(([path]) => path.endsWith("/upload/start"))).toHaveLength(3);
    expect(render().html).toContain("Validated backup");
  });

  it("does not restore client state before restart, then replaces only the initiating browser's allowlist", async () => {
    storage.set("seira-pending-workspace-restore", "stage-id"); storage.set("seira-drafts", "old"); storage.set("auth-token", "keep");
    fixture.api.mockResolvedValueOnce({ busy: true, pendingRestore: true });
    expect(render(true).html).not.toContain("Continue without restoring drafts");
    fixture.effects[0](); await flush();
    expect(render(true).html).toContain("Fully quit Seira");
    expect(render(true).html).not.toContain("Continue without restoring drafts");
    expect(fixture.api).toHaveBeenCalledOnce(); expect(storage.get("seira-drafts")).toBe("old");
    fixture.values = [];
    fixture.api.mockResolvedValueOnce({ busy: false, lastRestoreId: "stage-id" }).mockResolvedValueOnce({ clientState: { "seira-drafts": "restored" } });
    render(true); fixture.effects[0](); await flush();
    expect(storage.get("seira-drafts")).toBe("restored"); expect(storage.get("auth-token")).toBe("keep");
    expect(storage.has("seira-pending-workspace-restore")).toBe(false); expect(window.location.reload).toHaveBeenCalledOnce();
  });

  it("on a server that restarts itself, waits instead of asking to quit, then carries on once the restore is installed", async () => {
    storage.set("seira-pending-workspace-restore", "stage-id");
    fixture.api.mockResolvedValueOnce({ busy: true, pendingRestore: true, restarts: true });
    render(true); fixture.effects[0](); await flush();
    expect(render(true).html).toContain("is restarting to finish it");
    expect(render(true).html).not.toContain("Fully quit");
    vi.useFakeTimers();
    try {
      fixture.values = [];
      const view = render("cloud");
      expect(view.html).toContain("is restarting to finish it");
      expect(view.nodes.some(node => node.type === "button")).toBe(false);
      const stop = fixture.effects[0]() as () => void;
      fixture.api.mockResolvedValueOnce({ busy: true, pendingRestore: true });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(window.location.reload).not.toHaveBeenCalled();
      fixture.api.mockResolvedValueOnce({});
      await vi.advanceTimersByTimeAsync(3_000);
      expect(window.location.reload).not.toHaveBeenCalled();
      fixture.api.mockRejectedValueOnce(new DOMException("The operation timed out.", "TimeoutError"));
      await vi.advanceTimersByTimeAsync(3_000);
      expect(window.location.reload).not.toHaveBeenCalled();
      fixture.api.mockResolvedValueOnce({ busy: false, pendingRestore: false, lastRestoreId: "stage-id" });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(window.location.reload).toHaveBeenCalledOnce();
      expect(fixture.api.mock.calls.filter(([path, init]) => path === "/api/workspace-backup/status" && init?.timeoutMs === 10_000)).toHaveLength(4);
      await vi.advanceTimersByTimeAsync(9_000);
      expect(window.location.reload).toHaveBeenCalledOnce();
      stop();
    } finally { vi.useRealTimers(); }
    expect(storage.get("seira-pending-workspace-restore")).toBe("stage-id");
  });

  it("on a server that restarts itself, says so when the restart takes much longer, and keeps waiting", async () => {
    storage.set("seira-pending-workspace-restore", "stage-id");
    vi.useFakeTimers();
    try {
      expect(render("cloud").html).not.toContain("longer than usual");
      const stop = fixture.effects[0]() as () => void;
      fixture.api.mockRejectedValue(new Error("Server unavailable"));
      await vi.advanceTimersByTimeAsync(180_000);
      expect(render("cloud").html).toContain("longer than usual");
      expect(window.location.reload).not.toHaveBeenCalled();
      stop();
    } finally { vi.useRealTimers(); }
    expect(storage.get("seira-pending-workspace-restore")).toBe("stage-id");
  });

  it("on a server that restarts itself, reloads to sign-in when the restored workspace does not know this browser", async () => {
    vi.useFakeTimers();
    try {
      render("cloud");
      const stop = fixture.effects[0]() as () => void;
      fixture.api.mockRejectedValueOnce(Object.assign(new Error("Sign in"), { status: 401 }));
      await vi.advanceTimersByTimeAsync(3_000);
      expect(window.location.reload).toHaveBeenCalledOnce();
      stop();
    } finally { vi.useRealTimers(); }
  });

  it("offers a real desktop restart without clearing the restore marker or drafts, once only", async () => {
    const relaunch = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("window", { ...window, ogb: { relaunch } });
    storage.set("seira-pending-workspace-restore", "stage-id"); storage.set("seira-drafts", "keep");
    fixture.api.mockResolvedValueOnce({ busy: true, pendingRestore: true });
    render(true); fixture.effects[0](); await flush();
    expect(render(true).html).toContain("Restart and restore");
    expect(render(true).html).not.toContain(">Retry<");
    fixture.values = [];
    const restart = render("restart").nodes.find(node => node.type === "button")!;
    restart.props.onClick!(); restart.props.onClick!(); await flush();
    expect(relaunch).toHaveBeenCalledOnce();
    expect(render("restart").nodes.find(node => node.type === "button")!.props.disabled).toBe(true);
    expect(storage.get("seira-pending-workspace-restore")).toBe("stage-id");
    expect(storage.get("seira-drafts")).toBe("keep");
    expect(window.location.reload).not.toHaveBeenCalled();
  });

  it.each([false, new Error("Fixture restart unavailable")])("keeps recovery intact and offers a retry when native restart fails (%s)", async result => {
    const relaunch = result === false ? vi.fn().mockResolvedValue(false) : vi.fn().mockRejectedValue(result);
    vi.stubGlobal("window", { ...window, ogb: { relaunch } });
    storage.set("seira-pending-workspace-restore", "stage-id");
    render("restart").nodes.find(node => node.type === "button")!.props.onClick!(); await flush();
    const view = render("restart");
    expect(view.html).toContain("Could not restart Seira");
    expect(view.nodes.find(node => node.type === "button")!.props.disabled).toBe(false);
    expect(storage.get("seira-pending-workspace-restore")).toBe("stage-id");
    expect(window.location.reload).not.toHaveBeenCalled();
  });

  it.each([undefined, { relaunch: vi.fn(), remoteClient: { active: true } }])("never restarts the local app for a browser or remote workspace", bridge => {
    window.ogb = bridge as Window["ogb"];
    const view = render("restart");
    expect(view.html).toContain("restart the server process");
    expect(view.html).not.toContain("Restart and restore");
    expect(view.nodes.filter(node => node.type === "button")).toHaveLength(0);
  });

  it("retains the server-status retry for browser recovery", async () => {
    storage.set("seira-pending-workspace-restore", "stage-id");
    fixture.api.mockResolvedValueOnce({ busy: true, pendingRestore: true });
    render(true); fixture.effects[0](); await flush();
    expect(render(true).html).toContain(">Retry<");
    expect(render(true).html).not.toContain("Restart and restore");
  });

  it("never imports a different restore's browser state", async () => {
    storage.set("seira-pending-workspace-restore", "my-stage"); storage.set("seira-drafts", "keep");
    fixture.api.mockResolvedValueOnce({ busy: false, lastRestoreId: "another-stage" });
    render(true); fixture.effects[0](); await flush();
    expect(fixture.api).toHaveBeenCalledOnce();
    expect(render(true).html).toContain("Normal app");
    expect(storage.get("seira-drafts")).toBe("keep");
    expect(storage.has("seira-pending-workspace-restore")).toBe(false);
    expect(window.location.reload).not.toHaveBeenCalled();
  });

  it("keeps the normal app gated and its old drafts intact on recovery failure", async () => {
    storage.set("seira-pending-workspace-restore", "stage-id"); storage.set("seira-drafts", "keep");
    fixture.api.mockResolvedValueOnce({ busy: false, lastRestoreId: "stage-id" }).mockRejectedValueOnce(new Error("Fixture unavailable"));
    render(true); fixture.effects[0](); await flush();
    const html = render(true).html;
    expect(html).toContain("Fixture unavailable"); expect(html).toContain("Retry"); expect(html).not.toContain("Normal app");
    expect(storage.get("seira-drafts")).toBe("keep"); expect(storage.get("seira-pending-workspace-restore")).toBe("stage-id");
    expect(window.location.reload).not.toHaveBeenCalled();
  });

  it.each([401, 403])("explicitly returns to normal bootstrap after a %s without changing browser state", async (status) => {
    storage.set("seira-pending-workspace-restore", "stage-id");
    storage.set("seira-drafts", "keep drafts"); storage.set("seira-draft-attachments", "keep attachments");
    storage.set("seira-skin", "keep preferences"); storage.set("auth-token", "keep session");
    const before = new Map(storage);
    if (status === 403) fixture.api.mockResolvedValueOnce({ busy: false, lastRestoreId: "stage-id" });
    fixture.api.mockRejectedValueOnce(Object.assign(new Error("Sign-in required"), { status }));
    render(true); fixture.effects[0](); await flush();
    const view = render(true);
    expect(view.html).toContain("Retry"); expect(view.html).toContain("This does not undo the installation restore.");
    expect(view.html).not.toContain("Normal app");
    expect(storage).toEqual(before); expect(window.location.reload).not.toHaveBeenCalled();
    view.nodes.find((node) => node.type === "button" && node.props.children === "Continue without restoring drafts")!.props.onClick!();
    before.delete("seira-pending-workspace-restore");
    expect(storage).toEqual(before);
    expect(window.location.reload).toHaveBeenCalledOnce();
    expect(render(true).html).not.toContain("Normal app"); // bootstrap, not a direct authentication bypass
    expect(fixture.api).toHaveBeenCalledTimes(status === 401 ? 1 : 2);
  });

  it("keeps recovery gated if its marker cannot be cleared", async () => {
    storage.set("seira-pending-workspace-restore", "stage-id"); storage.set("seira-drafts", "keep");
    fixture.api.mockRejectedValueOnce(new Error("Sign-in required"));
    render(true); fixture.effects[0](); await flush();
    vi.spyOn(localStorage, "removeItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
    render(true).nodes.find((node) => node.type === "button" && node.props.children === "Continue without restoring drafts")!.props.onClick!();
    expect(render(true).html).toContain("Storage unavailable"); expect(render(true).html).not.toContain("Normal app");
    expect(storage.get("seira-drafts")).toBe("keep"); expect(storage.get("seira-pending-workspace-restore")).toBe("stage-id");
    expect(window.location.reload).not.toHaveBeenCalled();
  });
});
