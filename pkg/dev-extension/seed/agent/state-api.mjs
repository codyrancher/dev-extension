/**
 * A small HTTP service in the agent pod, so the browser can ask it things instead of shelling in.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────────────────────
 *
 * Nothing in the Kubernetes API can say what is happening inside this pod - which panes exist,
 * what each agent is doing - so the browser found out the only way it could: `pods/exec`, one
 * WebSocket per command, a process forked in this container for each one. A Focus page with two
 * live chats opened about eighty of those a minute, for ever, and every one of them paid for a
 * socket handshake and a fork to learn something that had not changed.
 *
 * This serves the same answers over HTTP. The browser reaches it through the apiserver's
 * `pods/<name>:<port>/proxy` subresource, which carries the person's own Rancher session exactly
 * as the exec subresource does - and exec is the more privileged of the two, since it spawns
 * processes. So this changes how the browser asks, and nothing about who is asking.
 *
 * ── The one design decision worth arguing with ──────────────────────────────────────────────
 *
 * This does NOT reimplement what the seed scripts do. It runs them.
 *
 * Every answer below is the output of the same `/seed/sessions.sh` the exec path called, cached
 * and shared. Reimplementing the logic in JavaScript would have been faster to read and would
 * have drifted the first time somebody edited the shell - and `sessions.sh` says in its own
 * comments that three browser parsers depend on its exact output. One source of truth, and the
 * win is kept anyway: a dozen tabs asking at once now cost ONE run of the script, not a dozen
 * forks, because the cache coalesces them.
 *
 * ── What it must never do ───────────────────────────────────────────────────────────────────
 *
 * Break a pane. This process shares a pod with every conversation a person is holding, so it is
 * written to fail small: it never exits on a bad request, it bounds every script it starts and
 * every byte it keeps, it serves a stale answer rather than an error when a run fails, and when
 * it cannot be sure it is healthy it exits so the supervisor can replace it. A pod with no
 * service here is not broken - the browser falls back to exec, which is what it does today.
 *
 * Node builtins only. This runs from a ConfigMap mount with no node_modules, like dev-api.
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

/**
 * Bumped whenever an answer's shape changes OR a route is added.
 *
 * A route was the case this missed. The service is started once, lazily, and nothing restarts
 * it - so a pod already serving version 1 keeps serving it after a new `state-api.mjs` lands in
 * /seed, and the route the browser is looking for 404s for ever. The browser can only notice
 * that if the number moves, which is why adding a route moves it.
 *
 * The browser sends the version it expects. An older server answering a newer browser is the
 * one failure this cannot detect from the outside - the reply looks fine and is wrong - so the
 * version rides in every response and the client restarts a server it has outgrown.
 */
const VERSION = 3;

const PORT = Number(process.env.STATE_API_PORT || 8111);
const SEED = process.env.STATE_API_SEED || '/seed';
/*
 * The token is minted in the pod, not shipped in the seed.
 *
 * A token in the ConfigMap would travel in the extension bundle, which makes it a secret every
 * holder of the bundle knows - and it would change the seed's fingerprint, so `ensureAgent`
 * would rewrite the ConfigMap on every page load. The supervisor generates one into the run
 * directory instead, and the browser is told it by the same exec that starts the service. It
 * lives and dies with the pod, which is the right lifetime for it.
 */
const TOKEN_FILE = process.env.STATE_API_TOKEN_FILE || '/tmp/.state-api/token';

/** How long an answer is served before it is read again. */
const FRESH_MS = 2_500;
/** How long a stale answer may still be served when the reader behind it is failing. */
const STALE_FLOOR_MS = 120_000;
/** A script that has not finished by here is killed; the caller gets the last good answer. */
const RUN_TIMEOUT_MS = 20_000;
/** A single script's output is bounded: this pod has conversations in it worth more than a read. */
const MAX_OUTPUT = 4 * 1024 * 1024;
/** A request that cannot be answered by here gives up rather than holding a connection open. */
const REQUEST_TIMEOUT_MS = 25_000;
/** No answer at all for this long means something is wrong with this process, not with a script. */
const WATCHDOG_MS = 5 * 60_000;

const startedAt = Date.now();

/* ── Saying so ──────────────────────────────────────────────────────────────────────────────
 *
 * To stderr, which the supervisor appends to a capped file. Never to a growing buffer in here:
 * a log nobody reads is still memory in a pod somebody is working in.
 */
