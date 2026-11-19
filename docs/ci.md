# CI

Seira has one CI workflow, `.github/workflows/ci.yml`. It runs on every pull
request, on every push to `main`, and on a manual start. A run does its work
on Linux. There is no merge queue or nightly run. Two rules cut the number of
runners that a run uses (see [Fewer runners](#fewer-runners)).

The repository also has package workflows, `.github/workflows/package-*.yml`.
A maintainer starts them by hand to build a desktop package (see
[Package workflows](#package-workflows)).

## Jobs

| Job | What it does |
| --- | --- |
| `checks` | `pnpm install --frozen-lockfile`, `pnpm i18n:check`, `pnpm lint`, `pnpm check:contrast`, the model manifest and announcements checks, `node scripts/check-local-leaks.mjs`, and the source guards (tests that only read the source) |
| `build` | `pnpm typecheck`, `pnpm check:electron`, and a production web build (`pnpm exec vite build`) |
| `vitest (linux, shard n/8)` | The whole Vitest suite in 8 shards, 4 files at once per shard. Shard 1 also runs `pnpm broker:test` and `pnpm test:electron`. |
| `CI` | The gate. It passes only when every job before it passed. `build` and the shards may be skipped only as [Fewer runners](#fewer-runners) says. |

`build` and the shards start after `checks` passes.

## Fewer runners

The organization can run 20 jobs at the same time, and a full run uses 10.
These rules keep a release from waiting for a free runner:

- **Draft pull request.** A draft runs `checks` only. `build` and the shards
  are skipped. When the author marks the pull request ready, CI runs the full
  suite. A draft cannot merge, so the skip hides no failure.
- **Documentation and pictures only.** A pull request runs `checks` only when
  every changed file is one of these: a Markdown file in the repository root,
  a `.md`, `.png`, `.jpg`, `.gif`, or `.webp` file under `docs/`, or a
  `.png`, `.jpg`, `.gif`, or `.webp` file under `brand/`. It still runs the
  full suite when a tracked source file names the changed file, or the folder
  of a picture, because a test can read it. `scripts/ci-heavy.mjs` applies the
  rule. It runs the full suite for any other file and for any doubt, such as
  an empty or unreadable list of changed files. The tests that read the docs
  in `checks` (`scripts/testing/verification-docs.test.ts`) still run.
- **Newer push to `main`.** A push to `main` cancels the older `main` run that
  is still going. The newer commit holds the older one, so the newer run tests
  both. A manual start is never cancelled.

The `CI` gate passes a skipped `build` or shard only for a draft or a
documentation-only pull request. In every other run, a skipped job fails the
gate.

## Fork pull requests

A pull request from a fork runs the same workflow, and it cannot write to the
repository or read a secret:

- The trigger is `pull_request`. No workflow uses `pull_request_target`,
  `workflow_run`, or `issue_comment`, which run with the base repository's
  rights.
- The workflow sets `permissions: contents: read`, and no job asks for more.
- No step in `ci.yml` reads a secret. Every `actions/checkout` sets
  `persist-credentials: false`, so the token is not left in `.git/config`.
- Every action is pinned to a full commit SHA, with the version in a comment.
- No `run` step puts an event value such as a branch name or a title into the
  shell directly. Event values go through `env`.

`scripts/ci-workflow.test.ts` holds these rules for every file in
`.github/workflows/`. It runs in the `checks` job, so a change that breaks a
rule fails CI. The rules also stop a workflow that reads `github.token`, puts
an `inputs` value into a shell command, or runs `electron-builder` with a
`--publish` value other than `never`. The one token read they accept is the
registry sign-in of `server-image.yml` (see [Server image workflow](#server-image-workflow)).

A job that needs write access or reads a secret must use the GitHub
environment `release`. The test fails a job that asks for write access or
reads a secret without it. A job with no secret and no permission can use the
environment `release-approval`. It holds the approval (see
[The `release-approval` environment](#the-release-approval-environment)).
Two workflows read secrets in the `release` environment:

- `package-macos.yml` reads the Apple signing secrets;
- `server-image.yml` reads the workflow token in its `publish` job, to sign in
  to `ghcr.io`.

## Package workflows

| Workflow | What it builds |
| --- | --- |
| `package-windows.yml` | The Windows x64 installer, its block map, `latest.yml`, `Seira-setup.exe`, and `SHA256SUMS-windows-x64.txt` |
| `package-macos.yml` | The macOS arm64 and x64 apps as `.dmg` and `.zip`, their block maps, `latest-mac.yml`, `Seira.dmg`, `Seira-intel.dmg`, and `SHA256SUMS-mac.txt`. Without the Apple secrets it builds test apps only, in an artifact named `NOT-FOR-RELEASE`. |

A package workflow builds a package and uploads it as a workflow artifact.
It does not create a tag or a release. A maintainer attaches the artifact to
the release by hand (see [Releasing](releasing.md)). `scripts/ci-workflow.test.ts`
holds these rules for every `package-*.yml` file:

- The only trigger is `workflow_dispatch`. Only a person with write access can
  start it, and a pull request never runs it.
- No job asks for a permission, so the token can only read the repository.
  The `approval` job sets `permissions: {}`, which grants nothing.
- A job uses an environment only to read the signing secrets, and only the
  `release` environment. Today only `package-macos.yml` does this. The one
  exception is an `approval` job in the `release-approval` environment. It
  has `permissions: {}` and reads no secret.
- The `commit` job of `package-macos.yml` finds the commit of the `ref` input
  before the approval. It refuses a ref with unusual characters. The run
  summary shows the commit. The `package` job builds that commit, never the
  ref name, so a moved tag or branch changes nothing after the approval.
- The `package` job of `package-macos.yml` needs the `commit` and `approval`
  jobs. It runs only when `commit` succeeded, it is not cancelled, and one of
  these is true:
  - a maintainer started this attempt;
  - `approval` succeeded in this same attempt. The `approval` job writes the
    attempt number as its output, and `package` compares it with the current
    attempt.
  A re-run keeps the result of a job that succeeded or was skipped. So a
  person who is not a maintainer cannot re-run a failed `package` job and
  reuse an earlier approval. That person must re-run all jobs, which asks for
  a new approval, or ask a maintainer to re-run.
- A secret goes only into a step's `env`, as `${{ secrets.NAME }}`. It never
  goes into a `run` command, an action input, or a job setting.
- Every job runs on a GitHub-hosted runner (`ubuntu-*`, `windows-*`, or
  `macos-*`), never on a self-hosted runner.
- No step uses a dependency cache (`package-manager-cache: false`), so another
  run cannot change what the package contains.
- The workflow packages only through a `pnpm package:*` script, and each such
  script in `package.json` ends with `electron-builder ... --publish never`.
- It has one `actions/upload-artifact` step with `if-no-files-found: error`.

## Server image workflow

`server-image.yml` builds the server image of the root `Dockerfile` and
publishes it as `ghcr.io/seira-bot/seira`. The scripts in `deploy/` install
and update that image.

| Start | What it does |
| --- | --- |
| A pull request that changes `Dockerfile`, `.dockerignore`, or the workflow | The `image` job only: build, start, and check the server on each platform |
| Run by hand from `main`, with `tag` set to a release tag | Publishes that tag's code as `ghcr.io/seira-bot/seira:<tag>` |
| Run by hand from `main`, with no `tag` | Publishes `main` as `latest` and `sha-<commit>` |

The repository allows only GitHub's own actions, so the workflow uses the
runner's `docker` CLI and no `docker/*` action. The `image` job builds each
platform on its own runner: `linux/amd64` on `ubuntu-24.04`, `linux/arm64` on
`ubuntu-24.04-arm`. It sets the label `org.opencontainers.image.version` to
the tag, or to `main` when there is no tag. On a run by hand from `main`, it
saves each image as a workflow artifact for 7 days.

The `publish` job loads the two images and pushes each one to the tag
`build-amd64` or `build-arm64`. It reads each pushed image back from the
registry and checks its platform, version label, and commit. Then it joins the
two digests under the final tags with `docker buildx imagetools create`. Approve the run within 7 days, or the
artifacts expire and the job fails. Then start a new run.

`scripts/ci-workflow.test.ts` holds these rules for it:

- The workflow uses only `actions/*` actions.
- The `image` job has no permission, no secret, and no environment, and it
  pushes nothing.
- The `approval` job needs `image`. It runs only for a person who is not a
  maintainer, in the `release-approval` environment.
- The `publish` job runs only by hand from `main`, after `image` succeeded. It
  needs `approval`. It runs only when a maintainer started this attempt, or
  when `approval` succeeded in this same attempt. A person who is not a
  maintainer cannot re-run a failed `publish` job and reuse an earlier
  approval. That person must re-run all jobs or ask a maintainer. It uses the
  `release` environment.
- Only the `publish` job gets `packages: write`, and only it can run
  `docker push` or `imagetools create`. The workflow token goes only into the
  `env` of its sign-in step.
- The `publish` job does no checkout, so it runs no code of the repository.
- It publishes only to this repository's own package, with no build cache, so
  another run cannot change the image.

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
| Windows and macOS shards, Windows and macOS smokes | CI tests on Linux only. `package-windows.yml` and `package-macos.yml` run the packaged smokes for their packages. |
| Packaged server, browser identity, browser driver, and UI smokes | Heavy jobs that download browsers and binaries. Run them locally when you change that area. |
| Behavior evals, FOSS build, relay, control plane, broker deploy | Not part of the Seira app, or needed a secret. |
| Release, Linux packaging, and docs-site workflows | A maintainer releases by hand. See [Releasing](releasing.md). |
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

### The `release` environment

`package-macos.yml` reads the Apple signing secrets from the environment
`release`, the `publish` job of `server-image.yml` uses it to write to
`ghcr.io`, and the `publish` job of `npm-publish.yml` uses it to publish to
npm (see [Releasing](releasing.md#publish-to-npm)). An organization admin creates it in **Settings → Environments**:

| Setting | Value |
| --- | --- |
| Required reviewers | None. The `release-approval` environment holds the approval. |
| Deployment branches and tags | Selected branches and tags: `main` and the tag pattern `v*` |
| Environment secrets | The five Apple secrets (see [Releasing](releasing.md#macos-signing-secrets)) |

- A job in `release` never waits for a person. The `approval` job before it
  decides if a maintainer must approve the run.
- With `main` and `v*` as the only deployment refs, a workflow file changed on
  another branch cannot read the secrets. Only an organization admin can create
  a `v*` tag.
- Do not store the Apple secrets as repository or organization secrets. Every
  workflow can read those without an approval.

### The `release-approval` environment

The `approval` jobs of `package-macos.yml` and `server-image.yml` use the
`release-approval` environment. An organization admin creates it in
**Settings → Environments**:

| Setting | Value |
| --- | --- |
| Required reviewers | The `maintainers` team |
| Deployment branches and tags | Selected branches and tags: `main` only |
| Environment secrets | None |

The repository variable `RELEASE_MAINTAINERS` holds the maintainers' GitHub
logins as a JSON array, for example `["login-a", "login-b"]`.

- A maintainer's run skips the `approval` job and does not wait.
- Another person's run waits until a maintainer approves the `approval` job.
- When the variable is missing, empty, or not a JSON array, every run waits
  for approval.
- Each attempt checks the person who started that attempt. An approval from
  an earlier attempt never counts.
