# Seira bug reports

This Worker receives bug reports from the Seira app.
It files each report as a GitHub issue in `seira-bot/seira`.
It uses a GitHub App installation token. The app holds no GitHub token.
It runs at `bugs.seira.bot`. It stores a small index in D1.

## Routes

| Route | Auth | Action |
| --- | --- | --- |
| `POST /api/bug-reports` | none, rate limited | File a report. Answer `201 {id, issue, joined}`. |
| `POST /api/bug-reports/status` | none, rate limited | Answer the status of the reports that one install sent. |
| `GET /health` | none | Answer `ok`. In dry-run mode, answer `ok dry-run`. |

Other methods on the two API routes get `405`. Other paths get `404`.

## What goes into a public issue

The repository is public. Everyone can read each issue.
The Worker redacts the text again. It does not trust the redaction of the app.

The Worker removes these items from the title, the description, and the diagnostics:

- email addresses, phone numbers, and the install ID
- home folder paths, and the user name found in them
- tokens, keys, passwords, and private key blocks
- credentials, queries, and fragments in URLs
- the values of `Authorization` and `Cookie` headers

The Worker puts the report text in a fenced code block.
This block stops `@mention`, `#reference`, HTML, and Markdown in the text.

The Worker drops `contactEmail` and `contact`. It does not store them, send them, or log them.
D1 stores the install ID only as a SHA-256 hash.
The Worker never logs the report text.

## Same error, one issue

The Worker computes a fingerprint of the error.
It uses the error kind, the failed step, and the top code frame. It ignores numbers, IDs, paths, and line numbers.
The issue body starts with `<!-- seira-fp:FINGERPRINT -->`.

- If an open issue has the fingerprint, the Worker adds a comment.
- If not, the Worker creates an issue with the labels `bug` and `from-app`.
- If the issue is closed, the next report creates a new issue.

The same install can send the same report again within 24 hours.
The Worker then answers the first ID and does not call GitHub.

An optional `title` (up to 120 characters) sets the issue title.
An optional `fingerprint` object `{kind, step, frame}` replaces the computed values.

## The answer

A filed report gets `201` with these fields:

| Field | Meaning |
| --- | --- |
| `id` | The ID of this report. The app sends it to the status route. |
| `issue` | The number of the public issue that holds the report. |
| `joined` | `true` if the report became a comment on an issue that was already open. `false` if the report opened a new issue. |

A report that the Worker answered before (same install, same text, within 24 hours) gets the same three fields again.

## Status and `fixedIn`

The app asks for the status of its reports.

| GitHub issue | Status |
| --- | --- |
| open | `received` |
| closed as not planned or duplicate | `received` |
| closed as completed | `fixed` |
| the install did not send this ID | `unknown` |

For a `fixed` report, the Worker sets `fixedIn` with this rule:

1. Use the highest version in the labels `fixed-in:X.Y.Z` or `released:X.Y.Z`. A leading `v` is allowed.
2. If there is no such label, use the milestone title `X.Y.Z` or `vX.Y.Z`.
3. If there is neither, use `null`.

The Worker keeps each issue status for 900 seconds. One request refreshes at most 10 issues.

## Limits

| Limit | Value |
| --- | --- |
| Reports per install | 5 in 3,600 seconds |
| Reports per IP address | 10 in 3,600 seconds, whatever the install ID. For an IPv6 address the limit holds for its whole `/64` prefix. |
| Reports from all installs | `GLOBAL_HOURLY_LIMIT` in 3,600 seconds (default 30) |
| Requests per IP address | 10 per minute for reports, 60 per minute for status. For an IPv6 address the limit holds for its whole `/64` prefix. |
| Report size | 600 KB |
| Status request size | 16 KB, 50 IDs |

A refused request gets `429` with `retryAfter` and a `Retry-After` header.
A failed GitHub call gets `502`. The app sends the report again later.
A failed call does not count in the limits.
D1 keeps an HMAC of the IP address, not the address. D1 keeps the HMAC for at most one hour.
The HMAC key comes from the App private key with HKDF.

One IPv6 subscriber controls a whole `/64` prefix (2^64 addresses) and can change address at will.
So the Worker keys every per-address limit by the `/64` prefix of an IPv6 address.
The HMAC then covers the prefix, not the full address.
The Worker keeps an IPv4 address whole.
It reads an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) as that IPv4 address.
It uses text that is not an IP address as it is. A missing address becomes `unknown`.
Many people behind one IPv6 prefix share the limit. Raise `PER_IP_LIMIT` in `src/limits.ts` if that causes complaints.

To stop all new reports, set the var `REPORTS_PAUSED` to `true` and deploy.
The Worker then answers `503` to `POST /api/bug-reports`. It does not call GitHub and does not write D1.
The status route keeps working.

## Dry-run mode

Set the var `DRY_RUN` to `true` to run the Worker without GitHub.
The Worker then does everything but the GitHub calls: it checks the report, redacts it, computes the fingerprint,
applies the limits, and writes D1.
It sends no request to GitHub, so it needs no GitHub App secret and files no issue.

- The answer adds `dryRun: {title, body}`. This is the redacted text that the Worker would have sent.
- An earlier report with the same fingerprint stands for an open issue, so the next report gets `joined: true`.
- Issue numbers start at 9,000,000, so none is the number of a real issue.
- The status route answers `received` and does not call GitHub.
- `GET /health` answers `ok dry-run`.

