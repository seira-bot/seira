# A new bot made once, even when its answer is lost

What it covers: `POST /api/bots` from the app, from `seira` team apply and from
the `create_bot` MCP tool. Each request names an id of its own and sends
`fresh: true`. When no answer comes back, the client sends the same request
again with the same id. The server refuses a known id with 409, so the first
request's bot stays the only one.

Run it on the isolated fixture ([Verifying Seira](README.md)): start
`node --experimental-strip-types scripts/control-seira.ts launch`, then use the
printed URL. Never use the live app.

1. Send `POST /api/bots` with `{"name":"a","useDefaults":false}` and destroy
   the socket before reading the answer. Send the same request again. Expect
   201 and two bots named `a`: a request without an id cannot be told from a
   new one.
2. Send `{"name":"b","id":"client-made-0001","fresh":true,"useDefaults":false}`
   and destroy the socket the same way. Send it again. Expect 409
   (`a bot with this id already exists here`) and one bot named `b`.
3. `GET /api/bots/client-made-0001` answers that bot, with its greeting.
4. Send `{"name":"c","id":"moved-in-0001","useDefaults":false}`. An id without
   `fresh` is a bot moved in from another computer: expect 201 and no greeting.
5. Send `"fresh":"yes"`. Expect 400.

A Team Cloud member may name an id only with `fresh: true`; `threadId` stays an
admin's.

Not covered: killing the server process between the save and the answer. The
chaos round repeats that case.
