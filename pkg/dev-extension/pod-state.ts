/**
 * Reading the agent pod over HTTP instead of shelling into it.
 *
 * The pod serves what it knows on a small HTTP port (see seed/agent/state-api.mjs), and the
 * browser reaches it through the apiserver's `pods/<name>:<port>/proxy` subresource. That
 * subresource carries the person's own Rancher session exactly as `pods/exec` does, and exec is
 * the more privileged of the two since it spawns processes - so this changes how the browser
 * asks and nothing about who is asking.
 *
 * ── What this is worth ──────────────────────────────────────────────────────────────────────
 *
 * An exec is a WebSocket handshake and a forked process per command. A Focus page with two live
 * chats opened about eighty of those a minute, for ever. A GET is neither, and the pod coalesces
 * callers behind one run of the script, so a dozen tabs asking at once cost one fork instead of
 * a dozen.
 *
 * ── The rule this file exists to keep ───────────────────────────────────────────────────────
 *
 * Nothing here may make anything worse than exec. A pod without the service, a service that is
 * starting, a service that is wedged, a token that has gone stale, a cluster where `pods/proxy`
 * is not allowed - every one of those has to end in the caller quietly using exec, the way it
 * did before any of this existed. So the only thing this ever throws is `PodStateUnavailable`,
 * and `sessionScript` treats that as "ask the pod the old way".
 *
 * The circuit breaker is the other half of that rule. A pod that cannot serve must be asked
 * rarely, not on every tick: without it, a cluster that forbids `pods/proxy` would pay a failed
 * request *in front of* every exec, and this would have doubled the cost of the thing it was
 * written to reduce.
 */

import { AGENT_BASE, AGENT_NS, AGENT_CONTAINER, podExecResult } from './pod';

// The same local alias the other modules here use rather than a shared export.
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The port state-api.sh starts the service on. */
const PORT = 8111;

/**
 * The answer shape this browser understands.
 *
 * Sent back in every reply. An older pod answering a newer browser is the one failure that
 * cannot be seen from the outside - the reply parses and is wrong - so a mismatch means this
 * service is not the one this page knows how to talk to.
 *
 * And a mismatch is not rare, which is the part that had to be handled rather than tolerated.
 * The service is started once and nothing restarts it, while the seed it runs from updates in
 * place underneath - so a pod that started version 1 goes on serving version 1 for as long as
 * it is up, however many releases land. The browser replaces it: one exec, the same way it
 * started it, and then the read it wanted. Without that, every route added after a pod came up
 * would 404 for the life of that pod.
 */
const WANT_VERSION = 3;

/** How long a pod that could not serve is left alone before it is tried again. */
const COOLDOWN_MS = 60_000;
/** A pod that has never been tried gets one start attempt; this bounds it. */
const START_TIMEOUT_MS = 15_000;
/** A read that takes longer than this is not worth waiting for when exec is sitting right there. */
const READ_TIMEOUT_MS = 10_000;
/**
 * How old an answer may be before it is not worth having.
 *
 * The pod serves the last good value immediately and refreshes behind it, so a wedged script
 * gives a fast stale answer rather than a slow fresh one - which is what a caller wants, up to
 * a point. Past this the staleness is the news, and exec (which would actually block on the
 * same wedged script) is the more honest answer.
 */
const MAX_AGE_MS = 60_000;

/**
 * A service of the wrong vintage, which is a thing to fix rather than to report.
 *
 * Separate from `PodStateUnavailable` because the two want opposite responses: unavailable
 * means stop asking for a while, and this means replace it and ask again.
 */
class WrongVersion extends Error {}

/**
 * A route this page knows about and this service does not, which may only mean it is older.
 *
 * Worth the same first response as a wrong version - replace it and ask again - and a very
 * different second one. A service that is simply behind serves everything else perfectly well,
 * so when the replacement still does not have the route, the route goes and the pod stays.
 *
 * This is what lets a route be added without a VERSION bump, which matters more than it sounds:
 * a bump says "do not trust this service at all", and every read on the pod falls back to exec
 * until the kubelet has put the new seed on disk - up to a minute of exactly the thing all of
 * this exists to avoid, every time anything is added. An added route is not a reason to distrust
 * the answers to the other ones. So VERSION moves when an ANSWER changes shape, a new route
 * arrives at a new path where an older service can only 404, and the cost of adding one is that
 * one route waits for the mount instead of all of them.
 */
class RouteMissing extends Error {}