Only the exact value `true` turns the mode on. `wrangler.jsonc` sets `false`.
Never set `DRY_RUN` on the production Worker: every report would be lost without a trace in GitHub.
Check a deployed Worker with `GET /health`. It must answer `ok`.

## Create the GitHub App

1. Open GitHub settings for your account or organization. Choose Developer settings, then GitHub Apps, then New GitHub App.
2. Set the repository permission Issues to Read and write. Metadata is Read-only and GitHub sets it for you.
3. Turn off Webhook.
4. Set "Where can this GitHub App be installed?" to "Only on this account".
5. Create the app. Write down the App ID.
6. Generate a private key. Keep the `.pem` file.
7. Install the app only on `seira-bot/seira`.
8. Open the installation. The number at the end of the URL is the installation ID.
9. Create the labels `bug` and `from-app` in the repository if they do not exist.

## Deploy

Set `CLOUDFLARE_ACCOUNT_ID` in the environment for each command.

1. Create the database:
   `pnpm exec wrangler d1 create seira-bug-reports`
2. Put the printed `database_id` in `cloudflare/bug-reports/wrangler.jsonc`, in the `d1_databases` entry.
3. Apply the migration:
   `pnpm exec wrangler d1 migrations apply seira-bug-reports --remote --config cloudflare/bug-reports/wrangler.jsonc`
4. Set the secrets:
   ```bash
   pnpm exec wrangler secret put GITHUB_APP_ID --config cloudflare/bug-reports/wrangler.jsonc
   pnpm exec wrangler secret put GITHUB_APP_INSTALLATION_ID --config cloudflare/bug-reports/wrangler.jsonc
   pnpm exec wrangler secret put GITHUB_APP_PRIVATE_KEY --config cloudflare/bug-reports/wrangler.jsonc < key.pem
   ```
5. Deploy:
   `pnpm bugs:deploy`

This change set needs no D1 migration. The `ip_hash` column of migration `0002` holds the `/64` HMAC too.
After a deploy, the IPv6 limit starts from zero for one hour, because the new hashes differ from the old ones.

The private key can be a PKCS#1 key (`BEGIN RSA PRIVATE KEY`) or a PKCS#8 key (`BEGIN PRIVATE KEY`).

| Name | Kind | Meaning |
| --- | --- | --- |
| `GITHUB_APP_ID` | secret | App ID |
| `GITHUB_APP_INSTALLATION_ID` | secret | Installation ID |
| `GITHUB_APP_PRIVATE_KEY` | secret | App private key, PEM |
| `GITHUB_REPOSITORY` | var | `owner/name` of the repository that receives the issues |
| `GLOBAL_HOURLY_LIMIT` | var | Reports per hour from all installs (default 30) |
| `REPORTS_PAUSED` | var | `true` stops new reports with `503` |
| `DRY_RUN` | var | `true` files no issue and calls no GitHub API. For tests and local runs only. |

The suggested route is `bugs.seira.bot`. The app then uses `https://bugs.seira.bot/api/bug-reports`.
Forks must change the route, the repository variable, and the rate-limit namespace IDs in `wrangler.jsonc`.

## Test

1. `pnpm bugs:check` runs `wrangler types` and the type check.
2. `pnpm bugs:test` runs the tests.

The tests use a fake GitHub API and a fake D1 database. They need no network and no secrets.
CI runs both commands in the workflow `.github/workflows/bug-reports.yml`.
That workflow starts only when this folder changes.

## Try it with the app

Never point a local test at `seira-bot/seira`.
The simplest run uses dry-run mode: no GitHub App and no test repository.
To see a real issue, use a test repository and a test GitHub App.

1. Create a file `cloudflare/bug-reports/.dev.vars`. Git ignores it.
   For dry-run mode:
   ```
   DRY_RUN=true
   GITHUB_APP_ID=dry-run
   GITHUB_APP_INSTALLATION_ID=dry-run
   GITHUB_APP_PRIVATE_KEY=dry-run
   ```
   For a test repository:
   ```
   GITHUB_REPOSITORY=your-account/your-test-repo
   GITHUB_APP_ID=...
   GITHUB_APP_INSTALLATION_ID=...
   GITHUB_APP_PRIVATE_KEY="<the PEM text, with \n for each line break>"
   ```
2. Create the local database:
   `pnpm exec wrangler d1 migrations apply seira-bug-reports --local --config cloudflare/bug-reports/wrangler.jsonc`
3. Start the Worker:
   `pnpm exec wrangler dev --config cloudflare/bug-reports/wrangler.jsonc`
4. Start the app with `OMB_BUG_REPORT_URL=http://127.0.0.1:8787/api/bug-reports`. The app accepts `https` or loopback `http`.
5. Send a report with `@devs` in a conversation. Check the issue in the test repository.
   In dry-run mode, send a report with `curl` and read `issue`, `joined`, and `dryRun` in the answer:
   ```bash
   curl -s http://127.0.0.1:8787/api/bug-reports -H 'content-type: application/json' \
     -d '{"installId":"try-install-0001","source":"bot","description":"It failed.","appVersion":"0.0.0","platform":"linux","diagnostics":""}'
   ```
