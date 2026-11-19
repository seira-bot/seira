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
- The server looks up the program on the host right before each launch. It starts the resolved target and refuses
  one in a folder the bots can write (same rule as the deb build).
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
