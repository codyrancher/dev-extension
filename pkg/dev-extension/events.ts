/**
 * One socket for the whole page, instead of a timer in every component.
 *
 * What this replaces: the sidebar asked for the workspace list every five seconds, a rail asked
 * for a pull request's comments every two and a half, a tools strip every ten, a review pane
 * every fifteen - each on its own `setInterval`, each in every open tab, each paying for a
 * session lookup and an apiserver proxy hop to be told nothing had changed. Opening the network
 * panel on a quiet page showed a wall of 200s a second apart.
 *
 * What it is instead: one WebSocket to dev-api carrying every path the page cares about. A
 * topic *is* a GET path this API already serves, and what arrives is byte-for-byte what that
 * path returns - so there is no second implementation of any answer to keep in step, and the
 * fallback when a socket cannot be had is simply to fetch the path on a timer, which is what
 * the page did before.
 *
 * That fallback is not a nicety. A shared preview is served with a certificate the browser does
 * not trust, and Chrome refuses a websocket handshake on such an origin with no interstitial and
 * no reason (see sockets.ts) - so a page that only knew how to subscribe would sit there empty.
 * Here the polling is the floor and the socket is what lifts the page off it: whenever the
 * socket is not up, every watch that was given a `fetch` is on its own timer, and the moment it
 * comes up they stop.
 */
import { clusterBase, devFetch } from './api';
import { backoffMs, wasStable, subscription } from './events-retry.mjs';
import { note } from './dev-log.mjs';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

type Listener = (value: Json) => void;

interface Watch {
  path: string;
  every: number;
  listeners: Set<Listener>;
  /** What the page would have fetched; also what it falls back to. */
  read: () => Promise<Json>;
  last?: Json;
  /** The last value serialized, so a poll that brings back the same answer wakes nobody. */
  text: string;
  seen: boolean;
  timer: ReturnType<typeof setInterval> | null;
}

/** dev-api, through the apiserver's service proxy - the one address the browser has for it. */
const DEV_API = `${ clusterBase('local') }/api/v1/namespaces/dev-system/services/http:dev-api:8080/proxy`;

/** Nothing heard for this long and the socket is dead however open it claims to be. */
const SILENCE_MS = 70_000;
const WATCHDOG_MS = 15_000;

const watches = new Map<string, Watch>();

/** One of dev-api's paths, fetched - the same call the socket's frames are made of. */
export function readPath(path: string): Promise<Json> {
  return devFetch(`${ DEV_API }${ path }`);
}

let socket: WebSocket | null = null;
let up = false;
let attempts = 0;
let openedAt = 0;
let heardAt = 0;
let sent = '';
let retry: ReturnType<typeof setTimeout> | null = null;
let watchdog: ReturnType<typeof setInterval> | null = null;
let pendingSub = false;

/** Whether the page is in front of someone. A hidden tab polls nothing; the socket stays. */
function visible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

/**
 * Hand a value to everyone watching, if it is news.
 *
 * The socket only ever sends a path that changed, so this is about the fallback: polling that
 * brings back the same answer should cost a string compare and nothing else. It is the same
 * test the server makes, for the same reason.
 */
function deliver(watch: Watch, value: Json) {
  const text = JSON.stringify(value ?? null);

  watch.last = value;
  if (watch.seen && text === watch.text) {
    return;
  }
  watch.text = text;
  watch.seen = true;
  for (const listener of [...watch.listeners]) {
    try {
      listener(value);
    } catch (e) {
      note(`events: a ${ watch.path } listener threw: ${ (e as Error)?.message || e }`);
    }
  }
}

/** The fallback: ask for the path the way the page used to, on the cadence it used to. */
function startPolling(watch: Watch) {
  if (watch.timer) {
    return;
  }

  const tick = () => {
    if (!visible()) {
      return;
    }
    watch.read().then((value) => deliver(watch, value)).catch(() => {});
  };

  watch.timer = setInterval(tick, watch.every);
  tick();
}

function stopPolling(watch: Watch) {
  if (watch.timer) {
    clearInterval(watch.timer);
    watch.timer = null;
  }
}

function pollAll() {
  for (const watch of watches.values()) {
    startPolling(watch);
  }
}

function pollNone() {
  for (const watch of watches.values()) {
    stopPolling(watch);
  }
}

/**
 * Tell the server what this page wants, once per turn of the event loop.
 *
 * A page that mounts six components registers six watches in one tick; sending six frames that
 * each restate the whole set would be silly, so the send is deferred to a microtask and the
 * last one wins.
 */
function sendSubscription() {
  if (pendingSub || !up || !socket) {
    return;
  }
  pendingSub = true;
  Promise.resolve().then(() => {
    pendingSub = false;
    if (!up || !socket) {
      return;
    }

    const next = subscription(watches.keys(), sent);

    if (next.changed) {
      sent = next.sent;
      try {
        socket.send(next.frame);
      } catch {
        // The close handler will pick this up and reconnect.
      }
    }
  });
}

