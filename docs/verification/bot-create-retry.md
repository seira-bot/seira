# A new bot made once, even when its answer is lost

What it covers: `POST /api/bots` from the app, from `seira` team apply and from
the `create_bot` MCP tool. Each request carries a `retryKey` of its own. The
server makes the bot's id. It keeps, for a short while, which bot a key made for
the one who sent it. When no answer comes back, the client sends the same
request again with the same key and gets the first request's bot.

Run it on the isolated fixture ([Verifying Seira](README.md)): start
`node --experimental-strip-types scripts/control-seira.ts launch`, then use the
printed URL. Never use the live app.

1. Send `POST /api/bots` with `{"name":"a","useDefaults":false}` and destroy
   the socket before reading the answer. Send the same request again. Expect
   201 and two bots named `a`: a request without a key cannot be told from a
   new one.
2. Send `{"name":"b","retryKey":"retry-key-0000001","useDefaults":false}` and
   destroy the socket the same way. Send it again. Expect 200, the same bot id,
   and one bot named `b`.
3. Send `"retryKey":"short"`. Expect 400.
4. With a Team Cloud fixture and two members: member 1 sends
   `{"name":"c","retryKey":"retry-key-0000002"}`. Member 2 sends the same key.
   Expect 201 and a different bot id: nothing of member 1's bot shows. Member 1
   sends the key again. Expect 200 and member 1's first bot, and one bot made
   by member 1.
5. As a member, send `{"name":"d","id":"<any id>"}`. Expect 403 whether or not
   that id exists. `id` and `threadId` stay an admin's.

Not covered: killing the server process between the save and the answer. The
key is kept in memory, so a restart forgets it and a resend after a restart
makes a second bot. The chaos round repeats that case.