function say(message) {
  try {
    process.stderr.write(`[state-api] ${ new Date().toISOString() } ${ message }\n`);
  } catch { /* a closed stderr is not a reason to stop serving */ }
}

/* ── Who may ask ─────────────────────────────────────────────────────────────────────────────
 *
 * A pod IP is reachable from anywhere in the cluster, and what this serves - titles, what each
 * agent is doing - belongs to the person whose pod it is. Reaching this *through the apiserver*
 * needs `pods/proxy`, the same gate as the exec it replaces; reaching the pod IP directly needs
 * only to be in the cluster, and that is what the token is for.
 *
 * Compared in constant time, and a missing token file means nothing is served rather than
 * everything: a service that fails open is worse than one that fails.
 */
let token = '';

function readToken() {
  try {
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    token = '';
  }

  return token;
}

function allowed(req) {
  const want = token || readToken();

  if (!want) {
    return false;
  }

  const got = String(req.headers['x-state-token'] || '');
  const a = Buffer.from(got);
  const b = Buffer.from(want);

  // timingSafeEqual throws on a length mismatch, which is itself the answer.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ── Running a seed script, once, however many are asking ────────────────────────────────────
 *
 * The whole point of this service. `reading` holds the promise of a run already in flight, so
 * ten tabs that all want the states at the same moment wait on one child process rather than
 * forking ten.
 */
const cache = new Map();

function entry(key) {
  let held = cache.get(key);

  if (!held) {
    held = { key, text: '', at: 0, failedSince: 0, error: '', reading: null };
    cache.set(key, held);
  }

  return held;
}

/**
 * One script, bounded in time and in bytes.
 *
 * Resolves rather than rejects for a non-zero exit, the way the browser's own exec helper does:
 * an exit code is a fact about the script, not a failure of this service. Rejects only when the
 * child could not be run or had to be killed.
 */
function runScript(argv, timeoutMs = RUN_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let child;

    try {
      child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      reject(new Error(`could not start ${ argv.join(' ') }: ${ e?.message || e }`));

      return;
    }

    let out = '';
    let err = '';
    let capped = false;
    let done = false;

    const finish = (fn, value) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      fn(value);
    };

    /*
     * Killed, not abandoned. A child left running after its caller gave up is a fork this
     * service is still paying for, and under a wedged tmux they would pile up one per tick.
     * SIGKILL after a grace period, because the thing most likely to hang here is a shell
     * waiting on a tmux server that is not answering, and that ignores a polite signal.
     */
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch { /* already gone */ }
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch { /* already gone */ }
      }, 2_000).unref?.();
      finish(reject, new Error(`${ argv.join(' ') } did not finish in ${ timeoutMs }ms`));
    }, timeoutMs);

    const take = (chunk, into) => {
      if (into === 'out') {
        if (out.length + chunk.length > MAX_OUTPUT) {
          capped = true;
          out = out.slice(0, MAX_OUTPUT);
          try {
            child.kill('SIGKILL');
          } catch { /* already gone */ }

          return;
        }
        out += chunk;
      } else if (err.length < 64 * 1024) {
        err += chunk;
      }
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => take(c, 'out'));
    child.stderr.on('data', (c) => take(c, 'err'));
    child.on('error', (e) => finish(reject, new Error(`${ argv[0] }: ${ e?.message || e }`)));
    child.on('close', (code) => {
      if (capped) {
        finish(reject, new Error(`${ argv.join(' ') } produced more than ${ MAX_OUTPUT } bytes`));

        return;
      }
      finish(resolve, { out, err, code: code ?? -1 });
    });
  });
}

/**
 * The cached text of one script, read again only when it is old.
 *
 * A failed read does not clear what is there. The browser asking "what is each agent doing"
 * would rather have an answer from eight seconds ago than an error, and the age travels with it
 * so a caller that cares can tell. Only after `STALE_FLOOR_MS` of unbroken failure does this
 * give up and report the error, because by then the answer is not worth having.
 */
