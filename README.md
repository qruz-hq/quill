# Flow

A local-first dictation app for macOS. Hold a key, speak, and the text is typed
into whatever app you are using.

Transcription runs entirely on your machine with [whisper.cpp](https://github.com/ggerganov/whisper.cpp).
Nothing is uploaded unless you opt into AI cleanup, and even then only the
transcript text — never audio.

## What it does

- **Dictation** — hold `fn` (or `⌃⌥D`) and speak; text is typed into the focused app
- **Whisper, on-device** — pick a model in Settings; only the one you choose downloads
- **Multi-language** — select several and it detects which you spoke
- **Snippets** — say a trigger, get a longer phrase typed
- **Transforms** — `⌥1`–`⌥9` reshape the last dictation
- **Scratchpad** — `⌥S` floating notepad; `⌥M` records straight into a note
- **Insights** — contribution grid, words per minute, most-used words
- **AI cleanup** (optional) — your own OpenAI key tidies punctuation and lists

## Requirements

- macOS 13+ on Apple silicon
- Accessibility permission (for the `fn` hotkey and typing into other apps)
- Microphone permission

## Development

```bash
bun install
bun run stt:build     # compile the Swift helper
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
