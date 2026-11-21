import { mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { crc32, deflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { createUploadStore, openUploads, safeFileName, type ImportLimits } from "./upload.ts";

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "ai-import-upload-"));
});
afterEach(() => removeTempDir(scratch));

const MIB = 1024 * 1024;
const roomy: ImportLimits = {
  uploadBytes: 100 * MIB,
  extractedBytes: 100 * MIB,
  entries: 1000,
  jsonMemberBytes: 100 * MIB,
  otherMemberBytes: 100 * MIB,
  compressionRatio: 100,
};

const u16 = (value: number): Buffer => {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
};
const u32 = (value: number): Buffer => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
};
const u64 = (value: number): Buffer => {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
};

interface Member {
  name: string;
  data: Buffer;
  method?: 0 | 8;
  declaredSize?: number;
  madeBy?: number;
  attributes?: number;
}

function buildZip(members: Member[]): Buffer {
  const body: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const member of members) {
    const name = Buffer.from(member.name);
    const method = member.method ?? 8;
    const stored = method === 8 ? deflateRawSync(member.data) : member.data;
    const size = member.declaredSize ?? member.data.length;
    const crc = crc32(member.data);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(method), u16(0), u16(0x21),
      u32(crc), u32(stored.length), u32(size), u16(name.length), u16(0), name,
    ]);
    central.push(Buffer.concat([
      u32(0x02014b50), u16(member.madeBy ?? 20), u16(20), u16(0), u16(method), u16(0), u16(0x21),
      u32(crc), u32(stored.length), u32(size), u16(name.length), u16(0), u16(0), u16(0), u16(0),
      u32(member.attributes ?? 0), u32(offset), name,
    ]));
    body.push(local, stored);
    offset += local.length + stored.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(members.length), u16(members.length),
    u32(directory.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...body, directory, end]);
}

function writeFile(name: string, data: Buffer | string): string {
  const path = join(scratch, name);
  writeFileSync(path, data);
  return path;
}

const part = (name: string, members: Member[]) => ({ path: writeFile(name, buildZip(members)), name });
const member = (name: string, content: string): Member => ({ name, data: Buffer.from(content) });

