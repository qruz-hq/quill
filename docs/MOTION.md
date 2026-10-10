# Quill Motion Spec

Status: **authoritative** · v2 · 2026-10-10
Scope: every animated surface in Quill: the Flow Bar, Hub (bento home, nav, mic picker, settings, snippets/transforms, dialogs, banners, toasts), Onboarding & permissions, Scratchpad and Todos.
Companions: the Motion board in `design.pen` (tokens and storyboards), the interactive HTML spec page, and the machine-readable `motion-tokens.json`. If any of them disagrees with this document, this document wins. Fix the other one.

Specs target the **design** state model in `design.pen` (top nav, settings route, full-screen onboarding with the title bar and top nav still visible, bento). Where the code differs today (left Sidebar, Settings/Permissions sheets), the code hook is noted and the motion follows the design.

Colour names in this document are `design.pen` variables (`$surface`, `$error`, …). Code uses the same names as CSS custom properties (`var(--surface)`).

**What changed in v2** (for the board, the HTML page and code): five choreographies brought back under 600 ms; per-word blur removed from frequent surfaces (route, pane and dialog titles, warnings, errors, banners); springs retuned so expressive moments visibly breathe (`spring.morph` 0.34/0.25, `spring.expressive` 0.40/0.25, new `spring.pop`, `spring.fluid` bounce 0.2); cadence-adaptive stream pacing; no `layout`/`layoutId` anywhere in the Flow Bar; real-height animation instead of layout scale for banners and step cards; new tokens (`dur.flash`, hover in/out, `loop.*`, `ring`, `dist.nudge`, `dist.tile`, `scale.*`, `LEVEL`, `WORD_VARIANTS`); an interruption rule for one-shot choreographies; hidden-window first-show handling; accessibility (inert exits, focus hand-off, no transcript live region); and the open items resolved (§8).

---

## 0. Hard rules (read first)

1. **Everyday UI ≤ 250 ms.** Clicks, hovers, toggles, dropdowns, popovers, list changes, route switches and pane switches all fit this budget, *including their titles*. For springs, the budget is the `visualDuration` (perceptual), not the settle tail.
2. **Signature moments ≤ 600 ms**, measured from the trigger (t = 0) to the last perceptual finish of every element in the choreography. All `t` values in this document are absolute within their choreography. Static holds such as "show the check for 180 ms" are not motion and don't count. Two exceptions are named, never implied:
   - **Chained moments.** A choreography that starts because a *separate* trigger arrived (for example, the user clicks Done after the Done state has landed) has its own t = 0. A table marks every chained step with "chained".
   - **The live stream.** Flow Bar words arriving while you speak are a continuous process, not a choreography. Each word's own animation is ≤ 220 ms and the pacing is bounded by the partial cadence (§3.3).
3. **Springs for anything spatial or interruptible** (size, position, shape, clip). **Tweens for opacity, colour and blur.** Bounce ≤ **0.25** for spatial/size motion; ≤ **0.4** only for scale-only pops of glyphs ≤ 24 px at signature moments (`spring.pop`). `spring.text` (0.3) is the one other exception: it moves headline words ≤ 0.25 em, so its overshoot is sub-pixel. `clip-path` never uses a bouncy spring (§4.1.6).
4. **Never block input.** Every transition can be interrupted. Springs retarget from their current value and velocity. Nothing queues. One-shot choreographies follow the interruption rule in §6.3.
5. **Reduce Motion = no animation at all.** Every state change is instant, including fades, blur, pulses, spinners and per-word reveals. See §5.
6. **Never animate across a backdrop root.** Never animate `opacity`, `filter`, `mask`, `clip-path` or `transform` on an element that is, or contains, a `backdrop-filter` element. In Chromium any of these on an ancestor turns it into the backdrop root, so the glass samples nothing until the animation ends, then pops. Screen switch, tile entrance, dialog, toast and the Todos panel animate a content layer that is a *sibling* of the glass layer, not its parent.
7. **No `transition: all`. No static `will-change`.** At rest, `filter` must be `none` (not `blur(0px)`) and `transform` must be `none`.
8. **No nested filters, and one headline at a time.** An element never runs a filter animation while an ancestor is animating a filter. At most **one** per-word headline is in flight per window. Any other copy in the same choreography reveals as a block with its container.
9. **Exiting content is inert.** From the first exit frame, every exiting subtree gets `inert` and `pointer-events: none`. Focus returns to the trigger at t = 0 of a menu or dialog exit, not after it.
10. **One transform channel per element.** An element's transform comes either from Motion's independent `x`/`y`/`scale` (springs) or from a `transform` string tween (WAAPI), never both. Put entrance tweens on an inner wrapper and press/hover scale on the outer interactive element.

---

## 1. Feeling & principles

**Quill moves like ink settling.** Words resolve out of a soft blur into sharp type. Shapes breathe between states instead of popping. The app feels alive while you speak and calm the rest of the time.

| Principle | What it means in Quill |
|---|---|
| **Fluid** | The Flow Bar is one continuous object. Sliver, capsule, recording pill, busy pill, error and notice are all the same shape morphing. Everything comes out of the right-edge pill and goes back into it, Dynamic Island style. Selection indicators (nav pill, radio dot, pane pill) fly between positions instead of teleporting. |
| **Expressive (sparingly)** | Bounce, blur-words and choreography are reserved for moments with meaning: starting to talk, words arriving, a permission granted, onboarding done, the first view of home. Carbon's rule applies: expressive motion is for *occasional, important* moments. |
| **Interruptible** | You can release fn mid-morph, hover out mid-expand, or click a different nav item while a page is fading. Springs retarget and keep their velocity. Exit animations never delay the next state. |
| **Purposeful** | Every animation explains cause → effect (row inserted *because* you dictated; counter changed *because* the row arrived) or tells you where something went (card collapses into the pill that owns it). If motion explains nothing, remove it. |
| **Quiet by frequency** | The more often you see something, the less it moves. Hovers are colour-only. Keyboard-driven in-app actions (menu arrows, autocomplete highlight, list navigation) do not animate. Route, pane and dialog titles swap as one unit, never per word. The Flow Bar is seen dozens of times a day, so its everyday morphs stay ≤ 250 ms with low bounce. Bounce and long reveals belong to the moments that happen once. |

### Expressive vs productive

| Tier | Where | Durations | Springs | Blur-words |
|---|---|---|---|---|
| **Productive** | Settings controls, lists, menus, dropdowns, popovers, hover/press, toasts, dialogs, Scratchpad editor and tabs, Todos | ≤ 250 ms | `spring.snap`, `spring.snappy`, `spring.ui`, `spring.exit`, `spring.meter` (bounce ≤ 0.1) | Labels (`label`), digits, `block` fades; never per word |
| **Fluid** | Flow Bar everyday morphs, nav pill, pane pill, route/pane switches, todos panel, Scratchpad window, mic picker, notice pill | ≤ 250 ms | `spring.fluid` (bounce 0.2) | **Flow Bar live stream only** |
| **Expressive / signature** | Flow Bar recording entry, busy and completion (and its hub echo on `dictations:added`), error, first bento entrance, onboarding (entrance, granted flip, done), Try-it → Home hand-off, card → dialog container transform | ≤ 600 ms total | `spring.morph`, `spring.expressive`, `spring.pop` (bounce 0.25–0.4) | `headline`, `title` (rare moments only), `body` |

---

## 2. Tokens

All tokens live in one module: `src/renderer/src/shared/motion/tokens.ts` (§6.2). CSS mirrors them in `src/renderer/src/shared/motion/motion.css` as custom properties for CSS-only transitions such as hover colour. The same values are published as `motion-tokens.json` for the board and the HTML spec page.

**Every number in §4 is either a token named here or a property of a token (a variant's own duration, a ring's scale).** A raw number in a component is a QA failure (§7).

### 2.1 Duration scale (tweens)

| Token | ms | CSS var | Use |
|---|---|---|---|
| `dur.instant` | 0 | `--dur-instant` | Reduce Motion; keyboard-driven highlight moves; focus rings; menu item highlight |
| `dur.hoverIn` | 60 | `--dur-hover-in` | Hover colour/bg/border **on enter** (crisp arrival) |
| `dur.flash` | 80 | `--dur-flash` | Content outs inside a morphing shape: glyph/label/content exits, tooltip exit, route/pane outgoing page, row-action hide |
| `dur.micro` | 100 | `--dur-micro` | Exits of small things (menus, chips, badges), row-action reveal, stream-word exit ceiling |
| `dur.tooltip` | 125 | `--dur-tooltip` | Tooltip enter |
| `dur.fast` | 150 | `--dur-fast` | Opacity enters for popovers, check strokes, digit exits, colour on selection, notice/toast/Scratchpad exits |
| `dur.hoverOut` | 160 | `--dur-hover-out` | Hover colour/bg/border **on leave** (soft release) |
| `dur.base` | 200 | `--dur-base` | Standard enter for toasts, colour tweens on status changes, row content |
| `dur.moderate` | 250 | `--dur-moderate` | **Everyday ceiling** |
| `dur.reveal` | 300 | `--dur-reveal` | Data-viz reveals (streak clip sweep), hand-off tile opacity/blur, checklist icon stroke |
| `dur.expressive` | 400 | `--dur-expressive` | Tile entrance, headline perWord (delayed start), single signature property |
| `dur.signature` | 600 | `--dur-signature` | **Hard cap** for any choreography end to end |

Holds (not motion; listed so everyone uses the same numbers):

| Token | ms | Use |
|---|---|---|
| `hold.tooltipDelay` | 500 | First tooltip in a group |
| `hold.tooltipGrace` | 600 | After a tooltip closes, neighbours open with no delay or animation for this long |
| `hold.hoverIntentOpen` | 80 | Flow Bar sliver → capsule |
| `hold.hoverIntentClose` | 300 | Flow Bar capsule → sliver after the pointer leaves (allows diagonal travel) |
| `hold.successCheck` | 180 | Flow Bar check visible before collapse |
| `hold.notice` | 4000 | Flow Bar notice, toasts (paused on hover, focus-within, window hidden) |
| `hold.transformNotice` | 1600 | Flow Bar "Applied · ⟨name⟩" notice |
| `hold.error` | 6000 | Flow Bar error (paused on hover / focus-within) |
| `hold.bannerSuccess` | 400 | Permission banner check visible before it leaves |
| `hold.highlight` | 400 | Changed-row highlight (`$violet-soft`) visible before it fades over `dur.moderate` |
| `hold.todoCheck` | 450 | Checked todo stays in place (undo window) before moving to Completed |
| `hold.copied` | 1200 | "Copied" check before reverting to the copy icon |
| `hold.devicesSettle` | 400 | Coalesce `mic:devices` bursts |
| `hold.dwell` | 350 | Todos left-edge dwell before the panel opens (§4.12) |
| `hold.coalesce` | 120 | Merge number/progress updates closer than this |
| `hold.pendingDelay` | 150 | Show a spinner/placeholder only if work is still pending after this |
| `hold.partialThrottle` | 100 | Max one `dictation:partial` per 100 ms from main |
| `hold.closeTimeout` | 300 | Main closes a window anyway if the renderer's exit handshake hasn't answered |
| `hold.spamWindow` | 400 | "More than 2 clicks within 400 ms → instant swaps" (date picker months) |

Loops (the only infinite or repeating motion in the app):

| Token | Spec | Use |
|---|---|---|
| `loop.pulse` | `opacity 1 → 0.45 → 1`, 1200 ms `ease.inOut`, infinite while the state lasts | Rec dot, listening chip dot, "Waiting for macOS…" dot, KeyRecorder dot |
| `loop.spin` | `rotate 0 → 360°`, 700 ms `linear`, infinite while work is in flight | Spinners |
| `loop.indeterminate` | 30 % segment slides left → right, 1100 ms `linear`, infinite | Indeterminate progress |
| `loop.promo` | `ring.promo` once per 1600 ms, **3 cycles**, then stop | Promo CTA dot |

### 2.2 Easing curves

| Token | `cubic-bezier` | Motion array | Use |
|---|---|---|---|
| `ease.out` | `(0.23, 1, 0.32, 1)` | `[0.23, 1, 0.32, 1]` | **UI default for entering** and for blur clears. Quint-out: responsive start, long soft landing |
| `ease.enter` | `(0.05, 0.7, 0.1, 1)` | `[0.05, 0.7, 0.1, 1]` | Expressive entrances (tiles, headline opacity/blur). M3 emphasized-decelerate |
| `ease.exit` | `(0.3, 0, 0.8, 0.15)` | `[0.3, 0, 0.8, 0.15]` | Things leaving and ending invisible. M3 emphasized-accelerate |
| `ease.standard` | `(0.2, 0, 0, 1)` | `[0.2, 0, 0, 1]` | On-screen colour tweens where a spring is not used (track colours, tints, chips) |
| `ease.drawer` | `(0.32, 0.72, 0, 1)` | `[0.32, 0.72, 0, 1]` | Reserved for any future sheet/drawer. Vaul curve |
| `ease.inOut` | `(0.45, 0, 0.55, 1)` | `[0.45, 0, 0.55, 1]` | `loop.pulse` only |
| `linear` | - | `"linear"` | `loop.spin`, `loop.indeterminate` only |

Rules: never use ease-in for an entering element. Exits run at **0.4–0.8×** the matching entrance, and never longer than `dur.fast` (150 ms) for a surface exit.

### 2.3 Spring presets

Motion syntax: `{ type: "spring", visualDuration, bounce }`. Each preset has an exact stiffness/damping equivalent for mass 1 (`k = (2π/d)²`, `c = 4π(1−bounce)/d`, ζ = 1 − bounce) so it can be ported to CSS `linear()` or native code. Peak overshoot = `exp(−πζ/√(1−ζ²))`.

| Token | visualDuration (s) | bounce | ≈ stiffness | ≈ damping | ζ | Overshoot | Use |
|---|---|---|---|---|---|---|---|
| `spring.snap` | 0.15 | 0 | 1755 | 83.8 | 1.0 | 0 | Press down/up (`scale`), knob squash, capsule button reveal, screen/pane incoming nudge |
| `spring.snappy` | 0.20 | 0.10 | 987 | 56.5 | 0.9 | 0.15 % | Toggle knob travel, checkbox/check pops, radio dot, badges, selection circles, keycap pops |
| `spring.ui` | 0.25 | 0 | 632 | 50.3 | 1.0 | 0 | Real-height reveals, list reflow, popover/dialog scale, progress fill, **every `clip-path`** |
| `spring.fluid` | 0.25 | 0.20 | 632 | 40.2 | 0.8 | 1.5 % | Nav/pane active pills, sliver ⇄ capsule, tooltip slide, toast in, todos panel in, notice pill, Scratchpad window |
| `spring.exit` | 0.20 | 0 | 987 | 62.8 | 1.0 | 0 | **Terminal** collapses only: → sliver, card dismiss, dialog/menu close |
| `spring.meter` | 0.28 | 0 | 503 | 44.9 | 1.0 | 0 | Level-driven meters (mic chip level dot). Data, not decoration |
| `spring.text` | 0.30 | 0.30 | 439 | 29.3 | 0.7 | 4.6 % of ≤ 0.25 em | The `y` settle of headline words only |
| `spring.gesture` | 0.30 | 0.20 | 439 | 33.5 | 0.8 | 1.5 % | Drag release and drag cancel (todo reorder), anything carrying pointer velocity |
| `spring.pop` | 0.32 | 0.40 | 386 | 23.6 | 0.6 | 9.5 % (0.5 → 1 peaks ≈ 1.047) | **Scale-only** pops of glyphs ≤ 24 px at signature moments: granted check, Flow Bar done check, first-of-day streak cell |
| `spring.morph` | 0.34 | 0.25 | 342 | 27.7 | 0.75 | 2.8 % (≈ 2.6 px on the 64 → 157 grow) | Flow Bar state-to-state morphs (→ recording, ↔ busy, → error) **in both directions**, step card ⇄ row height, container transforms (card → dialog, Try-it → Hero), tile `y` on first entrance |
| `spring.expressive` | 0.40 | 0.25 | 247 | 23.6 | 0.75 | 2.8 % (0.5 → 1 peaks ≈ 1.014) | Reserved for larger (> 24 px) signature pops, always from `scale.popSignature` (0.5). No use in v2 screens; kept so the board and code agree |

Rules:
- `spring.morph`, `spring.pop` and `spring.expressive` exist only in the expressive tier (§1). Never use them for hover, menus, settings controls, Scratchpad or Todos.
- **State-to-state** morphs (recording ↔ busy ↔ error) use `spring.morph` in both directions. `spring.exit` is only for **terminal** collapses (→ sliver, card dismiss, dialog/menu close).
- Opacity and colour never use a bouncy spring. When a spring is needed for them, use `spring.ui`.
- `clip-path` always uses `spring.ui` (bounce 0) or `spring.exit`, so an overshoot can never drive an inset below 0. The bouncy spring goes on `x`/size only.
- Per-property transitions are normal: `transition={{ default: SPRING.morph, opacity: { duration: DUR.fast, ease: EASE.out } }}`.

### 2.4 Stagger

| Token | Value | Cap | Use |
|---|---|---|---|
| `stagger.tight` | 15 ms | 8 items | Expand-group rows, Most-used bars, hand-off Recent rows, Todos panel items (cap 6) |
| `stagger.list` | 20 ms | 8 items | List entrances on first show (Recent rows, Todos Clear exits) |
| `stagger.handoff` | 20 ms | 6 tiles | Bento tiles in the onboarding hand-off (§4.6.5) |
| `stagger.tiles` | 40 ms | 7 tiles | Bento first entrance, diagonal wave (§4.3.1) |
| `stagger.title` | 30 ms | 8 words (rest with the 8th) | `title` variant (rare moments only) |
| `stagger.bodyCompact` | 12 ms | 8 words (rest as one block with the 8th) | `body.compact` |
| `stagger.ring` | 6 ms | - | Flow Bar waveform rings, centre-out on entry, outer-in on collapse |
| `stagger.digits` | 20 ms | 3 digits (rest with the 3rd) | Changed digits, right → left |
| `stagger.stream` | `clamp(35, 0.55 × EMA(partialInterval) / N, 90)` ms | - | Flow Bar live words, N new words in one partial. EMA α = 0.3, seeded at 1500 ms |
| `stagger.flush` | 20 ms | - | Unstarted stream words when a new partial or `dictation:final` arrives mid-burst |
| `stagger.headline` / `fit` | `STAGGER.fit(n, perWord, start, total = 600)` = `min(60, (total − start − perWord) / (n − 1))` ms | - | Fit-to-total: the last word lands by `total`. **If the result is < 12 ms, the words reveal together as one unit** |

**Fit-to-N** always means the **absolute** end time `N` of the parent choreography (t = 0 is the trigger), with `start` being the variant's absolute start. Items beyond a cap enter together with the last capped item. Never stagger more than **8** list items. A list entrance never exceeds **500 ms** total. **Popovers, menus, selects and autocomplete never stagger their rows**: rows enter with the container.

### 2.5 Distance, scale, blur, ring

