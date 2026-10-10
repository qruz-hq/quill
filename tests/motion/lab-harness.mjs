// Usage: node tests/motion/serve-lab.mjs &  then
//   PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs [CHROMIUM=/path/to/chrome] node tests/motion/lab-harness.mjs
// Exits 1 on any failed check. Prints frame timing, main-thread cost, filter peaks.
const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? 'playwright-core')
const URL = 'http://127.0.0.1:5199/motion-lab.html'
const results = {}
const fail = []
const check = (name, cond, detail) => { if (!cond) fail.push(`${name}: ${JSON.stringify(detail)}`) }

const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}) })

async function open(reduced) {
  const ctx = await browser.newContext({ reducedMotion: reduced ? 'reduce' : 'no-preference', viewport: { width: 1100, height: 1100 } })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(m.text()) })
  await page.goto(URL)
  await page.waitForFunction(() => !!window.__lab)
  await page.waitForTimeout(800)
  return { page, ctx, errors }
}

/* ---------- A: streaming diff behaviour ---------- */
{
  const { page, ctx, errors } = await open(false)
  const a = await page.evaluate(async () => {
    const L = window.__lab, sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const q = () => Array.from(document.querySelectorAll('[data-lab="stream"] .bw-word'))
    const toks = () => Array.from(document.querySelectorAll('[data-lab="stream"] .bw-tok')).map((e) => e.textContent)
    const nonCss = (el) => el.getAnimations().filter((x) => !(x instanceof CSSTransition))
    const props = (el) => nonCss(el).map((x) => Object.keys(x.effect.getKeyframes()[0]).filter((k) => ['opacity', 'filter', 'transform'].includes(k)).join('+')).sort()
    const r = {}
    L.setPartial('I wanted to meat you at the the cafe'); await sleep(700)
    const first = q(); const meat = first.find((e) => e.textContent === 'meat'); const wanted = first[1]; const cafe = first.find((e) => e.textContent === 'cafe')
    r.firstUnconfirmed = q().filter((e) => e.classList.contains('bw-unconf')).length
    // substitution + deletion in one partial
    L.setPartial('I wanted to meet you at the cafe on')
    await sleep(16)
    const meet = q().find((e) => e.textContent === 'meet')
    r.subSameNode = meet === meat
    r.subProps = props(meet)
    r.settledUntouched = nonCss(wanted).length
    r.tokensDuringExit = toks()
    r.exitingTok = Array.from(document.querySelectorAll('[data-lab="stream"] .bw-tok')).filter((t) => nonCss(t).length).map((t) => t.textContent)
    const allToks = Array.from(document.querySelectorAll('[data-lab="stream"] .bw-tok'))
    const exIdx = allToks.findIndex((t) => nonCss(t).length)
    const nb = allToks[exIdx + 1]?.querySelector('.bw-word')
    r.neighbourWord = nb?.textContent
    r.neighbourProps = nb ? props(nb) : []
    r.insertProps = props(q().find((e) => e.textContent === 'on'))
    r.confirmed = q().filter((e) => !e.classList.contains('bw-unconf')).map((e) => e.textContent).join(' ')
    await sleep(400)
    r.tokensAfter = toks()
    L.setFinal(true); await sleep(600)
    r.unconfAfterFinal = q().filter((e) => e.classList.contains('bw-unconf')).length
    r.restFilter = q().filter((e) => getComputedStyle(e).filter !== 'none').length
    r.restTransform = q().filter((e) => getComputedStyle(e).transform !== 'none').length
    r.restWordAnims = q().reduce((n, e) => n + nonCss(e).length, 0)
    r.budget = L.budgetInUse()
    r.text = document.querySelector('[data-lab="stream"]').textContent
    return r
  })
  results.streaming = a
  check('substitution keeps node', a.subSameNode, a)
  check('substitution re-blurs without y', a.subProps.join() === 'filter,opacity', a.subProps)
  check('settled word untouched', a.settledUntouched === 0, a.settledUntouched)
  check('deleted token exits with separator', a.exitingTok.length === 1 && a.exitingTok[0] === ' the', a.exitingTok)
  check('neighbour re-blur', a.neighbourProps.join() === 'filter,opacity', a.neighbourProps)
  check('insert enters with y', a.insertProps.join() === 'filter,opacity,transform', a.insertProps)
  check('deleted token removed', a.tokensAfter.join('') === 'I wanted to meet you at the cafe on', a.tokensAfter)
  check('final confirms all', a.unconfAfterFinal === 0, a)
  check('rest filter none', a.restFilter === 0 && a.restTransform === 0, a)
  check('budget released', a.budget === 0, a.budget)
  check('text reads once', a.text === 'I wanted to meet you at the cafe on', a.text)

  /* ---------- B: frame time, ~40 words ---------- */
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Performance.enable')
  const metric = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]))
  const m0 = await metric()
  results.frames300 = await page.evaluate(() => window.__lab.measure(300, false))
  const m1 = await metric()
  results.mainThread300 = {
    scriptMsPerFrame: +(((m1.ScriptDuration - m0.ScriptDuration) * 1000) / results.frames300.frames).toFixed(3),
    taskMsPerFrame: +(((m1.TaskDuration - m0.TaskDuration) * 1000) / results.frames300.frames).toFixed(3),
    layoutMsPerFrame: +(((m1.LayoutDuration - m0.LayoutDuration) * 1000) / results.frames300.frames).toFixed(3)
  }
  results.frames100 = await page.evaluate(() => window.__lab.measure(100, false))
  results.filters = await page.evaluate(() => window.__lab.measure(100, true))
  results.wordCount = await page.evaluate(() => window.__lab.streamSpans())
  check('~40 words', results.wordCount >= 40, results.wordCount)
  check('filter cap 12', results.filters.maxFilters <= 12, results.filters)

  /* ---------- E: headline + digits ---------- */
  results.words = await page.evaluate(async () => {
    const L = window.__lab, sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const h1 = document.querySelector('h1')
    L.replayHeadline(); await sleep(30)
    const h = document.querySelector('h1')
    const words = Array.from(h.querySelectorAll('.bw-word'))
    const r = {
      headlineTokens: words.map((w) => w.textContent),
      headlineAnimating: words.filter((w) => w.getAnimations().length).length,
      srText: h.querySelector('.m-sr-only')?.textContent,
      ariaHidden: h.querySelector('.bw')?.getAttribute('aria-hidden'),
      delays: words.map((w) => w.getAnimations()[0]?.effect.getTiming().delay)
    }
    await sleep(900)
    r.headlineRestFilter = Array.from(h.querySelectorAll('.bw-word')).filter((w) => getComputedStyle(w).filter !== 'none').length
    // digits: 9,998 → 9,999 (1 glyph) then → 10,000 (width change)
    const num = () => Array.from(document.querySelectorAll('h1 ~ *, section')).map(() => 0) && document.querySelectorAll('section')[2].querySelector('.bn')
    L.bump(1); await sleep(200); await sleep(16)
    const bn = num()
    r.digitsBefore = bn.querySelector('.bn-glyphs').textContent
    const w0 = bn.getBoundingClientRect().width
    L.bump(1); await sleep(140)
    r.changedGlyphsAnimating = Array.from(bn.querySelectorAll('.bn-glyph')).filter((g) => g.getAnimations().length).map((g) => g.textContent + (g.hasAttribute('data-exiting') ? '(out)' : '(in)'))
    r.wrapperWidthAnimating = bn.getAnimations().length
    await sleep(700)
    r.digitsAfter = bn.querySelector('.bn-glyphs').textContent
    r.sr = bn.querySelector('.m-sr-only').textContent
    r.widthGrew = bn.getBoundingClientRect().width > w0
    r.digitRestFilter = Array.from(bn.querySelectorAll('.bn-glyph')).filter((g) => getComputedStyle(g).filter !== 'none').length
    return r
  })
  check('headline per word', results.words.headlineAnimating >= 3, results.words)
  check('headline sr twin', results.words.ariaHidden === 'true' && !!results.words.srText, results.words)
  check('digits rest', results.words.digitRestFilter === 0 && results.words.headlineRestFilter === 0, results.words)

  /* ---------- C: interrupted bursts don't leak budget ---------- */
  results.leak = await page.evaluate(async () => {
    const L = window.__lab, sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const words = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon'.split(' ')
    for (let i = 0; i < 50; i++) {
      L.setFinal(false)
      L.setPartial(words.slice(0, 2 + (i % 18)).join(' ') + (i % 3 ? ' tail' + i : ''))
      await sleep(20 + (i % 4) * 15)
      if (i % 10 === 9) { L.setPartial(''); await sleep(10) }
    }
    await sleep(1200)
    const midBudget = L.budgetInUse()
    L.setPartial('still blurs after bursts'); await sleep(30)
    const blurring = Array.from(document.querySelectorAll('[data-lab="stream"] .bw-word')).filter((e) => getComputedStyle(e).filter !== 'none').length
    await sleep(800)
    return { budgetAfterBursts: midBudget, blurringAfter: blurring, budgetEnd: L.budgetInUse() }
  })
  check('no leaked budget after 50 bursts', results.leak.budgetAfterBursts === 0 && results.leak.budgetEnd === 0, results.leak)
  check('words still blur after bursts', results.leak.blurringAfter > 0, results.leak)

  /* ---------- D2: live toggle to reduced mid-stream ---------- */
  results.liveToggle = await page.evaluate(async () => {
    const L = window.__lab, sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    L.setFinal(false); L.setPartial(''); await sleep(30)
    L.runStream(200)
    await sleep(500)
    L.setReduced(true)
    await sleep(50)
    const r = {
      spans: document.querySelectorAll('[data-lab="stream"] .bw-word').length,
      anims: document.getAnimations().length,
      chip: document.querySelector('[data-lab="reduced"]').textContent
    }
    await sleep(800)
    r.animsLater = document.getAnimations().length
    L.setReduced(null)
    await sleep(2200)
    return r
  })
  check('live toggle → plain text, no animations', results.liveToggle.spans === 0 && results.liveToggle.anims === 0 && results.liveToggle.animsLater === 0, results.liveToggle)
  results.errorsMotion = errors
  await ctx.close()
}

