# CI

Seira has one CI workflow, `.github/workflows/ci.yml`. It runs on every pull
request, on every merge queue entry, on every push to `main`, and on a manual
start. A run does its work on Linux, except the `native` job (see
[Jobs](#jobs)). There is no nightly run. Two rules cut the
number of runners that a run uses (see [Fewer runners](#fewer-runners)).

The repository also has package workflows, `.github/workflows/package-*.yml`.
A maintainer starts them by hand to build a desktop package (see
[Package workflows](#package-workflows)).

## Jobs

| Job | What it does |
| --- | --- |
| `checks` | `pnpm install --frozen-lockfile`, `pnpm i18n:check`, `pnpm lint`, `pnpm check:contrast`, the model manifest and announcements checks, `node scripts/check-local-leaks.mjs`, `node scripts/check-flatpak-sources.mjs`, and the source guards (tests that only read the source) |
| `build` | `pnpm typecheck`, `pnpm check:electron`, the Electron unit tests (`pnpm test:electron`), and a production web build (`pnpm exec vite build`) |
| `vitest (linux, shard n/8)` | The whole Vitest suite in 8 shards, 4 files at once per shard. |
| `worker (<name>)` | One job for each Cloudflare Worker in scope: `pnpm install --frozen-lockfile`, the type check of the Worker, and its tests. The Worker list is `WORKERS` in `scripts/ci-heavy.mjs`. No job deploys a Worker. |
| `native (<runner>)` | One job on Windows and one on macOS for the code in `native/`. On Windows it builds the bot memory helper and its test program (`node scripts/prepare-job-fence.mjs --test`). On both it runs `node --test "native/**/*.test.mjs"`. It installs no packages. |
| `server image` | The image build and boot check of `server-image-smoke.yml`: build the server image on `linux/amd64` and `linux/arm64`, start it, and check the server, the UI, and the user. |
| `CI` | The gate. It passes only when every job before it passed or was skipped for an allowed reason. See [Skipped jobs](#skipped-jobs). |

`build`, the shards, `worker`, `native`, and `server image` start after `checks` passes.

## Fewer runners

The organization can run 20 jobs at the same time. These rules keep a release
from waiting for a free runner:

- **Draft pull request.** A draft runs `checks` only. All other jobs are
  skipped. When the author marks the pull request ready, CI runs the full
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
- **Workers in scope.** A pull request runs a `worker` job only for a Worker
  that it can break. A Worker is in scope when the change touches its folder
  `cloudflare/<name>/`, a file that the Worker reads outside its folder (the
  `paths` of the Worker in `scripts/ci-heavy.mjs`), or a file that every Worker
  reads (`WORKER_INPUTS`: the dependencies and the CI files). When no Worker is
  in scope, no `worker` job runs.
- **Native code in scope.** A pull request runs the `native` jobs only when it
  changes a file in `native/`, a file that a native test imports, or a file in
  `NATIVE_INPUTS` in `scripts/ci-heavy.mjs`. The macOS runners are few, so the
  jobs are short and run only when they can find a fault.
- **Server image.** The `server image` job runs when the heavy jobs run. The
  `Dockerfile` builds the server and the web app, so any code change can break
  the image.
- **Merge queue and `main`.** The merge queue checks the same scope as the pull
  request. A push to `main` and a manual start check everything.

## Skipped jobs

GitHub counts a skipped job as a pass. So the `CI` gate decides which skips are
allowed. It fails on any other skip.

| Job | The gate accepts a skip when |
| --- | --- |
| `build`, `vitest`, `server image` | The pull request is a draft, or `checks` found documentation and pictures only |
| `worker` | The pull request is a draft, or no Worker is in scope |
| `native` | The pull request is a draft, or no native code is in scope |
| `checks` | Never |

A job that ends as `failure` or `cancelled` fails the gate. A failed `checks`
job also fails it, and no skip is then allowed, because the scope outputs are
empty. The gate prints one line for each job.

## Runs on `main` and in the merge queue

A new push to a pull request cancels the older run of that pull request. A run
on `main` is never cancelled. GitHub replaces a run only when it still waits
for a runner. Before this rule, a burst of merges cancelled most `main` runs.
A cancelled run gives no verdict, so a commit had no proof that it was green.

The workflow listens to `merge_group` with the type `checks_requested`. Turn
on the merge queue in the `main` ruleset, and the gate then runs on each queue
entry.

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
registry sign-in of `server-image.yml` (see [Server image workflow](#server-image-workflows)).
A workflow may call another workflow of this repository by its path
(`./.github/workflows/<file>.yml`). Every other `uses` value stays pinned to a
full commit SHA.

A job that needs write access or reads a secret must use the GitHub
environment `release`. The test fails a job that asks for write access or
reads a secret without it. One job is an exception: the `milestones` job of
`milestones.yml` has `issues: write` and `pull-requests: write` and no
environment. It runs one script from `main`, installs no dependency, and reads
no secret. The test pins its exact shape (see
[Milestones workflow](#milestones-workflow)). A job with no secret and no permission can use the
environment `release-approval`. It holds the wait for a flagged run (see
[The `release-approval` environment](#the-release-approval-environment)).
A `gate` job with read-only permissions runs the release gate (see
[The release gate](#the-release-gate)). The `redispatch` job of
`npm-publish.yml` has `actions: write` and no environment. It starts the
workflow again on `main`.
One more workflow reads a secret outside the `release` environment:
`snap-publish.yml` reads `SNAPCRAFT_STORE_CREDENTIALS` in its `publish` job,
which uses the `snap-store` environment (see [Snap publish workflow](#snap-publish-workflow)).

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
It does not create a tag or publish a release. A maintainer attaches the
Windows artifact to the release by hand. For a signed `v*` tag, `package-macos.yml`
attaches the macOS files to the draft release itself (see [Releasing](releasing.md)). `scripts/ci-workflow.test.ts`
holds these rules for every `package-*.yml` file:

- The only trigger is `workflow_dispatch`. Only a person with write access can
  start it, and a pull request never runs it.
- No job asks for a permission, so the token can only read the repository.
  The `approval` job sets `permissions: {}`, which grants nothing. The `gate`
  job asks for `contents: read` and `pull-requests: read` only. The one
  exception is the `attach` job of `package-macos.yml` (see below).
- A job uses an environment only to read the signing secrets (the `attach` job is the exception), and only the
  `release` environment. Today only `package-macos.yml` does this. The one
  exception is an `approval` job in the `release-approval` environment. It
  has `permissions: {}` and reads no secret.
- The `commit` job of `package-macos.yml` finds the commit of the `ref` input
  first. It refuses a ref with unusual characters. The run
  summary shows the commit. The `package` job builds that commit, never the
  ref name, so a moved tag or branch changes nothing after the gate.
- The `gate` job of `package-macos.yml` runs the release gate. It uses
  `--tag` with `--sha` when `ref` is a `v*` tag, and `--sha` only otherwise.
- The `package` job of `package-macos.yml` needs the `commit`, `gate`, and
  `approval` jobs. It runs only when `commit` succeeded, it is not cancelled,
  the run is on `main`, `gate` succeeded, and one of these is true:
  - the gate passed;
  - `approval` succeeded in this same attempt. The `approval` job writes the
    attempt number as its output, and `package` compares it with the current
    attempt.
  A re-run keeps the result of a job that succeeded or was skipped. So a
  re-run of a failed `package` job cannot reuse an earlier approval. Re-run
  all jobs for a new approval.
- The `attach` job of `package-macos.yml` uploads the twelve macOS files to the
  draft release of a signed `v*` tag. It is the only package job with a write
  permission:
  - It needs `commit`, `gate`, `approval`, and `package`. It runs only when
    `package` succeeded, the build is signed, and `ref` starts with `v`.
  - Like `package`, it runs only on `main`, when the gate passed or when the
    approval came in this attempt.
  - It runs in the `release` environment with `contents: write` and no secret.
  - It checks out only `scripts/release-assets.mjs` from the workflow commit,
    without credentials. It never runs code from the built commit.
  - It stops before the upload when the files, or `sha256sum -c SHA256SUMS-mac.txt`,
    do not match.
  - It never publishes the release. The draft release must exist before the
    run. If it did not, re-run the failed `attach` job after you create it.
- A secret goes only into a step's `env`, as `${{ secrets.NAME }}`. It never
  goes into a `run` command, an action input, or a job setting.
- Every job runs on a GitHub-hosted runner (`ubuntu-*`, `windows-*`, or
  `macos-*`), never on a self-hosted runner.
- No step uses a dependency cache (`package-manager-cache: false`), so another
  run cannot change what the package contains.
- The workflow packages only through a `pnpm package:*` script, and each such
  script in `package.json` ends with `electron-builder ... --publish never`.
- It has one `actions/upload-artifact` step with `if-no-files-found: error`.

## Server image workflows

Two workflows handle the server image of the root `Dockerfile`. The scripts in
`deploy/` install and update the published image.

| Workflow | What it does |
| --- | --- |
| `server-image-smoke.yml` | A reusable workflow. It builds the image on each platform, starts it, and checks the server, the UI, and the user. It pushes nothing. |
| `server-image.yml` | Run by hand. It calls the smoke workflow, then publishes `ghcr.io/seira-bot/seira` and `ghcr.io/seira-bot/seira-cloud-home` (`linux/amd64` only). |

`ci.yml` calls the smoke workflow in the job `server image`. The `CI` gate
needs that job. A broken image therefore blocks a merge.

| Start of `server-image.yml` | What it does |
| --- | --- |
| Run by hand from `main`, with `tag` set to a release tag | Publishes that tag's code as `ghcr.io/seira-bot/seira:<tag>` |
| Run by hand from `main`, with no `tag` | Publishes `main` as `latest` and `sha-<commit>` |
| Run by hand from another branch | Builds and checks the image only |

The repository allows only GitHub's own actions, so the workflows use the
runner's `docker` CLI and no `docker/*` action. The smoke workflow builds each
platform on its own runner: `linux/amd64` on `ubuntu-24.04`, `linux/arm64` on
`ubuntu-24.04-arm`. A failure on one platform does not stop the other. It sets
the label `org.opencontainers.image.version` to the tag, or to `main` when
there is no tag. With the input `save` set, it keeps each image as a workflow
artifact for 7 days. `server-image.yml` sets `save` on `main` only.

The `publish` job loads the two images and pushes each one to the tag
`build-amd64` or `build-arm64`. It reads each pushed image back from the
registry and checks its platform, version label, and commit. Then it joins the
two digests under the final tags with `docker buildx imagetools create`.
Approve the run within 7 days, or the artifacts expire and the job fails. Then
start a new run.

`publish` stays in `server-image.yml`. A workflow that `ci.yml` calls cannot ask
for more rights than `ci.yml` has, and `publish` needs `packages: write`.

`scripts/ci-workflow.test.ts` holds these rules for them:

- The workflows use only `actions/*` actions.
- The smoke workflow has no permission, no secret, no environment, and no
  `concurrency` group. It pushes nothing. It reads the tag only through `env`.
- The `image` job of `server-image.yml` calls the smoke workflow.
- The `gate` job runs the release gate on the commit of the run. It runs only
  by hand from `main`.
- The `approval` job needs `gate`. It runs only when the gate flagged the run,
  in the `release-approval` environment.
- The `publish` job runs only by hand from `main`, after `image` and `gate`
  succeeded. It needs `approval`. It runs only when the gate passed, or when
  `approval` succeeded in this same attempt. A re-run of a failed `publish` job
  cannot reuse an earlier approval. Re-run all jobs for a new approval. It
  uses the `release` environment.
- Only the `publish` job gets `packages: write`, and only it can run
  `docker push` or `imagetools create`. The workflow token goes only into the
  `env` of its sign-in step.
- The `publish` job does no checkout, so it runs no code of the repository.
- It publishes only to this repository's own package, with no build cache, so
  another run cannot change the image.

## Milestones workflow

`milestones.yml` starts on a push to `main` and on a published release.
After a push, it puts each merged pull request into the milestone of the next
release. It does the same for the issues that the pull request closes.
After a release, it closes the milestone of that release and opens the next one.
It never replaces a milestone that a person set.
The workflow is not part of the `CI` gate, so a failed run does not block a
merge. See the [Milestones section of Releasing](releasing.md#milestones).

## Required check

The ruleset `main CI must pass` requires the one check `CI` and has no bypass
actor, so no one can merge while `CI` fails or still runs. The `main` ruleset
holds the pull request and review rules, and only those have the organization
admin bypass. The gate runs with
`if: ${{ !cancelled() }}`: GitHub counts a skipped required check as a pass,
so the gate must run and fail when a job before it failed or was skipped.
Before you rename the gate job, update the ruleset, or every pull request
waits forever.
The gate needs `checks`, `build`, `vitest`, `worker`, and `server image`. The
`worker` and `server image` jobs are part of `CI`, so you add no other check to
the ruleset.

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
- Linux runs every file, the e2e files too (`SEIRA_VITEST_E2E=all`).

To reproduce a failing shard:

1. Check out the commit in the job log and run `pnpm install --frozen-lockfile`.
   A pull request's CI checkout is a merge commit, not the branch tip.
2. Use Linux. The weights differ per platform, so shard 3 on another OS has
   other files.
3. Run the same command and environment as the **Run tests** step:

```sh
SEIRA_VITEST_E2E=all SEIRA_VITEST_SUBSET= SEIRA_VITEST_WORKERS=4 pnpm exec vitest run --shard=3/8
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
- Add an entry only when the cause is outside this repository, and give the
  run ids that prove it. A retry or a longer timeout does not fix a flaky test:
  find the cause and fix it. The list can be empty.

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
locale check when a catalog changed, and the size and vocabulary guards. A
checkout without dependencies can run them on an ssh host instead (see
[Contributing](contributing.md)).

## Repository settings for Actions

These settings keep CI safe for a public repository. An organization admin
sets them in GitHub **Settings → Actions → General**:

| Setting | Value |
| --- | --- |
| Actions permissions | Allow actions created by GitHub, plus `pnpm/action-setup@*` |
| Require actions to be pinned to a full-length commit SHA | On |
| Approval for fork pull request workflows | Require approval for all external contributors |
| Workflow permissions | Read repository contents |
| Allow GitHub Actions to create and approve pull requests | Off |

Then add the `CI` check (source: GitHub Actions) to a separate ruleset on the default branch with no bypass actor.
An organization admin's merge then also needs a green `CI` check.

In GitHub **Settings → General → Releases**, turn on release immutability. After a
release is published, nobody can add, change, or delete its assets, or move
its tag.

### The `release` environment

`package-macos.yml` reads the Apple signing secrets from the environment
`release`, its `attach` job writes to the draft release in it, the `publish` job of `server-image.yml` uses it to write to
`ghcr.io`, and the `publish` job of `npm-publish.yml` uses it to publish to
npm (see [Releasing](releasing.md#publish-to-npm)). An organization admin creates it in GitHub **Settings → Environments**:

| Setting | Value |
| --- | --- |
| Required reviewers | None. The `release-approval` environment holds the wait for a flagged run. |
| Deployment branches and tags | Selected branches and tags: `main` only |
| Environment secrets | The five Apple secrets (see [Releasing](releasing.md#macos-signing-secrets)) |

- A job in `release` never waits. The `gate` and `approval` jobs before it
  decide if the run waits.
- With `main` as the only deployment ref, a workflow file changed on
  another branch cannot read the secrets.
- Do not store the Apple secrets as repository or organization secrets. Every
  workflow can read those without an approval.

### The `release-approval` environment

The `approval` jobs of `npm-publish.yml`, `package-macos.yml`, and `server-image.yml` use the
`release-approval` environment. An organization admin creates it in
GitHub **Settings → Environments**:

| Setting | Value |
| --- | --- |
| Required reviewers | None |
| Wait timer | 360 minutes (6 hours) |
| Deployment branches and tags | Selected branches and tags: `main` only |
| Allow administrators to bypass configured protection rules | Off |
| Environment secrets | None |

A flagged run waits 6 hours. Then the `approval` job runs, and the run
publishes. Nobody can make the wait shorter. A maintainer can cancel the run
during the wait. The run summary of the `gate` job shows why the gate flagged
the run.

Set "Allow administrators to bypass configured protection rules" to off on the
`release` environment too.

### The release gate

`scripts/release-gate.mjs` checks every release run. It only reads from GitHub.
The `gate` job of `npm-publish.yml`, `package-macos.yml`, and `server-image.yml`
runs it from the commit of the workflow.

The gate checks every commit since the last version on npm. Only the gated
`npm-publish.yml` workflow can publish to npm, so each version on npm passed
the gate or waited in `release-approval`. The gate asks the npm registry for the
versions of `@seira-bot/seira` and takes the highest lower version as the
baseline. A run with a commit and no tag takes the highest version. The tag of the baseline must exist and must be
an ancestor of the release commit. If not, the gate flags the run. If the
registry answers with an error, the gate refuses the run.

The workflow gives the gate the tag and the commit that its `commit` job found.
The gate refuses the run when the tag points to another commit. The gate and
the `publish` job therefore check the same commit.

The gate checks:

- The release commit is on `main`. If not, the gate refuses the run.
- Each commit comes from a merged pull request into `main`. A commit without
  one flags the run.
- The author of each pull request is a trusted author. Another author flags the run.
  See [Trusted authors](#trusted-authors).
- A trusted author needs one more fact: the reviewer App `seira-roctis[bot]` has an
  approval whose `commit_id` is the final head commit of the pull request. Without it,
  the gate flags the run.
- Each pull request leaves these paths alone: `.github/**`, `scripts/release-*`,
  `scripts/git-hooks/**`, `pnpm-workspace.yaml`, and `.npmrc` files.
  A change to one of them flags the run.
- An earlier version of the package exists on npm. If not, the gate flags the run.
- A tag run has at least one commit since the baseline. If not, the gate flags the run.
- GitHub returns the full list of commits and of changed files. A cut list flags the run.

#### Trusted authors

The file `.github/release-trusted-authors.json` is the only list. The gate reads it
from `main` through the API (`contents/...?ref=main`). It never reads the file from the
pull request under review. The file is under `.github/**`, so each change to it flags
the run that ships it.

- `botAuthors`: GitHub Apps. A pull request author counts only when its `type` is `Bot`
  and its numeric `id` and its login both match one entry. The login alone never counts.
- `adminAuthors`: people. The author must match the `id` and login, have the type `User`,
  and the API must report `admin` for the account on the repository. The gate asks
  `GET repos/{repo}/collaborators/{login}/permission`. This call needs `Metadata: read`,
  which every `GITHUB_TOKEN` has. The gate does not use public organization membership.
- `reviewerApps`: the Apps whose approval counts. Same match rule as `botAuthors`.

The gate fails closed. A missing or invalid list means that no author is trusted, so
the run is flagged. An error from the API for the list, the files, or the reviews
refuses the run (exit status 2). An error from the permission call counts as "not admin".
A path that matches a sensitive pattern flags the run for any author, and a bot review
never clears it.

A listed human reviewer can clear only the author rules: an author who is not
trusted, and a missing reviewer App approval. The latest review of that reviewer
must be an approval of the final commit of the pull request. A human approval
never clears an incomplete file list or a sensitive path: these always flag the
run. The shared account `RamaAditya49` (ID 213913142) is never counted as a human
reviewer. This is fixed in the gate code, so it holds also when that account is
missing from the list. When the trusted-author list is invalid or missing, no human
review clears anything and every pull request stays flagged.

The trusted-author file must be fully valid: `version` is 1, the three lists are
arrays, each entry has exactly a string `login` and a positive integer `id`, and no
list repeats an ID or a login (case-insensitive). One bad entry makes the whole file
invalid, so every pull request is flagged.

The gate has three results:

| Exit status | Meaning | What the workflow does |
| --- | --- | --- |
| 0 | Pass | The run publishes with no wait |
| 1 | Flagged | The `approval` job waits 6 hours in `release-approval`, then the run publishes. A maintainer can cancel it. |
| 2 | Refused, wrong use, or API error | The `gate` job fails and nothing publishes |

The repository variable `RELEASE_HUMAN_REVIEWERS` holds the logins of the human
reviewers as a JSON array, for example `["login-a", "login-b"]`. When the
variable is missing, empty, or not a JSON array, it counts as an empty list.
Do not add a bot account to it.

- The `release` and `release-approval` environments accept `main` only.
- Each attempt waits again. The wait of an earlier attempt never counts.
- A published release starts `npm-publish.yml` again on `main`. The
  `redispatch` job does it with the workflow token. GitHub makes a new run for
  this kind of start.

## Snap publish workflow

`snap-publish.yml` is the one workflow that uploads a package to a store without
the `release` environment. It follows `npm-publish.yml`. A published release (not
a draft, not a prerelease) starts it through a `redispatch` job that runs it again
on `main`. A person can also start it by hand from `main` with a tag and a channel.
`scripts/ci-workflow.test.ts` holds these rules, and runs the shell of the
`commit` job with fake `gh` and `git` commands to test them:

- The `commit` job fails on any ref other than `main`. It resolves the tag once
  to a commit SHA, and fails when the SHA is not in the history of `main`. For the
  `stable` channel it also fails without a published release that is not a draft
  and not a prerelease.
- The `gate` job runs the release gate on the SHA. The `approval` job holds the
  wait of a flagged run in the `release-approval` environment.
- The `build` and `publish` jobs run only on `main`, after the gate passed or
  after an approval in the same attempt. They use the SHA, never the tag name.
- The `build` job has `contents: read`, no secret and no environment. It runs
  `scripts/check-snap.mjs`.
- The `publish` job uses the `snap-store` environment. It does no checkout, so
  it runs no code of the repository. It reads `SNAPCRAFT_STORE_CREDENTIALS` in
  the `env` of one step, and fails when the value is empty.
- The channel is `stable`, `candidate`, `beta` or `edge`. A release always
  uses `stable`.
- Every action is pinned to a full commit SHA, and every checkout drops its
  credentials.

See [Releasing](releasing.md#publish-to-the-snap-store) for the one-time setup.
