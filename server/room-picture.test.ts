import { describe, expect, it } from "vitest";

import { roomPictureChanges, roomPicturePatch } from "./room-picture.ts";

const room = { dm: false };

describe("roomPicturePatch", () => {
  it("ignores a body without a picture", () => {
    expect(roomPicturePatch({ name: "Ops" }, room)).toEqual({});
    expect(roomPicturePatch({ avatarUrl: undefined }, room)).toEqual({});
  });

  it("accepts a stored image attachment url", () => {
    for (const ext of ["png", "jpg", "gif", "webp"]) {
      const url = `/api/attachments/abc-123.${ext}`;
      expect(roomPicturePatch({ avatarUrl: url }, room)).toEqual({ avatarUrl: url });
    }
  });

  it("clears the picture for an empty string or null", () => {
    for (const value of ["", null]) {
      const patch = roomPicturePatch({ avatarUrl: value }, room);
      expect(Object.prototype.hasOwnProperty.call(patch, "avatarUrl")).toBe(true);
      expect(patch.avatarUrl).toBeUndefined();
    }
  });

  it("answers 400 for any other value", () => {
    for (const value of ["https://example.test/a.png", "/api/attachments/a.svg", "/api/attachments/../a.png", "data:image/png;base64,AAAA", 7, {}, true]) {
      expect(() => roomPicturePatch({ avatarUrl: value }, room)).toThrowError(expect.objectContaining({ status: 400 }));
    }
  });

  it("answers 400 on a bot-to-bot channel", () => {
    expect(() => roomPicturePatch({ avatarUrl: "/api/attachments/a.png" }, { dm: true })).toThrowError(expect.objectContaining({ status: 400 }));
    expect(() => roomPicturePatch({ avatarUrl: null }, { dm: true })).toThrowError(expect.objectContaining({ status: 400 }));
  });
});

describe("roomPictureChanges", () => {
  it("is true only when the picture differs from the current one", () => {
    expect(roomPictureChanges({ name: "x" }, {})).toBe(false);
    expect(roomPictureChanges({ avatarUrl: "/api/attachments/a.png" }, {})).toBe(true);
    expect(roomPictureChanges({ avatarUrl: "/api/attachments/a.png" }, { avatarUrl: "/api/attachments/a.png" })).toBe(false);
    expect(roomPictureChanges({ avatarUrl: null }, { avatarUrl: "/api/attachments/a.png" })).toBe(true);
    expect(roomPictureChanges({ avatarUrl: "" }, {})).toBe(false);
    expect(roomPictureChanges(null, {})).toBe(false);
  });
});
