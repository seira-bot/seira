import { describe, expect, it } from "vitest";

import { check, feedFiles, isFeed, judgeAssets, parseArgs, repoFromRemote, sumsFiles, upload, uploadOrder } from "./release-assets.mjs";

const FEED = "version: 1.0.0\nfiles:\n  - url: Seira-1.0.0-setup.exe\n    sha512: abc\n    size: 100\n  - url: Seira-1.0.0-setup.exe.blockmap\n    sha512: def\n    size: 5\npath: Seira-1.0.0-setup.exe\nsha512: abc\n";
const SUMS = `${"a".repeat(64)}  Seira-1.0.0-setup.exe\n${"b".repeat(64)} *Seira-setup.exe\n`;

type Asset = { id: number; name: string; size: number; state: string };
const asset = (name: string, size = 1, state = "uploaded", id = 0): Asset => ({ id: id || name.length * 7 + size, name, size, state });
const good = () => [asset("Seira-1.0.0-setup.exe", 100), asset("Seira-1.0.0-setup.exe.blockmap", 5), asset("Seira-setup.exe", 100), asset("latest.yml", 90), asset("SHA256SUMS-windows-x64.txt", 80)];

function fakeApi(assets: Asset[], contents: Record<string, string>, release: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const api = async (path: string, options?: { raw?: boolean }) => {
    calls.push(path);
    if (path.startsWith("repos/o/r/releases?")) return [{ id: 5, tag_name: "v0.9.0" }, { id: 7, tag_name: "v1.0.0", ...release }];
    if (path.startsWith("repos/o/r/releases/7/assets")) return assets;
    const match = /releases\/assets\/(\d+)$/.exec(path);
    if (match && options?.raw) {
      const name = assets.find((item) => item.id === Number(match[1]))!.name;
      return contents[name] ?? (name.startsWith("SHA256SUMS") ? SUMS : "");
    }
    throw new Error(`unexpected ${path}`);
  };
  return { api, calls };
}

const logger = () => {
  const lines: string[] = [];
  return { lines, log: (text: string) => lines.push(text) };
};

describe("parseArgs", () => {
  it("reads check and upload", () => {
    expect(parseArgs(["check", "v1.0.0"])).toMatchObject({ command: "check", tag: "v1.0.0" });
    expect(parseArgs(["upload", "v1.0.0", "a", "latest.yml", "--repo", "o/r"])).toMatchObject({ command: "upload", files: ["a", "latest.yml"], repo: "o/r" });
    expect(parseArgs(["--help"]).help).toBe(true);
  });

  it.each([
    [[]],
    [["check"]],
    [["check", "1.0.0"]],
    [["check", "v1.0.0", "file"]],
    [["upload", "v1.0.0"]],
    [["publish", "v1.0.0"]],
    [["check", "v1.0.0", "--repo"]],
    [["check", "v1.0.0", "--repo", "bad"]],
    [["check", "v1.0.0", "--nope"]],
  ])("gives exit 2 for %j", (argv) => {
    expect(() => parseArgs(argv)).toThrowError(expect.objectContaining({ exitCode: 2 }));
  });

  it("reads the repository from a remote", () => {
    expect(repoFromRemote("git@github.com:o/r.git")).toBe("o/r");
    expect(repoFromRemote("https://example.test/o/r")).toBeNull();
  });
});

describe("feeds and checksum files", () => {
  it("knows a feed by its name", () => {
    for (const name of ["latest.yml", "latest-linux.yml", "latest-mac.yml", "dir/latest.yml"]) expect(isFeed(name)).toBe(true);
    for (const name of ["latest.yml.blockmap", "Seira-latest.yml", "latest.txt"]) expect(isFeed(name)).toBe(false);
  });

  it("reads the files and the sizes of a feed, and its path", () => {
    expect(feedFiles(FEED)).toEqual([
      { name: "Seira-1.0.0-setup.exe", size: 100 },
      { name: "Seira-1.0.0-setup.exe.blockmap", size: 5 },
    ]);
    expect(feedFiles("version: 1\npath: only.exe\n")).toEqual([{ name: "only.exe", size: undefined }]);
  });

  it("reads the names of a checksum file", () => {
    expect(sumsFiles(SUMS)).toEqual(["Seira-1.0.0-setup.exe", "Seira-setup.exe"]);
  });
});

