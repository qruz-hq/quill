# Quill Motion: Implementation Guide

Status: foundation landed (new files only) · 2026-10-10
Spec: [`docs/MOTION.md`](./MOTION.md) is authoritative. This guide maps every spec item to the code that implements it and the files that still have to adopt it. Section numbers (§) refer to MOTION.md.

The foundation lives in `src/renderer/src/shared/motion/`. **No screen uses it yet.** Screens, CSS, `src/main` and the preload were deliberately left alone because another workflow is editing them. Adopting the foundation is the follow-up integration pass described in §3 and §4 of this guide.

---

## 1. What exists

| File | Exports | Spec |
|---|---|---|
| `tokens.ts` | `DUR` (s), `DUR_MS`, `EASE`, `cssEase()`, `SPRING`, `springPhysics()`, `springToLinear()`, `tween()`, `T()`, `STAGGER` (incl. `stream()`, `fit()`), `STAGGER_CAP`, `staggerDelay()`, `STREAM`, `DIST`, `SCALE`, `BLUR`, `BLUR_CAP`, `blurPx()`, `RING`, `LOOP`, `HOLD` (ms), `Z`, `LEVEL`, `ENTRANCE`, `WORD_VARIANTS`, `headlineBlur()`, `FLOWBAR` (geometry), `TOTALS_MS`, `RULES`, `isReducedMotion()` | §2, §4.1.2, App. A |
| `motion.css` | CSS custom properties (`--dur-*`, `--ease-*`, `--dist-*`, `--blur-*`, `--stream-unconfirmed`), `.m-hover` recipe, blur-word and digit anatomy classes, `.m-sr-only`, `.bw-viewport`, the Reduce Motion backstop | §2, §3.1, §4.13, §5 |
| `MotionProvider.tsx` | `MotionProvider` (alias `MotionRoot`), `useReduceMotion()`, `setReducedMotionOverride()`, `useWindowShown()`, `useDocumentVisible()`, `inputModality()` | §5, §6.1, §3.6, §6.3 |
| `BlurWords.tsx` | `BlurWords` with variants `headline`, `title`, `titleUnit`, `label`, `block`, `body`, `bodyCompact` | §3.1, §3.2 |
| `BlurStream.tsx` | `BlurStream` (live partial diffing), `StreamViewport` (bottom-anchored 2-line clip with line scroll) | §3.3 |
| `wordDiff.ts` | `tokenize`, `normalize`, `myers`, `pairRuns`, `diffTokens`, `applyPartial` (pure) | §3.3 |
| `BlurNumber.tsx` | `BlurNumber` (sizes `auto`, `default`, `large`, `subtle`), `formatTimer` | §3.4 |
| `filterBudget.ts` | `filterBudget` (12 live filters), `largeSurfaceBudget` (4), `isLargeSurface()` | §3.5 |
| `waapi.ts` | `animateWord()` (the only WAAPI entry point, Reduce Motion short-circuit, budget release on settle), `finishAll()`, `currentOpacity()` | §5 enforcement 2, §3.3 |
| `MorphContainer.tsx` | `RealHeight`, `RealWidth`, `Indicator` (text-free `layoutId`), `MorphContainer` (container transform), `MorphBox` (Flow Bar geometry, no layout), `PresenceSwap`, `useExitInert()`, `STATE_FADE` | §6.3, §4.1.1 |
| `presets.ts` | `fadeUpStagger`, `popover`, `sideMenu`, `selectInPlace`, `autocomplete`, `dialog.{scrim,content}`, `morphContent`, `toast`, `bannerContent`, `notice`, `tooltip`, `barTooltip`, `routeSwitch`, `paneSwitch`, `monthSwap`, `crossFade`, `tileEntrance`, `handoffTile`, `onboardingTile`, `rowInsert`, `recentRowInsert`, `rowDelete`, `cardDelete`, `filterOut`, `rowActions`, `popIn`, `signaturePop`, `chipIn`, `checkStroke`, `press()`, `barButtonHover`, `capsuleButton`, `pulse`, `spin`, `ring()`, `HEIGHT`; also bundled as `PRESET` | §4 |
| `barHit.ts` | `useBarHitTest()`, `shapeRect()` (renderer half of the click-through window) | §4.1.1 |
| `index.ts` | Barrel for everything above | |
| `dev/MotionLab.tsx`, `dev/main.tsx`, `src/renderer/motion-lab.html` | Dev-only lab page plus the `window.__lab` test API. Not a build input | |
| `tests/motion/wordDiff.test.ts` | 17 unit tests (`bun test tests/motion`) | §3.3 |
| `tests/motion/serve-lab.mjs`, `tests/motion/lab-harness.mjs` | Lab dev server on :5199 and a Playwright harness | §7 |

