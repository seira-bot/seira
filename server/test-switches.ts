// One shared way to accept a SEIRA_TEST_* switch. A switch takes effect only on a start that the test fixture made:
// under Vitest, or in a server that the e2e launcher (scripts/control-seira.ts) started with the sealed-path marker.
// A normal start ignores every switch, even when the variable is in its environment.

const SWITCH = /^SEIRA_TEST_[A-Z0-9_]+$/;

/** True for a start that the test fixture made. The e2e launcher sets SEIRA_TEST_SEALED_PATH; Vitest sets VITEST. */
export function fixtureStart(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VITEST === "true" || env.SEIRA_TEST_SEALED_PATH === "1";
}

/** The value of a test switch, or undefined when it is not set or when this start did not come from the fixture. */
export function testSwitch(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!SWITCH.test(name)) throw new Error(`Not a test switch name: ${name}`);
  return fixtureStart(env) ? env[name] : undefined;
}

/** True when a test switch is "1" on a start that the test fixture made. */
export function testSwitchOn(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return testSwitch(name, env) === "1";
}
