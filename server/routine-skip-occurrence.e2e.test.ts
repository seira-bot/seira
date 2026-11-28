import { expect, it } from "vitest";

import { runControlSeira } from "../scripts/control-seira.ts";
import { launchRestartableServer } from "./testing/restartable-server.ts";

const HOUR = 3_600_000;

it("skips one occurrence of a routine through the route, and undoes the skip", async () => {
  const server = await launchRestartableServer();
  const call = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(`${server.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: server.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    return value;
  };
  try {
    const bot = ((await runControlSeira(["new-bot", "--name", "Scout", "--url", server.url])) as { bot: { id: string } }).bot.id;
    const first = Date.now() + 600_000;
    const { routine } = await call("POST", "/api/routines", { name: "Hourly", prompt: "Reply with one line.", botId: bot, schedule: { type: "interval", everyMinutes: 60, anchorAt: first } }, 201);
    const skip = (id: string, body: unknown, status = 200) => call("POST", `/api/routines/${id}/skip`, body, status);

    const skipped = await skip(routine.id, { at: first, skip: true });
    expect(skipped.routine).toMatchObject({ skippedOccurrences: [first], nextRunAt: first + HOUR });
    const listed = (await call("GET", "/api/routines")).routines.find((candidate: any) => candidate.id === routine.id);
    expect(listed).toMatchObject({ skippedOccurrences: [first], nextRunAt: first + HOUR });

    const undone = await skip(routine.id, { at: first, skip: false });
    expect(undone.routine.skippedOccurrences).toBeUndefined();
    expect(undone.routine.nextRunAt).toBe(first);

    await skip(routine.id, { at: first, skip: "yes" }, 400);
    await skip(routine.id, { at: 1.5, skip: true }, 400);
    await skip(routine.id, { at: first + 1, skip: true }, 400);
    await skip("no-such-routine", { at: first, skip: true }, 404);

    const once = (await call("POST", "/api/routines", { name: "Reminder", prompt: "Remind me.", botId: bot, schedule: { type: "once", at: first } }, 201)).routine;
    expect((await skip(once.id, { at: first, skip: true }, 400)).error).toMatch(/only once/);
  } finally {
    await server.close();
  }
});
