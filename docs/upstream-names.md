# Upstream names in the code

Seira started from [OpenMausBot](https://github.com/milind-soni/OpenMausBot) 0.1.169 on 18 November 2026.
Some names in the code and in the docs still come from that project.
This page lists them, so you can find them and use them correctly.

## Names that belong to Seira

| Where | Name today |
|---|---|
| Desktop app id | `bot.seira.app` |
| Update source of packaged builds | The `seira-bot/seira` releases on GitHub |
| Update check of a server | The `seira-bot/seira` releases and stable channel on GitHub |

## Names that still come from upstream

| Where | Name today |
|---|---|
| Linux package | `openmausbot` |
| Data folder | `~/.openmausbot` |
| Environment variables | `OMB_PORT`, `OMB_UI_PORT`, `OMB_WEBHOOK_PORT` |
| Linux executable | `openmausbot` |
| Files the app reads from GitHub | Announcements, model list, team library, and browser engine downloads, all from upstream repositories |
| Cloud and website addresses | `openmausbot.com` and its subdomains |
| Text in the app and in the docs | OpenMausBot, MausBot |

Use these names as they are until the code changes.
In the guides, [CONTRIBUTING.md](../CONTRIBUTING.md), the [code guide](contributing.md), and [DESIGN.md](../DESIGN.md), read "OpenMausBot" as "Seira".

Seira's npm package is `@seira-bot/seira`. Do not install the npm package `openmausbot`: it is the upstream app.

## Packaged builds

Each release on GitHub has the Windows installer and the Linux AppImage, named `Seira-<version>-…`.

> [!WARNING]
> Seira and OpenMausBot use the same data folder, port, and Linux executable name.
> Do not install both on one computer.
> Never upload a Seira build to the OpenMausBot release repository.

## Security reports

Report a security problem in Seira as [SECURITY.md](../SECURITY.md) describes.
If the problem is also in OpenMausBot, report it to the [upstream repository](https://github.com/milind-soni/OpenMausBot/security) too.