async function cached(key, argv) {
  const held = entry(key);
  const now = Date.now();

  if (held.text && now - held.at < FRESH_MS) {
    return held;
  }

  /*
   * An answer in hand is returned now; the refresh happens behind it.
   *
   * Waiting for the read was costing the caller the whole of `RUN_TIMEOUT_MS` whenever the
   * script was wedged - and the script being wedged is precisely when a tmux server is not
   * answering, which is precisely when every tab is asking. Twenty seconds of held connections
   * to learn something that was already on the shelf, twenty seconds late.
   *
   * So: a caller waits only when there is nothing at all to give it. Otherwise it gets the last
   * good answer with its age attached - the browser can see for itself how old it is - and the
   * read it triggered lands for whoever asks next.
   */
  const refresh = () => {
    if (!held.reading) {
      held.reading = read();
    }

    return held.reading;
  };

  if (held.text) {
    refresh().catch(() => {});

    return held;
  }
  if (held.reading) {
    await held.reading.catch(() => {});

    return held;
  }
  async function read() {
    try {
      const { out, err, code } = await runScript(argv);

      /*
       * A non-zero exit is a failure, not an answer.
       *
       * `runScript` resolves on a non-zero exit deliberately - an exit code is a fact about the
       * script - but that made this overwrite good cached text with the empty stdout of a
       * script that had just failed. A caller then saw `ok:false` with nothing in it, having
       * been one tick away from a perfectly good answer that was thrown out to store the
       * failure. Zero exit with no output is different and is kept: a pod with no conversations
       * really does have nothing to say.
       */
      if (code !== 0) {
        throw new Error(`exit ${ code }${ err ? `: ${ err.trim().split('\n')[0].slice(0, 200) }` : '' }`);
      }
      held.text = out;
      held.at = Date.now();
      held.error = '';
      held.failedSince = 0;
    } catch (e) {
      const message = String(e?.message || e);

      held.failedSince = held.failedSince || Date.now();
      // Said once per spell rather than once per tick: a tmux that has been wedged for ten
      // minutes should not be ten minutes of identical lines in the log.
      if (message !== held.error) {
        held.error = message;
        say(`${ key }: ${ message }`);
      }
    } finally {
      held.reading = null;
    }
  }

  await refresh().catch(() => {});

  return held;
}

/** What a cached answer looks like on the wire, age and all. */
function body(held, extra = {}) {
  const now = Date.now();
  const age = held.at ? now - held.at : -1;
  const broken = held.failedSince && now - held.failedSince > STALE_FLOOR_MS;

  return {
    version: VERSION,
    ok:      !!held.text && !broken,
    text:    broken ? '' : held.text,
    age,
    stale:   !!held.error,
    error:   broken ? held.error : '',
    ...extra,
  };
}

/* ── The routes ─────────────────────────────────────────────────────────────────────────────
 *
 * Deliberately few, and all reads. Nothing here changes anything in the pod: a write still goes
 * through exec, where it has an exit code and an audit trail, and where a bug in this file
 * cannot cost anybody a conversation.
 */
/**
 * A project name safe to hand a shell script.
 *
 * The one place a caller's input reaches an argv here, so it is the one place that has to say
 * what it accepts. The ids this serves are `p-<workspace>-<n>` and `agent-<n>`, so letters,
 * digits, dash and underscore is the whole alphabet - and anything else is refused rather than
 * quoted, because refusing is checkable and quoting is a thing to get wrong once.
 */
const SAFE_NAME = /^[A-Za-z0-9_-]{1,120}$/;

/**
 * A chat's read, run here instead of by a WebSocket from the browser.
 *
 * This is the one that mattered: a live conversation polls every 1.5 seconds, so two of them
 * opened about eighty exec sockets a minute, each one a process forked in this container to
 * learn something that usually had not changed.
 *
 * Not cached and not coalesced, unlike everything else here. The other reads answer the same
 * question for every tab; this one is "what is in MY conversation since MY offset", so two
 * callers almost never want the same bytes and holding an answer would only serve a stale one.
 * What is saved is the socket and the fork-per-tick, which is what was costing.
 *
 * Every argument is checked before it reaches a shell. They are all scalars by design - an id,
 * two offsets, a nonce, a directory name, a CLI name - so checking them is a matter of saying
 * what each may contain, which is a thing that can be read and verified. Nothing a caller sends
 * becomes a command.
 */
const PANE_ID = /^[A-Za-z0-9_-]{1,120}$/;
const NONCE = /^[a-z0-9]{4,64}$/;
const PROJ_KEY = /^[A-Za-z0-9_.-]{1,200}$/;
const HOME_DIR = /^\/[A-Za-z0-9_./-]{1,200}$/;
const CLIS = ['claude', 'agy'];

