export function postToServer(proc, message, what, log) {
  try {
    proc.postMessage(message);
  } catch (error) {
    log(`${what} failed: ${error?.message ?? error}`);
  }
}
