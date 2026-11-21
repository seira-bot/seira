import { parentPort, workerData } from "node:worker_threads";

import { runReadPass, type ReadPassParams } from "./read-pass.ts";

const controller = new AbortController();
parentPort?.on("message", (message: unknown) => {
  if (message === "cancel") controller.abort();
});
try {
  await runReadPass(workerData as ReadPassParams, (message) => parentPort?.postMessage(message), controller.signal);
} catch {
  parentPort?.postMessage({ type: "error", code: "worker-failed" });
}
