# Linked places

A link joins two Seira servers that belong to different owners. A bot on one
side can then give work to a bot on the other side, and the result comes back
to the thread that asked. This page is for contributors. It describes the rules
that the code keeps.

## How a link starts

1. An admin of server A opens Settings, then Linked places (Advanced mode),
   and chooses Make an invite. The invite is a text that starts with
   `seira-link:`.
2. The admin sends the invite to an admin of server B.
3. The admin of B chooses Join with an invite and pastes the text.
4. Both sides now list the other side by name.

An invite works once. It stops working after 15 minutes. The server keeps only
a hash of the invite code.

Each side can hold at most 20 links.

## What each side chooses

A new link exposes no bot. An admin of each side does two things for that
side:

- The admin chooses which bots of this side the other side may give work to.
  The other side sees only these bots, each as id, name, title and description.
- The admin chooses an approval cap: `ask`, `edits` or `auto`. The default is
  `ask`.

Work from the other side runs here as outside work. It runs at the approval
mode of the bot, but never above the cap of the link. When the work of two or
more links meets in one thread, the lowest cap applies.

A change to the bots or the cap applies to the next hand-off. No restart is
needed.

| Cap | What work from the other side may do without a person here |
|-----|----------------------------------------------------------------|
| `ask` | Nothing. A person here approves each command and each file change. |
| `edits` | Edit files. A person here approves everything else. |
| `auto` | Run commands. No person here is asked. |

## What a link carries

- Hand-offs, in both directions, with their results.
- Files that belong to a hand-off.

Work that the other side started here cannot go on to a bot of a third server.

## What the other side cannot send

The other side holds a credential, but this side does not trust what it sends.

- Names, hand-off texts, result texts and file names lose their control and
  invisible characters before a bot or a person reads them. A name becomes one
  short line.
- A frame whose id holds anything but letters, digits, `_` and `-` is dropped.
- A frame is cleaned only after it passes the size limits. A frame with no
  room in the character limit waits at the sender and is not lost.
- An error inside this server gives the other side a fixed answer. The cause
  goes to the log of this side only.

## Limits

| Limit | Value |
|-------|-------|
| Links per server | 20 |
| Open hand-offs per link | 8 |
| New hand-offs per link | 30 in 60 seconds |
| Work frames per link | 150 in a minute |
| Characters of frames per link | 300,000 in 60 seconds |
| Bytes of exchange bodies per link | 6,000,000 in 60 seconds, each direction; one request at most 5,500,000 |
| Bytes of work frames a side sends per link | 3,000,000 in 60 seconds |
| Log lines per link | 20 in a minute |
| Unacknowledged frames per link | 2,000 |
| Records per link | 1,000 |
| File size | 100 MB |
| Files held for a link | 16 hand-offs, 320 files, 2 GiB, about 1 day |
| Exchanges per link | 120 in 60 seconds |
| New sessions per link | 10 in 60 seconds |
| File download | 10 minutes in total, and 60 seconds with no bytes |

The joining side keeps at least 1 second between exchanges and 10 seconds
between new sessions. A sending side holds its work frames for 5 to 10 seconds
after the other side took none of a batch. An honest pair stays below these
limits, also after a restart of either side.

## Who may change a link

Only an admin. The routes under `/api/linked-servers` answer an admin only. The
requests that the two servers send to each other do not use a person's sign-in.
They use the one credential that the invite created. That credential reaches the
exchange and file paths of its own link and nothing else.

## Removing a link

Either side can remove a link. Removing it stops the work that the link
started, on both sides. The other side shows the link as ended until an admin
removes it there too. To link again, make a new invite.

## Where it shows

| Place | What it shows |
|-------|---------------|
| Settings, then Linked places | Each link: the name of the other side, its state, the bots this side exposes, the cap, and the bots of the other side. |
| Settings, then Data, then Activity (a place opened in a browser) | Rows in the category Linked places: an invite made, a join, a change, a removal, each hand-off and each refused hand-off. A row names the other side and never holds a credential. |

The page shows only in Advanced mode, and only to an admin of a place that is
not a paired client.

## Known limits and open risks

