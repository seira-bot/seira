import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import type { GithubAccount, GithubBotPolicy } from "../../shared/github-app.ts";
import { writeFileAtomic } from "../atomic.ts";
import { ensurePrivateDir } from "../data-dir.ts";

export const GITHUB_STORE_FILE = "github-app.json";

const repoSchema = z.object({
  id: z.number().int(),
  name: z.string().max(200),
  fullName: z.string().max(400),
  private: z.boolean(),
  defaultBranch: z.string().max(255),
});

const accountSchema = z.object({
  installationId: z.number().int(),
  login: z.string().max(200),
  type: z.enum(["User", "Organization"]),
  avatarUrl: z.string().max(2048).optional(),
  repositorySelection: z.enum(["all", "selected"]),
  suspended: z.boolean(),
  repositories: z.array(repoSchema).max(5000),
});

export const MAX_GITHUB_BOT_REPOS = 200;

export const githubBotPolicySchema = z.object({
  repos: z.array(z.object({
    installationId: z.number().int(),
    repositoryId: z.number().int(),
    fullName: z.string().max(400),
    level: z.enum(["read", "pull_requests", "write"]),
  }).strict()).max(MAX_GITHUB_BOT_REPOS),
  askBeforeBigChanges: z.boolean(),
  ownBranchesOnly: z.boolean(),
}).strict();

const fileSchema = z.object({
  version: z.literal(1),
  ownerKey: z.string().max(200).optional(),
  ownerLabel: z.string().max(200).optional(),
  connectedAt: z.number().optional(),
  accounts: z.array(accountSchema),
  pending: z.array(z.object({ login: z.string().max(200).nullable() })),
  bots: z.record(z.string(), githubBotPolicySchema),
});

export interface GithubStoreData {
  version: 1;
  ownerKey?: string;
  ownerLabel?: string;
  connectedAt?: number;
  accounts: GithubAccount[];
  pending: { login: string | null }[];
  bots: Record<string, GithubBotPolicy>;
}

export interface GithubStore {
  read(): GithubStoreData;
  write(data: GithubStoreData): void;
  update(change: (data: GithubStoreData) => void): GithubStoreData;
}

export const emptyGithubStoreData = (): GithubStoreData => ({ version: 1, accounts: [], pending: [], bots: {} });

export function createGithubStore(dataDir: string, log: (line: string) => void = (line) => console.error(line)): GithubStore {
  const file = join(dataDir, GITHUB_STORE_FILE);
  const read = (): GithubStoreData => {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return emptyGithubStoreData();
    }
    try {
      return fileSchema.parse(JSON.parse(text)) as GithubStoreData;
    } catch {
      log("[github] the connection file is not valid and is read as empty");
      return emptyGithubStoreData();
    }
  };
  const write = (data: GithubStoreData): void => {
    ensurePrivateDir(dataDir);
    writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  };
  return {
    read,
    write,
    update(change) {
      const data = read();
      change(data);
      write(data);
      return data;
    },
  };
}
