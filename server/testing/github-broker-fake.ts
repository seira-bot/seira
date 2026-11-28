import { createServer, type IncomingMessage, type Server } from "node:http";

export interface FakeInstallation {
  id: number;
  account: { login: string; type: "User" | "Organization"; avatarUrl: string };
  repositorySelection: "all" | "selected";
  suspended: boolean;
  repositories: { id: number; name: string; fullName: string; private: boolean; defaultBranch: string }[];
}

export interface FakeTokenRequest {
  installationId: number;
  repositoryIds: number[];
  permissions: Record<string, string>;
}

export interface GithubBrokerFake {
  url: string;
  token: string;
  installations: FakeInstallation[];
  pending: { account: string | null }[];
  tokenRequests: FakeTokenRequest[];
  connectBodies: { returnTo?: string }[];
  unlinked: number[];
  /** The next answer of the named route is this status and { error }. */
  failNext(route: "connect" | "complete" | "installations" | "token" | "unlink", status: number): void;
  /** A later POST /v1/github/complete with this code links these installation ids. */
  expectCode(code: string, installationIds: number[]): void;
  tokenTtlMs: number;
  close(): Promise<void>;
}

export function fakeInstallation(id: number, login: string, repos: { id: number; name: string }[], overrides: Partial<FakeInstallation> = {}): FakeInstallation {
  return {
    id,
    account: { login, type: "User", avatarUrl: `https://avatars.example/${login}.png` },
    repositorySelection: "selected",
    suspended: false,
    repositories: repos.map((repo) => ({ id: repo.id, name: repo.name, fullName: `${login}/${repo.name}`, private: false, defaultBranch: "main" })),
    ...overrides,
  };
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { resolve({}); }
    });
  });
}

export async function startGithubBrokerFake(options: { token?: string } = {}): Promise<GithubBrokerFake> {
  const token = options.token ?? "fake-broker-bearer";
  const failures = new Map<string, number>();
  const codes = new Map<string, number[]>();
  let minted = 0;
  const fake: GithubBrokerFake = {
    url: "",
    token,
    installations: [],
    pending: [],
    tokenRequests: [],
    connectBodies: [],
    unlinked: [],
    tokenTtlMs: 60 * 60_000,
    failNext: (route, status) => { failures.set(route, status); },
    expectCode: (code, ids) => { codes.set(code, ids); },
    close: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
  const server: Server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: "unauthorized" });
    const path = new URL(req.url ?? "/", "http://fake").pathname;
    const route = path === "/v1/github/connect" ? "connect"
      : path === "/v1/github/complete" ? "complete"
        : path === "/v1/github/installations" ? "installations"
          : path === "/v1/github/token" ? "token"
            : path.startsWith("/v1/github/installations/") ? "unlink" : null;
    if (!route) return send(404, { error: "not found" });
    const failure = failures.get(route);
    if (failure !== undefined) {
      failures.delete(route);
      return send(failure, { error: "failed" });
    }
    if (route === "connect" && req.method === "POST") {
      const body = await readJson(req);
      fake.connectBodies.push(body);
      return send(200, { url: "https://github.com/apps/seira-fake/installations/new", expiresAt: Date.now() + 600_000 });
    }
    if (route === "complete" && req.method === "POST") {
      const { code } = await readJson(req);
      const ids = codes.get(code);
      if (!ids) return send(404, { error: "unknown code" });
      codes.delete(code);
      const linked = fake.installations.filter((one) => ids.includes(one.id)).map((one) => ({ id: one.id, account: { login: one.account.login, type: one.account.type } }));
      return send(200, { linked });
    }
    if (route === "installations" && req.method === "GET") return send(200, { installations: fake.installations, pending: fake.pending });
    if (route === "token" && req.method === "POST") {
      const body = await readJson(req);
      fake.tokenRequests.push(body);
      minted += 1;
      return send(200, { token: `ghs_fake_${minted}`, expiresAt: Date.now() + fake.tokenTtlMs });
    }
    if (route === "unlink" && req.method === "DELETE") {
      const id = Number(path.split("/").pop());
      const before = fake.installations.length;
      fake.installations = fake.installations.filter((one) => one.id !== id);
      if (fake.installations.length === before) return send(404, { error: "not linked" });
      fake.unlinked.push(id);
      return send(200, { manageUrl: "https://github.com/settings/installations" });
    }
    return send(405, { error: "method not allowed" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  fake.url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  return fake;
}
