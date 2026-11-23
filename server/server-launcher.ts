import "../electron/legacy-env-boot.mjs";
// Container entry: restarts the server in place on RESTART_EXIT_CODE, so a restart the server asks for keeps the container.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { boxMemory, heapSizeArgs, type BoxMemory } from "./box-memory.ts";
import { containerInit, execUnderInit, UNDER_IMAGE_INIT } from "./container-init.ts";
import { createContainerTunnel } from "./container-tunnel.ts";
import { clearRecordsFromEarlierRunOfThisContainer } from "./data-dir-lease.ts";
import { restartLine, restartPolicy } from "./restart.ts";

/** The server's heap sized to the container's memory limit, run through the bootstrap that keeps Node's compile cache on
 * the data volume, so a restarted container reuses the compiled bundle. */
export function serverCommand(here: string, env: NodeJS.ProcessEnv, options: { exists?: (path: string) => boolean; box?: BoxMemory } = {}) {
  const bootstrap = join(here, "desktop-entry.mjs");
  const cached = (options.exists ?? existsSync)(bootstrap);
  const dataDir = env.SEIRA_DATA_DIR || join(homedir(), ".seira");
  return {
    args: [...heapSizeArgs((options.box ?? boxMemory()).cgroupLimit, env.NODE_OPTIONS), cached ? bootstrap : join(here, "index.js")],
    env: cached ? { ...env, SEIRA_SERVER_COMPILE_CACHE: join(dataDir, "cache", "node-compile") } : env,
  };
}

export interface SupervisorHooks {
  /** Awaited before each start. */
  prepare?: () => Promise<void>;
  spawned?: (child: ChildProcess) => void;
  /** Awaited when the server is about to be stopped, and after it exits, before it starts again. */
  release?: () => Promise<void>;
}

export function superviseServer(start: () => ChildProcess, options: { signals?: Pick<NodeJS.Process, "on" | "off">; now?: () => number } & SupervisorHooks = {}): Promise<number> {
  const signals = options.signals ?? process, now = options.now ?? Date.now;
  return new Promise((done) => {
    let child: ChildProcess, stopping = false, preparing = false, waiting: ReturnType<typeof setTimeout> | undefined;
    const policy = restartPolicy(now);
    const finish = (code: number) => { signals.off("SIGTERM", onTerm); signals.off("SIGINT", onInt); done(code); };
    // Stopped while waiting to start again after a crash: there is no server to pass the signal to.
    const pass = (signal: NodeJS.Signals) => () => { stopping = true; if (waiting) { clearTimeout(waiting); waiting = undefined; finish(0); } else if (!preparing) { if (options.release) void options.release().finally(() => child.kill(signal)); else child.kill(signal); } };
    const onTerm = pass("SIGTERM"), onInt = pass("SIGINT");
    const go = () => {
      preparing = false;
      if (stopping) { if (options.release) void options.release().then(() => finish(0), () => finish(0)); else finish(0); return; }
      child = start();
      options.spawned?.(child);
      child.once("error", () => finish(1));
      child.once("exit", (code, signal) => {
        const settle = () => {
          if (policy.again(code, stopping, signal)) {
            console.log(restartLine(code, policy.delayMs()));
            if (policy.delayMs() > 0) waiting = setTimeout(run, policy.delayMs());
            else run();
            return;
          }
          finish(code ?? (stopping && (signal === "SIGTERM" || signal === "SIGINT") ? 0 : 1));
        };
        if (options.release) void options.release().then(settle, settle);
        else settle();
      });
    };
    const run = () => {
      waiting = undefined;
      if (!options.prepare) { go(); return; }
      preparing = true;
      void options.prepare().then(go, go);
    };
    signals.on("SIGTERM", onTerm);
    signals.on("SIGINT", onInt);
    run();
  });
}

/** Node names the entry by its real path, so compare real paths (a macOS temp folder is reached through a link). */
function isEntry(): boolean {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]!))).href; } catch { return false; }
}

if (isEntry()) {
  // First, before anything this run would do twice: as process 1, hand that place to the image's tini.
  const init = containerInit();
  if (init.line) console.warn(init.line);
  if (init.exec) execUnderInit(init.exec);
  delete process.env[UNDER_IMAGE_INIT];
  const dataDir = process.env.SEIRA_DATA_DIR || join(homedir(), ".seira");
  try {
    // A container starts with nothing of its own running: a lease its earlier run left is a dead server's.
    for (const { path, pid } of clearRecordsFromEarlierRunOfThisContainer(dataDir)) console.log(`Removed ${path}, left by this container's server (process ${pid}) when it stopped without closing.`);
  } catch (error) {
    console.warn(`The data folder's lease could not be checked: ${error instanceof Error ? error.message : String(error)}`);
  }
  const server = serverCommand(dirname(fileURLToPath(import.meta.url)), process.env);
  const tunnel = process.env.SEIRA_ACCESS === "tunnel" ? createContainerTunnel({ dataDir, port: Number(process.env.SEIRA_PORT) || 8799, log: (line) => console.log(line) }) : null;
  let tunnelEnv: Record<string, string> = {};
  void superviseServer(() => spawn(process.execPath, server.args, { stdio: "inherit", env: { ...server.env, ...tunnelEnv } }), tunnel ? {
    prepare: async () => { tunnelEnv = {}; tunnelEnv = await tunnel.prepare(); },
    spawned: (child) => { if (child.pid) void tunnel.attach(child.pid); },
    release: () => tunnel.release(),
  } : {}).then((code) => { process.exitCode = code; });
}