/*
 * `chat-read.mjs` is loaded when it is first wanted, not at the top of this file.
 *
 * It is the same module the browser imports - gen-seed.mjs copies it in beside this one, so
 * there is one definition of the read and not two that drift. But a top-level import makes the
 * whole service hostage to it: a seed without that file, for any reason, and this process
 * cannot start at all, so `list` and `states` go down with a route that has nothing to do with
 * them. Measured, not guessed: the service crash-looped and every read fell back to exec.
 *
 * Loaded once and remembered, including the failure, so a seed that cannot serve chat says so
 * immediately on every later request rather than retrying an import that will not work.
 */
let chatRead;

async function chatReader() {
  if (chatRead === undefined) {
    try {
      chatRead = (await import('./chat-read.mjs')).chatReadScript;
    } catch (e) {
      say(`chat-read.mjs could not be loaded, so /chat is not served: ${ e?.message || e }`);
      chatRead = null;
    }
  }

  return chatRead;
}

function chatArgs(url) {
  const id = url.searchParams.get('id') || '';
  const sub = url.searchParams.get('sub') || '';
  const nonce = url.searchParams.get('n') || '';
  const projKey = url.searchParams.get('proj') || '';
  const home = url.searchParams.get('home') || '';
  const cli = url.searchParams.get('cli') || 'claude';
  const off = Number(url.searchParams.get('off') || 0);
  const soff = Number(url.searchParams.get('soff') || 0);

  if (!PANE_ID.test(id)) {
    return { bad: 'id' };
  }
  if (sub && !PANE_ID.test(sub)) {
    return { bad: 'sub' };
  }
  if (!NONCE.test(nonce)) {
    return { bad: 'n' };
  }
  if (!PROJ_KEY.test(projKey)) {
    return { bad: 'proj' };
  }
  // `..` separately from the pattern: a path of only safe characters can still walk upwards.
  if (!HOME_DIR.test(home) || home.includes('..')) {
    return { bad: 'home' };
  }
  if (!CLIS.includes(cli)) {
    return { bad: 'cli' };
  }
  if (!Number.isInteger(off) || off < 0 || !Number.isInteger(soff) || soff < 0) {
    return { bad: 'off' };
  }

  return {
    id, off, sub, soff, nonce, projKey, cli, home,
  };
}

