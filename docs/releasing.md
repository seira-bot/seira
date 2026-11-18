# Releasing

Seira ships two desktop packages:

- a Linux x64 AppImage, which a maintainer builds by hand on a Linux machine;
- a Windows x64 installer, which the `Package Windows` workflow builds on a
  GitHub-hosted Windows runner.

A maintainer creates the tag and the GitHub release, and attaches every file
by hand. No workflow creates a tag or publishes a release.

Only the maintainers can release:

- The `main` branch ruleset needs a pull request, a passing `CI` check, and a
  review from the code owners. Squash merge is the only merge method.
- The `release tags` ruleset blocks the creation, update, and deletion of `v*`
  tags for everyone except the organization admins.
- GitHub Actions has no bypass on either ruleset, and its token can only read
  the repository (see [CI](ci.md)).

macOS, `.deb`, npm, and container images are not part of a Seira release.

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

### 6. Check what users download

```sh
mkdir -p .omb-scratch/release-check && cd .omb-scratch/release-check
gh release download v<version> --repo seira-bot/seira
sha256sum -c SHA256SUMS-linux-x64.txt
sha256sum -c SHA256SUMS-windows-x64.txt
```

Each check must print `OK`. If a check fails, delete the release assets and
upload them again. Never edit an asset in place.

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
