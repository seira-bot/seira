import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "vite";
import { expect, it, vi } from "vitest";
import viteConfig from "../vite.config.ts";

const OUTPUT_DIRS = ["build", "dist", "dist-companion", "dist-electron", "dist-native", "dist-server", "release", "electron/resources"];
const STAGED_BINARY = "cloudflared/.win32-x64-stage/cloudflared.exe";
const SOURCE_FILE = "src/lib/deep/deeper/app.ts";

function writeTree(root: string, files: readonly string[]) {
  for (const file of files) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), "");
  }
}

it("watches no file inside the build and packager output folders", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "vite-watch-"));
  writeTree(root, [...OUTPUT_DIRS.map((dir) => `${dir}/${STAGED_BINARY}`), SOURCE_FILE]);
  const server = await createServer({
    configFile: false,
    root,
    logLevel: "silent",
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, ws: false, watch: viteConfig.server?.watch },
  });
  try {
    const watchedPaths = () =>
      Object.entries(server.watcher.getWatched()).flatMap(([dir, names]) =>
        names.map((name) => path.relative(root, path.join(dir, name)).split(path.sep).join("/")),
      );

    await vi.waitFor(() => expect(watchedPaths()).toContain(SOURCE_FILE));

    expect(watchedPaths().filter((watched) => OUTPUT_DIRS.some((dir) => watched.startsWith(`${dir}/`)))).toEqual([]);
  } finally {
    await server.close();
  }
});
