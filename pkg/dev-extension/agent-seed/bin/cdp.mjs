// Where Chromium's DevTools protocol is, as something that can be connected to.
//
// Chromium refuses a CDP request whose Host header is neither localhost nor an IP address - its
// guard against DNS rebinding - and answers 500 to every request. The shared browser is a
// Kubernetes Service, so the natural way to name it (`github-browser.dev-system.svc.cluster.local`)
// is the one way that cannot work: an agent handed that endpoint got a 500 from every call, and
// had to discover the guard and resolve the name itself before anything would run.
//
// So every script here goes through this. It is written as its own file rather than repeated in
// each one, and the seed lays it out beside both (`$WS/cdp.mjs` and `$WS/bin/cdp.mjs`) so the
// relative import works wherever the script that needs it ended up.
import { lookup } from 'node:dns/promises';

/** The endpoint to connect to: whatever was configured, with any hostname in it resolved. */
export async function cdpEndpoint(configured = '') {
  const raw = (configured || process.env.CLAUDE_BROWSER_CDP || 'http://localhost:9222').trim();

  try {
    const url = new URL(raw);

    // localhost and a bare IP are what Chromium accepts as they are.
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || /^[0-9.]+$/.test(url.hostname) || url.hostname.includes(':')) {
      return url.origin;
    }

    url.hostname = (await lookup(url.hostname)).address;

    return url.origin;
  } catch {
    // An endpoint that cannot be parsed or resolved is handed back as it was: the connect that
    // follows says so far better than a message invented here.
    return raw;
  }
}

/**
 * Drive the browser and always let go of it.
 *
 * A CDP connection is an open websocket, and an open websocket keeps node's event loop alive:
 * a script that connects, does its work and ends without disconnecting does not exit. It has
 * *finished* - the screenshot is written, the answer is printed - and the command hangs anyway.
 * Claude Code then moves it to the background at two minutes and stops it half an hour later,
 * which is a thing that has happened here and cost an agent a slot of its own attention to
 * diagnose (the reproduce probe for issue 12212, 29 September).
 *
 * So the connection is not the caller's to remember. This opens it, hands over a page, and
 * closes both in a `finally` whatever the body did - and arms a watchdog under Claude Code's
 * two-minute threshold, so a script that blocks on something that never answers fails in front
 * of whoever ran it instead of disappearing into the background.
 *
 *   import { withBrowser } from './cdp.mjs';
 *
 *   await withBrowser(async ({ page }) => {
 *     await page.goto(url, { timeout: 30000 });
 *     await page.screenshot({ path: shot });
 *   });
 *
 * `newPage: false` works on the tab that is already in front instead of opening one - which is
 * what a command that continues where the last one left off wants, and what `browser.mjs` does.
 */
export async function withBrowser(run, { newPage = true, deadlineMs = Number(process.env.CDP_DEADLINE_MS || 100000) } = {}) {
  const { chromium } = await import('playwright-core');
  const endpoint = await cdpEndpoint();
  // Unref'd, so it never keeps the process alive by itself - it only fires while something else
  // is holding the loop open, which is exactly the case it is here for.
  const watchdog = setTimeout(() => {
    console.error(`[cdp] still running after ${ Math.round(deadlineMs / 1000) }s against ${ endpoint }; exiting rather than hanging. Raise CDP_DEADLINE_MS if the work really takes longer.`);
    process.exit(3);
  }, deadlineMs);

  watchdog.unref();

  const browser = await chromium.connectOverCDP(endpoint);
  let page = null;

  try {
    const context = browser.contexts()[0] || await browser.newContext();

    page = newPage ? await context.newPage() : (context.pages()[0] || await context.newPage());

    return await run({
      browser, context, page, endpoint,
    });
  } finally {
    // Only the page this opened: a tab somebody else is using is not ours to close. `close()` on
    // a connected browser disconnects this client and leaves the shared Chromium running.
    if (newPage && page) {
      await page.close().catch(() => {});
    }
    await browser.close().catch(() => {});
    clearTimeout(watchdog);
  }
}
