# Seira agent notes

Before claiming a server or conversation change works, follow
[`docs/verification/README.md`](docs/verification/README.md). Always launch an
isolated fixture; never verify mutations against the user's live app or data.

UI changes follow [`DESIGN.md`](DESIGN.md).

## Comments

Write a comment only for what the code cannot say:

- a license or attribution notice;
- a fact forced by something outside this code (a vendor, CLI, OS, browser,
  Electron or protocol behaviour), with its version when it has one;
- the doc comment of a public contract: the wire types in `shared/`, the
  driver interface, the preload bridge, `config.json` fields people edit;
- a link to an upstream issue;
- a security invariant or a known open risk.

Do not narrate what the next line does, restate a name, record history ("used
to", "no longer", PR or issue numbers, plan or slice names: git has it), point
at other files, draw banners or leave commented-out code. When our own code
needs a paragraph to explain a surprise, change the code instead: a better
name, a type, an extracted function, one shared helper. A rule ("never X",
"must match Y") belongs in a type, a test or a lint rule. Never suppress a lint
rule that guards correctness; fix the code.

More specific `AGENTS.md` files override this note within their directories.

## Local details stay local

This repository is public. A committed file must work on any machine and must not
describe one person's machine or private workflow.

- Never commit an absolute home path, a path to a personal tool, a host name, an
  SSH alias, a private IP address, a user name, `ls -l` output, or a secret.
- Read such values from environment variables. Document each variable in an
  `.env.example`, and keep your own values in a `*.local` file (gitignored).
- Keep specs, plans, done notes, research and business notes in `internal/`
  (gitignored). Publish a note under `docs/` only when contributors need it, and
  never link a public file to `internal/`.
- Put notes for your own machine in `AGENTS.local.md` (gitignored). Read it when
  it exists.
- `node scripts/check-local-leaks.mjs` finds these details in the lines you add.
  The pre-commit hook in `scripts/git-hooks/` runs it on the staged lines. Put
  your own user name, host aliases and LAN addresses in `.leakcheck.local`, one
  regular expression per line.

## Private by default

This repository is public. Before you add a file, decide if every user or
contributor needs it. If not, the file does not go here.

Keep these out of the repository:

- Code and config of hosted services that only the maintainers deploy. They
  live in a private repository.
- Business numbers of the hosted service: its plan prices, quotas and costs.
- Customer data.
- Plans, specs, research and task notes. Put them in `internal/`.
- Scratch files, backups and experiments.
- Local files and env files.

When you are unsure, keep the file local and ask the maintainer.

`node scripts/check-public-paths.mjs` blocks a new file under a known private
path. The pre-commit hook and CI run it.
