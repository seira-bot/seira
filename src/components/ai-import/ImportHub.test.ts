// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ state: {} as Record<string, unknown>, api: vi.fn(), copy: vi.fn(async (_text: string) => "copied" as const) }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: f.state, dispatch: vi.fn() }), api: f.api }));
vi.mock("@/lib/copy-text", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/copy-text")>()), copyText: f.copy }));

import type { AiImportClient } from "@/lib/ai-import";
import { setLocale } from "@/lib/i18n";
import { ImportSettings } from "../ImportSettings";
import { HERMES_EXPORT_SKILL } from "../../../shared/ai-import/hermes-export";
import { emptyCounts, type ImportErrorCode, type ImportJobView, type LocalSourceView } from "../../../shared/ai-import/api";
import { limitMessage } from "./copy";
import { GuideView, HubView, ImportHubSection, resumableJob, type HubViewProps } from "./ImportHub";
import { DropZone } from "./DropZone";
import { ApplyView, ReadingView } from "./Progress";
import { ReportView } from "./Report";
import { DONE, job, READY } from "./test-jobs";

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const SOURCES: LocalSourceView[] = [
  { id: "s1", kind: "hermes", name: "Hermes · work", profile: "work" },
  { id: "s2", kind: "claude-code", name: "Claude Code" },
];
const hub = (overrides: Partial<HubViewProps> = {}) => renderToStaticMarkup(createElement(HubView, {
  local: true, localSources: SOURCES, transcripts: false, instructions: "persona", grokOpen: false, resume: null, sending: null,
  onTranscripts: vi.fn(), onInstructions: vi.fn(), onGuide: vi.fn(), onBring: vi.fn(), onPaste: vi.fn(), onGrok: vi.fn(), onResume: vi.fn(), onFiles: vi.fn(), ...overrides,
}));

beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; setLocale("en"); f.state = { config: {}, bots: [{ id: "b-9", name: "Sample helper" }] }; });

