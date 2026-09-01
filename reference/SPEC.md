# Wispr Flow — reverse-engineered reference spec

Captured 2026-08-28 from Wispr Flow **v1.6.721** (macOS, Electron, bundle id `com.electron.wispr-flow`)
via on-screen inspection + static analysis of `/Applications/Wispr Flow.app/Contents/Resources`.

---

## 1. Stack facts (confirmed from the bundle)

| Fact | Value |
|---|---|
| Runtime | Electron (`app.asar`, 210 MB) |
| Bundle id | `com.electron.wispr-flow` |
| Version | 1.6.721 |
| Localisation | ~45 `.lproj` locales |
| Theming | Full light **and** dark token sets |

### Fonts — all four are free Google Fonts (bundled as variable TTFs)

| Font | Role |
|---|---|
| **Figtree** (+ Italic) | Primary UI sans — nav, body, buttons, headings |
| **EB Garamond** (+ Italic) | Display serif — promo banner headlines, Settings page titles. The italic is used for the emphasised word ("Make Flow sound like *you*") |
| **Manrope** | Secondary sans |
| **Google Sans Code** (+ Italic) | Monospace |

`assets/fonts/{Figtree,EBGaramond,Manrope,Google_Sans_Code}/`

### Bundled assets

| Folder | Count |
|---|---|
| `icons/` | 143 SVG |
| `illustrations/` | 35 |
| `images/` | 82 |
| `appLogos/` | 91 (third-party app icons for the per-app Style feature) |
| `logos/` / `transparentLogos/` | 27 / 36 |
| `sounds/` | 26 WAV (`dictation-start`, `dictation-stop`, `paste`, `achievement`, `Notification`, `popo-lock`…) |
| `lottie/` | `celebration.json`, `pulsing_circle.json` |
| `videos/` | 3 |
| `frame/`, `tray/` | 10 / 2 |

---

## 2. Design tokens (extracted verbatim from the CSS)

Every scale ships a light and a dark value. Full dump: `css-variables-raw.txt` (267 vars).

### Brand scales

**`sand`** — warm off-white chrome (window, sidebar, cards). *The signature surface colour.*
```
50 #fcfcfb   100 #faf9f7   200 #f8f7f3   300 #f7f6f2   400 #f6f5f1   500 #f5f4f0
600 #eeebe3  700 #c5c0b3   800 #a39d8e   900 #b3b2ad   950 #c8c8c2
dark: 50 #141414  100 #1a1a1a  200 #1f1f1e  300 #292928  400 #2e2e2c  500 #333331
      600 #464544  700 #71716e  800 #9d9c98  900 #736e62  950 #4d4a42
```

**`vast`** — greyscale text/borders
```
50 #e9e8e1  100 #deddd7  200 #c8c8c2  300 #b3b2ad  400 #9d9c98  500 #878683
600 #9d9c98  700 #b3b2ad  800 #c8c8c2  900 #c8c8c2  950 #deddd7
dark: 50 #1a1a1a  100 #242423  200 #353534  300 #464544  400 #71716e
      600 #71716e  700 #5b5b59  800 #464544  900 #30302f  950 #1a1a1a
```

**`dawn`** — lavender/purple (usage meter, Upgrade card, Flow Bar accent dot)
```
50 #fdfbff  100 #fcf7ff  200 #faf1ff  300 #f7ebff  400 #f4e1ff  500 #f0d7ff
600 #d2ace9  700 #d2ace9  800 #e4c8f5  900 #f0d7ff  950 #f7ebff
dark: 50 #2a2339  100 #322840  200 #3c2947  300 #502b66  400 #6c358c
      500 #a26ec1  600 #c48fdf  700 #a26ec1  800 #6c358c  900 #502b66  950 #3c2947
```

**`fathom`** — deep teal (Insights charts, streak heatmap)
```
50 #e2f5f2  100 #ceedea  200 #b8e4dc  300 #9fd9cf  400 #84cdc1  500 #68bdb0
600 #4daa9d  700 #369489  800 #247872  900 #1a5c5c  950 #034f46
base: #034f46 (light) / #34d399 (dark)
```

