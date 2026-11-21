import { describe, expect, it } from "vitest";

import { check, feedFiles, isFeed, judgeAssets, missingForPublish, parseArgs, publish, repoFromRemote, sumsFiles, upload, uploadOrder } from "./release-assets.mjs";

const FEED = "version: 1.0.0\nfiles:\n  - url: Seira-1.0.0-setup.exe\n    sha512: abc\n    size: 100\n  - url: Seira-1.0.0-setup.exe.blockmap\n    sha512: def\n    size: 5\npath: Seira-1.0.0-setup.exe\nsha512: abc\n";
const SUMS = `${"a".repeat(64)}  Seira-1.0.0-setup.exe\n${"b".repeat(64)} *Seira-setup.exe\n`;

type Asset = { id: number; name: string; size: number; state: string };
const asset = (name: string, size = 1, state = "uploaded", id = 0): Asset => ({ id: id || name.length * 7 + size, name, size, state });
const good = () => [asset("Seira-1.0.0-setup.exe", 100), asset("Seira-1.0.0-setup.exe.blockmap", 5), asset("Seira-setup.exe", 100), asset("latest.yml", 90), asset("SHA256SUMS-windows-x64.txt", 80)];

const linux = () => [asset("Seira-1.0.0-x86_64.AppImage", 300), asset("Seira-1.0.0-amd64.deb", 200), asset("latest-linux.yml", 60), asset("Seira.AppImage", 300), asset("Seira-amd64.deb", 200), asset("SHA256SUMS-linux-x64.txt", 70), asset("Seira-1.0.0-x86_64.flatpak", 250)];
const complete = () => [...linux(), ...good()];

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
    [["publish"]],
    [["publish", "v1.0.0", "file"]],
    [["check", "v1.0.0", "--repo"]],
    [["check", "v1.0.0", "--repo", "bad"]],
    [["check", "v1.0.0", "--nope"]],
  ])("gives exit 2 for %j", (argv) => {
    expect(() => parseArgs(argv)).toThrowError(expect.objectContaining({ exitCode: 2 }));
  });

  it("reads publish with a tag and no files", () => {
    expect(parseArgs(["publish", "v1.2.3"])).toMatchObject({ command: "publish", tag: "v1.2.3", files: [] });
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

describe("missingForPublish", () => {
  const names = (assets: Asset[]) => missingForPublish(assets, "v1.0.0").map((item) => item.name);

  it("names the Windows files that a Linux-only release lacks", () => {
    expect(missingForPublish(linux(), "v1.0.0")).toEqual([
      { platform: "Windows", name: "latest.yml" },
      { platform: "Windows", name: "SHA256SUMS-windows-x64.txt" },
      { platform: "Windows", name: "Seira-setup.exe" },
    ]);
  });

  it("names the Flatpak bundle of the release version when it is missing", () => {
    expect(names(complete().filter((item) => item.name !== "Seira-1.0.0-x86_64.flatpak"))).toEqual(["Seira-1.0.0-x86_64.flatpak"]);
    expect(names(complete())).toEqual([]);
  });

  it("does not count an asset that is not uploaded", () => {
    expect(names(complete().map((item) => (item.name === "latest.yml" ? { ...item, state: "starter" } : item)))).toEqual(["latest.yml"]);
  });
});

describe("publish", () => {
  const LINUX_FEED = "version: 1.0.0\nfiles:\n  - url: Seira-1.0.0-x86_64.AppImage\n    sha512: abc\n    size: 300\npath: Seira-1.0.0-x86_64.AppImage\nsha512: abc\n";
  const LINUX_SUMS = `${"a".repeat(64)}  Seira-1.0.0-x86_64.AppImage\n${"b".repeat(64)}  Seira.AppImage\n`;
  const MAC_FEED = "version: 1.0.0\nfiles:\n  - url: Seira-1.0.0-arm64.dmg\n    sha512: abc\n    size: 400\npath: Seira-1.0.0-arm64.dmg\nsha512: abc\n";
  const contents = { "latest.yml": FEED, "latest-linux.yml": LINUX_FEED, "SHA256SUMS-linux-x64.txt": LINUX_SUMS, "latest-mac.yml": MAC_FEED };

  function harness(assets: Asset[], release: Record<string, unknown> = { draft: true }, failRun = false) {
    const runs: string[][] = [];
    const run = async (args: string[]) => {
      runs.push(args);
      if (failRun) throw new Error("not allowed");
    };
    const { api } = fakeApi(assets.map((item, index) => ({ ...item, id: 1000 + index })), contents, release);
    return { runs, run, api, ...logger() };
  }
  const go = (h: ReturnType<typeof harness>) => publish({ api: h.api, run: h.run, repo: "o/r", tag: "v1.0.0", log: h.log });

  it("AC-01: refuses a draft with Linux files only, names latest.yml, and runs nothing", async () => {
    const h = harness(linux());
    expect(await go(h)).toBe(1);
    expect(h.lines).toContain("FAIL Windows: latest.yml is missing");
    expect(h.lines.join("\n")).toContain("stays a draft");
    expect(h.runs).toEqual([]);
  });

  it("AC-02: refuses a draft whose feed names a file with a wrong size, and runs nothing", async () => {
    const assets = complete().map((item) => (item.name === "Seira-1.0.0-setup.exe" ? { ...item, size: 50 } : item));
    const h = harness(assets);
    expect(await go(h)).toBe(1);
    expect(h.lines.join("\n")).toContain("FAIL latest.yml names Seira-1.0.0-setup.exe with size 100");
    expect(h.runs).toEqual([]);
  });

  it("AC-03: publishes a complete draft as latest with one gh release edit, and checks again", async () => {
    const h = harness(complete());
    expect(await go(h)).toBe(0);
    expect(h.runs).toEqual([["release", "edit", "v1.0.0", "--draft=false", "--latest", "--repo", "o/r"]]);
    expect(h.lines.some((line) => line.startsWith("FAIL"))).toBe(false);
  });

  it("AC-03: exits 1 when gh release edit fails", async () => {
    const h = harness(complete(), { draft: true }, true);
    expect(await go(h)).toBe(1);
    expect(h.lines.join("\n")).toContain("FAIL publish of v1.0.0 failed: not allowed");
  });

  it("refuses a draft without the Flatpak bundle, and runs nothing", async () => {
    const h = harness(complete().filter((item) => !item.name.endsWith(".flatpak")));
    expect(await go(h)).toBe(1);
    expect(h.lines).toContain("FAIL Linux: Seira-1.0.0-x86_64.flatpak is missing");
    expect(h.runs).toEqual([]);
  });

  it("AC-04: does not require macOS files when the release has none", async () => {
    expect(missingForPublish(complete(), "v1.0.0")).toEqual([]);
  });

  it("AC-05: requires every macOS file when the release has one", async () => {
    const h = harness([...complete(), asset("Seira-1.0.0-arm64.dmg", 400)]);
    expect(await go(h)).toBe(1);
    const text = h.lines.join("\n");
    expect(text).toContain("FAIL macOS: latest-mac.yml is missing");
    expect(text).toContain("FAIL macOS: Seira-intel.dmg is missing");
    expect(h.runs).toEqual([]);
  });

  it("AC-05: publishes when all macOS files are present", async () => {
    const mac = [asset("Seira-1.0.0-arm64.dmg", 400), asset("latest-mac.yml", 70), asset("SHA256SUMS-mac.txt", 60), asset("Seira.dmg", 400), asset("Seira-intel.dmg", 410)];
    const h = harness([...complete(), ...mac]);
    expect(await go(h)).toBe(0);
    expect(h.runs).toHaveLength(1);
  });

  it("AC-06: changes nothing for a published release and exits 1 when Windows files are missing", async () => {
    const h = harness(linux(), { draft: false });
    expect(await go(h)).toBe(1);
    expect(h.lines).toContain("FAIL Windows: Seira-setup.exe is missing");
    expect(h.runs).toEqual([]);
  });

  it("AC-06: exits 0 for a published release with every file", async () => {
    const h = harness(complete(), { draft: false });
    expect(await go(h)).toBe(0);
    expect(h.runs).toEqual([]);
  });

  it("exits 1 when the release does not exist", async () => {
    const h = harness(complete());
    expect(await publish({ api: h.api, run: h.run, repo: "o/r", tag: "v2.0.0", log: h.log })).toBe(1);
    expect(h.runs).toEqual([]);
  });
});
