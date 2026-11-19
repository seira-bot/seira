# Seira connected-apps broker

This Worker keeps the shared Composio project key out of desktop builds. Each
installation receives a random bearer token stored only as a SHA-256 hash in
D1. The Worker gives that installation its own Composio user/session, proxies
MCP traffic, and returns short-lived Connect Links to the local app.

The desktop never receives the project key. Authorization links are returned
only on demand and are never persisted in chat messages.

Deployment for this repository. Set `CLOUDFLARE_ACCOUNT_ID=<your account id>` for each command:

1. `pnpm broker:types`
2. `pnpm exec wrangler d1 migrations apply seira-composio --remote --config cloudflare/composio-broker/wrangler.jsonc`
3. To update an existing Worker, run `pnpm exec wrangler secret put COMPOSIO_API_KEY --config cloudflare/composio-broker/wrangler.jsonc`, then `pnpm broker:deploy`.
4. For the first deploy, put `COMPOSIO_API_KEY=...` in the ignored `.dev.vars.production` file. Run `pnpm exec wrangler deploy --config cloudflare/composio-broker/wrangler.jsonc --secrets-file .dev.vars.production`. Delete the file immediately afterward.

The Worker answers on the custom domain `apps.seira.bot`.

Forks should create their own D1 database and rate-limit namespaces, replace
the IDs in `wrangler.jsonc`, deploy under their own Worker name, and set
`OMB_COMPOSIO_BROKER_URL` in their packaged build. Running only the local
server with a Composio project key remains the no-Cloudflare self-host path.

Set `REGISTRATION_MODE` to `closed` to stop issuing new installation tokens
without affecting existing users.

## App events (Composio triggers)

The broker also receives Composio trigger events for every installation and
queues them until the installation's OMB server collects them. A desktop
needs no public URL: Composio posts to the broker, the server long-polls it.

```
Composio --signed POST--> /v1/composio/webhook --> D1 queue per installation <-- GET /v1/events (25 s long-poll)
```

### Routes

