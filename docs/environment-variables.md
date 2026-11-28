# Environment variables

Every setting Seira reads from the environment starts with `SEIRA_`, for example `SEIRA_DATA_DIR`, `SEIRA_PORT`,
`SEIRA_PUBLIC_URL`, `SEIRA_JEV_API_KEY` and `SEIRA_<PROVIDER>_API_KEY`.

## Moving from `OMB_`

Versions before v0.1.182 read the same settings under the prefix `OMB_`. The old names still work, as a deprecated
fallback:

- At start, Seira renames each `OMB_<NAME>` to `SEIRA_<NAME>` inside its own process, so engines, tools and child
  processes only ever see the `SEIRA_` name.
- Each old name prints one warning per process that names the variable and never its value.
- When both names are set to different values, `SEIRA_<NAME>` wins and a warning says so. An empty `SEIRA_<NAME>` counts as not set.
- The fallback is removed two minor releases after v0.1.182. Rename the variables in your service files, `.env` files and
  scripts before then. The old names stay filtered after the fallback is removed.

In Docker, rename `OMB_*` to `SEIRA_*` in your `.env` file. The server image sets some variables itself, such as
`SEIRA_DATA_DIR` and `SEIRA_PORT`, and the fallback never applies to those: your `OMB_` value loses to the image's value.

To find what still uses the old prefix on a server, start it and search its log for `is deprecated`.

## Access log

`SEIRA_ACCESS_LOG=1` (or `seira serve --access-log`) makes the server write one line for each request it answers:
time, method, route, status, duration and the way in (`local` or `tunnel`). The route is the shape of the path, taken from
the list of known routes: a word stays only when no known route reads that position as a name or an id, any other name or id is written as `:id`, and the part of a
path that matches no known route is written as `<other>`. The query string, cookies, headers and bodies
are never written. It is off unless you set it.

## Premium key

`SEIRA_TEAM_KEY` sets the Premium key that lets more than 5 people sign in with an email on a self-hosted server. It
wins over the key saved in Settings → People, and Settings shows it read-only. Only the server process reads it:
engines, bot boxes and tools never receive it. See
[How many people can sign in](self-hosting.md#how-many-people-can-sign-in).

## What the harness keeps to itself

Both prefixes are reserved, and names are matched without regard to letter case, as Windows does. A custom MCP server cannot be given a variable that starts with `SEIRA_` or `OMB_`, a bot's
box never receives an `OMB_` variable, and a `SEIRA_` variable reaches the box only when it is on the box's allow-list
(`server/bot-box/env.ts`). Provider keys such as `SEIRA_OPENAI_API_KEY` and the control-plane settings are removed from every
engine's environment and from the tools of a chat bot.
Stdio MCP servers in chat no longer inherit provider keys (for example `ANTHROPIC_API_KEY`) from the parent environment; put a key the server needs in that server's own env.
