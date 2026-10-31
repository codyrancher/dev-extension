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
const WANT_VERSION = 2;

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
}

const known = new Map<string, Known>();

function held(pod: string): Known {
  let it = known.get(pod);

  if (!it) {
    it = { token: '', downSince: 0, why: '', starting: null, replaced: false, missing: new Set() };
    known.set(pod, it);
  }

  return it;
}

/** Stop asking this pod for a while, and say why when somebody does. */
function down(it: Known, why: string): PodStateUnavailable {
  it.downSince = Date.now();
  it.why = why;
  it.token = '';

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

  const token = await tokenFor(pod);

  return fetchOnce(it, pod, path, token).catch(async(e) => {
    if (!(e instanceof WrongVersion) || it.replaced) {
      throw e instanceof WrongVersion ? down(it, e.message) : e;
    }
    /*
     * Once per pod, and only once.
     *
     * A restart loop would be the worst failure this file could have - every tab replacing the
     * service the others had just started - so a pod is replaced at most once per page. If the
     * one after it is still the wrong version, something is wrong that a restart does not fix
     * and exec is the right answer.
     */
    it.replaced = true;
    it.token = '';
    try {
      await podExecResult(pod, ['/bin/sh', '/seed/state-api.sh', 'restart'], START_TIMEOUT_MS, AGENT_CONTAINER);
    } catch {
      throw down(it, 'the state service is the wrong version and could not be replaced');
    }

    return fetchOnce(it, pod, path, await tokenFor(pod)).catch((again) => {
      throw again instanceof WrongVersion ? down(it, again.message) : again;
    });
  });
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
    // The route, not this read's query string: `/chat?id=...&off=...` is different on every
    // poll, so remembering the whole thing remembered nothing and grew for ever.
    it.missing.add(route(path));

    throw new PodStateUnavailable(`this pod's state service does not serve ${ route(path) }`);
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

/** Whether this pod is currently being read over HTTP rather than exec, for the record. */
export function podStateUp(pod: string): boolean {
  const it = known.get(pod);

  return !!it && !!it.token && !it.downSince;
}

/** Tests, and a page that wants to start again from nothing. */
export function resetPodState(): void {
  known.clear();
}