const ROUTES = [
  ['/healthz', async() => ({
    version: VERSION,
    ok:      true,
    pid:     process.pid,
    uptime:  Date.now() - startedAt,
    host:    os.hostname(),
    reads:   [...cache.keys()],
  })],
  ['/sessions', async() => body(await cached('list', ['/bin/sh', `${ SEED }/sessions.sh`, 'list']))],
  ['/chat', async(url) => {
    const chatReadScript = await chatReader();

    if (!chatReadScript) {
      return {
        version: VERSION, ok: false, text: '', age: -1, stale: false, error: 'This pod cannot serve chat reads.',
      };
    }

    const at = chatArgs(url);

    if (at.bad) {
      return {
        version: VERSION, ok: false, text: '', age: -1, stale: false, error: `Bad ${ at.bad }.`,
      };
    }

    /*
     * As the pane's own user, with the pane's home - the same wrapper the browser's exec used.
     *
     * Everything a pane touches belongs to uid 1000, and claude refuses to run as root, so a
     * read done as root here would be a read of files written by somebody else. The script goes
     * in base64 so nothing in it is ever quoted for a shell twice.
     */
    const script = `export HOME=${ at.home }; export PATH=$HOME/.local/bin:$PATH; ${ chatReadScript(at) }`;
    const b64 = Buffer.from(script, 'utf8').toString('base64');
    const path = `/tmp/.chat-api-${ process.pid }-${ Date.now().toString(36) }.sh`;
    const inner = `echo ${ b64 } | base64 -d > ${ path } && chmod 755 ${ path } && if [ "$(id -u)" = 0 ]; then su node -s /bin/bash -c "/bin/bash ${ path }" 2>&1; else /bin/bash ${ path } 2>&1; fi; rm -f ${ path }`;

    try {
      const { out } = await runScript(['/bin/sh', '-c', inner], 25_000);

      return {
        version: VERSION, ok: true, text: out, age: 0, stale: false, error: '',
      };
    } catch (e) {
      // The browser falls back to its own exec on this, which is the path it used before.
      return {
        version: VERSION, ok: false, text: '', age: -1, stale: false, error: String(e?.message || e),
      };
    }
  }],
  ['/states', async(url) => {
    /*
     * `states <project>` is a different verb from `states-all`, not a filter over it.
     *
     * sessions.sh says why in its own comments: `states` is scoped to a base and answers for
     * that project's conversations, `states-all` is not scoped and answers for the pod. Asking
     * the narrow one for a pod-wide answer is how a caller came to report that nothing was
     * running anywhere, so the two are kept apart here too - and cached apart, since a tab
     * watching one workspace and a panel watching the pod want different answers.
     */
    const project = url.searchParams.get('project') || '';

    if (!project) {
      return body(await cached('states-all', ['/bin/sh', `${ SEED }/sessions.sh`, 'states-all']));
    }
    if (!SAFE_NAME.test(project)) {
      return { version: VERSION, ok: false, text: '', age: -1, stale: false, error: 'That is not a project name.' };
    }

    return body(await cached(`states:${ project }`, ['/bin/sh', `${ SEED }/sessions.sh`, 'states', project]));
  }],
  /*
   * One workspace's conversations: `sessions.sh list <project>`.
   *
   * Its own path rather than `/sessions?project=`, and that is deliberate. A service that
   * predates a path answers 404, which says what it is; a service that predates a *parameter*
   * answers 200 with the unscoped list, which is a wrong answer wearing a right one's clothes -
   * every conversation in the pod handed back as though it belonged to one workspace. The
   * version check is what stands between `/states?project=` and that, and nothing should need
   * to stand between anything again: a new path cannot be misread by an older service, so
   * adding one costs no VERSION bump and no minute of exec on every other route.
   *
   * This is the last frequent read still going by exec - eight components call it, several on
   * timers - and it is the same verb the drawer's unscoped `/sessions` runs, cached apart
   * because a page watching one workspace and the panel watching the pod want different answers.
   */
  ['/project-sessions', async(url) => {
    const project = url.searchParams.get('project') || '';

    if (!project || !SAFE_NAME.test(project)) {
      return { version: VERSION, ok: false, text: '', age: -1, stale: false, error: 'That is not a project name.' };
    }

    return body(await cached(`list:${ project }`, ['/bin/sh', `${ SEED }/sessions.sh`, 'list', project]));
  }],
];

/* ── The watchdog ───────────────────────────────────────────────────────────────────────────
 *
 * The failure this cannot catch from inside is itself: a process that is up, holding the port,
 * and no longer answering. The browser would keep choosing it over the exec path that works.
 *
 * So: if something has been asked and NOT answered for WATCHDOG_MS, exit. The supervisor starts
 * a fresh one within seconds, and a service that replaces itself is strictly better than one
 * that sits there holding a port it cannot serve.
 *
 * "Asked and not answered", not "asked at all". The first version counted requests and never
 * forgot them, so once a pod had served anything, five minutes with nobody looking read exactly
 * like five minutes wedged - and the service exited. Then the supervisor started another, which
 * exited five minutes after ITS last reader. Every pod that had ever been read restarted its
 * service all night, which is the thing this comment claimed to prevent. Caught because the
 * `/served` counters kept coming back empty on a pod that had plainly served.
 *
 * Comparing the two clocks is what tells idle from wedged: everything asked has been answered
 * (idle, say nothing), or something was asked after the last answer and the gap is too wide
 * (wedged, go). Any reply counts as answering, a 401 and a 404 included - what is being watched
 * for is a process that has stopped replying at all, and a caller holding a stale token is not
 * that, and would not be helped by a restart that keeps the token.
 */
let asked = 0;
/** When a request last arrived, and when one was last replied to. The pair is the liveness test. */
let lastAsked = 0;

/*
 * How many of each route has been served, for one question nothing could answer from outside.
 *
 * The whole point of this service is that reads stop being execs, and until now the only way to
 * check whether that had actually happened was to count WebSockets in somebody's browser and
 * squint at truncated URLs. These are counts and nothing else - no ids, no paths, no content -
 * and they are served without a token, because a number that says "this pod has answered 4,000
 * chat reads" tells an unauthorised caller nothing it could not infer from the service existing,
 * and withholding it costs the one diagnosis anybody actually wants.
 */
const served = Object.create(null);
let answered = Date.now();

