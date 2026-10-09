/**
 * The assertion the design check cannot make: that the card is there, and that what is on it is
 * on it.
 *
 * Two rounds were lost to screens that passed the typed build and the token linter. One rendered
 * no cards at all - a circular computed between two computeds - and a dozen probes measured the
 * boxes *inside* a card without ever asserting a card existed. The next rendered every card's
 * primary content outside the card, where `overflow: hidden` clipped it away: a review's diff
 * drew at x=1479 on a card whose right edge is 962, and the title and the summary shared a line.
 * A token linter cannot see either of those, and a measurement of a card that is not there is
 * worse than no measurement.
 *
 * So this walks the deck and fails on five things, per card:
 *   a. a `.card` exists at all;
 *   b. nothing threw while it was drawn;
 *   c. every child of `.card__body` is inside the card's right edge;
 *   d. the body does not scroll sideways;
 *   e. the title and the summary are on different lines, on a card that has a summary.
 *
 * Run it in the agent pod, which can reach the browser:
 *   node --no-warnings /tmp/focus-geometry-check.mjs [dots]
 */
import fs from 'node:fs';
import { lookup } from 'node:dns/promises';

const DOTS = Number(process.argv[2] || 6);
/*
 * The dev server's own page, through the cluster's service proxy - not `/dashboard/...`, which is
 * the *installed* bundle and will happily hand back the code from before your change. A walk that
 * measures the old build and reports it as the new one is the most expensive kind of green.
 */
const URL_ = process.env.FOCUS_URL
  || 'https://rancher.ourhome.dev/k8s/clusters/local/api/v1/namespaces/extension-studio/services/http:dev-extension-extension:8005/proxy/dev/c/_/focus';
const say = (...a) => process.stdout.write(a.join(' ') + '\n');

const TOK = fs.readFileSync('/tmp/rtok', 'utf8').trim();
const ip = (await lookup('github-browser.dev-system.svc.cluster.local')).address;
const tab = await fetch(`http://${ ip }:9222/json/new?url=about:blank`, { method: 'PUT' }).then((r) => r.json());
const ws = new WebSocket(tab.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const thrown = [];

ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);

  if (m.method === 'Runtime.exceptionThrown') {
    thrown.push(String(m.params?.exceptionDetails?.exception?.description || '').slice(0, 160));
  }
  const w = m.id && pending.get(m.id);

  if (w) {
    pending.delete(m.id);
    m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result);
  }
});

await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});

const send = (method, params = {}, ms = 60000) => new Promise((res, rej) => {
  const id = ++seq;

  pending.set(id, { resolve: res, reject: rej });
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => pending.has(id) && (pending.delete(id), rej(new Error(`timeout ${ method }`))), ms);
});

const ev = async (expression, ms = 90000) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, ms);

  return r.exceptionDetails ? { threw: String(r.exceptionDetails.exception?.description || '').slice(0, 300) } : r.result.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Network.setCookie', {
  name: 'R_SESS', value: TOK, domain: 'rancher.ourhome.dev', path: '/', secure: true,
});
await send('Page.navigate', { url: URL_ });
// The dashboard blocks the main thread while it boots; a poll inside this window looks like a hang.
await new Promise((r) => setTimeout(r, 70000));

// The whole walk inside one evaluate: many small ones race the deck's own transitions.
const out = await ev(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rows = [];

  for (let i = 0; i < ${ DOTS }; i++) {
    const card = document.querySelector('.deck__top .card') || document.querySelector('.card');
    const row = { dot: i, cards: document.querySelectorAll('.card').length };

    if (card) {
      const box = card.getBoundingClientRect();
      const body = card.querySelector('.card__body');
      const title = card.querySelector('.card__title');
      const summary = card.querySelector('.card__summary');

      row.title = title ? title.textContent.trim().slice(0, 40) : null;
      row.head = Math.round(card.querySelector('.card__head')?.getBoundingClientRect().height || 0);
      row.body = Math.round(body?.getBoundingClientRect().height || 0);
      row.foot = Math.round(card.querySelector('.card__foot')?.getBoundingClientRect().height || 0);
      row.outside = [...(body?.children || [])]
        .filter((kid) => kid.getBoundingClientRect().right > box.right + 1)
        .map((kid) => kid.className.toString().split(' ')[0]);
      row.sideways = body ? body.scrollWidth - body.clientWidth : 0;
      row.stacked = !!title && (!summary || title.offsetTop !== summary.offsetTop);
      row.surface = [...(body?.children || [])].map((kid) => kid.className.toString().split(' ')[0]);
    }
    rows.push(row);

    const dots = document.querySelectorAll('.deck__dot');

    if (dots[i + 1]) { dots[i + 1].click(); }
    await sleep(1200);
  }

  return JSON.stringify({ dots: document.querySelectorAll('.deck__dot').length, rows });
})()`);

await send('Page.close', {}, 15000).catch(() => {});
ws.close();

if (!out || out.threw) {
  say('FAIL the walk itself threw: ' + (out?.threw || 'no result'));
  process.exit(1);
}

const { dots, rows } = JSON.parse(out);
const bad = [];

say(`deck: ${ dots } dots`);
for (const row of rows) {
  say(`dot ${ row.dot }  cards=${ row.cards }  head/body/foot=${ row.head }/${ row.body }/${ row.foot }`
    + `  sideways=${ row.sideways }  stacked=${ row.stacked }  outside=[${ (row.outside || []).join(' ') }]`
    + `  ${ row.title ? `"${ row.title }"` : '(NO CARD)' }`);
  if (!row.cards) { bad.push(`dot ${ row.dot }: no .card on the page`); }
  if ((row.outside || []).length) { bad.push(`dot ${ row.dot }: outside the card: ${ row.outside.join(', ') }`); }
  if (row.sideways > 1) { bad.push(`dot ${ row.dot }: body scrolls sideways by ${ row.sideways }px`); }
  if (row.cards && !row.stacked) { bad.push(`dot ${ row.dot }: the title and the summary share a line`); }
}
if (thrown.length) { bad.push(`exceptions: ${ [...new Set(thrown)].slice(0, 4).join(' | ') }`); }

say(bad.length ? '\nFAIL\n  ' + bad.join('\n  ') : '\nnothing to fix');
process.exit(bad.length ? 1 : 0);