**`lumen`** — ivory `50 #fffffd … 500 #f7f7db … 950 #a9a939`, base `#ffffeb` / `#deddd7`
**`signal`** — pink `50 #fffcfe … 500 #ffbcf2 … 950 #3f0433`
**`glow`** — amber `200 #facda1  300 #ffa946`
**`flare`** — coral `400 #ff6c4c`
**`chord`** — purple `600 #7232a6` (light) / `#c48fdf` (dark)
**`shade`** — `black #000` / `white #fff`, inverted in dark to `#deddd7` / `#1a1a1a`
**`focus`** — `#03b2cb`
`--accent` is overloaded for Google-Calendar event colours (`#039be5 #0b8043 #33b679 #3f51b5 #616161 #7986cb #8e24aa #d50000 #e67c73 #f4511e #f6bf26`).

### Layout / motion tokens
```
--dialog-border-radius: 12px          --dialog-border-width: 1px
--sidebar-rail-width: 48px            --spring-duration: 0.2s
--nudge-duration: 3.2s
--waveform-bar-width: 2px / 2.5px
--audio-level-meter-segment-width: 16px
--audio-level-meter-segment-height: 48px
--audio-level-meter-segment-radius: 9999px
--instruct-header-fade-height: 120px  --instruct-footer-fade-height: 86px / 140px
--single-line-end-fade-width: 20px
```

---

## 3. Surfaces

### 3.1 Main window ("Flow Hub")
Frameless-ish rounded window (~14px radius), traffic lights + a sidebar-collapse icon top-left,
bell + account avatar top-right. Two-pane: `sand` sidebar over a white content card.

**Sidebar** (~172pt): logo lockup `▍▍▍ Flow` (4-bar audio-meter glyph + Figtree bold wordmark), then nav:

| Item | Icon |
|---|---|
| Dictation | microphone |
| Notetaker | filled record circle |
| Insights | bar chart |
| Dictionary | book |
| Snippets | scissors |
| Style | `Tᴛ` |
| Transforms | magic wand |
| Scratchpad | note |

Active item = filled `sand-600` rounded-8 pill. Below: usage card (lavender `dawn-100`,
"**1325** words remaining" with the number in `chord`/purple, subcopy, black `Upgrade to Pro`
pill button). Footer: Invite your team · Get a free month · Settings · Help.

### 3.2 Dictation (home)
- `Welcome back, {name}` (Figtree, ~26px)
- Promo banner: dark rounded-16 card, blurred photo bleed right, EB Garamond headline with
  italic emphasis, subcopy, light `Start now` pill + a purple pulse dot
- `TODAY` section label + search icon; transcript rows = `time | text`, hover reveals
  **play · copy · flag · ⋯**. Row click copies + fires a green toast:
  *"You can also paste your last transcript with ^ Ctrl + ⌘ Cmd + v"*
- `⋯` menu: Undo AI edit · Retry transcript · **Delete transcript** (red) · Extract audio
- Right rail: `2,328 total words` / `108 wpm` / `2 day streak`, then a **Voice Profile** card
  ("Task Orchestrator") with an illustrated avatar

### 3.3 Notetaker
Header + `Start tutorial` / `+ New note` / gear. Ask-bar ("How should I prepare for my next
meeting?" with a `Past chats ›` affordance). `☀ GUI'S DAY` strip → empty state (calendar glyph,
"No meetings found", black `Connect calendar` button). Tabs `My notes | Shared with me`, date-
grouped note rows. Right rail: note detail card — title (EB Garamond), timestamp, `Open Note`,
`Overview:` summary.

### 3.4 Insights
Tabs `Your usage | Your voice`. Circular "SHARE · SHARE ·" rotating badge top-right.
Row 1 — three stat cards: `108 WORDS PER MINUTE` with a teal gauge arc + "Top 2%";
`245 FIXES MADE BY FLOW` (101 words corrected / 144 dictionary fixes);
`2,328 TOTAL WORDS DICTATED` (Desktop breakdown + `Download on mobile`).
Row 2 — **Desktop usage** horizontal teal bars (AI prompts 55% · other tasks 23% · work messages 9%
· personal messages 7% · emails 7% · documents 0%) and **2 day streak** GitHub-style contribution
heatmap (Sun–Sat rows, month nav arrows, More→Less legend, "Current streak" swatch).

### 3.5 Dictionary
`Add new` black button. Tabs `All | Personal | Shared with team` + search/sort/refresh icons.
Dismissible promo card (warm photo, EB Garamond "Flow spells the way *you* do."), chip row.
List rows, hover → pencil / trash / star.
**Add-to-vocabulary modal**: title, `Correct a misspelling` + `Share with team` toggles,
text input, `Cancel` / `Add word`.

