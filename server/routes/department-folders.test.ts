import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DepartmentFolders } from "../department-folders.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createDepartmentFolderRoutes, FOLDER_ACCESS_SET_ELSEWHERE, type FolderEnforcement } from "./department-folders.ts";
import { PASS, type RouteContext } from "./table.ts";

let root = "";
let dataDir = "";
let home = "";
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "department-routes-")));
  dataDir = join(root, "data");
  home = join(root, "home");
  for (const folder of [dataDir, home, join(root, "docs")]) mkdirSync(folder, { recursive: true });
  writeFileSync(join(root, "file.txt"), "x");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const admin = { kind: "loopback", scopes: ["admin", "client"] } as RequestAuth;
const client = { kind: "loopback", scopes: ["client"] } as RequestAuth;

function fixture(flags: { elsewhere?: boolean; enforcement?: FolderEnforcement } = {}) {
  const folders = new DepartmentFolders(join(root, `dept-${Math.random()}.json`));
  const handler = createDepartmentFolderRoutes({
    store: { sections: ["Sales"] }, folders, dataDir, home, setElsewhere: () => flags.elsewhere === true, enforcement: () => flags.enforcement ?? "ai",
  });
  const call = async (method: string, query: string, body?: unknown, auth: RequestAuth = admin) => {
    const sent: Array<{ status: number; body: any }> = [];
    const out = await handler({
      req: {} as IncomingMessage, res: {} as ServerResponse, url: new URL(`http://localhost/api/department-folders${query}`),
      path: "/api/department-folders", method, auth,
      json: ((_res: ServerResponse, status: number, response: unknown) => { sent.push({ status, body: response }); }) as RouteContext["json"],
      readBody: (async () => body) as RouteContext["readBody"],
    });
    expect(out).not.toBe(PASS);
    return sent[0]!;
  };
  return { folders, call };
}

describe("/api/department-folders", () => {
  it("passes other paths", async () => {
    const { folders } = fixture();
    const handler = createDepartmentFolderRoutes({ store: { sections: [] }, folders, dataDir, home, setElsewhere: () => false, enforcement: () => "ai" });
    const out = await handler({ path: "/api/other", method: "GET" } as RouteContext);
    expect(out).toBe(PASS);
  });

  it("gives a non-admin 403 on both methods", async () => {
    const { call } = fixture();
    expect((await call("GET", "", undefined, client)).status).toBe(403);
    expect((await call("PUT", "?section=Sales", { limited: false, folders: [] }, client)).status).toBe(403);
  });

  it("stores a valid list and reports it with the way it is enforced", async () => {
    const { call } = fixture({ enforcement: "ai" });
    const put = await call("PUT", "?section=Sales", { limited: true, folders: [{ path: join(root, "docs"), write: true }] });
    expect(put).toEqual({ status: 200, body: { access: { limited: true, folders: [{ path: join(root, "docs"), write: true }] } } });
    const got = await call("GET", "");
    expect(got.body).toEqual({ departments: { Sales: put.body.access }, enforcement: "ai", setHere: true });
    expect((await fixture({ enforcement: "box" }).call("GET", "")).body.enforcement).toBe("box");
    expect((await fixture({ enforcement: "limited" }).call("GET", "")).body.enforcement).toBe("limited");
  });

  it("clears a department on null", async () => {
    const { call, folders } = fixture();
    await call("PUT", "?section=Sales", { limited: true, folders: [] });
    expect(folders.get("Sales")).toBeDefined();
    expect(await call("PUT", "?section=Sales", null)).toEqual({ status: 200, body: { access: null } });
    expect(folders.get("Sales")).toBeUndefined();
  });

  it("answers 400 with the refusal, its message, and the path", async () => {
    const { call } = fixture();
    const cases: Array<[unknown, string, string]> = [
      [{ limited: true }, "invalid", "That folder list is not valid."],
      [{ limited: true, folders: [{ path: "docs", write: false }] }, "relative", "Use the full path of the folder."],
      [{ limited: true, folders: [{ path: join(root, "nope"), write: false }] }, "missing", "That folder isn't on this computer."],
      [{ limited: true, folders: [{ path: join(root, "file.txt"), write: false }] }, "notFolder", "That is a file, not a folder."],
      [{ limited: true, folders: [{ path: "/etc", write: false }] }, "system", "Choose one of your own folders, not a system folder."],
      [{ limited: true, folders: [{ path: dataDir, write: false }] }, "dataFolder", "Seira keeps its own data there. Choose another folder."],
      [{ limited: true, folders: Array.from({ length: 21 }, () => ({ path: join(root, "docs"), write: false })) }, "tooMany", "You can add up to 20 folders."],
    ];
    for (const [body, refusal, message] of cases) {
      const response = await call("PUT", "?section=Sales", body);
      expect(response.status, refusal).toBe(400);
      expect(response.body).toMatchObject({ error: message, refusal });
    }
    expect((await call("PUT", "?section=Sales", cases[1]![0])).body.path).toBe("docs");
  });

  it("answers 404 for an unknown or missing department", async () => {
    const { call } = fixture();
    expect((await call("PUT", "?section=Nowhere", { limited: false, folders: [] })).status).toBe(404);
    expect((await call("PUT", "", { limited: false, folders: [] })).status).toBe(404);
  });

  it("answers 409 on a Team Cloud or hosted workspace, and still lists", async () => {
    const { call, folders } = fixture({ elsewhere: true });
    expect(await call("PUT", "?section=Sales", { limited: true, folders: [] })).toEqual({ status: 409, body: { error: FOLDER_ACCESS_SET_ELSEWHERE } });
    expect(folders.all()).toEqual({});
    expect((await call("GET", "")).status).toBe(200);
    expect((await call("GET", "")).body.setHere).toBe(false);
  });
});
