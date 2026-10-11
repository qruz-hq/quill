# Releasing

## The signing problem, honestly

macOS ties two things to an app's code signature:

1. **Gatekeeper**, an unsigned or ad-hoc-signed app is refused on any machine
   other than the one that built it. Recipients see *"can't be opened because
   Apple cannot check it for malicious software"*.
2. **Permission grants**: Accessibility and Microphone approvals are keyed to
   the signature. Change it and every user re-grants.
3. **Auto-update**: Squirrel.Mac verifies the signature of the downloaded build
   before applying it. Ad-hoc signed updates are rejected outright.

An **Apple Developer ID** ($99/year) plus notarization fixes all three. Without
it, sharing works but is manual and slightly hostile.

## Without a Developer ID

The app checks GitHub Releases and tells the user when a newer version exists,
opening the release page. They download and replace the app themselves.

Recipients must right-click → Open the first time, or run:

```bash
xattr -dr com.apple.quarantine "/Applications/Flow.app"
```

## With a Developer ID

```bash
export CSC_LINK=/path/to/DeveloperID.p12
export CSC_KEY_PASSWORD=…
export APPLE_ID=…            APPLE_APP_SPECIFIC_PASSWORD=…   APPLE_TEAM_ID=…
export GH_TOKEN=…            # repo scope, for publishing
bun run release
```

Set `mac.identity` in `electron-builder.yml` to your Developer ID and add
`afterSign` notarization. Auto-update then works end to end.

## Cutting a release

```bash
bun pm version patch   # or minor / major, bumps package.json
git push --follow-tags
```

Only the maintainer can push a `v*` tag. The tag starts the Release workflow,
which waits for approval of the `release` environment (Actions tab, Review
deployments). That environment holds the signing secrets:

| Secret | What |
|---|---|
| `CSC_LINK` | Developer ID Application certificate, a base64 `.p12` |
| `CSC_KEY_PASSWORD` | the `.p12` password |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | notarisation |
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | optional Windows certificate |

The workflow builds macOS (signed and notarised), Windows and Linux, and
attaches everything to a draft release. Publish the draft and installed copies
offer the update: macOS, Windows and the Linux AppImage download and install
it themselves; a deb install is sent to the release page.