function onFrame(text: string) {
  heardAt = Date.now();

  let message: Json;

  try {
    message = JSON.parse(text);
  } catch {
    return;
  }

  if (!message?.t) {
    return;
  }

  const watch = watches.get(message.t);

  if (!watch) {
    return;
  }

  if (message.e) {
    // A path the server cannot answer. Say it once, and let this watch fetch for itself - the
    // socket may be fine and only this one path broken.
    note(`events: ${ message.t } - ${ message.e }`);
    startPolling(watch);

    return;
  }
  stopPolling(watch);
  deliver(watch, message.d);
}

function scheduleReconnect() {
  if (retry || !watches.size) {
    return;
  }
  attempts += 1;

  const wait = backoffMs(attempts);

  retry = setTimeout(() => {
    retry = null;
    connect();
  }, wait);
}

function dropped() {
  const was = up;

  up = false;
  socket = null;
  sent = '';
  if (watchdog) {
    clearInterval(watchdog);
    watchdog = null;
  }
  if (was && !wasStable(openedAt, Date.now())) {
    // It opened and died young, which is a proxy taking the upgrade and then dropping it. Not
    // a success, so the backoff must not be reset by it.
    note('events: the socket opened and closed again straight away');
  }
  openedAt = 0;
  // Back to timers while there is no socket, so a page is never frozen waiting for one.
  pollAll();
  scheduleReconnect();
}

function connect() {
  if (socket || !watches.size || typeof WebSocket === 'undefined' || typeof window === 'undefined') {
    return;
  }

  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';

  try {
    socket = new WebSocket(`${ scheme }://${ window.location.host }${ DEV_API }/events`);
  } catch {
    socket = null;
    scheduleReconnect();

    return;
  }

  socket.onopen = () => {
    up = true;
    openedAt = Date.now();
    heardAt = Date.now();
    sent = '';
    sendSubscription();
    // The timers stop only once a path has arrived on the socket (see onFrame): until then the
    // page keeps fetching, so switching over costs nothing if the socket turns out to be
    // useless.
    watchdog = setInterval(() => {
      if (up && Date.now() - heardAt > SILENCE_MS) {
        note('events: nothing heard for a minute, reconnecting');
        try {
          socket?.close();
        } catch {
          dropped();
        }
      }
    }, WATCHDOG_MS);
  };

  socket.onmessage = (event: MessageEvent) => {
    if (typeof event.data === 'string') {
      onFrame(event.data);
    }
  };

  socket.onerror = () => {
    // `onclose` always follows, and doing the work twice would double the backoff.
  };

  socket.onclose = () => {
    if (wasStable(openedAt, Date.now())) {
      attempts = 0;
    }
    dropped();
  };
}

/** Shut everything down once the last watch has gone, so a page with none holds no socket. */
function idle() {
  if (watches.size) {
    return;
  }
  if (retry) {
    clearTimeout(retry);
    retry = null;
  }
  if (watchdog) {
    clearInterval(watchdog);
    watchdog = null;
  }
  up = false;
  attempts = 0;
  sent = '';
  try {
    socket?.close();
  } catch {
    // Already gone.
  }
  socket = null;
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (visible() && !up) {
      // Back in front of someone with no socket: fetch now rather than at the end of an
      // interval that has been running against a hidden tab.
      for (const watch of watches.values()) {
        watch.read().then((value) => deliver(watch, value)).catch(() => {});
      }
    }
  });
}

/**
 * Watch a dev-api path, by socket where there is one and by fetching where there is not.
 *
 * `read` is what to call when there is no socket. It defaults to fetching the same path, which
 * is what the page did before and what the server is pushing - so most callers pass only the
 * path and the cadence. Pass one where the page read the value some other way.
 *
 * Returns the unwatch - call it from `beforeUnmount`, the way the `clearInterval` it replaces
 * was called.
 */
export function watch(path: string, onValue: Listener, opts: { every?: number; read?: () => Promise<Json> } = {}): () => void {
  let entry = watches.get(path);

  if (!entry) {
    entry = {
      path,
      every:     Math.max(1_000, opts.every || 10_000),
      listeners: new Set(),
      read:      opts.read || (() => readPath(path)),
      seen:      false,
      text:      '',
      timer:     null,
    };
    watches.set(path, entry);
  }
  entry.listeners.add(onValue);

  // Whatever was last heard, now, so a second component watching the same path is not blank
  // until the next change.
  if (entry.seen) {
    const value = entry.last;

    Promise.resolve().then(() => {
      if (entry.listeners.has(onValue)) {
        onValue(value);
      }
    });
  }

  if (up) {
    sendSubscription();
  } else {
    startPolling(entry);
    connect();
  }

  return () => {
    const held = watches.get(path);

    if (!held) {
      return;
    }
    held.listeners.delete(onValue);
    if (!held.listeners.size) {
      stopPolling(held);
      watches.delete(path);
      sendSubscription();
      idle();
    }
  };
}

/** Whether the page is currently being pushed to, for anything that wants to say so. */
export function eventsUp(): boolean {
  return up;
}

/** For a page that has just changed something and does not want to wait for the next read. */
export function nudge(path: string): void {
  const held = watches.get(path);

  if (held) {
    held.read().then((value) => deliver(held, value)).catch(() => {});
  }
}

/** Tests and teardown: forget everything and close. */
export function resetEvents(): void {
  for (const held of watches.values()) {
    stopPolling(held);
  }
  watches.clear();
  pollNone();
  idle();
}
