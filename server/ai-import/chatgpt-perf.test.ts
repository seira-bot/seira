import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { setFlagsFromString } from "node:v8";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { chatgptReader } from "./chatgpt.ts";
import { makeChatgptExport } from "./fixtures/make-chatgpt.ts";
import { folderFiles } from "./files.ts";
import { removeTempDir } from "../testing/cleanup.ts";

const MB = 1024 * 1024;
const enabled = process.env.AI_IMPORT_PERF === "1";
const sizeMb = Number(process.env.AI_IMPORT_PERF_MB ?? 1024);

describe("ChatGPT reader at size", () => {
  it("builds a synthetic export that the reader reads in full", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seira-ai-import-small-"));
    try {
      const made = await makeChatgptExport(dir, 2 * MB);
      let seen = 0;
      for await (const event of chatgptReader.read({ from: "files", files: await folderFiles(dir) }, { signal: new AbortController().signal, stagingDir: "", transcripts: true })) {
        if (event.type === "conversation") seen++;
      }
      expect(seen).toBe(made.conversations);
      expect(await chatgptReader.sniff(await folderFiles(dir))).toBe(true);
    } finally {
      removeTempDir(dir);
    }
  });

  describe.skipIf(!enabled)("AI_IMPORT_PERF=1", () => {
    let dir = "";
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "seira-ai-import-perf-"));
    });
    afterAll(() => removeTempDir(dir));

    it(`reads ${sizeMb} MB within 60 seconds and keeps heap growth at or below 512 MB`, { timeout: 600_000 }, async () => {
      setFlagsFromString("--expose-gc");
      const gc = runInNewContext("gc") as () => void;
      const made = await makeChatgptExport(dir, sizeMb * MB);
      const files = await folderFiles(dir);
      gc();
      const baseline = process.memoryUsage().heapUsed;
      let peakHeap = baseline;
      let peakRss = process.memoryUsage().rss;
      let conversations = 0;
      const started = performance.now();
      for await (const event of chatgptReader.read({ from: "files", files }, { signal: new AbortController().signal, stagingDir: "", transcripts: true })) {
        if (event.type !== "conversation") continue;
        conversations++;
        if (conversations % 100 === 0) {
          gc();
          const usage = process.memoryUsage();
          peakHeap = Math.max(peakHeap, usage.heapUsed);
          peakRss = Math.max(peakRss, usage.rss);
        }
      }
      const seconds = (performance.now() - started) / 1000;
      const growthMb = (peakHeap - baseline) / MB;
      console.log(`AI_IMPORT_PERF bytes=${made.bytes} conversations=${conversations} seconds=${seconds.toFixed(1)} heapGrowthMb=${growthMb.toFixed(1)} peakRssMb=${(peakRss / MB).toFixed(0)}`);
      expect(conversations).toBe(made.conversations);
      expect(seconds).toBeLessThanOrEqual(60);
      expect(growthMb).toBeLessThanOrEqual(512);
    });
  });
});
