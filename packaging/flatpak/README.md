# Flatpak packaging

Application id: `bot.seira.Seira`. Runtime `org.freedesktop.Platform//26.08`, base app
`org.electronjs.Electron2.BaseApp//26.08`, Node from `org.freedesktop.Sdk.Extension.node24//26.08`.

## Build

```sh
flatpak install --user flathub org.freedesktop.Platform//26.08 org.freedesktop.Sdk//26.08 \
  org.electronjs.Electron2.BaseApp//26.08 org.freedesktop.Sdk.Extension.node24//26.08
flatpak-builder --user --install --force-clean build-dir packaging/flatpak/bot.seira.Seira.yml
flatpak run bot.seira.Seira
```

The build commands use no network. `generated-sources.json` lists every npm tarball and Electron archive by hash.
Regenerate it after a change to `pnpm-lock.yaml` or the Electron version:

```sh
flatpak-node-generator pnpm pnpm-lock.yaml -o packaging/flatpak/generated-sources.json
```

For Flathub, replace the `dir` source in the manifest with a `git` source pinned to a release tag and commit.

## Lint

```sh
flatpak run --command=flatpak-builder-lint org.flatpak.Builder manifest packaging/flatpak/bot.seira.Seira.yml
flatpak run --command=flatpak-builder-lint org.flatpak.Builder repo <repo-dir>
appstreamcli validate --no-net packaging/flatpak/bot.seira.Seira.metainfo.xml
desktop-file-validate packaging/flatpak/bot.seira.Seira.desktop
```

The build writes the `package.json` version and the build date into the `<release>` entry of the metainfo.
Flatpak and software centers show that version. Do not edit the version in the metainfo file by hand.

## Permissions

| Permission | Reason |
|------------|--------|
| `--share=network` | The app talks to model providers and its own pages. |
| `--share=ipc`, `--socket=fallback-x11`, `--socket=wayland`, `--device=dri` | Window and graphics. |
| `--socket=pulseaudio` | Voice. |
| `--talk-name=org.freedesktop.Notifications` | Notifications. |
| `--talk-name=org.freedesktop.Flatpak` | Start agent programs on the host (below). |

## Host bridge

Agent CLIs live on the host. In a Flatpak the server finds them and starts them with
`flatpak-spawn --host` (`server/flatpak-host.ts`).

- Arguments are an argv array. No shell string is built from them.
- The environment goes in a nameless file of the runtime folder, open on descriptor 3 (`--env-fd=3`). No environment value is in any argv.
- The server looks up the program on the host right before each launch. It refuses a program when the found file or
  its link target is in a folder the bots can write (same rule as the deb build).
- The server starts the found file, not its link target, as a shell does. Tools such as mise link each program to one
  binary, which picks the program by the name it runs as.
- The lookup skips relative `PATH` folders.
- Where the bot box is on, a bot run is refused in a Flatpak. Where it is off, the run is unboxed, as in the deb build.

`--talk-name=org.freedesktop.Flatpak` lets the app run any host command. The Flathub linter reports it.

## Left out of this package

| Part | Reason |
|------|--------|
| Bot browser engine | The Chromium sandbox cannot start inside the Flatpak sandbox. The app keeps its error. |
| Computer-tools (CUA) bundle | Local control is off in a Flatpak. |
| `cloudflared`, DuckDB tree, Android tools | Prebuilt binaries are not committed and not built here. |

## Test

`packaging/flatpak/test-host-bridge.sh` checks start-up under Xvfb and the host bridge with a dummy program.

## Repository

Seira has its own signed Flatpak repository. Users install from it and get updates with `flatpak update`.

| Item | Value |
|------|-------|
| Repo URL | `https://flatpak.seira.bot/repo/` |
| Branch | `stable` |
| Files for users | `seira.flatpakref`, `seira.flatpakrepo`, `seira-flatpak.gpg` at `https://flatpak.seira.bot/` |
| Store | A Cloudflare R2 bucket. The R2 copy is the source of truth. |
| Signing | Commits and summary are signed. The public key is `packaging/flatpak/seira-flatpak.asc`. |

