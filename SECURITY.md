# Security

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub: on the repository page open **Security**,
then **Report a vulnerability**. You will get a reply within a few days.

Useful things to include: the Quill version, your OS, what an attacker could
do, and steps to reproduce.

## Scope

Quill records from the microphone, watches a global key and types into other
apps, so these are of particular interest:

- audio, transcripts or API keys leaving the machine when they should not;
- another local app or a web page driving Quill's typing or recording;
- problems in the update or release process.

## Supported versions

Only the latest release gets fixes.

## How releases are protected

- Installers are built by GitHub Actions from a `v*` tag only.
- Signing keys live in a protected environment that pull requests and
  branches cannot reach, and each release build waits for a maintainer's
  approval.
- Third-party actions are pinned to a commit hash.
