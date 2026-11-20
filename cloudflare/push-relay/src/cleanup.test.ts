import { describe, expect, it } from "vitest";

import { cleanup } from "./cleanup";
import worker from "./index";
import { APNS_TOKEN, harness, NOTIFICATION, TEST_IP } from "./test-harness";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("data kept", () => {
  it("AC-27: keeps no raw IP address and no message text in any table after enroll, register, and send", async () => {
    const h = harness();
    const { credential } = await h.install("203.0.113.77");
    await h.registerApns(credential);
    expect((await h.send(credential, APNS_TOKEN)).status).toBe(202);
    const text = h.everyTable();
    for (const forbidden of ["203.0.113.77", TEST_IP, NOTIFICATION.title, NOTIFICATION.botName, NOTIFICATION.roomName, NOTIFICATION.threadId, NOTIFICATION.botId]) {
      expect(text).not.toContain(forbidden);
    }
  });
});

describe("cleanup", () => {
  async function seed() {
    const h = harness();
    const idle = await h.install();
    const fresh = await h.install();
    await h.registerApns(idle.credential);
    await h.registerApns(fresh.credential);
    h.d1.db.prepare("UPDATE installations SET last_seen_at = ? WHERE id = ?").run(h.clock.ms - 91 * DAY_MS, idle.installationId);
    return { h, idle, fresh };
  }

  it("AC-27: deletes an installation 90 days after its last use, with its credentials and tokens, and keeps the others", async () => {
    const { h, idle, fresh } = await seed();
    await cleanup(h.env, h.clock.ms);
    expect(h.d1.rows("SELECT id FROM installations")).toEqual([{ id: fresh.installationId }]);
    expect(h.d1.rows("SELECT installation_id FROM installation_credentials")).toEqual([{ installation_id: fresh.installationId }]);
    expect(h.devices().map((device) => device.installation_id)).toEqual([fresh.installationId]);
    expect(JSON.stringify(h.d1.rows("SELECT installation_id FROM push_devices"))).not.toContain(idle.installationId);
  });

  it("AC-27: keeps an installation that was used 89 days ago", async () => {
    const { h, idle } = await seed();
    h.d1.db.prepare("UPDATE installations SET last_seen_at = ? WHERE id = ?").run(h.clock.ms - 89 * DAY_MS, idle.installationId);
    await cleanup(h.env, h.clock.ms);
    expect(h.d1.rows("SELECT id FROM installations")).toHaveLength(2);
  });

  it("AC-27: deletes credentials that were revoked or expired more than a day ago, and keeps the newer ones", async () => {
    const h = harness();
    const { installationId } = await h.install();
    const insert = h.d1.db.prepare("INSERT INTO installation_credentials (lookup_id, installation_id, secret_hash, created_at, expires_at, revoked_at) VALUES (?, ?, 'h', 0, ?, ?)");
    const now = h.clock.ms;
    insert.run("revoked-old", installationId, now + DAY_MS, now - 2 * DAY_MS);
    insert.run("revoked-new", installationId, now + DAY_MS, now - DAY_MS / 2);
    insert.run("expired-old", installationId, now - 2 * DAY_MS, null);
    insert.run("expired-new", installationId, now - DAY_MS / 2, null);
    await cleanup(h.env, now);
    const left = h.d1.rows<{ lookup_id: string }>("SELECT lookup_id FROM installation_credentials").map((row) => row.lookup_id);
    expect(left).toContain("revoked-new");
    expect(left).toContain("expired-new");
    expect(left).not.toContain("revoked-old");
    expect(left).not.toContain("expired-old");
    expect(left).toHaveLength(3);
  });

  it("AC-27: deletes limit counters older than two days", async () => {
    const h = harness();
    const now = h.clock.ms;
    const insert = h.d1.db.prepare("INSERT INTO action_limits (subject, action, window_start, count) VALUES (?, 'send', ?, 1)");
    insert.run("old", now - 3 * DAY_MS);
    insert.run("recent", now - DAY_MS);
    await cleanup(h.env, now);
    expect(h.d1.rows<{ subject: string }>("SELECT subject FROM action_limits").map((row) => row.subject)).toEqual(["recent"]);
  });

  it("AC-27: runs the cleanup from the scheduled handler", async () => {
    const h = harness();
    const { installationId } = await h.install();
    h.d1.db.prepare("UPDATE installations SET last_seen_at = 0 WHERE id = ?").run(installationId);
    await worker.scheduled({} as ScheduledController, h.env);
    expect(h.d1.rows("SELECT id FROM installations")).toHaveLength(0);
    expect(h.d1.rows("SELECT * FROM installation_credentials")).toHaveLength(0);
  });
});
