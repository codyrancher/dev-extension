// Recording template - copy to /workspace/videos/ and customise.
//
// Usage:
//   cp .claude/skills/my-browser-record-video/record-template.mjs videos/record-my-demo.mjs
//   cp .claude/skills/my-browser-record-video/overlay.mjs        videos/overlay.mjs
//   # edit RANCHER, OUT, and the "Recorded actions" section
//   node videos/record-my-demo.mjs

import { chromium } from 'playwright-core';
import { promises as fs } from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import { installOverlay } from './overlay.mjs';

const CDP = process.env.CLAUDE_BROWSER_CDP || 'http://localhost:9222';
const RANCHER_HOST = process.env.RANCHER_HOST_NAME;        // e.g. <project>-rancher
const RANCHER = `https://127.0.0.1:8005`;                  // dev server, or `https://${RANCHER_HOST}` for stock
const OUT = '/workspace/videos/demo.webm';
const FRAME_DIR = `/tmp/screencap-${Date.now()}`;
// Rate the capture loop *aims* for. What gets encoded is the rate frames
// actually arrived at (see ENCODE below) - a screenshot that takes longer than
// the interval, or a busy page, changes the real rate, and encoding a fixed
// number against a different real one is what makes a video play in slow
// motion or double speed.
const TARGET_FPS = 30;

// Token for /v1 API calls during the recording (resource creation, feature
// toggles, etc.). If you're not mutating Rancher, you can skip this.
let TOKEN = '';
try { TOKEN = execSync('cat /tmp/rancher-token.txt', { encoding: 'utf8' }).trim(); } catch {}

const browser = await chromium.connectOverCDP(CDP);
const ctx = browser.contexts()[0] || await browser.newContext();
const page = await ctx.newPage();
await page.setViewportSize({ width: 1280, height: 720 });