/** The one error this throws, and the signal to every caller to use exec. */
export class PodStateUnavailable extends Error {
  constructor(why: string) {
    super(why);
    this.name = 'PodStateUnavailable';
  }
}

interface Known {
  token: string;
  /** When the circuit opened; 0 while it is closed. */
  downSince: number;
  why: string;
  /** A start already under way, so ten callers at once do not exec ten times. */
  starting: Promise<string> | null;
  /** Whether this page has already replaced this pod's service once. See the version check. */
  replaced: boolean;
  /**
   * Routes this pod has answered 404 for, without their query strings.
   *
   * Reached only once the version has agreed, which is what makes a 404 here mean what it says:
   * a service of the right vintage that still does not serve this route. Opening the circuit
   * over one of them would take every other read off HTTP for a minute, so it is remembered
   * against the route alone and the pod goes on serving everything else.
   *
   * The query string is cut off first. `/chat?id=...&off=...` differs on every poll, so keeping
   * the whole string remembered a path that would never be asked for again and grew without
   * bound while guarding nothing.
   */
  missing: Set<string>;
  /** The one connection, and what it is watching. See the stream below. */
  feed: Feed | null;
}

interface Feed {
  /** What this page has asked the pod to watch, built from what it has actually read. */
  names: Set<string>;
  /** The last answer pushed for each name, and when it landed here. */
  pushed: Map<string, { answer: Json; at: number }>;
  /** Aborts the current connection, to reopen with a changed watch list or to give up. */
  stop: AbortController | null;
  /** A reopen already scheduled, so six components mounting at once open one connection. */
  soon: ReturnType<typeof setTimeout> | null;
  /** Consecutive failures, for the backoff. Reset by a connection that delivers anything. */
  failures: number;
  /** Whether the pod is currently pushing. Only then may a pushed answer be used. */
  live: boolean;
}

const known = new Map<string, Known>();

function held(pod: string): Known {
  let it = known.get(pod);

  if (!it) {
    it = {
      token: '', downSince: 0, why: '', starting: null, replaced: false, missing: new Set(), feed: null,
    };
    known.set(pod, it);
  }

  return it;
}

/** Stop asking this pod for a while, and say why when somebody does. */
function down(it: Known, why: string): PodStateUnavailable {
  it.downSince = Date.now();
  it.why = why;
  it.token = '';
  // The token it was opened with is gone, and a pod being left alone means left alone.
  it.feed?.stop?.abort();
  if (it.feed) {
    it.feed.live = false;
    it.feed.pushed.clear();
  }

  return new PodStateUnavailable(why);
}

function url(pod: string, path: string): string {
  // `http:` names the scheme of the thing inside the pod, the way dev-api's service proxy does.
  return `${ AGENT_BASE }/api/v1/namespaces/${ AGENT_NS }/pods/http:${ pod }:${ PORT }/proxy${ path }`;
}

/**
 * Start the service in the pod, and come back with the token it minted.
 *
 * The one exec this file does, and only when there is nothing listening. The script is
 * idempotent: a second caller is told the pid of the first and the same token, so two tabs
 * noticing at the same moment is the ordinary case rather than a race.
 */
async function start(pod: string): Promise<string> {
  const result = await podExecResult(pod, ['/bin/sh', '/seed/state-api.sh', 'start'], START_TIMEOUT_MS, AGENT_CONTAINER);
  const token = /^token ([0-9a-f]{16,})$/m.exec(result.stdout || '')?.[1] || '';

  if (!token) {
    // An older pod whose seed predates the service says "unknown verb", or nothing at all.
    throw new Error(result.stderr.trim() || result.status || 'the pod did not start a state service');
  }

  return token;
}

async function tokenFor(pod: string): Promise<string> {
  const it = held(pod);

  if (it.token) {
    return it.token;
  }
  if (!it.starting) {
    it.starting = start(pod).finally(() => {
      it.starting = null;
    });
  }

  try {
    it.token = await it.starting;
  } catch (e) {
    throw down(it, `could not start the state service: ${ (e as Error)?.message || e }`);
  }

  return it.token;
}

/**
 * One read, or `PodStateUnavailable`.
 *
 * @param pod The agent pod's name.
 * @param path A path the service serves, e.g. `/states`.
 * @returns The `text` field of the service's answer.
 */