| Route | Auth | Does |
| --- | --- | --- |
| `POST /v1/composio/webhook` | Composio signature (`COMPOSIO_WEBHOOK_SECRET`) | Verifies the Standard Webhooks signature (300 s tolerance), routes `metadata.trigger_id` through `trigger_bindings`, requires `metadata.user_id` to be that installation's Composio user, and queues the event. A bad, missing or stale signature gets 401; an event no installation can take gets 200 and is only counted. |
| `GET /v1/trigger-types[?toolkits=a,b]` | installation token | Event types of the given toolkits (at most 10), or of the installation's active connected accounts. Types that need their own webhook endpoint are left out. Cached per isolate for an hour. |
| `GET /v1/trigger-types/:slug` | installation token | One event type with its config and payload schemas. |
| `POST /v1/triggers` `{slug, connectedAccountId, config}` | installation token | Checks that the account is this installation's, then `POST /trigger_instances/{slug}/upsert` and saves the binding. An identical config returns the same `triggerId`, so local triggers can share one. |
| `PATCH /v1/triggers/:triggerId` `{enabled}` | installation token | Enables or disables the instance at Composio (only disabled once no other binding wants it). A config change is a new `POST` plus a `DELETE` of the old instance. |
| `DELETE /v1/triggers/:triggerId` | installation token | Removes the binding, its queued events and drop counts, and the Composio instance once nothing else binds it. Also deletes an unbound instance of this installation's Composio user. |
| `GET /v1/triggers` | installation token | Bindings beside Composio's view (`remote.state`: `enabled`, `disabled` or `missing`), `unbound` instances, drop counts per trigger, limits and today's usage: everything the server's reconciliation needs. |
| `GET /v1/events?after=<seq>&wait=<0-25>&limit=<1-50>` + header `x-omb-poller` | installation token | Acks every event at or below `after`, then returns the next events in arrival order, holding up to `wait` seconds. One poller at a time per installation: another `x-omb-poller` gets 409 until the 90 s lease runs out. |
| `POST /v1/events/test` `{triggerId, data}` | installation token | Queues a synthetic event (`type: "omb.test"`) through the same queue and limits. |
| `PUT /v1/installation/cloud` `{grant}` | installation token | Marks the installation as a paid Cloud's from an Admin-signed grant. |
| `POST /v1/installation/share` `{for}` | installation token | A one-time code (10 minutes, only its hash kept) that lets the installation `for` act as this installation's Composio user. |
| `POST /v1/installation/adopt` `{code}` | installation token | Redeems a code minted for this installation: from then on it acts as that Composio user (`shared_user_id`). Refused with 409 `has_connections` while it has active connected accounts of its own, which stay reachable. The code is spent either way. |
| `DELETE /v1/installation` | installation token | Erases the installation and what it created at Composio. See [Erasing an installation](#erasing-an-installation-and-what-the-broker-keeps). |
| `GET /v1/stats/app-events?days=<1-90>` | `Bearer STATS_TOKEN` | Fleet totals per day (queued, delivered, duplicates, drops, expired, unrouted) and current counts. Counts only, never event contents or installation ids. |
| cron `23 * * * *` | | Expires events not collected within 7 days, disables at Composio the triggers of installations that have not polled for 14 days (re-enabled on their next poll), keeps daily counts for 90 days. |

### One person's desktop and Cloud

Composio ties every connected account to one user, and a tool router Session
uses only its own user's accounts, so a person's desktop and their own Cloud
share connected apps by acting as one Composio user. The desktop app mints a
code for the Cloud's installation id, which the Cloud reports to the app over
its owner session (the Admin verified that Cloud as the person's); the Cloud's
server redeems it. A code works only for the installation it names, once,
within 10 minutes. Sessions, the connected inventory, triggers and the event
routing all follow the installation's acting user; an instance one sharing
installation binds is never listed as unbound to the other. `GET /v1/me` adds
`user`, a digest of the acting user, equal on two installations exactly when
they reach the same apps.

Deploy order: apply `0004_shared_users.sql` first (additive), then the code.
Every query reads `installations.*`, so the new code also runs on a database
without it: `GET /v1/me` then carries no `user`, so no desktop tries to share,
and sharing answers 503 until it is applied.

### Limits

| | Desktop | Paid Cloud |
| --- | --- | --- |
| Events queued per UTC day | 500 | 2,000 |
| Waiting in the queue | 1,000 events or 20 MB | same |
| Event `data` stored | 64 KB, then a truncation marker with a preview | same |
| Kept when not collected | 7 days | same |

An event over a limit is answered 200 to Composio, not queued, and counted on
its trigger (`event_drops`, shown by `GET /v1/triggers`) and in the daily
counts. Status events (`composio.trigger.disabled`,
`composio.connected_account.expired`) skip the limits and carry ids only.

### Paid Clouds

Registration is open, so a Cloud proves its plan with a grant the Cloud Admin
signs. The grant is `v1.<machine id>.<signature>`, where the signature is
`base64url(HMAC-SHA256(CLOUD_GRANT_SECRET, "omb-connected-apps-cloud:v1\n" + machineId))`:

```js
import { createHmac } from "node:crypto";
const grant = `v1.${machineId}.${createHmac("sha256", CLOUD_GRANT_SECRET).update(`omb-connected-apps-cloud:v1\n${machineId}`).digest("base64url")}`;
```

The Admin sets it as the machine's `OMB_CLOUD_CONNECTED_APPS_GRANT` secret
for paid plans only. The Cloud's server presents it after registering
(`server/cloud-connected-apps.ts`). One machine id holds the Cloud limit on one
installation at a time: presenting the grant again moves it.

### Waking a sleeping Cloud

A Cloud on a plan that sleeps when idle collects its events only while it is
awake. When an event is queued (not dropped, not a duplicate) for an
installation that has a `cloud_machine_id` and is not polling (its poll lease
is unset or has run out), the broker asks the Cloud Admin to start that
machine, at most once a minute per installation (`wake_requested_at`):

```
POST <CLOUD_ADMIN_URL>/api/cloud/machines/wake
content-type: application/json
x-omb-wake-timestamp: <unix seconds>
x-omb-wake-signature: v1=<base64url(HMAC-SHA256(CLOUD_GRANT_SECRET, "omb-cloud-wake:v1\n" + timestamp + "\n" + machineId))>

{"machineId":"<machine id>"}
```

The Admin accepts a timestamp within 300 s, each signature once, and answers
`202 {waking}`. The request runs after Composio has been answered
(`ctx.waitUntil`); a refusal or failure is logged without the key and never
fails the event. It is off unless both `CLOUD_GRANT_SECRET` and
`CLOUD_ADMIN_URL` (an `https://` origin) are set, so a deploy without them
changes nothing.

### One-time owner setup, in this order

1. Apply the migration before deploying the code (the old code ignores the
   new tables and columns):
   `pnpm exec wrangler d1 migrations apply seira-composio --remote --config cloudflare/composio-broker/wrangler.jsonc`
2. Deploy as usual (`wrangler versions upload --preview-alias <name>`, check,
   then `wrangler versions deploy`). Until step 4 the webhook route answers
   503 and no client calls the new routes.
3. Create the project's webhook subscription. Composio allows one per
   project; check that there is none, then create it and copy the returned
   `secret`:

   ```sh
   curl -sS https://backend.composio.dev/api/v3.1/webhook_subscriptions -H "x-api-key: $COMPOSIO_API_KEY"
   curl -sS -X POST https://backend.composio.dev/api/v3.1/webhook_subscriptions \
     -H "x-api-key: $COMPOSIO_API_KEY" -H "content-type: application/json" \
     -d '{"webhook_url":"https://apps.seira.bot/v1/composio/webhook","enabled_events":["composio.trigger.message","composio.trigger.disabled","composio.connected_account.expired"],"version":"V3"}'
   ```

   If Composio refuses `composio.trigger.disabled`, leave it out: the server's
   reconciliation still sees a disabled trigger through `GET /v1/triggers`.
4. `pnpm exec wrangler secret put COMPOSIO_WEBHOOK_SECRET --config cloudflare/composio-broker/wrangler.jsonc`
   with that secret.
5. Optional, each with `wrangler secret put` and a fresh random value
   (`openssl rand -base64 32`): `CLOUD_GRANT_SECRET` (shared with the Cloud
   Admin, which mints the grants) and `STATS_TOKEN` (given to Admin for the
   fleet counter). Without them, `PUT /v1/installation/cloud` answers 503 and
   the stats route 404.
6. Waking sleeping Clouds (at launch of a plan that sleeps): apply migration
   `0003_cloud_wake.sql` (step 1) before deploying the code that uses it, then
   set `CLOUD_ADMIN_URL` to the Cloud Admin's origin
   (`https://cloud.openmausbot.com`). Either add it to `vars` in
   `wrangler.jsonc` in a PR, or `wrangler secret put CLOUD_ADMIN_URL`: a
   deploy replaces variables set in the dashboard, but keeps secrets. Without
   it (or without `CLOUD_GRANT_SECRET`) the broker never asks the Admin to wake
   anything.
7. Idle sweep progress: apply migration `0005_trigger_sweep_progress.sql`
   (step 1) before you run `pnpm broker:deploy`. A push to `main` does not
   deploy the broker. Without it, the hourly sweep of idle installations
   fails after it has expired old events.

## Erasing an installation and what the broker keeps

`DELETE /v1/installation`, with the installation's own token:

| Answer | Means |
| --- | --- |
| `200 {erased: true, sharedUserKept}` | Everything is gone and the token no longer works. |
| `202 {erased: false, more: true}` | Call again. One call makes at most 30 Composio deletes, to stay inside a Worker's per-request limits. |
| `401` | Bad token, or already erased. |
| `429`, `502`, `503` | Nothing is lost: the token still works, so call again. Finished work is not redone. |

It removes share codes the installation minted or was named in, then at
Composio its triggers and connected accounts (`revoke_on_delete=true`), then in
one D1 transaction its rows in `trigger_bindings`, `events`, `event_drops`,
`app_event_days`, `user_shares` and last `installations`. Before that
transaction, it adds its `usage_days` counts to the `''` row and deletes its
own rows. It needs migrations through `0004`; before that it answers 503 and
changes nothing.

A trigger another installation also binds stays at Composio. A Composio user
another live installation still acts as (a desktop and its Cloud) keeps its
connected accounts and unbound triggers: `sharedUserKept` is `true`, and they go
when the last installation using that user is erased. An installation that
adopted a shared user also clears its own original Composio user.

Kept without an erase:

| Data | Kept |
| --- | --- |
| `installations` | Indefinitely: only an erase removes a row. |
| `events` | Unread: 7 days. Read: body cleared at once, the id kept for 7 days to spot duplicates. |
| `trigger_bindings`, `event_drops` | Until the trigger is deleted. |
| `app_event_days`, `usage_days`, `registration_days`, `usage_alerts` | 90 days. Counts only. `registration_days` holds a hash of the address, never the address. |
| `user_shares` | Until used; an expired code, until the next code is minted. Hash only. |
| Composio connected accounts and triggers | Until disconnected or deleted. A trigger is only paused after 14 days without a poll. |

An erase does not reach Composio's tool router Sessions (the broker has no call
that deletes one), the `''` rows of `app_event_days` and `usage_days` (counts no
installation owns), Worker logs (which carry installation ids), or a copy of the token on
the customer's side.

## Usage limits and cost watch

Composio bills the project for each tool call and each trigger event. These
limits keep one installation, or a fault, from running up that bill. They need
migration `0007_usage_limits.sql`. Before that migration, the Worker logs
`usage limits unavailable` and lets every request through.

### Limits and their defaults

Each limit is a row in the `broker_settings` table. A missing row uses the
default. A value of `0` turns that limit off. Days are UTC days.

| Key | Default | Limits |
| --- | --- | --- |
| `quota.tool_calls.desktop` | `500` | Tool calls per installation per day. |
| `quota.tool_calls.cloud` | `2000` | Tool calls per Cloud installation per day. |
| `quota.connect_links` | `30` | Sign-in links per installation per day. |
| `quota.triggers` | `50` | Triggers one installation can have. |
| `quota.registrations_per_ip` | `50` | New installations per IPv4 address or IPv6 /64 per day. |
| `budget.tool_calls_per_day` | `10000` | Tool calls by all installations together per day. |
| `units.workbench` | `10` | Tool calls that one remote workbench or bash call counts as (at least 1). |
| `tools.workbench` | `on` | `off` refuses the remote workbench and bash meta tools. |

One `COMPOSIO_MULTI_EXECUTE_TOOL` call counts once for each tool in it.
`COMPOSIO_SEARCH_TOOLS` and other MCP methods do not count. A
`COMPOSIO_REMOTE_WORKBENCH` or `COMPOSIO_REMOTE_BASH_TOOL` call runs code at
Composio that can call more tools, which the broker cannot see, so it counts
as `units.workbench` tool calls. A multi-execute call nested in another counts
by its own tools; a call nested deeper than three levels is refused, also with
every limit off. A batch over the quota is refused whole. The fleet budget is approximate: each Worker isolate
reads the fleet total again after 60 seconds.

A refused tool call gets a JSON-RPC result with `isError: true` and a text
that tells the person what to do. The other refusals:

| Refused | Answer |
| --- | --- |
| Sign-in link over the quota | `429`, `retry-after` until 00:00 UTC |
| Trigger over the cap | `409` |
| Registration over the per-address quota | `429` |
| Paused route | `503`, `retry-after: 300` |

### Kill switch

The `pause` setting stops Composio use with no redeploy. Each isolate reads
the settings again after 30 seconds.

| `pause` | Stops |
| --- | --- |
| `none` | Nothing (default). |
| `new` | New installations, new sign-in links (also `COMPOSIO_MANAGE_CONNECTIONS`, and the remote workbench and bash meta tools, through MCP), and new triggers. Other tool calls continue. |
| `tools` | The same as `new`, plus every tool call. |
| `all` | Every route that reaches Composio, except deletes. Trigger events still arrive: to stop them, disable the webhook subscription in the Composio dashboard. |

Set a value (here `pause` to `tools`):

```sh
pnpm exec wrangler d1 execute seira-composio --remote --config cloudflare/composio-broker/wrangler.jsonc \
  --command "INSERT INTO broker_settings (key, value, updated_at) VALUES ('pause', 'tools', unixepoch() * 1000)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
```

Use the same command for each key in the limits table. A value that is not a
number is ignored, logged as `broker setting ignored, default used`, and the
default applies. To go back to a default, delete the row. To stop one
installation, set `disabled_at` on its `installations` row.

### Daily counts and alerts

`usage_days` keeps counts per installation per day, and `registration_days`
keeps counts per hashed address per day. Both keep 90 days. An erase moves the
installation's counts to the `''` row, so the fleet totals stay right.

`GET /v1/stats/usage?days=<1-90>` with `Authorization: Bearer <STATS_TOKEN>`
returns the daily fleet counts, the month so far, an estimated Composio bill,
the pause level, and the settings in force. It holds no installation id.

The hourly cron sends each alert at most once per UTC day:

| Alert | When |
| --- | --- |
| `budget-near` | Today's tool calls reach `alert.budget_ratio` (`0.8`) of the fleet budget. |
| `budget-reached` | Today's tool calls reach the fleet budget. |
| `paused` | `pause` is not `none`. |
| `month-cost` | The month's estimated bill reaches `alert.usd_per_month` (`50`). |
| `registrations` | Today's new installations reach `alert.registrations_per_day` (`1000`). |
| `daily-summary` | Once a day, the counts of the day before. Set `alert.daily_summary` to `off` to stop it. |

The estimate uses the `price.*` settings: `price.plan_usd` (`29`),
`price.credit_usd` (`29`), `price.tool_calls_included` (`20000`),
`price.usd_per_1k_tool_calls` (`2`), `price.trigger_events_included` (`10000`)
and `price.usd_per_1k_trigger_events` (`6`). Set them to the project's plan.
The trigger event count includes the events the broker did not keep, because
Composio bills each delivery.

Alerts go to `ALERT_WEBHOOK_URL`, an `https` URL set with `wrangler secret put`:

| Channel | `ALERT_WEBHOOK_URL` | Also set |
| --- | --- | --- |
| Telegram | `https://api.telegram.org/bot<token>/sendMessage` | `ALERT_CHAT_ID` (a secret) |
| Discord | The channel webhook URL | |
| Slack and others | An incoming webhook URL that accepts `{text}` | |

Without it, each alert is a `usage alert` warning in the Worker logs. A
failed post is sent again the next hour.

### Deploy order

1. Apply migration `0007_usage_limits.sql` (owner setup, step 1).
2. Deploy the Worker.
3. Optional: set `ALERT_WEBHOOK_URL` (and `ALERT_CHAT_ID` for Telegram) and
   `STATS_TOKEN`.
4. Optional: set the limits and prices in `broker_settings`.
