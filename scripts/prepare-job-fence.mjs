// Build seira-job-fence.exe, the Windows helper that keeps bot work under the bots' memory limit, from
// native/job-fence with MinGW-w64: on Windows its gcc and windres, elsewhere the x86_64-w64-mingw32- cross tools.
// --test also builds the test program the Windows CI job runs; the package never contains it.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "native", "job-fence");
export const JOB_FENCE_EXE = join(root, "dist-native", "job-fence", "win32-x64", "seira-job-fence.exe");
export const TEST_EATER_EXE = join(root, "dist-native", "job-fence", "test", "test-eater.exe");

const CFLAGS = ["-std=gnu11", "-O2", "-s", "-Wall", "-Wextra", "-Werror", "-static", "-D_WIN32_WINNT=0x0A00", "-DUNICODE", "-D_UNICODE"];

/** The tool's path: on PATH, then the folders where Windows runners and MSYS2 keep MinGW-w64. */
function findTool(name) {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  const folders = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  if (process.platform === "win32") folders.push("C:\\mingw64\\bin", "C:\\msys64\\mingw64\\bin", "C:\\msys64\\ucrt64\\bin");
  for (const folder of folders) {
    const candidate = join(folder, exe);
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function tools() {
  const prefix = process.platform === "win32" ? "" : "x86_64-w64-mingw32-";
  const gcc = findTool(`${prefix}gcc`), windres = findTool(`${prefix}windres`);
  if (!gcc || !windres) throw new Error(`prepare-job-fence needs MinGW-w64 (${prefix}gcc and ${prefix}windres)`);
  return { gcc, windres };
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}

export function buildJobFence({ test = false } = {}) {
  const { gcc, windres } = tools();
  mkdirSync(dirname(JOB_FENCE_EXE), { recursive: true });
  const resource = join(dirname(JOB_FENCE_EXE), "job-fence.res.o");
  run(windres, ["-O", "coff", "-i", join(source, "job-fence.rc"), "-o", resource]);
  run(gcc, [...CFLAGS, "-municode", "-o", JOB_FENCE_EXE, join(source, "job-fence.c"), resource]);
  if (test) {
    mkdirSync(dirname(TEST_EATER_EXE), { recursive: true });
    run(gcc, [...CFLAGS, "-o", TEST_EATER_EXE, join(source, "test-eater.c")]);
  }
  return JOB_FENCE_EXE;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const built = buildJobFence({ test: process.argv.includes("--test") });
  console.log(`built ${built}`);
}