### 3.6 Snippets
Same chrome as Dictionary. Promo: "The stuff *you* shouldn't have to re-type." with
trigger → expansion chip pairs. Rows render `trigger → expansion`.

### 3.7 Style
Tabs `Personal messages | Work messages | Email | Other | Auto cleanup [Beta]`.
Currently the "Make Flow sound like *you*" onboarding banner only.

### 3.8 Transforms `[Beta]`
Header has an `Opt in` toggle + a keycap hint `⌥ Opt + O to view changes`.
Promo card with floating app icons. `My Transforms` grid of cards, each with a keycap badge
(`⌥ Opt 1`), name, description — Polish, Prompt Engineer, + a dashed `Create your own` tile.
`Reset to defaults` · black `Create New`.

### 3.9 Scratchpad `[Beta]`
`Add to Flow Bar` toggle + `⌥ Opt + S to Open`. Promo card with an inline mini-window mock.
`Recents` list: title / preview / date / time, hover → edit / pin / delete.

### 3.10 Settings (modal, 12px radius, own left rail)
`SETTINGS`: General · System · Notetaker · Vibe coding · Connectors · MCP
`ACCOUNT`: Account · Team · Plans and Billing · Data and Privacy
Footer: `Flow v1.6.721` + a cloud-sync glyph.

- **General** — Shortcuts (`Hold fn and speak`), Microphone, Dictation Languages, App Language select
- **System** — Launch app at login / Show Flow Bar at all times / Show app in dock; Sound:
  Dictation and notification sounds / Mute music while dictating; Notifications…
- **Notetaker** — Notify before scheduled meetings start (15 sec), Show next meeting in menu bar,
  Automatically detect any call, Maximum recording length (2 hours), Stop Notetaker when a call ends
- **Vibe coding** — Variable recognition (VS Code, Cursor, Windsurf) `Set up`; File Tagging in Chat
- **Connectors** — progress bar `0/2 connected`; Google Calendar, Slack
- **MCP** — Add to Claude / Add to ChatGPT; copyable URL `https://api.wisprflow.ai/connect/mcp`
- **Data and Privacy** — Improve the model for everyone (off), Dictation cloud storage,
  Context awareness, Local data storage select

### 3.11 Flow Bar ⭐ the signature UI
A floating always-on-top window docked to the **right screen edge**, vertically centred.
Idle = a thin dark rounded-full sliver. On hover it expands into a vertical stack of four
~28pt black circular buttons, each with a black rounded-pill tooltip to its left:

| Button | Tooltip |
|---|---|
| globe | `Change language` |
| microphone (lighter fill) | `Dictate  fn` |
| record circle | `New note  Opt+M` |
| note | `Scratchpad  ⌥ Opt s` |

Plus a `‹` chevron to collapse. Waveform + level-meter tokens above drive the recording state.

### 3.12 macOS menu-bar extra
See all upcoming meetings · Past notes › · Start Notetaker · Open Wispr Flow · Check for updates… ·
**Paste last transcript** `^⌘V` (with a greyed preview of the last transcript) · Shortcuts ·
Microphone › · Languages › · Help center · Talk to support `⌘B` · Share feedback · Quit `⌘Q`

### 3.13 App menu bar
`Wispr Flow · File · Edit · Dictation · Notetaker · My Voice · View · Help · Window`
Notetaker → Start new note `⇧⌘R` · See all upcoming meetings · Past notes › · Open Notetaker

### 3.14 Account popover (avatar)
Avatar + name + email · `You are on Flow Free` / `1325 of 2000 words left this week` /
`Get Flow Pro` · `Get a free month of Flow Pro` / `Refer a friend` · `Download Flow for mobile`
(+ QR glyph) · `Manage account`

---

## 4. Not yet captured
- Flow Bar **active recording** state (waveform animation) — needs a live mic trigger
- Notetaker in-call recording window
- Scratchpad floating window (`⌥S`)
- Style setup wizard, Transform create/edit sheet, Snippet add sheet
- Onboarding / sign-in flow (would need a logged-out account)
- Dark mode (tokens exist; needs the OS toggle)
- Account / Team / Plans and Billing panes (skipped — personal data)
