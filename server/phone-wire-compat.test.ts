import type { IncomingMessage } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-seira.ts";
import { defaultHostName } from "../companion/src/mdns.ts";
import * as companionNames from "../companion/src/wire-names.ts";
import { readPairingInput } from "../shared/pairing-code.ts";
import { phonePairingLink } from "../shared/pairing-link.ts";
import { phonePushCollapseId } from "../shared/phone-push.ts";
import { sentWireName } from "../shared/phone-wire-names.ts";
import { activityRegistrationSchema } from "./phone-activity.ts";
import { resolveRequestAuth } from "./request-auth.ts";
import { generatePairingCredential, SessionRegistry } from "./sessions.ts";

const body43 = "a".repeat(43);
const HEADLINES = { needsYou: "{name} needs you", working: "{name} is working" };

let fixture: VerificationServer;
let url: string;

const api = async (method: string, path: string, body?: unknown, token?: string) => {
  const response = await fetch(url + path, {
    method, headers: { "content-type": "application/json", origin: url, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, body: await response.json() as any };
};

beforeAll(async () => {
  fixture = await launchVerificationServer();
  url = fixture.info.url;
}, 60_000);

afterAll(async () => {
  await fixture?.close();
});

describe("what the server and the desktop send to a phone", () => {
  it("pair links, credentials and push ids use the names of the released phone apps", () => {
    const credential = generatePairingCredential();
    expect(credential).toMatch(/^omb_pair_[A-Za-z0-9_-]{43}$/);
    const link = phonePairingLink({ address: "192.168.1.20", port: 8810, token: credential });
    expect(link).toMatch(/^openmausbot:\/\/pair\?/);
    expect(new URL(link!).searchParams.get("token")).toMatch(/^omb_pair_/);
    expect(phonePushCollapseId("th_1", 4)).toBe("openmaus.th_1.4");
  });

  it("the companion announces the old service type and host name", () => {
    expect(companionNames.sentWireName("mdnsServiceType")).toBe("_openmausbot._tcp");
    expect(defaultHostName("a-machine")).toMatch(/^openmausbot-[0-9a-f]{8}\.local$/);
  });

  it("the server describes itself at the old path and answers health with the old name", async () => {
    const described = await api("GET", sentWireName("environmentPath"));
    expect(described.status).toBe(200);
    expect(sentWireName("environmentPath")).toBe("/.well-known/openmausbot/environment");
    expect((await api("GET", "/api/health")).body.app).toBe("openmausbot");
  });

  it("a new session token starts with the old prefix", async () => {
    const opened = await api("POST", "/api/auth/pairing", { label: "Phone", scopes: ["client"] });
    const paired = await api("POST", "/api/auth/pair", { code: opened.body.code });
    expect(paired.body.token).toMatch(/^omb_sess_/);
    expect((await api("GET", "/api/auth/session", undefined, paired.body.token)).status).toBe(200);
  });
});

describe("what the server and the desktop accept from a phone", () => {
  it("reads a credential and a link with either prefix and either scheme", () => {
    for (const prefix of ["omb_pair_", "seira_pair_"]) {
      expect(readPairingInput(`${prefix}${body43}`)).toEqual({ kind: "credential", credential: `${prefix}${body43}` });
      for (const scheme of ["openmausbot", "seira"]) {
        expect(readPairingInput(`${scheme}://pair?address=${encodeURIComponent("http://192.168.1.20:8799")}&token=${prefix}${body43}`))
          .toEqual({ kind: "credential", credential: `${prefix}${body43}` });
      }
      expect(phonePairingLink({ address: "192.168.1.20", port: 8810, token: `${prefix}${body43}` })).not.toBeNull();
    }
    for (const prefix of ["omb_sess_", "seira_sess_"]) expect(readPairingInput(`${prefix}${body43}`)).toEqual({ kind: "wrong", problem: "scriptKey" });
  });

  it("serves the descriptor at both paths with the same body", async () => {
    const old = await api("GET", "/.well-known/openmausbot/environment");
    const current = await api("GET", "/.well-known/seira/environment");
    expect(old.status).toBe(200);
    expect(current.body).toEqual(old.body);
  });

  it.each(["omb_sess_", "seira_sess_"])("signs a session in with the prefix %s", (prefix) => {
    const dir = mkdtempSync(join(tmpdir(), "seira-wire-compat-"));
    try {
      const file = join(dir, "sessions.json");
      const issued = new SessionRegistry({ file }).issue({ label: "Phone", scopes: ["client"] });
      const token = issued.token.replace(/^[a-z]+_sess_/, prefix);
      const saved = JSON.parse(readFileSync(file, "utf8"));
      saved.sessions[0].tokenHash = createHash("sha256").update(token).digest("hex");
      writeFileSync(file, JSON.stringify(saved));
      const req = { method: "GET", headers: { host: "127.0.0.1:8799", authorization: `Bearer ${token}` } } as unknown as IncomingMessage;
      const result = resolveRequestAuth(req, { sessions: new SessionRegistry({ file }), cookieName: "seira_session_8799_env", streamPath: "/api/events", url: new URL("/api/bots", "http://x") });
      expect(result.auth).toMatchObject({ kind: "session" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the scheme a phone registers for its activity links", () => {
    for (const scheme of ["openmausbot", "openmausbot-dev", "openmausbot-next", "seira", "seira-dev", "seira-next"]) {
      expect(activityRegistrationSchema.parse({ scheme, headlines: HEADLINES }).scheme).toBe(scheme);
    }
    expect(activityRegistrationSchema.safeParse({ scheme: "other", headlines: HEADLINES }).success).toBe(false);
  });

  it("creates a routine whose run-on value is the old or the current name for this computer", async () => {
    const chief = (await api("GET", "/api/bots")).body.bots.find((bot: { chiefOfStaff?: boolean }) => bot.chiefOfStaff);
    for (const runOn of ["maus", "seira"]) {
      const created = await api("POST", "/api/routines", {
        name: `Routine ${runOn}`, prompt: "Say hello", botId: chief.id, runOn, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
      });
      expect(created.status).toBeLessThan(300);
      expect(created.body.routine.runOn).toBe("seira");
    }
  });
});
