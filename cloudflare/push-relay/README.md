# Seira push relay

This Worker sends phone push notifications for Seira.
The Seira server asks it to wake the phone app. The relay calls APNs (iOS) or FCM (Android).
It runs at `push.seira.bot` as the Worker `seira-push`. It stores installations and tokens in D1.

The relay has no accounts. A Seira server enrolls itself and gets a credential for its installation.
The push code comes from `cloudflare/control-plane`. This Worker removes the accounts and adds anonymous enrollment.

## Routes

| Route | Auth | Answer |
| --- | --- | --- |
| `GET /healthz` | none | `200 {ok, service: "seira-push", apns, fcm}`. `apns` and `fcm` say whether the secrets are set. |
| `POST /v1/push/enroll` | none | Body `{"v":1}`. Answer `201 {installationId, credential, expiresAt}`. |
| `POST /v1/installations/self/push/register` | Bearer | `200 {registered: true}` |
| `POST /v1/installations/self/push/unregister` | Bearer | `204`, also when the token is not stored |
| `POST /v1/installations/self/push/send` | Bearer | `202 {sent: true}` |
| `POST /v1/installations/self/push/activity` | Bearer | `503 push_unavailable` until the Live Activity change lands |
| `POST /v1/installations/self/credentials/rotate` | Bearer | `200 {credential, expiresAt}`. The old credential stops working. |
| `DELETE /v1/installations/self` | Bearer | `204`. The installation, its credentials, and its tokens are gone. |

Every error answer is `{"error": "<code>"}`. A `429` carries `retry-after`.

- A request with an `Origin` header gets `403 forbidden`.
- An unknown path gets `404 not_found`. A wrong method gets `405`.
- A body over 16 KB, a body that is not JSON, or a body of the wrong shape gets `400 invalid_request`.
- A missing, malformed, unknown, wrong, expired, or revoked credential gets `401 unauthorized`. No provider is called.

The wire bodies of register, unregister, and send are the ones in `src/payload.ts`. Do not change them.

### Send answers

| Answer | Meaning |
| --- | --- |
| `202` | The provider took the push. |
| `404 push_device_unknown` | The token is not an alert token of this installation. |
| `410 push_device_unregistered` | The provider says the token is dead. The relay deleted it. |
| `429` | A limit, a block, or a provider throttle. See `retry-after`. |
| `503 push_unavailable` | The platform has no secrets, the provider refused the relay key, or `PUSH_PAUSED` is on. |
| `502 push_failed` | Another provider failure. |

## Credential

The format is `seira_install_<lookup>.<secret>`. The lookup is 22 characters. The secret is 43 characters.
The credential lasts 90 days. The server rotates it before it ends.
D1 keeps only the SHA-256 hash of the whole credential. The Worker compares digests in constant time.

## Payload contract, version 1

The payload is for the native phone apps. It holds no `botName`, no `roomName`, and no text except `title`.

APNs alert, headers: `apns-push-type: alert`, `apns-priority: 10`, `apns-expiration` (now + 24 hours),
`apns-topic` (the bundle id), and `apns-collapse-id` (the `collapseId` of the request, or a hash of kind and thread).

```json
{
  "aps": { "alert": { "title": "..." }, "sound": "default", "thread-id": "...", "category": "OPENMAUS_APPROVAL", "interruption-level": "time-sensitive" },
  "v": 1, "kind": "approval", "botId": "...", "threadId": "...",
  "pairing": "...", "roomId": "...", "requestId": "..."
}
```

FCM, a data-only message. Every data value is a string.

```json
{
  "message": {
    "token": "...",
    "data": { "v": "1", "kind": "approval", "botId": "...", "threadId": "...", "title": "...", "tag": "<collapse id>", "channelId": "approval_question", "pairing": "...", "roomId": "...", "requestId": "..." },
    "android": { "priority": "HIGH", "ttl": "86400s" }
  }
}
```

`pairing`, `roomId`, and `requestId` appear only when the request has them.
`KIND_PRESENTATION` in `src/payload.ts` maps each kind to its iOS category, its Android channel,
and its interruption level. The shipped phone apps use these ids. Do not rename them.

## Limits and settings

| Limit | Value |
| --- | --- |
| Requests per IP address | 300 per minute (`REQUEST_LIMITER`), all routes except `/healthz` |
| Enrolls per IP address | 3 per minute (`ENROLL_LIMITER`), and `ENROLL_PER_IP_DAILY` per UTC day (default 5) |
| Enrolls from all addresses | `ENROLL_GLOBAL_DAILY` per UTC day (default 2000) |
| Registers per installation | 120 per hour |
| Tokens per installation | 50 |
| Sends per installation | 600 per hour |
| Sends per token and installation | 60 per hour |
| Sends per token, all installations | `TOKEN_DAILY` per UTC day (default 300) |
| Sends from all installations | `SEND_GLOBAL_HOURLY` per hour (default 20000) |
| Dead-token answers per installation | 20 in one hour block the sends of that installation for 24 hours |

An IPv6 address counts as its `/64` prefix. The daily enroll limit keys on an HMAC of that prefix, not on the address.
The relay keeps no raw IP address and no message text.
A cron trigger (03:17 UTC) deletes installations unused for 90 days, old credentials, and old counters.

Other variables: `APNS_ENVIRONMENTS` (`production`, `sandbox`, or both with a comma), `PUSH_PAUSED`, `ENROLL_PAUSED`.

## Secrets

The names only. Never put a value in git, in an issue, or in a log.

| Name | Use |
| --- | --- |
| `IP_HASH_KEY` | Required. Keys the hash of the IP address. Without it, enroll answers `503`. |
| `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY`, `APNS_BUNDLE_ID` | Optional. Turn on iOS. |
| `FCM_SERVICE_ACCOUNT` | Optional. The service-account JSON file of Firebase, whole. Turns on Android. |

The Worker logs at most one JSON line per failure, with only `message`, `status`, `platform`, and `reason`.

## Test

```sh
pnpm push:check   # wrangler types, then tsc
pnpm push:test    # vitest, with a fake APNs, a fake FCM, and a fake D1 on node:sqlite
```

The tests use no network and no real key. The fake D1 runs the real migrations.

## Kill switches

- `PUSH_PAUSED` set to `"true"`: register, send, and activity answer `503 push_unavailable` before any D1 read.
- `ENROLL_PAUSED` set to `"true"`: enroll answers `503 enroll_unavailable`.

Change the var in `wrangler.jsonc` and deploy. Rotate, delete, and `/healthz` keep working.

## First deploy (operator)

Each step needs the approval of the owner. Do not run one on your own.

1. Create the D1 database `seira-push`. Put its id in `database_id` in `wrangler.jsonc`. The file holds a placeholder.
2. Apply the migrations to the remote database: `wrangler d1 migrations apply seira-push --remote --config cloudflare/push-relay/wrangler.jsonc`.
3. Set `IP_HASH_KEY` and the secrets of each platform with `wrangler secret put`.
4. Run `pnpm push:deploy`.
5. Check `https://push.seira.bot/healthz`. It must answer `ok: true` with the right `apns` and `fcm` values.

## Rollback

Run `wrangler rollback`. Or set `PUSH_PAUSED` to `"true"` and deploy.
