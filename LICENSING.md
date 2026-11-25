# Licensing

Seira is open source under the [Apache License 2.0](LICENSE). Everything in
this repository uses that license. There is no source-available folder. A
Premium key changes only how many people can sign in to a self-hosted server
(see [People on a self-hosted server](#people-on-a-self-hosted-server)).

Seira is a modified version of OpenMausBot
(<https://github.com/milind-soni/OpenMausBot>). The copyright holders are
named in [NOTICE](NOTICE).

## Open-source edition

The server reports `{"edition":"oss"}`. Ordinary standalone operation needs no
license, and no key for up to 5 people. The server still looks for an optional
extension folder named `enterprise/` next to it and uses it only when present.
This repository does not ship that folder.

A workspace explicitly configured for hosted sign-in refuses remote access
without that optional extension. The server never bypasses a configured
sign-in authority.

## People on a self-hosted server

A self-hosted server is free for up to 5 people who sign in with an email.
More people need a Premium key from <https://cloud.seira.bot/premium>. An admin
pastes it in Settings → People, or sets `SEIRA_TEAM_KEY` where the server
starts.

- Every feature is the same on every plan. Premium adds no feature.
- The server checks the key offline. It never contacts a Seira service to
  check it.
- The limit applies only to new people. Nobody who can sign in loses access
  when a key ends or when a server with more than 5 people updates.
- A device paired with a code and an access token do not count as a person.
- A Team Cloud, My Cloud and a hosted workspace have no such limit.

Details: [How many people can sign in](docs/self-hosting.md#how-many-people-can-sign-in).

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