Dependency: `motion@14.1.0`, pinned exactly. Import only from `"motion/react"`. Inside `MotionProvider`, `LazyMotion strict` is on, so components must use `m.div` and never `motion.div`.

### Deviations from the spec, and why

| Spec says | Foundation does | Reason |
|---|---|---|
| Module name `MotionRoot.tsx` (§6.2) | `MotionProvider.tsx`, which also exports `MotionRoot` | The task named it `MotionProvider`. Both names work |
| `useRealHeight.ts` hook (§6.2) | `RealHeight` component (Motion `height: "auto"`, which measures, animates in px, then sets `auto`) | Same behaviour with less code. Motion already handles measure → px → auto and retargeting |
| `useLevel.ts` (§2.7, §4.1.5) | **Not built.** Tokens are in `LEVEL` | It is tied to IPC (`dictation:level`), and the Flow Bar and hero mini wave aren't being touched yet. Build it in the integration pass (see §4) |
| Headline `y` uses Motion's main-thread spring (§3.2 note) | `spring.text` is converted once to a CSS `linear()` easing (`springToLinear`) and runs as WAAPI | It stays off the main thread, uses the same physics and keeps one transform channel per word |
| Over-maxD stream tail "cross-fades" (§3.3 step 4) | The old tail is removed at once and the new tail enters as a block (`block` timings, `blur(4px)`, same delay for every word) | A true in-flow cross-fade would double the text for 80 ms and jump the line |
| Task wording "aria-label on container + aria-hidden word spans" | Spec §3.1: one sr-only real-text twin plus **one** `aria-hidden` wrapper. User content gets no twin and no aria-hidden | §3.1 explicitly forbids `aria-label` on generic elements and per-span `aria-hidden`. The spec wins |

---

## 2. Verified behaviour (Motion Lab harness)

To run it: `node tests/motion/serve-lab.mjs &`, then `PLAYWRIGHT_CORE=<path to playwright-core/index.mjs> CHROMIUM=<optional chrome path> node tests/motion/lab-harness.mjs`. Last run: all checks passed (exit 0), headless Chromium, 60 Hz.

