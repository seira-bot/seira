# Releasing

Seira ships three desktop packages:

- a Linux x64 AppImage and Debian package, which a maintainer builds by hand on a Linux machine;
- a Windows x64 installer, which the `Package Windows` workflow builds on a
  GitHub-hosted Windows runner;
- macOS apps for Apple silicon (arm64) and Intel (x64), which the
  `Package macOS` workflow builds, signs, and notarizes on a GitHub-hosted
  macOS runner. This needs the [macOS signing secrets](#macos-signing-secrets).
  Until a maintainer sets them, a release has no macOS assets.

A maintainer creates the tag and the GitHub release, and attaches every file
by hand. No workflow creates a tag or publishes a release. The only package
that a workflow publishes is the npm package (see [Publish to npm](#publish-to-npm)).

Only the maintainers can release:

- The `main` branch ruleset needs a pull request, a passing `CI` check, and a
  review from the code owners. Squash merge is the only merge method.
- The `release tags` ruleset blocks the creation, update, and deletion of `v*`
  tags for everyone except the organization admins.
- GitHub Actions has no bypass on either ruleset, and its token can only read
  the repository (see [CI](ci.md)).
- A new push to `main` cancels the older `main` CI run that is still going
  (see [CI](ci.md#fewer-runners)). When you release, rely on the `CI` check of
  the release pull request, or on the run of the newest `main` commit. A
  cancelled run of an older commit is not a failure.

The server image `ghcr.io/seira-bot/seira:v<version>` comes from the
`Server image` workflow after the release (step 7). The npm package
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
export TMPDIR="$PWD/.omb-scratch/tmp" && mkdir -p "$TMPDIR"
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
mkdir -p .omb-scratch/linux-upload && cd .omb-scratch/linux-upload
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

### 4. Merge, tag, and publish

```sh
gh pr merge <pr number> --squash
git fetch origin
git tag -a v<version> -m "Seira v<version>" <merge commit sha>
git push origin v<version>
cd .omb-scratch/linux-upload
gh release create v<version> --verify-tag --title "Seira v<version>" --generate-notes \
  Seira-<version>-x86_64.AppImage Seira-<version>-amd64.deb latest-linux.yml \
  Seira.AppImage Seira-amd64.deb SHA256SUMS-linux-x64.txt
```

Tag the squash commit on `main`, not the release branch's last commit. The
tag push works only for an organization admin.

### Publish the Flatpak repo

Seira has a signed Flatpak repository at `https://flatpak.seira.bot/repo/`.
Only the release owner publishes to it, and only from a release tag. See the
[Flatpak packaging notes](../packaging/flatpak/README.md#publish) for the
settings and the recovery steps.

```sh
git switch --detach v<version>
scripts/linux-store/publish-flatpak.sh v<version>
gh release upload v<version> release/Seira-<version>-x86_64.flatpak --repo seira-bot/seira
```

- Use `--init-repo` for the first publish only.
- The script stops when HEAD is not the tag, the tree is not clean, or `package.json` has another version.
- The bundle `Seira-<version>-x86_64.flatpak` adds the Seira remote when a person installs it.

### 5. Build and attach the Windows installer

The `Package Windows` workflow (`.github/workflows/package-windows.yml`)
builds the installer from a tag on a GitHub-hosted Windows runner. Before it
uploads anything:

- it starts the bundled browser and the packaged server with an empty home
  folder, and waits for `/api/health`;
- it makes sure that `app-update.yml` points at `seira-bot/seira` and has no
  `publisherName`;
- it makes sure that `latest.yml` names the installer with the correct
  SHA-512 and size.

It uploads the five Windows assets as one workflow artifact. It cannot publish
them: its token can only read the repository.

```sh
gh workflow run package-windows.yml --repo seira-bot/seira -f ref=v<version>
gh run list --repo seira-bot/seira --workflow package-windows.yml --limit 1
gh run watch <run id> --repo seira-bot/seira --exit-status
mkdir -p .omb-scratch/windows && cd .omb-scratch/windows
gh run download <run id> --repo seira-bot/seira --name seira-<version>-windows-x64
sha256sum -c SHA256SUMS-windows-x64.txt
gh release upload v<version> --repo seira-bot/seira \
  Seira-<version>-setup.exe Seira-<version>-setup.exe.blockmap latest.yml \
  Seira-setup.exe SHA256SUMS-windows-x64.txt
```

- Set `ref` to the release tag. The workflow stops when the tag and the
  version in `package.json` are not equal.
- The workflow needs GitHub Actions to be on for the repository (see
  [CI](ci.md#repository-settings-for-actions)).
- The artifact stays for 14 days. Upload it before then, or run the workflow
  again.
- Upload all five files together. A release with the installer but without
  `latest.yml` leaves every installed Windows app on its old version.

#### The installer is not signed

Seira has no Windows code-signing certificate. When a person opens the
installer, Microsoft Defender SmartScreen shows "Windows protected your PC"
and "Unknown publisher". To continue, the person selects **More info**, then
**Run anyway**. Say this in the release notes.

Do not add `publisherName` or signing settings to `electron-builder.yml`
without a certificate. electron-updater checks the update signature only when
`publisherName` is set, so every installed app would reject every update. When
Seira gets a certificate, keep its subject the same for each later
certificate, or list the old and the new subject in `publisherName`.

### 6. Build and attach the macOS apps

Do this step only when the [macOS signing secrets](#macos-signing-secrets)
are set.

The `Package macOS` workflow (`.github/workflows/package-macos.yml`) builds
both apps from a tag on a GitHub-hosted macOS runner. It reads the Apple
secrets from the `release` environment. A run that a maintainer starts does
not wait. A run that another person starts waits until a maintainer approves
`release-approval` (see [CI](ci.md#the-release-approval-environment)). A
re-run by a person who is not a maintainer never reuses an approval of an
earlier attempt. That person must re-run all jobs or ask a maintainer. The
workflow finds the commit of the ref before the approval, and it builds that
commit only. The run summary shows the commit. Before it uploads anything:

- it makes sure that each app has every helper for its own CPU, and that
  `app-update.yml` points at `seira-bot/seira`;
- it verifies the code signature of each app, then starts the bundled browser
  and the packaged server with an empty home folder;
- it sends the four packages to Apple for notarization, staples the result to
  them, and makes the zip files, the block maps, and `latest-mac.yml` again
  from the stapled apps;
- it makes sure that Gatekeeper accepts both apps and both disk images, and
  that `latest-mac.yml` names each package with the correct SHA-512 and size.

It uploads the twelve macOS assets as one workflow artifact. It cannot publish
them: its token can only read the repository.

```sh
gh workflow run package-macos.yml --repo seira-bot/seira -f ref=v<version>
gh run list --repo seira-bot/seira --workflow package-macos.yml --limit 1
# A person who is not a maintainer: open the run page, select "Review deployments",
# and ask a maintainer to approve "release-approval".
gh run watch <run id> --repo seira-bot/seira --exit-status
mkdir -p .omb-scratch/macos && cd .omb-scratch/macos
gh run download <run id> --repo seira-bot/seira --name seira-<version>-macos
sha256sum -c SHA256SUMS-mac.txt
gh release upload v<version> --repo seira-bot/seira \
  Seira-<version>-arm64.dmg Seira-<version>-x64.dmg \
  Seira-<version>-arm64.zip Seira-<version>-x64.zip \
  Seira-<version>-arm64.dmg.blockmap Seira-<version>-x64.dmg.blockmap \
  Seira-<version>-arm64.zip.blockmap Seira-<version>-x64.zip.blockmap \
  latest-mac.yml Seira.dmg Seira-intel.dmg SHA256SUMS-mac.txt
```

- Set `ref` to the release tag. The workflow stops when the tag and the
  version in `package.json` are not equal.
- Tags up to `v0.1.170` do not copy the dictation helper into the app, so the
  workflow stops at a gate. Build `v0.1.171` or later.
- The artifact stays for 14 days. Upload it before then, or run the workflow
  again.
- Upload all twelve files together. A release with the apps but without
  `latest-mac.yml` leaves every installed macOS app on its old version.

#### An artifact named NOT-FOR-RELEASE

When the `release` environment has none of the Apple secrets, the workflow
still builds and runs every gate that needs no Apple account. The apps then
have an ad-hoc signature and no notarization, and the artifact is named
`seira-<version>-macos-NOT-FOR-RELEASE`. It holds the four packages and
`NOT-FOR-RELEASE.txt`, with no update feed and no block maps.

- Use it only to test the build. macOS blocks these apps when they come from
  a download.
- Never attach it to a release.

When only some of the five secrets are set, the workflow stops before it
builds, so a missing secret never gives an unsigned build by mistake.

### 7. Publish the server image

The `Server image` workflow (`.github/workflows/server-image.yml`) builds the
server image from the tag for `linux/amd64` and `linux/arm64`, each on its own
runner (see [CI](ci.md#server-image-workflow)). The scripts in `deploy/`
install the image of the newest release, so publish it for every release.

```sh
gh workflow run server-image.yml --repo seira-bot/seira --ref main -f tag=v<version>
gh run list --repo seira-bot/seira --workflow server-image.yml --limit 1
# A person who is not a maintainer: open the run page, select "Review deployments",
# and ask a maintainer to approve "release-approval".
gh run watch <run id> --repo seira-bot/seira --exit-status
docker buildx imagetools inspect ghcr.io/seira-bot/seira:v<version>
```

- Start the run from `main`. The `release` environment refuses other branches.
- A run that a maintainer starts needs no approval. For another person, the
  approval request shows after both builds pass. A maintainer approves it
  within 7 days, or the saved images expire. Then start a new run.
- Maintainers are the logins in the repository variable `RELEASE_MAINTAINERS`.
  When the variable is missing, empty, or not a JSON array, every run waits
  for approval.
- A person who is not a maintainer cannot re-run a failed publish job alone.
  An approval from an earlier attempt does not count. Re-run all jobs, or ask a
  maintainer to re-run.
- Publish the GitHub release first. The workflow refuses a tag that is not a
  published release, and it builds the tag only, never a branch of that name.
- The image must show both platforms, and the label
  `org.opencontainers.image.version` must be `v<version>`.
- The package must be public, or a server cannot pull it. An organization
  admin sets this once in the package settings on GitHub.

### 8. Check what users download

```sh
mkdir -p .omb-scratch/release-check && cd .omb-scratch/release-check
gh release download v<version> --repo seira-bot/seira
sha256sum -c SHA256SUMS-linux-x64.txt
sha256sum -c SHA256SUMS-windows-x64.txt
sha256sum -c SHA256SUMS-mac.txt
```

Each check must print `OK`. If a check fails, delete the release assets and
upload them again. Never edit an asset in place.

## Publish to npm

The `npm publish` workflow (`.github/workflows/npm-publish.yml`) publishes
`@seira-bot/seira` with npm Trusted Publishing. No npm token exists in GitHub
or on a maintainer's machine. npm trusts the workflow file and the `release`
environment through the GitHub OIDC token.

It starts in one of two ways:

```sh
# Automatic: it starts when a maintainer publishes the GitHub release (step 4).
# By hand, from main:
gh workflow run npm-publish.yml --repo seira-bot/seira --ref main -f tag=v<version>
gh run watch <run id> --repo seira-bot/seira --exit-status
npm view @seira-bot/seira@<version> version
```

- The tag must be equal to `v` and the version in `package.json`. The workflow
  stops when they differ.
- The workflow finds the commit of the tag first, and builds that commit only.
- A run that a maintainer starts needs no approval. For another person, a
  maintainer approves `release-approval` (see
  [CI](ci.md#the-release-approval-environment)). The `publish` job then uses
  the `release` environment, as the other release jobs do.
- When the version is already on npm, the workflow skips the build and the
  publish. A repeated run changes nothing.
- npm adds a provenance statement that links the package to this commit and run.
- The `release` environment accepts the `main` branch and the `v*` tags, so a
  run that starts from a published release can use it. The `release-approval`
  environment accepts `main` only. So a run that starts from a published
  release, and that a person outside the maintainers starts, fails at the
  `approval` job. It does not publish. This is intended. That person starts the
  workflow by hand from `main` instead.
- A person who is not a maintainer cannot re-run a failed `publish` job alone.
  The job reuses no approval of an earlier attempt. Re-run all jobs for a new
  approval, or ask a maintainer to re-run.

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
10. Run the workflow on `main`. A person who is not a maintainer needs a
    maintainer to approve it. The artifact name must end in
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
