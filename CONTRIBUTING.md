# Contributing to Quill

Thanks for wanting to help. Quill is a dictation app for macOS, Windows and
Linux: an Electron and React front end, and a native helper that records,
transcribes and types.

## Before you start

- For anything larger than a small fix, open an issue first so we can agree on
  the approach before you spend time on it.
- Security problems do not go in public issues. See [SECURITY.md](SECURITY.md).

## Setup

You need [bun](https://bun.sh), a Rust toolchain and cmake. On macOS you also
need the Xcode command line tools.

```bash
bun install
bun run helper:build   # the Rust helper, every platform
bun run stt:build      # the Swift helper, macOS only
bun run dev
```

Use bun, not npm or yarn: the lockfile is `bun.lock`.

## Checks

Run these before you open a pull request. CI runs the same ones.

```bash
bun run typecheck
bun run test
bun run helper:test    # cargo tests plus the helper conformance suite
```

`helper:test` records from the microphone for a few seconds. Set
`HELPER_NO_MIC=1` to skip those tests.

## Where things are

| Path | What |
|---|---|
| `src/main` | Electron main process: windows, dictation state, settings |
| `src/preload` | The `window.flow` API the windows use |
| `src/renderer` | React UI: hub, Flow Bar, scratchpad, todos |
| `native/helper` | Rust helper (all platforms) |
| `native/stt` | Swift helper (macOS, the current default there) |
| `tests/helper` | Conformance suite any helper must pass |
| `docs` | Protocol, platform notes, motion spec, manual test lists |

A change to how main and the helper talk must update
`docs/HELPER-PROTOCOL.md` and the conformance suite in the same pull request.

## Pull requests

- Branch from `main` and open the pull request against `main`.
- Keep it to one change. Smaller pull requests get reviewed sooner.
- Say what you tested and on which OS. Windows and Linux reports are
  especially welcome, as those builds have had little real use.
- CI on a pull request from a fork waits for a maintainer to approve the run.
  It has no access to signing keys or other secrets.
- Do not edit `.github/workflows` unless that is the point of the pull request.

## Style

- Match the code around you: naming, comment density, formatting.
- UI copy is plain and short.
- No em dashes anywhere: code, comments, copy or docs.

## License

Quill is released under the [MIT License](LICENSE). By contributing you agree
that your contribution is licensed under the same terms.
