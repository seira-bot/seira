# Licensing

Seira is open source under the [Apache License 2.0](LICENSE). Everything in
this repository uses that license. There is no source-available folder and no
license key is needed.

Seira is a modified version of OpenMausBot
(<https://github.com/milind-soni/OpenMausBot>). The copyright holders are
named in [NOTICE](NOTICE).

## Open-source edition

The server reports `{"edition":"oss"}`. Ordinary standalone operation needs no
license. The server still looks for an optional extension folder named
`enterprise/` next to it and uses it only when present. This repository does
not ship that folder.

A workspace explicitly configured for hosted sign-in refuses remote access
without that optional extension. The server never bypasses a configured
sign-in authority.

## Contributions

Contribute under Apache 2.0. No DCO sign-off or CLA is required. Submit only
code you wrote or have the right to contribute.

Every file has a code owner ([`CODEOWNERS`](.github/CODEOWNERS)): a maintainer
reviews each change.

## Third-party components and trademarks

Bundled third-party software keeps its own licenses. Notices, license texts,
source locations and the SBOM are listed in [NOTICE](NOTICE) and
[`third_party/`](third_party/).

OpenMausBot and MausBot are trademarks of Supamaus Software Private Limited.
Seira is not affiliated with or endorsed by Supamaus Software Private Limited
or the OpenMausBot project. The Apache License does not grant trademark rights
(section 6).