| Check | Result |
|---|---|
| Stream: a substitution keeps the **same DOM node** and re-blurs with filter and opacity only (no y) | pass |
| Stream: settled words never re-animate | pass (0 animations on settled words) |
| Stream: a deleted token exits together with its leading separator, then leaves the DOM | pass |
| Stream: neighbour re-blur on the first word after a deletion, same line only | pass |
| Stream: inserts enter with opacity, filter and y | pass |
| Stream: unconfirmed tail at 60 % `--fg`, everything confirmed on `final` | pass |
| At rest: computed `filter: none`, `transform: none`, 0 word animations, budget 0 | pass |
| Text reads once (`textContent` = the sentence, single spaces) | pass |
| 40-word stream, 300 ms partials: frame deltas | avg 16.67 ms, p95 16.8, max 16.8, 0 frames over 17.5 ms, 0 long tasks |
| 40-word stream, 100 ms partials (throttle ceiling) | avg 16.67 ms, max 16.8, 0 dropped |
| Main-thread cost during the 300 ms stream (CDP metrics, includes the lab's own per-frame UI) | script ≈ 1.0 ms/frame, all tasks ≈ 1.7 ms/frame, layout ≈ 0.09 ms/frame (budget 4 ms) |
| Peak elements with a non-`none` filter (sampled every frame) | **12**, never above the cap |
| 50 interrupted bursts (partials every 20–65 ms, mid-burst clears) | budget back to 0; words still blur afterwards (no leak) |
| Headline: 4 tokens incl. the inline `fn` keycap, fitted stagger 50 ms, sr twin present, wrapper `aria-hidden="true"`, rest filter none | pass |
| Digits 9,998 → 9,999 → 10,000: only changed glyphs animate (old out, new in), wrapper width animates, sr value updated | pass |
| Reduce Motion (emulated `prefers-reduced-motion: reduce`): headline replay and swap, full stream, digit changes | `document.getAnimations().length` **0 on every frame**, 0 filters, 0 word spans (plain text), full text present |
| Reduce Motion toggled **live** mid-stream | spans gone and 0 animations in the same frame; stays 0 |
| `diffTokens` on 200 words | < 1 ms (unit test) |

Not verifiable in headless Chromium, so do these on hardware in the integration pass: 120 Hz ProMotion rAF delta, the Electron 33 vs ≥ 38.2 compositor behaviour (§6.1), and the DevTools Layers count returning to baseline.

---

## 3. Integration pass: global wiring

| # | Change | File(s) | Spec |
|---|---|---|---|
| G1 | Wrap each renderer root: `<StrictMode><MotionProvider>…</MotionProvider></StrictMode>`. This also loads `motion.css` | `src/renderer/src/hub/main.tsx`, `flowbar/main.tsx`, `scratchpad/main.tsx`, `todos/main.tsx` | §6.1 |
| G2 | Main reads `systemPreferences.getAnimationSettings()` at **every** window creation (`prefersReducedMotion \|\| !shouldRenderRichAnimation`) and passes `--reduce-motion=1` through `webPreferences.additionalArguments` | `src/main/index.ts` (`createHub`, `createFlowBar`, `openScratchpad`, `openTodos`) | §5 detection 2 |
| G3 | The preload checks `process.argv.includes('--reduce-motion=1')` and sets `document.documentElement.setAttribute('data-reduce-motion', '')` on `DOMContentLoaded` (before React). `MotionProvider` seeds from it | `src/preload/index.ts` | §5 |
| G4 | Optional live backstop: subscribe to `NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification`, broadcast `motion:reduced`, and have the renderer call `setReducedMotionOverride(v)` | `src/main/index.ts`, preload (`onReducedMotion`), each `main.tsx` | §5 detection 3 |
| G5 | `win:shown` after `show()` / `showInactive()` for the hub, Todos and Scratchpad; first-show entrances gate on `useWindowShown(window.flow.win.onShown)`. Pass `firstShowDone` to a recreated hub | `src/main/index.ts`, preload | §3.6, §6.5 #9 |
| G6 | `webPreferences.backgroundThrottling: false` on the bar, Todos and Scratchpad windows | `src/main/index.ts` | §4.1.1, §4.9, §4.12 |
| G7 | Port existing CSS motion: `--spring-duration` → `var(--dur-base) var(--ease-out)` (or `--ease-standard` for colour-only); delete `--nudge-duration` and the infinite `promo__dot` pulse; replace every plain `ease`; no `transition: all`; hover = `.m-hover` or the same two durations | `src/renderer/src/styles/tokens.css`, `hub/hub.css`, `flowbar/flowbar.css`, `scratchpad/scratchpad.css`, `todos/todos.css` | §2.9, §4.13 |
| G8 | QA grep gate: no raw `duration:`, `blur(`, `scale:` or `cubic-bezier` outside `shared/motion/` | all components | §7 |

---

## 4. Integration pass: per surface

Notation: **Spec item → foundation piece → file(s) that adopt it.** "(new)" means a component the screens workflow is expected to create (top nav, bento tiles); adopt the motion wherever it lands.

### 4.1 Flow Bar (`src/renderer/src/flowbar/FlowBar.tsx`, `Waveform.tsx`, `flowbar.css`; `src/main/index.ts`; preload)

**The fixed transparent window change (main + preload). Do this first.**

1. In `src/main/index.ts`: replace `BAR_IDLE` / `BAR_OPEN` and `barBounds(mode)` with one fixed size, `FLOWBAR.window` = **400 × 260**, right-aligned to the primary work area and vertically centred. Remove the `ipcMain.on('bar:mode', … setBounds …)` handler. On `screen` `display-metrics-changed` / `display-removed`, reposition instantly with `setBounds` (no animation).
2. In `createFlowBar()`: keep `transparent`, `frame:false`, `hasShadow:false`, `focusable:false`, `alwaysOnTop 'screen-saver'` and all workspaces. Add `webPreferences.backgroundThrottling: false`. After creation, call `win.setIgnoreMouseEvents(true, { forward: true })`.
3. New IPC `bar:hit` (boolean). `true` → `setIgnoreMouseEvents(false)`; `false` → `setIgnoreMouseEvents(true, { forward: true })`. Preload: `window.flow.bar.setHit(hit)`. Remove `bar.setMode` from the preload and `index.d.ts`.
4. New IPC `bar:shape-rect` (published on every state settle). Main polls `screen.getCursorScreenPoint()` at 30 Hz while ignore = true and re-asserts the ignore state if forwarding stopped.
5. Global Esc only while `recording`, and while the pointer is over an error card (`bar:hit` with an error shown). Today the bar's document `keydown` cannot fire, because the window is `focusable:false`.
6. Spike first (§4.1.1 step 8): forwarded `mousemove` reaches the non-focusable window while another app is frontmost, survives 1,000 toggles, display sleep and a Space change, and the hover → capsule latency is ≤ 80 ms + 1 frame.

**Renderer:**

| Spec | Foundation | Notes |
|---|---|---|
| §4.1.1 click-through hit test | `useBarHitTest((h) => window.flow.bar.setHit(h))`; put `data-hit` on the shape, cards, notice and menu. Use a 12 px sliver hit zone via a `::before` | Tooltips get no `data-hit` |
| §4.1.2 geometry | `FLOWBAR.shape.*`, `FLOWBAR.buttons`, `.recDot`, `.waveform`, `.timer`, `.spinner`, `.partialCard`, `.errorCard`, `.notice`, `.languageMenu` | Every layer is absolute in window coordinates. **No `layout` / `layoutId` in the bar** |
| Shape morphs (sliver ⇄ capsule, → recording, ↔ busy, → error, → sliver) | `<MorphBox box={FLOWBAR.shape[state]} transition={SPRING.fluid \| SPRING.morph \| SPRING.exit} hit>` | Use one reducer that merges `dictation:state` + `:stage` + error/notice into one state (§6.3) |
| §4.1.3 capsule buttons radiate (20 / 35 / 35 / 50 ms) | `presets.capsuleButton` with `custom` = delay, `presets.barButtonHover`, `presets.press('icon')` | Close: buttons out with `dur.micro`, then the shape → sliver with `spring.exit` at t = 40 |
| Hover intent 80 ms / 300 ms | `HOLD.hoverIntentOpen`, `HOLD.hoverIntentClose` | Timers, not motion; unchanged under Reduce Motion |
| Bar tooltip (slide out, label swap, grace) | `presets.barTooltip`; label `<BlurWords variant="label">`; `HOLD.tooltipDelay` / `tooltipGrace`; y follows with `SPRING.fluid` | "Stop · fn" latch swap = `label` |
| §4.1.4 rec dot hand-off (32 → 8, violet → error) | An `m.div` with `animate={{ x, y, width, height, borderRadius, backgroundColor }}` and `transition={{ default: SPRING.morph, backgroundColor: tween('base','standard') }}`; from idle use `presets.popIn` at t = 60 | Then `presets.pulse` from t = 340 |
| Waveform (15 bars, rings centre-out at 6 ms) | Needs `useLevel` (to build): one rAF loop, attack immediately, decay `LEVEL.decay^(dt/16.7)`, direct style writes; bar opacity stagger `STAGGER.ring` | Reduce Motion: static 5-segment meter at `LEVEL.reducedHz` |
| Timer 0:00 | `<BlurNumber value={secs} format={formatTimer} size="subtle" />` | Enters as one unit at t = 120 (`dur.base`). Never inside `aria-live` |
| §4.1.6 Partial card unfurl | An `m.div` with `clipPath: inset(0 0 0 100% round 16px) → inset(0 0 0 0 round 16px)` on `SPRING.ui`, plus x `+8 → 0` on `SPRING.morph`. Head `opacity` + `blur(4)` at T0 + 120 | T0 = 0 during recording, 60 at stop |
| Card text | `<StreamViewport height={2*lineHeight + 8}><BlurStream text={partial} final={isFinal} catchUpStart={T0 + 0.12} ariaHidden ref={streamRef} /></StreamViewport>` | Lab: card demo in `dev/MotionLab.tsx` |
| Head label LISTENING → TRANSCRIBING → POLISHING | `<BlurWords variant="label" animateWidth text={…} />` | Notice-during-dictation also uses the head label (colour `$fg-3 → $warn` via CSS `--dur-fast`) |
| Progress (indeterminate / determinate) | `LOOP.indeterminate`; fill width on `SPRING.ui`, coalesced at `HOLD.coalesce` | |
| Spinner ⇄ dot ⇄ check | `presets.spin`, `presets.popIn`, `presets.signaturePop` + `presets.checkStroke` | |
| §4.1.8 Done send-out | `streamRef.current.settle()` at t = 80, then the text block `x +6`, opacity 0, `blur(4)`; card clip-path collapses on `SPRING.exit`; pill fill → `$success-soft`; hold `HOLD.successCheck`; shape → sliver on `SPRING.exit` at 380 | Copy fallback: no check, notice at 160 |
| §4.1.9 Error | Card height/y retarget on `SPRING.morph`; title `<BlurWords variant="title">` at t = 80; meta `variant="block"`; icon tile `presets.ring()` at 100; actions `presets.fadeUpStagger({ y: DIST.sm, step: STAGGER.list, start: 0.16 })` | Error dismiss waits for `HOLD.error`, paused on hover / focus-within |
| §4.1.10 Notice pill | `presets.notice`; text `label` at t = 60; replace = `label` swap + `RealWidth` | `HOLD.notice` / `HOLD.transformNotice` |
| §4.1.10a Language menu | `presets.sideMenu`, check `presets.popIn`; close at t = 120 | `data-hit` |
| §4.1.11 Cancel | `streamRef.current.exitAll()` ∥ card clip `SPRING.exit` ∥ shape `SPRING.exit` | Total 200 |
| Status region | One polite sr-only region with state words only; the transcript stays `aria-hidden` | |

### 4.2 Navigation shell (`hub/App.tsx`, `hub/Sidebar.tsx` / top nav (new), `hub/TitleBar.tsx`)

| Spec | Foundation |
|---|---|
| Active nav pill | `<LayoutGroup id="nav"><Indicator layoutId="nav-active" dependency={route} /></LayoutGroup>` (default `SPRING.fluid`); label colour via CSS `var(--dur-fast) var(--ease-standard)` |
| Route switch | `<PresenceSwap swapKey={route} variants={presets.routeSwitch} custom={sign(newIdx − oldIdx)}>`. The incoming route title is `<BlurWords variant="titleUnit" text={title} />` (animates only on change) |
| Nav hover / press | `.m-hover`, `presets.press('button')` |
| Sidebar collapse (if it survives) | `animate={{ width }}` on `SPRING.ui`; labels opacity `DUR.micro` |

### 4.3 Dictation home: bento (`hub/DictationScreen.tsx`, `hub/Insights.tsx`, bento tiles (new))

| Spec | Foundation |
|---|---|
| §4.3.1 first entrance, once per launch, gated on `useWindowShown` | Each tile's **content layer** (never the glass parent): `<m.div variants={presets.tileEntrance} custom={{ i, blur: i < 4 }} initial="initial" animate={shown ? 'animate' : 'initial'} />` |
| Hero headline at t = 80 | `<BlurWords as="h1" variant="headline" delay={0.08} parts={['Hold', { node: <Keycap>fn</Keycap>, text: 'fn' }, 'to talk.']} hold={!shown} />`; exclude it from the tile's blur wrapper (rule 8). Fitted stagger: 40 ms |
| Ready chip, mini wave | Opacity `DUR.fast` at 200 / 220; label swaps `variant="label"`; dot `presets.pulse` |
| Streak grid sweep | `clipPath inset(0 100% 0 0) → inset(0 0 0 0)`, `tween('reveal','out', 0.24)` |
| Most-used bars | Inner fill `scaleX` on `SPRING.ui`, `staggerDelay(i, STAGGER.tight, 8, 0.24)` |
| Recent rows | `presets.fadeUpStagger({ start: 0.24 })` |
| §4.3.2 `dictations:added` | Row: `<RealHeight open content={presets.recentRowInsert}>`, text `<BlurWords variant="bodyCompact" userContent />` only if visible and focused (`useDocumentVisible()`); counters `<BlurNumber>` at t = 80 |
| Re-rank Most used | `layout="position"` + `layoutDependency={ranking}`, `transition={SPRING.ui}` |
| Streak first-of-day cell | `presets.signaturePop` + fill tween `tween('base','standard')` |
| Row hover actions | `presets.rowActions`; instant on `:focus-within` in CSS |
| Row menu | `presets.popover('top')` (no row stagger) |
| Delete row | `presets.rowDelete` inside `RealHeight` (closing uses `SPRING.exit`) |
| Undo highlight | `$violet-soft` instantly, hold `HOLD.highlight`, fade `tween('moderate','out')` |
| Empty Recent becomes empty | `<BlurWords variant="title" />` |
| Loading placeholders | Only after `HOLD.pendingDelay`; swap with `presets.rowInsert` |
| Hand-off variant | `presets.handoffTile` with `custom={{ i, blur: i < 3 }}` |

### 4.4 Mic picker (title-bar chip + popover; `hub/TitleBar.tsx` or `hub/Settings.tsx` (mic tile))

| Spec | Foundation |
|---|---|
| Chip hover / press | `.m-hover`, `presets.press('button')` |
| Popover open / close | `presets.popover('top', { blur: true })`, origin top-right; exit is inert via `useExitInert` |
| Radio | `<Indicator layoutId="mic-radio" transition={SPRING.snappy} />` |
| Chip device name | `<BlurWords variant="label" animateWidth text={device} />` |
| Hot-plug add / remove | Coalesce with `HOLD.devicesSettle`; `<RealHeight open={present} content={presets.rowInsert}>` |
| "Disconnected" notice | `RealHeight` + `<BlurWords variant="block" />`; `presets.ring('dot')` on the chip dot when closed |
| Level dot | `SPRING.meter` on scale and opacity (needs the idle level monitor, §6.5 #7) |

### 4.5 Permission banners (`hub/DictationScreen.tsx` or the banner component)

`<RealHeight open={show} content={presets.bannerContent} initial={false}>`. The message is `<BlurWords variant="block" />`; the buttons are `variant="label"` + `animateWidth`. Granted: icon → `presets.popIn` check, colour tweens `tween('base','standard')`, `presets.ring()`, hold `HOLD.bannerSuccess`, then `open=false`. Defer while hidden (`useDocumentVisible`).

### 4.6 Onboarding & permissions (`hub/Permissions.tsx`, onboarding (new))

| Spec | Foundation |
|---|---|
| Entrance | `presets.onboardingTile` with `custom={{ start, blur }}` (hero 0/8, step 1 0.12/6, step 2 0.15/4); headline `<BlurWords variant="headline" delay={0.1} text="Two switches, then talk." />` (33 ms); tracker rows `presets.fadeUpStagger({ start: 0.16, duration: DUR.fast })` |
| Status chip | `RealWidth` + colour tweens; label `variant="label"`; `presets.chipIn`; waiting dot `presets.pulse` |
| Granted flip (one-shot) | `useAnimate` sequence: chip check `presets.signaturePop` + `checkStroke`; `ring()` at 40; step card ⇄ row `RealHeight`-style real height on `SPRING.morph` at 200; body `block`; focus moves at 200 |
| Done "You're set." | Headline swap: change `text` on the same `<BlurWords variant="headline">` (old words exit together, new at +80 ms, delayed-start rule) |
| Try-it tile + live text | `presets.onboardingTile`; live text `<BlurStream text={partial} />` (user content) |
| Hand-off to Home | `<MorphContainer layoutId="hero-hold-fn" contentKey=…>` on `SPRING.morph`; headline diff "Hold fn and say hello." → "Hold fn to talk." with `BlurStream` (or `layout="position"` on the kept words); bento `presets.handoffTile` |

### 4.7 Settings (`hub/Settings.tsx`)

| Spec | Foundation |
|---|---|
| Pane switch | `<Indicator layoutId="pane-active" />` + `<PresenceSwap variants={presets.paneSwitch} custom={dir}>`; header `variant="titleUnit"` |
| Toggle | Knob `x` on `SPRING.snappy`, squash width 20 → 24 on `SPRING.snap` at pointerdown; track colour via CSS `--dur-fast --ease-standard` |
| Select | `presets.selectInPlace` (origin = selected row centre) |
| KeyRecorder | Placeholder `label`; dot `popIn` → `pulse`; keycaps `presets.chipIn`-like with `scale.exitIcon` + `staggerDelay(i, STAGGER.list)` |
| Bind-failed warning | `RealHeight` + `variant="block"` |
| Languages | Check badge `presets.popIn`; filter `presets.filterOut` + `layout="position"`; > 24 changes → instant |
| Speech models | Action slot `animate={{ width, height, borderRadius }}` on `SPRING.ui`; percent `<BlurNumber size="subtle" />`; "In use" `<Indicator layoutId="model-in-use" />`; reorder `layout="position"` |
| AI cleanup, Calendar, About | `label` / `block` swaps, `RealHeight` result rows, check `popIn` |

### 4.8 Snippets & Transforms + dialogs (`hub/SnippetsScreen.tsx`, `hub/TransformsScreen.tsx`)

| Spec | Foundation |
|---|---|
| Dialog from a button | `<AnimatePresence mode="sync">` with `presets.dialog.scrim` + `presets.dialog.content` (content layer is a sibling of the glass); `transform-origin` = trigger centre; title `variant="titleUnit"`; focus to the first field at t = 0 and back to the trigger on close |
| Dialog from a card | `<MorphContainer layoutId={`transform-${id}`} contentKey={open ? 'dialog' : 'card'} closing={!open}>` |
| Conditional fields | `RealHeight` |
| Preview block | `<BlurStream text={preview} catchUpStart={0} />` (user content) + spinner after `HOLD.pendingDelay` |
| Row / card insert, update, delete | `RealHeight` + `presets.rowInsert`; highlight hold; `presets.rowDelete` / `presets.cardDelete`; grid `layout="position"` |
| Transform card hover | `whileHover={{ y: -DIST.xs }}` on `SPRING.snappy`, `::after` elevation opacity; `presets.press('card')` |
| Empty state | `variant="title"` heading, `variant="block"` body at 0.12 |
| Promo dot | `presets.ring('promo')` (3 cycles), replacing the infinite CSS pulse |

### 4.9 Scratchpad (`src/renderer/src/scratchpad/Scratchpad.tsx`, `main.tsx`; `src/main/index.ts`)

| Spec | Foundation |
|---|---|
| Window open (card in the transparent window) | `m.div` with opacity `tween('fast')`, `y DIST.md` + `scale 0.97` on `SPRING.fluid`, `blur(4)` `tween('base')`, gated on `useWindowShown` |
| Close handshake | Main: `show:false` + `ready-to-show`, intercept `close` → `pad:will-close {seq}` → renderer exit (`DUR.fast`, `scale 0.98`, `blur(4)`) → `pad:closed {seq}`, with a `HOLD.closeTimeout` fallback. Reduce Motion: answer at once |
| Tabs | Width via `RealWidth`/real width on `SPRING.ui`; `<Indicator layoutId="pad-tab" />`; editor `presets.crossFade` |
| Notes list | `<Indicator layoutId="pad-note-active" transition={SPRING.snappy} />`; filters `layout="position"` |
| Voice note reveal | An overlay `<BlurWords variant="body" userContent delay={0.12} text={note} />` positioned over the editor (editor text transparent), removed on settle or first input. **Never write spans into the contentEditable** |
| Autosave, word count | `variant="label"`, `<BlurNumber size="subtle" />` |
| Copy all | Icon swap `label`-style + `presets.popIn`, hold `HOLD.copied` |

### 4.10 Toasts (wherever the hub toast lives; today `hub/App.tsx`)

`<AnimatePresence mode="popLayout" custom={replacing ? 'replace' : undefined}>` with `presets.toast` keyed by toast id. Hold `HOLD.notice`, paused on hover, focus-within, window blur and hidden.

### 4.11 Menus, popovers and tooltips (all hub files)

`presets.popover(origin)`, `presets.selectInPlace`, `presets.tooltip` after `HOLD.tooltipDelay` (instant within `HOLD.tooltipGrace`). Rows never stagger; highlight is instant; context menus opened from the keyboard are instant (`inputModality() === 'keyboard'`).

### 4.12 Todos (`src/renderer/src/todos/Todos.tsx`, `DatePicker.tsx`, `main.tsx`; `src/main/index.ts`, `edge.ts`)

| Spec | Foundation |
|---|---|
| Dwell 350 ms | `HOLD.dwell` → `DWELL_MS` in main (`EdgeDwell`) |
| Panel open | Content layer: `x −24 → 0` on `SPRING.fluid`, opacity `tween('fast')`, `blur(8) → 0` `tween('base')`; items `presets.fadeUpStagger({ y: DIST.sm, step: STAGGER.tight, cap: 6, start: 0.03, duration: DUR.micro })` |
| Close handshake | `todos:will-close` / `todos:closed` / `todos:cancel-close` with `closeSeq`, plus the `HOLD.closeTimeout` fallback in main |
| Composer, autocomplete | `RealHeight`; `presets.autocomplete`; token `presets.chipIn` |
| Date picker | `presets.popover`; `presets.monthSwap` with `custom={dir}` (instant after 2 clicks within `HOLD.spamWindow`); `<Indicator layoutId="dp-selected" transition={SPRING.snappy} />` |
| Check / uncheck | Fill `presets.popIn`; strike `scaleX` `tween('base')`; hold `HOLD.todoCheck`; move with `RealHeight` |
| Drag reorder | `Reorder` from `motion/react` or `drag`: lift `SCALE.lift` on `SPRING.snappy`, siblings `layout="position"` `SPRING.ui`, release on `SPRING.gesture` |
| Groups, Completed, Clear | Chevron `SPRING.snappy`; `RealHeight`; Clear `presets.rowDelete` with reverse `STAGGER.list` |
| Counts | `<BlurNumber />` |
| "All clear." | `<BlurWords variant="title" delay={0.1} />` |

### 4.13 Global micro-interactions

Hover: `.m-hover` (60 ms in, 160 ms out). Press: `presets.press(kind)`. Focus rings: never animated. Disabled ↔ enabled: `STATE_FADE`. Selection: `Indicator` + `SPRING.snappy`. Loops: `presets.pulse`, `presets.spin` and `LOOP.indeterminate` only.

---

## 5. Usage cheatsheet

```tsx
import { BlurWords, BlurStream, StreamViewport, BlurNumber, formatTimer, RealHeight,
  Indicator, PresenceSwap, MorphBox, presets, SPRING, FLOWBAR } from '@/shared/motion'
import { m, AnimatePresence, LayoutGroup } from 'motion/react'

<BlurWords as="h1" variant="headline" delay={0.08}
  parts={['Hold', { node: <Keycap>fn</Keycap>, text: 'fn' }, 'to talk.']} />
<BlurWords variant="label" animateWidth text={stageLabel} />          // swaps on change only
<StreamViewport height={48}><BlurStream text={partial} final={done} ariaHidden ref={streamRef} /></StreamViewport>
<BlurNumber value={wordsToday} />                                        // ≥ 32 px picks the large variant
<BlurNumber value={secs} format={formatTimer} size="subtle" />
<RealHeight open={showBanner} content={presets.bannerContent}>…</RealHeight>
<PresenceSwap swapKey={route} variants={presets.routeSwitch} custom={dir}>…</PresenceSwap>
<MorphBox box={FLOWBAR.shape[state]} transition={SPRING.morph} />
<AnimatePresence>{open && <m.div variants={presets.popover('top')} initial="initial" animate="animate" exit="exit" />}</AnimatePresence>
```

Rules worth repeating: blur only words, tiles and small surfaces, never pages; never animate a `backdrop-filter` element or its ancestor; one per-word headline in flight per window; at most 12 live filters per window (the budget enforces this for words and digits; Motion-driven element blurs count toward it too, so keep tile blurs to the first 4); everyday ≤ 250 ms, signature ≤ 600 ms.

## 6. Open items for the integration pass

1. Build `useLevel.ts` (rAF level engine, §4.1.5) and the Reduce Motion static 5-segment meter.
2. The Flow Bar state reducer and the click-through window spike (§4.1.1 step 8), before any bar motion.
3. `win:shown`, `--reduce-motion`, `firstShowDone` and the close handshakes in `src/main` + preload (G2–G6).
4. Verify on Electron ≥ 38.2 (§6.1) and on a ProMotion display; VoiceOver pass for the headline twin and the bar status region.
5. Motion-driven element blurs (dialog, toast, tiles) don't draw from `filterBudget` today. If a screen ever stacks them with live words, gate them with `largeSurfaceBudget` / `filterBudget.take()` before choosing the variant with or without blur.
