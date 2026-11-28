# Contributing to Seira

Thank you for your help. Everyone can report bugs, propose ideas, and send pull requests.

## Report a bug or propose a feature

Open an [issue](https://github.com/seira-bot/seira/issues/new/choose) and pick a form.
Search the open issues first, and keep one problem per issue.

Do not report a security problem in a public issue. Use
[private vulnerability reporting](https://github.com/seira-bot/seira/security/advisories/new)
as [SECURITY.md](SECURITY.md) explains.

## Take an issue

An issue with the label `P2` or `P3` is open only to people for 24 hours after triage.
It has the label `human-window` during that time.
After that time, you can still take it if nobody works on it.

1. Comment `/take` on the issue. The comment must contain only that line.
2. Open a draft pull request that says `Closes #<number>` within 72 hours.
3. Comment `/untake` if you stop. The issue then goes back to the pool.

A deadline on a weekend moves to Monday 12:00 UTC.
We send a reminder 24 hours before the deadline.
After the deadline, the issue goes back to the pool.

You can hold one open claim at a time. After your first merged pull request, you can hold two.

An issue with the label `size: L`, `needs-security-review`, or `area: ci` needs a maintainer.

### Assigned issues

An assigned issue needs a draft pull request within 7 days.
A bot reminds the assignees after 5 days.
The bot unassigns them after 7 days, at least 2 days after the reminder.
This rule applies to maintainers too.

## Send a pull request

1. For a large change, open an issue first and agree on the approach.
2. Fork the repository and create a branch from `main`.
3. Make one focused change. New server behavior needs a test.
4. Run the checks below.
5. Open a pull request and fill in the template.

```sh
git clone https://github.com/<you>/seira && cd seira
git config core.hooksPath scripts/git-hooks
pnpm install

pnpm dev:server    # harness server on 127.0.0.1:8799
pnpm dev           # app on http://127.0.0.1:5199

pnpm typecheck && pnpm lint && pnpm test
```

The `git config` line turns on the commit and push hooks. It needs only git and node, so it works
before `pnpm install`. Run it in every new clone, and in every checkout that skips `pnpm install`.

You need Node 24+ and pnpm. To chat with a bot, you also need a logged-in
[`claude`](https://claude.com/claude-code) or [`codex`](https://github.com/openai/codex) CLI.

The code rules are in the [code guide](docs/contributing.md): repo map, tests,
data format, provider drivers, platform rules, and CI. UI changes follow
[DESIGN.md](DESIGN.md).

### Review and stalled pull requests

Maintainers give a first review within 24 hours after a pull request is ready.
After 24 hours without a maintainer response, a bot adds `needs-review` and asks the maintainers.
After 48 hours, the bot asks again.

A pull request waits for its author when it is a draft or when a review asked for changes.
After 7 days, a bot reminds the author.
After 14 days, the issues that it closes become free for other people.
The pull request gets the label `stalled` and stays open.
Push a change to continue.

## How a change lands

| Step | Who |
|------|-----|
| Open an issue or a pull request | Everyone |
| Review and approve | The maintainers (`@seira-bot/maintainers`) |
| Merge into `main` | The maintainers only |
| Tag and publish a release | The maintainers only |

- `main` is protected. Every change arrives through a pull request with a maintainer approval.
- Pull requests merge as one squashed commit. Write the title as a short imperative sentence,
  for example "Fix the sidebar overlap", because it becomes the commit message.
- Release tags (`v*`) and GitHub releases come only from the maintainers. Do not change the
  version number, the update feed, or the publish settings in a pull request.
- A maintainer can ask you to split a pull request that mixes concerns.

## License

Seira uses the [Apache License 2.0](LICENSE). By contributing, you agree that your work uses the
same license. There is no CLA and no DCO sign-off. Submit only code that you wrote or have the
right to contribute.

Everyone in the project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