- Only the side that makes the invite needs an https address. The joining
  side calls the inviter at that address, so the joining side needs no public
  address. A place with no https address cannot make an invite.
- A bot that works for the other side can make a routine. That routine later
  starts work that the link rules do not see. The approval caps `ask` and
  `edits` still ask a person here for the tool that the routine uses.
- Texts that a bot writes go to the other side as written. A bot can put any
  text in a hand-off or in a result. An admin who exposes a bot trusts the other
  side with what that bot knows.
- The approval cap `auto` lets work from the other side run commands on this
  side without asking anyone. Use it only with a side that the admin trusts.
- The names that the other side gives itself and its bots reach the lists here.
  Each name is cleaned to one short line.
- A side whose hand-off files never arrive keeps the open slots of those
  hand-offs. A link allows at most 8 open hand-offs and 30 new hand-offs in
  each minute.
- A bot that an admin exposes can give the other side's work to bots here
  that are not exposed. The approval cap of the link still applies to that
  work.
- A link can hold up to 2 GiB of files for about 1 day. The attachment store
  has no quota per link.
- Each new thread from the other side makes a new conversation here. Nothing
  removes it.
- When both sides hold 2,000 unacknowledged frames, neither side takes new
  work until acknowledgements arrive.
- A file of 100 MB needs at least 1.4 Mbit/s to pass the 10-minute limit. A
  file name longer than 255 UTF-16 units does not cross a link.
- The address in an invite must be https. An https address that points to a
  private network is accepted.
- A link carries at most 300,000 characters of frames a minute in each
  direction. That is about one and a half results of the largest size. The
  other frames wait at the sender; none are lost.
- A hostile side can use about 2 to 2.5 seconds of this server's time in each
  minute for each link, and about 4 to 5 seconds in one minute that spans two
  windows.
- A side that fills its 20 log lines a minute also hides this server's own
  log lines about that link.
- When the clock of the computer jumps back, the limits of a link stop its
  traffic for the size of the jump and one minute more.

## Where the code is

- `server/host/linked-servers.ts` keeps the links and the exchange.
- `server/host/linked-servers-admit.ts` holds the intake limits.
- `server/host/linked-servers-text.ts` cleans what the other side sends.
- `server/routes/bot-link-exchange.ts` holds the exchange and the file route.
- `server/routes/linked-servers.ts` holds the admin routes.
- `src/components/LinkedServersSection.tsx` is the page.
- `src/components/LinkedA2aForm.tsx` holds the A2A agent form and its token box.
- `docs/verification/linked-servers.md` tells how to check all of it.

## Links to A2A agents

An A2A agent is an agent of another product that speaks the open A2A protocol.
An admin links it from the same page with Add an A2A agent. The link can run in
two directions. Each direction is a choice of the admin.

- This Seira calls the agent. The admin gives the address of the agent, and a
  token when the agent wants one. The agent then shows as a teammate here.
- The agent calls this Seira. This Seira makes a token and shows it once. After
  the admin chooses the bots that the agent may use, each chosen bot shows one
  address. The agent uses that address and the token.

What the agent can and cannot do:

- The agent can use only the bots that the admin exposes on the link.
- The approval cap of the link applies to its work, as for a link to another
  Seira.
- Work that the agent started here cannot go on to another A2A agent.
- A token opens the A2A addresses of its own agent and nothing else.

New token makes a new token for an agent that calls in. The old token stops
working at once. Removing the link stops the work of the agent.

Limits that differ from a link to another Seira:

- An agent that calls in can make 600 requests in each minute. It can hold 8
  requests open at one time. A request is held for 55 seconds at most.
- A request body of the agent is at most 64 KiB.
- An agent that calls in can keep 50 conversations here.
- This Seira can have 8 open hand-offs to one agent, and 30 new hand-offs in
  each minute. This Seira stops waiting for a hand-off after 6 hours.
- A result text is cut at 200,000 characters. A status note is cut at 2,000
  characters.
- This Seira waits 10 seconds for the card of an agent and 60 seconds for the
  answer to a call.

The Activity page has a row when an agent is added and when a new token is
made. A row names the agent and never holds a token.