// --- Login (off-camera) -----------------------------------------------------
await page.goto(`${RANCHER}/auth/login`, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.locator('[data-testid="login-submit"]').waitFor({ state: 'visible', timeout: 20000 });
await page.locator('[data-testid="local-login-username"]').fill('admin');
await page.locator('[data-testid="local-login-password"] input').fill('<password>');
await page.locator('[data-testid="login-submit"]').click();
await page.waitForURL(u => !u.pathname.includes('/auth/login'), { timeout: 15000 });

// --- Navigate to target page (off-camera) ------------------------------------
// await page.goto(`${RANCHER}/c/local/explorer/...`, { waitUntil: 'domcontentloaded', timeout: 60000 });
// await page.locator('...').waitFor({ state: 'visible', timeout: 30000 });

// --- Install overlays (URL bar, cursor, click ripples, keystroke badges, highlights, banners)
await page.evaluate(installOverlay);
await ctx.addInitScript(installOverlay);
page.on('load', async () => { try { await page.evaluate(installOverlay); } catch {} });

// --- Frame capture (polled screenshot, with pause/resume) -------------------
// Polled `page.screenshot` is more resilient than CDP `Page.startScreencast`:
// it survives SPA navigations, full page reloads, and even Rancher backend
// restarts (where the page hangs for several seconds). The trade-off is
// slightly higher CPU; at 30fps and quality:80 jpegs this is fine.
//
// The `recording` flag lets you pause frame capture during long off-camera
// transitions (state changes, backend restarts) so they don't show up as dead
// air. Frames already captured stay; new ones aren't written while paused.
//
// `busy` is a re-entrancy guard: page.screenshot can take longer than the
// interval, and without it setInterval stacks overlapping captures, quietly
// dropping the real capture rate while the encode rate stays where you left
// it. `recordedMs` accumulates only the time frames were actually being
// written, so a paused section does not get counted as capture time.
await fs.mkdir(FRAME_DIR, { recursive: true });
let frame = 0;
let recording = false;
let busy = false;
let recordedMs = 0;
let lastCapture = 0;
const captureTimer = setInterval(async () => {
  if (!recording || busy) return;
  busy = true;
  try {
    const buf = await page.screenshot({ type: 'jpeg', quality: 80 });
    await fs.writeFile(`${FRAME_DIR}/f${String(frame++).padStart(6, '0')}.jpg`, buf);
    const now = Date.now();
    // Count the gap, capped - never drop the time while keeping the frame.
    // A screenshot slower than the cap used to contribute a frame worth zero
    // milliseconds, which inflates frame/recordedMs and encodes the video fast.
    // The cap is what keeps a paused section from being counted as capture
    // time; it costs at most one cap's worth of slack per pause boundary.
    if (lastCapture) recordedMs += Math.min(now - lastCapture, 500);
    lastCapture = now;
  } catch {} finally { busy = false; }
}, Math.round(1000 / TARGET_FPS));

// --- Helpers ----------------------------------------------------------------
// This file is the standalone fallback for when you cannot go through
// `browser.mjs record-script`. It reimplements the same input model: seeded
// randomness, interpolated pointer motion, human keystroke cadence, and holds
// derived from reading time. Prefer record-script, which gives you all of this
// plus deferred capture and measured-fps encoding for free.
const sleep = (ms) => new Promise(r => setTimeout(r, Math.max(0, ms)));

// Seeded so a rerun of this script produces the same video.
let __seed = (Number(process.env.RECORD_SEED) || 0xC0FFEE) >>> 0;
function rand() {
  __seed = (__seed + 0x6D2B79F5) >>> 0;
  let t = __seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const rnd = (a, b) => a + rand() * (b - a);
const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

// Minimum-jerk reach profile warped so peak velocity lands early: quick
// acceleration, long deceleration into the target, like a real hand.
const reachProfile = (t) => {
  const w = Math.pow(t, 0.85);
  return 10 * w ** 3 - 15 * w ** 4 + 6 * w ** 5;
};

// How long a viewer needs to read on-screen text. Use this instead of picking
// a number: a fixation cost plus a words-per-minute budget, floored so a short
// label still registers. The ceiling is a runaway guard, not a pacing knob: at
// 3000ms it silently cut every banner past eleven words, i.e. it broke exactly
// where there was most to read. Long text needs shorter text, not a shorter
// hold.
const READ_WARN_MS = 6500;   // beyond this, shorten the text
const PAUSE_WARN_MS = 1200;  // untied hold that is just sitting and waiting
function readingTime(text, opts = {}) {
  const { wpm = 250, base = 350, min = 650, max = 12000 } = opts;
  const words = (String(text ?? '').trim().match(/\S+/g) || []).length;
  const ms = Math.round(clamp(base + (words / wpm) * 60000, min, max));
  // The cap is a runaway guard, so it must not bite silently: warn well before
  // it, the way record-script's `say()` does, or a banner nobody can read in
  // time just quietly holds the frame for twelve seconds.
  if (ms > READ_WARN_MS && typeof text === 'string') {
    console.error(`readingTime(): "${text.slice(0, 40)}..." needs ${ms}ms to read. Shorten the text rather than holding the frame that long.`);
  }
  return ms;
}

// Interpolated pointer motion: a bowed, eased path made of many small steps,
// with an occasional overshoot and correction on longer travel. The cursor dot
// has no CSS position transition, so it lands on every step 1:1.
let ptr = { x: 640, y: 400 };
let primed = false;
// Held by whichever gesture owns the pointer, so the idle ramble stands aside
// instead of fighting it (and never lands a move between mousedown and mouseup).
let pointerBusy = 0;
let driftActive = false;
let rambleMoving = 0;
// Claiming the pointer is not instant: a ramble step can already be in flight
// over CDP and cannot be cancelled, only waited for. Without the drain a stray
// 1-2px ramble move lands between mousedown and mouseup, which is enough to
// read as a drag. Bounded, so a hung page delays a click rather than hanging it.
async function acquirePointer() {
  pointerBusy++;
  for (let i = 0; i < 40 && rambleMoving; i++) await sleep(5);
}
const releasePointer = () => { pointerBusy--; };
async function moveTo(x, y) { await page.mouse.move(x, y); ptr = { x, y }; primed = true; }

async function glide(tx, ty) {
  const from = { ...ptr };
  const dist = Math.hypot(tx - from.x, ty - from.y);
  if (!primed) await moveTo(from.x, from.y);
  if (dist < 1.5) { await moveTo(tx, ty); return; }
  const duration = clamp(180 + 0.6 * dist, 240, 800);
  const nx = -(ty - from.y) / dist, ny = (tx - from.x) / dist;
  const bow = Math.min(45, dist * rnd(0.05, 0.13)) * (rand() < 0.5 ? -1 : 1);
  const cx = (from.x + tx) / 2 + nx * bow, cy = (from.y + ty) / 2 + ny * bow;
  await acquirePointer();
  try {
    const t0 = Date.now();
    for (;;) {
      const raw = (Date.now() - t0) / duration;
      const t = raw >= 1 ? 1 : reachProfile(raw), u = 1 - t;
      await moveTo(u * u * from.x + 2 * u * t * cx + t * t * tx,
                   u * u * from.y + 2 * u * t * cy + t * t * ty);
      if (raw >= 1) break;
      await sleep(4);   // stepping is paced by the CDP round trip (~25ms), not by this
    }
  } finally { releasePointer(); }
  ptr = { x: tx, y: ty };
}

async function smoothMove(target, opts = {}) {
  if (typeof target.boundingBox === 'function') await scrollToSmooth(target);
  const box = typeof target.boundingBox === 'function' ? await target.boundingBox() : target;
  if (!box) throw new Error('smoothMove: target has no bounding box');
  const tx = box.x + (box.width ?? 0) / 2, ty = box.y + (box.height ?? 0) / 2;
  const dist = Math.hypot(tx - ptr.x, ty - ptr.y);
  if (dist > 220 && rand() < 0.45) {   // overshoot, then pull back
    const ux = (tx - ptr.x) / dist, uy = (ty - ptr.y) / dist, over = rnd(7, 18);
    await glide(tx + ux * over + rnd(-4, 4), ty + uy * over + rnd(-4, 4));
    await sleep(rnd(45, 95));
  }
  await glide(tx, ty);
  await sleep(opts.settle ?? rnd(60, 130));
}

// Travel to the target, settle, then press with a real dwell between mousedown
// and mouseup. Zero dwell is the tell that a machine clicked it.
async function moveAndClick(target, opts = {}) {
  await smoothMove(target, opts);
  await sleep(rnd(40, 100));
  // Playwright's actionability wait runs inside click() with the pointer
  // parked; do the visibility half out here with the ramble underneath, then
  // own the pointer for the press so nothing drags the cursor off the control
  // between mousedown and mouseup.
  await idle(() => target.waitFor({ state: 'visible', timeout: 10000 })).catch(() => {});
  await acquirePointer();
  try { await target.click({ delay: Math.round(rnd(55, 105)) }); } finally { releasePointer(); }
}

// Idle pointer motion is OFF by default. The ramble below ran under every hold
// so the cursor never sat still; in practice that reads as a pointer wandering
// in circles while nothing happens, pulling the eye away from the thing being
// demonstrated. Set `RECORD_CURSOR_RAMBLE=1` to bring it back.
//
// Nothing else depends on it: frames keep being emitted by the overlay's 1px
// rAF keepalive canvas, not by pointer motion, so a still cursor still gives a
// hold its full wall-clock length instead of a compressed one.
const IDLE_RAMBLE = /^(1|true|on|yes|ramble)$/i.test(process.env.RECORD_CURSOR_RAMBLE || '');

// What the ramble does when it is on: a hold that is not dead air - a heading
// that random-walks, a speed that never reaches zero, a pull back towards the
// resting point so the excursion stays inside ~15px. Constant-ish speed is the
// point: a step-and-hold drift, or a sum of sines with its zero-velocity
// moments, lands as runs of pixel-identical frames at capture rate, which is
// exactly the frozen video this exists to avoid.
//
// Everything random in here comes off `rambleRand`, never the main stream. The
// ramble is paced by the wall clock, so both how many iterations a hold runs
// and how many holds there are depend on machine timing; a draw from the main
// stream anywhere in this path would shift every gesture after it by an amount
// that depends on the machine, and "same script, same video" would be false.
const rambleRand = (() => {
  let a = ((rand() * 4294967296) >>> 0) >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})();

async function drift(shouldStop) {
  // Still cursor: leave the pointer where the last gesture put it and just wait
  // the caller out. Same contract as the ramble, so `pause` and `idle` behave
  // identically either way.
  if (!IDLE_RAMBLE) {
    while (!shouldStop()) await sleep(20);
    return;
  }
  // Another ramble owns the pointer: wait it out, then take over rather than
  // standing down for the rest of the caller's wait (that is how a phase with
  // no inner wait of its own ends up frozen).
  while (!shouldStop() && driftActive) await sleep(20);
  if (shouldStop()) return;
  driftActive = true;
  let warned = false;
  try {
    if (!primed) { try { await moveTo(ptr.x, ptr.y); } catch { /* reported below */ } }
    const lrnd = (a, b) => a + rambleRand() * (b - a);
    let home = { ...ptr };
    const speed = lrnd(35, 55), radius = lrnd(6.5, 9), turn = lrnd(1.8, 3.2);
    let ang = lrnd(0, Math.PI * 2), phase = lrnd(0, Math.PI * 2);
    let x = ptr.x, y = ptr.y;
    // One frame in the past, not "now": a first step with dt=0 re-emits the
    // position the pointer is already at, and that duplicate is a
    // pixel-identical frame pair at capture rate.
    let last = Date.now() - 16;
    while (!shouldStop()) {
      if (pointerBusy) {   // a gesture owns the pointer; resume from where it leaves it
        await sleep(15);
        x = ptr.x; y = ptr.y; home = { ...ptr }; last = Date.now() - 16;
        continue;
      }
      const now = Date.now(), dt = Math.min(0.12, (now - last) / 1000);
      last = now;
      ang += (rambleRand() * 2 - 1) * turn * dt;
      const ox = x - home.x, oy = y - home.y, r = Math.hypot(ox, oy);
      if (r > 0.5) {
        let diff = ((Math.atan2(-oy, -ox) - ang + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        ang += diff * Math.min(1, (r / radius) ** 2) * Math.min(1, 6 * dt);
      }
      phase += dt * 2.1;
      const v = speed * (1 + 0.22 * Math.sin(phase));
      x += Math.cos(ang) * v * dt; y += Math.sin(ang) * v * dt;
      // A move can be rejected mid-navigation. Say so once and keep the hold
      // alive: the caller's wait still has to finish, and a rejected ramble
      // would otherwise leave the rest of it frozen with nothing in the log.
      rambleMoving++;
      let failed = null;
      try { await moveTo(x, y); } catch (e) { failed = e; } finally { rambleMoving--; }
      if (failed) {
        if (!warned) { console.error(`drift(): pointer move failed (${failed.message}); retrying, this part of the hold has no motion.`); warned = true; }
        x = ptr.x; y = ptr.y; home = { ...ptr }; last = Date.now() - 16;
        await sleep(30);
        continue;
      }
      await sleep(4);
    }
  } finally { driftActive = false; }
}

async function pause(ms, opts = {}) {
  const total = Math.max(0, Math.round(ms));
  if (total <= 0) return;
  // A live cursor makes a hold look recorded; it does not make it earn its
  // place. Warn on a long beat with nothing to read and nothing loading, the
  // same way readingTime warns on text nobody can read in time. `{ ack: true }`
  // is the acknowledgement; `read()` holds are tied to text and never warn.
  if (total > PAUSE_WARN_MS && !opts.tied && !opts.ack) {
    console.error(`pause(): ${total}ms hold with nothing tied to it. Keep untied beats under ~${PAUSE_WARN_MS}ms, or pass { ack: true } if the frame really needs it.`);
  }
  // Under about three captured frames there is nothing to ramble through, and
  // a ramble that short would only fight a caller who is stepping the pointer
  // by hand between pauses.
  if (opts.still || total < 120) { await sleep(total); return; }
  const t0 = Date.now();
  await drift(() => Date.now() - t0 >= total);   // drift primes the pointer itself
}

// Run any other await (a locator wait, a navigation) with the drift going
// underneath it, so waiting on the UI does not freeze the cursor either.
async function idle(work) {
  let over = false;
  const task = (async () => { try { return await (typeof work === 'function' ? work() : work); } finally { over = true; } })();
  // drift handles a failing mouse move itself, so anything landing here is
  // unexpected: do not take the wait down with it, but do not swallow it
  // either - a silent catch is how the rest of a wait ends up frozen with
  // nothing in the log to explain it.
  const motion = drift(() => over).catch((e) => {
    console.error(`idle(): pointer ramble stopped (${e && e.message}); the rest of this wait is frozen.`);
  });
  const [result] = await Promise.all([task, motion]);
  return result;
}

// Scroll without teleporting. `scrollIntoViewIfNeeded` moves the page in a
// single rendered frame; a stream of CDP wheel events under an active capture
// arrives 40-140ms apart, which is the same jump in fewer pieces. Tweening in
// the page puts one eased step on every rendered frame.
async function scrollBySmooth(dy, opts = {}) {
  if (Math.abs(dy) < 8) return;
  await acquirePointer();
  try {
    await page.evaluate(({ x, y, delta, fixedDuration }) => new Promise((resolve) => {
      const scrollerFor = (el) => {
        for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
          const s = getComputedStyle(n);
          if (/(auto|scroll|overlay)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 4) return n;
        }
        return document.scrollingElement || document.documentElement;
      };
      const el = scrollerFor(document.elementFromPoint(x, y) || document.body);
      const prev = el.style.scrollBehavior;
      el.style.scrollBehavior = 'auto';
      const from = el.scrollTop;
      // Clamp to what the scroller can actually give BEFORE the tween starts.
      // Unclamped, a request past the end spends its whole deceleration half
      // pressed against the boundary: the steps accelerate and then simply
      // stop at peak velocity instead of arriving.
      const room = Math.max(0, el.scrollHeight - el.clientHeight);
      const d = Math.max(-from, Math.min(delta, room - from));
      if (Math.abs(d) < 1) { el.style.scrollBehavior = prev; return resolve(0); }
      const duration = fixedDuration ?? Math.max(380, Math.min(1600, 260 + 1.5 * Math.abs(d)));
      const t0 = performance.now();
      const ease = (t) => t < 0.5 ? 4 * t ** 3 : 1 - Math.pow(2 - 2 * t, 3) / 2;
      const step = () => {
        const t = Math.min(1, (performance.now() - t0) / duration);
        el.scrollTop = from + d * ease(t);
        if (t < 1) return requestAnimationFrame(step);
        el.style.scrollBehavior = prev; resolve(d);
      };
      requestAnimationFrame(step);
    }), { x: Math.round(ptr.x), y: Math.round(ptr.y), delta: dy, fixedDuration: opts.duration ?? null });
  } finally { releasePointer(); }
  await sleep(rnd(90, 170));
}

// Bring a locator into comfortable view by scrolling to it.
async function scrollToSmooth(locator, opts = {}) {
  const vp = page.viewportSize() || { width: 1280, height: 720 };
  const margin = opts.margin ?? 90;
  for (let i = 0; i < 3; i++) {
    const box = await locator.boundingBox({ timeout: 5000 }).catch(() => null);
    if (!box) { await locator.scrollIntoViewIfNeeded().catch(() => {}); return; }
    let dy = 0;
    if (box.y < margin) dy = box.y - margin;
    else if (box.y + box.height > vp.height - margin) dy = box.y + box.height - (vp.height - margin);
    if (Math.abs(dy) < 8) return;
    await scrollBySmooth(dy);
  }
}
// Tied to on-screen text by definition, so it never trips the untied warning.
const read = (textOrMs, opts = {}) =>
  pause(typeof textOrMs === 'number' ? textOrMs : readingTime(textOrMs, opts), { ...opts, tied: true });

// Character-by-character typing with human cadence: a beat before the first
// character lands (the hand finding the keys - not a longer gap after it,
// which reads as the *second* character lagging), the first few characters
// slightly slow before settling into a rhythm, longer gaps after spaces and
// punctuation, the odd think-pause. NEVER use .fill() during recording, it's
// instant and invisible.
async function smoothType(text, delayPerChar = 60) {
  const chars = [...String(text)];
  if (chars.length) await sleep(delayPerChar * rnd(0.9, 1.6));
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    await page.keyboard.type(ch);
    if (i === chars.length - 1) break;
    const warmup = i < 3 ? 1.3 - 0.1 * i : 1;
    let d = delayPerChar * rnd(0.55, 1.5) * warmup;
    if (ch === ' ') d += delayPerChar * rnd(0.5, 1.2);
    else if ('.,;:!?/\\-_@()[]{}'.includes(ch)) d += delayPerChar * rnd(0.8, 1.6);
    if (rand() < 0.05) d += delayPerChar * rnd(2, 4);
    await sleep(d);
  }
}

// Red rectangle around an element (or static rect). Returns an id for
// removal. Tracks scrolls/layout shifts. Use for the SINGLE specific element
// the viewer should look at - not "all the cards on the page".
async function highlight(target, opts = {}) {
  let selector = null, rect = null;
  if (typeof target === 'string') selector = target;
  else if (typeof target.boundingBox === 'function') rect = await target.boundingBox();
  else rect = target;
  return page.evaluate(({ selector, rect, label, color }) =>
    window.__highlight({ selector, rect, label, color }),
    { selector, rect, label: opts.label || null, color: opts.color || null });
}
async function clearHighlight(id) {
  if (id) await page.evaluate((id) => window.__removeHighlight(id), id);
  else await page.evaluate(() => window.__clearHighlights());
}

// Narrative banner near top of screen. Use to label what's about to happen:
// "Demonstrating live update by adding a service". Pass duration:ms to
// auto-remove, otherwise call removeBanner(id). Multiple banners stack.
async function banner(text, opts = {}) {
  return page.evaluate(({ text, opts }) => window.__banner(text, opts), { text, opts });
}
async function removeBanner(id) {
  if (id) await page.evaluate((id) => window.__removeBanner(id), id);
  else await page.evaluate(() => window.__clearBanners());
}

// API call against the live Rancher (used for mutations during the demo).
// Requires TOKEN above. Returns parsed JSON or null.
function api(method, path, body = null) {
  if (!TOKEN || !RANCHER_HOST) throw new Error('api(): TOKEN or RANCHER_HOST_NAME missing');
  const bodyArg = body ? `-d ${JSON.stringify(JSON.stringify(body))}` : '';
  const out = execSync(
    `curl -sk -X ${method} "https://${RANCHER_HOST}${path}" ` +
    `-H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" ${bodyArg} 2>/dev/null`,
    { encoding: 'utf8' }
  );
  try { return JSON.parse(out); } catch { return out; }
}

// Poll Rancher's /v1 endpoint until it returns 200. Useful after toggling
// features like ui-sql-cache that cause Rancher to restart its server.
async function waitForRancher(maxWaitMs = 120000) {
  if (!RANCHER_HOST) return;
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const code = execSync(
        `curl -sk -o /dev/null -w '%{http_code}' "https://${RANCHER_HOST}/v1" ` +
        `-H "Authorization: Bearer ${TOKEN}" 2>/dev/null`,
        { encoding: 'utf8' }
      ).trim();
      if (code === '200') return true;
    } catch {}
    await sleep(2000);
  }
  return false;
}