export async function podStateText(pod: string, path: string): Promise<string> {
  const it = held(pod);

  if (it.downSince && Date.now() - it.downSince < COOLDOWN_MS) {
    throw new PodStateUnavailable(it.why);
  }
  if (it.downSince) {
    /*
     * The cooldown is over: one more try, from nothing.
     *
     * Everything learned about this pod is forgotten, including that its service was already
     * replaced once. That matters for a race worth naming: a page can load, find an old
     * service and replace it *before* the kubelet has synced the new seed - so the replacement
     * is the same old version, and a once-per-page rule would leave that tab on exec for as
     * long as it stayed open, even after the new seed arrived seconds later. A minute later it
     * may try again, which is long enough to be nowhere near a restart loop and short enough
     * that nobody notices.
     */
    it.downSince = 0;
    it.replaced = false;
    it.missing.clear();
  }
  if (it.missing.has(route(path))) {
    throw new PodStateUnavailable(`this pod's state service does not serve ${ route(path) }`);
  }

  /*
   * The stream first, where it has this answer: no request at all, for the common case of a
   * page asking the same question every few seconds and getting the same answer.
   *
   * Asking is also how the pod learns to watch it. The watch list is not declared anywhere -
   * it is whatever this page has actually read - so the first read of something goes by
   * request, and from then on it arrives on its own.
   */
  const name = feedName(path);

  if (name) {
    const pushed = fromFeed(it, path);

    if (pushed !== null) {
      return pushed;
    }
    watch(it, pod, name);
  }

  const token = await tokenFor(pod);

  return fetchOnce(it, pod, path, token).catch(async(e) => {
    if (!replaceable(e) || it.replaced) {
      throw settle(it, e);
    }
    /*
     * Once per pod, and only once.
     *
     * A restart loop would be the worst failure this file could have - every tab replacing the
     * service the others had just started - so a pod is replaced at most once per page. If the
     * one after it is still wrong, something is wrong that a restart does not fix and exec is
     * the right answer.
     */
    it.replaced = true;
    it.token = '';
    try {
      await podExecResult(pod, ['/bin/sh', '/seed/state-api.sh', 'restart'], START_TIMEOUT_MS, AGENT_CONTAINER);
    } catch {
      throw settle(it, e);
    }

    return fetchOnce(it, pod, path, await tokenFor(pod)).catch((again) => {
      throw settle(it, again);
    });
  });
}

/** Whether replacing the service is worth trying before believing what it said. */
function replaceable(e: unknown): boolean {
  return e instanceof WrongVersion || e instanceof RouteMissing;
}

/**
 * What a failure means once there is nothing left to try.
 *
 * The two that survive a replacement land in different places, and the difference is the whole
 * point of telling them apart: a wrong version is the pod's problem and takes every read on it
 * back to exec for the cooldown, while a route this service does not have is the route's
 * problem and takes only that route.
 */
function settle(it: Known, e: unknown): Error {
  if (e instanceof WrongVersion) {
    return down(it, e.message);
  }
  if (e instanceof RouteMissing) {
    it.missing.add(e.message);

    return new PodStateUnavailable(`this pod's state service does not serve ${ e.message }`);
  }

  return e as Error;
}

/**
 * One request, and what the answer's version says about it before anything else does.
 *
 * Every reply this service sends carries its version - the 404s and the 401s too - and reading
 * that first is the whole of this function's order. A 404 from a service older than the route
 * being asked for is not "no such route", it is "not this service", and the two want opposite
 * responses: one is permanent and the other is fixed by a restart. Getting that backwards is
 * what kept a version-1 service alive under a version-2 page for a whole day: the chat read
 * asked for `/chat`, a route version 1 never had, took the 404 at face value, and went back to
 * exec for the life of the tab - while the one answer that proved the service was out of date
 * was the one answer nothing checked the version of.
 */
async function ask(it: Known, pod: string, path: string, token: string): Promise<{ status: number; answer: Json }> {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), READ_TIMEOUT_MS);
  let resp;

  try {
    resp = await fetch(url(pod, path), {
      headers: { accept: 'application/json', 'x-state-token': token },
      signal:  stop.signal,
    });
  } catch (e) {
    throw down(it, `the state service could not be reached: ${ (e as Error)?.message || e }`);
  } finally {
    clearTimeout(timer);
  }

  const answer = await resp.json().catch(() => null);
  const version = Number(answer?.version);

  // Before the status, because the status is only meaningful from a service this page knows.
  if (Number.isFinite(version) && version !== WANT_VERSION) {
    throw new WrongVersion(`the state service speaks version ${ version }, this page wants ${ WANT_VERSION }`);
  }

  return { status: resp.status, answer };
}

/** What a 404 is remembered as: the route, without the arguments this particular read passed. */
function route(path: string): string {
  return path.split('?')[0];
}

