# Linked places: two servers, one link

## Sub-features

- An admin makes an invite, and an admin of another server joins with it.
- Each side exposes chosen bots and sets an approval cap.
- Work crosses the link as outside work, at no more than the cap.
- Either side removes the link.
- Each step writes an activity row without a credential.

The rules are in [Linked places](../linked-servers.md).

## Two servers and a hand-off

`server/linked-servers.e2e.test.ts` starts two fixtures that belong to different
owners. It makes an invite on one, joins on the other, exposes a bot, hands work
across, checks the approval level on the working side, and removes the link.
Only the provider turns are scripted.

```sh
pnpm exec vitest run server/linked-servers.e2e.test.ts
```

The test passes when every case passes. The fixtures have no secure public
address, so the test points the invite at the loopback address of the inviter
before it joins.

## The Settings page

The page has a component test and a settings test:

```sh
pnpm exec vitest run src/components/LinkedServersSection.dom.test.ts src/components/settings/settings-index.test.ts
```

To see the page in a fixture, follow [Chat UI, driven headlessly](chat-ui.md)
and launch the UI fixture. Then do these steps:

1. Click the sidebar `button "Settings"`.
2. Turn on Advanced mode at the bottom of the list of pages.
3. Click `button "Linked places"`.
4. Read a full snapshot, not `--interactive`. The empty list shows one sentence
   and the buttons `Make an invite` and `Join with an invite`.
5. Click `Make an invite`. A fixture has no secure public address, so the page
   shows the plain refusal and no invite.
6. Click `Join with an invite`, type a text that is not an invite, and click
   `Join`. The page keeps the text and shows the refusal.

A fixture that has a secure public address, such as the first fixture of the
e2e test, shows the invite text. The page says that the invite works once and for
a short time.

To fill the list, run the e2e test and read the page of either fixture. Each
page lists the other side by name, its state, the exposed bots and the cap.
Change a cap, save, and hand work over again. The next hand-off uses the new
cap without a restart.

## Activity

Open the same server in a browser. Open Settings, then Data, then Activity, and choose Linked places in the filter.
Each step above has a row. A row names the other side. No row holds an invite or
a token.

## A2A agents

`server/a2a.e2e.test.ts` starts two servers. One plays the agent. The test adds
the agent in both directions, makes a new token, hands work across, and removes
the agent.

```sh
pnpm exec vitest run server/a2a.e2e.test.ts
```

To check the page, open Settings, then Linked places, and choose Add an A2A
agent.

1. Leave the name empty. The button stays off and says why.
2. Enter a name, turn on The agent calls this Seira, and add. The page shows a
   token once, with one address for each exposed bot.
3. Choose Done. The token is gone and cannot be shown again.
4. Choose New token on the agent and confirm. The old token stops working.

## Not proven here

- A real second owner on a separate network. The fixtures share one machine.
- An https address that a person controls. The test uses the loopback address.
