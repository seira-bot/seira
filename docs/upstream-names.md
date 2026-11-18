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

Seira has no release yet, so there is nothing to update to.

## Names that still come from upstream

| Where | Name today |
|---|---|
| npm package and Linux package | `openmausbot` |
| Data folder | `~/.openmausbot` |
| Environment variables | `OMB_PORT`, `OMB_UI_PORT`, `OMB_WEBHOOK_PORT` |
| Product name, installer files, Linux install folder | `OpenMausBot`, `OpenMausBot-<version>-…`, `/opt/OpenMausBot` |
| Server image, installers, and update scripts in `deploy/` | `ghcr.io/milind-soni/openmausbot` and the upstream repository |
| Files the app reads from GitHub | Announcements, model list, team library, and browser engine downloads, all from upstream repositories |
| Cloud and website addresses | `openmausbot.com` and its subdomains |
| Text in the app and in the docs | OpenMausBot, MausBot |

Use these names as they are until the code changes.
In the guides, [CONTRIBUTING.md](../CONTRIBUTING.md), the [code guide](contributing.md), and [DESIGN.md](../DESIGN.md), read "OpenMausBot" as "Seira".

Do not install the `openmausbot` npm package to get Seira. That package is the upstream app.

## Packaged builds

> [!WARNING]
> Do not publish a packaged build yet. The app id and the update source are Seira's,
> but the product name, the installer names, and the Linux install folder still say OpenMausBot.
> A Seira install can replace an OpenMausBot install on Linux.
> Never upload a Seira build to the OpenMausBot release repository.

## Security reports

Report a security problem in Seira as [SECURITY.md](../SECURITY.md) describes.
If the problem is also in OpenMausBot, report it to the [upstream repository](https://github.com/milind-soni/OpenMausBot/security) too.
