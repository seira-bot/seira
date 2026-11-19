import { base64url, json, readCapped, sha256, tooMany } from "./common";
import type { AppEnv, Deps } from "./env";
import { fingerprintOf } from "./fingerprint";
import { createComment, createIssue, findOpenIssue, getIssue } from "./github";
import { commentBody, issueBody, issueTitle, type ReportText } from "./issue-text";
import { recentDuplicate, reportRetryAfter } from "./limits";
import { homeUserNames, redact } from "./redact";
import { REPORT_BODY_LIMIT, reportSchema, type Report } from "./schema";

const FAILED = "The report could not be filed. Try again later.";

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

async function targetIssue(env: AppEnv, deps: Deps, hash: string) {
  const mapped = await env.DB.prepare("SELECT issue_number FROM fingerprints WHERE fingerprint = ?")
    .bind(hash)
    .first<{ issue_number: number }>();
  if (mapped) {
    const issue = await getIssue(env, deps, mapped.issue_number).catch(() => null);
    if (issue?.state === "open") return mapped.issue_number;
  }
  return findOpenIssue(env, deps, hash).catch(() => null);
}

export async function handleReport(request: Request, env: AppEnv, deps: Deps): Promise<Response> {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
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

  const earlier = await recentDuplicate(env, installHash, payloadHash, nowSeconds);
  if (earlier) return json({ id: earlier }, 201);

  const retryAfter = await reportRetryAfter(env, installHash, nowSeconds);
  if (retryAfter !== null) return tooMany(retryAfter, "Too many reports. Try again later.");

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

  let issueNumber: number;
  let commentId: number | null = null;
  try {
    const existing = await targetIssue(env, deps, fingerprint.hash);
    if (existing === null) {
      issueNumber = await createIssue(env, deps, issueTitle(text.title, description), issueBody(fingerprint.hash, text));
    } else {
      issueNumber = existing;
      commentId = await createComment(env, deps, existing, commentBody(id, text));
    }
  } catch (error) {
    console.error("github failed", (error as { status?: unknown }).status ?? "unreachable");
    return json({ error: FAILED }, 502);
  }

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO reports (id, install_hash, payload_hash, fingerprint, issue_number, comment_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(id, installHash, payloadHash, fingerprint.hash, issueNumber, commentId, nowSeconds),
    env.DB.prepare(
      "INSERT INTO fingerprints (fingerprint, issue_number, updated_at) VALUES (?, ?, ?) ON CONFLICT (fingerprint) DO UPDATE SET issue_number = excluded.issue_number, updated_at = excluded.updated_at",
    ).bind(fingerprint.hash, issueNumber, nowSeconds),
  ]);
  return json({ id }, 201);
}
