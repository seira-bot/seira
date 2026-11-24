import { expect, it } from "vitest";
import { loopbackAllowed } from "./host/linked-servers-egress.ts";
import { fixtureStart, testSwitch, testSwitchOn } from "./test-switches.ts";

const production = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ PATH: "/usr/bin", ...extra });
const fixture = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ SEIRA_TEST_SEALED_PATH: "1", ...extra });

it("sees a start as a fixture start only under Vitest or the e2e launcher's marker", () => {
  expect(fixtureStart(production())).toBe(false);
  expect(fixtureStart(production({ SEIRA_TEST_SEALED_PATH: "0" }))).toBe(false);
  expect(fixtureStart(production({ VITEST: "false" }))).toBe(false);
  expect(fixtureStart(fixture())).toBe(true);
  expect(fixtureStart(production({ VITEST: "true" }))).toBe(true);
});

it("ignores a test switch on a normal start", () => {
  expect(testSwitch("SEIRA_TEST_ANY", production({ SEIRA_TEST_ANY: "1" }))).toBeUndefined();
  expect(testSwitchOn("SEIRA_TEST_ANY", production({ SEIRA_TEST_ANY: "1" }))).toBe(false);
});

it("accepts a test switch from the fixture, and only the value 1 turns a switch on", () => {
  expect(testSwitch("SEIRA_TEST_ANY", fixture({ SEIRA_TEST_ANY: "abc" }))).toBe("abc");
  expect(testSwitchOn("SEIRA_TEST_ANY", fixture({ SEIRA_TEST_ANY: "1" }))).toBe(true);
  expect(testSwitchOn("SEIRA_TEST_ANY", fixture({ SEIRA_TEST_ANY: "true" }))).toBe(false);
  expect(testSwitchOn("SEIRA_TEST_ANY", fixture())).toBe(false);
});

it("refuses a name that is not a SEIRA_TEST_ switch", () => {
  expect(() => testSwitch("SEIRA_PORT", fixture())).toThrow("Not a test switch name");
  expect(() => testSwitch("seira_test_x", fixture())).toThrow("Not a test switch name");
});

it("keeps loopback closed on a normal start that has SEIRA_TEST_LINKED_LOOPBACK=1", () => {
  expect(loopbackAllowed(production({ SEIRA_TEST_LINKED_LOOPBACK: "1" }))).toBe(false);
  expect(loopbackAllowed(production())).toBe(false);
  expect(loopbackAllowed(fixture({ SEIRA_TEST_LINKED_LOOPBACK: "1" }))).toBe(true);
  expect(loopbackAllowed(fixture())).toBe(false);
});