Users install with one of these commands:

```sh
flatpak install --user https://flatpak.seira.bot/seira.flatpakref
flatpak remote-add --user seira https://flatpak.seira.bot/seira.flatpakrepo
```

The release bundle `Seira-<version>-x86_64.flatpak` adds the same remote when a user installs it.

`seira.flatpakref` and `seira.flatpakrepo` come from the public key. Do not edit them by hand:

```sh
scripts/linux-store/publish-flatpak.sh --write-refs   # write both files
scripts/linux-store/publish-flatpak.sh --check-refs   # fail when they differ
```

## Publish

Only the release owner publishes, and only from a release tag. Set the variables of
`scripts/linux-store/publish-flatpak.env.example`, then run:

```sh
git switch --detach v<version>
scripts/linux-store/publish-flatpak.sh v<version> --init-repo   # --init-repo: first publish only
gh release upload v<version> release/Seira-<version>-x86_64.flatpak --repo seira-bot/seira
```

The script does these steps:

1. It checks that HEAD is the tag, the tree is clean, and `package.json` has the same version.
2. It copies the repo down from R2 into a cache, then builds the app from a clean export of the tag.
3. It adds the build to the cache as a signed commit, then updates the repo: signed summary, static deltas, and `--prune-depth=2` (3 versions stay).
4. It makes the bundle in `release/`.
5. It uploads in this order: `objects/`, `deltas/`, `summaries/`, the other files, then `summary.sig`, `summary`, and the summary index.
   Files that a client reads first go last, so a client never sees a summary that names missing files.
6. It deletes stale files on R2 only after the new summary is up.

Cache headers: `objects/`, `deltas/`, and `summaries/` are `immutable` for one year. All other files are `no-cache`.

`--no-upload` stops after step 4. It reads nothing from R2 and sends nothing.

## Repository test

`scripts/linux-store/flatpak-repo-test.sh` runs the whole flow with no upload. It builds the app, publishes two versions
into a test repo, and checks the signatures. Then it uses an Ubuntu 24.04 VM to install from a `.flatpakref`, update,
and install from the bundle. Run it on a Linux host with KVM, under a memory limit:

```sh
systemd-run --user --scope -q -p MemoryMax=8G -p MemorySwapMax=0 scripts/linux-store/flatpak-repo-test.sh
```

It signs with a throwaway key. Set `SEIRA_TEST_KEY=real` to use the key in `SEIRA_FLATPAK_GNUPGHOME`.
Run `scripts/linux-store/flatpak-repo-test.sh clean` to delete its files.

## Repository recovery

Keep an offline backup of the private signing key and of its revocation certificate. Never commit them.

**The build host is lost.**

1. Set up a new host with `flatpak`, `flatpak-builder`, `ostree`, `gpg`, and `rclone`.
2. Restore the private key from the offline backup into a new GnuPG home (mode 700). Set `SEIRA_FLATPAK_GNUPGHOME` to it.
3. Fill in the R2 settings of `scripts/linux-store/publish-flatpak.env.example`.
4. Publish again from the newest tag. The script copies the repo down from R2 first, so the old versions stay.

**The key is lost or leaked.**

1. Publish the revocation certificate. Import it with `gpg --import` on a trusted host and publish the key to the places users can see.
2. Make a new signing key. Replace `packaging/flatpak/seira-flatpak.asc` with its public key.
3. Run `scripts/linux-store/publish-flatpak.sh --write-refs`. Commit the new `seira.flatpakref` and `seira.flatpakrepo`. They carry the new `GPGKey`.
4. Publish a new version with the new key. Users cannot verify it with the old key.
5. Each user does one of these:
   - `flatpak remote-modify --gpg-import=seira-flatpak.gpg seira` after they download the new key file; or
   - `flatpak remote-delete seira`, then add the remote again from the new `seira.flatpakrepo`.

**The R2 bucket is damaged.** The cache of the last publish host holds a full copy. Publish from it with
`--init-repo` after the bucket is empty, or rebuild the tag.