describe("the hub on the Import page", () => {
  it("replaces the two old cards", () => {
    const markup = renderToStaticMarkup(createElement(ImportSettings));
    const shown = text(markup);
    expect(shown).toContain("Move from another AI");
    expect(markup).toContain('data-import-section="ai-import"');
    expect(shown).not.toContain("From your AI apps");
    expect(shown).not.toContain("Move from Grok Bot");
    expect(markup).not.toContain('data-import-section="apps"');
    expect(markup).not.toContain('data-import-section="grok"');
  });

  it("lists the sources, with the found folders first", () => {
    const markup = hub();
    const shown = text(markup);
    for (const name of ["ChatGPT", "Claude.ai", "Grok Bot", "Another AI", "Hermes", "Claude Code"]) expect(shown).toContain(name);
    expect(markup).toContain('data-ai-import-source="hermes"');
    expect(markup.indexOf('data-ai-import-source="hermes"')).toBeLessThan(markup.indexOf('data-ai-import-source="chatgpt"'));
    expect(markup).toContain("data-ai-import-drop");
  });

  it("shows session transcripts for Claude Code, off until the person turns them on", () => {
    const box = (markup: string) => /<input[^>]*data-ai-import-transcripts[^>]*>/.exec(markup)![0];
    expect(box(hub())).not.toContain("checked");
    expect(box(hub({ transcripts: true }))).toContain("checked");
  });

  it("offers Claude Code instructions as persona or About you", () => {
    const markup = hub();
    const select = /<select[^>]*data-ai-import-instructions[^>]*>[\s\S]*?<\/select>/.exec(markup)![0];
    expect(select).toContain('<option value="persona" selected="">Persona</option>');
    expect(select).toContain('<option value="about-you">About you</option>');
    expect(markup.match(/data-ai-import-instructions/g)).toHaveLength(1);
    expect(markup.indexOf("data-ai-import-instructions")).toBeGreaterThan(markup.indexOf('data-ai-import-source="claude-code"') - 2000);
    const only = hub({ localSources: [SOURCES[0]!] });
    expect(only).not.toContain("data-ai-import-instructions");
    expect(text(hub())).toContain("Use your instructions as");
    expect(hub({ instructions: "about-you" })).toContain('<option value="about-you" selected="">About you</option>');
  });

  it("offers Hermes on another computer for a local and a remote server", () => {
    for (const local of [true, false]) {
      const markup = hub({ local });
      expect(markup).toContain('data-ai-import-source="hermes-file"');
      expect(text(markup)).toContain("Hermes on another computer");
    }
  });

  it("guides the Hermes file with three steps and a Copy button", () => {
    const guide = (copied: boolean) => renderToStaticMarkup(createElement(GuideView, { source: "hermes", sending: null, copied, onCopy: vi.fn(), onFiles: vi.fn(), onBack: vi.fn() }));
    const markup = guide(false);
    expect(text(markup)).toContain("Export from Hermes");
    expect(markup.match(/<li/g)).toHaveLength(3);
    expect(markup).toContain("data-ai-import-copy");
    expect(text(markup)).toContain("Copy");
    expect(text(guide(true))).toContain("Copied");
  });

  it("remote server hides local sources", () => {
    const markup = hub({ local: false });
    expect(markup).not.toContain('data-ai-import-source="hermes"');
    expect(markup).not.toContain('data-ai-import-source="claude-code"');
    expect(markup).not.toContain("data-ai-import-transcripts");
    expect(markup).not.toContain("data-ai-import-instructions");
    expect(markup).toContain('data-ai-import-source="chatgpt"');
    expect(markup).toContain('data-ai-import-source="paste"');
    expect(markup).toContain("data-ai-import-files");
    expect(text(markup)).toContain("can only be brought in from that computer");
  });

  it("names a local source once and describes it with its own line", () => {
    const shown = text(hub());
    expect(shown).toContain("Hermes · work Profile, memories, skills, tools, routines and chats.");
    expect(shown).not.toContain("work · work");
  });

  it("says when it looks, finds nothing, or has a job to come back to", () => {
    expect(text(hub({ localSources: undefined }))).toContain("Looking on this computer…");
    expect(text(hub({ localSources: [] }))).toContain("No other AI apps found on this computer.");
    expect(text(hub({ resume: job({ state: "reading" }) }))).toContain("An import is in progress");
    expect(text(hub({ resume: DONE }))).toContain("View report");
  });

  it("picks the job to come back to: one in progress, else the latest that can still be undone", () => {
    const old = job({ id: "old", state: "done", updatedAt: 1, undoUntil: 10_000, report: DONE.report });
    const busy = job({ id: "busy", state: "applying", updatedAt: 2 });
    expect(resumableJob([old, busy], 5)?.id).toBe("busy");
    expect(resumableJob([old], 5)?.id).toBe("old");
    expect(resumableJob([old], 20_000)).toBeNull();
    expect(resumableJob([job({ id: "u", state: "undone", undoUntil: 10_000 })], 5)).toBeNull();
  });

  it("guides an export with three steps and a drop zone", () => {
    const shown = text(renderToStaticMarkup(createElement(GuideView, { source: "chatgpt", sending: null, onFiles: vi.fn(), onBack: vi.fn() })));
    expect(shown).toContain("Export from ChatGPT");
    expect(shown).toContain("Data controls");
    expect(shown).toContain("Drop an export file or folder here");
    expect(shown).toContain("If the export came in several parts, drop them all together.");
    expect(text(renderToStaticMarkup(createElement(GuideView, { source: "claude-ai", sending: { done: 1, total: 3 }, onFiles: vi.fn(), onBack: vi.fn() })))).toContain("Sending file 1 of 3…");
  });
});

describe("a Seira backup in the drop zone", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  const pickFrom = (names: string[]) => {
    const onFiles = vi.fn();
    act(() => root.render(createElement(DropZone, { sending: null, onFiles })));
    const input = host.querySelector<HTMLInputElement>("input[multiple]")!;
    Object.defineProperty(input, "files", { value: names.map((name) => new File(["x"], name)), configurable: true });
    act(() => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    return onFiles;
  };

  it("starts no import and points to Import backup", () => {
    const onFiles = pickFrom(["Work.SeiraBackup"]);
    expect(onFiles).not.toHaveBeenCalled();
    expect(host.querySelector("[data-ai-import-backup]")?.textContent).toBe("This is a Seira backup, not an AI export. To restore it, use Import backup under Settings → Import & export → Bring things in.");
  });

  it("sends the other files and still shows the message", () => {
    const onFiles = pickFrom(["a.zip", "b.seirabackup"]);
    expect(onFiles).toHaveBeenCalledTimes(1);
    expect((onFiles.mock.calls[0]![0] as Array<{ name: string }>).map((file) => file.name)).toEqual(["a.zip"]);
    expect(host.querySelector("[data-ai-import-backup]")).not.toBeNull();
  });

  it("treats the legacy .ombbackup name as a backup too, as Import backup does", () => {
    const onFiles = pickFrom(["Old.OmbBackup"]);
    expect(onFiles).not.toHaveBeenCalled();
    expect(host.querySelector("[data-ai-import-backup]")).not.toBeNull();
  });

  it("sends the other files when a legacy backup comes with them", () => {
    const onFiles = pickFrom(["a.zip", "b.ombbackup"]);
    expect(onFiles).toHaveBeenCalledTimes(1);
    expect((onFiles.mock.calls[0]![0] as Array<{ name: string }>).map((file) => file.name)).toEqual(["a.zip"]);
    expect(host.querySelector("[data-ai-import-backup]")).not.toBeNull();
  });

  it("shows no message for an export", () => {
    expect(pickFrom(["a.zip"])).toHaveBeenCalledTimes(1);
    expect(host.querySelector("[data-ai-import-backup]")).toBeNull();
  });
});