describe("judgeAssets", () => {
  const texts = { "latest.yml": FEED, "SHA256SUMS-windows-x64.txt": SUMS };

  it("finds no problem when every named file is an uploaded asset of the same size", () => {
    expect(judgeAssets({ assets: good(), texts })).toEqual([]);
  });

  it("names a file that a feed names and the release does not have", () => {
    const assets = good().filter((item) => item.name !== "Seira-1.0.0-setup.exe");
    const problems = judgeAssets({ assets, texts: { "latest.yml": FEED } });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("Seira-1.0.0-setup.exe");
  });

  it("names a file with another size than the feed", () => {
    const assets = good().map((item) => (item.name === "Seira-1.0.0-setup.exe" ? { ...item, size: 99 } : item));
    const problems = judgeAssets({ assets, texts: { "latest.yml": FEED } });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("size 100");
    expect(problems[0]).toContain("size 99");
  });

  it("does not count an asset that is not uploaded", () => {
    const assets = good().map((item) => (item.name === "Seira-1.0.0-setup.exe" ? { ...item, state: "starter" } : item));
    const problems = judgeAssets({ assets, texts: { "latest.yml": FEED } });
    expect(problems.some((text) => text.includes("starter"))).toBe(true);
    expect(problems.some((text) => text.includes("names Seira-1.0.0-setup.exe"))).toBe(true);
  });

  it("names a file that a checksum file names and the release does not have", () => {
    const assets = good().filter((item) => item.name !== "Seira-setup.exe");
    const problems = judgeAssets({ assets, texts: { "SHA256SUMS-windows-x64.txt": SUMS } });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("SHA256SUMS-windows-x64.txt names Seira-setup.exe");
  });

  it("fails a feed that names no file", () => {
    expect(judgeAssets({ assets: good(), texts: { "latest.yml": "version: 1\n" } })[0]).toContain("names no file");
  });
});

describe("check", () => {
  it("exits 0 when every named file is there", async () => {
    const { api } = fakeApi(good(), { "latest.yml": FEED, "SHA256SUMS-windows-x64.txt": SUMS });
    const { lines, log } = logger();
    expect(await check({ api, repo: "o/r", tag: "v1.0.0", log })).toBe(0);
    expect(lines.every((line) => !line.startsWith("FAIL"))).toBe(true);
  });

  it("finds a draft release by listing, not by the tag endpoint", async () => {
    const { api, calls } = fakeApi(good(), { "latest.yml": FEED }, { draft: true });
    const { lines, log } = logger();
    expect(await check({ api, repo: "o/r", tag: "v1.0.0", log })).toBe(0);
    expect(calls.some((path) => path.includes("releases/tags/"))).toBe(false);
    expect(lines.join("\n")).toContain("draft");
  });

  it("exits 1 and prints the file when the installer is missing", async () => {
    const assets = good().filter((item) => item.name !== "Seira-1.0.0-setup.exe");
    const { api } = fakeApi(assets, { "latest.yml": FEED });
    const { lines, log } = logger();
    expect(await check({ api, repo: "o/r", tag: "v1.0.0", log })).toBe(1);
    expect(lines.join("\n")).toContain("FAIL latest.yml names Seira-1.0.0-setup.exe");
  });

  it("exits 1 for a size that differs", async () => {
    const assets = good().map((item) => (item.name === "Seira-1.0.0-setup.exe" ? { ...item, size: 50 } : item));
    const { api } = fakeApi(assets, { "latest.yml": FEED });
    expect(await check({ api, repo: "o/r", tag: "v1.0.0", log: () => {} })).toBe(1);
  });

  it("exits 1 for an asset that is still uploading", async () => {
    const assets = good().map((item) => (item.name === "Seira-1.0.0-setup.exe" ? { ...item, state: "starter" } : item));
    const { api } = fakeApi(assets, { "latest.yml": FEED });
    expect(await check({ api, repo: "o/r", tag: "v1.0.0", log: () => {} })).toBe(1);
  });

  it("exits 1 for a checksum file that names a missing file", async () => {
    const assets = good().filter((item) => item.name !== "Seira-setup.exe");
    const { api } = fakeApi(assets, { "SHA256SUMS-windows-x64.txt": SUMS });
    const { lines, log } = logger();
    expect(await check({ api, repo: "o/r", tag: "v1.0.0", log })).toBe(1);
    expect(lines.join("\n")).toContain("Seira-setup.exe");
  });

  it("exits 1 when the release does not exist", async () => {
    const { api } = fakeApi(good(), {});
    expect(await check({ api, repo: "o/r", tag: "v2.0.0", log: () => {} })).toBe(1);
  });
});

