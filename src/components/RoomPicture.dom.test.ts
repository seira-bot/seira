// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Group } from "@/state/store";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), upload: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: original.initialState, dispatch: fixture.dispatch }) };
});
vi.mock("@/state/store-select", async (importOriginal) => ({ ...await importOriginal<typeof import("@/state/store-select")>(), useStoreDispatch: () => fixture.dispatch }));
vi.mock("@/lib/room-picture", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/room-picture")>(), uploadRoomPicture: fixture.upload }));
vi.mock("./Avatar", async () => {
  const { createElement: h } = await import("react");
  return { BotAvatar: ({ bot }: { bot: { id: string } }) => h("i", { "data-face": bot.id }) };
});

const { RoomPicture } = await import("./RoomPicture");
const { RoomPictureControls } = await import("./RoomPictureControls");
const { RoomPictureMenuItems } = await import("./RoomPictureMenuItems");
const { SimpleRoomStack } = await import("./SidebarSimpleRoom");
const { AdvancedRoomStack } = await import("./SidebarAdvancedRows");
const { RoomMark } = await import("./StackedSeiras");

const bot = (id: string): Bot => ({
  id, threadId: `${id}-thread`, name: id, title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages: [], modelSelection: { instanceId: "test", model: "m" },
});
const members = [bot("a"), bot("b")];
const room = (patch: Partial<Group> = {}): Group => ({
  id: "desk", threadId: "desk-thread", name: "Desk", memberIds: ["a", "b"], defaultResponder: { kind: "mentions" },
  bulletin: "", unread: false, createdAt: 1, messages: [], ...patch,
});
const URL_A = "/api/attachments/team-1.png";
const URL_B = "/api/attachments/team-2.webp";

let host: HTMLDivElement;
let root: Root;
const draw = (node: Parameters<Root["render"]>[0]) => flushSync(() => root.render(node));
const $ = (selector: string) => host.querySelector<HTMLElement>(selector);
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const faces = () => [...host.querySelectorAll("[data-face]")].map((face) => face.getAttribute("data-face"));
const failToLoad = () => flushSync(() => $("[data-room-picture]")!.dispatchEvent(new Event("error")));

beforeEach(() => {
  fixture.dispatch.mockReset();
  fixture.upload.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

describe("RoomPicture", () => {
  const faceNode = createElement("b", { "data-fallback": "" });

  it("draws the picture as a round, empty-alt image and not the fallback", () => {
    draw(createElement(RoomPicture, { url: URL_A, size: 32, fallback: faceNode }));
    const img = $("[data-room-picture]") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(URL_A);
    expect(img.getAttribute("alt")).toBe("");
    expect(img.className).toContain("rounded-full");
    expect(img.className).toContain("object-cover");
    expect($("[data-fallback]")).toBeNull();
  });

  it("draws the fallback when there is no picture", () => {
    draw(createElement(RoomPicture, { url: null, size: 32, fallback: faceNode }));
    expect($("[data-room-picture]")).toBeNull();
    expect($("[data-fallback]")).not.toBeNull();
  });

  it("falls back when the picture fails to load, and tries a new url again", () => {
    draw(createElement(RoomPicture, { url: URL_A, size: 32, fallback: faceNode }));
    failToLoad();
    expect($("[data-room-picture]")).toBeNull();
    expect($("[data-fallback]")).not.toBeNull();
    draw(createElement(RoomPicture, { url: URL_B, size: 32, fallback: faceNode }));
    expect($("[data-room-picture]")?.getAttribute("src")).toBe(URL_B);
  });
});

describe("the sidebar marks", () => {
  it("shows the picture instead of the member faces in a Simple row, and the faces again when it fails", () => {
    draw(createElement(SimpleRoomStack, { members, picture: URL_A }));
    expect($("[data-room-picture]")).not.toBeNull();
    expect(faces()).toEqual([]);
    failToLoad();
    expect(faces()).toEqual(["a", "b"]);
  });

  it("keeps the member faces in a Simple row with no picture", () => {
    draw(createElement(SimpleRoomStack, { members, picture: null }));
    expect($("[data-room-picture]")).toBeNull();
    expect(faces()).toEqual(["a", "b"]);
  });

  it("shows the picture in an Advanced row", () => {
    draw(createElement(AdvancedRoomStack, { members, picture: URL_A }));
    expect($("[data-room-picture]")).not.toBeNull();
    expect(faces()).toEqual([]);
    failToLoad();
    expect(faces()).toEqual(["a", "b"]);
  });

  it("shows the picture on the icon rail's mark, and the plain mark without one", () => {
    draw(createElement(RoomMark, { density: "icons", picture: URL_A }));
    expect($("[data-room-picture]")).not.toBeNull();
    expect($("[data-room-mark]")).toBeNull();
    draw(createElement(RoomMark, { density: "icons", picture: null }));
    expect($("[data-room-mark]")).not.toBeNull();
  });
});

describe("the panel's picture controls", () => {
  const input = () => $('input[type="file"]') as HTMLInputElement;
  const pick = (file: File) => {
    Object.defineProperty(input(), "files", { value: [file], configurable: true });
    flushSync(() => input().dispatchEvent(new Event("change", { bubbles: true })));
  };
  const file = new File(["x"], "team.png", { type: "image/png" });

  it("accepts only the four image types and offers no Remove while there is no picture", () => {
    draw(createElement(RoomPictureControls, { group: room() }));
    expect(input().getAttribute("accept")).toBe("image/png,image/jpeg,image/gif,image/webp");
    expect($("[data-room-picture-change]")?.textContent).toBe("Change picture");
    expect($("[data-room-picture-remove]")).toBeNull();
  });

  it("saves the stored picture's url on the room", async () => {
    fixture.upload.mockResolvedValue({ ok: true, avatarUrl: URL_A });
    draw(createElement(RoomPictureControls, { group: room() }));
    pick(file);
    await settle();
    expect(fixture.dispatch.mock.calls.map(([action]) => action)).toEqual([{ type: "patchGroup", groupId: "desk", patch: { avatarUrl: URL_A } }]);
    expect($('[role="alert"]')).toBeNull();
  });

  it("disables the button while the picture is saving", async () => {
    let finish: (value: unknown) => void = () => {};
    fixture.upload.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    draw(createElement(RoomPictureControls, { group: room() }));
    pick(file);
    expect(($("[data-room-picture-change]") as HTMLButtonElement).disabled).toBe(true);
    finish({ ok: true, avatarUrl: URL_A });
    await settle();
    expect(($("[data-room-picture-change]") as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows a plain message, saves nothing and keeps the old picture when the file is refused", async () => {
    fixture.upload.mockResolvedValue({ ok: false, refusal: "type" });
    draw(createElement(RoomPictureControls, { group: room({ avatarUrl: URL_A }) }));
    pick(file);
    await settle();
    expect($('[role="alert"]')?.textContent).toBe("Pick a PNG, JPEG, GIF or WebP image.");
    expect(fixture.dispatch).not.toHaveBeenCalled();
    fixture.upload.mockResolvedValue({ ok: false, refusal: "size" });
    pick(file);
    await settle();
    expect($('[role="alert"]')?.textContent).toBe("That picture is too big. Pick one under 10 MB.");
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("clears the picture with null on Remove", () => {
    draw(createElement(RoomPictureControls, { group: room({ avatarUrl: URL_A }) }));
    flushSync(() => $("[data-room-picture-remove]")!.click());
    expect(fixture.dispatch.mock.calls.map(([action]) => action)).toEqual([{ type: "patchGroup", groupId: "desk", patch: { avatarUrl: null } }]);
  });

  it("draws nothing for a bot-to-bot chat", () => {
    draw(createElement(RoomPictureControls, { group: room({ dm: true }) }));
    expect($("[data-room-picture-controls]")).toBeNull();
  });
});

describe("the sidebar menu's picture rows", () => {
  const items = () => [...host.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent);

  it("offers Change, and Remove only while there is a picture", () => {
    draw(createElement(RoomPictureMenuItems, { group: room(), onClose: vi.fn() }));
    expect(items()).toEqual(["Change picture"]);
    draw(createElement(RoomPictureMenuItems, { group: room({ avatarUrl: URL_A }), onClose: vi.fn() }));
    expect(items()).toEqual(["Change picture", "Remove picture"]);
  });

  it("removes with null and closes the menu", () => {
    const onClose = vi.fn();
    draw(createElement(RoomPictureMenuItems, { group: room({ avatarUrl: URL_A }), onClose }));
    flushSync(() => host.querySelectorAll<HTMLElement>('[role="menuitem"]')[1]!.click());
    expect(fixture.dispatch.mock.calls.map(([action]) => action)).toEqual([{ type: "patchGroup", groupId: "desk", patch: { avatarUrl: null } }]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("opens a file input that is not in the page, so closing the menu cannot cancel the choice", async () => {
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    const chosen = () => click.mock.contexts[0] as HTMLInputElement;
    fixture.upload.mockResolvedValue({ ok: true, avatarUrl: URL_A });
    const onClose = vi.fn();
    draw(createElement(RoomPictureMenuItems, { group: room(), onClose }));
    flushSync(() => host.querySelector<HTMLElement>('[role="menuitem"]')!.click());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(chosen().isConnected).toBe(false);
    expect(chosen().accept).toBe("image/png,image/jpeg,image/gif,image/webp");
    flushSync(() => root.render(null));
    Object.defineProperty(chosen(), "files", { value: [new File(["x"], "t.png", { type: "image/png" })] });
    chosen().dispatchEvent(new Event("change"));
    await settle();
    expect(fixture.dispatch.mock.calls.map(([action]) => action)).toEqual([{ type: "patchGroup", groupId: "desk", patch: { avatarUrl: URL_A } }]);
    click.mockRestore();
  });

  it("raises the error notice for a refused file", async () => {
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    const chosen = () => click.mock.contexts[0] as HTMLInputElement;
    fixture.upload.mockResolvedValue({ ok: false, refusal: "size" });
    draw(createElement(RoomPictureMenuItems, { group: room(), onClose: vi.fn() }));
    flushSync(() => host.querySelector<HTMLElement>('[role="menuitem"]')!.click());
    Object.defineProperty(chosen(), "files", { value: [new File(["x"], "t.png", { type: "image/png" })] });
    chosen().dispatchEvent(new Event("change"));
    await settle();
    expect(fixture.dispatch.mock.calls.map(([action]) => action)).toEqual([{ type: "error", message: "That picture is too big. Pick one under 10 MB." }]);
    click.mockRestore();
  });
});
