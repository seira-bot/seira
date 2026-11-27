# Releasing

Seira ships three desktop packages:

- a Linux x64 AppImage and Debian package, which a maintainer builds by hand on a Linux machine;
- a Windows x64 installer, which the `Package Windows` workflow builds on a
  GitHub-hosted Windows runner;
- macOS apps for Apple silicon (arm64) and Intel (x64), which the
  `Package macOS` workflow builds, signs, and notarizes on a GitHub-hosted
  macOS runner. This needs the [macOS signing secrets](#macos-signing-secrets).
  Until a maintainer sets them, a release has no macOS assets.

A maintainer creates the tag and the draft GitHub release, and attaches the
Linux and Windows files by hand. For a signed `v*` tag, the `Package macOS`
workflow attaches the macOS files to the draft release. No workflow creates a
tag or publishes a release. A workflow publishes two packages: the
npm package (see [Publish to npm](#publish-to-npm)) and the desktop snap (see
[Publish to the Snap Store](#publish-to-the-snap-store)).

Only the maintainers can release:

- The `main` branch ruleset needs a pull request and a review from the code
  owners. Squash merge is the only merge method. The `main CI must pass`
  ruleset needs a passing `CI` check and has no bypass.
- The `release tags` ruleset blocks the creation, update, and deletion of `v*`
  tags for everyone except the organization admins.
- GitHub Actions has no bypass on any of these rulesets, and its token can only read
  the repository (see [CI](ci.md)).
- A newer push to `main` can replace a `main` CI run that still waits for a
  runner (see [CI](ci.md#runs-on-main-and-in-the-merge-queue)). A cancelled
  run proves nothing about the released tree. Step 4 runs a preflight that needs a successful `CI` run for
  that tree.

The server image `ghcr.io/seira-bot/seira:v<version>` comes from the
`Server image` workflow after the release (step 8). The npm package
`@seira-bot/seira` comes from the `npm publish` workflow (see
[Publish to npm](#publish-to-npm)).

## Assets

Each release has these Linux assets:

| Asset | What it is |
| --- | --- |
| `Seira-<version>-x86_64.AppImage` | The portable app |
| `Seira-<version>-amd64.deb` | The Debian package. Ubuntu 24.04 needs it: there, only its setuid helper keeps the Chromium sandbox on. |
| `latest-linux.yml` | The update feed. Installed apps read it to find the new version. |
| `Seira.AppImage` | A byte-identical copy of the AppImage, so `/releases/latest/download/Seira.AppImage` always works |
| `Seira-amd64.deb` | A byte-identical copy of the Debian package. The docs and the AppImage's install message name this file. |
| `SHA256SUMS-linux-x64.txt` | The SHA-256 of the AppImage, the Debian package, and both copies |

And these Windows assets:

| Asset | What it is |
| --- | --- |
| `Seira-<version>-setup.exe` | The installer. The update feed names this file. |
| `Seira-<version>-setup.exe.blockmap` | The block map. Installed apps use it to download only the changed parts. |
| `latest.yml` | The Windows update feed |
| `Seira-setup.exe` | A byte-identical copy of the installer, so `/releases/latest/download/Seira-setup.exe` always works |
| `SHA256SUMS-windows-x64.txt` | The SHA-256 of both installer files |

And these macOS assets:

| Asset | What it is |
| --- | --- |
| `Seira-<version>-arm64.dmg`, `Seira-<version>-x64.dmg` | The disk images for Apple silicon and for Intel. A person installs from these. |
| `Seira-<version>-arm64.zip`, `Seira-<version>-x64.zip` | The apps as zip files. Installed apps download these to update. |
| `Seira-<version>-arm64.dmg.blockmap`, `Seira-<version>-x64.dmg.blockmap`, `Seira-<version>-arm64.zip.blockmap`, `Seira-<version>-x64.zip.blockmap` | The block maps of the four files above |
| `latest-mac.yml` | The macOS update feed. It names both zip files and both disk images. |
| `Seira.dmg` | A byte-identical copy of the Apple silicon disk image, so `/releases/latest/download/Seira.dmg` always works |
| `Seira-intel.dmg` | A byte-identical copy of the Intel disk image |
| `SHA256SUMS-mac.txt` | The SHA-256 of the four packages, `Seira.dmg`, and `Seira-intel.dmg` |

Each update feed names its package by file name, SHA-512, and size. Upload the
files exactly as the build writes them. Do not rename them, and do not edit a
feed by hand. A feed that does not match its package makes installed apps
download the update and then reject it.

## Steps

### 1. Bump the version in a pull request

Add an entry for the new version to `RELEASE_NOTES` in `src/lib/release-notes.ts`,
with its strings in `en.json` and `pt-br.json`. A version with no entry shows no popup.
`src/lib/release-notes.test.ts` fails until the newest entry matches the `package.json` version.
The profile menu's What's new opens the same notes.

```sh
git switch -c release/v<version> origin/main
npm pkg set version=<version>
node scripts/record-data-format.mjs
git commit -am "Release v<version>"
git push -u origin release/v<version>
gh pr create --base main --title "Release v<version>"
```

`scripts/record-data-format.mjs` writes `server/data-format-released.json`
(see [Data format and rollback](#data-format-and-rollback)). The pull request
needs the `CI` check and a code-owner review, as every other change does.

### 2. Build on a Linux x64 machine

Use a clean checkout of the release branch's last commit. Do not build from a
folder that has other work in it.

```sh
git fetch origin
git switch --detach origin/release/v<version>
git status --short          # must print nothing
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm i18n:check
```

Then package:

```sh
export NODE_OPTIONS=--max-old-space-size=6144
export TMPDIR="$PWD/.seira-scratch/tmp" && mkdir -p "$TMPDIR"
pnpm package:linux
```

- The packaging step needs more than the default 2 GB Node heap.
- It also writes several GB of temporary files. A small `/tmp` in memory fills
  up and the build stops with `EDQUOT` or `ENOSPC`, so point `TMPDIR` at a disk.
- The Debian package step runs `fpm`, and its bundled Ruby needs `libcrypt.so.1`.
  Ubuntu and Debian have it. On Arch, install `libxcrypt-compat` first, or the
  build stops with `fpm process failed 127`.

The build writes `release/Seira-<version>-x86_64.AppImage`,
`release/Seira-<version>-amd64.deb`, `release/latest-linux.yml`, and
`release/linux-unpacked/`.

### 3. Check the package

```sh
grep -E '^(owner|repo):' release/linux-unpacked/resources/app-update.yml
# owner: seira-bot
# repo: seira
grep -E '^(version|path):' release/latest-linux.yml
node scripts/verify-linux-package.mjs release
```

`scripts/verify-linux-package.mjs` needs `dpkg-deb`, `desktop-file-validate`, and
`unsquashfs`. It checks the Debian package and the AppImage, and it fails when
the AppImage can start without the Chromium sandbox.

Then put the files to upload, and the copies with stable names, in their own
folder. Keep `release/` as the build wrote it.

```sh
mkdir -p .seira-scratch/linux-upload && cd .seira-scratch/linux-upload
cp ../../release/Seira-<version>-x86_64.AppImage ../../release/Seira-<version>-amd64.deb ../../release/latest-linux.yml .
cp Seira-<version>-x86_64.AppImage Seira.AppImage
cp Seira-<version>-amd64.deb Seira-amd64.deb
sha256sum Seira-<version>-x86_64.AppImage Seira-<version>-amd64.deb Seira.AppImage Seira-amd64.deb \
  > SHA256SUMS-linux-x64.txt
cd ../..
```

- If `app-update.yml` names another owner or repository, stop. Installed apps
  would look for updates in the wrong place.
- The version and path in `latest-linux.yml` must match the AppImage.
- Start the app once with a temporary data folder and a free port. Do not
  point it at the data folder of an installed copy.
- On a host that blocks user namespaces, such as stock Ubuntu 24.04, the
  AppImage shows its install message and stops. This is correct.
- `scripts/linux-store/deb-vm-test.sh` installs the Debian package and starts
  the AppImage in an Ubuntu 24.04 VM with the stock settings. Each `RESULT`
  line records one check.

### 4. Merge, tag, and create the draft

```sh
gh pr merge <pr number> --squash
git fetch origin
node scripts/release-preflight.mjs --sha <merge commit sha> --version <version>
git tag -a v<version> -m "Seira v<version>" <merge commit sha>
git push origin v<version>
node scripts/release-preflight.mjs --tag v<version>
cd .seira-scratch/linux-upload
gh release create v<version> --verify-tag --draft --title "Seira v<version>" --generate-notes
node ../../scripts/release-assets.mjs upload v<version> \
  Seira-<version>-x86_64.AppImage Seira-<version>-amd64.deb latest-linux.yml \
  Seira.AppImage Seira-amd64.deb SHA256SUMS-linux-x64.txt
node ../../scripts/release-assets.mjs check v<version>
```

The release stays a draft until step 7. Attach every file
with the upload command, never with `gh release upload`. The script uploads
the feeds (`latest*.yml`) last, so installed apps never read a feed whose file
is still uploading. It uploads one file at a time and stops at the first
failure. Before it uploads a feed, it checks that every file that a feed or a
`SHA256SUMS-*.txt` file names is an uploaded asset of the same size. The
`check` command runs the same check at any time. It only reads from GitHub.
Do not publish the release when a check fails. The preflight cannot see
assets, because it runs before the release exists.

Tag the squash commit on `main`, not the release branch's last commit. The
tag push works only for an organization admin.

The preflight reads GitHub with `gh api` and changes nothing. It ignores the
check runs of Dependabot update runs and lists them as notes. Stop when it
exits with a failure.

- It checks that the tag and the `package.json` version are the same, that
  the commit is on `main`, and that no check on the commit failed or is still
  running.
- It checks that a successful `CI` run proves the tree of the release commit.
  A cancelled run does not prove it. It also checks that `main` is green.
- When the CI proof is missing, start CI on the tag with
  `gh workflow run ci.yml --ref v<version>`. Wait for the run to succeed.
  Then run the preflight again.

### Publish the Flatpak repo

Seira has a signed Flatpak repository at `https://flatpak.seira.bot/repo/`.
Only the release owner publishes to it, and only from a release tag. See the
[Flatpak packaging notes](../packaging/flatpak/README.md#publish) for the
settings and the recovery steps.

```sh
git switch --detach v<version>
scripts/linux-store/publish-flatpak.sh v<version>
node scripts/release-assets.mjs upload v<version> release/Seira-<version>-x86_64.flatpak
```

- Use `--init-repo` for the first publish only.
- The script stops when HEAD is not the tag, the tree is not clean, or `package.json` has another version.
- The bundle `Seira-<version>-x86_64.flatpak` adds the Seira remote when a person installs it.
- Attach the bundle to the draft release before step 7. The `publish` command refuses a release without it.

### 5. Build and attach the Windows installer

Attach the files to the draft release. Do not publish the release yet.

The `Package Windows` workflow (`.github/workflows/package-windows.yml`)
builds the installer from a tag on a GitHub-hosted Windows runner. Before it
uploads anything:

- it starts the bundled browser and the packaged server with an empty home
  folder, and waits for `/api/health`;
- it makes sure that `app-update.yml` points at `seira-bot/seira` and has no
  `publisherName`;
- it makes sure that `latest.yml` names the installer with the correct
  SHA-512 and size.
- it builds the bot memory helper `seira-job-fence.exe` with MinGW-w64
  (`pnpm build:job-fence`), and makes sure that the app folder and the Store
  package contain it, and that it passes an exit code on.

It uploads the five Windows assets as one workflow artifact. It uploads the
Microsoft Store package as a second artifact (see
[Microsoft Store (MSIX)](#microsoft-store-msix)). It cannot publish them: its
token can only read the repository.

```sh
gh workflow run package-windows.yml --repo seira-bot/seira -f ref=v<version>
gh run list --repo seira-bot/seira --workflow package-windows.yml --limit 1
gh run watch <run id> --repo seira-bot/seira --exit-status
mkdir -p .seira-scratch/windows && cd .seira-scratch/windows
gh run download <run id> --repo seira-bot/seira --name seira-<version>-windows-x64
sha256sum -c SHA256SUMS-windows-x64.txt
node ../../scripts/release-assets.mjs upload v<version> \
  Seira-<version>-setup.exe Seira-<version>-setup.exe.blockmap latest.yml \
  Seira-setup.exe SHA256SUMS-windows-x64.txt
node ../../scripts/release-assets.mjs check v<version>
```

- Set `ref` to the release tag. The workflow stops when the tag and the
  version in `package.json` are not equal.
- The workflow needs GitHub Actions to be on for the repository (see
  [CI](ci.md#repository-settings-for-actions)).
- The artifact stays for 14 days. Upload it before then, or run the workflow
  again.
- Upload all five files in one upload command. The script uploads `latest.yml`
  last, so installed apps never read a feed whose file is still uploading. A
  release with the installer but without `latest.yml` leaves every installed
  Windows app on its old version.
- Run `check` after the upload. It must print no `FAIL` line.

#### The installer is not signed

Seira has no Windows code-signing certificate. When a person opens the
installer, Microsoft Defender SmartScreen shows "Windows protected your PC"
and "Unknown publisher". To continue, the person selects **More info**, then
**Run anyway**. Say this in the release notes.

The bot memory helper `resources/job-fence/seira-job-fence.exe` is not
signed either. It is inside the installer and the Store package, not a
separate release asset. The Store signs the whole package.

Do not add `publisherName` or signing settings to `electron-builder.yml`
without a certificate. electron-updater checks the update signature only when
`publisherName` is set, so every installed app would reject every update. When
Seira gets a certificate, keep its subject the same for each later
certificate, or list the old and the new subject in `publisherName`.

#### Microsoft Store (MSIX)

The `msstore publish` workflow (`.github/workflows/msstore-publish.yml`)
submits each stable release to the Microsoft Store. It follows the pattern of
the Snap workflow (see [Publish to the Snap Store](#publish-to-the-snap-store)).
The manual path below stays as a fallback.

```sh
# Automatic: when a maintainer publishes the GitHub release (step 7), the
# workflow starts itself again on main. A draft or a prerelease does not start it.
# By hand, from main only:
gh workflow run msstore-publish.yml --repo seira-bot/seira --ref main -f tag=v<version>
gh run list --repo seira-bot/seira --workflow msstore-publish.yml --limit 1
```

- The `commit` job, the `gate` job and the `approval` job work like the ones of
  the Snap workflow. Every later job uses the commit SHA, never the tag name.
- The `build` job has no secret. It builds the package with `pnpm package:appx`
  and runs the same package checks as the list below. It writes the What's new
  text with `scripts/store-whats-new.mjs`: the English titles of the release
  notes of the version, at most 1500 characters. It uses
  `Bug fixes and improvements.` when the version has no release notes.
- The `publish` job uses the `microsoft-store` environment and runs no code of
  the repository. Only this job reads the four `MSSTORE_*` secrets.
- The `publish` job stops, and uploads nothing, when a secret is missing. It
  also stops when Partner Center already has a submission in progress,
  because the upload tool deletes that submission. Finish or delete that
  submission in Partner Center, then run the workflow again.
- The `publish` job uploads the package with the `msstore` tool, sets the
  What's new text of each listing, commits the submission, and waits until the
  commit ends. Microsoft then certifies the submission. This can take hours.

The same Windows package workflow (`package-windows.yml`) also builds an MSIX
package for the Microsoft Store. The file is `Seira-<version>-x64.appx`. It is
in a separate artifact, `seira-<version>-windows-x64-store`, with
`SHA256SUMS-windows-x64-store.txt`. Use it for a manual upload. Do not attach
this package to the GitHub release.

```sh
gh run download <run id> --repo seira-bot/seira --name seira-<version>-windows-x64-store
sha256sum -c SHA256SUMS-windows-x64-store.txt
```

Before it uploads the package, the workflow extracts it and checks that:

- the manifest names the display name and the publisher display name of Seira;
- the manifest declares the `seira` protocol, the `runFullTrust`
  capability, and a start-up task that is off by default;
- the package version is the mapped version (see below);
- each logo in `build/appx/` is in the package with the same SHA-256, and no
  sample logo of electron-builder is in the package.

Rules for the package:

- The Store rejects a version that starts with 0, and it needs a last part
  of 0. The build maps `<major>.<minor>.<patch>` to
  `<major+1>.<minor>.<patch>.0`. Version `0.1.179` becomes `1.1.179.0`.
  `scripts/appx-manifest.mjs` does this. The build stops when it cannot map
  the version. The app still reports `0.1.179`.
- The package has no signature. The Store signs the package after you upload it.
  A person cannot install the file from the workflow without a test signature.
- `appx.identityName` and `appx.publisher` in `electron-builder.yml` hold the
  values from the Product identity page of the product in Partner Center. The
  Store rejects a package with other values. `scripts/check-appx.mjs` checks them.
- The `msstore publish` workflow submits each stable release as a new
  submission of the same product (see below). A manual upload in Partner
  Center stays possible as a fallback.
- The app does not update itself in this package. The Store delivers updates.
- The app does not write a Windows Run entry in this package, because Windows
  redirects that write. A person turns on Open at login in Startup apps in
  Windows Settings. Settings tells the person this.
- Change the logos only in `brand/build_logo.py`. Run `python3 brand/build_logo.py`
  and `python3 brand/check_logo.py`, and commit the files in `build/appx/`.

### 6. Build and attach the macOS apps

Do this step only when the [macOS signing secrets](#macos-signing-secrets)
are set. The workflow attaches the files to the draft release.

The `Package macOS` workflow (`.github/workflows/package-macos.yml`) builds
both apps from a tag on a GitHub-hosted macOS runner. It reads the Apple
secrets from the `release` environment. The release gate checks every run (see
[CI](ci.md#the-release-gate)). A run that passes the gate does not wait. A run
that the gate flags waits 6 hours in `release-approval`, then builds. A
maintainer can cancel it during the wait. A run that the gate refuses does not
build. A re-run never reuses the wait of an earlier attempt. The workflow finds the commit of the
ref first, and it builds that commit only. The run summary shows the commit. Before it uploads anything:

- it makes sure that each app has every helper for its own CPU, and that
  `app-update.yml` points at `seira-bot/seira`;
- it verifies the code signature of each app, then starts the bundled browser
  and the packaged server with an empty home folder;
- it sends the four packages to Apple for notarization, staples the result to
  them, and makes the zip files, the block maps, and `latest-mac.yml` again
  from the stapled apps;
- it makes sure that Gatekeeper accepts both apps and both disk images, and
  that `latest-mac.yml` names each package with the correct SHA-512 and size.

It uploads the twelve macOS assets as one workflow artifact. The `package`
job cannot publish them: its token can only read the repository.

For a signed build of a `v*` tag, the `attach` job then uploads the twelve
files to the draft release of that tag. The job does these steps:

- It checks that the artifact holds exactly the twelve files.
- It runs `sha256sum -c SHA256SUMS-mac.txt`. It stops before the upload when a
  sum does not match.
- It runs `scripts/release-assets.mjs upload`, which uploads `latest-mac.yml`
  last, and then `check`.

The `attach` job reads no secret. It never publishes the release. The draft
release must exist before the run. Step 4 creates it.

```sh
gh workflow run package-macos.yml --repo seira-bot/seira -f ref=v<version>
gh run list --repo seira-bot/seira --workflow package-macos.yml --limit 1
# A run that the gate flags waits 6 hours in "release-approval".
# To stop it, cancel the run on its run page.
gh run watch <run id> --repo seira-bot/seira --exit-status
node scripts/release-assets.mjs check v<version>
```

Use the manual upload only when the `attach` job did not run or failed. For
example, the run started before the draft release existed. First create the
draft release and re-run the failed `attach` job. If that does not work, upload
the files by hand:

```sh
mkdir -p .seira-scratch/macos && cd .seira-scratch/macos
gh run download <run id> --repo seira-bot/seira --name seira-<version>-macos
sha256sum -c SHA256SUMS-mac.txt
node ../../scripts/release-assets.mjs upload v<version> \
  Seira-<version>-arm64.dmg Seira-<version>-x64.dmg \
  Seira-<version>-arm64.zip Seira-<version>-x64.zip \
  Seira-<version>-arm64.dmg.blockmap Seira-<version>-x64.dmg.blockmap \
  Seira-<version>-arm64.zip.blockmap Seira-<version>-x64.zip.blockmap \
  latest-mac.yml Seira.dmg Seira-intel.dmg SHA256SUMS-mac.txt
node ../../scripts/release-assets.mjs check v<version>
```

- Set `ref` to the release tag. The workflow stops when the tag and the
  version in `package.json` are not equal.
- Tags up to `v0.1.170` do not copy the dictation helper into the app, so the
  workflow stops at a gate. Build `v0.1.171` or later.
- The artifact stays for 14 days. Upload it before then, or run the workflow
  again.
- Upload all twelve files in one upload command, by the job or by hand. The script uploads
  `latest-mac.yml` last, so installed apps never read a feed whose file is
  still uploading. A release with the apps but without `latest-mac.yml` leaves
  every installed macOS app on its old version.
- Run `check` after the upload. It must print no `FAIL` line.

#### An artifact named NOT-FOR-RELEASE

When the `release` environment has none of the Apple secrets, the workflow
still builds and runs every gate that needs no Apple account. The apps then
have an ad-hoc signature and no notarization, and the artifact is named
`seira-<version>-macos-NOT-FOR-RELEASE`. It holds the four packages and
`NOT-FOR-RELEASE.txt`, with no update feed and no block maps. The apps carry no update
feed file, so a gate checks that it is absent, and they never check for updates.

- Use it only to test the build. macOS blocks these apps when they come from
  a download.
- Never attach it to a release.

When only some of the five secrets are set, the workflow stops before it
builds, so a missing secret never gives an unsigned build by mistake.

### 7. Publish the release

```sh
node scripts/release-assets.mjs publish v<version>
```

The command makes the draft release public and marks it as the latest release.

- It refuses when a Linux or Windows asset is missing. The release stays a draft.
- The Linux assets include the Flatpak bundle `Seira-<version>-x86_64.flatpak`.
- It refuses when the release has any macOS file and a macOS asset is missing.
- It refuses when `check` finds a problem. The release stays a draft.
- It runs `check` again after it publishes the release.
- Publishing the release starts the `npm publish` workflow (see [Publish to npm](#publish-to-npm)).
- It also starts the `snap publish` workflow (see [Publish to the Snap Store](#publish-to-the-snap-store)).
- It also starts the `msstore publish` workflow (see [Microsoft Store (MSIX)](#microsoft-store-msix)).
- A published release without the Windows assets makes installed Windows apps fail their update check.
- It also breaks the `Seira-setup.exe` download link.
- Do not publish with `gh release edit` or the GitHub web page.
- Do this step before step 8. The server image workflow fails while the release is still a draft.

### 8. Publish the server image

The `Server image` workflow (`.github/workflows/server-image.yml`) builds the
server image from the tag for `linux/amd64` and `linux/arm64`, each on its own
runner (see [CI](ci.md#server-image-workflow)). The scripts in `deploy/`
install the image of the newest release, so publish it for every release.

```sh
gh workflow run server-image.yml --repo seira-bot/seira --ref main -f tag=v<version>
gh run list --repo seira-bot/seira --workflow server-image.yml --limit 1
# A run that the gate flags waits 6 hours in "release-approval".
# To stop it, cancel the run on its run page.
gh run watch <run id> --repo seira-bot/seira --exit-status
docker buildx imagetools inspect ghcr.io/seira-bot/seira:v<version>
```

- Start the run from `main`. The `release` environment refuses other branches.
- The gate checks the commit of the run. A run that passes publishes with no
  person. A run that the gate flags shows an approval request after both builds
  pass. A person approves it within 7 days, or the saved images expire. Then
  start a new run.
- The repository variable `RELEASE_HUMAN_REVIEWERS` is a JSON array of the
  logins of the human reviewers (see [CI](ci.md#the-release-gate)). When the
  variable is missing, empty, or not a JSON array, it counts as an empty list.
- A re-run does not reuse the wait of an earlier attempt. Re-run all jobs: the
  new attempt waits again.
- Publish the GitHub release first (step 7). The workflow refuses a tag that is not a
  published release, and it builds the tag only, never a branch of that name.
- The image must show both platforms, and the label
  `org.opencontainers.image.version` must be `v<version>`.
- The same run also publishes `ghcr.io/seira-bot/seira-cloud-home` for `linux/amd64` only, with the same tags.
  Its label `org.opencontainers.image.version` is `<version>`, without the `v`. The publish job summary prints its digest.
- The package must be public, or a server cannot pull it. An organization
  admin sets this once in the package settings on GitHub.

### 9. Check what users download

```sh
mkdir -p .seira-scratch/release-check && cd .seira-scratch/release-check
gh release download v<version> --repo seira-bot/seira
sha256sum -c SHA256SUMS-linux-x64.txt
sha256sum -c SHA256SUMS-windows-x64.txt
sha256sum -c SHA256SUMS-mac.txt
node ../../scripts/release-assets.mjs check v<version>
```

Each check must print `OK`, and the `check` command must print no `FAIL`
line. A published release is immutable: nobody can change, delete, or add an
asset. If a check fails, publish a new patch release with correct files.

## Publish to npm

The `npm publish` workflow (`.github/workflows/npm-publish.yml`) publishes
`@seira-bot/seira` with npm Trusted Publishing. No npm token exists in GitHub
or on a maintainer's machine. npm trusts the workflow file and the `release`
environment through the GitHub OIDC token.

It starts in one of two ways:

```sh
# Automatic: when a maintainer publishes the GitHub release (step 7), the
# workflow starts itself again on main.
# By hand, from main:
gh workflow run npm-publish.yml --repo seira-bot/seira --ref main -f tag=v<version>
gh run watch <run id> --repo seira-bot/seira --exit-status
npm view @seira-bot/seira@<version> version
```

- The tag must be equal to `v` and the version in `package.json`. The workflow
  stops when they differ.
- The workflow finds the commit of the tag first, and builds that commit only.
- The release gate checks every run (see [CI](ci.md#the-release-gate)). A run
  that passes publishes with no wait. A run that the gate flags waits 6 hours
  in `release-approval`, then publishes. A maintainer can cancel it during the
  wait. A run that the gate refuses does not publish. The `publish` job uses the `release` environment, as the other
  release jobs do.
- When the version is already on npm, the workflow skips the build and the
  publish. A repeated run changes nothing.
- npm adds a provenance statement that links the package to this commit and run.
- The `release` and `release-approval` environments accept the `main` branch
  only. A published release starts `npm-publish` again on `main`, with the tag
  as input. The run for the release event itself does nothing else.
- A re-run does not reuse the wait of an earlier attempt. Re-run all jobs: the
  new attempt waits again.

### One-time npm setup

An organization owner does this once, on npmjs.com. The workflow cannot do it.

1. Sign in to npmjs.com as an owner of the `@seira-bot` organization.
2. Open the package `@seira-bot/seira`, then **Settings**.
3. In **Trusted Publisher**, select **GitHub Actions** and enter:

   | Field | Value |
   | --- | --- |
   | Organization or user | `seira-bot` |
   | Repository | `seira` |
   | Workflow filename | `npm-publish.yml` |
   | Environment name | `release` |

4. Save. Optionally, set **Publishing access** to require two-factor
   authentication and disallow tokens, so that only this workflow can publish.

The first version, 0.1.178, was published by hand. Trusted Publishing needs a
package that already exists on npm, so a first publish cannot use it. Every
later version comes from the workflow.

If a run fails with an authentication error, check that the four fields above
match the workflow file name and the environment name exactly.

## Publish to the Snap Store

The `snap publish` workflow (`.github/workflows/snap-publish.yml`) uploads the
classic snap `seira` to the Snap Store. Nobody uploads a snap by hand. It
follows the pattern of the npm workflow (see [Publish to npm](#publish-to-npm)).

```sh
# Automatic: when a maintainer publishes the GitHub release (step 7), the
# workflow starts itself again on main and uploads to `stable`.
# A draft or a prerelease does not start it.
# By hand, from main only:
gh workflow run snap-publish.yml --repo seira-bot/seira --ref main -f tag=v<version> -f channel=stable
gh run list --repo seira-bot/seira --workflow snap-publish.yml --limit 1
# A run that the gate flags waits 6 hours in "release-approval".
# To stop it, cancel the run on its run page.
gh run watch <run id> --repo seira-bot/seira --exit-status
```

- Start the run from `main`. A run from another branch or tag fails in the
  `commit` job, before any job reads a credential. The `snap-store`
  environment also refuses every ref except `main`.
- The `commit` job resolves the tag once to a commit SHA. It stops when the
  SHA is not in the history of `main`. Every later job uses the SHA, never the
  tag name.
- The `stable` channel needs a published GitHub release for the tag that is not
  a draft and not a prerelease. The channels `candidate`, `beta` and `edge`
  need only a commit in `main`.
- The `gate` job runs the release gate on the SHA (see
  [CI](ci.md#the-release-gate)). A run that passes uploads with no person. A
  run that the gate flags waits in `release-approval`, and a re-run does not
  reuse the wait of an earlier attempt. A run that the gate refuses builds nothing.
- The `build` job has no secret. It builds the SHA with `pnpm package:snap`. It
  stops when the tag does not match `package.json`. `scripts/check-snap.mjs`
  checks the snap: the name, classic confinement, no sandbox-off switch, and no
  setuid file.
- The `publish` job uses the `snap-store` environment and uploads the file with
  `snapcraft upload --release=<channel>`. Only this job reads the secret
  `SNAPCRAFT_STORE_CREDENTIALS`. When the secret is missing, the job fails and
  uploads nothing.
- The store does not accept two builds with one version number, so a repeated
  upload of the same version fails.
- The store holds a classic snap until a reviewer grants classic confinement,
  so the first `stable` release waits for that review (see
  [Linux desktop](linux-desktop.md#snap)).

### Check the first build

The workflow has not built a snap yet. Before the credentials exist, prove the
build with the `edge` channel. The `publish` job may fail for the missing secret.
The `build` job must pass.

```sh
gh workflow run snap-publish.yml --repo seira-bot/seira --ref main -f tag=v<version> -f channel=edge
```

### One-time Snap Store setup

An organization owner does this once. The workflow cannot do it. Do not add the
credentials before the controls above are on `main`.

1. Register the name `seira` on the Snap Store with the publisher account.
   Request classic confinement for it on the Snapcraft forum.
2. On a trusted computer, export store credentials that can only upload this
   snap and expire:

   ```sh
   snapcraft export-login --snaps=seira --channels=stable,candidate,beta,edge \
     --acls=package_access,package_push,package_release --expires=<ISO date> -
   ```

3. In the repository settings, create the environment `snap-store`. Limit its
   deployment branches to `main` only. Do not allow tags or other branches.
   Add required reviewers if a person must approve each upload.
4. Add the exported text as the environment secret `SNAPCRAFT_STORE_CREDENTIALS`.
   Do not put it in a repository secret, a variable, an issue, or a log.
5. Renew the credentials before they expire.

Until the secret exists, a run fails at the upload step with a clear error.

### One-time Microsoft Store setup

The owner of the Partner Center account does this once. The workflow cannot do
it. Do not add the secrets before the `msstore publish` workflow is on `main`.

1. In Partner Center, open Account settings, then User management, then
   Microsoft Entra applications. Create an application. Give it the role
   Manager and no other role.
2. Choose Add new key. Copy the key at once, because Partner Center shows it
   one time. Write down the expiry date of the key. Renew the key before that
   date.
3. Write down the Tenant ID, the Client ID and the Seller ID of the account.
4. In the repository settings, create the environment `microsoft-store`. Limit
   its deployment branches to `main` only. Do not allow tags or other branches.
   Add required reviewers if a person must approve each submission.
5. Add four environment secrets to `microsoft-store`: `MSSTORE_TENANT_ID`,
   `MSSTORE_SELLER_ID`, `MSSTORE_CLIENT_ID` and `MSSTORE_CLIENT_SECRET`. Do not
   put them in a repository secret, a variable, an issue, or a log.

The workflow stops when Partner Center already has a submission in progress.
Until the secrets exist, a run fails in the `publish` job with a message that
names each missing secret.

## macOS signing secrets

The `Package macOS` workflow reads five secrets from the GitHub environment
`release` (see [CI](ci.md#the-release-environment)). Set all five, or none.

| Secret | What it holds |
| --- | --- |
| `MAC_CERT_P12_BASE64` | The Developer ID Application certificate and its private key, as a `.p12` file in base64 |
| `MAC_CERT_PASSWORD` | The password of that `.p12` file |
| `APPLE_API_KEY_P8_BASE64` | An App Store Connect API key (the `.p8` file) in base64. The workflow sends the apps for notarization with it. |
| `APPLE_API_KEY_ID` | The key ID of that API key |
| `APPLE_API_ISSUER_ID` | The issuer ID of the App Store Connect team |

To make them, you need a Mac and the Account Holder role on the Apple team.

1. Enroll in the Apple Developer Program (`https://developer.apple.com/programs/`).
   It costs a yearly fee. An organization needs a D-U-N-S number, and its
   name then shows in the certificate.
2. Make a certificate signing request. On the Mac, open **Keychain Access**,
   then **Keychain Access → Certificate Assistant → Request a Certificate From
   a Certificate Authority**. Select **Saved to disk**.
3. Make the certificate. In **Certificates, IDs & Profiles → Certificates**,
   add a certificate of the type **Developer ID Application**. Select the
   **G2 Sub-CA** and upload the request from step 2.
4. Download the certificate and open it. Keychain Access adds it to the login
   keychain, beside the private key from step 2.
5. Export the `.p12` file. In Keychain Access, open **My Certificates**,
   select `Developer ID Application: <name> (<team ID>)`, and export it as a
   `.p12` file with a strong password. The file must hold the private key.
6. Make the API key. In App Store Connect, open **Users and Access →
   Integrations → App Store Connect API → Team Keys**, and add a key with the
   **Developer** role. Download the `.p8` file. Apple lets you download it
   only once.
7. Write down the key ID and the issuer ID. Both show on the same page.
8. Store the five secrets in the environment. `gh secret set` asks for a value
   when no value comes from the input, so the password does not go into the
   shell history:

```sh
base64 -i developer-id.p12 | tr -d '\n' | gh secret set MAC_CERT_P12_BASE64 --env release --repo seira-bot/seira
gh secret set MAC_CERT_PASSWORD --env release --repo seira-bot/seira
base64 -i AuthKey_<key ID>.p8 | tr -d '\n' | gh secret set APPLE_API_KEY_P8_BASE64 --env release --repo seira-bot/seira
gh secret set APPLE_API_KEY_ID --env release --repo seira-bot/seira
gh secret set APPLE_API_ISSUER_ID --env release --repo seira-bot/seira
```

9. Keep the `.p12` file, its password, and the `.p8` file in a password
   manager. Then delete the files from the disk.
10. Run the workflow on `main`. When the release gate flags the run, the run
    waits 6 hours in `release-approval`. The artifact name must end in
    `-macos`, not in `-NOT-FOR-RELEASE`. Do not attach a build of `main` to
    a release.

A Developer ID certificate is valid for five years. Before it expires, make a
new one with the same Apple team and replace `MAC_CERT_P12_BASE64` and
`MAC_CERT_PASSWORD`. An installed macOS app accepts an update only when the
same team signed it, so never change the team.

## Data format and rollback

Each release records the data-folder formats it writes and reads:
`scripts/record-data-format.mjs` writes `server/data-format-released.json` in
the version-bump commit. The next release's changes are tested against that
record, so a version never writes data the release before it cannot read
([code guide, "Changing how data is stored"](contributing.md#changing-how-data-is-stored)).
A version bump without that command fails `server/data-format.test.ts` on the
mismatched version.

## Bundled browser

The Linux package stages a pinned engine and Chromium Headless Shell before
packaging. See [browser packaging](browser-packaging.md) for update ownership,
license provenance, and Linux sandbox limits. A build with missing browser
resources must fail. Do not ship a package that downloads them on first use.

## Milestones

Each release has a milestone with the name of its tag, for example `v0.1.189`.
The workflow `milestones.yml` puts each merged pull request into the milestone of the next release.
It also puts the issues that the pull request closes into that milestone.
The pull request that changes `version` in `package.json` goes into the milestone of that version.
A published release closes its milestone and opens the milestone of the next patch version.
The workflow never replaces a milestone that a person set.
A maintainer has no step to do.
To plan an open issue for a release, set its milestone by hand.
