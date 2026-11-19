# Seira bug reports

This Worker receives bug reports from the Seira app.
It files each report as a GitHub issue in `seira-bot/seira`.
It uses a GitHub App installation token. The app holds no GitHub token.
It runs at `bugs.seira.bot`. It stores a small index in D1.

## Routes

| Route | Auth | Action |
| --- | --- | --- |
| `POST /api/bug-reports` | none, rate limited | File a report. Answer `201 {id}`. |
| `POST /api/bug-reports/status` | none, rate limited | Answer the status of the reports that one install sent. |
| `GET /health` | none | Answer `ok`. |

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
| Reports per IP address | 10 in 3,600 seconds, whatever the install ID |
| Reports from all installs | `GLOBAL_HOURLY_LIMIT` in 3,600 seconds (default 30) |
| Requests per IP address | 10 per minute for reports, 60 per minute for status |
| Report size | 600 KB |
| Status request size | 16 KB, 50 IDs |

A refused request gets `429` with `retryAfter` and a `Retry-After` header.
A failed GitHub call gets `502`. The app sends the report again later.
A failed call does not count in the limits.
D1 keeps an HMAC of the IP address, not the address. D1 keeps the HMAC for at most one hour.
The HMAC key comes from the App private key with HKDF.

To stop all new reports, set the var `REPORTS_PAUSED` to `true` and deploy.
The Worker then answers `503` to `POST /api/bug-reports`. It does not call GitHub and does not write D1.
The status route keeps working.

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
   `pnpm exec wrangler deploy --config cloudflare/bug-reports/wrangler.jsonc`

The private key can be a PKCS#1 key (`BEGIN RSA PRIVATE KEY`) or a PKCS#8 key (`BEGIN PRIVATE KEY`).

| Name | Kind | Meaning |
| --- | --- | --- |
| `GITHUB_APP_ID` | secret | App ID |
| `GITHUB_APP_INSTALLATION_ID` | secret | Installation ID |
| `GITHUB_APP_PRIVATE_KEY` | secret | App private key, PEM |
| `GITHUB_REPOSITORY` | var | `owner/name` of the repository that receives the issues |
| `GLOBAL_HOURLY_LIMIT` | var | Reports per hour from all installs (default 30) |
| `REPORTS_PAUSED` | var | `true` stops new reports with `503` |

The suggested route is `bugs.seira.bot`. The app then uses `https://bugs.seira.bot/api/bug-reports`.
Forks must change the route, the repository variable, and the rate-limit namespace IDs in `wrangler.jsonc`.

## Test

1. `pnpm exec wrangler types --config cloudflare/bug-reports/wrangler.jsonc cloudflare/bug-reports/worker-configuration.d.ts`
2. `pnpm exec tsc -p cloudflare/bug-reports/tsconfig.json`
3. `pnpm exec vitest run --config cloudflare/bug-reports/vitest.config.ts`

The tests use a fake GitHub API and a fake D1 database. They need no network and no secrets.

## Try it with the app

Never point a local test at `seira-bot/seira`. Use a test repository and a test GitHub App.

1. Create a file `cloudflare/bug-reports/.dev.vars`. Git ignores it.
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