describe("openUploads", () => {
  it("one JSON file", async () => {
    const path = writeFile("upload-1", '{"a":1}');
    const files = await openUploads([{ path, name: "../exports/conversations.json" }], roomy);
    expect(files.entries).toEqual([{ name: "conversations.json", size: 7 }]);
    expect(await text(await files.open("conversations.json"))).toBe('{"a":1}');
    await expect(files.open("other.json")).rejects.toThrow();
    expect(safeFileName("a\\b\\c.json")).toBe("c.json");
    expect(safeFileName("bad\u0000na\nme.json")).toBe("badname.json");
    expect(safeFileName("..")).toBe("upload.json");
    expect(safeFileName("x".repeat(500))).toHaveLength(200);
  });

  it("one ZIP", async () => {
    const zip = part("export.bin", [member("conversations.json", "[1]"), member("media/a.txt", "hello")]);
    const files = await openUploads([zip], roomy);
    expect(files.entries).toEqual([
      { name: "conversations.json", size: 3 },
      { name: "media/a.txt", size: 5 },
    ]);
    expect(await text(await files.open("media/a.txt"))).toBe("hello");
    expect(await text(await files.open("conversations.json"))).toBe("[1]");
    await expect(files.open("missing.txt")).rejects.toThrow();
  });

  it("several part ZIPs as one list", async () => {
    const one = part("part-1.zip", [member("c.json", "ccc"), { name: "a.json", data: Buffer.from("aaa"), method: 0 }]);
    const two = part("part-2.zip", [member("b.json", "bbbb")]);
    const files = await openUploads([one, two], roomy);
    expect(files.entries).toEqual([
      { name: "a.json", size: 3 },
      { name: "b.json", size: 4 },
      { name: "c.json", size: 3 },
    ]);
    expect(await text(await files.open("b.json"))).toBe("bbbb");
    expect(await text(await files.open("a.json"))).toBe("aaa");
    expect(await text(await files.open("c.json"))).toBe("ccc");

    const plain = { path: writeFile("plain.json", "{}"), name: "plain.json" };
    await expect(openUploads([one, plain], roomy)).rejects.toMatchObject({ code: "unknown-source" });
    await expect(openUploads([plain, plain], roomy)).rejects.toMatchObject({ code: "unknown-source" });
  });

  it("ZIP64 entries", async () => {
    const small = Buffer.from("small");
    const big = Buffer.from("zip64 content");
    const name = Buffer.from("big.json");
    const first = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0x21), u32(crc32(small)), u32(5), u32(5),
      u16(5), u16(0), Buffer.from("a.txt"), small,
    ]);
    const localExtra = Buffer.concat([u16(1), u16(16), u64(big.length), u64(big.length)]);
    const second = Buffer.concat([
      u32(0x04034b50), u16(45), u16(0), u16(0), u16(0), u16(0x21), u32(crc32(big)), u32(0xffffffff), u32(0xffffffff),
      u16(name.length), u16(localExtra.length), name, localExtra, big,
    ]);
    const centralExtra = Buffer.concat([u16(1), u16(24), u64(big.length), u64(big.length), u64(first.length)]);
    const directory = Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0x21), u32(crc32(small)), u32(5), u32(5),
      u16(5), u16(0), u16(0), u16(0), u16(0), u32(0), u32(0), Buffer.from("a.txt"),
      u32(0x02014b50), u16(45), u16(45), u16(0), u16(0), u16(0), u16(0x21), u32(crc32(big)), u32(0xffffffff),
      u32(0xffffffff), u16(name.length), u16(centralExtra.length), u16(0), u16(0), u16(0), u32(0), u32(0xffffffff),
      name, centralExtra,
    ]);
    const directoryOffset = first.length + second.length;
    const record = Buffer.concat([
      u32(0x06064b50), u64(44), u16(45), u16(45), u32(0), u32(0), u64(2), u64(2), u64(directory.length),
      u64(directoryOffset),
    ]);
    const locator = Buffer.concat([u32(0x07064b50), u32(0), u64(directoryOffset + directory.length), u32(1)]);
    const end = Buffer.concat([
      u32(0x06054b50), u16(0), u16(0), u16(0xffff), u16(0xffff), u32(0xffffffff), u32(0xffffffff), u16(0),
    ]);
    const path = writeFile("zip64.zip", Buffer.concat([first, second, directory, record, locator, end]));

    const files = await openUploads([{ path, name: "zip64.zip" }], roomy);
    expect(files.entries).toEqual([
      { name: "a.txt", size: 5 },
      { name: "big.json", size: big.length },
    ]);
    expect(await text(await files.open("big.json"))).toBe("zip64 content");
    expect(await text(await files.open("a.txt"))).toBe("small");
  });

  it("total limits", async () => {
    const zip = part("total.zip", [member("a.json", "x".repeat(600)), member("b.json", "y".repeat(600))]);
    const size = statSync(zip.path).size;
    await expect(openUploads([zip], { ...roomy, uploadBytes: size - 1 })).rejects.toMatchObject({ code: "upload-too-large" });
    await expect(openUploads([zip], { ...roomy, entries: 1 })).rejects.toMatchObject({ code: "too-many-files" });
    await expect(openUploads([zip], { ...roomy, extractedBytes: 1000 })).rejects.toMatchObject({ code: "too-much-data" });
    await expect(openUploads([zip], roomy)).resolves.toBeTruthy();
  });

  it("member limits", async () => {
    const json = part("json.zip", [member("big.json", "x".repeat(100))]);
    await expect(openUploads([json], { ...roomy, jsonMemberBytes: 50 })).rejects.toMatchObject({ code: "too-much-data" });
    const other = part("other.zip", [member("big.bin", "x".repeat(100))]);
    await expect(openUploads([other], { ...roomy, otherMemberBytes: 50 })).rejects.toMatchObject({ code: "too-much-data" });

    const upper = part("upper.zip", [member("BIG.JSON", "x".repeat(100))]);
    await expect(openUploads([upper], { ...roomy, otherMemberBytes: 50 })).resolves.toBeTruthy();

    const single = writeFile("single.json", "x".repeat(100));
    await expect(openUploads([{ path: single, name: "single.json" }], { ...roomy, jsonMemberBytes: 50 }))
      .rejects.toMatchObject({ code: "too-much-data" });
  });

  it("zip bomb", async () => {
    const bomb = part("bomb.zip", [{ name: "zeros.json", data: Buffer.alloc(2 * MIB) }]);
    await expect(openUploads([bomb], roomy)).rejects.toMatchObject({ code: "unsafe-archive" });

    const liar = part("liar.zip", [{ name: "lie.txt", data: Buffer.alloc(5000, 97), declaredSize: 10 }]);
    const files = await openUploads([liar], roomy);
    await expect(text(await files.open("lie.txt"))).rejects.toMatchObject({ code: "unsafe-archive" });

    const short = part("short.zip", [{ name: "short.txt", data: Buffer.alloc(50, 97), declaredSize: 80 }]);
    const shortFiles = await openUploads([short], roomy);
    await expect(text(await shortFiles.open("short.txt"))).rejects.toMatchObject({ code: "unsafe-archive" });
  });

  it("unsafe paths", async () => {
    const symlink: Member = {
      name: "link",
      data: Buffer.from("target"),
      madeBy: (3 << 8) | 20,
      attributes: (0o120777 << 16) >>> 0,
    };
    const cases: Array<Array<{ path: string; name: string }>> = [
      [part("absolute.zip", [member("/etc/passwd", "x")])],
      [part("dotdot.zip", [member("a/../b.json", "x")])],
      [part("symlink.zip", [member("ok.json", "{}"), symlink])],
      [part("duplicate.zip", [member("a.json", "1"), member("a.json", "2")])],
      [part("case.zip", [member("A.json", "1"), member("a.json", "2")])],
      [part("one.zip", [member("same.json", "1")]), part("two.zip", [member("same.json", "2")])],
    ];
    for (const parts of cases) {
      await expect(openUploads(parts, roomy)).rejects.toMatchObject({ code: "unsafe-archive" });
    }
  });
});