function watchdog() {
  const timer = setInterval(() => {
    // Nothing is outstanding: every request that arrived has been replied to. Idle, not wedged.
    if (lastAsked <= answered) {
      return;
    }
    if (Date.now() - answered > WATCHDOG_MS) {
      say(`asked ${ Math.round((Date.now() - lastAsked) / 1000) }s ago and answered nothing for ${ Math.round((Date.now() - answered) / 1000) }s; exiting for the supervisor`);
      process.exit(3);
    }
  }, 30_000);

  timer.unref?.();
}

/* ── Serving ────────────────────────────────────────────────────────────────────────────────── */

const server = http.createServer(async(req, res) => {
  lastAsked = Date.now();

  const send = (code, value) => {
    const text = JSON.stringify(value);

    // Whatever the status: this process is replying, which is the only thing the watchdog is
    // watching for.
    answered = Date.now();
    try {
      res.writeHead(code, {
        'content-type':  'application/json',
        'cache-control': 'no-store',
        'x-state-api':   String(VERSION),
      });
      res.end(text);
    } catch { /* the browser went away mid-answer */ }
  };

  // A request that cannot be answered gives the connection back rather than holding it. The
  // apiserver proxy in front of this has its own timeout, and a reply it has stopped waiting
  // for is a socket neither end is using.
  res.setTimeout?.(REQUEST_TIMEOUT_MS, () => {
    try {
      res.destroy();
    } catch { /* already gone */ }
  });

  try {
    const url = new URL(req.url || '/', 'http://pod');
    const path = url.pathname.replace(/\/+$/, '') || '/healthz';

    if (req.method !== 'GET') {
      send(405, { version: VERSION, error: 'Only GET.' });

      return;
    }
    // Before the token, and the only route that is: see `served`.
    if (path === '/served') {
      send(200, {
        version: VERSION,
        ok:      true,
        uptime:  Date.now() - startedAt,
        served:  { ...served },
      });

      return;
    }
    if (!allowed(req)) {
      // Nothing about why. A caller without the token learns that it needs one, and no more.
      send(401, { version: VERSION, error: 'No.' });

      return;
    }

    const route = ROUTES.find(([at]) => at === path);

    if (!route) {
      send(404, { version: VERSION, error: 'No such path.' });

      return;
    }
    asked++;
    served[path] = (served[path] || 0) + 1;
    send(200, await route[1](url));
  } catch (e) {
    /*
     * A bug in a route is a 500, not a dead pod.
     *
     * This is the line that matters most in the file. Everything in here shares a pod with
     * somebody's conversations, and an unhandled throw in a request handler would take the
     * whole process down and, worse, do it silently from the browser's point of view.
     */
    say(`unhandled: ${ e?.stack || e }`);
    send(500, { version: VERSION, error: String(e?.message || e) });
  }
});

/*
 * One of these, and the loser says nothing.
 *
 * Two tabs noticing a dead service at the same moment both start one. The second binds nothing
 * and leaves quietly: the first is already serving, which is what both of them wanted. Any
 * other listen error is worth a word before going, because that one is not expected.
 */
server.on('error', (e) => {
  if (e?.code === 'EADDRINUSE') {
    process.exit(0);
  }
  say(`listen: ${ e?.message || e }`);
  process.exit(1);
});

/*
 * A throw with nothing to catch it must not end the pod's service.
 *
 * Logged and survived rather than fatal. The watchdog above is what catches a process that has
 * been damaged enough to stop answering; these two handlers are for the ordinary case of a bug
 * on a path nobody is waiting on, where exiting would be the larger harm.
 */
process.on('uncaughtException', (e) => say(`uncaught: ${ e?.stack || e }`));
process.on('unhandledRejection', (e) => say(`unhandled rejection: ${ e?.stack || e }`));

// SIGTERM is the supervisor or the kubelet asking; stop taking work and let what is in flight
// finish. SIGINT likewise, for anyone running this by hand.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    say(`${ signal }: closing`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref?.();
  });
}

readToken();
// Re-read on a timer: the extension can rotate the token by rewriting the ConfigMap, and the
// kubelet updates the mount in place without this process knowing.
setInterval(readToken, 30_000).unref?.();
watchdog();

server.listen(PORT, '0.0.0.0', () => {
  say(`version ${ VERSION } listening on ${ PORT }${ token ? '' : ' (no token yet; serving nothing until one appears)' }`);
});
