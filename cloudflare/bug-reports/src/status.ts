import { json, readCapped, sha256, tooMany } from "./common";
import type { AppEnv, Deps } from "./env";
import { getIssue, type GitHubIssue } from "./github";
import { isDryRun } from "./dry-run";
import { rateKeyOf } from "./ip";
import { STATUS_BODY_LIMIT, statusSchema } from "./schema";

export const STATUS_TTL_SECONDS = 900;
export const REFRESH_BUDGET = 10;

type IssueStatus = "open" | "fixed" | "closed";
interface CachedIssue {
  number: number;
  status: IssueStatus;
  fixed_in: string | null;
  checked_at: number;
}

const VERSION = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/i;
const LABEL = /^(?:fixed-in|released):(v?\d{1,6}\.\d{1,6}\.\d{1,6})$/i;

function parts(version: string) {
  const match = VERSION.exec(version);
  return match ? ([Number(match[1]), Number(match[2]), Number(match[3])] as const) : null;
}

const compare = (a: readonly number[], b: readonly number[]) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;

export function fixedInOf(labels: Array<string | { name?: string }> | undefined, milestone: { title?: string } | null | undefined) {
  let best: readonly [number, number, number] | null = null;
  for (const label of labels ?? []) {
    const name = (typeof label === "string" ? label : label.name ?? "").trim();
    const version = parts(LABEL.exec(name)?.[1] ?? "");
    if (version && (!best || compare(version, best) > 0)) best = version;
  }
  best ??= parts((milestone?.title ?? "").trim());
  return best ? best.join(".") : null;
}

function describe(issue: GitHubIssue): { status: IssueStatus; fixedIn: string | null } | null {
  if (issue.state === "open") return { status: "open", fixedIn: null };
  if (issue.state !== "closed") return null;
  if (issue.state_reason === "completed") return { status: "fixed", fixedIn: fixedInOf(issue.labels, issue.milestone) };
  return { status: "closed", fixedIn: null };
}

const marks = (count: number) => Array.from({ length: count }, () => "?").join(", ");

async function refresh(env: AppEnv, deps: Deps, numbers: number[], nowSeconds: number, known: Map<number, CachedIssue>) {
  const stale = numbers
    .filter((number) => {
      const row = known.get(number);
      return !row || nowSeconds - row.checked_at >= STATUS_TTL_SECONDS;
    })
    .sort((a, b) => (known.get(a)?.checked_at ?? -1) - (known.get(b)?.checked_at ?? -1))
    .slice(0, REFRESH_BUDGET);

  await Promise.all(
    stale.map(async (number) => {
      const issue = await getIssue(env, deps, number).catch(() => null);
      const state = issue && describe(issue);
      if (!state) return;
      const row: CachedIssue = { number, status: state.status, fixed_in: state.fixedIn, checked_at: nowSeconds };
      known.set(number, row);
      await env.DB.prepare(
        "INSERT INTO issues (number, status, fixed_in, checked_at) VALUES (?, ?, ?, ?) ON CONFLICT (number) DO UPDATE SET status = excluded.status, fixed_in = excluded.fixed_in, checked_at = excluded.checked_at",
      )
        .bind(number, row.status, row.fixed_in, row.checked_at)
        .run();
    }),
  );
}

export async function handleStatus(request: Request, env: AppEnv, deps: Deps): Promise<Response> {
  const ip = rateKeyOf(request.headers.get("cf-connecting-ip") || "unknown");
  if (!(await env.STATUS_LIMITER.limit({ key: ip })).success) return tooMany(60);

  const body = await readCapped(request, STATUS_BODY_LIMIT);
  if (body === null) return json({ error: "The request is too large." }, 413);
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return json({ error: "The request is not valid JSON." }, 400);
  }
  const parsed = statusSchema.safeParse(raw);
  if (!parsed.success) return json({ error: "The request is missing a field or has a field that is too long." }, 400);
  const { installId, ids } = parsed.data;

  const installHash = await sha256(installId);
  const unique = [...new Set(ids)];
  const issueOf = new Map<string, number>();
  if (unique.length) {
    const rows = await env.DB.prepare(
      `SELECT id, issue_number FROM reports WHERE install_hash = ? AND issue_number IS NOT NULL AND id IN (${marks(unique.length)})`,
    )
      .bind(installHash, ...unique)
      .all<{ id: string; issue_number: number }>();
    for (const row of rows.results) issueOf.set(row.id, row.issue_number);
  }

  const numbers = [...new Set(issueOf.values())];
  const known = new Map<number, CachedIssue>();
  if (numbers.length) {
    const cached = await env.DB.prepare(
      `SELECT number, status, fixed_in, checked_at FROM issues WHERE number IN (${marks(numbers.length)})`,
    )
      .bind(...numbers)
      .all<CachedIssue>();
    for (const row of cached.results) known.set(row.number, row);
  }
  // A dry run has no real issues. Its numbers are made up, so it never asks GitHub about them.
  if (!isDryRun(env)) await refresh(env, deps, numbers, Math.floor(deps.now() / 1000), known);

  const reports = ids.map((id) => {
    const number = issueOf.get(id);
    if (number === undefined) return { id, status: "unknown" as const, fixedIn: null };
    const row = known.get(number);
    return row?.status === "fixed"
      ? { id, status: "fixed" as const, fixedIn: row.fixed_in }
      : { id, status: "received" as const, fixedIn: null };
  });
  return json({ reports, notify: true });
}