| Token | Value | Use |
|---|---|---|
| `dist.xs` | 2 px | Stream words y, hover lift on transform cards |
| `dist.sm` | 4 px | Popover/menu/date-picker y, action reveal x, Todos item y, error actions y |
| `dist.nudge` | 6 px | Route switch x, tooltip x, Recent row y, banner content y, tracker rows y, step body y, done text x |
| `dist.md` | 8 px | Pane switch y, dialog y, toast exit, row exit x, Scratchpad y, card x on unfurl |
| `dist.tile` | 12 px | Bento tile y (first entrance and hand-off), notice exit x |
| `dist.lg` | 16 px | Toast in y, notice in x, onboarding tile y, month swap x, Todos panel exit x |
| `dist.xl` | 24 px | Todos panel enter x |
| `scale.press` | 0.97 | Buttons, tooltip enter, Try-it tile enter |
| `scale.pressIcon` | 0.92 | 32 px round Flow Bar buttons and icon buttons |
| `scale.pressCard` | 0.98 | Cards, clickable tiles, first-entrance tile scale |
| `scale.enter` | 0.96 | Popovers, menus, dialogs, toasts, notice pill (never animate from 0) |
| `scale.exit` | 0.98 | Popover/dialog/autocomplete exit, filtered-out cards |
| `scale.chip` | 0.9 | Status chips, `@Project` token, chip enters |
| `scale.reveal` | 0.85 | Flow Bar capsule buttons on reveal |
| `scale.exitIcon` | 0.8 | Button/icon exits, spinner ring enter, keycap enter, error icon enter |
| `scale.pop` | 0.6 | Badges, checkbox fills, rec dot from idle, selection circles (with `spring.snappy`) |
| `scale.popSignature` | 0.5 | Signature glyph pops (with `spring.pop`/`spring.expressive`) |
| `scale.lift` | 1.02 | Picked-up drag item |
| `scale.hoverBar` | 1.06 | Flow Bar buttons on hover |
| `blur.xs` | 2 px | Content cross-fade mask (state swaps inside a morphing shape), date-picker month, row exits |
| `blur.label` | 3 px | `label` and `block` variants, re-blur, error/permission copy, capsule buttons |
| `blur.sm` | 4 px | Stream/body words, digits ≤ 20 px, small enters, unit titles, Scratchpad window |
| `blur.md` | 6 px | `title` variant, dialogs, toasts, large numerals ≥ 32 px, hand-off tiles |
| `blur.lg` | 8 px | First-entrance tiles, onboarding tiles, Todos panel, headline min |
| `blur.max` | 10 px | Absolute max anywhere (headline at ≥ 44 px type) |

**One attention ring recipe.** A ring is an outline layer (`::after`, 1.5 px, current accent colour) that scales out and fades once:

| Token | scale | opacity | Duration / easing | Use |
|---|---|---|---|---|
| `ring` | 1 → 1.3 | 0.5 → 0 | 420 ms `ease.out`, once | Error icon tile, granted chip/icon tile, banner granted icon |
| `ring.dot` | 1 → 1.6 | 0.6 → 0 | 420 ms `ease.out`, once | ≤ 8 px dots (mic chip level dot on disconnect). A small target needs more relative growth to be seen |
| `ring.promo` | 1 → 1.4 | 0.6 → 0 | 1600 ms `ease.out`, `loop.promo` (3 cycles) | Promo CTA dot only |

### 2.6 Elevation & z

| Level | Use | Shadow token (static layer) | z-index |
|---|---|---|---|
| `e0` | Flat page, rows | none | 0 |
| `e1` | Tiles, cards, Flow Bar shape | tile shadow | 1 |
| `e2` | Popovers, menus, date picker, autocomplete, tooltips | popover shadow | 100 |
| `e3` | Dialog, toast, dragged item, lifted card | overlay shadow | toast 200 · scrim 300 · dialog 310 · drag 400 |

Elevation changes such as a card lifting on hover or an item picked up for drag do **not** animate `box-shadow` directly. Each elevated element has a `::after` shadow layer at the target shadow, and its **opacity** animates (`dur.base`, `ease.out`). A moving element raises its z-index at the start of the motion and lowers it on complete, so it never slides under a neighbour.

### 2.7 Level meter constants (`LEVEL`)

| Constant | Value | Use |
|---|---|---|
| `LEVEL.tickMs` | 42 | History shift interval (≈ 24 Hz) for scrolling waveforms |
| `LEVEL.decay` | 0.86 per 16.7 ms, frame-independent: `0.86 ^ (dt / 16.7)` | Release after a peak |
| `LEVEL.floorPx` | 4 | Bar length at silence |
| `LEVEL.rangePx` | 22 | Bar length added at level 1 (max 26 px) |
| `LEVEL.minRateHz` | 24 | If `dictation:level` arrives slower than this, `useLevel` interpolates between samples (attack over 1 frame, decay as above) instead of stepping |
| `LEVEL.reducedHz` | 4 | Reduce Motion static meter update rate (5 segments) |

### 2.8 Entrance recipes (`ENTRANCE`)

Named bundles for the tile choreographies, so §4 never carries raw numbers:

| Recipe | Opacity | Content blur | y / scale | Stagger | Use |
|---|---|---|---|---|---|
| `entrance.tile` | 340 ms `ease.enter` | `blur.lg` (8 px), 360 ms `ease.enter`, first 4 large tiles only | `dist.tile` + `scale.pressCard`, `spring.morph` | `stagger.tiles` | Bento first entrance (§4.3.1) |
| `entrance.handoff` | `dur.reveal` `ease.enter` | `blur.md` (6 px), `dur.reveal` `ease.enter`, first 3 tiles only | `dist.tile`, `spring.ui` | `stagger.handoff` from t = 120 | Bento in the onboarding hand-off (§4.6.5) |
| `entrance.onboarding` | `dur.expressive` `ease.enter` | `blur.lg` / `blur.md` / `blur.sm` by size, `dur.expressive` `ease.enter` | `dist.lg`, `spring.morph` | explicit starts | Onboarding tiles and the Try-it tile (§4.6) |

### 2.9 Migration of existing CSS motion

| Today (`styles/tokens.css`, `hub.css`) | v2 |
|---|---|
| `--spring-duration: 0.2s` with plain `ease` (5 uses) | `--dur-base` with `--ease-out` for entering/hover-like transitions, `--ease-standard` for colour-only. Delete `--spring-duration` once the screens port |
| `--nudge-duration: 3.2s` + infinite `promo__dot` pulse | Removed. Promo dot uses `ring.promo` × `loop.promo` (3 cycles, then static) |
| Any `transition: … ease` | Replaced by a named curve: `ease.out` (enter, hover), `ease.exit` (leave), `ease.standard` (colour on screen). Plain `ease` is a QA failure |

---

## 3. Blur-word system

Three components share one engine:
- `<BlurWords>` for static UI copy (headlines, titles, labels, block copy)
- `<BlurStream>` for live transcription with diffing (Flow Bar, Try-it tile, transform preview)
- `<BlurNumber>` for digits

All three live in `src/renderer/src/shared/motion/`.

### 3.1 Anatomy and splitting

```
<h1 class="headline">
  <span class="sr-only" style="user-select:none">Hold fn to talk.</span>
  <span aria-hidden="true" class="bw">
    <span class="bw-tok"><span class="bw-word">Hold</span></span><span class="bw-tok">␠<Keycap class="bw-word">fn</Keycap></span><span class="bw-tok">␠<span class="bw-word">to</span></span><span class="bw-tok">␠<span class="bw-word">talk.</span></span>
  </span>
</h1>
```

