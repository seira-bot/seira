import { describe, expect, it } from "vitest";
import { backupSizeText, readBackupSizes, sortedBackupParts, totalWithout } from "./workspace-backup-sizes";

const reply = { parts: { other: 5, "work-folders": 900, chats: 10, memory: 20, attachments: 30 }, total: 965, canLeaveOut: ["work-folders"] };

describe("backup size report", () => {
  it("accepts the shape of the size route and rejects any other", () => {
    expect(readBackupSizes(reply)).toEqual(reply);
    for (const bad of [undefined, null, "x", [], {}, { ...reply, parts: [] }, { ...reply, parts: { chats: -1 } }, { ...reply, parts: { chats: "1" } }, { ...reply, total: Number.NaN }, { ...reply, canLeaveOut: "work-folders" }]) {
      expect(readBackupSizes(bad)).toBeNull();
    }
  });

  it("drops a leave-out entry that is not text", () => {
    expect(readBackupSizes({ ...reply, canLeaveOut: ["work-folders", 3, null] })?.canLeaveOut).toEqual(["work-folders"]);
  });

  it("orders the known parts first and an unknown part last", () => {
    expect(sortedBackupParts({ ...reply, parts: { ...reply.parts, zeta: 1 } })).toEqual(["chats", "memory", "attachments", "work-folders", "other", "zeta"]);
  });

  it("totals without the parts that are left out", () => {
    const sizes = readBackupSizes(reply)!;
    expect(totalWithout(sizes, [])).toBe(965);
    expect(totalWithout(sizes, ["work-folders"])).toBe(65);
    expect(totalWithout(sizes, ["not-a-part"])).toBe(965);
  });

  it("writes a size in B, KB, MB or GB", () => {
    expect(backupSizeText(0)).toBe("0 B");
    expect(backupSizeText(1023)).toBe("1,023 B");
    expect(backupSizeText(1536)).toBe("1.5 KB");
    expect(backupSizeText(5 * 1024 ** 2)).toBe("5.0 MB");
    expect(backupSizeText(3 * 1024 ** 3)).toBe("3.0 GB");
  });
});