/* ---------- E: label real width, StrictMode catch-up, live toggle settles Motion springs ---------- */
{
  const { page, ctx, errors } = await open(false)
  results.width = await page.evaluate(async () => {
    const L = window.__lab, sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const frame = () => new Promise((r) => requestAnimationFrame(() => r()))
    const root = () => document.querySelector('[data-lab="label"] .bw-root')
    const widthAnim = () => root().getAnimations().find((a) => 'width' in a.effect.getKeyframes()[0])
    const px = (v) => parseFloat(v)
    const w0 = root().getBoundingClientRect().width
    L.swapLabel(); await frame(); await frame()
    const a = widthAnim()
    const kf = a ? a.effect.getKeyframes().map((k) => px(k.width)) : null
    await sleep(60)
    const mid = root().getBoundingClientRect().width
    // Interrupt: the second swap starts from the width on screen.
    L.swapLabel(); await frame(); await frame()
    const b = widthAnim()
    const kf2 = b ? b.effect.getKeyframes().map((k) => px(k.width)) : null
    await sleep(700)
    return {
      w0, kf, mid, kf2, duration: a?.effect.getTiming().duration,
      restAnims: root().getAnimations().length, restWidth: root().getBoundingClientRect().width, inline: root().style.width
    }
  })
  {
    const w = results.width
    check('label width animates old → new', !!w.kf && Math.abs(w.kf[0] - w.w0) < 0.6 && Math.abs(w.kf[1] - w.kf[0]) > 2, w)
    check('label width is mid-flight', !!w.kf && w.mid > Math.min(...w.kf) && w.mid < Math.max(...w.kf), w)
    check('label width interrupt starts from the current width', !!w.kf2 && !!w.kf && w.kf2[0] > Math.min(...w.kf) && w.kf2[0] < Math.max(...w.kf), w)
    check('label width rests at auto', w.restAnims === 0 && w.inline === '' && !!w.kf2 && Math.abs(w.restWidth - w.kf2[1]) < 0.6, w)
  }

  results.strictMount = await page.evaluate(async () => {
    const L = window.__lab, sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const q = () => Array.from(document.querySelectorAll('[data-lab="stream"] .bw-word'))
    const nonCss = (el) => el.getAnimations().filter((x) => !(x instanceof CSSTransition))
    L.setPartial(''); await sleep(50)
    L.remountStream('one two three four five six')
    await sleep(40)
    const r = { words: q().length, unconfirmed: q().filter((e) => e.classList.contains('bw-unconf')).length, animating: q().filter((e) => nonCss(e).length).length }
    await sleep(700)
    r.restAnims = q().reduce((n, e) => n + nonCss(e).length, 0)
    r.budget = L.budgetInUse()
    return r
  })
  check('StrictMode mount with text: nothing confirmed by the second effect run', results.strictMount.words === 6 && results.strictMount.unconfirmed === 6, results.strictMount)
  check('StrictMode mount with text: catch-up reveal runs', results.strictMount.animating === 6 && results.strictMount.restAnims === 0 && results.strictMount.budget === 0, results.strictMount)

  results.settle = await page.evaluate(async () => {
    const L = window.__lab, sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const ind = () => document.querySelector('nav [data-projection-id], nav button > div, nav button > span')
    const box = () => { const r = ind().getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 10) / 10) }
    const running = () => document.getAnimations().filter((a) => a.playState === 'running' && a.effect.getTiming().iterations !== Infinity).length
    L.setNav(0); await sleep(700)
    const from = box()
    L.setNav(3); await sleep(50)
    const mid = box()
    L.swapLabel(); L.bump(137)
    await new Promise((r) => requestAnimationFrame(() => r()))
    const runningBefore = running()
    L.setReduced(true)
    // Same task: every spring and WAAPI animation must already be at rest.
    const at0 = box(), running0 = running()
    await sleep(600)
    const rest = box(), runningRest = running()
    L.setReduced(null)
    await sleep(100)
    return { from, mid, at0, rest, runningBefore, running0, runningRest }
  })
  {
    const s = results.settle
    check('live toggle: a spring was in flight', s.mid.join() !== s.from.join() && s.mid.join() !== s.rest.join() && s.runningBefore > 0, s)
    check('live toggle: Motion spring lands at once', s.at0.join() === s.rest.join(), s)
    check('live toggle: no running animation left', s.running0 === 0 && s.runningRest === 0, s)
  }
  results.errorsE = errors
  check('no console errors (E)', errors.length === 0, errors)
  await ctx.close()
}

