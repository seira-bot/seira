# Seira updates list

This Worker keeps the "Get Seira updates" email list. It uses double opt-in.
It runs at `updates.seira.bot`. It stores the list in D1. It sends email with Cloudflare Email Sending.

## Routes

| Route | Auth | Action |
| --- | --- | --- |
| `POST /api/updates-consent` | none, rate limited | Save an opt-in and send a confirmation email. Or withdraw a receipt. |
| `GET /confirm?t=TOKEN` | none | Show a confirm button. It does not confirm. |
| `POST /confirm` | none | Confirm the address. The link is valid for 7 days. |
| `GET /unsubscribe?t=TOKEN` | none | Show an unsubscribe button. |
| `POST /unsubscribe?t=TOKEN` | none | Unsubscribe. Accepts the one-click body `List-Unsubscribe=One-Click`. |
| `GET /admin/stats` | bearer token | Count subscribers by status. |
| `POST /admin/send` | bearer token | Send an update to confirmed subscribers, or one test email. |

The app sends `{status: "opted_in", email, installId, textVersion}` and gets `{receipt}`.
The app sends `{status: "withdrawn" | "declined", receipt}` to withdraw.
An app withdrawal ends only a subscription that the same confirmation email confirmed. Every update email has its own unsubscribe link.
The Worker stores only SHA-256 hashes of receipts and confirmation tokens.
The Worker sends a new confirmation email only when the address has no open link or the last email is more than 10 minutes old.
Only a confirm clears the open link. A withdrawal does not.

## Deploy

Set `CLOUDFLARE_ACCOUNT_ID` in the environment for each command.

1. `pnpm updates:types`
2. `pnpm exec wrangler d1 migrations apply seira-updates --remote --config cloudflare/updates/wrangler.jsonc`
3. `pnpm exec wrangler secret put ADMIN_TOKEN --config cloudflare/updates/wrangler.jsonc`
4. `pnpm updates:deploy`

Forks must replace the D1 database ID, the rate-limit namespace ID, the domain, and the sender address in `wrangler.jsonc`.
The sender domain must be onboarded to Cloudflare Email Sending.

## Send an update

Put the admin token in `SEIRA_UPDATES_ADMIN_TOKEN`. Write the message in a text file.

```bash
node cloudflare/updates/scripts/send-update.mjs --dry-run
node cloudflare/updates/scripts/send-update.mjs --subject "Seira news" --text-file update.txt --test you@example.com
node cloudflare/updates/scripts/send-update.mjs --subject "Seira news" --text-file update.txt
```

Add `--html-file` for an HTML version. Add `--origin` to use another Worker URL.
The script sends in batches of 25 and prints the totals and each failed address.
A test email has no unsubscribe link.