describe("reading and applying", () => {
  it("shows the counts as they grow, and Cancel", () => {
    const markup = renderToStaticMarkup(createElement(ReadingView, { job: job({ state: "reading" }), onCancel: vi.fn() }));
    const shown = text(markup);
    expect(shown).toContain("Reading your file…");
    expect(shown).toMatch(/Chats\s+12/);
    expect(shown).toMatch(/Messages\s+340/);
    expect(shown).not.toContain("Skills");
    expect(markup).toContain('role="progressbar"');
    expect(shown).toContain("Cancel");
    expect(text(renderToStaticMarkup(createElement(ReadingView, { job: job({ state: "queued" }), onCancel: vi.fn() })))).toContain("Waiting to start…");
  });

  it("says bots come first and chats follow, with a Stop button", () => {
    const shown = text(renderToStaticMarkup(createElement(ApplyView, { job: job({ state: "applying" }), onStop: vi.fn() })));
    expect(shown).toContain("Your bots are ready first. Chats arrive in the background.");
    expect(shown).toContain("Stop");
  });
});

describe("a read that stopped", () => {
  const view = (error: ImportErrorCode) => text(renderToStaticMarkup(createElement(ReportView, { job: job({ state: "failed", error }), onUndo: vi.fn(), onDone: vi.fn(), onRetry: vi.fn() })));

  it("unknown file message: names the supported sources and says nothing was imported", () => {
    const shown = view("unknown-source");
    expect(shown).toContain("Nothing was imported");
    for (const name of ["ChatGPT", "Claude.ai", "Hermes", "OpenClaw", "Claude Code"]) expect(shown).toContain(name);
  });

  it("limit message copy: plain words, no file path or internal code", () => {
    const codes: ImportErrorCode[] = ["upload-too-large", "too-much-data", "too-many-files", "unsafe-archive", "worker-failed", "unknown-source", "secret-file", "bad-export"];
    for (const code of codes) {
      const shown = view(code);
      expect(shown, code).toContain("Nothing was imported");
      expect(shown, code).not.toMatch(/[\\/]|\.\.|[a-z]+-[a-z]+-[a-z]+|worker|archive|error code|\.json|\.zip/i);
    }
    expect(limitMessage("upload-too-large")).toBe("This is larger than 8 GB, the most Seira can read at once.");
    expect(limitMessage("too-much-data")).toBe("This holds more than 16 GB of data once unpacked.");
    expect(limitMessage("too-many-files")).toBe("This holds more than 200,000 files.");
  });
});

describe("a Hermes export that Seira refused", () => {
  it("says what to do in plain words, without file names or codes", () => {
    for (const [code, sentence] of [["secret-file", "This file holds a password or key file"], ["bad-export", "This export file has a mistake in it"]] as const) {
      const shown = text(renderToStaticMarkup(createElement(ReportView, { job: job({ state: "failed", error: code }), onUndo: vi.fn(), onDone: vi.fn(), onRetry: vi.fn() })));
      expect(shown, code).toContain(sentence);
      expect(shown, code).toContain("Nothing was imported");
      expect(shown, code).not.toMatch(/\.env|json|manifest|secret-file|bad-export/i);
    }
  });
});

