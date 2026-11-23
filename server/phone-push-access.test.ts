import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ENROLL_RETRY_MAX_MS,
  ENROLL_RETRY_MIN_MS,
  PUSH_RELAY_FILE,
  PhonePushAccessSource,
  ROTATE_BEFORE_MS,
  pushRelayOrigin,
  type PhonePushAccessOptions,
} from "./phone-push-access.ts";

const DAY = 24 * 60 * 60_000;
const RELAY = "https://push.seira.bot";
const credentialOf = (n: number) => `seira_install_${String(n).padStart(22, "a")}.${String(n).padStart(43, "b")}`;

interface Call { url: string; authorization: string | null; origin: string | null; body: string | undefined; redirect: string | undefined }
type Answer = { status: number; body?: unknown; retryAfter?: number } | "unreachable";

let dataDir: string;
let clock: number;
let calls: Call[];
let answers: Answer[];
let logs: string[];
let issued: number;

const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const headers = new Headers(init?.headers);
  calls.push({ url, authorization: headers.get("authorization"), origin: headers.get("origin"), body: init?.body === undefined ? undefined : String(init.body), redirect: init?.redirect });
  const answer = answers.shift() ?? defaultAnswer(url);
  if (answer === "unreachable") throw new TypeError("fetch failed");
  return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
    status: answer.status,
    headers: answer.retryAfter ? { "retry-after": String(answer.retryAfter) } : {},
  });
}) as typeof fetch;

function defaultAnswer(url: string): Answer {
  issued += 1;
  if (url.endsWith("/v1/push/enroll")) return { status: 201, body: { installationId: `inst_${issued}`, credential: credentialOf(issued), expiresAt: clock + 90 * DAY } };
  return { status: 200, body: { credential: credentialOf(issued), expiresAt: clock + 90 * DAY } };
}

const source = (options: Partial<PhonePushAccessOptions> = {}) =>
  new PhonePushAccessSource({ dataDir, env: {}, fetchImpl, now: () => clock, log: (line) => logs.push(line), ...options });
const file = () => join(dataDir, PUSH_RELAY_FILE);
const saved = () => JSON.parse(readFileSync(file(), "utf8")) as Record<string, unknown>;
const paths = () => calls.map((call) => new URL(call.url).pathname);

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "seira-push-access-"));
  clock = 1_700_000_000_000;
  calls = [];
  answers = [];
  logs = [];
  issued = 0;
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