- **Token = separator + word.** Each token is a keyed `<span class="bw-tok">` (the AnimatePresence child) holding its **leading** whitespace as a plain, non-animated text node, followed by the animated `<m.span class="bw-word">`. Line-break opportunities stay native, and a deletion removes the word and its separator together (no double space while it exits, no 1-space jump on settle).
- Word spans are `display: inline-block` (transforms need it) with `white-space: pre`. Punctuation stays attached to its word.
- Inline components such as the `fn` keycap in "Hold fn to talk." count as **one token** in the sequence and animate like a word.
- Never split into letters.
- **Static UI copy** (headlines, titles, labels): a visually hidden real-text copy (`user-select: none`) plus **one** `aria-hidden` wrapper. Do not use `aria-label` on generic elements, and do not put `aria-hidden` on each span.
- **User content** (Recent row text, transform preview, voice note, Try-it text): **no sr-only twin**. The spans are the only text. Whitespace stays in real text nodes, so screen readers, selection, copy and find-in-page read it once and normally. No `aria-hidden`.
- At rest: `filter: none; transform: none; opacity: 1` (Motion `transitionEnd`). Spans may remain. Do not swap to a plain text node after settling, because that risks a reflow jump.
- Fonts: split after `document.fonts.ready` resolves (fonts are `font-display: block`, so this is one tick in practice). Render the wrapper with `opacity: 0` until the first animation frame, so un-animated text never flashes.
- **Em-based values are resolved to px once per element** from `getComputedStyle(el).fontSize` after `document.fonts.ready`: blur = `clamp(8, 0.2 × fs, 10)` px for headlines, y = `k × fs` px. Animate `blur(Npx) → blur(0px)` with `transitionEnd: { filter: "none" }`, and never animate to the keyword `none` (Motion can't interpolate it, and its JS fallback would jump).

### 3.2 Variants (exact parameters, `WORD_VARIANTS`)

Each word animates from `{opacity: o0, filter: blur(B), y: Y}` to `{opacity: 1, filter: blur(0px), y: 0}` and then `transitionEnd` → `filter: none; transform: none`. **Opacity leads the blur**: opacity finishes at about 70 % of the blur duration, so the word is fully present while its last bit of softness clears (Apple's TextRenderer pattern). This also hides the AA "pop" when the layer is dropped.

| Variant | Use (exhaustive) | B (blur) | Y | Opacity | Filter | Transform | Stagger | Max total |
|---|---|---|---|---|---|---|---|---|
| `headline` | Hero headline (first show per launch, hand-off diff) and onboarding headlines ("Two switches, then talk.", "You're set.") | `clamp(8, 0.2·fs, 10)` px | `0.25·fs` | 315 ms `ease.enter` | 450 ms `ease.enter` | `spring.text` | `fit` (delayed-start rule) | 600 ms |
| `title` | **Rare moments only:** empty-state headings ("All clear.", empty Recent), error-card titles | 6 px | `0.18·fs` | 220 ms `ease.out` | 320 ms `ease.out` | 320 ms `ease.out` | `stagger.title` | 600 ms |
| `titleUnit` | Route titles, Settings pane headers, dialog titles. **One unit, no split** | 4 px | `0.12·fs` | 160 ms `ease.out` | 200 ms `ease.out` | 200 ms `ease.out` |, (starts at t = 40 → ends 240) | 240 ms |
| `label` | Status chips, Flow Bar head ("TRANSCRIBING" → "POLISHING"), button label swaps, device name, autosave state, tooltip labels. One unit | 3 px | 0 | 110 ms `ease.out` | 160 ms `ease.out` | - | - | 160 ms |
| `block` | Warnings, error meta/messages, bind-failed rows, banner messages, permission body copy, notice copy, engine descriptions, test results, footer notes. One unit, **readable on the first frame** (o0 = 0.35) | 3 px | 0 | 160 ms `ease.out` from 0.35 | 160 ms `ease.out` | - | - | 160 ms |
| `body` | Voice note arriving in Scratchpad (§4.9) | 4 px | `0.12·fs` | 160 ms `ease.out` | 240 ms `ease.out` | 240 ms `ease.out` | `fit` to the choreography's end; only the first **40** words split, the rest fade as one block with the 40th | 600 ms |
| `body.compact` | A new Recent row's text, a retried row's text | 4 px | `0.12·fs` | 110 ms `ease.out` | 160 ms `ease.out` | 160 ms `ease.out` | `stagger.bodyCompact` (12 ms, cap 8 → 84 + 160 = **244 ms**) | 250 ms |
| `stream` | Flow Bar live partials, Try-it live text, transform preview (§3.3) | 4 px | `dist.xs` | 160 ms `ease.out` | 220 ms `ease.out` | 220 ms `ease.out` | `stagger.stream` (live) or catch-up `fit` | per word 220 ms |

Exits and swaps:

| Swap | Spec |
|---|---|
| `label` A → B | A exits as one unit (`opacity → 0`, `blur(3px)`, `dur.flash` `ease.exit`). B enters with `label` overlapping (AnimatePresence `mode="popLayout"`, B starts at t = 40 → ends 200). If the label's width changes, the container's real `width` animates with `spring.ui` (never `layout` scale on text) |
| `block` A → B | A `opacity → 0`, `blur(2px)`, `dur.flash` `ease.exit`; B `block` at t = 40 → ends 200 |
| `titleUnit` A → B | A `opacity → 0`, `dur.flash` `ease.exit` (no blur); B at t = 40 → ends 240 |
| `headline` swap | All old words exit **together** (`opacity → 0`, `blur(8px)`, `y −0.15·fs`, 150 ms `ease.exit`). New words start at t = 80 with the delayed-start rule |
| Stream delete | `opacity → 0`, `blur(3px)`, `dur.flash` `ease.exit` + neighbour re-blur (§3.3) |
| Stream substitution re-blur | `filter: [blur(3px), blur(0px)]`, `opacity: [0.45, 1]`, 240 ms `ease.out`, **no y** |
| Neighbour re-blur (after a delete) | `filter: [blur(2px), blur(0px)]`, `opacity: [0.7, 1]`, 160 ms `ease.out`, no y |

**Delayed-start rule (headline):** when a headline starts at t > 0 inside a larger choreography, perWord drops to `dur.expressive` (400 ms; opacity 280 ms) and the stagger is `STAGGER.fit(n, 0.4, start)`, so the last word lands by 600 ms. If the fitted stagger falls below 12 ms, the words reveal together as one unit. Every use in §4 states its resulting stagger.

**Where per-word blur is NOT used** (frequency or readability): route/pane/dialog titles (`titleUnit`), inline warnings, error meta and messages, bind-failed rows, banner messages, permission copy (`block`), toasts (block with the toast), menu items, buttons. Error and permission copy must be readable on the first frame.

**Implementation note: the headline is the one place where `y` uses a spring** (`spring.text`). There are few words, so a main-thread spring is fine. Every other variant animates a `transform: "translateY(Npx)"` **string** with a tween on the inner `.bw-word`, so opacity, filter and transform all run as WAAPI while React reconciles (rule 10: nothing else sets a transform on that node).

### 3.3 Streaming partials (Flow Bar)

**Input contract (code hook, §6.5 #2):** `dictation:partial` always carries the **full running text** of the current dictation:
- Cloud (ElevenLabs realtime, `stream.ts`): `committed.join(' ') + ' ' + lastPartial`, emitted on **both** `partial_transcript` and `committed_transcript` messages. Broadcasting the raw partial would look like a full delete + re-insert at every commit, because `partial_transcript` resets on each commit.
- Local helper: the full re-transcription string, about every 1.5 s. Because partials re-decode the whole buffer (`partialInFlight` skips ticks), the cadence degrades below 1.5 s on long dictations. The pacing below adapts to that.
- Main throttles to at most one `dictation:partial` per `hold.partialThrottle` (100 ms). `dictation:final` follows.

Model: `words: Array<{ id: string; raw: string; norm: string; confirmed: boolean; rev: number }>`.

**Diff on each partial (`wordDiff.ts`, pure, unit-tested):**
1. **Tokenize:** `text.trim().split(/\s+/)`. Drop bracketed non-speech tokens before diffing (`/^[\[(].*[\])]$/`: `[BLANK_AUDIO]`, `(music)`).
2. **Normalize** for comparison: lowercase and strip `[.,!?;:"“”'’]`. A token that normalizes to `''` (`-`, `-`, `…`) uses its **raw** text as the key, so such tokens don't all compare equal.
3. **Fast path:** the longest common prefix (LCP) of normalized tokens keeps its `id`s and does **not** animate.
4. **Tails:** run Myers on the full old and new tails after the LCP with **maxD = 24**. If the edit distance exceeds 24, cross-fade the whole tail as one block (`opacity` + `blur(4px)`, `block` timings, no per-word) and re-key it.
5. **Pair runs explicitly:** a run of *d* deletes and *i* inserts at the same position becomes `min(d, i)` substitutions in order, then `|d − i|` inserts or deletes.
6. Result per token:
   - **equal, raw identical** → keep `id`, no animation.
   - **equal, raw differs** (casing/punctuation: `hello` → `Hello,`) → update the text **in place, no animation**.
   - **insert** → new `id`, plays `stream` enter, paced by `stagger.stream`.
   - **substitute** → keep the slot `id`, bump `rev`, set the new text **immediately**, mark it **unconfirmed** again, and play the substitution **re-blur**. The re-blur must **not remount**: keep `key={id}` and run an imperative `animate(el, { filter: ["blur(3px)","blur(0px)"], opacity: [0.45, 1] }, …)` in an effect keyed on `rev`. `key={id + rev}` would replay the enter with y and jump the line.
   - **delete** → the token (word + its separator) exits with the stream delete (`dur.flash`). The **first word after the deletion on the same line** plays the neighbour re-blur to mask the reflow. All other neighbours are untouched.
7. Never key by index. One inserted word would then re-key and re-blur everything after it.
8. **Polished text is never diffed in.** The card shows the raw final; AI polishing output is inserted into the target app but not streamed into the card. If that ever changes, apply the block cross-fade when more than 30 % of tokens change.

**Confirmation (LocalAgreement-2 styling):** a word counts as *confirmed* once it appears in the same aligned position in two consecutive partials.
- Unconfirmed words rest at **`color: color-mix(in srgb, var(--fg) 60%, transparent)`**, not at `opacity: 0.6`. A colour needs no per-word opacity layer, so only animating words are promoted.
- On confirmation, the colour goes to `var(--fg)` over `dur.fast` `ease.out`, with no blur.
- Skip the confirm tween if the done choreography (§4.1.8) starts within 100 ms; the text exits from its current colour anyway.

**Cadence-adaptive pacing (`stagger.stream`):** N inserts in one partial get `clamp(35, 0.55 × EMA / N, 90)` ms in reading order, where EMA is the exponential moving average of the interval between partials (α = 0.3, seeded at 1500 ms). Example: 6 words at 1.5 s → 90 ms each, spread over 450 ms, so the words read as steady typing rather than a clump followed by 1.3 s of nothing. Each word's own animation stays 220 ms.
- **Flush:** when a new partial or `dictation:final` arrives mid-burst, already-started words keep animating, words not yet started are re-diffed against the new text, and surviving unstarted words start at `stagger.flush` (20 ms). No queue.
- **Catch-up at unfurl:** words already buffered when the card unfurls (§4.1.6) use `STAGGER.fit(n, 0.22, start)` capped at 35 ms, so the last one ends ≤ 600 ms after the unfurl trigger. If the fitted stagger is < 12 ms, they reveal as one block (`block` timings with `blur(4px)`). Only words arriving after the unfurl use `stagger.stream`.

**Filter budget (allocated per batch, not counted on completion):**
- At schedule time, each batch (burst, catch-up, re-blur set) asks `filterBudget.take(k)` for up to `12 − active` slots. The first words in reading order get filter keyframes; the rest animate opacity and transform only.
- Slots are released in a `finally` on each WAAPI `animation.finished` promise (which also settles on cancel) **and** in the effect cleanup on unmount. Motion's `onAnimationComplete` is not used for accounting, because it doesn't fire on interruption, re-diff or unmount during exit.
- `filterBudget.reset()` runs whenever the stream is cleared (new dictation).

**Final (`dictation:final` or stage → idle with text):** run one last diff (substitutions re-blur), flush unstarted words, and mark all remaining words confirmed. The text then hands off to the success choreography (§4.1.8).

**Overflow and wrapping (Partial card, text box 276 × 2 lines):**
- The text container is a fixed-height clip box with **4 px padding on all sides** so blur halos are not clipped. Its content is bottom-anchored (`display: flex; flex-direction: column; justify-content: flex-end`).
- Older lines scroll up out of view. When a new line starts, the text block's `y` animates by exactly one line height with `spring.ui` (no overshoot), from its measured offset; nothing else moves. Word spans never get `layout`, because measuring 50 spans per partial is too expensive.
- The top edge uses `mask-image: linear-gradient(to bottom, transparent 0, #000 12px)` on the static text container, never on an element that also has a running `clip-path` or transform spring in the same frame.

**Accessibility:** the visual transcript is `aria-hidden`. There is **no** live region for the transcript: the Flow Bar is `focusable:false` and never key, VoiceOver does not reliably speak `aria-live` from a non-frontmost app, and the final text is typed into the target app, which VoiceOver already echoes. The bar has **one** polite sr-only status region for state words only ("Recording", "Transcribing", "Inserted", error/notice copy). This is best-effort and must be verified with VoiceOver (§7).

### 3.4 Numbers & digits (`<BlurNumber>`)

- Format with `Intl.NumberFormat` (grouping on). Each character renders in its own slot. The **wrapper** has `font-variant-numeric: tabular-nums`, `position: relative` and an explicit `line-height`/height, so absolutely-popped glyphs never collapse the line box and slot widths are stable before measuring.
- Key each slot by **position-from-right**, and each glyph by `slot + char`.
- Only changed digits animate, inside `AnimatePresence mode="popLayout" initial={false}`. The trend is always `sign(new − old)`.

| Size | Exit (old glyph) | Enter (new glyph) |
|---|---|---|
| ≤ 20 px (default) | `opacity → 0`, `blur(4px)`, `y −0.35·fs × trend`, `dur.fast` `ease.exit` | from `opacity 0`, `blur(4px)`, `y +0.35·fs × trend` → rest, 220 ms `ease.out` |
| ≥ 32 px (tile numerals: Words today, WPM) | same with `blur(6px)`, `y 0.3·fs` | same with `blur(6px)`, `y 0.3·fs` |
| `subtle` (timer, download %, word counts) | `blur(2px)`, `y 0.2·fs`, `dur.micro` | `blur(2px)`, `y 0.2·fs`, `dur.fast` |

- Changed digits stagger `stagger.digits` (20 ms) **right → left**, capped at 3 digits (the rest move with the 3rd), so 9,999 → 10,000 doesn't trail.
- When the width changes (99 → 100, 999 → 1,000), the wrapper's real `width` animates with `spring.ui`. New leading slots enter with the same enter.
- **Coalescing:** updates closer than `hold.coalesce` (120 ms) are merged, so only the latest value animates.
- **No count-up from 0.** On first show, a number enters as one unit with its tile (no rolling, no filter of its own if the tile is blurring; rule 8).
- Accessibility: sr-only formatted value plus an `aria-hidden` glyph wrapper. The 1 Hz timer is **never** inside `role=status`/`aria-live`, or it would be announced every second.

### 3.5 Performance caps for blur

| Cap | Value |
|---|---|
| Concurrent live `filter` per window (words + elements) | **12**, allocated per batch (§3.3). Overflow gets opacity/transform only |
| Concurrent large blurred surfaces (> 300 × 150 px: tiles, dialog, panel, Scratchpad card) | **4**. Every surface beyond the 4th gets **opacity/transform only** (no reduced-radius variant) |
| Nested filters | **None.** A filter never runs inside an ancestor's running filter. A container that blurs excludes its headline (which blurs per word) and its digits/rows (opacity/y only) |
| Max radius | 10 px (`blur.max`) |
| Filter at rest | `none` via `transitionEnd` |
| `backdrop-filter` elements | Never animated, nor any ancestor (rule 6) |
| `text-shadow` blur trick | Not used |

Performance notes:
- Each live-filter word is its own compositor layer. 12 concurrent layers is fine **only if released**: `transitionEnd` must set both `filter: none` and `transform: none`, or the text stays a greyscale-rasterized promoted layer. QA measures this with DevTools › Layers (layer count back to baseline), not by eye.
- Page-level surfaces (route, pane) never blur. Blur belongs to words, tiles and small surfaces.

### 3.6 Replay & visibility rules

- **Hero headline** ("Hold fn to talk."): `headline` plays on the **first hub show per app launch**, and its words diff on the onboarding hand-off (§4.6.5). Otherwise it renders at rest. It does not replay on route return, window refocus, or when the hub window is destroyed and recreated in the same launch (main passes `firstShowDone` to the new window).
- **Route, pane and dialog titles:** `titleUnit` on change only. Never on re-render or focus.
- **Onboarding headlines:** always play, because onboarding is rare.
- **Stream:** always plays.
- **Digits:** always play on value change, never on mount.
- **Hidden windows and first-show entrances.** The hub, Todos and Scratchpad are created with `show:false` and shown on `ready-to-show` (or `showInactive()`), so their first render happens while `document.visibilityState === "hidden"`.
  - **First-show entrances** (bento first entrance, Todos panel open, Scratchpad open, onboarding entrance) render their **initial frame** (opacity 0, blurred, offset) while hidden, then start on the first `visibilitychange → visible` + one rAF, **or** on the main-process `win:shown` message, whichever comes first. Main sends `win:shown` right after `show()`/`showInactive()`; this is the fallback for a non-focused panel shown with `showInactive()`, where `visibilitychange` must be verified.
  - **Live-update choreographies** (`dictations:added`, granted flip, banners, toasts, digits) apply the **end state** when hidden. If the change matters (a permission granted while the user was in System Settings), that one choreography is deferred until the window becomes visible again (+100 ms).

---

## 4. Per-surface choreography

Notation: **Trigger → Elements → Properties (from → to) → Token → Delay/Stagger → Interruption.** Times are absolute within the choreography (t = 0 is the trigger). "Retarget" means the spring continues from its current value and velocity toward the new target. Every table that claims a total shows the element that ends last.

### 4.1 Flow Bar (window `flowbar`)

#### 4.1.1 Window: fixed and transparent, with click-through outside the shape

- **One fixed transparent window, never resized.** The current `bar:mode` → `setBounds(BAR_IDLE | BAR_OPEN)` path goes away. Code hook: owned by the other workflow / `src/main` (§6.5 #1).
- **Size:** 400 × 260 DIP. Derivation: widest state = card 304 + gap 8 + pill 44 + edge inset 8 + shadow/blur bleed 2 × 16 ≈ 396 → **400**. Tallest = error card 166 or capsule 158 plus `spring.morph` overshoot (2.8 %) and 2 × 16 bleed ≈ 224 → **260**, which leaves room for the language menu (§4.1.10a) and a tooltip taller than the pill.
- **Placement:** right-aligned to the primary display's work area, vertically centred, as today. Content is anchored **right-centre** inside the window. **Display or work-area change while visible:** main repositions the window instantly (`setBounds`, no animation); the DOM state and any running springs continue in window coordinates.
- Window flags as today (`transparent`, `frame:false`, `hasShadow:false`, `focusable:false`, `alwaysOnTop 'screen-saver'`, all workspaces). Add **`webPreferences.backgroundThrottling: false`** so rAF and animations run while the app is unfocused, which is the normal case for the bar.
- **Click-through:**
  1. Main creates the window with `win.setIgnoreMouseEvents(true, { forward: true })`. On macOS, mouse moves are still forwarded to the renderer.
  2. The renderer listens to `mousemove` on `document`, then hit-tests `document.elementFromPoint(x, y)?.closest('[data-hit]')`. Elements marked `data-hit` are the shape, the cards, the notice pill, the language menu and any interactive child. Tooltips are **not** marked.
  3. On a change, the renderer sends `bar:hit` (`true`/`false`). Main calls `setIgnoreMouseEvents(false)` or `setIgnoreMouseEvents(true, { forward: true })`.
  4. Hysteresis: the hit target is padded by 4 px using an invisible `::before` on the shape. `false` is sent on the **next `mousemove` or `mouseleave` without a hit** (no frame-based timer: when the pointer is still, no frame event exists).
  5. With ignore = false, the last event before the cursor leaves the 400 × 260 rect is a hit and no further `mousemove` arrives. So `mouseleave` on `document` and the window `blur` event both send `bar:hit false`.
  6. **Main-process backstop:** while ignore = true, main polls `screen.getCursorScreenPoint()` at 30 Hz (EdgeDwell already polls at 20 Hz) against the shape rect the renderer publishes on every state settle (`bar:shape-rect`), and re-asserts the ignore state if forwarding has silently stopped (display sleep, Space change, repeated toggles).
  7. The sliver's hit zone is **12 px wide** (the visual stays 6 px), so it can be found against the screen edge.
  8. **First implementation task: a spike** on Electron 33 and the target version. Pass criteria: forwarded `mousemove` reaches the `focusable:false` window while another app is frontmost; forwarding survives 1,000 ignore toggles, display sleep/wake and a Space change; hover → capsule latency ≤ `hold.hoverIntentOpen` + 1 frame.
- **No `layout` or `layoutId` anywhere in the Flow Bar.** The shape's size animates as real CSS values, so a child's layout projection would be measured against the parent's old box and snap at the end, and a `layoutId` card would scale-distort its 16 px radius, 1 px hairline and text. Instead, **every layer is absolutely positioned in window coordinates** from the geometry table (§4.1.2), and each layer animates its own `x`, `y`, `width`, `height`, `borderRadius`, `clipPath` and colour directly.
- **Shape rendering:** the shape is one `m.div` whose `width`, `height`, `x`, `y` and `borderRadius` are animated directly:
  - Shadow is drawn in DOM, because transparent windows have none. It is a static `box-shadow` on the shape. Repainting a pill-sized shadow is cheap.
  - Fill `$surface` with a 1 px `$line-strong` hairline in every bar state (sliver, capsule, recording, busy, error, notice), so **there is no fill tween between bar states** except the done tint (§4.1.8). No `backdrop-filter` on the shape.
  - Contents are absolutely positioned layers swapped with `AnimatePresence mode="popLayout"`, so content never stretches.
- **Occlusion note:** a transparent window that ignores the mouse can be treated as an occluder by Chromium on macOS (Electron PR #52365). Verify the hub isn't throttled to `visibilityState = "hidden"` while the bar overlaps it.

#### 4.1.2 Geometry per state (from `oQ6Qr`, window coordinates)

Window 400 × 260, origin top-left, vertical centre y = 130. `x, y` is each box's top-left.

| State | Shape (x, y, w × h, radius) | Attached layers |
|---|---|---|
| Idle / Sliver | 394, 98, 6 × 64, radius `6 0 0 6`, flush right | - |
| Hover / Capsule | 348, 51, 44 × 158, radius 22 (padding 6, gap 6) | Buttons 32 × 32, centre x 370: Language y 73, **Dictate y 111**, Voice note y 149, Scratchpad y 187. Tooltip: right edge 340, centred on the hovered button |
| Recording | 348, 51.5, 44 × 157, radius 22 | Rec dot 8 × 8 centred at (370, 69.5). Waveform 26 × 87 at (357, 83.5). Timer at (357, 180.5). Partial card (§4.1.6) when partials exist |
| Busy (transcribing/polishing) | 348, 106, 44 × 48, radius 22 | Spinner 16 × 16 centred at (370, 130). Partial card 36, 76.5, 304 × 107, radius 16 |
| Error | 348, 108, 44 × 44, radius 22 | Error card 36, 47, 304 × 166, radius 16 |
| Notice | Shape unchanged (sliver or capsule) | Notice pill 261 × 40, y 110, right edge 8 px left of the shape (x 125 next to the sliver, x 79 next to the capsule) |

#### 4.1.3 Idle ⇄ Hover (sliver ⇄ capsule), fluid tier

| | Spec |
|---|---|
| **Trigger** | Forwarded `mousemove` enters the sliver hit zone and stays for `hold.hoverIntentOpen` (80 ms) |
| **Shape** | Sliver → capsule geometry, radius `6 0 0 6` → `22` · `spring.fluid` · t = 0 → ends 250 |
| **Buttons** (radiate from Dictate) | `opacity 0 → 1` (`dur.micro` `ease.out`), `scale 0.85 → 1` (`scale.reveal`, `spring.snap`), `blur(3px) → blur(0px)` (`dur.fast` `ease.out`). **Dictate at t = 20; Language and Voice note together at t = 35; Scratchpad at t = 50** (`stagger.tight`) → last ends 50 + 150 = 200 |
| **Total** | 250 (shape) ✓ |
| **Close trigger** | Pointer outside the capsule (plus 4 px) for `hold.hoverIntentClose` (300 ms). Suspended while the language menu is open |
| **Close** | Tooltip out (`dur.flash`). Buttons together: `opacity → 0`, `scale → 0.8` (`scale.exitIcon`), `dur.micro` `ease.exit` · shape → sliver with `spring.exit` from t = 40 → ends 240 |
| **Interruption** | Re-entering during the close retargets the shape spring back to the capsule; buttons re-enter from their current opacity with no stagger. A dictation start in either direction goes straight to §4.1.4 from the current geometry |
| **Button hover** | `scale 1 → 1.06` (`scale.hoverBar`, `spring.snappy`), bg `dur.hoverIn` / `dur.hoverOut`. **Press:** `scale → 0.92` (`spring.snap`) on pointerdown, release with `spring.snappy` |

**Tooltip** (`iIu70`, `$surface` + `$line-strong`, label + keycap, e.g. "Dictate · fn"):
- **First show:** wait `hold.tooltipDelay`, then `opacity 0 → 1`, `x +6 → 0` (`dist.nudge`, slides out from the bar toward the left), `scale 0.97 → 1` (`scale.press`), `dur.tooltip` `ease.out`.
- **Moving between buttons:** a single tooltip element slides its `y` to the new button with `spring.fluid`. The label swaps with `label`. No delay and no re-fade.
- **Exit:** `opacity → 0`, `dur.flash`. For `hold.tooltipGrace` after an exit, the next tooltip opens instantly with no animation.
- **While recording:** the pill tooltip reads "Cancel · esc" (push-to-talk) or **"Stop · fn"** (hands-free latch, double-tap fn). When the latch engages mid-recording, the tooltip label swaps with `label`. This is the **only** visual difference of the latched mode.

#### 4.1.4 → Recording (signature, the moment you start talking)

| t (ms) | Element | Spec |
|---|---|---|
| - | **Trigger** | `dictation:state = "recording"` (fn hold, double-tap latch, ⌃⌥D, Dictate click, ⌥M voice note, tray). The bar responds on the **first frame** after the IPC message, with no hover intent and no waiting for the previous animation. Main registers the global Esc now (§4.1.11) |
| < 0 | Anticipation (Dictate click only) | Dictate button already at `scale 0.92` from pointerdown |
| 0 | Shape | From current geometry → recording geometry · `spring.morph` → ends 340. From idle this is a grow, which reads as the bar "inhaling". From the capsule it is a 1 px height change |
| 0 | Other buttons (capsule open) | `opacity → 0`, `scale → 0.8`, `blur(3px)`, `dur.micro` `ease.exit` → 100 |
| 0 | **Rec dot, from the capsule** | Two layers at the same coordinates. In the same frame the Dictate button unmounts, a dot layer mounts as a 32 × 32 `$violet` circle centred at (370, 111), and the mic glyph (its own layer) fades out over `dur.flash`. The dot's `x`, `y`, `width`, `height` (32 → 8) and `borderRadius` animate to the rec-dot slot (370, 69.5) with `spring.morph` → 340; `backgroundColor $violet → $error` over `dur.base` `ease.standard` |
| 60 | **Rec dot, from idle** | Mounted at its slot: `scale 0.6 → 1` (`scale.pop`, `spring.snappy`), `opacity` `dur.micro` → 260 |
| 60 | Waveform (15 bars, 3 px thick, 4–26 px long, `$fg-2`) | Bars `opacity 0 → 1`, `dur.micro` `ease.out`, centre ring first, `stagger.ring` (6 ms) per ring outward → last ring starts 96, ends 196. **Bar length is driven by the live level from the first frame** (no 0 → floor tween), so the first syllable is visible |
| 120 | Timer "0:00" (`$fg-2`) | `BlurNumber` enters as a unit: `opacity`, `blur(4px) → blur(0px)`, `dur.base` `ease.out` → 320 |
| 340 | Rec dot pulse | `loop.pulse` until the state leaves recording |
| | **Total** | 340 (shape, dot) ✓ |
| | **Interruption** | Stop before the entry finishes (a quick tap): retarget straight to Busy (§4.1.6) from the current values, and cancel unstarted waveform staggers. Error: §4.1.9. Esc: §4.1.11 |

#### 4.1.5 Recording, live

- **Level → waveform:** a single rAF loop per window (`useLevel`) reads the latest `dictation:level` (0–1).
  - Smoothing: attack `level = max(level, input)` immediately, decay `LEVEL.decay` frame-independently. If the measured event rate is below `LEVEL.minRateHz`, interpolate between samples.
  - Every `LEVEL.tickMs` the history shifts by one bar.
  - Each bar length = `LEVEL.floorPx + level × LEVEL.rangePx`, written **directly to style** (`width`, keeping round caps). There is no Motion component per bar and no React render per frame.
- **Timer:** m:ss, ticks at 1 Hz. Changed digits use the `BlurNumber` **subtle** variant.
- **Hover on pill:** bg `dur.hoverIn` / `dur.hoverOut`, plus the tooltip.
- **Click pill** = stop, which goes to §4.1.6.
- **Hover while recording** does not open the capsule.
- **Mic interrupted mid-recording** (`stt interrupted` → `stopDictation()`): the normal Busy path (§4.1.6) transcribes the audio captured so far. If the transcript is empty, Busy → Error ("Nothing came back"). The hub's mic chip shows the disconnect (§4.4).

#### 4.1.6 Partials and → Busy (transcribing / polishing)

**Design addition (frame on the Motion board): "Recording + live partial".** When the first `dictation:partial` arrives during recording (≥ 1 s of audio), the **Partial card** (`B2ifmT`, `$surface` + `$line-strong`) unfurls to the left of the recording pill, vertically centred on y = 130. Its head reads "LISTENING" + timer, and the text streams in (§3.3). Everything below applies whether the card first appears during recording or at stop.

**Card unfurl** (first appearance). T0 = 0 when it unfurls during recording; T0 = 60 when it unfurls at stop, so the pill starts shrinking first.

| t (ms) | Element | Spec |
|---|---|---|
| T0 | Card container | Positioned at (36, 76.5), 304 × 107, fixed height in every busy/recording state. Reveal from the pill side: `clip-path: inset(0 0 0 100% round 16px) → inset(0 0 0 0 round 16px)` with **`spring.ui`** (no overshoot, so the inset never goes below 0) · `x +8 → 0` (`dist.md`) with `spring.morph` · `opacity 0 → 1` `dur.micro` `ease.out` → T0 + 340 |
| T0 + 120 | Head (waveform icon + label `$fg-3` + time) | `opacity`, `blur(4px) → blur(0px)`, `dur.fast` `ease.out` → T0 + 270 |
| T0 + 120 | Text (`$fg`) | `BlurStream` **catch-up**: buffered words use `STAGGER.fit(n, 0.22, T0 + 120)` capped at 35 ms (one block if < 12 ms) → last word ends ≤ 600. Words arriving later use `stagger.stream` |
| - | Progress (276 × 3, track `$surface-3`, fill `$cyan`) | **No progress while recording.** The progress slot is reserved and empty, so the card height stays 107 across the stop. At stop: track `opacity 0 → 1`, `dur.fast` `ease.out` at t = 60 of the stop. **Indeterminate:** `loop.indeterminate`. **Determinate** (if the engine reports progress): fill width with `spring.ui` per update, coalesced at `hold.coalesce` |

**Recording → Busy** (`dictation:state = idle` + `dictation:stage = transcribing`):

| t (ms) | Element | Spec |
|---|---|---|
| 0 | - | Main unregisters the global Esc |
| 0 | Shape | Recording → busy geometry (157 → 48 high) · `spring.morph` (state-to-state) → 340 |
| 0 | Waveform | Bars collapse **outer → inner**: length → 0, `opacity → 0`, `dur.micro` `ease.exit`, `stagger.ring` → 136 |
| 0 | Timer | Exits as a unit: `opacity → 0`, `blur(4px)`, `dur.flash` `ease.exit` |
| 0 | Rec dot → spinner | Dot `scale → 0.6`, `opacity → 0`, `dur.flash`. Spinner (track `$line-strong`, arc `$cyan`) `opacity 0 → 1` `dur.fast`, `scale 0.8 → 1` (`spring.snappy`) at t = 80 → 280. Rotation `loop.spin` |
| 0 / 60 | Card | **If shown:** head label "LISTENING" → "TRANSCRIBING" (`label` swap → 200), the head timer freezes, progress track enters at t = 60 → 210. **If not shown:** it unfurls with T0 = 60 (clip ends 310, head 330, catch-up text ≤ 600) |
| | **Total** | 340 (shape); ≤ 600 including catch-up text ✓ |

**Transcribing → Polishing** (`stage = polishing`): head label "TRANSCRIBING" → "POLISHING" (`label`). Nothing else moves.

**Interruption:** a partial arriving mid-morph streams into the card normally. An error retargets to §4.1.9. `stage = idle` goes to §4.1.8. A new recording retargets the shape to §4.1.4 and the card collapses (`spring.exit` on clip-path).

#### 4.1.7 Partial word behaviour

This follows §3.3 exactly:
- New words blur in, paced by `stagger.stream` (cadence-adaptive), flushed at 20 ms when the next partial arrives.
- Corrected words re-blur in place (3 px, 0.45 → 1, 240 ms, no y, no remount) and become unconfirmed again.
- Deleted words blur out (`dur.flash`), and the next word on the line gets the neighbour re-blur.
- The unconfirmed tail sits at 60 % `$fg` (colour, not opacity).
- Filters are allocated per batch from the 12-slot budget.

#### 4.1.8 Done → paste (success moment)

Trigger: `stage = idle` after text insertion succeeded (gap #9: there is no feedback today).

| t (ms) | Element | Spec |
|---|---|---|
| 0 | Final text | Last diff applied, unstarted words flushed, tail confirmed (`$fg` 60 % → 100 %, `dur.fast`; skipped if the text is about to exit) |
| 0 | Spinner → check | Spinner `opacity → 0` (`dur.flash`). Check (`$success`) strokes in (`pathLength 0 → 1`, `dur.base` `ease.out` → 200) with `scale 0.5 → 1` (`scale.popSignature`, **`spring.pop`** → 320). Pill fill `$surface → $success-soft`, `dur.fast` `ease.standard` |
| 80 | Card "sends" into the pill | **Send-out supersedes everything in the text:** in-flight re-blurs and confirm tweens jump to rest in this frame, so no element carries a filter past the collapse. The text block moves `x → +6` (`dist.nudge`, toward the pill), `opacity → 0`, `blur(4px)`, `dur.fast` `ease.exit` → 230. The card collapses toward the pill: `clip-path → inset(0 0 0 100% round 16px)` with `spring.exit` → 280, and `opacity → 0` `dur.fast` `ease.exit` from t = 140 → 290. Everything converges into the pill |
| 200–380 | Hold | Check visible (`hold.successCheck`, from the stroke's end) |
| 380 | Pill → sliver | Check `opacity → 0` (`dur.flash`). Shape → sliver with `spring.exit` → **580**. Fill `$success-soft → $surface`, `dur.fast` `ease.standard` → 530 |
| | **Total** | 580 ✓ |

- **Done with copy fallback** (Accessibility missing, so the text went to the clipboard): **no check**, because nothing was pasted. t = 0 spinner out (`dur.flash`); t = 80 the card sends out exactly as above (→ 290) while the shape collapses to the sliver with `spring.exit` (→ 280); t = 160 the notice "Copied, press ⌘V to paste" enters (§4.1.10, → 410). Total 410 ✓.
- **Voice note:** identical; Scratchpad then opens with the note (§4.9, a chained moment triggered by `notes:changed`).
- **No partial card ever shown** (very short dictation): skip the card rows.
- **Interruption:** a new recording at any point retargets the shape straight to §4.1.4 from the current geometry, the check fades over `dur.flash`, and the fill returns to `$surface` over `dur.fast`.
- **Hub side effects** (other window, same `dictations:added`): see §4.3.2.

#### 4.1.9 Error

Trigger: `dictation:error` with `kind = error` (anything that isn't a notice, §4.1.10).

| t (ms) | Element | Spec |
|---|---|---|
| 0 | Shape | → error geometry (44 × 44) · `spring.morph` → 340. Fill stays `$surface` |
| 0 | Pill icon | Spinner/dot out over `dur.flash`. Error icon (`$error`) `opacity 0 → 1`, `blur(3px) → blur(0px)` `dur.fast`, `scale 0.8 → 1` (`spring.snappy`) at t = 60 → 260 |
| 0 | Card | **From the partial card:** its `height` 107 → 166 and `y` 76.5 → 47 animate directly with `spring.morph` (state-to-state) → 340. Old content exits (`opacity → 0`, `blur(2px)`, `dur.flash`). **From no card:** it unfurls as §4.1.6 with T0 = 0 (clip ends 250) |
| 80 | Icon tile (`$error-soft`) | `opacity` `dur.fast` → 230 |
| 80 | Title "Nothing came back" (`$fg`) | `title` per word (error-card titles are a rare moment): 3 tokens, `stagger.title` → 80 + 60 + 320 = **460** |
| 100 | Attention (no shake) | `ring` on the icon tile → 520 |
| 120 | Meta / message (`$fg-2`) | `block` → 280 |
| 160 | Actions (Try again `$error`, Change model `$surface-3`, esc `$fg-3`) | `opacity` + `y 4 → 0` (`dist.sm`), `dur.base` `ease.out`, `stagger.list` → 160 / 180 / 200, last ends **400** |
| | **Total** | **520** (ring) ✓ |

| Exit path | Spec |
|---|---|
| Dismiss | After `hold.error` (paused while hovered or focus-within), an action, or Esc **only while the pointer is over the card** (main registers a global Esc only while `bar:hit = true` over the error card and unregisters on `bar:hit false`; otherwise Esc stays with the user's app). Card collapses (`clip-path` with `spring.exit`, plus `opacity` `dur.fast` `ease.exit`), then the pill → sliver with `spring.exit` from t = 80 → 280 |
| Try again | The card collapses and the shape goes straight to Recording (§4.1.4) in parallel. No detour through the sliver |
| Change model | The card collapses and the hub opens on Settings › Speech models |
| Mic refused | Error choreography, plus the hub comes forward on Permissions (§4.6) |
| Error → Busy | A new `stage = transcribing` while the error is shown (retry of the same audio): card `height` 166 → 107 and `y` 47 → 76.5 with `spring.morph`, content swaps (`block` out/in) to the Partial head "TRANSCRIBING", shape → busy geometry with `spring.morph`, error icon → spinner |

#### 4.1.10 Notice

Kinds (code hook §6.5 #3: a `kind` on the message): copy fallback "Copied, press ⌘V to paste", key fallback "No key, using local model", cloud failure fallback, transform applied "Applied · ⟨name⟩", AI cleanup failed "Cleanup failed, raw text inserted" (`cleanup:error`).

| | Spec |
|---|---|
| Anchor | Notice pill (`lPWEY`, `$surface` + `$line-strong`, icon tile `$surface-3`, text `$fg`) at y 110, right edge 8 px left of the **current** shape. When the shape changes (sliver ⇄ capsule), the pill's `x` follows with `spring.fluid` |
| Enter | `x +16 → 0` (`dist.lg`, `spring.fluid`), `opacity 0 → 1` (`dur.fast`), `blur(4px) → blur(0px)` (`dur.base`), `scale 0.96 → 1` (`spring.fluid`). Text `label` at t = 60 → 220. Total 250 |
| Hold | `hold.notice` (4 s), or `hold.transformNotice` (1.6 s) for "Applied". Paused on hover and focus-within |
| Exit | `x → +12` (`dist.tile`), `opacity → 0`, `blur(4px)`, `dur.fast` `ease.exit` |
| Replace | A new notice while one is shown: the text does a `label` swap, and the pill's real `width` animates with `spring.ui`. No exit + enter |
| **During a dictation** (Recording or Busy) | No notice pill. The Partial card's head label swaps to the notice's short form ("LOCAL MODEL", "CLOUD FAILED · LOCAL") with `label`, colour `$fg-3 → $warn` over `dur.fast` `ease.standard`, and stays for the rest of the dictation. If the card isn't visible yet, it unfurls now (T0 = 0) showing only the head until the first partial. The full copy goes to the status region |
| Hover on the sliver while a notice shows | The capsule opens (§4.1.3); the notice re-anchors to the capsule with `spring.fluid`; its hold pauses |
| Error arrives while a notice shows | The notice exits (`dur.fast` `ease.exit`) ∥ §4.1.9. The error outranks it; the notice is not re-shown |

#### 4.1.10a Language button (design addition, frame on the Motion board)

Click opens a **language menu** to the left of the capsule: 200 px wide, up to 5 rows × 32 + 8 padding = 168 px (recent languages, "Auto-detect", "More in Settings…"), right edge at 340, vertically centred on the Language button and clamped to y ≥ 16 and y + h ≤ 244, so it always fits the 400 × 260 window. Menu rules from §4.11, with the origin at the Language button's left-centre and `x +4 → 0` (`dist.sm`) instead of y. The menu is `data-hit`. Choosing a language moves the check (`spring.snappy`), then the menu closes at t = 120. While it is open, the capsule's hover-intent close is suspended.

#### 4.1.11 Cancel (Esc / cancel action)

Main registers `globalShortcut('Escape')` **only while the state is `recording`** and unregisters it on the first frame of busy, error, notice or idle, so Esc is never stolen from the app the user is typing into. All at t = 0:
- Waveform collapses (`dur.micro`).
- Partial card words all blur out together (`opacity → 0`, `blur(4px)`, `dur.micro`); the card collapses (`clip-path` with `spring.exit`, `opacity` `dur.fast` `ease.exit`).
- Rec dot `opacity → 0` (`dur.flash`).
- Shape → sliver, or → capsule if the pointer is over it, with `spring.exit` → 200.

Total 200 ✓ (≤ 250). Applies from Recording mid-entry, Recording live and while the card is unfurling during recording (each from its current values).

#### 4.1.12 Flow Bar interruption matrix

| From \ to | Hover | Recording | Busy | Done | Error | Notice | Cancel (Esc) |
|---|---|---|---|---|---|---|---|
| Idle | §4.1.3 | §4.1.4 grow | - | - | §4.1.9 | §4.1.10 |, (Esc not registered) |
| Hover (mid-expand) | - | Retarget from current size; the dot hand-off runs only if Dictate is mounted, else the dot pops (§4.1.4 t = 60) | - | - | Buttons out (`dur.micro`) ∥ §4.1.9 | Capsule stays open while the pointer is over it; the notice anchors left of the capsule | - |
| Hover (open) | - | §4.1.4 from the capsule | - | - | As above | As above | - |
| Recording (mid-entry) | Ignored | - | Retarget to busy; cancel unstarted wave staggers | - | §4.1.9 from current values | Card head label (§4.1.10 "During a dictation") | §4.1.11 from current values |
| Recording (live, post-entry) | Ignored (tooltip only) | - | §4.1.6 | - | §4.1.9 | Card head label | §4.1.11 |
| Busy (card unfurling) | Ignored | §4.1.4; the card collapses with `spring.exit` | - | §4.1.8; the in-flight clip retargets to collapse | §4.1.9; card height retargets to 166 | Card head label |, (Esc not registered) |
| Busy | Ignored | §4.1.4; the card collapses | - | §4.1.8 (or the copy-fallback path) | §4.1.9 (card morphs) | Card head label | - |
| Done (mid-collapse) | Retarget to the capsule if hovered | Retarget to recording; check out `dur.flash` | - | - | §4.1.9 | §4.1.10 | - |
| Error | Hover pauses the hold; the capsule does **not** open | Card collapses ∥ §4.1.4 (Try again or fn) | Error → Busy (§4.1.9) | - | Replace content (`block` swap; title per word) | Dropped (error outranks) | Dismiss, only while the pointer is over the card |
| Notice | The capsule opens; the notice re-anchors; hold paused | Notice exits (`dur.fast` `ease.exit`) ∥ §4.1.4 | - | - | Notice exits ∥ §4.1.9 | Replace (`label` swap, width `spring.ui`) | - |

No state waits for an exit to finish. All shape springs retarget.

### 4.2 Navigation shell (hub title bar + top nav)

| Interaction | Spec |
|---|---|
| **Active nav pill** (Dictation / Snippets / Transforms / Settings) | Shared `layoutId="nav-active"` (a text-free pill, so projection can't distort type; `borderRadius` in `style`) inside a `LayoutGroup`, `layoutDependency` = active route. Moves with `spring.fluid`. Labels tween `$fg-2 → $fg` (and back) over `dur.fast` `ease.standard` |
| **Route switch** | **Outgoing** content layer: `opacity → 0`, `dur.flash` `ease.exit`, `inert`, removed from flow (`AnimatePresence mode="popLayout"`, `position:absolute` during exit). **Incoming** content layer, at t = 30: `opacity 0 → 1` (`dur.fast` `ease.out` → 180) and `x ±6 → 0` (`dist.nudge`, `spring.snap` → 180). The sign follows the nav index: `+` (enters from the right) when the new item is right of the old one, `−` when left. **No scale, no page blur, no tile stagger.** The incoming route title plays `titleUnit` at t = 40 → **240** ✓ |
| **Programmatic route changes** (`perms:show`, "Change model" from the Flow Bar, banner Fix, mic picker footer) | The same switch. There are no keyboard shortcuts for nav, so no keyboard variant is specified |
| **Interruption** | Clicking another item mid-transition retargets the pill. The in-flight incoming page becomes the outgoing one (inert at once), exiting from its current opacity. No queue, no stacked pages |
| **Nav item hover** | bg/colour `dur.hoverIn` / `dur.hoverOut` `ease.out`. **Press:** `scale 0.97` with `spring.snap`. **Focus-visible:** ring appears instantly |
| **Brand mark** | Static |
| **Hub window show/close** | Native macOS (no app motion). The first content render follows §3.6 (initial frame while hidden, start on visible / `win:shown`), then the first-show bento entrance (§4.3.1) |
| Code hook | Today: Sidebar collapse (`app--collapsed`, instant). If the sidebar survives: width with `spring.ui`, labels `opacity` `dur.micro`. In the design it's replaced by the top nav |

### 4.3 Dictation home (bento, `vBtIm`)

#### 4.3.1 First entrance (signature): first hub show per launch

Order (Carbon): shell → content → data viz last. **Title bar and nav** are present instantly with the window.

**Tiles** in a diagonal wave ordered by distance from the Hero tile's top-left: Hero, Words today, Streak, WPM, Most used, Recent, Scratchpad. Each tile animates its **content layer** (a sibling of any glass layer, rule 6):
- `entrance.tile`: `opacity 0 → 1` (340 ms `ease.enter`)
- `y 12 → 0` (`dist.tile`) and `scale 0.98 → 1` (`scale.pressCard`) with `spring.morph` (340)
- `blur(8px) → blur(0px)` (360 ms `ease.enter`) on the first **4** tiles only (the large-surface cap). The Hero's blur wrapper **excludes the headline node** (rule 8); digits and rows inside a blurring tile get opacity/y only
- `stagger.tiles` (40 ms)

| Tile | Start | Content blur | Opacity ends | y/scale ends |
|---|---|---|---|---|
| Hero | 0 | 8 px (chip, hint, wave; not the headline) → 360 | 340 | 340 |
| Words today | 40 | 8 px → 400 | 380 | 380 |
| Streak | 80 | 8 px → 440 | 420 | 420 |
| WPM | 120 | 8 px → 480 | 460 | 460 |
| Most used | 160 | none | 500 | 500 |
| Recent | 200 | none | 540 | 540 |
| Scratchpad | 240 | none | **580** | **580** |

Inside the tiles:

| t (ms) | Element | Spec | Ends |
|---|---|---|---|
| 80 | Hero headline "Hold fn to talk." | `headline`, delayed-start rule: 4 tokens, `(600 − 80 − 400) / 3` = **40 ms** stagger | **600** |
| 200 | Ready chip (`$scrim-dark-2`, dot `$lime`, label `$violet-on`) | `opacity`, `dur.fast` | 350 |
| 220 | Mini wave (10 bars `$lime`) | Bars at their floor, `opacity`, `dur.fast` | 370 |
| - | Numbers (Words today, WPM) | Enter with their tile, no rolling, no own filter | with tile |
| 240 | **Streak grid** (30 × 7) | Not per cell: `clip-path: inset(0 100% 0 0) → inset(0 0 0 0)` over `dur.reveal` (300 ms) `ease.out` (a single compositor-friendly value; no `mask-position` sweep) | 540 |
| 240 | **Most-used bars** | An inner fill `scaleX 0 → value` (origin left, square cap; the round end-cap is a separate element riding the same spring) with `spring.ui`, `stagger.tight` (5 bars: 240 → 300) | 550 |
| 240 | **Recent rows** | `opacity` + `y 6 → 0` (`dist.nudge`), `dur.base` `ease.out`, `stagger.list` (cap 8 → last starts 380) | 580 |
| | **Total** | Last finish: the headline | **600** ✓ |

Budget: live filters peak at 4 tile wrappers + 4 headline words = 8 ≤ 12; large blurred surfaces = 4.
**Return visits** (route back to Dictation): no tile stagger and no headline replay. Only the route switch (§4.2).
**Intel / low-end fallback** (if supported): tiles get no blur, opacity/transform only.

#### 4.3.2 Live updates

| Trigger | Elements | Spec |
|---|---|---|
| `dictation:state = recording` | Hero `Ready` chip | Label "Ready" → "Listening" (`label`). Dot `$lime → $error` over `dur.fast` `ease.standard`, then `loop.pulse`. Mini wave goes live (same rAF engine as §4.1.5, 10 bars). The level is written to style in a leaf component, never React state above layout nodes (§6.3) |
| `dictation:state = idle` | Chip | Back to "Ready" (`label`), dot `→ $lime`. Pulse stops. Mini-wave bars follow `LEVEL.decay` until every bar is at `LEVEL.floorPx`; no tween. Then the rAF loop stops |
| `dictations:added` | **Recent** list | New row inserts at the top: its wrapper's real `height` 0 → measured with `spring.ui`; siblings reflow natively each frame. Row content `opacity` + `y −6 → 0` (`dist.nudge`), `dur.base` `ease.out`. Row text plays `body.compact` (first 8 words, → 244 ms) **only if the hub is visible and focused**; otherwise it renders at rest. If the list shows N rows max, the last row exits (`opacity → 0` `dur.micro`, height `spring.exit`) |
| ″ t = 80 (after the row: cause → effect) | Words today, WPM, "All 38 today ›" | `BlurNumber`, trend = `sign(new − old)` per number (WPM can fall) |
| ″ | Most used words | Bar fills `scaleX` with `spring.ui`. On a re-rank, rows move with `layout="position"` (`layoutDependency` = ranking), `spring.ui`; the row moving up raises its z while moving. Counts use `BlurNumber` |
| ″ (first dictation of the day) | Streak today cell | Fill `$streak-0 → $streak-N` over `dur.base` `ease.standard`, `scale 0.5 → 1` with **`spring.pop`**. "7-day streak" → "8-day streak" digits use `BlurNumber` at t = 80 |
| ″ (current streak passes the longest) | "LONGEST 21 DAYS" | Digits `BlurNumber` (trend up) at t = 160, after the streak count |
| Day rollover (midnight, hub visible) | Streak grid, Words today | The grid's inner layer shifts one column left: `x +(cell + gap) → 0` with `spring.ui`; the oldest column leaves under the tile's clip; the new today column's cells `opacity 0 → 1` `dur.fast` at t = 60; the today marker rides the grid. Words today → 0 (`BlurNumber`, trend down). Hidden hub → end state |
| Row hover / focus | Row actions | Hover: `opacity 0 → 1`, `x 4 → 0` (`dist.sm`), `dur.micro` `ease.out`; leave `opacity → 0` `dur.flash`. Row bg `dur.hoverIn` / `dur.hoverOut`. `:focus-within` reveals the actions **instantly**, so keyboard users can reach them. **No row scale** |
| ⋯ click | Row menu (`I8sEup`) | §4.11 menu, origin = top-right of the ⋯ button. Items appear with the menu (no stagger). Item highlight instant |
| Menu › Copy | Toast | §4.10 |
| Menu › Undo AI edit | Row | Text `block` swap to the raw text. Row highlight `$violet-soft` appears instantly, holds `hold.highlight` (400 ms), then fades over `dur.moderate` `ease.out` |
| Menu › Retry | Row | Meta swaps to spinner (`loop.spin`) + "Retrying…" (`label`); text tints `$fg → $fg-3` (`dur.fast` `ease.standard`). On result: spinner out (`dur.flash`), text re-reveals with `body.compact`, meta `label` swap back to the time, counters `BlurNumber`. On failure: row bg `→ $error-soft` (`dur.base` `ease.standard`), meta "Failed" (`label`) |
| Menu › Extract audio | - | Native save sheet (no app motion). On save, toast "Audio saved" (§4.10) |
| Menu › Delete | Row | `opacity → 0`, `x → −8` (`dist.md`), `blur(2px)`, `dur.micro` `ease.exit`, inert. Real height → 0 with `spring.exit`; siblings reflow natively. Counters `BlurNumber`, trend down |
| Failed row | Row | Same insert as a normal row, with the `$error-soft` tint present from the start |
| Loading | Tiles | If data resolves within `hold.pendingDelay` (typical local IPC), no loading state. Otherwise placeholders show at `opacity 0.5`, and real content swaps in with `opacity` + `blur(4px) → blur(0px)` over `dur.base`. If the swap lands while the tile's first-entrance blur is still running, it runs concurrently with **opacity only** (rule 8). **No shimmer** |
| Empty | Recent tile | During the first entrance, "Nothing dictated yet, hold fn and speak." reveals as a block with its tile (the hero headline is in flight, rule 8). When Recent *becomes* empty later (last row deleted), the heading plays `title` at t = 0 (7 tokens → 180 + 320 = 500) |
| Banner appears/leaves | Bento | The banner wrapper's real `height` animates (§4.5); the bento grid reflows natively each frame. **No `layout` on tiles** (it would squash tile text and charts with a scale transform) |
| Missing permission (design addition) | Hero Ready chip | Label "Mic needed" / "Access needed" (`label`), dot `→ $warn` (`dur.fast` `ease.standard`). Reverses on grant |
| Scratchpad tile | Tile | Hover: `::after` elevation opacity (e1 → e2), `dur.fast`. Press: `scale 0.98` (`spring.snap`) |

### 4.4 Mic picker (title bar chip + popover, `M6uvcU`)

| Interaction | Spec |
|---|---|
| Chip hover / press | bg `dur.hoverIn` / `dur.hoverOut`; `scale 0.97` with `spring.snap` |
| Chip level dot | Driven by the level through `spring.meter` on `scale 1 → 1.6` and `opacity 0.6 → 1`. Code hook: idle level needs a helper monitor mode (§6.5 #7). Without data, the dot is static |
| **Open** | Popover 340 × 324, origin top-right under the chip: `opacity 0 → 1` `dur.fast` `ease.out`, `scale 0.96 → 1` and `y −4 → 0` with `spring.ui`, `blur(2px) → blur(0px)` `dur.fast`. **Rows enter with the container (no stagger).** The live 7-bar level in the head uses the rAF engine. Total 250 ✓ |
| **Close** (outside click, Esc, selection) | `opacity → 0`, `scale → 0.98`, `dur.micro` `ease.exit`, inert; focus returns to the chip at t = 0. After a selection, close at t = 120 so the radio move is seen |
| **Re-toggle mid-open/close** | Retarget from the current opacity/scale (§6.3). No restart |
| **Select device** | Radio dot: shared `layoutId="mic-radio"` (text-free) flies to the new row with `spring.snappy`. Row bg `dur.fast`. Chip label swaps the device name (`label`) and the chip's real `width` animates with `spring.ui` |
| **Hot-plug: added** | Coalesce over `hold.devicesSettle`. New row: real height 0 → measured (`spring.ui`), content `opacity` + `blur(4px) → blur(0px)` `dur.base` |
| **Hot-plug: removed** (not selected) | Row `opacity → 0` `dur.micro` `ease.exit`, height → 0 with `spring.exit`, siblings reflow natively |
| **Hot-plug: selected device removed** | The radio flies to the fallback row (`spring.snappy`) **while** the removed row collapses. A "⟨Device⟩ disconnected, using ⟨Fallback⟩" inline notice enters at the popover top: real height (`spring.ui`) plus text `block`. The chip label swaps. If the popover is closed, only the chip label swaps, with one `ring.dot` on the level dot |
| **Pinned device returns** | Row inserts, the radio flies back, and the notice collapses (`opacity` `dur.micro` ∥ height `spring.exit`) |
| Footer "Dictation settings →" | The route switch (§4.2) starts at t = 0; the popover exits in parallel (`dur.micro`); focus moves to the route |
| Interruption | Hot-plug while the popover is mid-open: the list just reflows. Selections are immediate |

### 4.5 Permission banners (`TyR7q`, `f9cd0`, `iUNKf`)

Banner colours: bg `$tangerine-soft`, hairline `$tangerine`, icon chip `$tangerine`, message `$fg`.

| Transition | Spec |
|---|---|
| **Hidden → shown** | The banner wrapper's real `height` 0 → measured with `spring.ui` (→ 250); the bento reflows natively each frame. Content at t = 60: `block` + `y −6 → 0` (`dist.nudge`) → 220. **Not on app launch:** a banner present at first render renders at rest |
| **Variant change** (mic-missing ⇄ ax-off) | Height retargets with `spring.ui`. Icon tile colour `dur.base` `ease.standard`. Message `block` swap. Buttons (Fix / Not now): `label` swap, real widths `spring.ui` |
| **Granted → leaves** | t = 0: icon → check (`opacity`, `scale 0.6 → 1` with `spring.snappy`, stroke `dur.base`); colours `$tangerine-soft → $success-soft`, `$tangerine → $success` (hairline and icon chip) over `dur.base` `ease.standard`; one `ring` on the icon chip (→ 420). Hold `hold.bannerSuccess` from t = 200. Then (t = 600): content `opacity → 0` `dur.fast` `ease.exit` ∥ height → 0 with `spring.exit`; the bento reflows. Each segment ≤ 420 ms; the hold doesn't count |
| **Dismiss / Not now** | Immediate leave (no success beat): content `opacity → 0` `dur.fast` ∥ height `spring.exit` |
| **Fix** | Press feedback, then the route switch to onboarding/Permissions (§4.6) |
| Hidden-window rule | Grant detected while the hub is hidden: defer the success beat until visible (§3.6) |

### 4.6 Onboarding & permissions (`qKuS4`, `Yrwr7`, `MGecJ`, `eMSI1`)

Layout: Setup hero tile (left) + Steps (right) + footer. Step card `E29iO` (expanded) ⇄ row `FalvR` (collapsed, 68 px). The **title bar and top nav stay visible** during onboarding (design `p6fgHb`: nav with Dictation active, plus a "SETUP" tag on the right), so no nav entrance is needed anywhere.

**Step card ⇄ row** always animates the container's **real height** with overflow clip (title and chip stay crisp at the top, no `layoutId` scale). Status chips animate their real `width`.

#### 4.6.1 Entrance (first run)

| t (ms) | Element | Spec | Ends |
|---|---|---|---|
| 0 | Setup hero tile | `opacity 0 → 1` `dur.expressive` `ease.enter`, `y 16 → 0` (`dist.lg`) with `spring.morph`, content `blur(8px) → blur(0px)` `dur.expressive` `ease.enter` (**excluding the headline**) | 400 |
| 100 | Headline "Two switches, then talk." | `headline`, delayed start: 4 tokens, `(600 − 100 − 400) / 3` = **33 ms** | **600** |
| 120 | Step 1 card (expanded) | Tile spec with content `blur(6px)` | 520 |
| 150 | Step 2 row (collapsed) | Tile spec with `blur(4px)` (68 px high, not a large surface) | 550 |
| 160 | Tracker rows | `opacity` + `y 6 → 0` (`dist.nudge`), `dur.fast` `ease.out`, `stagger.list` (160 / 180 / 200) | 350 |
| 220 | Footer note + Continue | `opacity`, `dur.base` `ease.out` | 420 |
| | **Total** | | **600** ✓ |

Focus: step 1's primary action ("Allow") at t = 0. Filters: 1 + 4 words + 2 = 7.

**Re-entry** (from a banner Fix or `perms:show`): the route switch (§4.2), then the headline at t = 40 with the delayed-start rule (4 tokens, `(600 − 40 − 400) / 3` = 53 ms → 600). No tile stagger. **Esc** on re-entry routes back with the switch.
**Esc on first run: no-op.** Onboarding ends only through Continue / Done / "Continue without it".

#### 4.6.2 Per-step status

Status chip: one `m.span` whose real `width` animates with `spring.ui`, colours with `dur.base` `ease.standard`. Colours: Checking `$warn-soft` / `$warn`, Granted `$success-soft` / `$success`, Missing / Not allowed / Turned off `$error-soft` / `$error`.

| From → to | Spec |
|---|---|
| Not determined → **Waiting for macOS…** (Allow clicked, TCC prompt up) | Button press `scale 0.97`. Chip "Checking" enters (`opacity` `dur.fast`, `scale 0.9 → 1` with `spring.snappy`). Label `label`. A 6 px dot runs `loop.pulse`. The button gets `disabled` opacity 0.5 over `dur.fast` `ease.standard` |
| Waiting → **Granted** (user's own action in this session) | The granted flip, §4.6.3 |
| Waiting → **Not allowed / Turned off** | Chip width `spring.ui`, colours → Missing, label `label`. Body copy `block` swap. Action button "Allow" → "Open System Settings": `label` swap plus real width `spring.ui`. **No shake** |
| Accessibility: not asked → asked (Open System Settings) | Same label/`block` swaps |
| Return from System Settings (`focus` + poll) | The result choreography starts at **focus + 100 ms** so it's visible (§3.6) |
| **Granted, not from the user's own action** (e.g. granted in System Settings without clicking Allow here) | Chip flip only (the §4.6.3 t = 0 row, **no ring**), tracker label swap. No card swap, no auto-advance, no focus move |
| **Revoked while onboarding is open** (Granted → Turned off) | Chip width `spring.ui`, colours Granted → Missing, label `label`; check → dot (check `opacity → 0` `dur.flash`, dot `scale 0.6 → 1` `spring.snappy`). Tracker label "Allowed" → "Turned off" (`label`). The step does not auto-expand |
| **Click a collapsed row** (re-expand a previous step) | Everyday tier. The expanded card collapses to a row and the clicked row expands, both with real height and **`spring.ui`** (→ 250). Outgoing body `opacity → 0`, `blur(2px)`, `dur.flash`, inert; incoming body `block` at t = 80 → 240. Focus moves to the expanded step's primary action |

#### 4.6.3 Granted flip: step 1 → step 2 (signature)

| t (ms) | Element | Spec | Ends |
|---|---|---|---|
| 0 | Chip | Width → "Allowed" (`spring.ui`), colours Checking → Granted (`dur.base` `ease.standard`). Pulse dot → check: dot `scale → 0` `dur.flash` `ease.exit`; check strokes in (`dur.base` `ease.out`) with `scale 0.5 → 1` (**`spring.pop`**). Label `label` | 320 |
| 40 | Card icon tile | One `ring` (→ 460). Ring and check read as one beat | 460 |
| 150 | Tracker step 1 | Number "1" → check via glyph swap (BlurNumber ≤ 20 px params, the new glyph is the check icon), plus state label "Now" → "Allowed" (`label`) | 370 |
| 200 | Step 1 card → row | Container real height → 68 with `spring.morph`, overflow clip. Body and actions exit first (`opacity → 0`, `blur(2px)`, `dur.flash` `ease.exit`, inert). Title and chip stay put | 540 |
| 200 | Step 2 row → card | Real height 68 → card height with `spring.morph`. Body/actions enter at t = 320: `opacity`, `blur(4px) → blur(0px)`, `y 6 → 0` (`dist.nudge`), `dur.base` `ease.out` (→ 520). Tracker step 2 label "Next" → "Now" (`label`) | 540 |
| 200 | Focus | Focus moves to step 2's primary action (`preventScroll`), because the step 1 button is unmounting. The polite status region announces "Microphone allowed" | - |
| 240 | Footer note | `block` swap | 400 |
| | **Total** | | **540** ✓ |

Auto-advance happens only for a grant that results from the user's own action in this session. The pointer being over the card does not block it. If both permissions were already granted on mount, render the Done state at rest.

#### 4.6.4 Done ("You're set.")

Trigger: step 2 (Accessibility) granted by the user's action. **The step 2 chip flip runs inside Done's t = 0 row**, so the whole thing is one choreography.

| t (ms) | Element | Spec | Ends |
|---|---|---|---|
| 0 | Step 2 chip | The §4.6.3 t = 0 chip flip (`spring.pop` check) | 320 |
| 40 | Step 2 icon tile | `ring` | 460 |
| 0 | Hero headline | Old words exit together (150 ms `ease.exit`, `blur(8px)`, `y −0.15·fs`). "You're set." `headline` from t = 80: 2 tokens, `min(60, (600 − 80 − 400) / 1)` = 60 ms stagger → 80 + 60 + 400 | **540** |
| 0 | Tracker step 2 | → check (as §4.6.3 t = 150) + "Now" → "Allowed" (`label`) | 220 |
| 60 | Step 2 card → row | Real height with `spring.morph` (body exits first, `dur.flash`) | 400 |
| 120 | **Try it** tile | Enters: `opacity` `dur.expressive` `ease.enter`, `y 16 → 0` and `scale 0.97 → 1` (`spring.morph`), content `blur(8px) → blur(0px)` `dur.expressive` `ease.enter`. **Its headline "Hold [fn] and say hello." is part of this content and reveals as a block with it** (one per-word headline at a time; its fitted stagger would be 0 anyway) | 520 |
| 240 | Footer button | Label swap Continue → Done (`label`); focus moves to it; status region "Accessibility allowed. You're set." | 400 |
| | **Total** | | **540** ✓ |

**"Continue without it"** (step 2 skipped): the same table, except the t = 0 chip row and the t = 40 ring don't play: the step 2 chip stays "Turned off", and tracker step 2's label swaps "Now" → "Turned off" (`label`) with its tint going to `$fg-3` on `$surface-3` (`dur.base` `ease.standard`). The "You're set." headline still plays.

**Try it live:** holding fn on this screen drives the tile's mini wave (rAF engine), and the user's words stream in with `stream` inside the tile (`BlurStream`, same diff). This doubles as proof that the full pipeline works.

#### 4.6.5 Exit to home (hand-off, signature, chained from Done)

Trigger: Done click (t = 0). The bento uses a **hand-off variant** of §4.3.1 so everything lands by 600.

| t (ms) | Element | Spec | Ends |
|---|---|---|---|
| 0 | **Container transform** | The Try-it tile (`layoutId="hero-hold-fn"`, `borderRadius` in `style`) morphs into the home Hero tile with `spring.morph`; fill `→ $violet` over `dur.base` `ease.standard`. Tile content (not the headline): old hint/wave out `dur.flash` with `blur(2px)`; new chip, hint and mini wave in at t = 120 with `opacity` + `blur(4px) → blur(0px)`, `dur.base` | 340 |
| 0 | **Headline diff** (BlurStream engine) | "Hold fn and say hello." → "Hold fn to talk.". "Hold" and the fn keycap stay sharp and ride the morph (`layout="position"`). "and say hello." exits (`opacity → 0`, `blur(4px)`, `dur.micro` `ease.exit`). "to talk." enters with `headline` from t = 140, explicit stagger 40 ms, perWord 400 → 140 + 40 + 400 | **580** |
| 0 | Other onboarding tiles (Setup hero, steps, footer) | `opacity → 0`, `scale → 0.98`, `dur.fast` `ease.exit`, **no blur**, reverse `stagger.list` (cap 4), inert | 210 |
| 0 | Title bar "SETUP" tag | `opacity → 0`, `dur.flash` | 80 |
| 120 | Bento tiles (hand-off variant) | Words 120, Streak 140, WPM 160, Most used 180, Recent 200, Scratchpad 220 (`stagger.handoff`). `opacity` `dur.reveal` (300) `ease.enter`; `y 12 → 0` with **`spring.ui`**; content `blur(6px) → blur(0px)` `dur.reveal` `ease.enter` on Words, Streak and WPM only | 520 |
| 200 | Streak grid | `clip-path` sweep, `dur.reveal` `ease.out` | 500 |
| 200 | Most-used bars | `scaleX` with `spring.ui`, `stagger.tight` | 510 |
| 220 | Recent rows | `opacity` + `y 6 → 0`, `dur.fast` `ease.out`, `stagger.tight` (cap 8) | 475 |
| 0 | Focus | The Dictation main region heading (`tabIndex=-1`, `preventScroll`) | - |
| | **Total** | | **580** ✓ |

Filter budget: t = 0–100: old tile content (1) + 3 exiting words = 4. t = 120–520: Hero new content (1) + 2 words + 3 tile wrappers = 6. Onboarding tile exits carry no blur. Large surfaces ≤ 4.

### 4.7 Settings (route; panes `y10BqR` … `q8FVWN`)

| Interaction | Spec |
|---|---|
| **Entering Settings from the nav** | The route switch only (§4.2). The pane header is the route title and plays `titleUnit` once. Pane-switch rules apply only to pane changes inside Settings |
| **Pane switch** | Pane list active pill: `layoutId="pane-active"` (text-free) with `spring.fluid`. Shared axis Y: outgoing content `opacity → 0`, `dur.flash` `ease.exit`, inert (`popLayout`). Incoming at t = 30: `opacity` `dur.fast` `ease.out` and `y ±8 → 0` (`dist.md`, `spring.snap`; + when the new pane is below the old in the list, − when above) → 180. Header `titleUnit` at t = 40 → **240** ✓. **No tile stagger** (panes are browsed rapidly) |
| Pane switch spam | Each click retargets the pill; the in-flight incoming pane becomes outgoing from its current opacity (inert at once). No queue |
| Pane item hover / press | bg `dur.hoverIn` / `dur.hoverOut` / `scale 0.98` with `spring.snap` |
| **Toggle** (`HQZBU`/`qKcSg`) | Knob x with `spring.snappy`. **Squash:** on pointerdown the knob width 20 → 24 px (`spring.snap`), stretching toward the travel direction, released on pointerup. Track colour `dur.fast` `ease.standard`. Keyboard (Space) toggles with the same knob spring (no squash) |
| **Select / dropdown** | Opens **in place**: the list is positioned so the selected row's box sits exactly over the trigger (selected row y = trigger y), clamped inside the window with an 8 px margin. Enter: `opacity` `dur.fast` `ease.out`, `scale 0.96 → 1` with `spring.ui`, `transform-origin` at the selected row's centre, **no y offset**, no row stagger. Exit `opacity → 0`, `scale → 0.98`, `dur.micro` `ease.exit` |
| **KeyRecorder** idle → listening | Field border colour `dur.fast`. Placeholder → "Press keys…" (`label`). Red rec dot `scale 0.6 → 1` (`spring.snappy`), then `loop.pulse`. Cancel button `opacity` `dur.fast` |
| ″ captured | Each keycap: `opacity`, `scale 0.8 → 1` (`spring.snappy`), `blur(4px) → blur(0px)` `dur.fast`, `stagger.list` (3 keys → 240). Rec dot out `dur.micro`. Focus stays on the field |
| ″ Esc, click outside, or field blur while listening | **Cancel**: reverse in `dur.micro` `ease.exit`, back to the previous keycaps (render at rest). After Esc, focus stays on the field; after a click outside, focus goes where the user clicked |
| ″ bind failed (`shortcuts:failed`) | Warning row (`$warn-soft`, message `$fg`): real height 0 → measured (`spring.ui`), text `block`, field border `→ $warn` over `dur.base` `ease.standard`. **No shake** |
| **Mic tile** (Dictation pane) | Same device rows, radio `layoutId`, hot-plug and disconnected notice as §4.4. The input level bars use the rAF engine (leaf component) |
| **Languages** card select / deselect | Border/fill `dur.fast` `ease.standard`. Check badge `scale 0.6 → 1` (`spring.snappy`) with `opacity` `dur.micro`. Deselect: badge `scale → 0.6`, `opacity → 0`, `dur.micro` `ease.exit` |
| ″ search filter | Non-matching cards exit: `opacity → 0`, `scale → 0.98`, `dur.micro` (`popLayout`). Remaining cards move with `layout="position"` (`layoutDependency` = query), `spring.ui`. Matches entering: `opacity` `dur.fast`. **If more than 24 cards change in one keystroke, apply instantly** with one grid `opacity` dip 0.6 → 1 over `dur.fast` |
| ″ auto-detect toggle | Grid `opacity → 0.4`, `inert`, `dur.base` `ease.standard` (and back) |
| **Speech models**: engine select | Description `block` swap |
| ″ Download → downloading | The row's **action slot** (one element) animates its real `width`/`height`/`borderRadius` from the Download button to the progress bar with `spring.ui`; the label exits `dur.flash`. Progress fill width `spring.ui` per update, coalesced at `hold.coalesce`. Percent `BlurNumber` subtle. Cancel `opacity` `dur.fast` at t = 100 |
| ″ Cancel during download (`models:cancelled`) | Reverse: the action slot returns to the Download button size with `spring.ui`; the percent exits (subtle exit); "Download" enters with `label` at t = 80; Cancel out `dur.micro` |
| ″ downloading → installed | Fill to 100 % (`spring.ui`), then the action slot resizes to the "Use" button (`spring.ui`), label in at t = 80, with a check pop (`spring.snappy`) on the row |
| ″ Remove installed | "Use / Remove" → "Download": `label` swap + real width `spring.ui`. The "Installed" chip exits (`opacity → 0`, `scale → 0.9`, `dur.micro` `ease.exit`); the size meta swaps with `label` |
| ″ → in use | The "In use" pill moves between rows: `layoutId="model-in-use"` with `spring.fluid` (same size in every row, so projection is translate-only and the text never scales) |
| ″ error | Fill tint `→ $error` `dur.fast`. "Download failed" `block`. Retry button `label` swap. No shake |
| ″ list reorder (`models:list`) | `layout="position"`, `layoutDependency` = list ids, `spring.ui` |
| **AI cleanup** key save | Button label → spinner (`label` swap, spinner `opacity`), then → masked key (`label`). Test connection: busy spinner → ✓ / ✗ (stroke `dur.base` `ease.out` + `scale 0.6 → 1` `spring.snappy`) + result text `block`. Result row real height `spring.ui` |
| ″ `cleanup:error` | Inline Warning "Last cleanup failed · ⟨reason⟩" at the top of the AI cleanup pane (warning row spec above). Present when the pane opens → renders at rest. The live moment is the Flow Bar notice (§4.1.10) |
| **Calendar** status | Chip as §4.6.2 (not determined → busy → granted/denied). Note `block` |
| **About** update check | "Check for updates" → "Checking…" (`label`, spinner) → "Up to date" (`label` + check pop) or "Version x available" (row real height `spring.ui` + primary button `opacity`/`scale 0.96 → 1` `spring.ui`) |

### 4.8 Snippets & Transforms (+ dialogs `VnBia`, `ddCUn`)

| Interaction | Spec |
|---|---|
| **Dialog open** (from a button) | Scrim `opacity 0 → 1` `dur.base` `ease.out`. Dialog content layer: `opacity` `dur.fast` `ease.out`, `scale 0.96 → 1` and `y 8 → 0` (`dist.md`) with `spring.ui`, `blur(6px) → blur(0px)` `dur.base` `ease.out`. **`transform-origin` = the trigger's centre** relative to the dialog. Title `titleUnit` at t = 40 → 240. Focus moves to the first field at t = 0. Total 250 ✓ |
| **Dialog open from a card** (Edit transform, "Create your own") | **Container transform:** the card (`layoutId="transform-⟨id⟩"`, `borderRadius`/`boxShadow` in `style`) morphs into the dialog with `spring.morph` (→ 340). Card content out `dur.flash` with `blur(2px)`; dialog content (title included, as a unit) in at t = 120 with `opacity` + `blur(4px) → blur(0px)`, `dur.base` (→ 320). Scrim as above. Total 340 ✓ |
| **Dialog close** (Cancel, Esc, scrim, Save) | Dialog `opacity → 0`, `scale → 0.98`, `blur(2px)`, `dur.micro` `ease.exit`, inert. Scrim `opacity → 0` `dur.fast`. Focus returns to the trigger at t = 0. Save: close, then the list update at t = 80 |
| **Close back into its card** | Dialog content out `dur.flash` with `blur(2px)` (→ 80); the container morphs back into the card with `spring.exit` (→ 200); card content in at t = 60 with `opacity` + `blur(2px) → blur(0px)`, `dur.fast` `ease.out` (→ 210); scrim `dur.fast`. Total 210 |
| Esc before the open finishes | §6.3: the dialog retargets to closed from its current values |
| Save disabled ↔ enabled | bg/opacity `dur.fast` `ease.standard` |
| Conditional fields (Template textarea / Case select, by rule) | Appear: real height 0 → measured (`spring.ui`), `opacity` `dur.fast` at t = 50. Disappear: `opacity → 0` `dur.micro`, height with `spring.exit`. The dialog's height follows natively |
| Slot select (⌥n) | Select rules (§4.7). The keycap in the dialog title swaps glyph with `label` |
| **Preview block** (`transforms:preview`) | **Pending:** the block's real height grows to one line (`spring.ui`); a 14 px spinner (`loop.spin`) + "Running…" (`label`) appear only if still pending after `hold.pendingDelay`. **Result:** spinner out `dur.flash`; height → measured (`spring.ui`); text reveals with the **`stream`** variant using the catch-up rule: `STAGGER.fit(n, 0.22, 0)` capped at 35 ms, first 40 words, block if < 12 ms. The spans are the only text (user content, §3.1). A re-run diffs like `BlurStream` |
| **Row/card insert** (after Save) | Real height 0 → measured (`spring.ui`), content `opacity` + `blur(4px) → blur(0px)` `dur.base` `ease.out` |
| **Row/card update** | Changed text swaps with `label` (short) or `block`. Highlight `$violet-soft` appears instantly, holds `hold.highlight`, fades over `dur.moderate` `ease.out` |
| **Delete** | Row/card `opacity → 0`, `x → −8` (rows) or `scale → 0.96` (cards), `blur(2px)`, `dur.micro` `ease.exit`, inert. Real height `spring.exit`. The grid reflows with `layout="position"` `spring.ui` |
| Search filter | As the languages filter (§4.7), cap 30 → instant |
| Row hover delete reveal | `opacity` `dur.micro` in / `dur.flash` out; instant on `:focus-within` |
| **Transform card hover** | Lift `y −2` (`dist.xs`, `spring.snappy`) and the `::after` elevation opacity e1 → e2 over `dur.fast`. Press: `scale 0.98` (`spring.snap`) |
| Empty state | Heading `title` at t = 0; body `block` at t = 120 |
| Promo CTA dot | `ring.promo` × `loop.promo` (3 cycles, then static) |

### 4.9 Scratchpad (window `scratchpad`, `vytSm`)

Productive/fluid tier: Scratchpad is summoned many times a day with ⌥S.

| Interaction | Spec |
|---|---|
| **Window open** | Code hooks: `show:false` + `ready-to-show` gating (main), `backgroundThrottling:false`. Starts on visible / `win:shown` (§3.6). Card inside the transparent window: `opacity 0 → 1` `dur.fast` `ease.out`, `y 8 → 0` (`dist.md`) and `scale 0.97 → 1` with `spring.fluid`, `blur(4px) → blur(0px)` `dur.base` `ease.out`. Total **250** ✓ |
| Already open (⌥S again) | `show()` + `focus()`. No animation |
| **Window close** (close button, ⌘W, last tab, native close) | Every path goes through the renderer. Main intercepts `close` (`preventDefault`), sends `pad:will-close {seq}`; the renderer plays `opacity → 0` `dur.fast` `ease.exit`, `scale → 0.98`, `blur(4px)`, then sends `pad:closed {seq}`; main destroys the window. **Main** closes anyway after `hold.closeTimeout` (a hung renderer can't block it). Stale `seq` values are ignored. **App quit closes instantly** (main sets a quitting flag; no handshake). Reduce Motion: close immediately |
| Close requested while the open animation runs | §6.3: the exit retargets from the current values |
| Maximize (`pad:expand`) | Native zoom. No app motion |
| **Tabs**: new | Tab real width 0 → measured (`spring.ui`), `opacity` `dur.fast`. Active indicator: `layoutId="pad-tab"` (text-free) with `spring.fluid` |
| ″ switch | Indicator slides. Editor content cross-fades: out `dur.flash`, in `dur.fast` `ease.out`, **no blur, no y** (it's a text editor, so keep the caret area stable) |
| ″ close | Tab `opacity → 0` `dur.micro`, width → 0 with `spring.exit`, siblings reflow natively. Closing the last tab triggers the window close |
| Notes sidebar collapse/expand | Width with `spring.ui`, list content `opacity` `dur.micro` (out) / `dur.fast` at t = 60 (in) |
| Notes search | Filter rows (`popLayout`, `layout="position"`, `spring.ui`), cap 30 → instant |
| Note row active | Highlight `layoutId="pad-note-active"` with `spring.snappy` (pointer); instant on keyboard |
| Delete note | Row exit as §4.8 delete |
| **Voice note arrives, window closed** (chained after the Flow Bar done; trigger `notes:changed` with the new note) | t = 0 window open (above, → 250); the note's tab and row insert with the window. Body reveal from t = 120: `body`, `STAGGER.fit(min(n, 40), 0.24, 0.12)` → last word ≤ **600**; beyond 40 words the remainder block-fades with the 40th; block if the fit is < 12 ms |
| **Voice note arrives, window already open** | No window motion. A new tab inserts (tab spec) and the note row inserts (§4.8 insert) at t = 0. Body from t = 0: `STAGGER.fit(min(n, 40), 0.24, 0)` → ≤ 600 |
| Voice note reveal mechanics | The editor is `contentEditable` and autosaved, so **the editor DOM is never touched**. The reveal runs on a separate `aria-hidden` overlay absolutely positioned over the editor content with the same font metrics, padding and width, while the editor text is `color: transparent` and `caret-color: transparent`. On settle, or on the first `keydown`/`pointerdown` in the editor, the overlay is removed and the colour restored **in the same frame**. The caret goes to the end after the reveal |
| Dictation into the editor (helper typing) | No animation. It's real input |
| Autosave indicator | "Saving…" ⇄ "Saved" (`label`). Word count `BlurNumber` subtle. "Edited 2 min ago" swaps with `label` |
| Toolbar button | Press `scale 0.92` (`scale.pressIcon`, `spring.snap`). Active format bg: selection colour `dur.fast` `ease.standard` (a state, not a hover) |
| **Copy all** | Icon copy → check (`label`-style blur swap + `scale 0.6 → 1` `spring.snappy`). Hold `hold.copied`, then back |
| Format popover (code `.fmt`) | Popover rules (§4.11) |
| Empty placeholder "Hold fn to dictate here" | Static. On dictation start the placeholder fades out over `dur.micro` |

### 4.10 Toasts (`pBsOO`)

Colours: bg `$fg` (`toast-bg`), text `$fg-inverse`.

| | Spec |
|---|---|
| Enter | Bottom-centre of the hub, content layer: `y 16 → 0` (`dist.lg`) and `scale 0.96 → 1` with `spring.fluid`, `opacity 0 → 1` `dur.fast` `ease.out`, `blur(6px) → blur(0px)` `dur.base`. Text block-fades with the toast (no per-word: frequency). Total 250 |
| Hold | `hold.notice`. Paused on hover, focus-within, while the window is blurred, and while `visibilityState` is hidden |
| Exit | `y 8`, `opacity → 0`, `blur(4px)`, `dur.fast` `ease.exit`, inert |
| Replace | The old toast exits **upward** (`y −8`, `opacity → 0`, `dur.micro` `ease.exit`) while the new one enters at **t = 40** with `spring.snap` for y/scale and `dur.fast` for opacity and blur (→ 190), so the exit reads first. No stacking: one toast at a time |
| Action button | Press `scale 0.97` |

### 4.11 Dialogs, menus and tooltips (shared hub rules)

- **Dialog:** see §4.8 (shared by every hub dialog).
- **Menu / popover / select:** origin-aware. `opacity` `dur.fast` `ease.out`, `scale 0.96 → 1` with `spring.ui`, `y ∓4` toward the trigger → 250. Exit `opacity → 0`, `scale → 0.98`, `dur.micro` `ease.exit`, inert, focus back to the trigger at t = 0. **Rows never stagger.** Highlight moves are instant (pointer and keyboard). A context-style menu opened from the keyboard appears **instantly**. Re-toggling mid-open or mid-close retargets from the current values. Selects open in place (§4.7).
- **Tooltip (hub):** delay `hold.tooltipDelay`, then `opacity` + `scale 0.97 → 1`, `dur.tooltip` `ease.out`. Exit `dur.flash`. During `hold.tooltipGrace`, neighbours appear instantly.

### 4.12 Todos edge panel (window `todos`)

| Interaction | Spec |
|---|---|
| **Dwell** | `hold.dwell` = **350 ms** (decided, §8). Code `DWELL_MS` 200 opens on fly-bys; the storyboard's 1 s felt broken. No dwell-progress affordance and no timer chip |
| **Open** | Code hooks: `backgroundThrottling:false`, `showInactive()` on `ready-to-show` as today; starts on visible / `win:shown` (§3.6). Panel content layer: `x −24 → 0` (`dist.xl`) with `spring.fluid`, `opacity 0 → 1` `dur.fast` `ease.out`, `blur(8px) → blur(0px)` `dur.base` `ease.out`. Items: `opacity` + `y 4 → 0` (`dist.sm`), `dur.micro` `ease.out`, `stagger.tight` from t = 30, cap 6 → last ends 30 + 75 + 100 = 205. Total 250 ✓ |
| **Close** (pointer left for 300 ms, or ×) | **IPC handshake with `closeSeq`:** main sends `todos:will-close {seq}`. The renderer plays `x −16` (`dist.lg`), `opacity → 0`, `blur(4px)`, `dur.fast` `ease.exit`, then sends `todos:closed {seq}`. Main calls `close()` only if `seq` is current, and falls back to closing after `hold.closeTimeout`. **Re-entry during the exit:** main sends `todos:cancel-close {seq}` and bumps `seq`; the panel retargets to open (springs keep velocity). A stale `todos:closed` is ignored |
| Pin | Icon `rotate 45° → 0` with `spring.snappy` and fill `dur.fast`. Unpin reverses |
| Count badge, project group counts | `BlurNumber` |
| **Composer** open ("Add a todo" → form, `rXrLL`) | Container real height `spring.ui`. Button label out `dur.flash`. Fields `opacity` `dur.fast` at t = 40. **The title input is focused at t = 0** |
| ″ submit | The new item inserts at its position (real height `spring.ui` + content `opacity` + `blur(4px)` `dur.base`). The composer stays open, the title clears instantly, and **focus stays in the title input** |
| ″ submit with a new `@Project:` | The new group header and its item insert as one: the group's real height 0 → measured (`spring.ui`); header content `opacity` + `blur(3px) → blur(0px)` `dur.fast` at t = 50 (→ 200); item content `dur.base` at t = 50 (→ 250) |
| ″ Esc / Cancel | Fields `opacity → 0` `dur.flash`, height with `spring.exit` |
| **Project autocomplete** (`sAMWu`, title starts with `@`) | Appears below the input, origin top-left: `opacity` `dur.fast` `ease.out`, `scale 0.98 → 1` and `y −4 → 0` (`spring.ui`). **Rows enter with it (no stagger).** Rows filter with `popLayout` + `layout="position"` `spring.ui` (cap 8 → instant). **Highlight moves instantly** (keyboard and hover). Accept: the `@Project` token pops (`scale 0.9 → 1` `spring.snappy`), and the list exits `dur.micro`. **Dismiss without accepting** (Esc, deleting `@`, input blur): `opacity → 0`, `scale → 0.98`, `dur.micro` `ease.exit` |
| **Date picker** (`wtWtv`, `QjrFy`) open | Origin = the chip (bottom when flipped above): `opacity` `dur.fast`, `scale 0.96 → 1` (`spring.ui`), `y ∓4`. Exit `dur.micro` `ease.exit` |
| ″ month nav ‹ › | Shared axis X with direction from `custom`. Outgoing grid `x ∓16` (`dist.lg`), `opacity → 0`, `dur.micro` `ease.exit`. Incoming `x ±16 → 0` (`spring.ui`), `opacity` `dur.fast` `ease.out`, `blur(2px) → blur(0px)` `dur.fast` (`popLayout`). Month label `label`. **More than 2 clicks within `hold.spamWindow` → instant swaps** until the clicking stops |
| ″ day select | Selection circle `layoutId="dp-selected"` (text-free) with `spring.snappy` (same month). Otherwise `scale 0.6 → 1` (`spring.snappy`) |
| ″ quick pick / time pick | Selection shown, then the picker closes at t = 120 |
| ″ chip in row updates | `label` swap. Overdue tint `$surface-3 → $error-soft` (`overdue-bg`) over `dur.base` `ease.standard` |
| Synced dot (calendar sync) | Appear `scale 0.6 → 1` (`spring.snappy`) + `opacity` `dur.micro`. Disappear `opacity → 0`, `scale → 0.6`, `dur.micro` `ease.exit` |
| **Check** | Checkbox fill `scale 0.6 → 1` (`spring.snappy`) + check stroke `dur.fast` `ease.out`. Strike line draws left → right (`scaleX 0 → 1`, origin left, `dur.base` `ease.out`), and the text `opacity → 0.5` over `dur.base`. The description hides: real height → 0 (`spring.ui`) + `opacity → 0` `dur.micro`. **Hold `hold.todoCheck`** in place (undo window). Then the row leaves the active list (real height `spring.ui`, `opacity` `dur.micro`) and inserts at the top of Completed if open (real height `spring.ui`). Counts use `BlurNumber` |
| **Uncheck** | Strike retracts (`scaleX → 0`, origin right, `dur.fast` `ease.exit`), text opacity → 1 (`dur.fast`), the description reappears (real height `spring.ui` + `opacity` `dur.fast` at t = 50), and the row moves back. Rapid toggles reset the hold, and the springs retarget |
| Delete | `opacity → 0`, `x → −8`, `blur(2px)`, `dur.micro` `ease.exit`, inert; collapse `spring.exit` |
| **Drag reorder** | Hysteresis 4 px before the drag starts. Pickup: `scale 1.02` (`scale.lift`, `spring.snappy`), elevation `::after` opacity e1 → e3 over `dur.fast`, z → drag. The item follows the pointer **1:1** (no smoothing). Siblings make room with `layout="position"` `spring.ui`. Drop indicator line `scaleX 0 → 1` over `dur.micro`. Release: settles into the slot with `spring.gesture`, **carrying the release velocity**. Elevation fades back over `dur.base`. Replaces today's 0.35-opacity ghost |
| ″ drag cancel (Esc or drop outside) | Returns to its origin slot with `spring.gesture` carrying the current velocity; siblings return with `spring.ui`; elevation back over `dur.base` |
| ″ keyboard reorder (⌥↑ / ⌥↓) | The row moves one slot with `spring.ui` (no drag physics, no lift) |
| **Project group collapse / expand** (`H9heB`) | Chevron rotate with `spring.snappy`. Collapse: rows `opacity → 0` `dur.micro` together, container real height `spring.ui`. Expand: height `spring.ui`, rows `opacity` `dur.fast`, `stagger.tight` cap 6 (→ 225) |
| **Completed** toggle | As the group |
| ″ Clear | Done rows exit (`opacity → 0`, `blur(2px)`, `x −8`, `dur.micro`, `stagger.list` from the bottom, cap 8 → 240) while the section's real height collapses with `spring.exit` from t = 40 (→ 240). Count → 0 with `BlurNumber` |
| **Empty "All clear."** (`R8pow`) | Only on the transition to empty (not on open): the checklist icon strokes in over `dur.reveal` `ease.out`, and "All clear." plays `title` at t = 100 (2 tokens → 450) |
| `todos:changed` from elsewhere | Same diff-driven insert/remove/move. **More than 8 changes at once** (calendar backfill) → apply instantly with a single list `opacity` dip 0.6 → 1 over `dur.fast` |
| "+ date" on hover | `opacity` `dur.hoverIn` / `dur.hoverOut` |

### 4.13 Global micro-interactions

| Interaction | Spec |
|---|---|
| Hover (buttons, rows, chips, nav, pane items) | bg/colour/border **`dur.hoverIn` (60 ms) in, `dur.hoverOut` (160 ms) out**, `ease.out`: crisp arrival, soft release. CSS transitions with explicit properties. **No hover scale** except Flow Bar buttons (1.06) and transform cards (lift −2 px) |
| Named exceptions | Menu, select and autocomplete highlight: **instant** (mirrors macOS menus). Row-action reveal: `dur.micro` in / `dur.flash` out (it moves, so it needs a beat). Selected/active state colour (format buttons, cards, rows): `dur.fast` `ease.standard` (a state change, not a hover) |
| Press | `scale.press` 0.97 (buttons), `scale.pressIcon` 0.92 (32 px icon buttons), `scale.pressCard` 0.98 (cards). `spring.snap` on **pointerdown**, release with `spring.snappy`. Rows never scale |
| Focus-visible | Ring appears **instantly** (no transition). Never animate focus |
| Disabled ↔ enabled | `opacity` `dur.fast` `ease.standard` |
| Selection (radio, segmented control, chips) | Indicator `layoutId` (text-free) + `spring.snappy`. Colour `dur.fast` |
| Spinners | `loop.spin`. They exist only while work is in flight |
| Text selection, caret, scrolling | Native. No smooth-scroll overrides |
| Infinite loops | Only `loop.pulse` (rec dot / listening / waiting dots), `loop.spin` and `loop.indeterminate`. Everything else is finite |

---

## 5. Reduced motion (macOS "Reduce motion" → no animation at all)

Every state change becomes **instant**. There are no fades, blur, scale, pulses, staggers, layout animations or shared-element flights. Information is preserved: every state still renders, it just doesn't move.

**Detection (live, no relaunch):**
1. **Renderer (live, authoritative):** `matchMedia('(prefers-reduced-motion: reduce)')` with a `change` listener, wrapped in `useReduceMotion()` in `shared/motion/MotionRoot.tsx`. Chromium maps macOS Reduce Motion (System Settings › Accessibility › Display, or › Motion on macOS 26) to this query and updates it live.
2. **Main (initial value before first paint):** `systemPreferences.getAnimationSettings()`. Treat `prefersReducedMotion === true` **or** `shouldRenderRichAnimation === false` as reduce. It is read at **every window creation** (including a hub destroyed and recreated in the same launch) and passed through `webPreferences.additionalArguments` (`--reduce-motion=1`), so the preload sets `html[data-reduce-motion]` before any CSS animation can start.
3. **Main (live backstop, optional):** `getAnimationSettings()` has no change event, and `nativeTheme` `updated` does **not** fire for Reduce Motion. If a live main-side value is needed (remote sessions, windows created later), subscribe to `systemPreferences.subscribeWorkspaceNotification('NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification', …)`, re-read `getAnimationSettings()`, and broadcast `motion:reduced` to every window. The renderer `matchMedia` listener stays primary.

**Enforcement (all required):**
1. **`MotionGlobalConfig.skipAnimations = reduced`** (set per renderer on every change). This is the primary mechanism. A unit/QA check must prove it also covers imperative `animate()` / `useAnimate` sequences (granted flip, done, stream re-blur, Scratchpad/Todos exits) and `layout`/`layoutId` projection. Verify the API name against the installed `motion` version.
2. **Token helper:** every transition passes through `T(token)`, which returns `{ duration: 0 }` when reduced. Direct WAAPI calls (word engine, `filterBudget`) go through `animateWord()`, which short-circuits to the end state. Nothing depends on a single global.
3. `<MotionConfig reducedMotion="always">` when reduced, as belt and braces. `reducedMotion="user"` alone is **not** enough, because it still animates opacity and colour. Note that `MotionConfig transition` does not override per-component `transition` props, which is why layers 1 and 2 exist.
4. **CSS backstop** in `motion.css`:
   ```css
   @media (prefers-reduced-motion: reduce) {
     *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
   }
   html[data-reduce-motion] *, html[data-reduce-motion] *::before, html[data-reduce-motion] *::after { animation: none !important; transition: none !important; }
   ```
5. **Components:**
   - `BlurWords` / `BlurStream` render **plain text** with no spans. The stream still diffs (for the confirmed/unconfirmed colour), with no transition.
   - `BlurNumber` renders the formatted string.
   - The rAF engine is not used for decoration.

**Specific substitutions:**

| Normally | Reduce Motion |
|---|---|
| Waveform (scrolling 15 bars) | **Static level meter, 5 segments**, updated discretely at ≤ `LEVEL.reducedHz` (4 Hz), no interpolation, no scrolling history. It carries information ("the mic hears you"), so it stays. Decided (§8); drawn as a frame on the Motion board |
| Rec dot / listening pulse | Static solid dot |
| Spinner | Static "busy" glyph (three dots, no motion) |
| Indeterminate progress | Static track + the stage label ("Transcribing…") |
| Exit handshakes (Todos `todos:closed`, Scratchpad close) | Sent immediately |
| Drag reorder | The item still follows the pointer **1:1** (direct manipulation is not animation); siblings jump to their new slots instantly; drop and cancel are instant |
| Voice note reveal | No overlay; the text is simply there |
| Success check hold, notice/error holds, hover-intent delays, dwell | **Unchanged.** They are timing, not motion |
| Rings, promo pulse, highlight fades | Removed |

**QA:** toggle Reduce Motion while the hub, bar, Todos and Scratchpad are open. Every window must switch live. Close and reopen the hub: it must start reduced. Run a dictation and confirm that no element has a non-`none` `filter` or a running `getAnimations()` entry at any point.

---

## 6. Implementation notes (Motion in React 19 / Electron)

### 6.1 Dependencies & setup
- `bun add motion` (pin the exact version). Import from `"motion/react"`. No Motion+ (`AnimateNumber`/`splitText` are paid): we ship our own `BlurNumber`/`BlurWords`.
- **Every renderer root** (`hub`, `flowbar`, `scratchpad`, `todos` `main.tsx`) wraps in `<MotionRoot>`:
  ```tsx
  <LazyMotion features={domMax} strict>
    <MotionConfig transition={T(SPRING.ui)} reducedMotion={reduced ? "always" : "never"}>
      {children}
    </MotionConfig>
  </LazyMotion>
  ```
  `domMax` is required because we use `layout`, `layoutId` and drag. Components use `m.div`, not `motion.div` (`strict` enforces this). The default transition is our token, never Motion's defaults (its default x/y spring is ζ ≈ 0.56, which is too bouncy).
- Electron is **33.4.x** today. Electron < 36.9.2 / 37.6.0 / 38.2.0 has a macOS 26 WindowServer GPU load bug for vibrancy windows (`_cornerMask`), and the hub uses `vibrancy: 'sidebar'`. The upgrade is a cross-team dependency (§6.5 #8). Until it lands, verify on 33 that `filter`/`opacity`/`clip-path` WAAPI animations composite and that the Flow Bar rAF runs at 120 Hz in a transparent `focusable:false` window. Smoothness sign-off is only valid on ≥ 38.2 (§7).

### 6.2 Module layout (new files only)
```
src/renderer/src/shared/motion/
  tokens.ts        DUR, EASE, SPRING, STAGGER, DIST, SCALE, BLUR, RING, HOLD, LOOP, LEVEL, ENTRANCE, WORD_VARIANTS, T()
  motion.css       CSS custom properties mirror + reduced-motion backstop
  MotionRoot.tsx   LazyMotion + MotionConfig + useReduceMotion + skipAnimations sync
  BlurWords.tsx    headline | title | titleUnit | label | block | body | body.compact
  BlurStream.tsx   streaming diff + cadence-adaptive pacing + confirmation + filter budget
  wordDiff.ts      LCP fast path + bounded Myers (maxD 24) over normalized tokens (pure, unit-tested)
  BlurNumber.tsx   digit slots, trend, size variants, subtle variant, coalescing
  filterBudget.ts  per-window batch allocator for live filters (12) and large surfaces (4)
  useLevel.ts      single rAF loop: level smoothing/interpolation + direct style writes
  useRealHeight.ts measured 0 ↔ px ↔ auto height animation (banners, rows, step cards)
```

`tokens.ts` excerpt (values are normative; `motion-tokens.json` carries the same values):

```ts
export const DUR = { instant: 0, hoverIn: .06, flash: .08, micro: .1, tooltip: .125, fast: .15,
  hoverOut: .16, base: .2, moderate: .25, reveal: .3, expressive: .4, signature: .6 } as const;
export const EASE = {
  out: [0.23, 1, 0.32, 1], enter: [0.05, 0.7, 0.1, 1], exit: [0.3, 0, 0.8, 0.15],
  standard: [0.2, 0, 0, 1], drawer: [0.32, 0.72, 0, 1], inOut: [0.45, 0, 0.55, 1],
} as const;
const s = (visualDuration: number, bounce: number) => ({ type: "spring", visualDuration, bounce }) as const;
export const SPRING = {
  snap: s(.15, 0), snappy: s(.2, .1), ui: s(.25, 0), fluid: s(.25, .2), exit: s(.2, 0), meter: s(.28, 0),
  text: s(.3, .3), gesture: s(.3, .2), pop: s(.32, .4), morph: s(.34, .25), expressive: s(.4, .25),
} as const;
export const STAGGER = { tight: .015, list: .02, handoff: .02, tiles: .04, title: .03, bodyCompact: .012,
  digits: .02, ring: .006, flush: .02,
  stream: (n: number, emaMs: number) => Math.min(.09, Math.max(.035, (0.55 * emaMs / 1000) / Math.max(1, n))),
  fit: (n: number, perWord: number, start = 0, total = .6, max = .06) => {
    if (n <= 1) return 0;
    const v = Math.min(max, Math.max(0, (total - start - perWord) / (n - 1)));
    return v < .012 ? 0 : v; // 0 = reveal as one unit
  },
} as const;
export const STREAM = { emaAlpha: .3, emaSeedMs: 1500, maxD: 24, splitCap: 40 } as const;
export const DIST = { xs: 2, sm: 4, nudge: 6, md: 8, tile: 12, lg: 16, xl: 24 } as const;
export const SCALE = { press: .97, pressIcon: .92, pressCard: .98, enter: .96, exit: .98, chip: .9,
  reveal: .85, exitIcon: .8, pop: .6, popSignature: .5, lift: 1.02, hoverBar: 1.06 } as const;
export const BLUR = { xs: 2, label: 3, sm: 4, md: 6, lg: 8, max: 10 } as const;
export const BLUR_CAP = { live: 12, large: 4 } as const;
export const RING = {
  default: { scale: [1, 1.3], opacity: [.5, 0], duration: .42, ease: EASE.out },
  dot:     { scale: [1, 1.6], opacity: [.6, 0], duration: .42, ease: EASE.out },
  promo:   { scale: [1, 1.4], opacity: [.6, 0], duration: 1.6, ease: EASE.out, repeat: 2 },
} as const;
export const HOLD = { tooltipDelay: 500, tooltipGrace: 600, hoverIntentOpen: 80, hoverIntentClose: 300,
  successCheck: 180, notice: 4000, transformNotice: 1600, error: 6000, bannerSuccess: 400, highlight: 400,
  todoCheck: 450, copied: 1200, devicesSettle: 400, dwell: 350, coalesce: 120, pendingDelay: 150,
  partialThrottle: 100, closeTimeout: 300, spamWindow: 400 } as const; // ms
export const LOOP = {
  pulse: { opacity: [1, .45, 1], duration: 1.2, ease: EASE.inOut, repeat: Infinity },
  spin: { rotate: 360, duration: .7, ease: "linear", repeat: Infinity },
  indeterminate: { segment: .3, duration: 1.1, ease: "linear", repeat: Infinity },
  promo: { period: 1.6, cycles: 3 },
} as const;
export const ENTRANCE = {
  tile:       { opacity: .34, blur: 8, filter: .36, y: 12, scale: .98, spring: "morph", stagger: .04, blurredTiles: 4 },
  handoff:    { opacity: .3, blur: 6, filter: .3, y: 12, spring: "ui", stagger: .02, start: .12, blurredTiles: 3 },
  onboarding: { opacity: .4, filter: .4, y: 16, spring: "morph" },
} as const;
export const LEVEL = { tickMs: 42, decay: .86, frameMs: 16.7, floorPx: 4, rangePx: 22, minRateHz: 24, reducedHz: 4 } as const;
// Per-word variants. Times in s; y/blur in px unless suffixed "fs" (× resolved font size).
export const WORD_VARIANTS = {
  headline:    { blur: "clamp(8,0.2fs,10)", y: "0.25fs", opacity: .315, filter: .45, transform: "spring.text", ease: EASE.enter,
                 delayed: { perWord: .4, opacity: .28 }, swapOut: { duration: .15, blur: 8, y: "-0.15fs", ease: EASE.exit } },
  title:       { blur: 6, y: "0.18fs", opacity: .22, filter: .32, transform: .32, ease: EASE.out, stagger: .03, cap: 8 },
  titleUnit:   { blur: 4, y: "0.12fs", opacity: .16, filter: .2, transform: .2, ease: EASE.out, delay: .04 },
  label:       { blur: 3, y: 0, opacity: .11, filter: .16, ease: EASE.out, exit: .08, enterDelay: .04 },
  block:       { blur: 3, y: 0, from: .35, opacity: .16, filter: .16, ease: EASE.out, exit: .08 },
  body:        { blur: 4, y: "0.12fs", opacity: .16, filter: .24, transform: .24, ease: EASE.out, splitCap: 40 },
  bodyCompact: { blur: 4, y: "0.12fs", opacity: .11, filter: .16, transform: .16, ease: EASE.out, stagger: .012, cap: 8 },
  stream:      { blur: 4, y: 2, opacity: .16, filter: .22, transform: .22, ease: EASE.out },
  reblur:      { blur: 3, from: .45, duration: .24, ease: EASE.out },
  neighbour:   { blur: 2, from: .7, duration: .16, ease: EASE.out },
  streamExit:  { blur: 3, duration: .08, ease: EASE.exit },
  digits:      { blur: 4, y: "0.35fs", enter: .22, exit: .15, large: { blur: 6, y: "0.3fs" }, subtle: { blur: 2, y: "0.2fs", enter: .15, exit: .1 } },
} as const;
```

### 6.3 Patterns
- **AnimatePresence modes:**
  - `popLayout` for lists, content swaps inside morphing shapes, digits and label swaps (exiting nodes leave the flow immediately, so nothing waits). Custom children must accept `ref` (React 19 passes it as a prop).
  - `sync` for overlays (scrim + dialog).
  - **Avoid `wait`.** It adds the exit duration as latency.
  - `initial={false}` on lists and every presence group whose initial children must not animate on mount. Only the first-show entrances opt in.
- **Exiting subtrees are inert** (rule 9): read `useIsPresent()` / `usePresence()` and set `inert` + `pointer-events: none` on the first exit frame. Pages, panes, dialogs, menus, toasts, deleted rows, the language menu.
- **Layout:**
  - `layout="position"` only, for pure position moves (re-ranks, grid filters, drag siblings, the hand-off headline words). **Never `layout` for size changes** of anything with text, charts or a radius: animate the real `height`/`width` instead (`useRealHeight`: measure → animate px → set `auto` on complete).
  - `layoutId` only for **text-free indicators** (`nav-active`, `pane-active`, `mic-radio`, `pad-tab`, `pad-note-active`, `dp-selected`), the translate-only `model-in-use` pill, and the two **container transforms** whose content cross-fades (`transform-⟨id⟩`, `hero-hold-fn`).
  - **No `layout`/`layoutId` in the Flow Bar** (§4.1.1).
  - Every layout node has a `layoutDependency` (list ids, active route, ranking, query).
  - `dictation:level`, partial text, the 1 Hz timer and progress values are **never React state in a component that is an ancestor of layout nodes** (hero chip/mini wave, mic chip level dot, Settings input level, model progress). Write them to refs/style or keep them in isolated leaf components. Otherwise every update re-measures every layout node.
  - Group interacting siblings in `LayoutGroup` (nav, onboarding steps). `layoutScroll` on scroll containers that hold layout nodes.
  - Put `borderRadius` and `boxShadow` in `style`/`animate`, not in classes, so Motion scale-corrects them.
  - **Never** put `layout` on word spans or waveform bars.
- **Where values run:** opacity, filter and `transform` *strings* run as WAAPI (off the main thread). Independent `x`/`y`/`scale` and all springs run on the JS loop. `clip-path` driven by a spring runs on WAAPI only if Motion converts the spring to `linear()` easing, otherwise on the main thread; either is fine for one 304 × 166 element. Use strings for word/digit/label tweens; springs for shapes (few nodes).
- **One transform channel per element** (rule 10): entrance transform strings on an inner wrapper; press/hover scale and spring `x`/`y` on the outer element.
- **will-change hygiene:** never set it in CSS. Motion promotes during an animation and releases afterwards. End every blur with `transitionEnd: { filter: "none" }` and every transform tween with `transform: "none"`.
- **`backdrop-filter`:** the glass layer is static and is a **sibling** of the animated content layer (rule 6).
- **Declarative first:** drive state from props (`animate={state}`), never from imperative sequences that assume completion. Use `useAnimate` sequences only for one-shot signatures (granted flip, done, hand-off, first entrance).
- **Interruption rule for one-shot choreographies.** When a newer state arrives for the same surface (or the surface unmounts) while a sequence runs:
  1. Steps **not yet started** jump to their end state in the same frame (or are dropped if the surface is leaving).
  2. **In-flight springs** retarget from their current value and velocity to the new target.
  3. **In-flight tweens** finish over `dur.micro` from their current value, unless the new state animates the same property, in which case they retarget.
  4. The new state's choreography starts at its own t = 0 immediately. Nothing waits.

| Case | What renders |
|---|---|
| Nav click during the §4.3.1 first entrance | The Dictation page becomes the outgoing page (inert at once) and fades from its current state over `dur.flash`; its sequence is dropped |
| `dictations:added` during the first entrance | The row insert starts at once. Recent's unstarted row steps jump to end. Changed digits animate opacity/y only while their tile is still blurring (rule 8) |
| Continue clicked mid granted flip (§4.6.3) | Flip steps not started jump to end; the height springs retarget; Continue's choreography starts at t = 0 |
| A second grant arrives mid flip | Unstarted flip steps jump to end; Done (§4.6.4) starts at t = 0, its step 2 card → row retargets the in-flight grow |
| Headline text changes mid-reveal (A → B → C) | The visible words exit together with the headline swap from their current values; the newest text starts 80 ms later. B never renders if C arrives before B's first word starts |
| `label` swap re-triggered mid-swap | The entering label becomes the exiting one from its current opacity; the newest enters at t = 40. At most 2 labels in the DOM (an older exiting one is removed instantly) |
| Dialog closed (Esc) before its open finishes | Retargets to closed from the current opacity/scale/blur; inert and focus-to-trigger at t = 0 |
| Menu / popover / mic picker re-toggled mid-open or mid-close | Retargets from the current values. No restart from 0 |
| Settings pane-switch spam | As nav spam: the pill follows the last click; no stacked panes |
| Scratchpad close requested during its open | The exit retargets from the current values; the handshake proceeds |
| Todos re-entry during its exit | `todos:cancel-close`; the panel retargets to open |
| Flow Bar | The matrix in §4.1.12 |

- **IPC-driven state** (Flow Bar): reduce `dictation:state` + `dictation:stage` + error/notice into **one** state value in a reducer, so a burst of IPC messages lands as one retarget, not several.
- **Visibility:** §3.6. First-show entrances hold their initial frame while hidden and start on visible / `win:shown`; live updates apply the end state.
- **Keyboard:** gate optional motion with an `inputModality` ref (`pointer` | `keyboard`) updated on `pointerdown`/`keydown`.
- **Focus management:** focus never falls to `<body>` because of an animation. Granted flip → step 2's primary action at t = 200 (§4.6.3); Done → the Done button (§4.6.4); hand-off → the Dictation main heading; dialog open → first field at t = 0, close → trigger at t = 0; KeyRecorder → the field after capture or Esc; Todos composer → the title input after submit; collapsed step click → the expanded step's primary action. Always `preventScroll`.
- **Auto-dismiss holds** (toasts, Flow Bar notice and error) pause on hover **and** on `focus-within` (WCAG 2.2.1).

### 6.4 Performance budget

| Metric | Budget |
|---|---|
| Frame rate | 60 fps floor on 60 Hz displays. Target 120 fps on ProMotion. Measure the rAF delta in the Flow Bar (8.3 ms = 120 Hz). ProMotion caps at 60 in Low Power Mode, which is acceptable |
| Main-thread JS per frame during "Recording → Busy + card" with streaming | ≤ 4 ms (Performance trace) |
| Long tasks during any animation | 0 over 50 ms |
| Concurrent live `filter` per window | 12 (words + elements), allocated per batch. Large surfaces: 4 |
| Blur radius | ≤ 10 px |
| Concurrently animating layout nodes | ≤ 20. Above that, apply instantly (filters, bulk changes) |
| Flow Bar renderer idle (sliver) | 0 running animations, 0 rAF callbacks (the rAF loop runs only while recording or while the level is decaying to the floor) |
| Partial → first word pixel | ≤ 1 frame after the IPC message (diff ≤ 1 ms for ≤ 200 words) |
| Hub first entrance | Starts within 1 frame of becoming visible. No layout thrash (measure all tiles in one pass). 0 dropped frames on the lowest supported Mac |
| React renders during a 30 s dictation | 0 renders of the Recent list / bento grid other than on `dictations:added` (React Profiler) |

### 6.5 Code hooks this spec depends on (owned outside the motion work)
1. **Flow Bar window** (owner: `src/main` workflow): fixed 400 × 260 window, `setIgnoreMouseEvents(true, {forward:true})`, `bar:hit` IPC, `bar:shape-rect` + 30 Hz cursor-poll backstop, remove `bar:mode` setBounds, `backgroundThrottling:false`, global Esc **only while recording** (and while the pointer is over an error card), instant reposition on display change. First task: the click-through spike (§4.1.1).
2. **Partials:** `dictation:partial` carries the full running text (cloud: `committed.join(' ') + ' ' + lastPartial` on both message types), throttled to 1 per 100 ms, consumed by the Flow Bar.
3. **Notice channel:** a `kind` on the message (`error` | `notice`) for copy fallback, key fallback, cloud fallback, transform applied, cleanup failed.
4. **Todos:** `todos:will-close` / `todos:closed` / `todos:cancel-close` with `closeSeq`; the 300 ms fallback lives in main. `DWELL_MS` = 350.
5. **Scratchpad:** `show:false` + `ready-to-show`; main intercepts `close` (⌘W, native close) and runs `pad:will-close {seq}` → `pad:closed {seq}` with the 300 ms fallback in main; app quit closes instantly.
6. **Reduce Motion:** initial value from `systemPreferences.getAnimationSettings()` at every window creation via `additionalArguments`; optional `NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification` subscription → `motion:reduced` broadcast.
7. **Idle mic level monitor** (picker dot, Settings input level). Without it, those meters are static.
8. **Electron ≥ 38.2** (owner: app platform / `src/main` workflow). Motion QA results are valid only on the upgraded runtime.
9. **`win:shown`** sent by main after `show()` / `showInactive()` for hub, Todos and Scratchpad, plus `firstShowDone` passed to a recreated hub.
10. Recommendation: send `dictation:level` only to windows that subscribed (bar, hub while visible), not to every window.

---

## 7. QA checklist

**Tokens & timing**
- [ ] No hard-coded durations, curves, springs, distances, scales or blur radii outside `tokens.ts`/`motion.css` (grep for `transition:`, `duration:`, `blur(`, `scale:` in components). No plain `ease`.
- [ ] Everyday interactions finish ≤ 250 ms (perceptual), **including route/pane/dialog titles**. Record with the DevTools Performance panel or a 120 fps screen capture.
- [ ] Every signature choreography ends ≤ 600 ms from its trigger: bar → recording, → busy + card (incl. catch-up text), done (both paths), error, first bento, onboarding entrance / granted flip / done / hand-off, card → dialog, voice note reveal. Appendix A numbers match a recording.
- [ ] No `transition: all` anywhere. No static `will-change`.

**Interruption**
- [ ] Flow Bar: tap fn quickly (record < 200 ms) → goes straight to busy, with no flash of the full recording pill.
- [ ] Flow Bar: hover in/out rapidly across the sliver → no flicker, and the click-through edge doesn't jitter.
- [ ] Flow Bar: start a new dictation during the done collapse → the shape's velocity is continuous: sampled per rAF, no frame where any edge of the shape jumps > 2 px.
- [ ] Flow Bar: "Try again" from an error → goes to recording without passing through the sliver.
- [ ] Flow Bar: Esc works only while recording (and over an error card); Esc in the target app is never swallowed otherwise.
- [ ] Every row of the §4.1.12 matrix and the §6.3 case table, exercised once.
- [ ] Click three nav items fast → the pill follows the last click, and there are no stacked pages. Same for Settings panes.
- [ ] Toggle a todo 4× quickly → the strike and hold follow the final state, and the row ends in the right list.
- [ ] Date-picker month spam → swaps go instant after 2 clicks within 400 ms.
- [ ] Todos: re-enter the edge during the exit → the panel reopens from its current position; a stale `todos:closed` never closes it.

**Blur words**
- [ ] Partials: only new words blur. Settled words never re-animate. A corrected word re-blurs in place with no line jump and no remount (same DOM node). Deleted words blur out with their separator, and the next word re-blurs.
- [ ] Cloud partials across a commit boundary produce no full re-insert.
- [ ] Words arrive at a steady cadence (no clump-then-silence) at 1.5 s partials.
- [ ] Unconfirmed tail at 60 % `$fg` colour; confirmed words → 100 %.
- [ ] Never more than 12 elements with a live non-`none` `filter` (debug overlay sampling computed `filter` per frame). After 50 interrupted bursts, words still blur (no leaked budget).
- [ ] No element runs a filter while an ancestor does.
- [ ] At rest, every word, digit and label has computed `filter: none` and `transform: none`, and the DevTools Layers count returns to baseline.
- [ ] Blur halos are not clipped in the Partial card (4 px padding) and the top edge fades with the mask.
- [ ] Copying a Recent row or the transform preview yields the text once; find-in-page matches once.
- [ ] Headline wrapping at narrow hub widths matches the plain-text wrapping.
- [ ] `BlurNumber`: 999 → 1,000 width change animates, only the changed digits move (max 3 staggered), and the trend is correct for down (WPM falling).
- [ ] Voice note reveal never writes spans into the saved note; undo, caret and selection behave normally; typing during the reveal snaps to rest.

**Accessibility**
- [ ] VoiceOver reads each headline once as a whole and never letter by letter. Numbers are read as values. The timer is never announced.
- [ ] Flow Bar status region announces state words (best effort; verify with VoiceOver while another app is frontmost). No transcript is announced by the bar.
- [ ] Exiting pages, panes, dialogs, menus and toasts are not tabbable or clickable from the first exit frame.
- [ ] Focus never lands on `<body>` after the granted flip, Done, hand-off, dialog close or KeyRecorder capture.
- [ ] Row actions appear instantly on keyboard focus.

**Reduce Motion**
- [ ] Toggling it live affects every open window with no relaunch; a recreated hub starts reduced.
- [ ] `document.getAnimations().length === 0` throughout a full dictation, onboarding grant, nav switch, dialog open, toast, todo check and drag. Imperative sequences are covered.
- [ ] Blur text renders plain with no spans. The waveform is replaced by the static meter. Spinner and pulse are static.
- [ ] Todos/Scratchpad close immediately (handshakes don't wait).

**Rendering & environment**
- [ ] Measured pass per surface: `getComputedStyle` + `getBoundingClientRect` of every Flow Bar layer at rest in each state = the §4.1.2 geometry.
- [ ] Flow Bar shadow and shape never clipped by the 400 × 260 window at peak overshoot; the language menu fits.
- [ ] Click-through spike passes (§4.1.1 step 8).
- [ ] Nothing that carries or contains `backdrop-filter` has a running opacity/filter/mask/clip-path/transform animation.
- [ ] Animations run while the app is unfocused (Flow Bar, Todos): `backgroundThrottling:false` is honoured.
- [ ] First-show entrances play on a hub, Todos panel and Scratchpad created hidden (`show:false`, `showInactive()`).
- [ ] The hub is not throttled to hidden while the Flow Bar overlaps it.
- [ ] Performance trace of the first bento entrance on the lowest supported Mac: 0 dropped frames. "Recording → Busy + card" ≤ 4 ms main-thread JS per frame.
- [ ] React Profiler during a 30 s dictation: 0 renders of the Recent list / bento grid apart from `dictations:added`.
- [ ] `dictation:level` real event rate measured; if < 24 Hz, interpolation is on.
- [ ] 120 Hz: the rAF delta in the Flow Bar is ~8.3 ms on a ProMotion display (not in Low Power Mode).
- [ ] **Gate:** smoothness sign-off only on Electron ≥ 38.2 (macOS 26 vibrancy GPU bug).

---

## 8. Decisions recorded (v2)

No open items remain in this spec. Decisions that other deliverables must reflect:

| Decision | Reflect in |
|---|---|
| Todos dwell = **350 ms**, no dwell timer chip (the storyboard's "LEFT-EDGE DWELL · 1 SECOND" with the Timer chip in `YQI5b` is superseded) | Motion board storyboard for the dwell (350 ms, no timer chip); code `DWELL_MS` (§6.5 #4) |
| Reduce Motion waveform = static **5-segment** meter at ≤ 4 Hz | A Reduce Motion meter frame on the Motion board |
| Flow Bar design additions: "Recording + live partial" card, language menu (§4.1.10a), notice anchored to the capsule, "Stop · fn" latched tooltip | Frames on the Motion board |
| Hero Ready chip "Mic needed" / "Access needed" state | A Hero tile state on the Motion board |
| Copy-fallback completion shows **no check** (notice only); errors outrank notices; notices during a dictation live in the card head | Flow Bar storyboard |
| Route, pane and dialog titles swap as one unit; per-word reveals are reserved for the stream, headlines (once), empty states, error-card titles, the voice note and the transform preview | HTML spec page demos |
| Hand-off headline diffs "Hold fn and say hello." into "Hold fn to talk." | Hand-off storyboard |

---

## Appendix A: Quick reference

| Surface | Moment | Token(s) | Total (ms) |
|---|---|---|---|
| Flow Bar | Sliver → capsule | `spring.fluid`; buttons 20 / 35 / 35 / 50 + `spring.snap` | 250 |
| Flow Bar | Capsule → sliver | `spring.exit` @ 40 | 240 |
| Flow Bar | → Recording | `spring.morph`, dot hand-off, wave `stagger.ring` @ 60, timer @ 120 | 340 |
| Flow Bar | → Busy + card | `spring.morph`, clip `spring.ui` @ 60, catch-up text fitted | 340 (≤ 600 with catch-up) |
| Flow Bar | Live words | `stream`, `stagger.stream` (35–90 ms, cadence-adaptive) | 220 per word, continuous |
| Flow Bar | Done → sliver | check `spring.pop`, send-out @ 80, hold 180, `spring.exit` @ 380 | 580 |
| Flow Bar | Done, copy fallback | send-out @ 80, collapse, notice @ 160 | 410 |
| Flow Bar | Error | `spring.morph`, title per word @ 80, `ring` @ 100 | 520 |
| Flow Bar | Notice | `spring.fluid` in, `dur.fast` out, hold 4 s / 1.6 s | 250 in / 150 out |
| Flow Bar | Cancel | `spring.exit`, all at 0 | 200 |
| Hub | Route switch | pill `spring.fluid`; out 80; in 150 + x 6 `spring.snap` @ 30; `titleUnit` @ 40 | 240 |
| Hub | First bento | `stagger.tiles` 40 wave, headline 40 ms stagger @ 80, data viz @ 240 | 600 |
| Hub | Dictation added (completion echo, signature tier) | row real height `spring.ui`, `body.compact`, digits @ 80 | 340 |
| Hub | Popover / menu | `dur.fast` + `spring.ui` in, `dur.micro` out, no row stagger | 250 / 100 |
| Hub | Dialog | `spring.ui` + `titleUnit`; from card `spring.morph` | 250 / 340; close 100 / into card 210 |
| Hub | Toast | `spring.fluid` in, `dur.fast` out; replace @ 40 with `spring.snap` | 250 / 150; replace 190 |
| Hub | Banner | real height `spring.ui`, `block` @ 60 | 250 |
| Onboarding | Entrance | tiles, headline 33 ms stagger @ 100 | 600 |
| Onboarding | Granted flip | `spring.pop` check, `ring` @ 40, `spring.morph` heights @ 200 | 540 |
| Onboarding | Done | chip flip, "You're set." @ 80, Try-it @ 120 | 540 |
| Onboarding | Hand-off (chained) | `hero-hold-fn` morph, headline diff @ 140, hand-off tiles @ 120 | 580 |
| Settings | Pane switch | `spring.fluid` pill, y ±8 `spring.snap` @ 30, `titleUnit` @ 40 | 240 |
| Settings | Toggle | `spring.snappy` knob, squash `spring.snap` | 200 |
| Todos | Panel open / close | `spring.fluid` + blur 8, items `stagger.tight` @ 30 / `dur.fast` exit + handshake | 250 / 150 |
| Todos | Check → move | stroke 150, strike 200, hold 450, `spring.ui` | (hold) + 250 |
| Scratchpad | Window open / close | `spring.fluid` + blur 4 / `dur.fast` exit + handshake | 250 / 150 |
| Scratchpad | Voice note reveal (chained) | `body`, fitted from 120 (or 0 if open) | ≤ 600 |
| All | Reduce Motion | instant | 0 |
