/** The old cloud computer service is retired: BOX_TOKEN is never read, so it can no longer turn that service on.
 * Says so once per process, and never prints the value. */
let warned = false;

export function warnBoatEnvIgnored(env: NodeJS.ProcessEnv = process.env): void {
  if (env.BOX_TOKEN === undefined || warned) return;
  warned = true;
  console.warn("config: BOX_TOKEN is ignored: that service has been retired. Choose a VPS or a Local VM for a bot's computer.");
}

/** Test hook: forget that the notice was already logged. */
export function resetBoatEnvWarningForTest(): void { warned = false; }