describe("createUploadStore", () => {
  it("upload store", async () => {
    const dir = join(scratch, "uploads");
    const store = createUploadStore(dir);

    const saved = await store.save(Readable.from([Buffer.from("hello "), Buffer.from("world")]), "../a/export.zip");
    expect(saved.name).toBe("export.zip");
    expect(saved.bytes).toBe(11);
    expect(statSync(saved.path).mode & 0o777).toBe(0o600);
    expect(store.get(saved.id)).toEqual(saved);
    const read = await openUploads([{ path: saved.path, name: saved.name }], roomy);
    expect(await text(await read.open("export.zip"))).toBe("hello world");

    expect(store.get("not-an-id")).toBeNull();
    expect(store.get("../../etc")).toBeNull();
    expect(store.get("00000000-0000-4000-8000-000000000000")).toBeNull();
    store.remove("../uploads");
    expect(readdirSync(dir)).toEqual([saved.id]);

    store.remove(saved.id);
    expect(store.get(saved.id)).toBeNull();
    expect(readdirSync(dir)).toEqual([]);

    await expect(store.save(Readable.from([Buffer.alloc(20)]), "big.zip", 10)).rejects.toMatchObject({ code: "upload-too-large" });
    expect(readdirSync(dir)).toEqual([]);

    const old = await store.save(Readable.from([Buffer.from("old")]), "old.json");
    const now = old.at + 10_000;
    expect(store.sweep(60_000, now)).toBe(0);
    expect(store.get(old.id)).not.toBeNull();
    expect(store.sweep(5_000, now)).toBe(1);
    expect(store.get(old.id)).toBeNull();
    expect(createUploadStore(join(scratch, "missing")).sweep(0)).toBe(0);
  });
});