async function fetchOnce(it: Known, pod: string, path: string, token: string): Promise<string> {
  let { status, answer } = await ask(it, pod, path, token);

  /*
   * A 401 is the one failure worth a second attempt rather than a cooldown.
   *
   * It means the pod restarted and minted a new token while this tab held the old one, which is
   * an ordinary thing to happen and not a reason to spend a minute on exec. The token is
   * dropped and the service asked to start again - it is already running, so that call just
   * hands back the current token.
   */
  if (status === 401 && it.token) {
    it.token = '';
    ({ status, answer } = await ask(it, pod, path, await tokenFor(pod)));
  }

  if (status === 404) {
    throw new RouteMissing(route(path));
  }
  if (status < 200 || status >= 300) {
    throw down(it, `the state service answered ${ status }`);
  }

  return readAnswer(it, answer);
}

function readAnswer(it: Known, answer: Json): string {
  if (!answer || typeof answer !== 'object') {
    throw down(it, 'the state service answered something that is not an answer');
  }
  if (!answer.ok) {
    // The service is up and saying it has nothing good - a script that has been failing for
    // longer than it is willing to paper over. Exec will get the real error.
    throw new PodStateUnavailable(String(answer.error || 'the state service has no answer'));
  }

  const age = Number(answer.age);

  if (Number.isFinite(age) && age > MAX_AGE_MS) {
    throw new PodStateUnavailable(`the state service's answer is ${ Math.round(age / 1000) }s old`);
  }

  return String(answer.text ?? '');
}

/* ── One connection instead of a request each ───────────────────────────────────────────────
 *
 * Every read above is a question whose answer usually has not changed. A page with a chat and a
 * workspace rail open asks the same four of them for ever, and pays a request each time to be
 * told what it already knew. The pod can do that polling itself - once, however many tabs are
 * watching - and say something only when an answer moves.
 *
 * So this opens one stream per pod and lets it fill a cache that `podStateText` reads first.
 *
 * It is a layer, deliberately, and not a rewrite. No caller changes, no component subscribes to
 * anything: a read that the stream has an answer for returns without touching the network, and
 * a read it does not falls through to exactly the request it made before. A pod too old to have
 * `/stream`, a cluster that will not hold the connection open, a stream that dies at three in
 * the morning - all of them land back on the request path that already works, which is the same
 * rule the rest of this file keeps about exec.
 *
 * The watch list builds itself from what the page actually reads. Nothing has to be declared,
 * and a page that stops reading something keeps watching it until the tab goes - which costs
 * one script run per tick in the pod and saves working out when a component is really finished.
 */

/** How long a reopen waits for other names to join it. */
const FEED_SETTLE_MS = 300;
/** A connection that has delivered nothing for this long is replaced. */
const FEED_SILENCE_MS = 90_000;
const FEED_RETRY_MS = 5_000;
const FEED_RETRY_MAX_MS = 60_000;

/**
 * The watch name for a path, or '' for a read that cannot be streamed.
 *
 * `/chat` is the deliberate absence. It is a cursor read - the browser tells the pod where it
 * got to and the answer depends on that - so it is not one answer that changes, it is a
 * different question every time. Pushing it would mean the pod tracking each watcher's offsets,
 * which is a different and much larger thing than this.
 */
function feedName(path: string): string {
  const [at, query] = path.split('?');
  const params = new URLSearchParams(query || '');
  const project = params.get('project') || '';

  if (at === '/sessions') {
    return 'sessions';
  }
  if (at === '/states') {
    return project ? `states:${ project }` : 'states';
  }
  if (at === '/project-sessions') {
    return project ? `sessions:${ project }` : '';
  }
  if (at === '/queued') {
    return 'queued';
  }
  if (at === '/report') {
    return params.get('workdir') ? `report:${ params.get('workdir') }` : '';
  }

  return '';
}

function feedOf(it: Known): Feed {
  if (!it.feed) {
    it.feed = {
      names: new Set(), pushed: new Map(), stop: null, soon: null, failures: 0, live: false,
    };
  }

  return it.feed;
}

/** Ask for this name from now on, reopening the connection once the rush has settled. */
function watch(it: Known, pod: string, name: string): void {
  const feed = feedOf(it);

  if (feed.names.has(name)) {
    return;
  }
  feed.names.add(name);
  if (feed.soon) {
    clearTimeout(feed.soon);
  }
  feed.soon = setTimeout(() => {
    feed.soon = null;
    open(it, pod).catch(() => {});
  }, FEED_SETTLE_MS);
}