// --- Recorded actions -------------------------------------------------------
// Pacing rule: nothing on screen should ever sit still with nothing happening.
// Every wait is one of exactly three things:
//   1. UI wait -> locator.waitFor() / page.waitForURL() / waitForResponse().
//      Continue the instant the condition holds. Never guess a duration.
//   2. Viewer reading -> read(text) or read(ms). Derived from the text, and the
//      pointer rambles underneath it so no two captured frames are identical.
//      Wrap any other wait in idle(...) to get the same thing:
//        await idle(page.locator('.modal').waitFor());
//   3. Off-camera transition -> set `recording = false` first, then sleep, then
//      `recording = true` once the UI is ready again.
// Hard rule: no bare `await sleep(...)` over 500ms while `recording = true`.
recording = true;
await pause(500);                                    // opening beat (viewer)

// ... your interactions here ...
//
// Click that reveals new UI, preferred pattern (smoothMove scrolls the target
// into view with scrollToSmooth, so never call scrollIntoViewIfNeeded yourself
// while recording - it moves the page in a single frame):
//   await moveAndClick(someLocator);                                // scroll + glide + settle + dwell
//   await page.locator('.next-panel').waitFor({ state: 'visible' }); // wait on UI, not clock
//
// Highlight + banner for a specific spot, sparingly, one or two per video:
//   const hl = await highlight(numberCell, { label: 'Live count' });
//   const bn = await banner('Adding a service to demonstrate live update');
//   api('POST', '/v1/services', { ... });                           // trigger the change
//   await page.locator('.count-cell:has-text("2")').waitFor();      // wait on the result
//   await read('Live count');                                       // hold for the label
//   await clearHighlight(hl); await removeBanner(bn);
//
// Type into a focused input, keystroke badges pace this naturally:
//   await moveAndClick(inputLocator);
//   await sleep(rnd(90, 180));                                      // look before typing
//   await smoothType('my-resource-name');
//
// Long off-camera transition (state change, backend restart):
//   recording = false;
//   const bn = await banner('Disabling VAI...');
//   recording = true; await read('Disabling VAI'); recording = false;
//   api('PUT', '/v1/management.cattle.io.features/ui-sql-cache', { ... });
//   await waitForRancher();                                         // off-camera, no frames
//   await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
//   await page.evaluate(installOverlay);                            // re-inject after nav
//   recording = true;
//   await pause(600);                                               // viewer settle