describe("the hub, in use", () => {
  let root: Root;
  let host: HTMLElement;
  beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  function fakeClient(over: Partial<AiImportClient> = {}) {
    const listeners = new Set<(next: ImportJobView) => void>();
    const client = {
      upload: vi.fn(async () => "u1"),
      localSources: vi.fn(async () => SOURCES),
      create: vi.fn(async () => job({ state: "reading" })),
      list: vi.fn(async () => []),
      get: vi.fn(async () => job({ state: "reading" })),
      apply: vi.fn(async () => job({ state: "applying", agents: READY.agents })),
      cancel: vi.fn(async () => job({ state: "cancelled" })),
      undo: vi.fn(async () => job({ state: "undone" })),
      subscribe: vi.fn((on: (next: ImportJobView) => void) => { listeners.add(on); return () => listeners.delete(on); }),
      ...over,
    } satisfies AiImportClient;
    return { client, emit: (next: ImportJobView) => act(async () => { listeners.forEach((on) => on(next)); }) };
  }
  const click = (selector: string) => act(async () => { host.querySelector<HTMLElement>(selector)!.click(); });
  const type = (selector: string, value: string) => act(async () => {
    const field = host.querySelector<HTMLTextAreaElement>(selector)!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });

  it("opens the Grok Bot dialog", async () => {
    const { client } = fakeClient();
    await act(async () => root.render(createElement(ImportHubSection, { client, local: true })));
    const row = host.querySelector<HTMLButtonElement>("[data-grok-move-open]")!;
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector("[data-grok-move]")).toBeNull();
    await click("[data-grok-move-open]");
    await vi.waitFor(() => expect(host.querySelector("[data-grok-move]")).not.toBeNull());
    expect(row.getAttribute("aria-expanded")).toBe("true");
  });

  it("copies the Hermes steps and shows Copied", async () => {
    const { client } = fakeClient();
    f.copy.mockClear();
    await act(async () => root.render(createElement(ImportHubSection, { client, local: false })));
    await click('[data-ai-import-source="hermes-file"]');
    expect(host.textContent).not.toContain("Copied");
    await click("[data-ai-import-copy]");
    expect(f.copy).toHaveBeenCalledWith(HERMES_EXPORT_SKILL);
    await vi.waitFor(() => expect(host.textContent).toContain("Copied"));
  });

  it("goes from paste to review to the report, and Undo asks nothing first", async () => {
    const { client, emit } = fakeClient();
    await act(async () => root.render(createElement(ImportHubSection, { client, local: true })));
    await click('[data-ai-import-source="paste"]');
    expect(host.querySelector<HTMLButtonElement>("[data-ai-import-paste-import]")!.disabled).toBe(true);
    await type("[data-ai-import-paste-text]", "About you\n- Runs a bakery\nHow to reply\n- Keep it short");
    await click("[data-ai-import-paste-import]");
    expect(client.create).toHaveBeenCalledWith({ from: "paste", ai: "chatgpt", aboutYou: ["Runs a bakery"], howToReply: ["Keep it short"], destination: { kind: "new" } });
    await vi.waitFor(() => expect(host.querySelector('[data-ai-import-screen="reading"]')).not.toBeNull());

    await emit(READY);
    expect(host.querySelector('[data-ai-import-screen="review"]')).not.toBeNull();
    expect(host.querySelectorAll("[data-ai-import-apply]").length).toBe(1);
    await click("[data-ai-import-apply]");
    expect(client.apply).toHaveBeenCalledWith("job-1", { destinations: { a1: { kind: "new" }, a2: { kind: "bot", botId: "b-9" } } });

    await emit({ ...DONE, updatedAt: 9_000 });
    expect(host.querySelector('[data-ai-import-screen="report"]')).not.toBeNull();
    await click("[data-ai-import-undo]");
    expect(client.undo).toHaveBeenCalledWith("job-1");
    expect(host.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull();
  });

  it("shows the supported sources when the file is not one of them", async () => {
    const { client, emit } = fakeClient({ create: vi.fn(async () => job({ state: "reading" })) });
    await act(async () => root.render(createElement(ImportHubSection, { client, local: false })));
    await click('[data-ai-import-source="paste"]');
    await type("[data-ai-import-paste-text]", "Likes tea");
    await click("[data-ai-import-paste-import]");
    await emit(job({ state: "failed", error: "unknown-source", updatedAt: 9_000, counts: emptyCounts() }));
    expect(host.querySelector('[data-ai-import-error="unknown-source"]')?.textContent).toContain("OpenClaw");
  });
});
