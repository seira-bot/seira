import { base64url, ipHashOf, json, readCapped, sha256, tooMany } from "./common";
import { dryRunIssueNumber, isDryRun } from "./dry-run";
import type { AppEnv, Deps } from "./env";
import { fingerprintOf } from "./fingerprint";
import { createComment, createIssue, findOpenIssue, getIssue } from "./github";
import { rateKeyOf } from "./ip";
import { commentBody, issueBody, issueTitle, type ReportText } from "./issue-text";
import { clearOldIpHashes, recentDuplicate, reportRetryAfter, reserveReport } from "./limits";
import { homeUserNames, redact } from "./redact";
import { REPORT_BODY_LIMIT, reportSchema, type Report } from "./schema";

const FAILED = "The report could not be filed. Try again later.";
/** The IP hash needs a key. A dry run has no GitHub App key, so it uses this one: it protects nothing. */
const DRY_RUN_HASH_KEY = "seira-bug-reports/dry-run";
/** `comment_id` of a report that joined an issue, when no comment id is known. A set `comment_id` is what marks the report as joined. */
const NO_COMMENT_ID = 0;

function canonical(report: Report) {
  const hint = report.fingerprint;
  return JSON.stringify([
    report.installId,
    report.source,
    report.description,
    report.appVersion,
    report.platform,
    report.diagnostics,
    report.title ?? null,
    hint ? [hint.kind ?? null, hint.step ?? null, hint.frame ?? null] : null,
  ]);
}

async function mappedIssue(env: AppEnv, hash: string) {
  const mapped = await env.DB.prepare("SELECT issue_number FROM fingerprints WHERE fingerprint = ?")
    .bind(hash)
    .first<{ issue_number: number }>();
  return mapped?.issue_number ?? null;
}

async function targetIssue(env: AppEnv, deps: Deps, hash: string) {
  const mapped = await mappedIssue(env, hash);
  if (mapped !== null) {
    const issue = await getIssue(env, deps, mapped).catch(() => null);
    if (issue?.state === "open") return mapped;
  }
  return findOpenIssue(env, deps, hash).catch(() => null);
}

interface Filed {
  issueNumber: number;
  commentId: number | null;
  joined: boolean;
  /** What a dry run would have sent to GitHub. */
  preview?: { title: string; body: string };
}

/** Dry run: no GitHub call. An earlier report with the same fingerprint stands for an open issue. */
async function fileDry(env: AppEnv, id: string, hash: string, text: ReportText): Promise<Filed> {
  const mapped = await mappedIssue(env, hash);
  if (mapped !== null) {
    return { issueNumber: mapped, commentId: NO_COMMENT_ID, joined: true, preview: { title: `Comment on #${mapped}`, body: commentBody(id, text) } };
  }
  return {
    issueNumber: dryRunIssueNumber(hash),
    commentId: null,
    joined: false,
    preview: { title: issueTitle(text.title, text.description), body: issueBody(hash, text) },
  };
}

async function file(env: AppEnv, deps: Deps, id: string, hash: string, text: ReportText): Promise<Filed> {
  const existing = await targetIssue(env, deps, hash);
  if (existing === null) {
    return { issueNumber: await createIssue(env, deps, issueTitle(text.title, text.description), issueBody(hash, text)), commentId: null, joined: false };
  }
  const commentId = await createComment(env, deps, existing, commentBody(id, text));
  return { issueNumber: existing, commentId: commentId ?? NO_COMMENT_ID, joined: true };
}

export async function handleReport(request: Request, env: AppEnv, deps: Deps): Promise<Response> {
  if (env.REPORTS_PAUSED === "true") return json({ error: "Reports are paused. Try again later." }, 503);
  const dryRun = isDryRun(env);

  const ip = rateKeyOf(request.headers.get("cf-connecting-ip") || "unknown");
  if (!(await env.REPORT_LIMITER.limit({ key: ip })).success) return tooMany(60);

  const body = await readCapped(request, REPORT_BODY_LIMIT);
  if (body === null) return json({ error: "The report is larger than 600 KB." }, 413);

  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return json({ error: "The report is not valid JSON." }, 400);
  }
  const parsed = reportSchema.safeParse(raw);
  if (!parsed.success) return json({ error: "The report is missing a field or has a field that is too long." }, 400);
  const report = parsed.data;

  const nowSeconds = Math.floor(deps.now() / 1000);
  const installHash = await sha256(report.installId);
  const payloadHash = await sha256(canonical(report));
  const ipHash = await ipHashOf(env.GITHUB_APP_PRIVATE_KEY || (dryRun ? DRY_RUN_HASH_KEY : ""), ip);

  const earlier = await recentDuplicate(env, installHash, payloadHash, nowSeconds);
  if (earlier) return json(earlier, 201);

  const userNames = homeUserNames([report.description, report.diagnostics, report.title ?? "", report.appVersion, report.platform]);
  const clean = (value: string) => redact(value, { installId: report.installId, userNames });
  const description = clean(report.description);
  const diagnostics = clean(report.diagnostics);
  const text: ReportText = {
    title: report.title === undefined ? undefined : clean(report.title),
    description,
    diagnostics,
    appVersion: clean(report.appVersion),
    platform: clean(report.platform),
  };
  const fingerprint = await fingerprintOf({ description, diagnostics, hint: report.fingerprint });
  const id = `br_${base64url(crypto.getRandomValues(new Uint8Array(16)))}`;

  const reserved = await reserveReport(env, { id, installHash, ipHash, payloadHash, fingerprint: fingerprint.hash }, nowSeconds);
  if (!reserved) {
    const retryAfter = (await reportRetryAfter(env, installHash, ipHash, nowSeconds)) ?? 1;
    return tooMany(retryAfter, "Too many reports. Try again later.");
  }

  await clearOldIpHashes(env, nowSeconds).catch(() => {});

  let filed: Filed;
  try {
    filed = dryRun ? await fileDry(env, id, fingerprint.hash, text) : await file(env, deps, id, fingerprint.hash, text);
  } catch (error) {
    console.error("github failed", (error as { status?: unknown }).status ?? "unreachable");
    await env.DB.prepare("DELETE FROM reports WHERE id = ?").bind(id).run();
    return json({ error: FAILED }, 502);
  }

  await env.DB.batch([
    env.DB.prepare("UPDATE reports SET issue_number = ?, comment_id = ? WHERE id = ?").bind(filed.issueNumber, filed.commentId, id),
    env.DB.prepare(
      "INSERT INTO fingerprints (fingerprint, issue_number, updated_at) VALUES (?, ?, ?) ON CONFLICT (fingerprint) DO UPDATE SET issue_number = excluded.issue_number, updated_at = excluded.updated_at",
    ).bind(fingerprint.hash, filed.issueNumber, nowSeconds),
  ]);
  return json({ id, issue: filed.issueNumber, joined: filed.joined, ...(filed.preview ? { dryRun: filed.preview } : {}) }, 201);
}