describe("the push relay's origin", () => {
  it("is Seira's relay once push is live, the override when set, and nothing for an invalid override", () => {
    expect(pushRelayOrigin({}, ["push"])).toBe(RELAY);
    expect(pushRelayOrigin({}, [])).toBe("");
    expect(pushRelayOrigin({ SEIRA_PUSH_RELAY_URL: "https://relay.example.test/" }, [])).toBe("https://relay.example.test");
    expect(pushRelayOrigin({ SEIRA_PUSH_RELAY_URL: "  " }, ["push"])).toBe(RELAY);
    expect(pushRelayOrigin({ SEIRA_PUSH_RELAY_URL: "http://127.0.0.1:8787" }, ["push"])).toBe("http://127.0.0.1:8787");
    expect(pushRelayOrigin({ SEIRA_PUSH_RELAY_URL: "http://relay.example.test" }, ["push"])).toBe("");
    expect(pushRelayOrigin({ SEIRA_PUSH_RELAY_URL: "https://relay.example.test/v1/push" }, ["push"])).toBe("");
  });

  it("is Seira's relay in this build", () => {
    expect(pushRelayOrigin({})).toBe(RELAY);
  });

  it("with no origin, gives no access and never calls out", async () => {
    const access = source({ live: [] });
    await access.ensure();
    expect(access.relay).toBe("");
    expect(access.current()).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe("enrolling", () => {
  it("enrolls once with {\"v\":1} and no credential, then keeps the credential in a 0600 file", async () => {
    const access = source();
    expect(access.current()).toBeNull();
    await access.ensure();
    expect(calls).toEqual([{ url: `${RELAY}/v1/push/enroll`, authorization: null, origin: null, body: '{"v":1}', redirect: "error" }]);
    expect(access.current()).toEqual({ relay: RELAY, credential: credentialOf(1) });
    expect(saved()).toEqual({ version: 1, relay: RELAY, installationId: "inst_1", credential: credentialOf(1), expiresAt: clock + 90 * DAY });
    if (process.platform !== "win32") expect(statSync(file()).mode & 0o777).toBe(0o600);

    await access.ensure();
    expect(calls).toHaveLength(1);
  });

  it("reuses the saved credential after a restart, without a second enroll", async () => {
    await source().ensure();
    const restarted = source();
    expect(restarted.current()).toEqual({ relay: RELAY, credential: credentialOf(1) });
    await restarted.ensure();
    expect(paths()).toEqual(["/v1/push/enroll"]);
  });

  it("runs one enroll at a time", async () => {
    const access = source();
    await Promise.all([access.ensure(), access.ensure(), access.ensure()]);
    expect(paths()).toEqual(["/v1/push/enroll"]);
  });

  it("never sends a credential to another relay than the one that issued it", async () => {
    await source().ensure();
    const elsewhere = source({ env: { SEIRA_PUSH_RELAY_URL: "https://relay.example.test" } });
    expect(elsewhere.current()).toBeNull();
    await elsewhere.ensure();
    expect(calls.at(-1)).toMatchObject({ url: "https://relay.example.test/v1/push/enroll", authorization: null });
    expect(elsewhere.current()).toEqual({ relay: "https://relay.example.test", credential: credentialOf(2) });
  });

  it("enrolls again when the saved file is damaged, and says so without its content", async () => {
    writeFileSync(file(), JSON.stringify({ version: 1, relay: RELAY, installationId: "x", credential: "seira_install_short", expiresAt: clock + DAY }));
    const access = source();
    expect(access.current()).toBeNull();
    expect(logs).toEqual(["[phone-push] the saved push relay credential could not be read; this computer enrolls again"]);
    await access.ensure();
    expect(paths()).toEqual(["/v1/push/enroll"]);
  });

  it("enrolls again once the saved credential has expired", async () => {
    await source().ensure();
    clock += 90 * DAY + 1;
    const access = source();
    expect(access.current()).toBeNull();
    await access.ensure();
    expect(paths()).toEqual(["/v1/push/enroll", "/v1/push/enroll"]);
  });

  it("takes no credential the relay did not shape as one", async () => {
    answers.push({ status: 201, body: { installationId: "inst_x", credential: "not-a-credential", expiresAt: clock + DAY } });
    const access = source();
    await access.ensure();
    expect(access.current()).toBeNull();
    expect(() => readFileSync(file())).toThrow();
  });
});

describe("waiting after a failed enroll", () => {
  it("backs off from a minute, doubling, up to six hours", async () => {
    const access = source();
    const waits: number[] = [];
    for (let i = 0; i < 12; i++) {
      answers.push({ status: 503, body: { error: "push_unavailable" } });
      const before = calls.length;
      await access.ensure();
      expect(calls.length).toBe(before + 1);
      const wait = Number(/next try in (\d+) min/.exec(logs.at(-1)!)![1]) * 60_000;
      waits.push(wait);
      clock += wait - 1;
      await access.ensure();
      expect(calls.length).toBe(before + 1);
      clock += 1;
    }
    expect(waits.slice(0, 4)).toEqual([ENROLL_RETRY_MIN_MS, 2 * ENROLL_RETRY_MIN_MS, 4 * ENROLL_RETRY_MIN_MS, 8 * ENROLL_RETRY_MIN_MS]);
    expect(waits.at(-1)).toBe(ENROLL_RETRY_MAX_MS);
    expect(logs.at(-1)).toBe("[phone-push] push relay enroll failed (503 push_unavailable); next try in 360 min");
  });

  it("honours Retry-After, never less than a minute nor more than a day", async () => {
    const access = source();
    answers.push({ status: 429, body: { error: "rate_limited" }, retryAfter: 600 });
    await access.ensure();
    clock += 599_000;
    await access.ensure();
    expect(calls).toHaveLength(1);
    clock += 1_000;
    answers.push({ status: 429, body: { error: "rate_limited" }, retryAfter: 1 });
    await access.ensure();
    clock += ENROLL_RETRY_MIN_MS - 1;
    await access.ensure();
    expect(calls).toHaveLength(2);
    clock += 1;
    answers.push({ status: 429, body: { error: "rate_limited" }, retryAfter: 7 * 24 * 3600 });
    await access.ensure();
    expect(logs.at(-1)).toBe("[phone-push] push relay enroll failed (429 rate_limited); next try in 1440 min");
  });

  it("waits the same way when the relay cannot be reached, and starts over after a success", async () => {
    const access = source();
    answers.push("unreachable");
    await access.ensure();
    expect(logs.at(-1)).toBe("[phone-push] push relay enroll failed (unreachable); next try in 1 min");
    clock += ENROLL_RETRY_MIN_MS;
    await access.ensure();
    expect(access.current()).not.toBeNull();
  });
});

describe("rotating", () => {
  it("leaves a credential with more than 30 days left alone, and rotates one with less", async () => {
    const access = source();
    await access.ensure();
    clock += 90 * DAY - ROTATE_BEFORE_MS - 1;
    await access.ensure();
    expect(paths()).toEqual(["/v1/push/enroll"]);
    clock += 2;
    await access.ensure();
    expect(calls.at(-1)).toEqual({ url: `${RELAY}/v1/installations/self/credentials/rotate`, authorization: `Bearer ${credentialOf(1)}`, origin: null, body: undefined, redirect: "error" });
    expect(access.current()).toEqual({ relay: RELAY, credential: credentialOf(2) });
    expect(saved()).toMatchObject({ installationId: "inst_1", credential: credentialOf(2), expiresAt: clock + 90 * DAY });
    if (process.platform !== "win32") expect(statSync(file()).mode & 0o777).toBe(0o600);
  });

  it("enrolls again when the relay refuses the credential it rotates", async () => {
    const access = source();
    await access.ensure();
    clock += 61 * DAY;
    answers.push({ status: 401, body: { error: "unauthorized" } });
    await access.ensure();
    expect(paths()).toEqual(["/v1/push/enroll", "/v1/installations/self/credentials/rotate", "/v1/push/enroll"]);
    expect(access.current()).toEqual({ relay: RELAY, credential: credentialOf(2) });
  });

  it("keeps the credential it has while a rotate fails, and tries again later", async () => {
    const access = source();
    await access.ensure();
    clock += 61 * DAY;
    answers.push({ status: 503, body: { error: "push_unavailable" } });
    await access.ensure();
    expect(access.current()).toEqual({ relay: RELAY, credential: credentialOf(1) });
    expect(logs.at(-1)).toBe("[phone-push] push relay rotate failed (503 push_unavailable); next try in 1 min");
    clock += ENROLL_RETRY_MIN_MS;
    await access.ensure();
    expect(access.current()).toEqual({ relay: RELAY, credential: credentialOf(2) });
  });
});

describe("a credential the relay refused", () => {
  it("is dropped when it is the saved one, and a new one is enrolled after the wait", async () => {
    const access = source();
    await access.ensure();
    expect(access.refused(credentialOf(9))).toBe(false);
    expect(access.current()).not.toBeNull();
    expect(access.refused(credentialOf(1))).toBe(true);
    expect(access.current()).toBeNull();
    await access.ensure();
    expect(paths()).toEqual(["/v1/push/enroll"]);
    clock += ENROLL_RETRY_MIN_MS;
    await access.ensure();
    expect(access.current()).toEqual({ relay: RELAY, credential: credentialOf(2) });
  });
});

describe("a credential from SEIRA_PUSH_CREDENTIAL", () => {
  it("is used as it is: never enrolled, rotated or dropped here", async () => {
    const access = source({ env: { SEIRA_PUSH_CREDENTIAL: credentialOf(5) } });
    expect(access.current()).toEqual({ relay: RELAY, credential: credentialOf(5) });
    await access.ensure();
    expect(access.refused(credentialOf(5))).toBe(false);
    expect(access.current()).toEqual({ relay: RELAY, credential: credentialOf(5) });
    expect(calls).toEqual([]);
  });

  it("gives no access when it is not a credential", () => {
    expect(source({ env: { SEIRA_PUSH_CREDENTIAL: "nope" } }).current()).toBeNull();
  });
});

describe("the credential in logs", () => {
  it("never appears, whatever happens", async () => {
    const access = source();
    await access.ensure();
    clock += 61 * DAY;
    answers.push({ status: 500, body: { error: credentialOf(1) } }, "unreachable");
    await access.ensure();
    clock += ENROLL_RETRY_MIN_MS;
    await access.ensure();
    access.refused(access.current()?.credential ?? "");
    const all = logs.join("\n");
    for (let n = 1; n <= issued; n++) expect(all).not.toContain(credentialOf(n));
    expect(all).not.toContain("seira_install_");
  });
});
