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
