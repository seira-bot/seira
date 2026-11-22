import { beforeEach, describe, expect, it, vi } from "vitest";

const upload = vi.hoisted(() => vi.fn());
vi.mock("./composer-attachments", async (importOriginal) => ({ ...await importOriginal<typeof import("./composer-attachments")>(), imageAttachmentFromFile: upload }));

const { roomPictureMessage, sniffImageMime, uploadRoomPicture } = await import("./room-picture");

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0];
const GIF = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0];
const WEBP = [0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50];
const file = (bytes: number[] | string, name: string, type: string) => new File([typeof bytes === "string" ? bytes : new Uint8Array(bytes)], name, { type });

beforeEach(() => upload.mockReset());

describe("sniffImageMime", () => {
  it("names the four allowed types by their first bytes", () => {
    expect(sniffImageMime(new Uint8Array(PNG))).toBe("image/png");
    expect(sniffImageMime(new Uint8Array(JPEG))).toBe("image/jpeg");
    expect(sniffImageMime(new Uint8Array(GIF))).toBe("image/gif");
    expect(sniffImageMime(new Uint8Array(WEBP))).toBe("image/webp");
  });

  it("refuses everything else", () => {
    expect(sniffImageMime(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffImageMime(new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45]))).toBeNull();
    expect(sniffImageMime(new Uint8Array())).toBeNull();
  });
});

describe("uploadRoomPicture", () => {
  it("uploads a real image and returns its attachment url", async () => {
    upload.mockResolvedValue({ path: "/data/attachments/abc-1.png" });
    const result = await uploadRoomPicture(file(PNG, "logo.png", "image/png"));
    expect(result).toEqual({ ok: true, avatarUrl: "/api/attachments/abc-1.png" });
    expect(upload.mock.calls[0]![0].type).toBe("image/png");
  });

  it("trusts the bytes, not the name or the declared type", async () => {
    upload.mockResolvedValue({ path: "/data/attachments/abc-2.jpg" });
    expect(await uploadRoomPicture(file(JPEG, "notes.txt", "text/plain"))).toEqual({ ok: true, avatarUrl: "/api/attachments/abc-2.jpg" });
    expect(upload.mock.calls[0]![0].type).toBe("image/jpeg");
  });

  it("refuses an SVG and text renamed .png, and uploads nothing", async () => {
    expect(await uploadRoomPicture(file("<svg xmlns='http://www.w3.org/2000/svg'/>", "a.svg", "image/svg+xml"))).toEqual({ ok: false, refusal: "type" });
    expect(await uploadRoomPicture(file("hello world, not an image", "a.png", "image/png"))).toEqual({ ok: false, refusal: "type" });
    expect(upload).not.toHaveBeenCalled();
  });

  it("refuses a file over 10 MB and uploads nothing", async () => {
    const big = new File([new Uint8Array(10 * 1024 * 1024 + 1)], "big.png", { type: "image/png" });
    expect(await uploadRoomPicture(big)).toEqual({ ok: false, refusal: "size" });
    expect(upload).not.toHaveBeenCalled();
  });

  it("reports a failed upload, or a path that is not a stored image", async () => {
    upload.mockRejectedValueOnce(new Error("upload failed"));
    expect(await uploadRoomPicture(file(GIF, "a.gif", "image/gif"))).toEqual({ ok: false, refusal: "failed" });
    upload.mockResolvedValueOnce({ path: "/data/attachments/abc.svg" });
    expect(await uploadRoomPicture(file(WEBP, "a.webp", "image/webp"))).toEqual({ ok: false, refusal: "failed" });
  });
});

describe("roomPictureMessage", () => {
  it("says each refusal in plain words", () => {
    expect(roomPictureMessage("type")).toBe("Pick a PNG, JPEG, GIF or WebP image.");
    expect(roomPictureMessage("size")).toBe("That picture is too big. Pick one under 10 MB.");
    expect(roomPictureMessage("failed")).toBe("The picture could not be saved. Try again.");
  });
});
