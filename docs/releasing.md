# Releasing

Seira ships one desktop package: a Linux x64 AppImage. A maintainer builds it
by hand on a Linux machine and publishes it as a GitHub release. No workflow
builds, tags, or publishes a release.

Only the maintainers can release:

- The `main` branch ruleset needs a pull request, a passing `CI` check, and a
  review from the code owners. Squash merge is the only merge method.
- The `release tags` ruleset blocks the creation, update, and deletion of `v*`
  tags for everyone except the organization admins.
- GitHub Actions has no bypass on either ruleset, and its token can only read
  the repository (see [CI](ci.md)).

macOS, Windows, `.deb`, npm, and container images are not part of a Seira
release.

## Assets

Each release has exactly these three assets:

| Asset | What it is |
| --- | --- |
| `Seira-<version>-x86_64.AppImage` | The desktop app |
| `latest-linux.yml` | The update feed. Installed apps read it to find the new version. |
| `SHA256SUMS-linux-x64.txt` | The SHA-256 of the AppImage |

The update feed names the AppImage by its file name and SHA-512. Upload the
files exactly as the build writes them. Do not rename them.

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

### 5. Check what users download

```sh
mkdir -p .omb-scratch/release-check && cd .omb-scratch/release-check
gh release download v<version> --repo seira-bot/seira
sha256sum -c SHA256SUMS-linux-x64.txt
```

The check must print `OK`. If it fails, delete the release assets and upload
them again. Never edit an asset in place.

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
