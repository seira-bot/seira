// @vitest-environment happy-dom
// The one avatar editor, in the three places that show it.
import { createElement, createRef } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import { AVATAR_FOCUS_CENTER, AVATAR_ZOOM_MIN } from "../../../shared/bot-avatar";
import { PICKER_BODY_IDS } from "../../../shared/bot-body";
import { MASCOT_ACCESSORY_IDS } from "../../../shared/mascot-accessories";

const fixture = vi.hoisted(() => ({ imageGen: { ready: true } as { ready: boolean } | undefined, dispatch: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({
      state: { ...original.initialState, config: { imageGen: fixture.imageGen } },
      dispatch: fixture.dispatch,
      flushBotPatches: () => Promise.resolve(null),
    }),
  };
});
vi.mock("@/lib/use-organization-branding", () => ({ useOrganizationBranding: () => null }));
vi.mock("../Avatar", () => ({ SeiraAvatar: () => null, BotAvatar: () => null }));

const { AvatarEditor } = await import("./AvatarEditor");
const { AvatarEditorCard } = await import("../bot-panel/AvatarEditorCard");
const { BotProfileAvatarCard } = await import("../BotProfileAvatarCard");
const { SeiraCustomize } = await import("../SeiraCustomize");

const bot = (extra: Partial<Bot> = {}): Bot => ({
  id: "scout", threadId: "t", name: "Scout", title: "Researcher", description: "", notifications: false, color: "green", unread: false,
  modelSelection: { instanceId: "claude", model: "m" }, messages: [], ...extra,
}) as Bot;
const PICTURE = { avatarUrl: "/api/attachments/cat.webp", avatarCrop: "circle" } as const;

