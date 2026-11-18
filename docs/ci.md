# CI

Seira has one CI workflow, `.github/workflows/ci.yml`. It runs on every pull
request, on every push to `main`, and on a manual start. Every run does the
same work on Linux. There is no path-based job selection, merge queue, or
nightly run.

The repository also has package workflows, `.github/workflows/package-*.yml`.
A maintainer starts them by hand to build a desktop package (see
[Package workflows](#package-workflows)).

## Jobs

| Job | What it does |
| --- | --- |
| `checks` | `pnpm install --frozen-lockfile`, `pnpm i18n:check`, `pnpm lint`, `pnpm check:contrast`, the model manifest and announcements checks, `node scripts/check-local-leaks.mjs`, and the source guards (tests that only read the source) |
| `build` | `pnpm typecheck`, `pnpm check:electron`, and a production web build (`pnpm exec vite build`) |
| `vitest (linux, shard n/8)` | The whole Vitest suite in 8 shards, 4 files at once per shard. Shard 1 also runs `pnpm broker:test` and `pnpm test:electron`. |
| `CI` | The gate. It passes only when every job before it passed. |

`build` and the shards start after `checks` passes.

## Fork pull requests

A pull request from a fork runs the same workflow, and it cannot write to the
repository or read a secret:

- The trigger is `pull_request`. No workflow uses `pull_request_target`,
  `workflow_run`, or `issue_comment`, which run with the base repository's
  rights.
- The workflow sets `permissions: contents: read`, and no job asks for more.
- No step reads a secret. Every `actions/checkout` sets
  `persist-credentials: false`, so the token is not left in `.git/config`.
- Every action is pinned to a full commit SHA, with the version in a comment.
- No `run` step puts an event value such as a branch name or a title into the
  shell directly. Event values go through `env`.

`scripts/ci-workflow.test.ts` holds these rules for every file in
`.github/workflows/`. It runs in the `checks` job, so a change that breaks a
rule fails CI. The rules also stop a workflow that reads `github.token`, puts
an `inputs` value into a shell command, or runs `electron-builder` with a
`--publish` value other than `never`.

A job that needs write access (for example a future release job) must use the
GitHub environment `release`, and that environment must need a maintainer's
approval. The test fails a job that asks for write access without it.

## Package workflows

| Workflow | What it builds |
| --- | --- |
| `package-windows.yml` | The Windows x64 installer, its block map, `latest.yml`, `Seira-setup.exe`, and `SHA256SUMS-windows-x64.txt` |

A package workflow builds a package and uploads it as a workflow artifact.
It does not create a tag or a release. A maintainer attaches the artifact to
the release by hand (see [Releasing](releasing.md)). `scripts/ci-workflow.test.ts`
holds these rules for every `package-*.yml` file:

- The only trigger is `workflow_dispatch`. Only a person with write access can
  start it, and a pull request never runs it.
- No job asks for a permission or an environment, so the token can only read
  the repository.
- Every job runs on a GitHub-hosted runner (`ubuntu-*`, `windows-*`, or
  `macos-*`), never on a self-hosted runner.
- No step uses a dependency cache (`package-manager-cache: false`), so another
  run cannot change what the package contains.
- The workflow packages only through a `pnpm package:*` script, and each such
  script in `package.json` ends with `electron-builder ... --publish never`.
- It has one `actions/upload-artifact` step with `if-no-files-found: error`.

## Required check

The `main` branch ruleset requires the one check `CI`. The gate runs with
`if: ${{ !cancelled() }}`: GitHub counts a skipped required check as a pass,
so the gate must run and fail when a job before it failed or was skipped.
Before you rename the gate job, update the ruleset, or every pull request
waits forever.

## Vitest shards

`scripts/testing/duration-sequencer.ts` deals the test files out to the shards
by recorded time, slowest first, each to the shard with the least time so far.
Vitest's own `--shard` deals out equal numbers of files and puts slow files
together. A failure names the same shard on every run.

- The times are in `scripts/testing/vitest-shard-weights.json`: each file's
  median seconds on each platform, for every file over five seconds and every
  e2e file. A file not in the list counts one second, or the median e2e time
  for an e2e file.
- The shard count and the files at once come from `VITEST_SHARDS` and
  `VITEST_WORKERS` in `scripts/ci-scope.mjs`. `scripts/ci-workflow.test.ts`
  keeps `ci.yml` equal to them.
- Files that run side by side never share a port: each worker picks from its
  own range (`server/testing/worker-port.ts`). Test and hook timeouts double
  when files share the CPU (`server/testing/host-timeout.ts`).
- Linux runs every file, the e2e files too (`OMB_VITEST_E2E=all`).

To reproduce a failing shard:

1. Check out the commit in the job log and run `pnpm install --frozen-lockfile`.
   A pull request's CI checkout is a merge commit, not the branch tip.
2. Use Linux. The weights differ per platform, so shard 3 on another OS has
   other files.
3. Run the same command and environment as the **Run tests** step:

```sh
OMB_VITEST_E2E=all OMB_VITEST_SUBSET= OMB_VITEST_WORKERS=4 pnpm exec vitest run --shard=3/8
```

When a test file is deleted or renamed, remove or refresh its entry in the
weights, or `scripts/testing/duration-sequencer.test.ts` fails. Refresh the
times when the shards drift apart:

```sh
node scripts/testing/update-shard-weights.mjs --run <run id> --run <run id> --run <run id>
```

A refresh moves some files to other shards. A failure that appears only after
a refresh is a real order dependency between test files.

## Flaky tests

Known flaky tests are in `scripts/testing/ci-retry-list.json`: file, full test
name, owner, evidence, and the date. In CI only (`CI=true`), the Vitest runner
(`scripts/testing/ci-retry-runner.ts`) gives each listed test two retries.
Nothing else is retried, and a local run never retries.

- Once a listed test fails all three attempts, that is a real failure, and the
  file's later listed tests get no retry.
- A listed test that needed a retry shows in the job summary and as a warning
  (`scripts/testing/ci-retry-summary.mjs`).
- Fix the test, then delete its entry. `scripts/testing/ci-retry-list.test.ts`
  fails on an entry whose test no longer exists.

## What CI does not run

Seira took over a larger CI from the project it forked. These parts are gone:

| Removed | Why |
| --- | --- |
| Windows and macOS shards, Windows and macOS smokes | CI tests on Linux only. `package-windows.yml` runs the packaged smokes for the Windows installer. |
| Packaged server, browser identity, browser driver, and UI smokes | Heavy jobs that download browsers and binaries. Run them locally when you change that area. |
| Behavior evals, FOSS build, relay, control plane, broker deploy | Not part of the Seira app, or needed a secret. |
| Release, Linux packaging, container image, npm, and docs-site workflows | A maintainer releases by hand. See [Releasing](releasing.md). |
| Server installer, server update, Podman, and connector tests | They install container images that Seira does not publish. |
| Contributor license check | Seira has no source-available folder. |

The local `pre-push` hook still checks the files a push changes: lint, the
locale check when a catalog changed, and the size and vocabulary guards.

## Repository settings for Actions

These settings keep CI safe for a public repository. An organization admin
sets them in **Settings → Actions → General**:

| Setting | Value |
| --- | --- |
| Actions permissions | Allow actions created by GitHub, plus `pnpm/action-setup@*` |
| Require actions to be pinned to a full-length commit SHA | On |
| Approval for fork pull request workflows | Require approval for all external contributors |
| Workflow permissions | Read repository contents |
| Allow GitHub Actions to create and approve pull requests | Off |

Then add the `CI` check (source: GitHub Actions) to the `main` branch ruleset.
