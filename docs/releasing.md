# Releasing

Seira ships three desktop packages:

- a Linux x64 AppImage, which a maintainer builds by hand on a Linux machine;
- a Windows x64 installer, which the `Package Windows` workflow builds on a
  GitHub-hosted Windows runner;
- macOS apps for Apple silicon (arm64) and Intel (x64), which the
  `Package macOS` workflow builds, signs, and notarizes on a GitHub-hosted
  macOS runner. This needs the [macOS signing secrets](#macos-signing-secrets).
  Until a maintainer sets them, a release has no macOS assets.

A maintainer creates the tag and the GitHub release, and attaches every file
by hand. No workflow creates a tag or publishes a release.

Only the maintainers can release:

- The `main` branch ruleset needs a pull request, a passing `CI` check, and a
  review from the code owners. Squash merge is the only merge method.
- The `release tags` ruleset blocks the creation, update, and deletion of `v*`
  tags for everyone except the organization admins.
- GitHub Actions has no bypass on either ruleset, and its token can only read
  the repository (see [CI](ci.md)).

The server image `ghcr.io/seira-bot/seira:v<version>` comes from the
`Server image` workflow after the release (step 7). `.deb` and npm packages
are not part of a Seira release.

## Assets

Each release has these Linux assets:

| Asset | What it is |
| --- | --- |
| `Seira-<version>-x86_64.AppImage` | The desktop app |
| `latest-linux.yml` | The update feed. Installed apps read it to find the new version. |
| `SHA256SUMS-linux-x64.txt` | The SHA-256 of the AppImage |

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

The build writes `release/Seira-<version>-x86_64.AppImage`,
`release/latest-linux.yml`, and `release/linux-unpacked/`.

### 3. Check the package

```sh
grep -E '^(owner|repo):' release/linux-unpacked/resources/app-update.yml
# owner: seira-bot
# repo: seira
grep -E '^(version|path):' release/latest-linux.yml
./release/Seira-<version>-x86_64.AppImage --version
(cd release && sha256sum Seira-<version>-x86_64.AppImage > SHA256SUMS-linux-x64.txt)
```

- If `app-update.yml` names another owner or repository, stop. Installed apps
  would look for updates in the wrong place.
- The version and path in `latest-linux.yml` must match the AppImage.
- Start the AppImage once with a temporary data folder and a free port. Do not
  point it at the data folder of an installed copy.

`scripts/verify-linux-package.mjs` also expects a `.deb`, so it does not apply
to an AppImage-only build.

### 4. Merge, tag, and publish

```sh
gh pr merge <pr number> --squash
git fetch origin
git tag -a v<version> -m "Seira v<version>" <merge commit sha>
git push origin v<version>
gh release create v<version> --verify-tag --title "Seira v<version>" --generate-notes \
  release/Seira-<version>-x86_64.AppImage release/latest-linux.yml release/SHA256SUMS-linux-x64.txt
```

Tag the squash commit on `main`, not the release branch's last commit. The
tag push works only for an organization admin.

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
secrets from the `release` environment, so each run waits until a maintainer
approves it. Before it uploads anything:

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
# Open the run page, select "Review deployments", and approve "release".
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
# Open the run page, select "Review deployments", and approve "release".
gh run watch <run id> --repo seira-bot/seira --exit-status
docker buildx imagetools inspect ghcr.io/seira-bot/seira:v<version>
```

- Start the run from `main`. The `release` environment refuses other branches.
- The approval request shows after both builds pass. Approve it within 7 days,
  or the saved images expire. Then start a new run.
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
10. Run the workflow on `main` and approve it. The artifact name must end in
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