/* ---------- F: first-show gate (useWindowShown store) ---------- */
{
  const MOD = '/src/shared/motion/windowShown.ts'
  // stub: false = plain browser, 'legacy' = onShown only, 'null' / 'shown' = with the synchronous win.shown()
  const probe = async (stub, fireAt) => {
    const ctx = await browser.newContext({ viewport: { width: 400, height: 300 } })
    const page = await ctx.newPage()
    if (stub) await page.addInitScript((stub) => {
      const win = { onShown: (cb) => { window.__fireShown = () => cb({ first: true }); return () => {} } }
      if (stub === 'null') win.shown = () => null
      if (stub === 'shown') win.shown = () => ({ first: false })
      window.flow = { win }
    }, stub)
    await page.goto(URL)
    await page.waitForFunction(() => !!window.__lab)
    const r = await page.evaluate(async ({ MOD, fireAt }) => {
      const m = await import(/* @vite-ignore */ MOD)
      const t0 = performance.now()
      let at = null
      m.whenWindowShown(() => { at = Math.round(performance.now() - t0) })
      const sync = at
      if (fireAt != null) setTimeout(() => window.__fireShown(), fireAt)
      await new Promise((r) => setTimeout(r, 500))
      let late = null
      m.whenWindowShown(() => { late = true })
      return { sync, at, late }
    }, { MOD, fireAt })
    await ctx.close()
    return r
  }
  results.shown = {
    browser: await probe(false, null), main: await probe('legacy', 100), fallback: await probe('legacy', null),
    syncShown: await probe('shown', null), syncNull: await probe('null', null), syncNullEvent: await probe('null', 400)
  }
  const s = results.shown
  check('shown: plain browser is visible at once', s.browser.sync === 0, s)
  check('shown: Electron waits for win:shown', s.main.sync === null && s.main.at >= 100 && s.main.at < 200, s)
  check('shown: backstop after hold.closeTimeout', s.fallback.sync === null && s.fallback.at >= 295 && s.fallback.at < 400, s)
  check('shown: already shown is true at once', s.main.late === true && s.fallback.late === true, s)
  check('shown: win.shown() non-null is shown at once', s.syncShown.sync === 0, s)
  check('shown: win.shown() null outlasts hold.closeTimeout', s.syncNull.at === null && s.syncNull.late === null, s)
  check('shown: win.shown() null, late win:shown still lands', s.syncNullEvent.sync === null && s.syncNullEvent.at >= 400 && s.syncNullEvent.at < 500, s)
}