async function open(it: Known, pod: string): Promise<void> {
  const feed = feedOf(it);

  // The circuit says this pod is not answering; the stream is not the thing to prove otherwise.
  if (it.downSince && Date.now() - it.downSince < COOLDOWN_MS) {
    return;
  }
  feed.stop?.abort();

  const names = [...feed.names];

  if (!names.length) {
    return;
  }

  const stop = new AbortController();

  feed.stop = stop;

  let resp;

  try {
    resp = await fetch(url(pod, `/stream?watch=${ encodeURIComponent(names.join(',')) }`), {
      headers: { accept: 'text/event-stream', 'x-state-token': await tokenFor(pod) },
      signal:  stop.signal,
    });
  } catch {
    return retry(it, pod, stop);
  }

  // A pod whose service predates the stream, or one that refused: the request path still works,
  // so this is not news and not a reason to doubt the pod.
  if (!resp.ok || !resp.body) {
    return retry(it, pod, stop);
  }

  feed.live = true;
  feed.failures = 0;

  const reader = resp.body.getReader();
  const decode = new TextDecoder();
  let buffer = '';
  let heard = Date.now();
  const quiet = setInterval(() => {
    // The pod beats every 25s, so silence for well past that is a connection that is not there
    // any more even though nothing said so.
    if (Date.now() - heard > FEED_SILENCE_MS) {
      stop.abort();
    }
  }, 15_000);

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }
      heard = Date.now();
      buffer += decode.decode(value, { stream: true });

      const chunks = buffer.split('\n\n');

      buffer = chunks.pop() || '';
      for (const chunk of chunks) {
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data:')) {
            continue; // `: open` and `: beat` are comments, and keeping the socket warm is their job.
          }
          let answer;

          try {
            answer = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }
          if (answer?.name && !answer.unknown) {
            feed.pushed.set(answer.name, { answer, at: Date.now() });
          }
          if (answer?.name && answer.unknown) {
            // This pod does not know that name; stop pretending the stream covers it.
            feed.pushed.delete(answer.name);
          }
        }
      }
    }
  } catch { /* aborted, or the connection broke; both are the same from here */ } finally {
    clearInterval(quiet);
  }

  return retry(it, pod, stop);
}

/** A connection that ended, for whatever reason, tried again later and never urgently. */
function retry(it: Known, pod: string, stop: AbortController): void {
  const feed = feedOf(it);

  if (feed.stop !== stop) {
    return; // Something already opened a newer one; this is the old connection finishing.
  }
  feed.live = false;
  feed.stop = null;
  feed.pushed.clear();
  feed.failures += 1;

  const wait = Math.min(FEED_RETRY_MS * (2 ** (feed.failures - 1)), FEED_RETRY_MAX_MS);

  if (feed.soon) {
    clearTimeout(feed.soon);
  }
  feed.soon = setTimeout(() => {
    feed.soon = null;
    open(it, pod).catch(() => {});
  }, wait);
}

/**
 * The pushed answer for this read, if the stream is carrying it.
 *
 * `age` is not checked the way a requested answer's is, and that is the one real difference.
 * A request's age says how long the pod has been unable to produce anything new, which past a
 * minute is worth going round by exec for. A pushed answer is old precisely because nothing has
 * changed - the pod re-runs the script every couple of seconds and stays silent - so age here
 * means the opposite thing. What still has to hold is `ok`, which the pod turns off once a
 * script has been failing for longer than it is willing to paper over.
 */
function fromFeed(it: Known, path: string): string | null {
  const feed = it.feed;
  const name = feedName(path);

  if (!feed || !feed.live || !name) {
    return null;
  }
  const held = feed.pushed.get(name);

  if (!held || !held.answer?.ok) {
    return null;
  }

  return String(held.answer.text ?? '');
}

/** Whether this pod is currently being read over HTTP rather than exec, for the record. */
export function podStateUp(pod: string): boolean {
  const it = known.get(pod);

  return !!it && !!it.token && !it.downSince;
}

/** Tests, and a page that wants to start again from nothing. */
export function resetPodState(): void {
  for (const it of known.values()) {
    it.feed?.stop?.abort();
    if (it.feed?.soon) {
      clearTimeout(it.feed.soon);
    }
  }
  known.clear();
}

/** What the stream is carrying, for the record and for anything that wants to say so. */
export function podFeedState(pod: string): { live: boolean; watching: number; holding: number } {
  const feed = known.get(pod)?.feed;

  return { live: !!feed?.live, watching: feed?.names.size || 0, holding: feed?.pushed.size || 0 };
}
