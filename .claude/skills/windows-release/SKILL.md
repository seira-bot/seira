---
name: windows-release
description: Build, check, and attach the Seira Windows x64 installer and its update feed to a seira-bot/seira release. Use when you cut a release, when a release has no Windows assets, or when a Windows user says that the app does not update. Covers Windows only; docs/releasing.md covers Linux and macOS.
---

# Windows release

The full release guide is [`docs/releasing.md`](../../../docs/releasing.md).
This skill covers its step 5 and the Windows update problems.
A release goes only to [`seira-bot/seira`](https://github.com/seira-bot/seira/releases).
Never upload a Seira build to a Seira repository.

## Before you start

- The tag `v<version>` exists, and `package.json` at that tag has the same
  version. The workflow stops when they are not equal.
- Only a maintainer can start the workflow and attach the files.
- GitHub Actions is on for the repository ([CI](../../../docs/ci.md)).
- Do not build the installer on a local machine. The workflow builds it on a
  GitHub-hosted Windows runner from a clean checkout with no dependency cache.

## 1. Build

```sh
gh workflow run package-windows.yml --repo seira-bot/seira -f ref=v<version>
gh run list --repo seira-bot/seira --workflow package-windows.yml --limit 1
gh run watch <run id> --repo seira-bot/seira --exit-status
```

Before it uploads, the workflow does these checks. When one fails, the run fails:

| Check | Problem that it stops |
| --- | --- |
| `server/index.js` and `ui/index.html` are in the package | The "Couldn't start the bot server" page, or a black window |
| The bundled browser and the packaged server start with an empty home folder, and `/api/health` answers | An app that cannot start on a new computer |
| `app-update.yml` names `owner: seira-bot` and `repo: seira`, and has no `publisherName` | Installed apps that look for updates in the wrong place, or reject every update |
| `latest.yml` names `Seira-<version>-setup.exe` with the correct SHA-512 and size | Installed apps that download the update and then reject it |
| `cloudflared.exe` has the pinned version and SHA-256 | A wrong third-party binary in the package |

## 2. Download and check

```sh
mkdir -p .seira-scratch/windows && cd .seira-scratch/windows
gh run download <run id> --repo seira-bot/seira --name seira-<version>-windows-x64
sha256sum -c SHA256SUMS-windows-x64.txt
```

Each line must print `OK`. The artifact stays for 14 days. After that, run the
workflow again.

## 3. Attach to the release

Attach all five files to the same release as the Linux and macOS files:

```sh
gh release upload v<version> --repo seira-bot/seira \
  Seira-<version>-setup.exe Seira-<version>-setup.exe.blockmap latest.yml \
  Seira-setup.exe SHA256SUMS-windows-x64.txt
```

| File | Who uses it |
| --- | --- |
| `Seira-<version>-setup.exe` | The installer. `latest.yml` names this file, so the updater downloads it. |
| `Seira-<version>-setup.exe.blockmap` | The updater. It downloads only the changed parts. |
| `latest.yml` | Installed apps. They read it to find the new version. |
| `Seira-setup.exe` | The download link `/releases/latest/download/Seira-setup.exe`. It is a byte-identical copy. |
| `SHA256SUMS-windows-x64.txt` | People who check the download |

- Upload the files as the workflow wrote them. Do not rename them, and do not
  edit `latest.yml`. Do not use a `latest.yml` from an earlier build.
- Never replace an asset in place. If an asset is wrong, delete the assets of
  the release and upload all five again.
- Then do step 8 of `docs/releasing.md`: download the release and check every
  checksum file.

## Microsoft Store package

The same run builds `Seira-<version>-x64.appx` for the Microsoft Store. It is in
the artifact `seira-<version>-windows-x64-store`. Do not attach it to the GitHub
release. Upload it to Partner Center by hand. The Store signs it.

- The build maps version `0.1.179` to `1.1.179.0`, because the Store rejects a
  first part of 0.
- Set `appx.identityName` and `appx.publisher` in `electron-builder.yml` from
  the Product identity page in Partner Center before the first upload.
- In this package the app does not update itself and does not write a Run key.
  The Store updates it, and the person turns on Open at login in Startup apps.
- The workflow checks the manifest and the logos. `docs/releasing.md` lists the
  checks.

## Each release has Windows files

A release without `latest.yml` leaves every installed Windows app on its old
version. A background update check that fails shows no message, so the user
gets no warning. Attach the Windows files to each release. If you cannot, say in the
release notes that Windows stays on the earlier version.

## A Windows user says that the app does not update

Find the cause in this order:

1. Open the release of the newest version. It must have all five files. If
   `latest.yml` is missing, attach the files of step 3.
2. Download `latest.yml` and the installer from the release. The `path`, the
   SHA-512, and the size in `latest.yml` must match the installer. If they do
   not match, delete the five assets and attach the workflow files again.
3. Ask for `updater.log` from the log folder of the app:
   `%APPDATA%\seira\logs`. The folder keeps its upstream name.
4. Ask where the user installed the app from. A Seira installer from
   the upstream project reads the upstream releases. It never updates to Seira.
   The user must install `Seira-setup.exe` once.

## The installer is not signed

Seira has no Windows code-signing certificate. Microsoft Defender SmartScreen
shows "Windows protected your PC" and "Unknown publisher". The user selects
**More info**, then **Run anyway**. Say this in the release notes.

Do not add `publisherName` or signing settings to `electron-builder.yml`
without a certificate. electron-updater checks the signature only when
`publisherName` is set, so each installed app then rejects each update. When
Seira gets a certificate, keep its subject the same for each later certificate,
or list the old and the new subject in `publisherName`.