let host: HTMLDivElement;
let root: Root;
const click = (element: Element | null) => {
  if (!element) throw new Error("nothing to click");
  flushSync(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
};
const q = (selector: string) => host.querySelector<HTMLElement>(selector);
const tabs = () => [...host.querySelectorAll('[role="tab"]')].map((tab) => [tab.getAttribute("data-avatar-tab"), tab.textContent]);
const selectedTab = () => host.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute("data-avatar-tab");
const image = (extra: Record<string, unknown> = {}) => ({
  fileRef: createRef<HTMLInputElement>(), crop: "mascot", busy: false, uploading: false, generating: false, error: null,
  upload: vi.fn(), removeImage: vi.fn(), generate: vi.fn(), ...extra,
});
const REMOVED = ["data-avatar-crop", "data-avatar-reset", "data-avatar-more", "data-avatar-body-everywhere", "data-cast-character"];

beforeEach(() => {
  fixture.imageGen = { ready: true };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

const mount = (shown: Bot, onPatch = vi.fn(), extra: Record<string, unknown> = {}, variant: "popover" | "card" | "welcome" = "popover") => {
  const crop = shown.avatarCrop ?? "mascot";
  flushSync(() => root.render(createElement(AvatarEditor, { bot: shown, activeState: "idle", image: image({ crop, ...extra }) as never, variant, onPatch })));
  return onPatch;
};

describe("the avatar editor", () => {
  it.each(["popover", "card", "welcome"] as const)("has exactly three tabs and none of the old controls in the %s look", (variant) => {
    mount(bot(), vi.fn(), {}, variant);
    expect(tabs()).toEqual([["seira", "Seira"], ["generate", "Generate"], ["upload", "Upload"]]);
    for (const attribute of REMOVED) expect(q(`[${attribute}]`)).toBeNull();
    expect(host.textContent).not.toMatch(/Characters|Reset|More looks|Rounded|Square|Circle|Shape/);
  });

  it("opens on Seira for a mascot, and on Upload while a picture shows", () => {
    mount(bot());
    expect(selectedTab()).toBe("seira");
    flushSync(() => root.unmount());
    root = createRoot(host);
    mount(bot(PICTURE));
    expect(selectedTab()).toBe("upload");
  });

  it("offers Hair, Face, Accessories and Color groups and a Surprise me button on the Seira tab", () => {
    mount(bot());
    const groups = [...host.querySelectorAll("[data-avatar-group]")].map((group) => [group.getAttribute("data-avatar-group"), group.textContent]);
    const hair = PICKER_BODY_IDS.length > 1 ? [["hair", "Hair"]] : [];
    expect(groups).toEqual([...hair, ["face", "Face"], ["accessories", "Accessories"], ["color", "Color"]]);
    expect(q("[data-avatar-surprise]")?.textContent).toBe("Surprise me");
  });

  it("shows the grid of the open group", () => {
    mount(bot());
    click(q('[data-avatar-group="face"]'));
    expect(host.querySelectorAll("[data-avatar-face]").length).toBeGreaterThan(5);
    click(q('[data-avatar-group="accessories"]'));
    expect(host.querySelectorAll("[data-avatar-accessory]")).toHaveLength(MASCOT_ACCESSORY_IDS.length);
    click(q('[data-avatar-group="color"]'));
    expect(host.querySelectorAll("[data-avatar-color]")).toHaveLength(12);
  });

  it("sets the face, the color and an accessory", () => {
    const onPatch = mount(bot());
    click(q('[data-avatar-group="face"]'));
    click(q('[data-avatar-face="proud"]'));
    expect(onPatch).toHaveBeenLastCalledWith({ mascotExpression: "proud" });
    click(q('[data-avatar-group="color"]'));
    click(q('[data-avatar-color="blue"]'));
    expect(onPatch).toHaveBeenLastCalledWith({ color: "blue" });
    click(q('[data-avatar-group="accessories"]'));
    click(q('[data-avatar-accessory="glasses"]'));
    expect(onPatch).toHaveBeenLastCalledWith({ mascotAccessories: ["glasses"] });
  });

  it("sets hair", () => {
    const second = PICKER_BODY_IDS[1];
    if (!second) return;
    const onPatch = mount(bot());
    click(q(`[data-avatar-hair="${second}"]`));
    expect(onPatch).toHaveBeenLastCalledWith({ mascotBody: second });
  });

  it("Surprise me sends a whole look", () => {
    const onPatch = mount(bot());
    click(q("[data-avatar-surprise]"));
    expect(onPatch).toHaveBeenCalledWith({
      mascotBody: expect.any(String), mascotAccessories: expect.any(Array), color: expect.any(String),
    });
  });

  it("shows the mascot and keeps the picture when a Seira option is picked over a picture", () => {
    const onPatch = mount(bot(PICTURE));
    click(q('[data-avatar-tab="seira"]'));
    click(q('[data-avatar-group="color"]'));
    click(q('[data-avatar-color="blue"]'));
    expect(onPatch).toHaveBeenLastCalledWith({ color: "blue", avatarCrop: "mascot" });
    click(q("[data-avatar-surprise]"));
    const surprise = onPatch.mock.calls.at(-1)![0];
    expect(surprise.avatarCrop).toBe("mascot");
    expect("avatarUrl" in surprise).toBe(false);
  });

  it("offers Use this picture while a stored picture is hidden, and Remove picture while one is stored", () => {
    const stored = bot({ avatarUrl: PICTURE.avatarUrl, avatarCrop: "mascot" });
    const onPatch = mount(stored);
    click(q('[data-avatar-tab="upload"]'));
    expect(q("[data-avatar-use-picture]")?.textContent).toBe("Use this picture");
    expect(q("[data-avatar-remove]")?.textContent).toBe("Remove picture");
    click(q("[data-avatar-use-picture]"));
    expect(onPatch).toHaveBeenLastCalledWith({ avatarCrop: "circle" });
  });

  it("removes the picture through the shared remove, and offers neither button without a stored picture", () => {
    const removeImage = vi.fn();
    mount(bot(PICTURE), vi.fn(), { removeImage });
    expect(q("[data-avatar-use-picture]")).toBeNull();
    click(q("[data-avatar-remove]"));
    expect(removeImage).toHaveBeenCalled();
    flushSync(() => root.unmount());
    root = createRoot(host);
    mount(bot());
    click(q('[data-avatar-tab="upload"]'));
    expect(q("[data-avatar-remove]")).toBeNull();
    expect(q("[data-avatar-use-picture]")).toBeNull();
  });

  it("shows the drop zone and one line of file types, and framing only while a picture shows", () => {
    mount(bot());
    click(q('[data-avatar-tab="upload"]'));
    expect(q("[data-avatar-drop]")?.textContent).toContain("PNG, JPEG, GIF, or WebP");
    expect(host.querySelector('input[type="range"]')).toBeNull();
    flushSync(() => root.unmount());
    root = createRoot(host);
    mount(bot(PICTURE));
    expect(host.querySelector('input[type="range"]')).not.toBeNull();
  });

  it("shows an error under the tabs", () => {
    mount(bot(), vi.fn(), { error: "The upload failed" });
    const alert = q('[role="alert"]')!;
    expect(alert.textContent).toBe("The upload failed");
    expect(q('[role="tablist"]')!.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("disables Generate with one sentence and the settings link while image generation is not set up", () => {
    fixture.imageGen = undefined;
    mount(bot());
    click(q('[data-avatar-tab="generate"]'));
    expect((host.querySelector("button.bg-accent") as HTMLButtonElement).disabled).toBe(true);
    const sentence = q("[data-avatar-generator] p")!;
    expect(sentence.textContent).toBe("Set up image generation to make a picture with AI. Open image settings");
    expect(sentence.textContent).not.toMatch(/\byet\b|provider|key|endpoint/i);
    click(sentence.querySelector("button"));
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "imageGeneration" });
  });

  it("shows no setup sentence once image generation is ready", () => {
    mount(bot());
    click(q('[data-avatar-tab="generate"]'));
    expect(q("[data-avatar-generator] p")).toBeNull();
  });
});

describe("the editor in its three places", () => {
  it("is the popover body of the panel", () => {
    flushSync(() => root.render(createElement(AvatarEditorCard, { bot: bot(), activeState: "idle", onPatch: vi.fn(), onClose: vi.fn() })));
    expect(q("[data-panel-avatar-editor] [data-avatar-editor]")).not.toBeNull();
    expect(tabs()).toHaveLength(3);
  });

  it("is the Bot settings card", () => {
    flushSync(() => root.render(createElement(BotProfileAvatarCard, { bot: bot(), activeState: "idle", mascotMotion: null, onPatch: vi.fn() })));
    expect(tabs()).toEqual([["seira", "Seira"], ["generate", "Generate"], ["upload", "Upload"]]);
    for (const attribute of REMOVED) expect(q(`[${attribute}]`)).toBeNull();
  });

  it("is the welcome's look editor, below the name", () => {
    flushSync(() => root.render(createElement(SeiraCustomize, {
      preview: bot(), name: "", nameRef: createRef<HTMLInputElement>(), image: image() as never, onName: vi.fn(), onPatch: vi.fn(),
    })));
    expect(tabs()).toEqual([["seira", "Seira"], ["generate", "Generate"], ["upload", "Upload"]]);
    expect(q("[data-seira-welcome-name]")).not.toBeNull();
    expect(host.textContent).not.toContain("Characters");
  });
});

describe("what an upload, a generation and a removal save", () => {
  const probe = async (shown: Bot, request = vi.fn(), uploadAvatar: (file: File) => Promise<string> = () => Promise.resolve("/api/attachments/new.png")) => {
    const { useAvatarImage } = await import("../avatar-editing");
    const { BotEditorContext } = await import("../bot-settings/BotEditorContext");
    const patches: Array<Record<string, unknown>> = [];
    let current!: ReturnType<typeof useAvatarImage>;
    const Probe = () => {
      current = useAvatarImage(shown, (patch) => patches.push(patch));
      return null;
    };
    const value = { request: request as never, uploadAvatar };
    flushSync(() => root.render(createElement(BotEditorContext.Provider, { value }, createElement(Probe))));
    return { patches, get: () => current };
  };

  it("saves an upload in a circle, even for a bot saved with another shape", async () => {
    const { patches, get } = await probe(bot({ avatarCrop: "rounded", avatarUrl: "/api/attachments/old.png" }));
    await get().upload(new File(["x"], "a.png", { type: "image/png" }));
    expect(patches.at(-1)).toEqual({ avatarUrl: "/api/attachments/new.png", avatarCrop: "circle", avatarZoom: AVATAR_ZOOM_MIN, avatarFocusX: AVATAR_FOCUS_CENTER, avatarFocusY: AVATAR_FOCUS_CENTER });
  });

  it("saves a generated picture in a circle", async () => {
    const request = vi.fn(() => Promise.resolve({ avatarUrl: "/api/attachments/made.png" }));
    const { patches, get } = await probe(bot({ avatarCrop: "square", avatarUrl: "/api/attachments/old.png" }), request);
    await get().generate("a calm navigator");
    expect(patches.at(-1)).toEqual({ avatarUrl: "/api/attachments/made.png", avatarCrop: "circle" });
  });

  it("saves a removal as the mascot, with the framing back at center", async () => {
    const { patches, get } = await probe(bot(PICTURE));
    get().removeImage();
    expect(patches.at(-1)).toEqual({ avatarUrl: null, avatarCrop: "mascot", avatarZoom: AVATAR_ZOOM_MIN, avatarFocusX: AVATAR_FOCUS_CENTER, avatarFocusY: AVATAR_FOCUS_CENTER });
  });

  it("keeps the picture and reports the error when an upload fails", async () => {
    const { patches, get } = await probe(bot(PICTURE), vi.fn(), () => Promise.reject(new Error("The upload failed")));
    await get().upload(new File(["x"], "a.png", { type: "image/png" }));
    expect(patches).toEqual([]);
    await vi.waitFor(() => expect(get().error).toBe("The upload failed"));
  });

  it("keeps the picture and reports the error when a generation fails", async () => {
    const { patches, get } = await probe(bot(PICTURE), vi.fn(() => Promise.reject(new Error("No picture was made"))));
    await get().generate("a calm navigator");
    await vi.waitFor(() => expect(get().error).toBe("No picture was made"));
    expect(patches).toEqual([]);
  });
});