await pause(700);                                    // final hold (viewer)
recording = false;

// --- Encode + cleanup -------------------------------------------------------
clearInterval(captureTimer);
await page.close();
await browser.close();

// ENCODE at the rate frames actually arrived at, never at TARGET_FPS.
// The ceiling guards against dividing by a tiny elapsed, and must stay above
// anything the compositor can really produce: at 60 it clamped a 61-68 fps
// capture down and stretched playback by up to 13%, which is the hardcoded-fps
// bug again from the other direction. On *this* path the ceiling is defensive
// only, because capture here is a polled screenshot every 1000/TARGET_FPS ms
// (33ms at TARGET_FPS = 30) and arrival cannot approach it; it is the screencast
// path in browser.mjs that gets near it, capturing at 62-69 fps when measured.
const measuredFps = (frame > 2 && recordedMs > 500)
  ? clamp(frame / (recordedMs / 1000), 4, 240)
  : TARGET_FPS;
console.log(`Captured ${frame} frames over ${(recordedMs / 1000).toFixed(1)}s -> encoding at ${measuredFps.toFixed(2)} fps`);
await new Promise((resolve, reject) => {
  const ff = spawn('ffmpeg', [
    '-y', '-framerate', measuredFps.toFixed(3),
    '-i', `${FRAME_DIR}/f%06d.jpg`,
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-b:v', '1.5M',
    OUT,
  ], { stdio: 'inherit' });
  ff.on('exit', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)));
});
await fs.rm(FRAME_DIR, { recursive: true, force: true });
console.log(`saved ${OUT}`);
process.exit(0);
