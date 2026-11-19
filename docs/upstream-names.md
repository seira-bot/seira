# Upstream names in the code

Seira started from [OpenMausBot](https://github.com/milind-soni/OpenMausBot) 0.1.169 on 18 November 2026.
Some names in the code and in the docs still come from that project.
This page lists them, so you can find them and use them correctly.

## Names that belong to Seira

| Where | Name today |
|---|---|
| Product name | `Seira` |
| Desktop app id | `bot.seira.app` |
| Release files | `Seira-<version>-…`, `Seira-setup.exe` (see [Releasing](releasing.md)) |
| Releases and update source of packaged builds | The `seira-bot/seira` releases on GitHub |
| Update check of a server | The `seira-bot/seira` releases and stable channel on GitHub |
| Announcements and the model list | The `seira-bot/seira` repository on GitHub |
| npm package and command line | `@seira-bot/seira`, command `seira` (for example `npx @seira-bot/seira serve`) |
| Server image | `ghcr.io/seira-bot/seira` |
| Local VM image and desktops | `localhost/seira/cua-local-vm`, `seira-computer` (a desktop with the old `openmausbot-computer` name works until you create it again) |

## Names that still come from upstream

These names keep installs, scripts, and links working. A change to one of them
needs a migration, so change it only in its own pull request.

| Where | Name today |
|---|---|
| Linux executable and systemd unit | `openmausbot`, `openmausbot.service` |
| Link scheme | `openmausbot://` |
| Data folder | `~/.openmausbot` (`OMB_DATA_DIR` moves it) |
| Folder of the desktop app (logs, sign-ins, window state) | `openmausbot`: `~/.config/openmausbot`, `%APPDATA%\openmausbot`, `~/Library/Application Support/openmausbot` |
| Command in the server image | `openmausbot` (for example `docker compose exec omb openmausbot`); `seira` also works |
| Environment variables | `OMB_*` (for example `OMB_PORT`, `OMB_UI_PORT`, `OMB_WEBHOOK_PORT`), `OPENMAUSBOT_URL` |
| VPS desktop image | `localhost/openmausbot/cua-local-vm` |
| Page script API of chat pages | `window.mausbot`, `import … from "mausbot"` |
| Id of the built-in docs skill | `openmausbot-docs` |
| Developer tools | `pnpm control:omb`, `scripts/control-omb.ts`, `pnpm omb`, the `.omb-scratch/` folder |
| Files the app reads from GitHub | The team library (`milind-soni/openmausbot-teams`) and the Windows browser engine download |
| Cloud and website addresses | `openmausbot.com` and its subdomains |
| Text in the docs | OpenMausBot, MausBot |

Use these names as they are until the code changes.
In the guides, [CONTRIBUTING.md](../CONTRIBUTING.md), the [code guide](contributing.md), and [DESIGN.md](../DESIGN.md), read "OpenMausBot" as "Seira".

Seira's npm package is `@seira-bot/seira`. Do not install the npm package `openmausbot`: it is the upstream app.

## Packaged builds

Each release on GitHub has the Windows installer and the Linux AppImage, named `Seira-<version>-…`.
Seira publishes its packaged builds only to the
[`seira-bot/seira` releases](https://github.com/seira-bot/seira/releases).
Never upload a Seira build to an OpenMausBot repository.

An OpenMausBot install reads the upstream releases, so it never updates to Seira.
To change to Seira, install the Seira package once.

> [!WARNING]
> Seira and OpenMausBot use the same data folder, port, and Linux executable name.
> Do not install both on one computer.

## Security reports

Report a security problem in Seira as [SECURITY.md](../SECURITY.md) describes.
If the problem is also in OpenMausBot, report it to the [upstream repository](https://github.com/milind-soni/OpenMausBot/security) too.