/* ---------- D: Reduce Motion = instant ---------- */
{
  const { page, ctx, errors } = await open(true)
  results.reduced = await page.evaluate(async () => {
    const L = window.__lab, sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    let maxAnims = 0, maxFilters = 0, maxSpans = 0, running = true
    const loop = () => {
      maxAnims = Math.max(maxAnims, document.getAnimations().length)
      maxFilters = Math.max(maxFilters, window.__lab.filterCount())
      maxSpans = Math.max(maxSpans, document.querySelectorAll('.bw-word, .bw-unit, .bn-glyph').length)
      if (running) requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
    L.replayHeadline(); L.swapHeadline(); L.bump(3)
    await L.runStream(150)
    L.bump(1000)
    await sleep(400)
    running = false
    return {
      maxAnims, maxFilters, maxSpans,
      text: document.querySelector('[data-lab="stream"]').textContent,
      headline: document.querySelector('h1').textContent,
      htmlAttr: document.documentElement.hasAttribute('data-reduce-motion')
    }
  })
  const r = results.reduced
  check('reduced: zero animations', r.maxAnims === 0, r)
  check('reduced: zero filters', r.maxFilters === 0, r)
  check('reduced: no word spans', r.maxSpans === 0, r)
  check('reduced: full text', r.text.endsWith('exact timing.'), r.text)
  results.errorsReduced = errors
  await ctx.close()
}

await browser.close()
results.failures = fail
console.log(JSON.stringify(results, null, 2))
process.exit(fail.length ? 1 : 0)