describe("uploadOrder", () => {
  it("puts the feeds last and keeps the given order", () => {
    expect(uploadOrder(["latest.yml", "a.exe", "latest-linux.yml", "b.txt"])).toEqual({ first: ["a.exe", "b.txt"], last: ["latest.yml", "latest-linux.yml"] });
  });
});

describe("upload", () => {
  const files = ["latest.yml", "dist/Seira-1.0.0-setup.exe", "dist/Seira-1.0.0-setup.exe.blockmap", "Seira-setup.exe", "SHA256SUMS-windows-x64.txt"];
  const exists = () => true;

  function harness(options: { failOn?: string; stage?: () => Asset[] } = {}) {
    const uploaded: string[] = [];
    const contents = { "latest.yml": FEED, "SHA256SUMS-windows-x64.txt": SUMS };
    const run = async (args: string[]) => {
      if (args[3] === options.failOn) throw new Error("network down");
      uploaded.push(args[3]);
    };
    let checks = 0;
    const api = async (path: string, opts?: { raw?: boolean }) => {
      if (path.includes("/assets?")) {
        checks++;
        return (options.stage ?? good)();
      }
      return fakeApi(good(), contents).api(path, opts);
    };
    return { uploaded, run, api, checks: () => checks };
  }

  it("uploads each file one at a time, feeds last, and checks twice", async () => {
    const h = harness();
    const status = await upload({ api: h.api, run: h.run, repo: "o/r", tag: "v1.0.0", files, log: () => {}, exists });
    expect(status).toBe(0);
    expect(h.uploaded).toEqual(["dist/Seira-1.0.0-setup.exe", "dist/Seira-1.0.0-setup.exe.blockmap", "Seira-setup.exe", "SHA256SUMS-windows-x64.txt", "latest.yml"]);
    expect(h.checks()).toBe(2);
  });

  it("uploads no feed when a file that is not a feed fails", async () => {
    const h = harness({ failOn: "Seira-setup.exe" });
    const status = await upload({ api: h.api, run: h.run, repo: "o/r", tag: "v1.0.0", files, log: () => {}, exists });
    expect(status).toBe(1);
    expect(h.uploaded).not.toContain("latest.yml");
    expect(h.uploaded).not.toContain("SHA256SUMS-windows-x64.txt");
    expect(h.checks()).toBe(0);
  });

  it("uploads no feed when the first check fails", async () => {
    const h = harness({ stage: () => good().filter((item) => item.name !== "Seira-setup.exe") });
    const status = await upload({ api: h.api, run: h.run, repo: "o/r", tag: "v1.0.0", files, log: () => {}, exists });
    expect(status).toBe(1);
    expect(h.uploaded).not.toContain("latest.yml");
  });

  it("returns the status of the second check", async () => {
    let calls = 0;
    const h = harness({ stage: () => (++calls === 1 ? good() : good().filter((item) => item.name !== "Seira-setup.exe")) });
    expect(await upload({ api: h.api, run: h.run, repo: "o/r", tag: "v1.0.0", files, log: () => {}, exists })).toBe(1);
    expect(h.uploaded).toContain("latest.yml");
  });

  it("stops with status 1 when a feed upload fails", async () => {
    const h = harness({ failOn: "latest.yml" });
    expect(await upload({ api: h.api, run: h.run, repo: "o/r", tag: "v1.0.0", files, log: () => {}, exists })).toBe(1);
  });

  it("rejects a file that does not exist before it uploads anything", async () => {
    const h = harness();
    const { lines, log } = logger();
    const status = await upload({ api: h.api, run: h.run, repo: "o/r", tag: "v1.0.0", files, log, exists: (file: string) => file !== "Seira-setup.exe" });
    expect(status).toBe(2);
    expect(h.uploaded).toEqual([]);
    expect(lines.join("\n")).toContain("Seira-setup.exe does not exist");
  });
});
