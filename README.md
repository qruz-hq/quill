# Quill

A local-first dictation app for macOS, Windows and Linux. Hold a key, speak, and the text is typed
into whatever app you are using.

Transcription runs entirely on your machine with [whisper.cpp](https://github.com/ggerganov/whisper.cpp).
Nothing is uploaded unless you opt into AI cleanup, and even then only the
transcript text, never audio.

## What it does

- **Dictation**, hold `fn` (or `⌃⌥D`) and speak; text is typed into the focused app
- **Whisper, on-device**, pick a model in Settings; only the one you choose downloads
- **Multi-language**, select several and it detects which you spoke
- **Snippets**, say a trigger, get a longer phrase typed
- **Transforms**, `⌥1`–`⌥9` reshape the last dictation
- **Scratchpad**, `⌥S` floating notepad; `⌥M` records straight into a note
- **Insights**, contribution grid, words per minute, most-used words
- **AI cleanup** (optional), your own OpenAI key tidies punctuation and lists

## Requirements

- macOS 14+ on Apple silicon, or Windows or Linux on x64 (preview, see [docs/PLATFORMS.md](docs/PLATFORMS.md))
- Accessibility permission (for the `fn` hotkey and typing into other apps)
- Microphone permission

## Development

```bash
bun install
bun run helper:build  # the Rust helper, every platform
bun run stt:build     # the Swift helper, macOS only
bun run dev
```

## Building a release

```bash
bun run package       # produces dist/mac-arm64/
```

## Signing

Builds are ad-hoc signed by default, which means macOS Gatekeeper will refuse to
open them on another machine and automatic updates cannot be applied. Both need
an Apple Developer ID certificate. See `docs/RELEASING.md`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security problems go through
[SECURITY.md](SECURITY.md), not public issues.

## License

[MIT](LICENSE)
