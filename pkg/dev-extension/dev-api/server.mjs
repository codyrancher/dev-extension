// The Dev extension's in-cluster API. Written by the extension into a ConfigMap and run as a
// Deployment in dev-system (see api.ts, ensureWorkspaceApi); this file is the source, packed by
// scripts/gen-dev-api.mjs.
//
// Two jobs. One: workspaces and templates for anything that is not a browser - an action, a
// script - so a workspace can be asked for with a POST. Two: the harness's `/my-work` API, as
// far as the harness's own skills need it. The review and fix skills the harness wrote read a
// pull request, file review comments, report their progress and read CI through
// `$CLAUDE_HARNESS_API/my-work/...`; this serves those paths, so the same skills run unchanged
// from Extension Studio's agent pod, with this service standing where the harness API stood.
//
// GitHub is reached with the one token in this Rancher's harness - the per-person secret store
// in dev-system - and the review state lives in ConfigMaps beside it, one per pull request.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PORT || 8080);
const ROOT = 'https://kubernetes.default.svc';
const SA = '/var/run/secrets/kubernetes.io/serviceaccount';
const TOKEN = fs.readFileSync(`${ SA }/token`, 'utf8').trim();
const NAMESPACE = process.env.DEV_SYSTEM_NAMESPACE || 'dev-system';
const DEFAULT_REPO = process.env.DEV_REPO || 'rancher/dashboard';

const APPS = '/apis/appsplus.io/v1alpha1/apps';
const INSTANCES = '/apis/appsplus.io/v1alpha1/appinstances';
// The App whose installations are per-workspace shares (dashboard-preview), named
// `preview-<ws>` / `storybook-<ws>`. The reconciler removes one whose workspace is gone.
const PREVIEW_APP = 'dashboard-preview';
/** The App new workspaces are made from, and the marker their names carry. See lte.ts. */
const LTE_APP = 'lte-workspace';
const LTE_PREFIX = 'lte-';
const LABEL_WORKSPACE = 'dev.rancher.io/workspace';
const LABEL_APP = 'dev.rancher.io/app';
const LABEL_CLUSTER = 'dev.rancher.io/cluster';
const SECRET_KIND_LABEL = 'dev.rancher.io/kind';

// -- Kubernetes ------------------------------------------------------------------------------

async function k8s(path, init = {}) {
  const response = await fetch(`${ ROOT }${ path }`, {
    ...init,
    headers: {
      authorization:  `Bearer ${ TOKEN }`,
      'content-type': init.method === 'PATCH' ? 'application/merge-patch+json' : 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  let body = {};
  let parsed = true;

  /*
   * Parsed after the status is checked, not before.
   *
   * It used to `JSON.parse` first, so any error response that was not JSON threw a SyntaxError
   * and the HTTP status was thrown away with it. A 404 for a type this cluster does not have came
   * back through the proxy as an error page and surfaced as `Unexpected non-whitespace character
   * after JSON at position 4` - which is how three reconcilers came to log that, every tick,
   * forever, on every downstream cluster, while the actual answer was "that type is not installed
   * here". The status is what the caller needs to tell one failure from another.
   */
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    parsed = false;
  }

  if (!response.ok) {
    const detail = body.message || (parsed ? '' : text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120));
    const error = new Error(detail ? `${ response.status } from ${ path }: ${ detail }` : `${ response.status } from ${ path }`);

    error.status = response.status;
    throw error;
  }

  if (!parsed) {
    throw new Error(`${ path } answered ${ response.status } with something that is not JSON: ${ text.slice(0, 120) }`);
  }

  return body;
}

/**
 * The Apps Plus installations, or null when there are none to be had.
 *
 * Three reconcilers want this list, and every one of them is right to do nothing when it cannot
 * be read: an empty list would read as "every workspace is gone" and tear all of them down. But
 * on a downstream cluster the type is not installed at all - Apps Plus lives on `local` - so the
 * answer will never arrive, and all three logged a failure on every tick of their loops.
 *
 * A 404 is not doubt, it is an answer: there are no installations here and there never will be.
 * It is said once per reconciler and then not asked again.
 */
const noInstallations = new Set();

async function installations(who) {
  if (noInstallations.has(who)) {
    return null;
  }

  try {
    return await k8s(INSTANCES);
  } catch (e) {
    if (e.status === 404) {
      noInstallations.add(who);
      console.log(`[dev-api] ${ who }: this cluster has no Apps Plus installations type, so there is nothing to reconcile; not asking again.`);

      return null;
    }
    // Doubt rather than an answer: say so and wait for the next tick.
    console.error(`[dev-api] ${ who }: could not list installations, skipping tick:`, e.message || e);

    return null;
  }
}

/** The same call, for a response that is not JSON: a pod's log. */
/**
 * How long one exec may stay quiet before its caller gets whatever arrived.
 *
 * The same two minutes the browser's `podExecOnce` uses. The hang this guards against never
 * settles, so the deadline only decides how long a *working* exec may take.
 */
const EXEC_WAIT_MS = 120000;

/** base64url, for the bearer-token subprotocol below. */
function b64url(text) {
  return Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Run one command in a pod and hand back its stdout.
 *
 * The browser has had this for a long time (`podExecOnce`, api.ts) but it reaches the apiserver
 * through Rancher's proxy, which carries the session cookie for it. From in here there is no proxy
 * and no cookie, and the WebSocket Node exposes is the WHATWG one, which **cannot set an
 * Authorization header** - so the token goes where Kubernetes accepts it for exactly this reason,
 * as a subprotocol: `base64url.bearer.authorization.k8s.io.<base64url token>` alongside the channel
 * protocol. This is the same mechanism a browser uses against a bare apiserver, and it is why this
 * needs no dependency: adding `ws` to get a header would be a package for one call, which this file
 * has already declined once (see the CDP note).
 *
 * Every frame is a channel digit then base64. 1 is stdout, which is all any caller here wants; 2 is
 * stderr and 3 is the apiserver's own status, and a command that writes to either has nothing to
 * say to a caller that asked for output.
 *
 * It always settles. An exec the apiserver upgrades and then abandons - a pod going away, a node
 * that stopped answering - fires neither `close` nor `error`, and a promise that never settles in a
 * reconcile loop is a loop that never ticks again.
 */
function podExec(namespace, pod, container, command, waitMs = EXEC_WAIT_MS) {
  return new Promise((resolve) => {
    const params = new URLSearchParams({ container, stdout: 'true', stderr: 'true', stdin: 'false', tty: 'false' });

    // Repeated, not comma-joined: this is argv, and a command with a space in an argument has to
    // arrive as that one argument.
    for (const arg of command) {
      params.append('command', arg);
    }

    const url = `${ ROOT.replace(/^http/, 'ws') }/api/v1/namespaces/${ namespace }/pods/${ pod }/exec?${ params }`;
    const decoder = new TextDecoder('utf-8');
    let out = '';
    let settled = false;
    let timer;

    const done = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(out + decoder.decode());
    };

    try {
      const socket = new WebSocket(url, [`base64url.bearer.authorization.k8s.io.${ b64url(TOKEN) }`, 'base64.channel.k8s.io']);

      timer = setTimeout(() => {
        done();
        try {
          socket.close();
        } catch { /* already gone, which is the case this exists for */ }
      }, waitMs);

      socket.addEventListener('message', (event) => {
        const frame = String(event.data || '');

        if (!frame.startsWith('1')) {
          return;
        }

        try {
          // Streamed, because a character can straddle two frames.
          out += decoder.decode(Buffer.from(frame.slice(1), 'base64'), { stream: true });
        } catch { /* a frame that is not base64 is not output */ }
      });

      socket.addEventListener('close', done);
      socket.addEventListener('error', done);
    } catch {
      done();
    }
  });
}

async function k8sText(path) {
  const response = await fetch(`${ ROOT }${ path }`, { headers: { authorization: `Bearer ${ TOKEN }` } });
  const text = await response.text();

  if (!response.ok) {
    const error = new Error(`${ response.status } from ${ path }`);

    error.status = response.status;
    throw error;
  }

  return text;
}

async function create(path, body) {
  try {
    return await k8s(path, { method: 'POST', body: JSON.stringify(body) });
  } catch (e) {
    if (e.status === 409) {
      return null;
    }
    throw e;
  }
}

async function readDoc(name, key) {
  try {
    const map = await k8s(`/api/v1/namespaces/${ NAMESPACE }/configmaps/${ name }`);

    return JSON.parse(map.data?.[key] || 'null') ?? null;
  } catch (e) {
    if (e.status === 404) {
      return null;
    }
    throw e;
  }
}

async function writeDoc(name, key, value, labels = {}) {
  const path = `/api/v1/namespaces/${ NAMESPACE }/configmaps/${ name }`;
  const data = { [key]: JSON.stringify(value) };

  try {
    await k8s(path, { method: 'PATCH', body: JSON.stringify({ data }) });
  } catch (e) {
    if (e.status !== 404) {
      throw e;
    }

    await k8s(`/api/v1/namespaces/${ NAMESPACE }/configmaps`, {
      method: 'POST',
      body:   JSON.stringify({
        apiVersion: 'v1', kind: 'ConfigMap', metadata: { namespace: NAMESPACE, name, labels: { 'dev.rancher.io/kind': 'review', ...labels } }, data,
      }),
    });
  }
}

// -- GitHub ----------------------------------------------------------------------------------

let tokenCache = { at: 0, token: '' };

/** The GH_TOKEN of the first per-person secret store in dev-system: this harness is one person's. */
async function githubToken() {
  if (Date.now() - tokenCache.at < 60_000 && tokenCache.token) {
    return tokenCache.token;
  }

  const list = await k8s(`/api/v1/namespaces/${ NAMESPACE }/secrets?labelSelector=${ SECRET_KIND_LABEL }%3Dsecrets`);
  const found = (list.items || []).find((secret) => secret.data?.GH_TOKEN);
  const token = found ? Buffer.from(found.data.GH_TOKEN, 'base64').toString('utf8').trim() : '';

  tokenCache = { at: Date.now(), token };

  return token;
}

function failure(status, message) {
  const error = new Error(message);

  error.status = status;

  return error;
}

let viewerLogin = { at: 0, login: '' };

/** Whose token this is - so a page can tell the person's own threads from everyone else's. */
async function githubViewer() {
  if (Date.now() - viewerLogin.at < 10 * 60_000 && viewerLogin.login) {
    return viewerLogin.login;
  }
  try {
    const me = await ghRest('GET', '/user');

    viewerLogin = { at: Date.now(), login: me.login || '' };
  } catch {
    viewerLogin = { at: Date.now(), login: '' };
  }

  return viewerLogin.login;
}

async function ghRest(method, apiPath, body) {
  const token = await githubToken();

  if (!token) {
    throw failure(503, 'No GitHub token is set. Add one in the Dev extension\'s Settings.');
  }

  const response = await fetch(`https://api.github.com${ apiPath }`, {
    method,
    headers: {
      authorization: `Bearer ${ token }`,
      accept:        'application/vnd.github+json',
      'user-agent':  'dev-extension',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();

  if (!response.ok) {
    throw failure(502, `GitHub ${ method } ${ apiPath } -> ${ response.status }: ${ text.slice(0, 400) }`);
  }

  return text ? JSON.parse(text) : null;
}

async function graphql(query, variables) {
  const token = await githubToken();
  const response = await fetch('https://api.github.com/graphql', {
    method:  'POST',
    headers: { authorization: `Bearer ${ token }`, 'content-type': 'application/json', 'user-agent': 'dev-extension' },
    body:    JSON.stringify({ query, variables }),
  });
  const body = await response.json();

  if (body.errors?.length) {
    throw new Error(body.errors.map((e) => e.message).join('; '));
  }

  return body.data;
}

function repoOf(url) {
  const asked = url.searchParams.get('repo') || '';

  return /^[\w.-]+\/[\w.-]+$/.test(asked) ? asked : DEFAULT_REPO;
}

// -- CI --------------------------------------------------------------------------------------

const BAD_CONCLUSIONS = ['failure', 'timed_out', 'startup_failure', 'action_required', 'cancelled'];

function latestRuns(checkRuns) {
  const latest = new Map();

  for (const r of checkRuns?.check_runs || []) {
    const prev = latest.get(r.name);
    const at = r.completed_at || r.started_at || '';

    if (!prev || at >= (prev.completed_at || prev.started_at || '')) {
      latest.set(r.name, r);
    }
  }

  return [...latest.values()];
}

function ciFromRest(checkRuns, statuses) {
  const runs = latestRuns(checkRuns);
  const ctxs = new Map();

  for (const c of statuses?.statuses || []) {
    const prev = ctxs.get(c.context);

    if (!prev || (c.created_at || '') >= (prev.created_at || '')) {
      ctxs.set(c.context, c);
    }
  }

  if (!runs.length && !ctxs.size) {
    return null;
  }

  let pending = 0;
  let failing = 0;
  let total = 0;
  let failingUrl = null;

  for (const r of runs) {
    total++;
    if (r.status !== 'completed') {
      pending++;
    } else if (['failure', 'timed_out', 'startup_failure'].includes(r.conclusion)) {
      failing++;
      failingUrl = failingUrl || r.details_url || r.html_url || null;
    }
  }

  for (const c of ctxs.values()) {
    total++;
    if (c.state === 'pending') {
      pending++;
    } else if (['failure', 'error'].includes(c.state)) {
      failing++;
      failingUrl = failingUrl || c.target_url || null;
    }
  }

  return { pending, failing, total, failingUrl };
}

function jobIdFrom(url) {
  const m = String(url || '').match(/\/job\/(\d+)/);

  return m ? Number(m[1]) : null;
}

/**
 * How much of a job's log is kept, in characters.
 *
 * Named rather than written twice because two answers have to agree about it: the excerpt below
 * marks a line by its position in the retained tail, and the dialog that opens the whole log has
 * to number the same lines the same way. A second read of a *finished* job's log retains the same
 * tail only while both reads keep the same amount of it, so this is the one place it is decided.
 */
const LOG_TAIL_BYTES = 256_000;

async function jobLogTail(repo, jobId, keepBytes = LOG_TAIL_BYTES, capBytes = 25_000_000) {
  const token = await githubToken();
  const response = await fetch(`https://api.github.com/repos/${ repo }/actions/jobs/${ jobId }/logs`, {
    headers: { authorization: `Bearer ${ token }`, 'user-agent': 'dev-extension' }, redirect: 'follow',
  });

  if (!response.ok || !response.body) {
    return '';
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let tail = '';
  let read = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }
    read += value.length;
    tail += decoder.decode(value, { stream: true });
    if (tail.length > keepBytes) {
      tail = tail.slice(-keepBytes);
    }
    if (read > capBytes) {
      try {
        await reader.cancel();
      } catch { /* ignore */ }
      break;
    }
  }

  return tail;
}

const FAILURE_RE = /(^|\s)(✕|✗|×|●|FAIL\b|AssertionError|Assertion(Error)?:|Error:|Expected\b.*Received\b|Timed out|expected .* to |\bat .+:\d+:\d+\))/i;
const ANSI_RE = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');

/**
 * A job log as lines, with the two things GitHub puts in front of every one of them taken off.
 *
 * Every line of an Actions log is prefixed `2026-10-03T12:11:09.1234567Z `, and most of what a
 * test runner prints is wrapped in ANSI colour besides - so 29 characters of a 120-character
 * terminal are a timestamp nobody reads and the rest draws as mojibake anywhere but a terminal.
 *
 * Both come off here rather than in each caller, because the excerpt and the whole log have to be
 * numbered the same way: the card marks a line by its position in this array and the dialog that
 * opens the whole log has to agree about which line that is.
 */
function cleanLines(log) {
  return String(log || '').split('\n')
    .map((l) => l.replace(/\r$/, '').replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, '').replace(ANSI_RE, ''));
}

/** Which of these lines the matcher hit, 1-based, capped so a 4,000-line log stays a JSON reply. */
function failureHits(lines, cap = 500) {
  const hits = [];

  for (let i = 0; i < lines.length && hits.length < cap; i++) {
    if (FAILURE_RE.test(lines[i])) {
      hits.push(i + 1);
    }
  }

  return hits;
}

/**
 * Blank lines off both ends, and where what is left actually starts.
 *
 * `.trim()` on the joined text did the first half of this and lost the second, which was harmless
 * only for as long as nobody numbered the result: the card draws these lines with the log's own
 * line numbers, so a window that silently begins two lines later than it claims puts every number
 * - and the whole-log dialog's scroll position - two lines out.
 */
function trimEnds(lines, from) {
  let a = 0;
  let b = lines.length;

  while (a < b && !lines[a].trim()) {
    a++;
  }
  while (b > a && !lines[b - 1].trim()) {
    b--;
  }

  return { lines: lines.slice(a, b), at: from + a + 1 };
}

/**
 * The failure and its neighbourhood, out of a log that is mostly installs and passes.
 *
 * `at`, `hits` and `lines` are what make this readable on a card rather than only by an agent,
 * and all three are additive - `text` and `matched` are what they were, because the harness's own
 * skills read this route too.
 *
 *   - `at` is where the window starts in the retained log, 1-based, so the lines can carry the
 *     log's own numbers instead of 1..n of a slice nobody can locate again.
 *   - `hits` are the lines inside the window the matcher fired on. The card marks those rows; a
 *     window with no marks in it is a window of context with the point somewhere off screen.
 *   - `lines` is how long the whole log is, so the card can say how much of it this is.
 *
 * **The window is contiguous now.** It used to keep the first hundred lines and the last twenty
 * with a `...` between them, which was fine while the lines were anonymous and is not once they
 * are numbered: everything after the elision would be numbered as though nothing had been cut.
 * A window only exceeds 120 lines when the matches are spread over a hundred of them - a suite
 * with several failures - and the first failure in full is the better first look of the two. The
 * rest is one press away on the whole log.
 */
function failureExcerpt(log, maxLines = 120) {
  const clean = cleanLines(log);
  let first = -1;
  let last = -1;

  clean.forEach((line, i) => {
    if (FAILURE_RE.test(line)) {
      if (first === -1) {
        first = i;
      }
      last = i;
    }
  });

  if (first === -1) {
    const from = Math.max(0, clean.length - 40);
    const tail = trimEnds(clean.slice(from), from);

    return {
      text: tail.lines.join('\n'), matched: false, at: tail.at, hits: [], lines: clean.length,
    };
  }

  const start = Math.max(0, first - 4);
  const end = Math.min(clean.length, Math.max(last + 6, start + 20));
  const kept = trimEnds(clean.slice(start, Math.min(end, start + maxLines)), start);

  return {
    text: kept.lines.join('\n'), matched: true, at: kept.at, hits: failureHits(kept.lines), lines: clean.length,
  };
}

async function ciFailures(repo, num) {
  const meta = await ghRest('GET', `/repos/${ repo }/pulls/${ num }`);
  const sha = meta.head?.sha;

  if (!sha) {
    throw new Error('No head sha on the PR');
  }

  const [checkRuns, statuses] = await Promise.all([
    ghRest('GET', `/repos/${ repo }/commits/${ sha }/check-runs?per_page=100`).catch(() => null),
    ghRest('GET', `/repos/${ repo }/commits/${ sha }/status`).catch(() => null),
  ]);
  const checks = latestRuns(checkRuns)
    .filter((r) => BAD_CONCLUSIONS.includes(String(r.conclusion || '').toLowerCase()))
    .map((r) => ({
      id:          r.id,
      kind:        'check',
      name:        r.name,
      conclusion:  r.conclusion,
      url:         r.html_url,
      title:       r.output?.title || null,
      summary:     (r.output?.summary || '').slice(0, 600) || null,
      annotations: r.output?.annotations_count || 0,
      jobId:       jobIdFrom(r.details_url || r.html_url),
    }));

  for (const st of statuses?.statuses || []) {
    if (['failure', 'error'].includes(String(st.state || '').toLowerCase())) {
      checks.push({
        id: st.id, kind: 'status', name: st.context, conclusion: st.state, url: st.target_url, title: st.description || null, summary: null, annotations: 0, jobId: null,
      });
    }
  }

  return { pr: num, sha, checks };
}

async function ciFailureDetail(repo, num, checkId) {
  const run = await ghRest('GET', `/repos/${ repo }/check-runs/${ checkId }`);
  const raw = await ghRest('GET', `/repos/${ repo }/check-runs/${ checkId }/annotations?per_page=50`).catch(() => []);
  const annotations = (Array.isArray(raw) ? raw : []).map((a) => ({
    path: a.path, line: a.start_line, endLine: a.end_line, level: a.annotation_level, message: a.message, title: a.title || null,
  })).filter((a) => !/^Process completed with exit code|^The job|^This job/i.test(a.message || ''));

  annotations.sort((a, b) => (a.level === 'failure' ? 0 : 1) - (b.level === 'failure' ? 0 : 1));

  const jobId = jobIdFrom(run.details_url || run.html_url);
  let log = null;

  if (jobId) {
    const tail = await jobLogTail(repo, jobId).catch(() => '');

    if (tail) {
      log = { ...failureExcerpt(tail), jobId };
    }
  }

  return {
    pr:    num,
    check: {
      id: run.id, name: run.name, conclusion: run.conclusion, url: run.html_url, title: run.output?.title || null, summary: run.output?.summary || null,
    },
    annotations,
    log,
  };
}

/**
 * The whole of the log the excerpt came out of.
 *
 * The card shows the failure and the twenty lines around it; this is the second look, behind a
 * press. A route of its own rather than a flag on the detail call, because of what it costs: a
 * quarter of a megabyte of text where the detail call is made for every red card the deck draws
 * and prefetched for the two either side of it.
 *
 * Numbered the same way as the excerpt - same tail, same cleaning, same `LOG_TAIL_BYTES` - so the
 * line the card marked is the line this opens on. `truncated` says the job printed more than is
 * kept, in which case line 1 here is wherever the retained tail happens to begin rather than the
 * start of the job.
 */
async function ciFailureLog(repo, num, checkId) {
  const run = await ghRest('GET', `/repos/${ repo }/check-runs/${ checkId }`);
  const jobId = jobIdFrom(run.details_url || run.html_url);
  const about = {
    pr: num, check: checkId, name: run.name || null, url: run.html_url || null,
  };

  // A check that is not an Actions job - a status context posted by a bot, a required review -
  // has no log anywhere to fetch. Said rather than 404'd: the caller asked a reasonable question.
  if (!jobId) {
    return {
      ...about, jobId: null, text: '', lines: 0, hits: [], truncated: false,
    };
  }

  const tail = await jobLogTail(repo, jobId).catch(() => '');
  const lines = cleanLines(tail);

  return {
    ...about,
    jobId,
    text:      lines.join('\n'),
    lines:     lines.length,
    hits:      failureHits(lines),
    truncated: tail.length >= LOG_TAIL_BYTES,
  };
}

// -- Pull requests, comments, runs -----------------------------------------------------------

const reviewMap = (num) => `dev-review-pr-${ num }`;

async function localComments(num) {
  return (await readDoc(reviewMap(num), 'comments.json')) || [];
}

async function saveComments(num, comments) {
  await writeDoc(reviewMap(num), 'comments.json', comments, { 'dev.rancher.io/pr': String(num) });
}

// Where the agent pod's files are, as this pod sees them. The Studio's agent keeps its
// workspace on a hostPath; the same directory is mounted here read-only (see api.ts,
// ensureWorkspaceApi) so a recording an agent made can be looked at before it goes anywhere.
const AGENT_ROOT = process.env.AGENT_WORKSPACE_ROOT || '/agent-workspace';
const AGENT_PREFIX = '/workspace/';
// And where every workspace's /workspace is (one directory per workspace, the rancher-dev App's
// hostPath): a review runs in the PR's workspace now, so its evidence is under that one.
const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT || '/dev-workspaces';

/** The seed as the extension shipped it, as the ConfigMap carries it (gzipped) or used to. */
function bakedSeed() {
  try {
    return JSON.parse(zlib.gunzipSync(Buffer.from(fs.readFileSync('/seed/seed.json.gz.b64', 'utf8'), 'base64')).toString('utf8'));
  } catch {
    return JSON.parse(fs.readFileSync('/seed/seed.json', 'utf8'));
  }
}

// ── Skills, rules and CLAUDE.md: codyrancher/ai-skills ──────────────────────────────────────
//
// None of them are in this extension. They live in one repository, and this service pulls its
// branch, so a commit there reaches every workspace without a release here: the sidebar polls
// /agent-seed/version, which carries the repository's commit, and lays the seed out again when it
// moves. The seed a workspace gets is three layers: what the extension ships (the layout step,
// scripts, git hooks, settings), the repository's files over that, and the Skills page's
// overrides over those. An edit saved on that page is an override until it is committed, and
// committing writes it to the repository, where it replaces the override.

const SKILLS_MAP = process.env.DEV_SKILLS_MAP || 'dev-skills';
const AI_SKILLS_REPO = process.env.DEV_AI_SKILLS_REPO || 'codyrancher/ai-skills';
const AI_SKILLS_REF = process.env.DEV_AI_SKILLS_REF || 'main';
const AI_SKILLS_ROOT = process.env.DEV_AI_SKILLS_ROOT || 'rancher-dashboard';
const AI_SKILLS_SNAPSHOT = 'dev-ai-skills';
const AI_SKILLS_CHECK_MS = 60_000;
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,60}$/;

/** The seed keys the repository owns. The extension's own seed must not carry any of these. */
function repoOwnsKey(key) {
  return key.startsWith('skills/') || key.startsWith('rules/') || /^CLAUDE(\.dev)?\.md(\.hbs)?$/.test(key);
}

/** Where a path in the repository lands in the seed, or null for a file that is not the seed's. */
function seedKeyFor(repoPath) {
  if (!repoPath.startsWith(`${ AI_SKILLS_ROOT }/`)) {
    return null;
  }
  const rel = repoPath.slice(AI_SKILLS_ROOT.length + 1);

  if (rel.startsWith('.claude/skills/') || rel.startsWith('.claude/rules/')) {
    return rel.slice('.claude/'.length);
  }

  return rel === 'CLAUDE.md' || rel === 'CLAUDE.dev.md' ? rel : null;
}

/**
 * A GitHub tarball as { path: text }, paths without the "<owner>-<repo>-<sha>/" GitHub puts first.
 * POSIX tar: 512-byte headers, ustar's name prefix, and the pax records GitHub uses for long paths.
 */
function untar(tgz) {
  const buf = zlib.gunzipSync(tgz);
  const text = (b, start, length) => {
    const field = b.subarray(start, start + length);
    const nul = field.indexOf(0);

    return field.subarray(0, nul < 0 ? length : nul).toString('utf8');
  };
  const files = {};
  let offset = 0;
  let paxPath = null;

  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);

    if (header.every((b) => b === 0)) {
      break;
    }
    const size = parseInt(text(header, 124, 12).trim() || '0', 8);
    const type = header[156] ? String.fromCharCode(header[156]) : '0';
    const prefix = text(header, 257, 5) === 'ustar' ? text(header, 345, 155) : '';
    const body = buf.subarray(offset + 512, offset + 512 + size);

    offset += 512 + Math.ceil(size / 512) * 512;

    if (type === 'x') {
      paxPath = (/(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8')) || [])[1] || null;
      continue;
    }
    if (type !== '0') {
      paxPath = null;
      continue;
    }
    const name = paxPath || (prefix ? `${ prefix }/${ text(header, 0, 100) }` : text(header, 0, 100));

    paxPath = null;
    files[name.replace(/^[^/]+\//, '')] = body.toString('utf8');
  }

  return files;
}

let aiSkills = null; // { sha, files, checkedAt }
let aiSkillsInFlight = null;

async function aiSkillsSnapshot() {
  try {
    const map = await k8s(`/api/v1/namespaces/${ NAMESPACE }/configmaps/${ AI_SKILLS_SNAPSHOT }`);

    return JSON.parse(zlib.gunzipSync(Buffer.from(map.data['snapshot.json.gz.b64'], 'base64')).toString('utf8'));
  } catch {
    return null;
  }
}

async function saveAiSkillsSnapshot(snapshot) {
  const data = { 'snapshot.json.gz.b64': zlib.gzipSync(Buffer.from(JSON.stringify(snapshot))).toString('base64') };
  const p = `/api/v1/namespaces/${ NAMESPACE }/configmaps/${ AI_SKILLS_SNAPSHOT }`;

  try {
    await k8s(p, { method: 'PATCH', body: JSON.stringify({ data }) });
  } catch (e) {
    if (e.status !== 404) {
      throw e;
    }
    await k8s(`/api/v1/namespaces/${ NAMESPACE }/configmaps`, {
      method: 'POST',
      body:   JSON.stringify({
        apiVersion: 'v1', kind: 'ConfigMap', metadata: { namespace: NAMESPACE, name: AI_SKILLS_SNAPSHOT, labels: { 'dev.rancher.io/kind': 'ai-skills' } }, data,
      }),
    });
  }
}

/**
 * The repository's files at the branch's current commit. Checked at most once a minute, and only
 * downloaded when the commit moved. The last good copy is kept in a ConfigMap so a restart while
 * GitHub is unreachable still serves skills; with no copy at all this throws rather than serve a
 * seed without skills, because laying that out would empty every workspace's .claude.
 */
async function aiSkillsFiles(force = false) {
  if (!force && aiSkills && Date.now() - aiSkills.checkedAt < AI_SKILLS_CHECK_MS) {
    return aiSkills;
  }
  if (aiSkillsInFlight) {
    return aiSkillsInFlight;
  }
  aiSkillsInFlight = (async() => {
    try {
      const token = await githubToken();

      if (!token) {
        throw failure(503, 'No GitHub token is set, and the skills live in a private repository. Add one in the Dev extension\'s Settings.');
      }
      const headers = { authorization: `Bearer ${ token }`, 'user-agent': 'dev-extension' };
      const head = await fetch(`https://api.github.com/repos/${ AI_SKILLS_REPO }/commits/${ encodeURIComponent(AI_SKILLS_REF) }`, { headers: { ...headers, accept: 'application/vnd.github.sha' } });

      if (!head.ok) {
        throw failure(502, `GitHub could not resolve ${ AI_SKILLS_REPO }@${ AI_SKILLS_REF }: ${ head.status }`);
      }
      const sha = (await head.text()).trim();

      if (!aiSkills) {
        aiSkills = await aiSkillsSnapshot();
      }
      if (aiSkills?.sha === sha) {
        aiSkills.checkedAt = Date.now();

        return aiSkills;
      }
      const tarball = await fetch(`https://api.github.com/repos/${ AI_SKILLS_REPO }/tarball/${ sha }`, { headers: { ...headers, accept: 'application/vnd.github+json' } });

      if (!tarball.ok) {
        throw failure(502, `GitHub would not send ${ AI_SKILLS_REPO }@${ sha.slice(0, 12) }: ${ tarball.status }`);
      }
      const files = {};

      for (const [repoPath, content] of Object.entries(untar(Buffer.from(await tarball.arrayBuffer())))) {
        const key = seedKeyFor(repoPath);

        if (key) {
          files[key] = content;
        }
      }
      if (!Object.keys(files).some((k) => /^skills\/[^/]+\/SKILL\.md$/.test(k))) {
        throw failure(502, `${ AI_SKILLS_REPO }@${ sha.slice(0, 12) } has no skills under ${ AI_SKILLS_ROOT }/.claude/skills.`);
      }
      aiSkills = { sha, files, checkedAt: Date.now() };
      await saveAiSkillsSnapshot({ sha, files }).catch((e) => console.error('[dev-api] could not keep the ai-skills snapshot:', e.message || e));
      console.log(`[dev-api] skills from ${ AI_SKILLS_REPO }@${ sha.slice(0, 12) }: ${ Object.keys(files).length } files`);

      return aiSkills;
    } catch (e) {
      const last = aiSkills || await aiSkillsSnapshot();

      if (last) {
        console.error(`[dev-api] keeping skills from ${ last.sha.slice(0, 12) }: ${ e.message || e }`);
        aiSkills = { ...last, checkedAt: Date.now() };

        return aiSkills;
      }
      throw e.status ? e : failure(503, `The skills could not be fetched from ${ AI_SKILLS_REPO }: ${ e.message || e }`);
    } finally {
      aiSkillsInFlight = null;
    }
  })();

  return aiSkillsInFlight;
}

/** What the extension itself ships, without anything the repository owns. */
function shippedSeed() {
  const seed = bakedSeed();

  for (const key of Object.keys(seed)) {
    if (repoOwnsKey(key)) {
      delete seed[key];
    }
  }

  return seed;
}

function fnv(text) {
  let h = 2166136261;

  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }

  return (h >>> 0).toString(16);
}

let bakedVersion = '';

/**
 * A file of a skill that is not its SKILL.md: a script, a template, a manifest.
 *
 * A skill is a directory, and a third of them carry something beside the prose - `share.sh`,
 * `a11y-probe.mjs`, `rancher-share-app.yaml` - that the SKILL.md tells the agent to run. Editing
 * the prose and not the script it names is editing half the skill.
 *
 * Flat names only: no directory separators, and nothing that could climb out of the skill's own
 * folder. Everything in the repository is flat, and a ConfigMap key cannot hold a slash anyway.
 */
const SKILL_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Where one file's override is kept. SKILL.md keeps the key it has always had. */
function overrideKey(name, path) {
  return path === 'SKILL.md' ? `skill__${ name }` : `file__${ name }__${ path }`;
}

/** The overrides: SKILL.md text by skill, other files by `<skill>/<file>`, and the ConfigMap's version. */
async function skillOverrides() {
  try {
    const map = await k8s(`/api/v1/namespaces/${ NAMESPACE }/configmaps/${ SKILLS_MAP }`);
    const skills = {};
    const files = {};

    for (const [key, value] of Object.entries(map.data || {})) {
      const skill = /^skill__([a-z0-9-]+)$/.exec(key);
      const file = /^file__([a-z0-9-]+)__(.+)$/.exec(key);

      if (skill) {
        skills[skill[1]] = value;
      } else if (file && SKILL_FILE.test(file[2])) {
        files[`${ file[1] }/${ file[2] }`] = value;
      }
    }

    return { skills, files, version: map.metadata?.resourceVersion || '' };
  } catch (e) {
    if (e.status === 404) {
      return { skills: {}, files: {}, version: '' };
    }
    throw e;
  }
}

/** The seed the workspaces are laid out from: what shipped, the repository's files, then the edited skills. */
async function agentSeed() {
  const seed = { ...shippedSeed(), ...(await aiSkillsFiles()).files };
  const { skills, files } = await skillOverrides();

  for (const [name, content] of Object.entries(skills)) {
    seed[`skills/${ name }/SKILL.md`] = content;
  }
  for (const [path, content] of Object.entries(files)) {
    seed[`skills/${ path }`] = content;
  }

  return seed;
}

/** What the seed is now, for a workspace to compare its own copy against: shipped hash, repository commit, overrides. */
async function seedVersion() {
  if (!bakedVersion) {
    bakedVersion = fnv(JSON.stringify(shippedSeed()));
  }
  const { sha } = await aiSkillsFiles();
  const { version } = await skillOverrides();

  return `${ bakedVersion }+${ sha.slice(0, 12) }${ version ? `+${ version }` : '' }`;
}

function skillDescription(text) {
  const front = /^---\n([\s\S]*?)\n---/.exec(text || '');
  const line = front && /^description:\s*(.+)$/m.exec(front[1]);

  return line ? line[1].trim().slice(0, 300) : '';
}

async function listSkills() {
  const seed = (await aiSkillsFiles()).files;
  const { skills, files } = await skillOverrides();
  const names = Object.keys(seed).map((key) => /^skills\/([a-z0-9-]+)\/SKILL\.md$/.exec(key)?.[1]).filter(Boolean);

  for (const name of Object.keys(skills)) {
    if (!names.includes(name)) {
      names.push(name);
    }
  }

  return names.sort().map((name) => ({
    name,
    description: skillDescription(skills[name] ?? seed[`skills/${ name }/SKILL.md`]),
    overridden:  name in skills || Object.keys(files).some((path) => path.startsWith(`${ name }/`)),
    // How many files the skill carries beside its prose, so the list can say so without
    // reading every skill.
    files:       skillFileNames(name, seed, files).length,
  }));
}

/** The names of one skill's supporting files: what the repository ships, plus anything edited here. */
function skillFileNames(name, seed, overrides) {
  const found = new Set();

  for (const key of Object.keys(seed)) {
    const m = new RegExp(`^skills/${ name }/(.+)$`).exec(key);

    if (m && m[1] !== 'SKILL.md' && SKILL_FILE.test(m[1])) {
      found.add(m[1]);
    }
  }
  for (const key of Object.keys(overrides)) {
    const m = new RegExp(`^${ name }/(.+)$`).exec(key);

    if (m && m[1] !== 'SKILL.md') {
      found.add(m[1]);
    }
  }

  return [...found].sort();
}

async function readSkill(name) {
  if (!SKILL_NAME.test(name)) {
    throw failure(400, 'Not a skill name.');
  }
  const seed = (await aiSkillsFiles()).files;
  const baked = seed[`skills/${ name }/SKILL.md`] || '';
  const { skills, files } = await skillOverrides();

  if (!baked && !(name in skills)) {
    throw failure(404, `There is no skill called ${ name }.`);
  }

  return {
    name,
    content:    skills[name] ?? baked,
    baked,
    overridden: name in skills,
    // The scripts and manifests the prose tells the agent to run, each with the same three
    // facts as the prose itself: what it is now, what shipped, and whether those differ.
    files:      skillFileNames(name, seed, files).map((path) => ({
      path,
      content:    files[`${ name }/${ path }`] ?? seed[`skills/${ name }/${ path }`] ?? '',
      baked:      seed[`skills/${ name }/${ path }`] || '',
      overridden: `${ name }/${ path }` in files,
    })),
  };
}

// ── Focus ───────────────────────────────────────────────────────────────────────────────────
//
// One ConfigMap, three keys. Written whole rather than merged key by key, because the three are
// edited one at a time by whoever is editing them - the weights panel writes weights, the card
// editor writes cards - and a PUT carrying one of them must not drop the other two.

const FOCUS_MAP = process.env.DEV_FOCUS_MAP || 'dev-focus';

async function readFocus() {
  try {
    const map = await k8s(`/api/v1/namespaces/${ NAMESPACE }/configmaps/${ FOCUS_MAP }`);
    const read = (key) => {
      try {
        return JSON.parse(map.data?.[key] || 'null');
      } catch {
        return null;
      }
    };

    return {
      cards:   read('cards.json'),
      weights: read('weights.json'),
      tasks:   read('tasks.json'),
      /*
       * Which repositories the queue may look in.
       *
       * The personal searches behind the queue - `author:@me`, `assignee:@me`,
       * `review-requested:@me` - mean something across the whole of GitHub, so with nothing here
       * the deck fills with work from every repository the person has ever touched. Empty means
       * all of them, which is what it did before anyone could say otherwise.
       */
      repos:   read('repos.json'),
      version: map.metadata?.resourceVersion || '',
    };
  } catch (e) {
    if (e.status === 404) {
      return {
        cards: null, weights: null, tasks: null, version: '',
      };
    }
    throw e;
  }
}

async function writeFocus(body) {
  const data = {};

  if (Array.isArray(body?.cards)) {
    data['cards.json'] = JSON.stringify(body.cards, null, 2);
  }
  if (body?.weights && typeof body.weights === 'object') {
    data['weights.json'] = JSON.stringify(body.weights, null, 2);
  }
  if (Array.isArray(body?.tasks)) {
    data['tasks.json'] = JSON.stringify(body.tasks, null, 2);
  }
  if (Array.isArray(body?.repos)) {
    // `owner/name` only: anything else is a search qualifier somebody typed by accident, and a
    // malformed one makes GitHub reject the whole query rather than ignore the bad part.
    data['repos.json'] = JSON.stringify(body.repos.filter((repo) => /^[\w.-]+\/[\w.-]+$/.test(String(repo || '').trim())), null, 2);
  }
  if (!Object.keys(data).length) {
    throw failure(400, 'Nothing to write: send weights, tasks or repos.');
  }

  const p = `/api/v1/namespaces/${ NAMESPACE }/configmaps/${ FOCUS_MAP }`;

  try {
    await k8s(p, { method: 'PATCH', body: JSON.stringify({ data }) });
  } catch (e) {
    if (e.status !== 404) {
      throw e;
    }
    await k8s(`/api/v1/namespaces/${ NAMESPACE }/configmaps`, {
      method: 'POST',
      body:   JSON.stringify({
        apiVersion: 'v1', kind: 'ConfigMap', metadata: { namespace: NAMESPACE, name: FOCUS_MAP, labels: { 'dev.rancher.io/kind': 'focus' } }, data,
      }),
    });
  }

  return { ok: true, ...(await readFocus()) };
}

// ── The spec ─────────────────────────────────────────────────────────────────────
//
// This API is used by agents, and an agent given a URL and a sentence invents the rest. So the
// routes describe themselves. There was no OpenAPI document here before this one - nothing in the
// repository matched `openapi` or `swagger` - so it starts with the routes an agent needs today,
// and the others get described as they are touched rather than in one unverifiable sweep.
//
// Served, not generated at build time, because it has to agree with `routes` in this same file:
// a spec kept somewhere else is a spec that drifts the first time a path changes.

const OPENAPI = {
  openapi: '3.1.0',
  info:    {
    title:       'Dev extension API',
    version:     '1',
    description: 'Workspaces, the harness my-work routes, and the Focus deck\'s cards. Served by the dev-api Deployment in dev-system.',
  },
  paths: {
    '/conversations': {
      get: {
        operationId: 'readConversations',
        summary:     'Every conversation in the Studio\'s agent pod, and what it is doing.',
        description: [
          'Written by a loop in this pod (reconcileConversations), not by a browser - which is the',
          'point, since every other read of a conversation is an exec a tab issues. So this is also',
          'the answer to "what finished while nothing was open".',
          '',
          '`stops` and `asks` are how many times each conversation has ended a turn and asked for',
          'something, ever. Store them, compare them, and you know how many you missed. They say how',
          'many and never what; for that, read /conversations/{id}/events.',
          '',
          '`stale: true` means the loop has stopped and the states are history. `ok: false` means the',
          'last listing failed, so every state is as the listing before it left them: old rather',
          'than wrong, and `watchedAt` says how old.',
        ].join('\n'),
        parameters: [
          { name: 'workspace', in: 'query', schema: { type: 'string' }, description: 'Only that workspace\'s conversations.' },
          { name: 'state', in: 'query', schema: { type: 'string' }, description: 'Comma separated: working, input, idle, finished, none, gone.' },
        ],
        responses: { 200: { description: 'The conversations, newest change first, and the watcher\'s own freshness.' } },
      },
    },
    '/conversations/{id}/events': {
      parameters: [{
        name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: '`agent-<n>` or `p-<workspace>-<n>`.',
      }],
      get: {
        operationId: 'readConversationEvents',
        summary:     'One conversation\'s hook firings, newest first.',
        description: 'Read off the hook\'s own log in the agent pod\'s volume, which it already keeps and already trims. `mount: false` means this API cannot see that volume.',
        responses:   { 200: { description: 'The firings.' } },
      },
    },
    '/conversations/refresh': {
      post: {
        operationId: 'refreshConversations',
        summary:     'Run one listing now rather than waiting for the next tick.',
        description: 'For a caller that has just started or ended a conversation. One listing in flight at a time, however many callers press it.',
        responses:   { 200: { description: 'The snapshot, after the listing.' } },
      },
    },
    '/focus': {
      get: {
        operationId: 'readFocus',
        summary:     'The Focus document: queue weights and hand-written tasks.',
        description: 'Cards are not in here. A card is a module - bundled with the extension, or held in its own ConfigMap under /focus/cards.',
        responses:   { 200: { description: 'The document.' } },
      },
      put: {
        operationId: 'writeFocus',
        summary:     'Write weights or tasks. Each key is optional; the others keep what they were.',
        responses:   { 200: { description: 'The document as written.' }, 400: { description: 'Nothing to write.' } },
      },
    },
    '/focus/cards': {
      get: {
        operationId: 'listCards',
        summary:     'Every card somebody has edited, newest first.',
        description: 'Only the edited ones. A card not listed here is whatever the extension ships, which is the normal case.',
        responses:   { 200: { description: 'ids, versions and sizes.' } },
      },
    },
    '/focus/cards/{id}': {
      parameters: [{
        name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$' }, description: "The card's id, as declared inside the module.",
      }],
      get: {
        operationId: 'readCard',
        summary:     "One card's module source, or an empty string when it is the shipped one.",
        responses:   { 200: { description: '{ id, source, version }' } },
      },
      put: {
        operationId: 'writeCard',
        summary:     'Write a card. It takes effect in any open deck within a couple of seconds, with no reload.',
        description: [
          'A card is a CommonJS module. The minimum:',
          '',
          "  module.exports = {",
          "    id: 'my-card',",
          "    label: 'What this card is', kind: 'review', summary: '{why}',",
          "    rules: ['some-rule-id'],",
          "    wants: ['stat'],",
          "    template: '<CardSurface :api=\"api\" />',",
          "    setup(api) { return { api }; },",
          "    actions: [{ label: 'Open it', verb: 'url' }],",
          "  };",
          '',
          '`rules` is the join to the queue and a card without them never reaches the deck. `require`',
          'reaches any module in the extension; Vue is handed in as `api.vue` rather than imported.',
          'Refused unless it exports something, claims rules and draws something.',
        ].join('\n'),
        requestBody: {
          required: true,
          content:  {
            'application/json': {
              schema: {
                type: 'object', required: ['source'], properties: { source: { type: 'string', description: 'The module, as text.' } },
              },
            },
          },
        },
        responses: { 200: { description: 'The card as written.' }, 400: { description: 'Why it was refused.' } },
      },
      delete: {
        operationId: 'deleteCard',
        summary:     'Drop the edit and go back to the card the extension ships.',
        responses:   { 200: { description: 'Dropped.' } },
      },
    },
    /*
     * The three CI routes, described because the third one is new and the other two are what it
     * is reached through: an agent - or a card - that has a pull request number and nothing else
     * has to get from "it is red" to a check id to a job's log, and that is three calls in order.
     */
    '/my-work/pr/{num}/ci': {
      parameters: [{
        name: 'num', in: 'path', required: true, schema: { type: 'integer' }, description: 'The pull request number.',
      }, {
        name: 'repo', in: 'query', schema: { type: 'string' }, description: 'owner/name. Defaults to rancher/dashboard.',
      }],
      get: {
        operationId: 'ciFailures',
        summary:     'Every failing check on the head commit, with what each one said about itself.',
        description: [
          'Failures only: a passing check has nothing to report and forty of them said at length is',
          'noise. `id` is what the two routes below take. `jobId` is the Actions job behind the',
          'check where there is one, and a check with one has a log to read; a `status` context -',
          'posted by a bot rather than run as a job - has neither a job nor a log.',
        ].join('\n'),
        responses: { 200: { description: '{ pr, sha, checks: [{ id, kind, name, conclusion, url, title, summary, annotations, jobId }] }' } },
      },
    },
    '/my-work/pr/{num}/ci/{checkId}': {
      parameters: [{
        name: 'num', in: 'path', required: true, schema: { type: 'integer' }, description: 'The pull request number.',
      }, {
        name: 'checkId', in: 'path', required: true, schema: { type: 'integer' }, description: "A check run's id, as /ci lists it.",
      }, {
        name: 'repo', in: 'query', schema: { type: 'string' }, description: 'owner/name. Defaults to rancher/dashboard.',
      }],
      get: {
        operationId: 'ciFailureDetail',
        summary:     'What one failing check actually printed: its annotations, and the failure out of its log.',
        description: [
          'The log is not returned whole - a CI log is megabytes of installs and passes - but as the',
          'window around the first thing that looks like a failure. In `log`:',
          '',
          '  text      the window, timestamps and ANSI colour already stripped',
          '  at        where the window starts in the retained log, 1-based',
          '  hits      lines of `text`, 1-based, that look like the failure itself',
          '  lines     how long the whole retained log is, so `text` can be placed in it',
          '  matched   false where nothing looked like a failure and `text` is the last lines instead',
          '',
          '`annotations` is GitHub\'s own idea of where it broke - a path, a line and a message -',
          'with the "Process completed with exit code 1" rows dropped, and the failures sorted first.',
          'Null `log` means the check is not an Actions job, in which case `summary` is all there is.',
        ].join('\n'),
        responses: { 200: { description: '{ pr, check, annotations, log }' } },
      },
    },
    '/my-work/pr/{num}/ci/{checkId}/log': {
      parameters: [{
        name: 'num', in: 'path', required: true, schema: { type: 'integer' }, description: 'The pull request number.',
      }, {
        name: 'checkId', in: 'path', required: true, schema: { type: 'integer' }, description: "A check run's id, as /ci lists it.",
      }, {
        name: 'repo', in: 'query', schema: { type: 'string' }, description: 'owner/name. Defaults to rancher/dashboard.',
      }],
      get: {
        operationId: 'ciFailureLog',
        summary:     "The whole of the job's log, cleaned and numbered the same way the excerpt is.",
        description: [
          'For reading past the excerpt. Up to a quarter of a megabyte - the *end* of the log, which',
          'is where a failure is - so ask for it when somebody is going to read it, not for every',
          'failing check on a page. The line numbers agree with the `at` and `hits` of the excerpt',
          'above, which is what lets a reader open this on the line they were already looking at.',
          '`truncated` says the job printed more than is kept, so line 1 is wherever the kept tail',
          'begins rather than the start of the job. `jobId` is null, and the text empty, for a check',
          'that is not an Actions job.',
        ].join('\n'),
        responses: { 200: { description: '{ pr, check, name, url, jobId, text, lines, hits, truncated }' } },
      },
    },
    '/workspace/{name}/media': {
      parameters: [{
        name: 'name', in: 'path', required: true, schema: { type: 'string' },
      }],
      get: {
        operationId: 'listArtifacts',
        summary:     "Everything under a workspace's artifacts directory, newest first.",
        description: "What an agent left behind: recordings, screenshots, logs, reports. `?media=1` returns only the images and videos, which is what the review panel asks for. One file is fetched from the same path plus `/<its path>`.",
        responses:   { 200: { description: '{ files: [{ path, name, type, size, mtimeMs }] }' } },
      },
    },
  },
};

// ── Cards ──────────────────────────────────────────────────────────────────────────────
//
// A card is a module, and a card somebody has edited is one ConfigMap: `dev-card-<id>`, labelled
// so the browser can watch the set rather than poll a list of names. One map per card buys a
// resourceVersion per card, no shared 1MiB ceiling and no sibling to corrupt - see focus-cards.ts
// in the extension, which reads these.
//
// These routes exist because the agents edit cards. "Make me a card for X" should end in a PUT
// here rather than a pull request against the extension, and an agent is pointed at
// /openapi.json rather than at this file.

const CARD_LABEL_KEY = 'dev.rancher.io/kind';
const CARD_LABEL_VALUE = 'focus-card';
const CARD_KEY = 'card.js';
const CARD_ID = /^[a-z0-9][a-z0-9-]*$/;

const cardMapName = (id) => `dev-card-${ id }`;

function cardId(id) {
  if (!CARD_ID.test(String(id || ''))) {
    throw failure(400, 'A card id is lower-case letters, digits and dashes.');
  }

  return String(id);
}

/** Every card somebody has edited, newest first. Not the bundled ones: those are in the image. */
async function listCards() {
  const selector = encodeURIComponent(`${ CARD_LABEL_KEY }=${ CARD_LABEL_VALUE }`);
  const list = await k8s(`/api/v1/namespaces/${ NAMESPACE }/configmaps?labelSelector=${ selector }`);

  return {
    cards: (list.items || []).map((map) => ({
      id:      String(map.metadata?.name || '').replace(/^dev-card-/, ''),
      version: map.metadata?.resourceVersion || '',
      changed: map.metadata?.creationTimestamp || '',
      bytes:   String(map.data?.[CARD_KEY] || '').length,
    })).sort((a, b) => String(b.changed).localeCompare(String(a.changed))),
  };
}

async function readCard(id) {
  const card = cardId(id);

  try {
    const map = await k8s(`/api/v1/namespaces/${ NAMESPACE }/configmaps/${ cardMapName(card) }`);

    return { id: card, source: String(map.data?.[CARD_KEY] || ''), version: map.metadata?.resourceVersion || '' };
  } catch (e) {
    if (e.status === 404) {
      // Not an error: it means this card is whatever the extension ships, which is the normal case.
      return { id: card, source: '', version: '' };
    }
    throw e;
  }
}

/**
 * Write a card.
 *
 * Checked here and not only in the browser, because the browser is not the only writer: an agent
 * posting a card with no `module.exports` would otherwise get a card that loads to an error
 * message with no hint which end was wrong. These three are what make a module a card at all - it
 * exports something, it claims rules, it draws something - and they are cheap to check on text.
 * Anything subtler is the loader's job and shows on the card itself.
 */
async function writeCard(id, body) {
  const card = cardId(id);
  const source = String(body?.source ?? '');

  if (!source.trim()) {
    throw failure(400, 'Nothing to write: send { "source": "module.exports = { ... }" }.');
  }
  if (!/module\.exports\s*=/.test(source)) {
    throw failure(400, 'A card is a CommonJS module: it has to `module.exports = { ... }`.');
  }
  if (!/\brules\s*:/.test(source)) {
    throw failure(400, 'A card needs `rules`, the rule ids whose work it draws. Without them it claims nothing and never reaches the deck.');
  }
  if (!/\b(?:template|component)\s*:/.test(source)) {
    throw failure(400, 'A card needs `template` (or `component`): the body it draws.');
  }

  // Either quote. It was `'` only, and a card written `id: "other"` was accepted under another
  // name - caught by the test for this check, which is the sort of thing the check exists for.
  const declared = /\bid\s*:\s*['"]([^'"]+)['"]/.exec(source);

  if (declared && declared[1] !== card) {
    throw failure(400, `This card declares id '${ declared[1] }' but is being written as '${ card }'. The deck matches on the declared id, so the two have to agree.`);
  }

  const name = cardMapName(card);
  const data = { [CARD_KEY]: source };
  const metadata = { labels: { [CARD_LABEL_KEY]: CARD_LABEL_VALUE } };
  const where = `/api/v1/namespaces/${ NAMESPACE }/configmaps/${ name }`;

  try {
    await k8s(where, { method: 'PATCH', body: JSON.stringify({ metadata, data }) });
  } catch (e) {
    if (e.status !== 404) {
      throw e;
    }
    await k8s(`/api/v1/namespaces/${ NAMESPACE }/configmaps`, {
      method: 'POST',
      body:   JSON.stringify({
        apiVersion: 'v1', kind: 'ConfigMap', metadata: { name, namespace: NAMESPACE, ...metadata }, data,
      }),
    });
  }

  return { ok: true, ...(await readCard(card)) };
}

/** Drop the edit. The extension puts the bundled card back in its place; see `forget` there. */
async function deleteCard(id) {
  const card = cardId(id);

  try {
    await k8s(`/api/v1/namespaces/${ NAMESPACE }/configmaps/${ cardMapName(card) }`, { method: 'DELETE' });
  } catch (e) {
    if (e.status !== 404) {
      throw e;
    }
  }

  return { ok: true, id: card, source: '' };
}

/** The edited prompt templates, by the action's key: what a button sends before the variables go in. */
async function promptOverrides() {
  try {
    const map = await k8s(`/api/v1/namespaces/${ NAMESPACE }/configmaps/${ SKILLS_MAP }`);
    const out = {};

    for (const [key, value] of Object.entries(map.data || {})) {
      const m = /^prompt__([a-z0-9-]+)$/.exec(key);

      if (m) {
        out[m[1]] = value;
      }
    }

    return out;
  } catch (e) {
    if (e.status === 404) {
      return {};
    }
    throw e;
  }
}

async function writeConfigValue(key, value) {
  const p = `/api/v1/namespaces/${ NAMESPACE }/configmaps/${ SKILLS_MAP }`;

  try {
    await k8s(p, { method: 'PATCH', body: JSON.stringify({ data: { [key]: value } }) });
  } catch (e) {
    if (e.status !== 404 || value === null) {
      throw e;
    }
    await k8s(`/api/v1/namespaces/${ NAMESPACE }/configmaps`, {
      method: 'POST',
      body:   JSON.stringify({
        apiVersion: 'v1', kind: 'ConfigMap', metadata: { namespace: NAMESPACE, name: SKILLS_MAP, labels: { 'dev.rancher.io/kind': 'skills' } }, data: { [key]: value },
      }),
    });
  }
}

async function writeSkillOverride(name, content, path = 'SKILL.md') {
  const p = `/api/v1/namespaces/${ NAMESPACE }/configmaps/${ SKILLS_MAP }`;
  const data = { [overrideKey(name, path)]: content };

  try {
    await k8s(p, { method: 'PATCH', body: JSON.stringify({ data }) });
  } catch (e) {
    if (e.status !== 404) {
      throw e;
    }
    await k8s(`/api/v1/namespaces/${ NAMESPACE }/configmaps`, {
      method: 'POST',
      body:   JSON.stringify({
        apiVersion: 'v1', kind: 'ConfigMap', metadata: { namespace: NAMESPACE, name: SKILLS_MAP, labels: { 'dev.rancher.io/kind': 'skills' } }, data,
      }),
    });
  }
}

/** The file committed to the skills repository, on the branch every workspace is laid out from. */
async function commitSkill(name, content, message, path = 'SKILL.md') {
  const filePath = `${ AI_SKILLS_ROOT }/.claude/skills/${ name }/${ path }`;
  let sha = '';

  try {
    const current = await ghRest('GET', `/repos/${ AI_SKILLS_REPO }/contents/${ filePath }?ref=${ encodeURIComponent(AI_SKILLS_REF) }`);

    sha = current.sha || '';
    if (Buffer.from(current.content || '', 'base64').toString('utf8') === content) {
      return { committed: false, url: current.html_url || '' };
    }
  } catch (e) {
    if (e.status !== 502 || !/-> 404/.test(e.message)) {
      throw e;
    }
  }
  const result = await ghRest('PUT', `/repos/${ AI_SKILLS_REPO }/contents/${ filePath }`, {
    message: message || `Skill ${ name }: ${ path === 'SKILL.md' ? 'updated' : `${ path } updated` } from the Dev extension`,
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch:  AI_SKILLS_REF,
    ...(sha ? { sha } : {}),
  });

  return { committed: true, url: result.commit?.html_url || result.content?.html_url || '' };
}

/**
 * Save one file of a skill: the override for every workspace, and - when asked - the commit to
 * the repo. Saving the shipped text back drops the override rather than keeping a copy of it.
 *
 * `path` is SKILL.md unless something says otherwise, which is what keeps every caller written
 * before a skill had more than prose in it working unchanged.
 */
async function saveSkill(name, body) {
  if (!SKILL_NAME.test(name)) {
    throw failure(400, 'Not a skill name.');
  }
  const path = String(body?.path || 'SKILL.md');

  if (path !== 'SKILL.md' && !SKILL_FILE.test(path)) {
    throw failure(400, `${ path } is not a file of a skill.`);
  }
  const content = String(body?.content || '');

  if (!content.trim()) {
    throw failure(400, `${ path === 'SKILL.md' ? 'The skill' : path } is empty.`);
  }
  const key = `skills/${ name }/${ path }`;
  const baked = (await aiSkillsFiles()).files[key] || '';

  if (content === baked) {
    await dropSkillOverride(name, path);
  } else {
    await writeSkillOverride(name, content, path);
  }
  const commit = body?.commit ? await commitSkill(name, content, String(body?.message || ''), path) : null;

  // Committed, the repository has the text, so the override is a copy of it: pull the new commit
  // and let the override go, or the page keeps calling a committed skill "edited".
  if (commit) {
    const fresh = await aiSkillsFiles(true).catch(() => null);

    if (fresh?.files[key] === content) {
      await dropSkillOverride(name, path);
    }
  }

  const { skills, files } = await skillOverrides();

  return {
    ok:         true,
    overridden: path === 'SKILL.md' ? name in skills : `${ name }/${ path }` in files,
    commit,
    version:    await seedVersion(),
  };
}

async function dropSkillOverride(name, path = 'SKILL.md') {
  try {
    await k8s(`/api/v1/namespaces/${ NAMESPACE }/configmaps/${ SKILLS_MAP }`, { method: 'PATCH', body: JSON.stringify({ data: { [overrideKey(name, path)]: null } }) });
  } catch (e) {
    if (e.status !== 404) {
      throw e;
    }
  }
}

/**
 * The workspace a PR's review ran in, from its run record. Remembered as the record is read or
 * written, because the callers that want it are synchronous; a PR whose run has not been read
 * yet answers null, and its evidence is then found by looking in every workspace instead.
 */
const reviewProjects = new Map();

function reviewWorkspace(num) {
  return reviewProjects.get(Number(num)) || null;
}

function rememberReviewWorkspace(num, run) {
  if (run?.project) {
    reviewProjects.set(Number(num), run.project);
  }
}

const ARTIFACT_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.webm': 'video/webm', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
  '.log': 'text/plain', '.txt': 'text/plain', '.json': 'application/json', '.md': 'text/markdown',
};

function extOf(name) {
  const dot = name.lastIndexOf('.');

  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

function attachmentKind(name) {
  const type = ARTIFACT_TYPES[extOf(name)] || '';

  return type.startsWith('image/') ? 'image' : type.startsWith('video/') ? 'video' : 'file';
}

/**
 * A path an agent wrote (`/workspaces/<name>/artifacts/x.webm`, or relative to it) as a file
 * here, or null. Looked for in the PR's own workspace first, then in any workspace, then in the
 * agent pod's directory, which is where a review ran before workspaces were the harness's
 * containers.
 *
 * Both spellings of the root are stripped: a workspace's tree is at `/workspaces/<name>` now,
 * and evidence recorded when it was `/workspace` is still worth finding.
 */
function artifactFile(given, num = null) {
  const rel = String(given || '')
    .replace(/^\/?workspaces\/[^/]+\//, '')
    .replace(/^\/?workspace\//, '')
    .replace(/^\/+/, '');

  if (!rel || rel.split('/').includes('..')) {
    return null;
  }

  const roots = [];
  const own = num ? reviewWorkspace(num) : null;

  if (own) {
    roots.push(`${ WORKSPACES_ROOT }/${ own }`);
  }
  try {
    for (const name of fs.readdirSync(WORKSPACES_ROOT)) {
      if (name !== own) {
        roots.push(`${ WORKSPACES_ROOT }/${ name }`);
      }
    }
  } catch { /* no workspaces mounted */ }
  roots.push(AGENT_ROOT);

  for (const root of roots) {
    const full = `${ root }/${ rel }`;

    try {
      if (fs.statSync(full).isFile()) {
        return full;
      }
    } catch { /* not there */ }
  }

  return null;
}

// ---------------------------------------------------------------------------
// A comment's evidence, uploaded to GitHub for real.
//
// A screenshot or a recording cannot go up with an API token: `user-attachments`
// is a browser flow - a CSRF token that only the classic comment box renders, a
// policy call, a POST to the bucket it names, then a confirm. The one thing here
// holding a github.com session is the shared browser in `extension-studio`, which
// a person signs in once (see the Conversations page). So this pod reads the file
// off the mounted workspace and runs GitHub's own flow *inside a page of that
// browser*, where the cookies already are.
//
// Over raw CDP rather than playwright, which is not installed here and would be
// most of a gigabyte to add for one call. Node 24's global WebSocket drives a
// single tab well enough, and the page-side half is the same script the
// `my-pr-create` skill runs (codyrancher/ai-skills, rancher-dashboard/.claude/skills/my-pr-create/upload-github-assets.mjs)
// - keep the two in step.

const GITHUB_BROWSER_CDP = process.env.GITHUB_BROWSER_CDP || 'http://github-browser.dev-system.svc.cluster.local:9222';

// GitHub rejects the policy request when the extension and the content type disagree, so every
// extension we upload needs an entry here.
const UPLOAD_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.webm': 'video/webm', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
};

/**
 * Uploads already done, so submitting a review twice does not send the bytes again.
 *
 * Keyed by what makes a file that file - its path, size and mtime - rather than by the comment
 * it hangs off, because the same recording is routinely attached to more than one comment.
 */
const uploadCache = new Map();

/**
 * Chromium's CDP refuses a Host header that is not localhost or an IP: its anti DNS-rebinding
 * guard. The shared browser is reached by service name across the cluster, so resolve it first.
 */
async function cdpBase() {
  const parsed = new URL(GITHUB_BROWSER_CDP);

  if (parsed.hostname !== 'localhost' && !/^[0-9.]+$/.test(parsed.hostname)) {
    const { lookup } = await import('node:dns/promises');

    parsed.hostname = (await lookup(parsed.hostname)).address;
  }

  return parsed.origin;
}

/** One CDP session on one target: send a command, wait for its id to come back. */
function cdpSession(wsUrl) {
  const socket = new WebSocket(wsUrl);
  const pending = new Map();
  let seq = 0;

  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('The shared GitHub browser refused a CDP connection.')), { once: true });
  });

  const listeners = new Map();

  socket.addEventListener('message', (event) => {
    let msg;

    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    const waiter = msg.id && pending.get(msg.id);

    if (waiter) {
      pending.delete(msg.id);
      msg.error ? waiter.reject(new Error(msg.error.message || 'CDP error')) : waiter.resolve(msg.result);

      return;
    }
    // An event rather than a reply: whoever asked for this method hears it.
    for (const fn of listeners.get(msg.method) || []) {
      try {
        fn(msg.params || {});
      } catch { /* a listener's own fault, not the socket's */ }
    }
  });

  return {
    /** Hear a CDP event - `Network.responseReceived` and friends. */
    on(method, fn) {
      listeners.set(method, [...(listeners.get(method) || []), fn]);
    },
    async send(method, params = {}) {
      await ready;
      const id = ++seq;

      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
        setTimeout(() => {
          if (pending.delete(id)) {
            reject(new Error(`${ method } timed out against the shared GitHub browser.`));
          }
        }, 120_000);
      });
    },
    close() {
      try {
        socket.close();
      } catch { /* already gone */ }
    },
  };
}

/** Evaluate an async function in the page and return its value, surfacing a thrown Error. */
async function evaluate(session, fn, arg) {
  const result = await session.send('Runtime.evaluate', {
    expression:    `(${ fn.toString() })(${ JSON.stringify(arg) })`,
    awaitPromise:  true,
    returnByValue: true,
  });

  if (result.exceptionDetails) {
    const thrown = result.exceptionDetails.exception;

    throw new Error(thrown?.description || thrown?.value || result.exceptionDetails.text || 'The page threw.');
  }

  return result.result?.value;
}

/**
 * The page-side half. Runs in the shared browser on a PR page, where the classic comment box has
 * rendered the one CSRF token `/upload/policies/assets` accepts - the generic per-form
 * `authenticity_token` is rejected with an HTML error page, which is why this asks for
 * `input.js-data-upload-policy-url-csrf` by name.
 */
const UPLOAD_IN_PAGE = async({ b64, name, ct }) => {
  const token = document.querySelector('input.js-data-upload-policy-url-csrf')?.value;

  if (!token) {
    throw new Error('no js-data-upload-policy-url-csrf token on the page - is the shared browser signed in to GitHub?');
  }

  const repoId = document.querySelector('file-attachment[data-upload-repository-id]')?.getAttribute('data-upload-repository-id')
    || document.querySelector('meta[name="octolytics-dimension-repository_id"]')?.content;
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const polForm = new FormData();

  polForm.append('name', name);
  polForm.append('size', String(bytes.length));
  polForm.append('content_type', ct);
  polForm.append('repository_id', String(repoId));
  polForm.append('authenticity_token', token);

  const polResp = await fetch('/upload/policies/assets', { method: 'POST', headers: { Accept: 'application/json' }, body: polForm });

  if (!polResp.ok) {
    throw new Error(`policy ${ polResp.status }: ${ (await polResp.text()).slice(0, 300) }`);
  }
  const pol = await polResp.json();
  const form = new FormData();

  for (const [k, v] of Object.entries(pol.form)) {
    form.append(k, String(v));
  }
  form.append('file', new Blob([bytes], { type: ct }), name);

  const upResp = await fetch(pol.upload_url, { method: 'POST', body: form, mode: 'cors' });

  if (!upResp.ok) {
    throw new Error(`upload ${ upResp.status }: ${ (await upResp.text()).slice(0, 200) }`);
  }

  // Without the confirm the asset stays unconfirmed and its href 404s later, once the comment
  // carrying it is already public.
  if (pol.asset_upload_url) {
    const body = new FormData();

    body.append('authenticity_token', pol.asset_upload_authenticity_token);

    const confirm = await fetch(pol.asset_upload_url, { method: 'PUT', headers: { Accept: 'application/json' }, body });

    if (!confirm.ok) {
      throw new Error(`confirm ${ confirm.status }`);
    }
  }

  return pol.asset.href;
};

const assetCache = new Map();

const ASSET_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * One attachment OUT of `user-attachments`.
 *
 * On a public repository the asset is a redirect to a signed S3 URL that anyone may follow, so
 * this pod fetches it itself - as a browser, since GitHub answers 404 to a bare client. What
 * that cannot reach (a private repository, an asset only a session may see) falls back to the
 * shared signed-in browser, the same one the upload uses; there the bytes come back over CDP,
 * so only small ones (8 MB) - a big recording is meant to be opened on GitHub.
 */
async function fetchGithubAsset(assetUrl) {
  const kept = assetCache.get(assetUrl);

  if (kept && Date.now() - kept.at < 10 * 60_000) {
    return kept.value;
  }

  try {
    const direct = await fetch(assetUrl, {
      redirect: 'follow',
      headers:  { 'user-agent': ASSET_UA, accept: 'image/avif,image/webp,image/*,video/*,*/*' },
    });
    const type = direct.headers.get('content-type') || '';

    // A 404 comes back as GitHub's own HTML page, which is not the attachment.
    if (direct.ok && !/text\/html/.test(type)) {
      const value = { type: type || 'application/octet-stream', body: Buffer.from(await direct.arrayBuffer()) };

      assetCache.set(assetUrl, { at: Date.now(), value });

      return value;
    }
    await direct.body?.cancel?.();
  } catch { /* the browser below is the other way */ }

  const base = await cdpBase();
  const opened = await fetch(`${ base }/json/new?${ encodeURIComponent('https://github.com/') }`, { method: 'PUT' })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`the shared GitHub browser would not open a tab (${ r.status })`))));
  const session = cdpSession(opened.webSocketDebuggerUrl);

  try {
    // The page cannot fetch it: the asset redirects to a signed URL on another origin that
    // sends no CORS headers, so a page-side `fetch` fails whatever its credentials. The
    // browser's own network has no such rule - so the tab is navigated to the asset and the
    // response body is read out of the network log, redirects and cookies included.
    await session.send('Network.enable');
    await session.send('Page.enable');

    let main = '';
    let status = 0;
    let type = '';
    const finished = new Promise((resolve) => {
      session.on('Network.responseReceived', (p) => {
        if (p.type === 'Document' || p.requestId === main) {
          main = p.requestId;
          status = p.response?.status || 0;
          type = p.response?.mimeType || '';
        }
      });
      session.on('Network.loadingFinished', (p) => {
        if (p.requestId === main) {
          resolve(p.encodedDataLength || 0);
        }
      });
      session.on('Network.loadingFailed', (p) => {
        if (p.requestId === main) {
          resolve(-1);
        }
      });
      setTimeout(() => resolve(-2), 60_000);
    });

    await session.send('Page.navigate', { url: assetUrl });
    const size = await finished;

    if (size === -2) {
      throw failure(504, 'the shared browser did not finish loading the attachment');
    }
    if (size === -1 || (status && status >= 400)) {
      throw failure(502, `GitHub asset -> ${ status || 'load failed' }`);
    }
    if (size > 8 * 1024 * 1024) {
      const value = { type, body: null, tooBig: size };

      assetCache.set(assetUrl, { at: Date.now(), value });

      return value;
    }
    const got = await session.send('Network.getResponseBody', { requestId: main });
    const value = { type, body: Buffer.from(got.body || '', got.base64Encoded ? 'base64' : 'utf8') };

    assetCache.set(assetUrl, { at: Date.now(), value });

    return value;
  } finally {
    session.close();
    await fetch(`${ base }/json/close/${ opened.id }`).catch(() => {});
  }
}

/**
 * One file to `user-attachments`, through the shared browser, as the `user-attachments` href.
 *
 * `hostUrl` is any page of the repo that still renders the classic uploader - the PR's own page.
 * The viewport is forced because the shared browser's display can be 1x1 when nobody is watching
 * it, and GitHub then serves a mobile layout with no uploader at all.
 */
async function uploadToGithub(file, hostUrl) {
  const stat = fs.statSync(file);
  const key = `${ file }:${ stat.size }:${ stat.mtimeMs }`;

  if (uploadCache.has(key)) {
    return { href: uploadCache.get(key), cached: true };
  }

  const name = path.basename(file);
  const ct = UPLOAD_TYPES[extOf(file)];

  if (!ct) {
    throw new Error(`${ name } is not an image or a recording, so it cannot be uploaded.`);
  }

  const base = await cdpBase();
  const opened = await fetch(`${ base }/json/new?${ encodeURIComponent(hostUrl) }`, { method: 'PUT' })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`the shared GitHub browser would not open a tab (${ r.status })`))));
  const session = cdpSession(opened.webSocketDebuggerUrl);

  try {
    await session.send('Page.enable');
    await session.send('Runtime.enable');
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: 1280, height: 800, deviceScaleFactor: 1, mobile: false,
    });
    // Opening the tab already navigated it; this is the wait for the uploader to exist, which is
    // also the wait for the login to be there.
    const deadline = Date.now() + 60_000;

    for (;;) {
      const ready = await evaluate(session, () => !!document.querySelector('input.js-data-upload-policy-url-csrf'));

      if (ready) {
        break;
      }
      if (Date.now() > deadline) {
        throw new Error('the PR page never rendered GitHub\'s uploader - the shared browser is probably signed out of GitHub (open it from the Conversations page and sign in).');
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    const href = await evaluate(session, UPLOAD_IN_PAGE, { b64: fs.readFileSync(file).toString('base64'), name, ct });

    if (!href) {
      throw new Error(`GitHub accepted ${ name } but returned no href.`);
    }
    uploadCache.set(key, href);

    return { href, cached: false };
  } finally {
    session.close();
    await fetch(`${ base }/json/close/${ opened.id }`).catch(() => null);
  }
}

function cleanAttachments(list) {
  if (!Array.isArray(list)) {
    return [];
  }

  return list
    .filter((a) => a && typeof a.path === 'string' && a.path.trim())
    .map((a) => ({ path: a.path.trim().slice(0, 400), caption: typeof a.caption === 'string' ? a.caption.slice(0, 400) : '' }));
}

function decorate(c) {
  return {
    ...c,
    level:       c.path ? 'line' : 'pr',
    attachments: (c.attachments || []).map((a) => ({
      ...a,
      name:  a.path.split('/').pop(),
      kind:  attachmentKind(a.path),
      found: !!artifactFile(a.path, c.pr),
    })),
  };
}

async function prDetail(repo, num) {
  const [meta, files, reviewComments, discussion, reviews, commits] = await Promise.all([
    ghRest('GET', `/repos/${ repo }/pulls/${ num }`),
    ghRest('GET', `/repos/${ repo }/pulls/${ num }/files?per_page=100`).catch(() => []),
    ghRest('GET', `/repos/${ repo }/pulls/${ num }/comments?per_page=100`).catch(() => []),
    ghRest('GET', `/repos/${ repo }/issues/${ num }/comments?per_page=100`).catch(() => []),
    ghRest('GET', `/repos/${ repo }/pulls/${ num }/reviews?per_page=100`).catch(() => []),
    ghRest('GET', `/repos/${ repo }/pulls/${ num }/commits?per_page=100`).catch(() => []),
  ]);
  // /pulls/:n/comments leaves out the comments of a PENDING (unsubmitted) review. GitHub only
  // shows the asking user their own pending reviews, so those comments come in flagged.
  const pendingReviews = (reviews || []).filter((r) => r.state === 'PENDING');
  const pendingGhComments = (await Promise.all(pendingReviews.map((r) => ghRest('GET', `/repos/${ repo }/pulls/${ num }/reviews/${ r.id }/comments?per_page=100`).catch(() => [])))).flat();
  const latestByUser = new Map();

  for (const r of reviews || []) {
    if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) {
      latestByUser.set(r.user?.login || '?', r.state);
    }
  }

  const states = [...latestByUser.values()];
  const approved = states.includes('APPROVED') && !states.includes('CHANGES_REQUESTED');
  const headSha = meta.head?.sha || '';
  const [checkRuns, statuses] = headSha ? await Promise.all([
    ghRest('GET', `/repos/${ repo }/commits/${ headSha }/check-runs?per_page=100`).catch(() => null),
    ghRest('GET', `/repos/${ repo }/commits/${ headSha }/status`).catch(() => null),
  ]) : [null, null];
  // `diff_hunk` is GitHub's own context for the comment - the hunk as it was when the comment
  // was left - which is the code to show for a comment whose line the diff has since moved
  // past (`line` null: outdated; `original_line` is the line in that hunk).
  const mapGhComment = (c, pending) => ({
    id: c.id, path: c.path, line: c.line ?? c.original_line ?? null, side: c.side || 'RIGHT', author: c.user?.login, body: c.body, createdAt: c.created_at, inReplyTo: c.in_reply_to_id ?? null, pending, outdated: c.line == null && c.original_line != null, originalLine: c.original_line ?? null, diffHunk: c.diff_hunk || '', position: c.position ?? c.original_position ?? null,
  });

  return {
    meta: {
      number:       meta.number,
      title:        meta.title,
      body:         meta.body || '',
      url:          meta.html_url,
      author:       meta.user?.login,
      state:        meta.draft ? 'DRAFT' : (meta.state || '').toUpperCase(),
      baseRef:      meta.base?.ref,
      headRef:      meta.head?.ref,
      headSha,
      additions:    meta.additions,
      deletions:    meta.deletions,
      changedFiles: meta.changed_files,
      approved,
      approvedBy:     [...latestByUser.entries()].filter(([, s]) => s === 'APPROVED').map(([u]) => u),
      merged:         !!meta.merged,
      draft:          !!meta.draft,
      mergeable:      meta.mergeable,
      mergeableState: meta.mergeable_state || null,
      ci:             ciFromRest(checkRuns, statuses),
      repo,
    },
    commits: (commits || []).map((c) => ({
      sha:     c.sha,
      message: (c.commit?.message || '').split('\n')[0].slice(0, 120),
      author:  c.commit?.author?.name || c.author?.login || 'unknown',
      // The committer's date, not the author's: a rebase keeps the author date, and what the
      // page wants to know is when the commit reached the branch.
      date:    c.commit?.committer?.date || c.commit?.author?.date || null,
    })),
    files: (files || []).map((f) => ({
      path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch || '',
    })),
    reviewComments: [
      ...(reviewComments || []).map((c) => mapGhComment(c, false)),
      ...pendingGhComments.map((c) => mapGhComment(c, true)),
    ],
    discussion:     (discussion || []).map((c) => ({
      id: c.id, author: c.user?.login, body: c.body, createdAt: c.created_at,
    })),
    localComments: (await localComments(num)).map(decorate),
    run:           await readDoc(reviewMap(num), 'run.json'),
    viewer:        await githubViewer(),
    // Every review submitted on the PR, whoever submitted it and from wherever: the rail's
    // "Submitted" reads these too, so a review left on GitHub itself counts.
    reviews:       (reviews || []).filter((r) => r.state !== 'PENDING').map((r) => ({
      author: r.user?.login || '', state: r.state, submittedAt: r.submitted_at || null,
    })),
  };
}

const RUN_STATES = ['starting', 'waiting-for-sidecars', 'running', 'idle', 'complete', 'failed', 'cancelled'];

// -- Dependabot ------------------------------------------------------------------------------

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'unknown'];
const BOT_TITLE_RE = /bump\s+(\S+)\s+from\s+(\S+)\s+to\s+(\S+)(?:\s+in\s+(\/\S*))?/i;

function slugFor(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'advisory';
}

function ciFromNode(node) {
  const rollup = node.commits?.nodes?.[0]?.commit?.statusCheckRollup;

  if (!rollup) {
    return null;
  }

  const contexts = rollup.contexts?.nodes || [];
  let pending = 0;
  let failing = 0;

  for (const c of contexts) {
    if (c.__typename === 'CheckRun') {
      if (!c.conclusion) {
        pending++;
      } else if (['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE'].includes(c.conclusion)) {
        failing++;
      }
    } else if (c.state === 'PENDING') {
      pending++;
    } else if (['FAILURE', 'ERROR'].includes(c.state)) {
      failing++;
    }
  }

  return { pending, failing, total: rollup.contexts?.totalCount || contexts.length, failingUrl: null };
}

async function openDependabotPrs(repo) {
  const data = await graphql(`
    query($search: String!) {
      search(query: $search, type: ISSUE, first: 60) {
        nodes {
          ... on PullRequest {
            number url title bodyText isDraft updatedAt headRefName mergeable reviewDecision
            commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { totalCount nodes { __typename ... on CheckRun { conclusion } ... on StatusContext { state } } } } } } }
          }
        }
      }
    }`, { search: `repo:${ repo } is:pr is:open author:app/dependabot` }).catch(() => null);

  return (data?.search?.nodes || []).filter(Boolean).map((n) => {
    const m = String(n.title || '').match(BOT_TITLE_RE);
    const pkg = m?.[1] || null;
    const branch = n.headRefName || '';

    return {
      number:      n.number,
      url:         n.url,
      title:       n.title,
      body:        n.bodyText || '',
      packageName: pkg,
      fromVersion: m?.[2] || null,
      toVersion:   m?.[3] || null,
      ecosystem:   branch.includes('/npm_and_yarn/') ? 'npm' : (branch.includes('/github_actions/') ? 'github-actions' : 'unknown'),
      branch,
      draft:       !!n.isDraft,
      updatedAt:   n.updatedAt || '',
      approved:    n.reviewDecision === 'APPROVED',
      mergeable:   n.mergeable === 'MERGEABLE' ? true : (n.mergeable === 'CONFLICTING' ? false : null),
      ci:          ciFromNode(n),
    };
  });
}

async function fetchDependabot(repo) {
  const [alerts, prs] = await Promise.all([
    ghRest('GET', `/repos/${ repo }/dependabot/alerts?state=open&per_page=100`),
    openDependabotPrs(repo),
  ]);
  const byTitle = new Map();

  for (const a of Array.isArray(alerts) ? alerts : []) {
    const title = a.security_advisory?.summary || a.security_advisory?.ghsa_id || 'Unknown advisory';
    let group = byTitle.get(title);

    if (!group) {
      group = {
        title,
        slug:           slugFor(title),
        severity:       'unknown',
        ghsaId:         a.security_advisory?.ghsa_id || null,
        cveId:          a.security_advisory?.cve_id || null,
        description:    a.security_advisory?.description || '',
        packages:       [],
        manifests:      [],
        alerts:         [],
        prs:            [],
        patchedVersion: null,
        url:            a.html_url || `https://github.com/${ repo }/security/dependabot`,
      };
      byTitle.set(title, group);
    }

    const severity = String(a.security_vulnerability?.severity || 'unknown').toLowerCase();

    if (SEVERITY_ORDER.indexOf(severity) < SEVERITY_ORDER.indexOf(group.severity)) {
      group.severity = severity;
    }

    const packageName = a.dependency?.package?.name || 'unknown';
    const manifest = a.dependency?.manifest_path || '';

    if (!group.manifests.includes(manifest)) {
      group.manifests.push(manifest);
    }
    if (!group.packages.includes(packageName)) {
      group.packages.push(packageName);
    }

    const patched = a.security_vulnerability?.first_patched_version?.identifier || null;

    group.alerts.push({
      number: a.number, packageName, manifest, ecosystem: a.dependency?.package?.ecosystem || 'unknown', patchedVersion: patched, url: a.html_url,
    });
    group.patchedVersion = group.patchedVersion || patched;

    const pr = prs.find((p) => (group.ghsaId && p.body.includes(group.ghsaId)) || p.packageName === packageName);

    if (pr && !group.prs.some((p) => p.number === pr.number)) {
      group.prs.push({ number: pr.number, url: pr.url, title: pr.title });
    }
  }

  const groups = [...byTitle.values()].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || a.title.localeCompare(b.title));

  return { groups, prs: prs.map(({ body, ...rest }) => rest), url: `https://github.com/${ repo }/security/dependabot`, repo };
}

async function dependabotReviewContext(repo, num) {
  const [meta, files, prs] = await Promise.all([
    ghRest('GET', `/repos/${ repo }/pulls/${ num }`),
    ghRest('GET', `/repos/${ repo }/pulls/${ num }/files?per_page=100`).catch(() => []),
    openDependabotPrs(repo).catch(() => []),
  ]);
  const headSha = meta.head?.sha;
  const [checkRuns, statuses] = headSha ? await Promise.all([
    ghRest('GET', `/repos/${ repo }/commits/${ headSha }/check-runs?per_page=100`).catch(() => null),
    ghRest('GET', `/repos/${ repo }/commits/${ headSha }/status`).catch(() => null),
  ]) : [null, null];
  const self = prs.find((p) => p.number === num) || null;
  const failingChecks = latestRuns(checkRuns)
    .filter((r) => BAD_CONCLUSIONS.includes(String(r.conclusion || '').toLowerCase()))
    .map((r) => ({
      name: r.name, conclusion: r.conclusion, url: r.html_url, title: r.output?.title || null, summary: (r.output?.summary || '').slice(0, 600) || null,
    }));

  return {
    pr: {
      number:         num,
      url:            meta.html_url,
      title:          meta.title,
      body:           String(meta.body || '').slice(0, 40_000),
      author:         meta.user?.login || null,
      state:          meta.state,
      draft:          !!meta.draft,
      labels:         (meta.labels || []).map((l) => l.name),
      mergeable:      meta.mergeable,
      mergeableState: meta.mergeable_state || null,
      additions:      meta.additions,
      deletions:      meta.deletions,
      changedFiles:   meta.changed_files,
      branch:         meta.head?.ref || '',
      files:          (Array.isArray(files) ? files : []).map((f) => ({
        path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions,
      })),
    },
    ci:   { ...(ciFromRest(checkRuns, statuses) || { pending: 0, failing: 0, total: 0, failingUrl: null }), failingChecks },
    bump: self ? {
      packageName: self.packageName, ecosystem: self.ecosystem, fromVersion: self.fromVersion, toVersion: self.toVersion,
    } : null,
  };
}

// -- Workspaces, for callers with no browser -------------------------------------------------

async function apps() {
  const list = await k8s(APPS);

  return (list.items || []).map((app) => ({
    id: app.metadata.name, label: app.metadata.name, description: app.spec?.description || '', values: app.spec?.values || {},
  }));
}

function nameError(name) {
  if (!name) {
    return 'A name is required.';
  }
  if (name.length > 40) {
    return 'A name has to be 40 characters or fewer.';
  }

  return /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name) ? '' : 'A name can hold lowercase letters, numbers and dashes, and has to start and end with one of the first two.';
}

async function makeWorkspace(name, appId, cluster = 'local') {
  const known = await apps();

  if (!known.some((app) => app.id === appId)) {
    throw failure(400, `No Apps Plus app called ${ appId }. There is ${ known.map((app) => app.id).join(', ') || 'none' }.`);
  }

  // A leased workspace wears its kind in its name, the same way the create page puts it there:
  // every list, namespace and tree then says which kind it is without reading the App off the
  // Installation, and `isLte` in the extension is a question about a name. The caller is told
  // the name it ended up with, in the answer below.
  if (appId.startsWith(LTE_PREFIX) && !name.startsWith(LTE_PREFIX)) {
    name = `${ LTE_PREFIX }${ name }`;
  }

  const namespace = `dev-${ name }`;
  const created = await create(INSTANCES, {
    apiVersion: 'appsplus.io/v1alpha1',
    kind:       'AppInstance',
    metadata:   { name, labels: { [LABEL_WORKSPACE]: name, [LABEL_APP]: appId, [LABEL_CLUSTER]: cluster } },
    spec:       {
      app: appId, namespace, targets: [{ clusterName: cluster }], values: { hostCluster: cluster }, provisionCluster: { enabled: false },
    },
  });

  if (!created) {
    throw failure(409, `A workspace called ${ name } already exists.`);
  }

  return { name, namespace, app: appId, rendered: false };
}

// -- Tools: leased, rendered here, swept here ------------------------------------------------
//
// A leased (`lte-`) workspace runs nothing. Everything that costs something while it is up is a
// tool with a pod of its own: a dev server, a storybook, a Rancher to test against. A tool is
// started when it is wanted, carries a lease, and goes when the lease runs out, when whoever
// asked for it releases it, or when the workspace it belongs to is deleted.
//
// Rendering happens *here* rather than in the browser, and that is the reason this code is in
// dev-api at all. Apps Plus renders an Installation from a model that only exists in a loaded
// dashboard; agents start tools while nobody has a dashboard open, so an AppInstance would be a
// record with nothing behind it until somebody happened to look. The App is still the
// definition - these read it out of Apps Plus and substitute its values - but the objects are
// applied by the one process that is always running, which is also the one that can sweep them.

const LABEL_TOOL = 'dev.rancher.io/tool';
const LABEL_TOOL_OF = 'dev.rancher.io/tool-of';
const LEASE_ANNOTATION = 'dev.rancher.io/lease-expires';
const LEASE_MINUTES_ANNOTATION = 'dev.rancher.io/lease-minutes';
const DEFAULT_LEASE_MINUTES = 90;
// Nothing gets a lease longer than a working day in one go. A tool that is genuinely needed for
// longer is renewed, which costs one command and means somebody said so twice.
const MAX_LEASE_MINUTES = 8 * 60;

/** The Apps the pod-backed tools are rendered from. `browser` has no pod; see below. */
const TOOL_APPS = { 'dev-server': 'lte-dev-server', storybook: 'lte-storybook', rancher: 'lte-rancher' };
const TOOL_KINDS = [...Object.keys(TOOL_APPS), 'browser'];
/** Where each tool answers, which is also what its Service publishes. */
const TOOL_PORTS = { 'dev-server': 8005, storybook: 6006, rancher: 443 };
const TOOL_SCHEMES = { 'dev-server': 'https', storybook: 'http', rancher: 'https' };
/**
 * The browser tool is the shared Chromium, and it is not leased.
 *
 * It was a CDP *browser context* per workspace - its own cookies, its own window - which is a
 * real thing in Chromium and a thing no client here can use: Playwright's `connectOverCDP`
 * surfaces only the default context, and a page opened in any other one turns up inside that
 * same default context's `pages()`. So the isolation was invisible to the tooling that was
 * supposed to benefit from it, while the contexts accumulated and their pages appeared in every
 * other workspace's list. One shared browser, one shared set of logins - which is what the
 * GitHub and Rancher sessions want anyway - and no lease, because a browser nobody is driving
 * costs nothing to leave running.
 */

function toolNs(workspace, kind) {
  return `dev-${ workspace }-${ kind }`;
}

/** Every Kubernetes kind a tool template may hold, and where it lives. */
const RESOURCES = {
  Namespace:  '/api/v1/namespaces',
  ConfigMap:  '/api/v1/namespaces/{ns}/configmaps',
  Secret:     '/api/v1/namespaces/{ns}/secrets',
  Service:    '/api/v1/namespaces/{ns}/services',
  Deployment: '/apis/apps/v1/namespaces/{ns}/deployments',
};

/**
 * Apps Plus's substitution, over an object rather than over text.
 *
 * The rule it follows is Apps Plus's own: `${name}` is replaced for the exact names the App
 * declares plus the built-ins, and anything else is left as written (which is what the Apps
 * Plus UI warns about, and it is right to). One addition: a string that is *nothing but* a
 * placeholder takes the value's own type, so a port declared as a number stays a number - the
 * apiserver refuses a Service port that arrives as "8005".
 */
function substitute(node, values) {
  if (typeof node === 'string') {
    const whole = /^\$\{([A-Za-z0-9_]+)\}$/.exec(node);

    if (whole && whole[1] in values) {
      return values[whole[1]];
    }

    return node.replace(/\$\{([A-Za-z0-9_]+)\}/g, (all, key) => (key in values ? String(values[key]) : all));
  }
  if (Array.isArray(node)) {
    return node.map((item) => substitute(item, values));
  }
  if (node && typeof node === 'object') {
    const out = {};

    for (const [key, value] of Object.entries(node)) {
      out[String(substitute(key, values))] = substitute(value, values);
    }

    return out;
  }

  return node;
}

/** Create it, or bring what is there up to what was asked for. */
async function applyObject(object) {
  const base = RESOURCES[object.kind];

  if (!base) {
    throw failure(500, `A tool template holds a ${ object.kind }, which this renderer does not apply.`);
  }
  const namespace = object.metadata?.namespace || '';
  const path = base.replace('{ns}', namespace);
  const made = await create(path, object);

  if (made) {
    return made;
  }

  // 409: it is already there. A merge patch rather than a replace, so a field somebody else
  // owns on it (a nodePort the apiserver chose, say) is not taken away.
  return k8s(`${ path }/${ object.metadata.name }`, { method: 'PATCH', body: JSON.stringify(object) });
}

/** When a lease of this many minutes runs out. */
function leaseUntil(minutes) {
  const span = Math.min(Math.max(Number(minutes) || DEFAULT_LEASE_MINUTES, 5), MAX_LEASE_MINUTES);

  return { minutes: span, expires: new Date(Date.now() + span * 60_000).toISOString() };
}

/**
 * The shared browser, as a tool: where it is, in a form that can be connected to.
 *
 * `cdpBase()` resolves the service name to its address, and that is the whole value of this
 * answer. Chromium refuses a CDP request whose Host header is neither localhost nor an IP - its
 * guard against DNS rebinding - so the service name every other part of this product passes
 * around is the one string a client cannot use. An agent handed it got a 500 from every call.
 */
async function browserTool(workspace) {
  const url = await cdpBase().catch(() => GITHUB_BROWSER_CDP);

  return {
    kind:    'browser',
    workspace,
    running: true,
    ready:   true,
    shared:  true,
    url,
    cdp:     url,
    detail:  'the shared browser, always available',
  };
}

/** What a pod-backed tool is doing, and where it answers. */
async function podTool(workspace, kind) {
  const namespace = toolNs(workspace, kind);
  const ns = await k8s(`/api/v1/namespaces/${ namespace }`).catch((e) => {
    if (e.status === 404) {
      return null;
    }
    throw e;
  });

  if (!ns) {
    return { kind, workspace, running: false };
  }

  const [deployment, service, pods] = await Promise.all([
    k8s(`/apis/apps/v1/namespaces/${ namespace }/deployments/${ namespace }`).catch(() => null),
    k8s(`/api/v1/namespaces/${ namespace }/services/${ namespace }`).catch(() => null),
    k8s(`/api/v1/namespaces/${ namespace }/pods`).catch(() => ({ items: [] })),
  ]);

  const pod = (pods.items || [])[0] || null;
  const port = TOOL_PORTS[kind];
  const scheme = TOOL_SCHEMES[kind];
  const ready = (deployment?.status?.readyReplicas || 0) > 0;

  return {
    kind,
    workspace,
    running:  true,
    ready,
    expires:  ns.metadata?.annotations?.[LEASE_ANNOTATION] || '',
    minutes:  Number(ns.metadata?.annotations?.[LEASE_MINUTES_ANNOTATION] || 0),
    since:    ns.metadata?.creationTimestamp || '',
    removing: !!ns.metadata?.deletionTimestamp,
    namespace,
    port,
    scheme,
    nodePort: service?.spec?.ports?.[0]?.nodePort || 0,
    // How something inside the cluster reaches it - an agent's curl, the shared browser. The
    // Service and the namespace have the same name, which is what makes this predictable.
    url:      `${ scheme }://${ namespace }.${ namespace }.svc:${ port }`,
    // And how a person reaches it: this Rancher's service proxy, which is the only way in to
    // the host cluster from outside. The page puts the Rancher's own address in front.
    proxy:    `/k8s/clusters/local/api/v1/namespaces/${ namespace }/services/${ scheme }:${ namespace }:${ port }/proxy/`,
    detail:   podTrouble(pod, deployment, ready),
  };
}

/** Why a tool is not answering yet, in a few words, or ''. */
function podTrouble(pod, deployment, ready) {
  if (ready) {
    return '';
  }
  if (!pod) {
    return deployment ? 'no pod yet' : 'starting';
  }
  for (const status of pod.status?.containerStatuses || []) {
    const waiting = status.state?.waiting;

    if (waiting?.reason && FAILED_REASONS.includes(waiting.reason)) {
      return `${ waiting.reason }: ${ waiting.message || 'the container will not start' }`;
    }
    if (waiting?.reason) {
      return waiting.reason;
    }
  }

  return pod.status?.phase === 'Running' ? 'starting up' : (pod.status?.phase || 'starting');
}

/**
 * The tail of a tool's log.
 *
 * Read here rather than by the workspace's own `kubectl`: a tool has a namespace of its own, and
 * the workspace's ServiceAccount is bound to `edit` in *its* namespace and nowhere else. Giving
 * it rights in every tool namespace would mean this API granting privileges it would then have
 * to hold, for a read it can simply do itself.
 */
async function toolLogs(workspace, kind, tail = 60) {
  if (kind === 'browser') {
    return { kind, workspace, log: 'The browser tool is a context on the shared browser; it has no pod and no log of its own.' };
  }
  const namespace = toolNs(workspace, kind);
  const pods = await k8s(`/api/v1/namespaces/${ namespace }/pods`).catch(() => ({ items: [] }));
  const pod = (pods.items || [])[0];

  if (!pod) {
    return { kind, workspace, log: `The ${ kind } tool is not attached to ${ workspace }.` };
  }

  const lines = Math.min(Math.max(Number(tail) || 60, 1), 2000);
  const log = await k8sText(`/api/v1/namespaces/${ namespace }/pods/${ pod.metadata.name }/log?tailLines=${ lines }`).catch((e) => `could not read the log: ${ e.message }`);

  return { kind, workspace, pod: pod.metadata.name, log };
}

async function toolState(workspace, kind) {
  return kind === 'browser' ? browserTool(workspace) : podTool(workspace, kind);
}

async function toolsOf(workspace) {
  return Promise.all(TOOL_KINDS.map((kind) => toolState(workspace, kind).catch((e) => ({ kind, workspace, error: e.message }))));
}

/**
 * Start a tool, or renew the one that is already there.
 *
 * Idempotent on purpose: an agent that asks twice, or a page whose button was pressed twice,
 * should get the tool and a fresh lease rather than an error about a namespace that exists.
 */
async function startTool(workspace, kind, body = {}) {
  if (!TOOL_KINDS.includes(kind)) {
    throw failure(400, `There is no ${ kind } tool. There is ${ TOOL_KINDS.join(', ') }.`);
  }

  const instance = await k8s(`${ INSTANCES }/${ workspace }`).catch(() => null);

  if (!instance) {
    throw failure(404, `There is no workspace called ${ workspace } to attach a tool to.`);
  }

  if (kind === 'browser') {
    // Nothing to create: the shared browser is already there, and saying where it is is the
    // whole of "starting" it.
    return browserTool(workspace);
  }

  const appId = TOOL_APPS[kind];
  const app = await k8s(`${ APPS }/${ appId }`).catch(() => null);

  if (!app) {
    throw failure(503, `The ${ appId } App is not in Apps Plus yet. Open the Dev pages once and it will be created.`);
  }

  // What makes a tool impossible to orphan, and it is not a sweep.
  //
  // The tool's namespace is *owned* by the workspace's Installation: an ownerReference from one
  // cluster-scoped object to another, which Kubernetes' garbage collector enforces. Delete the
  // workspace by any means - this API, the page, `kubectl`, a Fleet teardown, a cascade nobody
  // wrote - and the apiserver removes the namespace and everything in it. No code of ours has to
  // remember, which is the point: the sweep below is now a backstop for leases rather than the
  // thing standing between a deleted workspace and a dev server that runs all weekend.
  //
  // It is also why a tool cannot be created without one. The uid is the workspace that exists
  // *now*: a workspace deleted and made again under the same name is a different uid, so any
  // namespace still carrying the old one is collected rather than adopted - which is the other
  // half of the orphan problem, the one that used to leave a new workspace sharing a tool with
  // the ghost of the last.
  if (!instance.metadata?.uid) {
    throw failure(409, `The workspace ${ workspace } has no uid yet, so a tool made now could not be owned by it. Try again in a moment.`);
  }

  const owner = {
    apiVersion:         'appsplus.io/v1alpha1',
    kind:               'AppInstance',
    name:               workspace,
    uid:                instance.metadata.uid,
    // Not a controller and not blocking: this API does not manage the Installation, and a
    // workspace's own teardown must not wait on a namespace draining.
    controller:         false,
    blockOwnerDeletion: false,
  };

  const namespace = toolNs(workspace, kind);
  const lease = leaseUntil(body.minutes);
  const values = {
    ...(app.spec?.values || {}),
    ...(body.values || {}),
    workspace,
    namespace,
    install:  `${ workspace }-${ kind }`,
    app:      appId,
    instance: `${ workspace }-${ kind }`,
  };

  for (const t of app.spec?.templates || []) {
    let object;

    try {
      object = JSON.parse(t.content);
    } catch {
      throw failure(500, `The ${ appId } App's ${ t.name } is not JSON, so dev-api cannot render it. Tool templates are written as JSON for exactly this reason.`);
    }

    const rendered = substitute(object, values);

    // The lease and the owner both ride on the namespace: it is the object the sweep reads, the
    // one the garbage collector follows, and the one whose deletion takes the whole tool with it.
    if (rendered.kind === 'Namespace') {
      rendered.metadata.annotations = {
        ...(rendered.metadata.annotations || {}),
        [LEASE_ANNOTATION]:         lease.expires,
        [LEASE_MINUTES_ANNOTATION]: String(lease.minutes),
      };
      rendered.metadata.ownerReferences = [owner];
    }

    // The guard that keeps the guarantee true as this grows: a tool is a namespace and things
    // inside it, and a namespace with no owner is a tool nothing will ever collect. A template
    // that produced one would be a leak that only showed up as a node running out of memory a
    // week later, so it is refused here instead.
    if (rendered.kind === 'Namespace' && !rendered.metadata.ownerReferences?.length) {
      throw failure(500, `The ${ appId } App's ${ t.name } would create a namespace owned by nothing, which is a tool that could outlive its workspace. Refusing.`);
    }

    await applyObject(rendered);
  }

  console.log(`[dev-api] started the ${ kind } tool for ${ workspace }, leased for ${ lease.minutes } minutes`);

  return { ...(await podTool(workspace, kind)), ...lease };
}

async function renewTool(workspace, kind, minutes) {
  const lease = leaseUntil(minutes);

  if (kind === 'browser') {
    return browserTool(workspace);
  }

  await k8s(`/api/v1/namespaces/${ toolNs(workspace, kind) }`, {
    method: 'PATCH',
    body:   JSON.stringify({ metadata: { annotations: { [LEASE_ANNOTATION]: lease.expires, [LEASE_MINUTES_ANNOTATION]: String(lease.minutes) } } }),
  });

  return { ...(await podTool(workspace, kind)), ...lease };
}

async function stopTool(workspace, kind) {
  if (kind === 'browser') {
    // It is shared and it is not leased, so there is nothing here that releasing could free.
    // Answered rather than refused, so a skill that tidies up after itself is not made to
    // special-case one of the four.
    return { ...(await browserTool(workspace)), detail: 'the shared browser is not released; it costs nothing when nobody is driving it' };
  }

  await k8s(`/api/v1/namespaces/${ toolNs(workspace, kind) }`, { method: 'DELETE' }).catch((e) => {
    if (e.status !== 404) {
      throw e;
    }
  });
  console.log(`[dev-api] released the ${ kind } tool for ${ workspace }`);

  return { kind, workspace, running: false };
}

/**
 * The sweep: expired leases, and tools whose workspace has gone.
 *
 * This is what makes the arrangement worth having. An agent is told to release a tool when it
 * is done and mostly does, but a conversation that ended mid-task, a pane that was closed or a
 * person who walked away all leave a dev server compiling for nobody - which is the single most
 * expensive idle thing on this node. The lease means the worst case is the rest of an hour and
 * a half rather than the rest of the week.
 */
async function reapTools() {
  const instances = await installations('tools');

  if (!instances) {
    return;
  }

  const live = new Set((instances.items || []).map((i) => i.metadata?.name).filter(Boolean));

  const namespaces = await k8s(`/api/v1/namespaces?labelSelector=${ encodeURIComponent(LABEL_TOOL) }`).catch(() => null);
  const now = Date.now();

  for (const ns of namespaces?.items || []) {
    if (ns.metadata?.deletionTimestamp) {
      continue;
    }
    const kind = ns.metadata?.labels?.[LABEL_TOOL];
    const owner = ns.metadata?.labels?.[LABEL_TOOL_OF] || '';
    const expires = Date.parse(ns.metadata?.annotations?.[LEASE_ANNOTATION] || '');
    const orphaned = !!owner && !live.has(owner);
    const expired = Number.isFinite(expires) && expires < now;

    if (!orphaned && !expired) {
      continue;
    }

    await k8s(`/api/v1/namespaces/${ ns.metadata.name }`, { method: 'DELETE' })
      .then(() => console.log(`[dev-api] released the ${ kind } tool for ${ owner }: ${ orphaned ? 'its workspace is gone' : 'its lease ran out' }`))
      .catch((e) => {
        if (e.status !== 404) {
          console.error(`[dev-api] tools: namespace ${ ns.metadata.name }:`, e.message || e);
        }
      });
  }

}

// -- HTTP ------------------------------------------------------------------------------------

function send(res, status, body) {
  const text = JSON.stringify(body);

  res.writeHead(status, {
    'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'access-control-allow-origin': '*',
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('The body is not JSON.'));
      }
    });
    req.on('error', reject);
  });
}

// -- Conversations ---------------------------------------------------------------------------
//
// What the browser could only ask while a tab was open, asked here instead. Every read of a
// conversation's state used to be an exec issued BY THE BROWSER (conversations.ts, through
// podExecOnce), so with no tab open nothing observed anything: an agent could finish at four in
// the morning and the only record of it was a hook file nobody would read until somebody loaded
// a page.
//
// The expensive half of that question and the cheap half are different questions, and separating
// them is the whole of this loop's cost.
//
//   The listing - which conversations exist, and whether each pane is alive - is one exec, because
//   `sessions.sh` owns the first and only a process inside that pod can answer the second.
//
//   The fields that move every few seconds - the hook's last event, the transcript's mtime - are
//   files, and this pod already has them: it mounts the agent pod's /workspace read-only at
//   AGENT_ROOT so a review's evidence can be served out of it, and the same mount holds
//   sessions/<id>.state.json.
//
// So: one exec every thirty seconds. The listing carries the whole state head, so that one read is
// sufficient by itself - which is why the five-second refresh off that mount was dropped rather
// than kept as an accelerator. The mount is still read on demand, for a conversation's own event
// log and for what it last said, where a stale or absent answer costs one response and not a tick.

const AGENT_NAMESPACE = process.env.AGENT_NAMESPACE || 'extension-studio';
const AGENT_APP = process.env.AGENT_APP || 'extension-studio-agent';
const AGENT_CONTAINER = process.env.AGENT_CONTAINER || 'agent';
/** Where the agent pod's conversations are, as this pod sees them. See AGENT_ROOT. */
const AGENT_SESSIONS = `${ AGENT_ROOT }/sessions`;

const CONVERSATIONS_DOC = process.env.DEV_CONVERSATIONS_MAP || 'dev-conversations';
const CONVERSATIONS_KEY = 'conversations.json';
const CONVERSATION_LABELS = { 'dev.rancher.io/kind': 'conversations' };

/**
 * One exec, every thirty seconds, and nothing else.
 *
 * There was a second tick at five seconds that re-stat'ed each conversation's hook file off the
 * mount this pod has of the agent pod's volume, to beat thirty-second freshness. It is gone, and
 * thirty seconds is the answer: the listing's own output carries the whole state head, so the exec
 * was always sufficient on its own, and the mount never was - both hostPaths are node-local and
 * neither Deployment pins a node, so on a multi-node cluster that mount is a different, empty
 * directory which throws nothing and refreshes nothing. A cadence that is right everywhere beats
 * one that is six times faster on a single-node cluster and silently stale on any other.
 */
const LISTING_MS = 30_000;
/** Five missed listings. Past this the loop has stopped and the states are history. */
const STALE_MS = 5 * LISTING_MS;

/**
 * How long after a new agent pod appears a dead pane is not news.
 *
 * Measured, and the reason this guard exists: tmux is empty for the first minute after the agent
 * pod restarts, while every conversation is still there on the hostPath with its transcript and
 * its name intact - the note at the top of sessions.sh is about exactly this. dev-api is rolled by
 * the same publish that rolls that pod, so without this the first tick after every release would
 * declare every conversation in the cluster finished at once.
 */
const POD_SETTLE_MS = 120_000;

/**
 * How long a conversation is kept after its directory has gone.
 *
 * Not dropped the moment it disappears, because disappearing is itself the news: a deck holding a
 * card until a conversation moved, and told nothing, holds it for ever. `sessions.sh end` removes
 * the directory as well as the session, so this is the only record that it ever existed.
 */
const GONE_TTL_MS = 6 * 3600_000;

/** Entries kept, oldest change dropped first. Five times anything observed; see the doc. */
const ITEM_CAP = 400;
const SAID_MAX = 500;
/** Several turns of transcript. A transcript itself runs to many megabytes. */
const TAIL_BYTES = 128 * 1024;

/**
 * How recently the transcript must have moved for a conversation to count as working.
 *
 * The same ninety seconds the browser used when it made this judgement itself. Long enough to
 * cover a subagent thinking between writes, short enough that a conversation nobody is in stops
 * claiming to be busy. Kept identical on purpose: the point of moving the derivation here is that
 * one answer is given, not that a third one is invented.
 */
const WORKING_WINDOW_S = 90;

/**
 * The hook events that are the last word on a conversation, when they are the latest thing to
 * have happened.
 *
 * `Stop` and `SessionEnd` say the turn is over and both fire after that turn's final writes land,
 * so for a few seconds afterwards the transcript still looks like it is moving. `Notification`
 * fires right after the tool call it is asking permission for was written down. Each has to be
 * able to overrule a transcript that has only just stopped, which is the five-second margin below.
 *
 * `SessionStart` and `UserPromptSubmit` are not on this list, and that is the point of having one:
 * neither says anything about whether claude is busy now. SessionStart is the case that was wrong
 * for longest - the CLI fires it the moment it finishes an auto-compact and then carries straight
 * on with the rest of the turn, while the transcript, quiet all through the compaction, is the only
 * thing that knows. Letting it know halved the samples where a working conversation showed an idle
 * dot (agent.ts, activityState, which this is ported from).
 */
const SPEAKS_LAST = new Set(['Stop', 'SessionEnd', 'Notification']);

/** The states that mean it has stopped and the work is a person's again. */
const SETTLED = new Set(['input', 'idle', 'finished']);
const QUESTION_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
const CONVERSATION_ID = /^(agent-\d+|p-[a-z0-9-]+-\d+)$/;

/** Which agent pod the last listing came from, and when this process first saw that one. */
let agentSeen = { pod: '', since: 0 };
/** What this process knows about its own looking. In memory: a write per tick to say "nothing
 * happened" is the cost this design exists to avoid, and what a client wants from this is whether
 * THIS process is still looking, which only this process knows. */
let watch = { at: 0, ms: 0, ok: true, detail: '', first: true };
/** One tick at a time, whichever kind. See `once`. */
let ticking = null;
let noAgentPod = false;
/** A short memo, so a dozen browser tabs polling do not each cost an apiserver read. */
let memo = { at: 0, doc: null };


/**
 * The bucket a conversation falls in, from what the pod reported about it.
 *
 * Ported verbatim from `activityState` (agent.ts:448) - the newer of the two browser copies, the
 * one that carries the SessionStart fix - and it is here because this is the judgement that has to
 * be made when nobody is looking. `agentStateOf` (workspace-status.ts) is deleted in the same
 * change; it was the drifted copy, with neither SPEAKS_LAST nor that fix, which is why the same
 * conversation read `idle` in the sidebar and `working` in the conversation strip after a compact.
 *
 * The transcript outranks the hook: a hook fires only at a turn's edges, so a turn spent inside
 * subagents reads as finished to it while the subagents write all the while, and a permission
 * prompt answered in the terminal leaves the last Notification standing over an agent that is
 * working again.
 *
 * '' is returned for "nothing believable", which the caller folds in as no change at all. A state
 * file caught between the hook's write and its rename, and an `alive: no` from a pod that has only
 * just started, are both doubt rather than news.
 */
function conversationState(a, podStartedMs = 0) {
  // Neither a hook file nor a transcript: a conversation nobody has ever opened. Which is what
  // leaves a fresh tab with no dot rather than a misleading one.
  if (!a.event && a.wroteAgo < 0) {
    return 'none';
  }

  const hookMs = Date.parse(a.at) || 0;

  if (!a.alive) {
    /*
     * A pane that is not there, which is only believable twice over.
     *
     * For the first two minutes after the agent pod changes there is no tmux server at all while
     * every conversation is still on the hostPath waiting to be reattached. And a hook event
     * written before this container started was written by a claude that no longer exists, so its
     * pane being absent says nothing that was not already true - and that holds however long ago
     * the pod came up, which is what stops a conversation last touched a week ago becoming
     * `finished` news the moment the settle window passes.
     */
    if (!podStartedMs || Date.now() - podStartedMs < POD_SETTLE_MS || (hookMs && hookMs < podStartedMs)) {
      return '';
    }

    return 'finished';
  }

  const hookAgo = (Date.now() - hookMs) / 1000;
  const overruled = SPEAKS_LAST.has(a.event) && hookAgo <= a.wroteAgo + 5;

  if (a.wroteAgo >= 0 && a.wroteAgo <= WORKING_WINDOW_S && !overruled) {
    return 'working';
  }
  // claude said it exited. The pane may well still be there - the loop that owns it restarts
  // claude in a moment - but nothing is running in it now. Below the transcript window on purpose:
  // a `/clear` fires SessionEnd too, and the SessionStart a second later takes this back.
  if (a.event === 'SessionEnd') {
    return 'finished';
  }
  if (a.event === 'Notification' && a.notification && a.notification !== 'idle_prompt') {
    return 'input';
  }
  switch (a.event) {
  case 'UserPromptSubmit':
  case 'PreToolUse':
  case 'PostToolUse':
  case 'SubagentStop':
    return 'working';
  case 'Notification':
    return a.notification === 'idle_prompt' ? 'idle' : 'input';
  default:
    return 'idle';
  }
}


const freshDoc = () => ({
  v: 1, epoch: `${ Date.now().toString(36) }${ Math.random().toString(36).slice(2, 6) }`, at: '', pod: '', items: {},
});

/**
 * The document, read rather than cached between ticks.
 *
 * Two watchers exist for a few seconds of every publish: the dev-api Deployment has replicas 1 and
 * no `strategy`, so Kubernetes defaults to RollingUpdate with maxSurge 1, and `ensure` in api.ts is
 * create-if-missing so `strategy: Recreate` cannot be retrofitted to a cluster that already has
 * one. `writeDoc` is a merge-patch with no precondition, so the answer is not to serialise but to
 * be idempotent: both watchers read the same base, both compute the same fold from the same inputs
 * (see `foldOne`), and the clobber is harmless. Caching the document in a module variable is what
 * would make it harmful.
 *
 * The memo is two seconds, for the browser tabs polling this through the service proxy; a tick
 * passes `true` and reads through it.
 */
async function conversationDoc(force = false) {
  if (!force && memo.doc && Date.now() - memo.at < 2_000) {
    return memo.doc;
  }
  const held = await readDoc(CONVERSATIONS_DOC, CONVERSATIONS_KEY).catch(() => null);
  const doc = held?.items ? held : freshDoc();

  memo = { at: Date.now(), doc };

  return doc;
}

async function writeConversations(doc, changed) {
  memo = { at: Date.now(), doc };
  if (!changed) {
    return;
  }

  await writeDoc(CONVERSATIONS_DOC, CONVERSATIONS_KEY, doc, CONVERSATION_LABELS);
}


/** The running agent pod, or null. `Running` rather than `Ready`: this pod has no probes. */
async function agentPod() {
  const pods = await k8s(`/api/v1/namespaces/${ AGENT_NAMESPACE }/pods?labelSelector=app%3D${ AGENT_APP }`).catch((e) => {
    /*
     * No such namespace, said once.
     *
     * dev-api runs on every cluster a workspace can land on and the agent pod is only ever on
     * `local`, so downstream this is the normal and permanent answer. The three reconcilers above
     * each learned the expensive way that a failure logged every tick, forever, on every downstream
     * cluster is worse than no feature; see `installations`.
     */
    if (e.status === 404) {
      noAgentPod = true;
      console.log(`[dev-api] conversations: no ${ AGENT_NAMESPACE } namespace on this cluster, so there is no agent pod to watch; not asking again.`);
    } else {
      watch = { ...watch, ok: false, detail: `the agent pod could not be looked up: ${ e.message || e }` };
    }

    return null;
  });

  return (pods?.items || []).find((pod) => pod.status?.phase === 'Running' && !pod.metadata?.deletionTimestamp) || null;
}

/**
 * When the claude side of this pod started, which is what decides whether `alive: no` means
 * anything. The container's own start, not the pod's: a pod scheduled an hour ago whose container
 * restarted ninety seconds ago has an empty tmux server either way.
 */
function agentStartedMs(pod) {
  const container = (pod.status?.containerStatuses || []).find((c) => c.name === AGENT_CONTAINER);

  return Date.parse(container?.state?.running?.startedAt || pod.status?.startTime || '') || 0;
}

/**
 * The listing: one exec, and the only thing here allowed to decide what a conversation IS.
 *
 * `sessions.sh states-all` owns that. A conversation is a directory under /workspace/sessions and
 * not a tmux session, a distinction two earlier versions of this question got wrong in two
 * different ways, and that script is also the only place that can say whether a pane is alive.
 */
async function listingTick() {
  return once(async() => {
    if (noAgentPod) {
      return;
    }
    const started = Date.now();
    const pod = await agentPod();

    if (!pod) {
      // Not "no conversations": every one of them is still on the hostPath. Record that the tick
      // could not look, and change nothing.
      return note('the agent pod is not running, so the conversations could not be listed', started);
    }
    if (pod.metadata.name !== agentSeen.pod) {
      agentSeen = { pod: pod.metadata.name, since: Date.now() };
    }

    const out = await podExec(AGENT_NAMESPACE, pod.metadata.name, AGENT_CONTAINER, ['/bin/sh', '/seed/sessions.sh', 'states-all'], 30_000);

    /*
     * The sentinel, and why it is not `out.trim()`.
     *
     * `podExec` hands back stdout and throws away stderr and the exit status (see its note), so an
     * exec that failed - a 403 because the pods/exec rule has not reached this cluster, a pod going
     * away mid-tick, a socket the apiserver abandoned - is indistinguishable from a pod holding no
     * conversations, and from a listing cut off halfway. Folding any of those in as the truth would
     * mark conversations gone and bump counters, which is the one mistake this loop can make that a
     * client cannot recover from. So the script says it ran to the end.
     */
    if (!out.includes('@@end')) {
      return note('the listing did not run to the end; keeping the last snapshot. If this persists, check that the pods/exec rule in api.ts has reached this cluster', started);
    }

    const rows = [];

    for (const line of out.split('\n')) {
      const [id, alive, wrote, head] = line.replace(/\r$/, '').split('\t');

      if (!id || !CONVERSATION_ID.test(id)) {
        continue;
      }
      rows.push({ ...rowOf(id, head), alive: alive === 'yes', wroteAgo: Number(wrote ?? -1) });
    }

    await absorb(rows, pod.metadata.name, agentStartedMs(pod), true, started);
  });
}

/** One row, from an id and the 800-byte head of its state file. */
function rowOf(id, head) {
  let hook = {};

  try {
    hook = JSON.parse(head || '{}');
  } catch { /* a state file caught between the hook's write and its rename; next tick reads it whole */ }

  return {
    id,
    kind:         id.startsWith('agent-') ? 'drawer' : 'workspace',
    workspace:    id.startsWith('agent-') ? '' : id.replace(/^p-/, '').replace(/-\d+$/, ''),
    event:        String(hook.event || ''),
    notification: String(hook.notification || ''),
    message:      String(hook.message || '').slice(0, 500),
    reason:       String(hook.reason || '').slice(0, 80),
    at:           String(hook.at || ''),
    transcript:   String(hook.transcript || ''),
  };
}


/**
 * Fold one observation in, and move a counter where something moved.
 *
 * `stops` and `asks` are the whole of the contract with a client: it holds what they were when it
 * handed work over and compares. So they must move exactly once per turn boundary and never for
 * the clock - `changedAt` and `wroteAgo` change on every tick, and a counter that moved with them
 * would be one no client could ever match.
 *
 * Derived from the stored values rather than incremented in memory, and keyed on the hook's own
 * `at`: two watchers folding the same observation onto the same base reach the same answer, which
 * is what makes the merge-patch clobber during a rollout harmless. The same property is what makes
 * a tick that re-reads an unchanged state file a no-op.
 */
function foldOne(before, seen, state, now) {
  if (!before || before.state === 'gone') {
    return {
      ...seen,
      state,
      was:       '',
      // Adopted, not announced: a conversation seen for the first time has a history this watcher
      // did not observe, and counting it would mean installing this feature credited every
      // conversation in the cluster with a stop it never saw.
      stops:     0,
      asks:      0,
      bornAt:    now,
      changedAt: now,
      hookAt:    seen.at,
    };
  }

  const moved = before.state !== state || before.hookAt !== seen.at || before.alive !== seen.alive;

  if (!moved) {
    return { ...before, ...seen, state, hookAt: seen.at };
  }

  const ended = SETTLED.has(state) && state !== 'input';
  const wasEnded = SETTLED.has(before.state) && before.state !== 'input';

  return {
    ...before,
    ...seen,
    state,
    was:       before.state,
    stops:     before.stops + (ended && !wasEnded ? 1 : 0),
    asks:      before.asks + (state === 'input' && before.state !== 'input' ? 1 : 0),
    changedAt: now,
    hookAt:    seen.at,
  };
}

/** `listing` says this came from the exec, which is the only thing allowed to call one gone. */
async function absorb(rows, pod, podStartedMs, listing, started) {
  const doc = await conversationDoc(true);
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const items = { ...(doc.items || {}) };
  const seen = new Set();
  let changed = false;

  for (const row of rows) {
    seen.add(row.id);
    const before = items[row.id] || null;
    const state = conversationState(row, podStartedMs);

    // Doubt rather than news: a state file caught mid-rename, or a pane whose absence cannot yet
    // be believed. Nothing moves, so nothing anybody put aside comes back on a publish.
    if (!state) {
      continue;
    }

    const gap = watch.first && before && before.hookAt && before.hookAt !== row.at ? hookGap(row.id, before.hookAt, row.at) : null;
    const base = gap ? { ...before, stops: before.stops + gap.stops, asks: before.asks + gap.asks } : before;
    const next = foldOne(base, row, state, now);

    if (SETTLED.has(state) && (!before || before.state !== state)) {
      // What it last said, read once, here. `agentTurnOf` in the browser costs up to five execs
      // for this and the deck prefetches two neighbours; the transcript is on this mount already.
      Object.assign(next, detailOf(row));
    }
    changed = changed || !before || next.stops !== before.stops || next.asks !== before.asks ||
      next.state !== before.state || next.alive !== before.alive;
    items[row.id] = next;
  }

  if (listing) {
    for (const [id, held] of Object.entries(items)) {
      if (held.state === 'gone') {
        if (nowMs - Date.parse(held.changedAt || '') > GONE_TTL_MS) {
          delete items[id];
          changed = true;
        }
        continue;
      }
      if (seen.has(id)) {
        continue;
      }
      /*
       * Its directory has gone, which `end` does deliberately - it is what `new` allocates
       * against. News, and it gets an entry of its own rather than simply disappearing: a client
       * holding a card until this conversation moved would otherwise hold it until somebody
       * noticed. The counters stop here; a reused id gets a new `bornAt` and starts again.
       */
      items[id] = {
        ...held, state: 'gone', was: held.state, alive: false, changedAt: now, said: '', question: null,
      };
      changed = true;
    }
  }

  // The ceiling, enforced on write. A dropped entry is rediscovered by the next listing with fresh
  // counters, which releases anything held against it - the safe direction.
  const ids = Object.keys(items);

  if (ids.length > ITEM_CAP) {
    for (const id of ids.sort((a, b) => Date.parse(items[a].changedAt || '') - Date.parse(items[b].changedAt || '')).slice(0, ids.length - ITEM_CAP)) {
      delete items[id];
    }
    changed = true;
  }

  watch = {
    at: nowMs, ms: nowMs - started, ok: true, detail: '', first: false,
  };
  await writeConversations({ ...doc, at: now, pod, startedAt: podStartedMs, items }, changed);

  for (const row of rows) {
    const next = items[row.id];
    const before = (doc.items || {})[row.id];

    if (next && (!before || before.state !== next.state)) {
      console.log(`[dev-api] conversation ${ row.id }: ${ before?.state || 'new' } -> ${ next.state }${ next.note ? ` (${ next.note })` : '' } (stops ${ next.stops }, asks ${ next.asks })`);
    }
  }
}


/**
 * The hook firings a conversation recorded between the last one this watcher saw and the one it is
 * looking at now.
 *
 * For the gap a restart leaves. dev-api is replaced by every publish and the roll takes up to a
 * minute; a turn that both begins and ends inside that minute leaves the document saying `idle`
 * before and the listing saying `idle` after, so the fold sees no transition and the person who was
 * away for all of it is told nothing happened. The hook's own log is the record that survives - it
 * appends every firing to `<id>.events.jsonl` for exactly this kind of question, trimmed at 512
 * KiB - and this pod has that volume mounted already, so reading it costs nothing.
 *
 * Only the two firings that are worth a count: a Stop (the turn ended) and a Notification that is
 * not an idle prompt (it is waiting). Strictly between the two timestamps, so the firing that
 * produced the state being folded in is counted by the fold and not twice.
 *
 * Once per conversation, on the first tick of a process, and only where the hook has moved since.
 * Zero when the file cannot be read, which includes the case where this pod is on a different node
 * from the agent pod: recovering nothing is the right failure, because these are events that are
 * already over and inventing one is worse than missing one.
 */
function hookGap(id, fromAt, toAt) {
  const from = Date.parse(fromAt || '') || 0;
  const to = Date.parse(toAt || '') || 0;

  if (!from || !to || to <= from) {
    return null;
  }

  const out = { stops: 0, asks: 0 };

  try {
    const lines = fs.readFileSync(`${ AGENT_SESSIONS }/${ id }.events.jsonl`, 'utf8').split('\n');

    // Backwards, and stopped at the first one old enough: the file holds up to five hundred lines
    // and only its tail can be newer than what the document already recorded.
    for (let n = lines.length - 1; n >= 0; n--) {
      if (!lines[n].trim()) {
        continue;
      }
      let event;

      try {
        event = JSON.parse(lines[n]);
      } catch {
        continue;
      }
      const at = Date.parse(event.at || '') || 0;

      if (at <= from) {
        break;
      }
      if (at >= to) {
        continue;
      }
      if (event.event === 'Stop') {
        out.stops++;
      }
      if (event.event === 'Notification' && event.notification && event.notification !== 'idle_prompt') {
        out.asks++;
      }
    }
  } catch {
    return null;
  }

  return out.stops || out.asks ? out : null;
}

/** The same file, as the sequence a person can read. See GET /conversations/{id}/events. */
function hookEvents(id, limit) {
  const want = Math.min(Math.max(1, limit || 50), 200);

  try {
    const lines = fs.readFileSync(`${ AGENT_SESSIONS }/${ id }.events.jsonl`, 'utf8').split('\n');
    const out = [];

    for (let n = lines.length - 1; n >= 0 && out.length < want; n--) {
      if (!lines[n].trim()) {
        continue;
      }
      try {
        const event = JSON.parse(lines[n]);

        out.push({
          event:        String(event.event || ''),
          at:           String(event.at || ''),
          notification: String(event.notification || ''),
          message:      String(event.message || '').slice(0, 500),
          reason:       String(event.reason || ''),
          prompt:       String(event.prompt || '').slice(0, 300),
        });
      } catch { /* a line cut mid-write */ }
    }

    return { mount: true, events: out };
  } catch {
    return { mount: false, events: [] };
  }
}


/**
 * The two things a stopped conversation's card needs that the state file does not carry: what
 * claude last said, and what it is actually asking.
 *
 * Read off the mount, once, when the conversation enters a settled state - not per tick. The hook
 * writes the transcript's absolute path in the pod's own spelling, so `/workspace/...` there is
 * `/agent-workspace/...` here, which also means this never has to guess which project directory it
 * is under: a drawer conversation's is `-workspace-conversations` and a workspace's is
 * `-workspaces-<name>-dashboard`, and `ai_title_of` in sessions.sh only knows the first.
 *
 * The last 128 KiB - several turns - because a transcript runs to many megabytes, and the first
 * line of that is dropped because it was cut in the middle.
 */
function detailOf(row) {
  const local = row.transcript.startsWith(AGENT_PREFIX) ? `${ AGENT_ROOT }/${ row.transcript.slice(AGENT_PREFIX.length) }` : '';
  const detail = { said: '', question: null };

  if (!local) {
    return detail;
  }

  const entries = [];

  for (const line of tailLines(local)) {
    try {
      entries.push(JSON.parse(line));
    } catch { /* a line cut mid-write */ }
  }

  const blocksOf = (e) => {
    const content = e?.message?.content;

    if (typeof content === 'string') {
      return [{ type: 'text', text: content }];
    }

    return Array.isArray(content) ? content : [];
  };
  const answered = new Set();

  // Backwards, and the same rule `pendingQuestion` uses in chat-state.mjs: a question tool with no
  // result yet is pending. A side chain is a subagent's and is not what the conversation waits on.
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];

    if (entry.type === 'user') {
      for (const block of blocksOf(entry)) {
        if (block.type === 'tool_result') {
          answered.add(block.tool_use_id);
        }
      }
      continue;
    }
    if (entry.type !== 'assistant' || entry.isSidechain) {
      continue;
    }
    if (!detail.question) {
      for (const block of blocksOf(entry)) {
        if (block.type !== 'tool_use' || answered.has(block.id)) {
          continue;
        }
        detail.question = QUESTION_TOOLS.has(block.name) ? {
          tool:    block.name,
          header:  String(block.input?.questions?.[0]?.header || (block.name === 'ExitPlanMode' ? 'A plan to approve' : '')).slice(0, 120),
          options: (block.input?.questions?.[0]?.options || []).slice(0, 4).map((o) => String(o?.label || o).slice(0, 80)),
        } : null;
        break;
      }
    }
    if (!detail.said) {
      const text = blocksOf(entry).filter((b) => b.type === 'text').map((b) => String(b.text || '')).join('\n').trim();

      // Not a tag: `latestAgentReport` skips these too - the CLI's own furniture reads as the
      // agent's last word and it is not.
      if (text && !/^</.test(text)) {
        detail.said = text.slice(0, SAID_MAX);
      }
    }
    if (detail.said && detail.question) {
      break;
    }
  }

  return detail;
}

/** The tail of a file as lines, without the first one, which was cut in the middle. */
function tailLines(file, bytes = TAIL_BYTES) {
  let fd = 0;

  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const take = Math.min(size, bytes);
    const buffer = Buffer.alloc(take);

    fs.readSync(fd, buffer, 0, take, size - take);
    const lines = buffer.toString('utf8').split('\n');

    return take < size ? lines.slice(1) : lines;
  } catch {
    return [];
  } finally {
    if (fd) {
      try {
        fs.closeSync(fd);
      } catch { /* already closed */ }
    }
  }
}


/**
 * One tick at a time, whichever kind.
 *
 * The listing and the refresh write the same key, and `writeDoc` is a merge-patch with no
 * precondition - so a refresh that read the document before the listing's write and wrote after it
 * would silently undo a transition. Serialising them inside this process costs nothing (the disk
 * tick is a handful of stats) and removes the only race this design can actually prevent. The
 * overlap between two processes cannot be prevented, which is what the idempotent fold is for.
 */
function once(work) {
  if (!ticking) {
    ticking = work().finally(() => {
      ticking = null;
    });
  }

  return ticking;
}

function note(detail, started) {
  watch = {
    at: Date.now(), ms: Date.now() - started, ok: false, detail, first: watch.first,
  };
  console.error(`[dev-api] conversations: ${ detail }`);
}

/**
 * The freshness a consumer needs, and the two halves of it that must not be confused.
 *
 * `stale` is about the loop: `at` is stamped by every tick whatever happened, so this is "nothing
 * is looking any more", and a client releases everything it was holding on it.
 *
 * `ok`/`detail` are about the last listing only. An exec that failed changes nothing - the states
 * stand as the listing before it left them, old rather than wrong, with `watchedAt` saying how
 * old. A client must NOT release the cards it is holding on `ok: false`: a busy cluster with
 * several working agents is exactly when an exec is most likely to time out, and that is the
 * moment releasing everything would be most wrong.
 *
 * `at: ''` is "has not looked yet", the few seconds after a publish, and is not stale: the counters
 * were read back from the document and are correct.
 */
function freshness() {
  const doc = memo.doc || freshDoc();

  return {
    epoch:      doc.epoch || '',
    pod:        doc.pod || '',
    podSettled: !agentSeen.since || Date.now() - agentSeen.since > POD_SETTLE_MS,
    watchedAt:  watch.at ? new Date(watch.at).toISOString() : '',
    ageMs:      watch.at ? Date.now() - watch.at : -1,
    stale:      !!watch.at && Date.now() - watch.at > STALE_MS,
    ok:         watch.ok,
    detail:     watch.detail,
  };
}

async function conversationsAnswer(url) {
  const doc = await conversationDoc();
  const workspace = url.searchParams.get('workspace') || '';
  const states = (url.searchParams.get('state') || '').split(',').filter(Boolean);
  const conversations = Object.values(doc.items || {})
    .filter((c) => !workspace || c.workspace === workspace)
    .filter((c) => !states.length || states.includes(c.state))
    .sort((a, b) => String(b.changedAt).localeCompare(String(a.changedAt)));

  return { conversations, ...freshness() };
}

const routes = [
  /*
   * The health check, and nothing else.
   *
   * This is what the readiness probe GETs, and it used to answer with the list of Apps Plus
   * templates - so the probe depended on another product's CRDs being installed on this cluster.
   * On a downstream cluster they are not: Apps Plus lives on `local`, `apps()` got HTML back from
   * the apiserver, the route threw, and the probe failed every ten seconds forever. The pod ran
   * perfectly and was never Ready, so nothing could route to it and a workspace there waited on a
   * service that was up the whole time.
   *
   * A readiness probe answers one question: is this process able to serve. Templates moved to
   * /templates, which is where the only caller was already looking.
   */
  ['GET', /^\/$/, async() => ({ api: 'ok' })],
  // -- Conversations -------------------------------------------------------------------------
  //
  // What every claude in the Studio's agent pod is doing, and how many times each has stopped
  // and asked. Watched here (reconcileConversations) rather than read by a browser, which is the
  // whole of the change: every read of this used to be an exec issued BY a tab, so with no tab
  // open nothing observed anything - and the two moments worth knowing about, "it finished" and
  // "it is asking you something", are by definition moments when nobody is watching.
  //
  // A snapshot and two counters rather than a log. `stops` and `asks` are what a client compares
  // against what it last acted on; what they cannot say is which way the news went, and that is
  // paid where it is cheapest - the card comes back either way, and what it is about is read off
  // the conversation when the card is drawn. The sequence, when somebody wants it, is the hook's
  // own events.jsonl: see /conversations/{id}/events.
  ['GET', /^\/conversations$/, async(m, url) => conversationsAnswer(url)],
  ['GET', /^\/conversations\/(agent-\d+|p-[a-z0-9-]+-\d+)$/, async(m) => {
    const held = (await conversationDoc()).items?.[m[1]];

    if (!held) {
      throw failure(404, `No conversation called ${ m[1] }.`);
    }

    return { conversation: held, ...freshness() };
  }],
  // The sequence, read off the hook's own log rather than from a log of our own. The id pattern
  // is spelled out rather than `[^/]+` because this one interpolates into a path.
  ['GET', /^\/conversations\/(agent-\d+|p-[a-z0-9-]+-\d+)\/events$/, async(m, url) => ({
    id: m[1], ...hookEvents(m[1], Number(url.searchParams.get('limit') || 50)),
  })],
  // Look now rather than at the next tick. One caller: a page that has just set an agent
  // working. Without it the card it put aside comes back for one tick at the counters it was put
  // aside at, on top of somebody who has just dealt with it. At most one listing in flight
  // however many tabs press it.
  ['POST', /^\/conversations\/refresh$/, async() => {
    await listingTick();

    return conversationsAnswer(new URL('http://dev-api/conversations'));
  }],
  ['GET', /^\/templates$/, async() => ({ templates: await apps() })],
  // What a workspace is laid out from: the extension's own files, with the skills, rules and
  // CLAUDE.md from codyrancher/ai-skills over them. Served because an exec command is URL
  // arguments and this is most of a megabyte.
  ['GET', /^\/agent-seed$/, async() => agentSeed()],
  ['GET', /^\/agent-seed\/version$/, async() => ({ version: await seedVersion() })],
  ['GET', /^\/skills$/, async() => ({ skills: await listSkills(), version: await seedVersion() })],
  ['GET', /^\/prompts$/, async() => ({ prompts: await promptOverrides() })],
  ['PUT', /^\/prompts\/([a-z0-9-]+)$/, async(m, url, body) => {
    const template = String(body?.template || '');

    if (!template.trim()) {
      throw failure(400, 'The prompt is empty.');
    }
    await writeConfigValue(`prompt__${ m[1] }`, template);

    return { ok: true };
  }],
  ['DELETE', /^\/prompts\/([a-z0-9-]+)$/, async(m) => {
    await writeConfigValue(`prompt__${ m[1] }`, null).catch(() => {});

    return { ok: true };
  }],
  // ── The Focus view's own document ─────────────────────────────────────────────────────────
  //
  // Three things, in one ConfigMap: the cards (what a kind of work looks like when it is in
  // front of you), the weights (what each rule in the priority queue is worth) and the tasks
  // somebody wrote by hand. All three are data rather than code so they can be changed from the
  // page - and, more to the point, by an agent: "make a card for X" is a thing to ask for, and
  // what comes back is a PUT here rather than a pull request.
  //
  // Defaults live in the browser (focus.ts), the way the skills' do: an empty document means
  // the shipped cards, not an empty page.
  ['GET', /^\/focus$/, async() => readFocus()],
  ['PUT', /^\/focus$/, async(m, url, body) => writeFocus(body)],
  ['GET', /^\/openapi.json$/, async() => OPENAPI],
  ['GET', /^\/focus\/cards$/, async() => listCards()],
  ['GET', /^\/focus\/cards\/([a-z0-9-]+)$/, async(m) => readCard(m[1])],
  ['PUT', /^\/focus\/cards\/([a-z0-9-]+)$/, async(m, url, body) => writeCard(m[1], body)],
  ['DELETE', /^\/focus\/cards\/([a-z0-9-]+)$/, async(m) => deleteCard(m[1])],
  ['GET', /^\/skills\/([a-z0-9-]+)$/, async(m) => readSkill(m[1])],
  ['PUT', /^\/skills\/([a-z0-9-]+)$/, async(m, url, body) => saveSkill(m[1], body)],
  ['POST', /^\/skills\/([a-z0-9-]+)\/reset$/, async(m, url, body) => {
    if (!SKILL_NAME.test(m[1])) {
      throw failure(400, 'Not a skill name.');
    }
    const path = String(body?.path || url.searchParams.get('path') || 'SKILL.md');

    if (path !== 'SKILL.md' && !SKILL_FILE.test(path)) {
      throw failure(400, `${ path } is not a file of a skill.`);
    }
    await dropSkillOverride(m[1], path);

    return { ok: true, version: await seedVersion() };
  }],
  // One piece of a comment's evidence, on GitHub's CDN and ready to embed. The review panel asks
  // for this as it submits, so a screenshot or a recording lands in the comment itself rather
  // than as a sentence naming a path nobody reading the PR can reach.
  ['POST', /^\/my-work\/pr\/(\d+)\/upload$/, async(m, url, body) => {
    const num = Number(m[1]);
    const file = artifactFile(body?.path, num);

    if (!file) {
      throw new Error(`No such file in the agent workspace: ${ body?.path }`);
    }

    const repo = typeof body?.repo === 'string' && body.repo.includes('/') ? body.repo : DEFAULT_REPO;
    const { href, cached } = await uploadToGithub(file, `https://github.com/${ repo }/pull/${ num }`);

    return {
      href, cached, name: path.basename(file), kind: attachmentKind(file),
    };
  }],
  // Ask for a run of an agent (the dashboard's Agents page; see agent-defs.ts). The run is
  // recorded as requested here and started by the next dashboard tick, which has the browser
  // session the start needs. `note` rides along into the run's record.
  ['POST', /^\/agents\/([a-z0-9-]+)\/trigger$/, async(m, url, body) => {
    const name = m[1];
    const runs = (await readDoc(`dev-agent-runs-${ name }`, 'runs.json')) || [];
    const run = {
      id: `${ Date.now().toString(36) }${ Math.random().toString(36).slice(2, 6) }`, agent: name, trigger: 'api', workspace: '', conversation: '', state: 'requested', startedAt: new Date().toISOString(), note: typeof body?.note === 'string' ? body.note.slice(0, 200) : '',
    };

    runs.push(run);
    await writeDoc(`dev-agent-runs-${ name }`, 'runs.json', runs.slice(-50), { 'dev.rancher.io/kind': 'agent-runs', 'dev.rancher.io/agent': name });

    return { queued: true, run };
  }],
  ['GET', /^\/agents\/([a-z0-9-]+)\/runs$/, async(m) => ({ runs: (await readDoc(`dev-agent-runs-${ m[1] }`, 'runs.json')) || [] })],
  ['GET', /^\/workspaces$/, async() => {
    const list = await k8s(`${ INSTANCES }?labelSelector=${ LABEL_WORKSPACE }`);

    return {
      workspaces: (list.items || []).map((instance) => ({
        name:      instance.metadata.labels[LABEL_WORKSPACE],
        namespace: instance.spec?.namespace || `dev-${ instance.metadata.labels[LABEL_WORKSPACE] }`,
        app:       instance.spec?.app || '',
        cluster:   instance.metadata.labels[LABEL_CLUSTER] || 'local',
        createdAt: instance.metadata.creationTimestamp,
      })),
    };
  }],
  ['POST', /^\/workspaces$/, async(m, url, body) => {
    const problem = nameError(body.name);

    if (problem) {
      throw failure(400, problem);
    }

    // The leased App by default, which is what new work gets everywhere else: this is the path
    // with no browser behind it - an agent, a script - and it used to be the one place that
    // still made an all-in-one workspace without being asked to.
    return makeWorkspace(body.name, body.app || body.template || LTE_APP, body.cluster || 'local');
  }],

  // -- Tools ---------------------------------------------------------------------------------
  //
  // What a leased workspace attaches when it needs it. Reachable by an agent from inside the
  // cluster (`$CLAUDE_HARNESS_API/tools/...`, which is what `bin/tools` calls) and by the page.
  ['GET', /^\/tools$/, async() => {
    const namespaces = await k8s(`/api/v1/namespaces?labelSelector=${ encodeURIComponent(LABEL_TOOL) }`).catch(() => ({ items: [] }));
    const tools = [];

    for (const ns of namespaces.items || []) {
      const kind = ns.metadata?.labels?.[LABEL_TOOL];
      const owner = ns.metadata?.labels?.[LABEL_TOOL_OF];

      if (kind && owner) {
        tools.push(await podTool(owner, kind).catch(() => ({ kind, workspace: owner, running: true })));
      }
    }

    // The shared browser belongs to every workspace at once, so it is not listed here: there is
    // nothing per-workspace about it to report. `GET /tools/<workspace>` includes it.
    return { tools };
  }],
  ['GET', /^\/tools\/([a-z0-9-]+)$/, async(m) => ({ workspace: m[1], tools: await toolsOf(m[1]) })],
  ['GET', /^\/tools\/([a-z0-9-]+)\/([a-z-]+)$/, async(m) => toolState(m[1], m[2])],
  ['POST', /^\/tools\/([a-z0-9-]+)\/([a-z-]+)$/, async(m, url, body) => startTool(m[1], m[2], body)],
  ['POST', /^\/tools\/([a-z0-9-]+)\/([a-z-]+)\/renew$/, async(m, url, body) => renewTool(m[1], m[2], body?.minutes)],
  ['GET', /^\/tools\/([a-z0-9-]+)\/([a-z-]+)\/logs$/, async(m, url) => toolLogs(m[1], m[2], url.searchParams.get('tail'))],
  ['DELETE', /^\/tools\/([a-z0-9-]+)\/([a-z-]+)$/, async(m) => stopTool(m[1], m[2])],

  // The harness's /my-work API, as far as its skills need it.
  ['GET', /^\/my-work\/pr\/(\d+)$/, (m, url) => prDetail(repoOf(url), Number(m[1]))],
  ['GET', /^\/my-work\/pr\/(\d+)\/comments$/, async(m) => (await localComments(Number(m[1]))).map(decorate)],
  ['POST', /^\/my-work\/pr\/(\d+)\/comments$/, async(m, url, body) => {
    const num = Number(m[1]);
    const prLevel = body.level === 'pr' || !body.path;

    if (typeof body.body !== 'string' || !body.body.trim()) {
      throw failure(400, 'body is required');
    }

    const comments = await localComments(num);
    const id = comments.reduce((max, c) => Math.max(max, c.id), 0) + 1;
    const now = new Date().toISOString();
    const created = {
      id,
      pr:           num,
      path:         prLevel ? '' : String(body.path),
      line:         prLevel || !Number.isFinite(body.line) ? null : body.line,
      start_line:   prLevel || !Number.isFinite(body.startLine) ? null : body.startLine,
      side:         body.side === 'LEFT' ? 'LEFT' : 'RIGHT',
      body:         body.body.trim(),
      status:       'pending',
      author:       typeof body.author === 'string' ? body.author.slice(0, 40) : 'agent',
      attachments:  cleanAttachments(body.attachments),
      created_at:   now,
      updated_at:   now,
      submitted_at: null,
    };

    comments.push(created);
    await saveComments(num, comments);

    return decorate(created);
  }],
  ['PUT', /^\/my-work\/pr\/(\d+)\/comments\/(\d+)$/, async(m, url, body) => {
    const num = Number(m[1]);
    const comments = await localComments(num);
    const existing = comments.find((c) => c.id === Number(m[2]));

    if (!existing) {
      throw failure(404, 'comment not found');
    }

    if (typeof body.body === 'string' && body.body.trim()) {
      existing.body = body.body.trim();
    }
    if (body.status === 'approved' || body.status === 'pending') {
      existing.status = body.status;
    }
    if (Number.isFinite(body.line)) {
      existing.line = body.line;
    }
    if (typeof body.path === 'string') {
      existing.path = body.path;
    }
    if (body.submitted_at !== undefined) {
      existing.submitted_at = body.submitted_at;
    }
    // A list replaces the evidence; an empty list detaches it all; nothing leaves it alone.
    if (body.attachments !== undefined) {
      existing.attachments = cleanAttachments(body.attachments);
    }
    existing.updated_at = new Date().toISOString();
    await saveComments(num, comments);

    return decorate(existing);
  }],
  ['DELETE', /^\/my-work\/pr\/(\d+)\/comments\/(\d+)$/, async(m) => {
    const num = Number(m[1]);

    await saveComments(num, (await localComments(num)).filter((c) => c.id !== Number(m[2])));

    return { ok: true };
  }],
  // A file as it is at a ref - the PR head - for expanding the context between hunks.
  ['GET', /^\/my-work\/pr\/(\d+)\/file$/, async(m, url) => {
    const filePath = url.searchParams.get('path') || '';
    const ref = url.searchParams.get('ref') || '';

    if (!filePath || !ref) {
      throw failure(400, 'path and ref are required');
    }

    const token = await githubToken();
    const response = await fetch(`https://api.github.com/repos/${ repoOf(url) }/contents/${ encodeURI(filePath) }?ref=${ encodeURIComponent(ref) }`, {
      headers: { authorization: `Bearer ${ token }`, accept: 'application/vnd.github.raw', 'user-agent': 'dev-extension' },
    });

    if (!response.ok) {
      throw failure(502, `GitHub contents -> ${ response.status }`);
    }

    return { content: await response.text() };
  }],
  // The files a subset of the PR's commits changed. A contiguous run is one compare; anything
  // else is each commit's own patch, labelled, since line numbers differ per commit.
  ['GET', /^\/my-work\/pr\/(\d+)\/commits-diff$/, async(m, url) => {
    const repo = repoOf(url);
    const num = Number(m[1]);
    const shas = (url.searchParams.get('shas') || '').split(',').map((sha) => sha.trim()).filter(Boolean);

    if (!shas.length) {
      throw failure(400, 'shas is required');
    }

    const order = ((await ghRest('GET', `/repos/${ repo }/pulls/${ num }/commits?per_page=100`)) || []).map((c) => c.sha);
    const idxs = shas.map((sha) => order.indexOf(sha)).filter((i) => i >= 0).sort((a, b) => a - b);

    if (!idxs.length) {
      throw failure(400, 'none of those commits are in this PR');
    }

    const asFile = (f) => ({
      path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch || '',
    });

    if (idxs[idxs.length - 1] - idxs[0] === idxs.length - 1) {
      const meta = await ghRest('GET', `/repos/${ repo }/pulls/${ num }`);
      const base = idxs[0] === 0 ? meta.base?.sha : order[idxs[0] - 1];
      const cmp = await ghRest('GET', `/repos/${ repo }/compare/${ base }...${ order[idxs[idxs.length - 1]] }`);

      return { combined: true, files: (cmp.files || []).map(asFile) };
    }

    const perCommit = await Promise.all(idxs.map((i) => ghRest('GET', `/repos/${ repo }/commits/${ order[i] }`)));
    const byFile = new Map();

    perCommit.forEach((commit, n) => {
      const sha = order[idxs[n]].slice(0, 7);

      for (const f of commit.files || []) {
        const cur = byFile.get(f.filename) || {
          path: f.filename, status: f.status, additions: 0, deletions: 0, patch: '',
        };

        cur.additions += f.additions || 0;
        cur.deletions += f.deletions || 0;
        if (f.patch) {
          cur.patch += `${ cur.patch ? '\n' : '' }@@ -0,0 +0,0 @@ -- ${ sha } --\n${ f.patch }`;
        }
        byFile.set(f.filename, cur);
      }
    });

    return { combined: false, files: [...byFile.values()].sort((a, b) => a.path.localeCompare(b.path)) };
  }],
  ['GET', /^\/my-work\/pr\/(\d+)\/review-run$/, async(m) => {
    const run = await readDoc(reviewMap(Number(m[1])), 'run.json');

    rememberReviewWorkspace(m[1], run);

    return { run };
  }],
  ['POST', /^\/my-work\/pr\/(\d+)\/review-run$/, async(m, url, body) => {
    const num = Number(m[1]);
    const state = String(body.state || '');

    if (!RUN_STATES.includes(state)) {
      throw failure(400, `bad state; one of ${ RUN_STATES.join(', ') }`);
    }

    const previous = (await readDoc(reviewMap(num), 'run.json')) || {};
    const run = {
      pr:        num,
      project:   typeof body.project === 'string' ? body.project : (previous.project || null),
      state,
      note:      typeof body.note === 'string' ? body.note.slice(0, 400) : '',
      startedAt: previous.startedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await writeDoc(reviewMap(num), 'run.json', run, { 'dev.rancher.io/pr': String(num) });
    rememberReviewWorkspace(num, run);

    return { run };
  }],
  ['GET', /^\/my-work\/pr\/(\d+)\/ci$/, (m, url) => ciFailures(repoOf(url), Number(m[1]))],
  ['GET', /^\/my-work\/pr\/(\d+)\/ci\/(\d+)$/, (m, url) => ciFailureDetail(repoOf(url), Number(m[1]), Number(m[2]))],
  ['GET', /^\/my-work\/pr\/(\d+)\/ci\/(\d+)\/log$/, (m, url) => ciFailureLog(repoOf(url), Number(m[1]), Number(m[2]))],
  ['GET', /^\/my-work\/dependabot$/, (m, url) => fetchDependabot(repoOf(url))],
  ['GET', /^\/my-work\/dependabot\/pr\/(\d+)\/review-context$/, (m, url) => dependabotReviewContext(repoOf(url), Number(m[1]))],
  ['GET', /^\/my-work\/dependabot\/reviews$/, async() => ({ reviews: (await readDoc('dev-review-dependabot', 'reviews.json')) || {} })],
  ['PUT', /^\/my-work\/dependabot\/reviews\/(\d+)$/, async(m, url, body) => {
    const all = (await readDoc('dev-review-dependabot', 'reviews.json')) || {};

    all[m[1]] = { ...(all[m[1]] || {}), ...body, pr: Number(m[1]), updatedAt: new Date().toISOString() };
    await writeDoc('dev-review-dependabot', 'reviews.json', all);

    return { review: all[m[1]] };
  }],
  ['DELETE', /^\/my-work\/dependabot\/reviews\/(\d+)$/, async(m) => {
    const all = (await readDoc('dev-review-dependabot', 'reviews.json')) || {};

    delete all[m[1]];
    await writeDoc('dev-review-dependabot', 'reviews.json', all);

    return { ok: true };
  }],
];

// ── Workspace teardown reconciler ────────────────────────────────────────────
//
// Deleting a workspace is several requests, and it used to run every one of them in the browser.
// A workspace is a Fleet deployment: an Installation (appsplus AppInstance) renders to a `Bundle`,
// which Fleet turns into a `BundleDeployment` that owns Helm release `apps-plus-<name>` and the
// `dev-<name>` namespace. A UI delete could drop the Bundle and leave the BundleDeployment behind
// - orphaned, finalizer still set - and the orphan keeps reinstalling the release, so the
// namespace reappears within seconds and the workspace looks undeletable (this was "delete isn't
// stable" and workspaces that "keep coming back"). It could also leave this extension's own bits:
// the credentials RoleBinding in dev-system, and a namespace stranded when the Installation was
// gone before its Bundle could take it.
//
// This loop finishes teardown here instead, on an interval, so it no longer depends on whoever
// pressed delete staying on the page. It only ever touches a workspace whose Installation is
// already gone; anything with a live Installation is healthy or mid-delete and is Apps Plus's to
// handle. The node tree (gigabytes of checkout) is not here: this pod mounts /dev-workspaces
// read-only, and it is pruned where it lives, from the agent pod.
const WS_SA = 'dev-workspace';
const CREDS_BINDING_RE = new RegExp(`^creds-${ WS_SA }-dev-(.+)$`);
const APPS_PLUS_PREFIX = 'apps-plus-';
const BUNDLES = '/apis/fleet.cattle.io/v1alpha1/bundles';
const BUNDLE_DEPLOYMENTS = '/apis/fleet.cattle.io/v1alpha1/bundledeployments';

async function reconcileTeardown() {
  const instances = await installations('reconcile');

  if (!instances) {
    return;
  }

  const live = new Set((instances.items || []).map((i) => i.metadata?.name).filter(Boolean));

  // The Fleet layer, read before anything is removed. `apps-plus-<name>` Bundles say which
  // workspaces Fleet still means to deploy; the BundleDeployments are what actually reinstall
  // them. A namespace is only removed directly when there is no BundleDeployment left to bring
  // it back.
  const bundles = await k8s(BUNDLES).catch(() => null);
  const bundled = new Set((bundles?.items || [])
    .map((b) => b.metadata?.name || '')
    .filter((n) => n.startsWith(APPS_PLUS_PREFIX))
    .map((n) => n.slice(APPS_PLUS_PREFIX.length)));

  const deployments = await k8s(BUNDLE_DEPLOYMENTS).catch(() => null);
  const bdByWorkspace = new Map();

  for (const bd of deployments?.items || []) {
    const name = bd.metadata?.name || '';

    if (name.startsWith(APPS_PLUS_PREFIX)) {
      bdByWorkspace.set(name.slice(APPS_PLUS_PREFIX.length), bd);
    }
  }

  // 1) Orphaned BundleDeployments: the Installation is gone and so is the Bundle, but the
  //    BundleDeployment is still there reinstalling the workspace. Delete it - the Fleet agent
  //    releases its finalizer, uninstalls Helm and removes the namespace in ~15s. A BundleDeployment
  //    whose Bundle still exists is left alone: deleting it would only have Fleet's Bundle
  //    controller recreate it, and it means Apps Plus's own teardown is still in flight.
  for (const [name, bd] of bdByWorkspace) {
    if (live.has(name) || bundled.has(name) || bd.metadata?.deletionTimestamp) {
      continue;
    }

    const bdNs = bd.metadata?.namespace;

    await k8s(`/apis/fleet.cattle.io/v1alpha1/namespaces/${ bdNs }/bundledeployments/${ bd.metadata.name }`, { method: 'DELETE' })
      .then(() => console.log(`[dev-api] reconciled orphaned BundleDeployment ${ bdNs }/${ bd.metadata.name } (workspace ${ name })`))
      .catch((e) => {
        if (e.status !== 404) {
          console.error(`[dev-api] reconcile: bundledeployment ${ bd.metadata?.name }:`, e.message || e);
        }
      });
  }

  // 2) Namespaces still labelled for a workspace whose Installation is gone and which has no
  //    BundleDeployment to recreate it - a true remnant nothing will bring back.
  const namespaces = await k8s(`/api/v1/namespaces?labelSelector=${ encodeURIComponent(LABEL_WORKSPACE) }`).catch(() => null);

  for (const ns of namespaces?.items || []) {
    const name = ns.metadata?.labels?.[LABEL_WORKSPACE];

    if (!name || live.has(name) || bdByWorkspace.has(name) || ns.metadata?.deletionTimestamp) {
      continue;
    }

    const nsName = ns.metadata.name;

    try {
      if (nsName === `dev-${ name }`) {
        // This product's own namespace, whose Bundle is gone and will not take it.
        await k8s(`/api/v1/namespaces/${ nsName }`, { method: 'DELETE' });
      } else {
        // A workspace label stranded on a shared namespace (a workspace once mapped onto
        // `default`): drop the label, never delete the namespace.
        await k8s(`/api/v1/namespaces/${ nsName }`, { method: 'PATCH', body: JSON.stringify({ metadata: { labels: { [LABEL_WORKSPACE]: null, [LABEL_APP]: null, [LABEL_CLUSTER]: null } } }) });
      }
      console.log(`[dev-api] reconciled teardown of workspace ${ name } (namespace ${ nsName })`);
    } catch (e) {
      if (e.status !== 404) {
        console.error(`[dev-api] reconcile: namespace ${ nsName }:`, e.message || e);
      }
    }
  }

  // 3) Credentials bindings left in dev-system by a workspace that is fully gone - no Installation,
  //    and no BundleDeployment that will make one again.
  const bindings = await k8s(`/apis/rbac.authorization.k8s.io/v1/namespaces/${ NAMESPACE }/rolebindings`).catch(() => null);

  for (const rb of bindings?.items || []) {
    const match = CREDS_BINDING_RE.exec(rb.metadata?.name || '');

    if (!match || live.has(match[1]) || bdByWorkspace.has(match[1]) || rb.metadata?.deletionTimestamp) {
      continue;
    }

    await k8s(`/apis/rbac.authorization.k8s.io/v1/namespaces/${ NAMESPACE }/rolebindings/${ rb.metadata.name }`, { method: 'DELETE' }).catch((e) => {
      if (e.status !== 404) {
        console.error(`[dev-api] reconcile: binding ${ rb.metadata.name }:`, e.message || e);
      }
    });
  }

  // 4) Abandoned previews. A share is a separate installation of the dashboard-preview App, one
  //    per workspace, named `preview-<ws>` / `storybook-<ws>` (see previews.ts). deleteWorkspace
  //    removes them now, but a workspace torn down another way - kubectl, a delete that failed
  //    part way, or one from before that cascade existed - leaves the preview standing as an
  //    installation nothing else owns, which is what fills the Apps list with dead rows. Remove
  //    any whose workspace installation is gone; deleting the installation takes its Bundle and
  //    namespace with it, and steps 1-3 above collect whatever Fleet leaves behind.
  for (const inst of (await k8s(INSTANCES).catch(() => ({ items: [] }))).items || []) {
    if (inst.spec?.app !== PREVIEW_APP) {
      continue;
    }
    const name = inst.metadata?.name || '';
    const base = name.replace(/^(?:preview|storybook)-/, '');

    if (base === name || live.has(base) || inst.metadata?.deletionTimestamp) {
      continue;
    }
    // A grace window, so a preview is never taken in the moments before its workspace's own
    // installation appears - though in practice the workspace is always created first.
    const created = Date.parse(inst.metadata?.creationTimestamp || '');

    if (Number.isFinite(created) && Date.now() - created < 10 * 60 * 1000) {
      continue;
    }

    await k8s(`${ INSTANCES }/${ name }`, { method: 'DELETE' })
      .then(() => console.log(`[dev-api] reconciled abandoned preview ${ name } (workspace ${ base } gone)`))
      .catch((e) => {
        if (e.status !== 404) {
          console.error(`[dev-api] reconcile: preview ${ name }:`, e.message || e);
        }
      });
  }
}

// ── Workspace registrar + finishing deletes ──────────────────────────────────
//
// Two jobs the browser used to own, moved here so they no longer need a tab open:
//   - project the local AppInstances into one ConfigMap the sidebar reads, instead of the browser
//     fanning three Steve reads out to every cluster (which flaps on a downstream one);
//   - finish a delete - clear the cleanup finalizer once the Bundle is gone - which otherwise left
//     a workspace Terminating forever when the tab that pressed delete went away.
// The AppInstance stays the source of truth; the registrar is only a projection of it.
const REGISTRAR = 'dev-workspaces';
const DOWNSTREAM_STATE = 'dev-workspaces-downstream';
const CLEANUP_FINALIZER = 'appsplus.io/cleanup';
const PORT_ANNOTATION = 'dev.rancher.io/port';
const SCHEME_ANNOTATION = 'dev.rancher.io/scheme';
const TITLE_ANNOTATION = 'dev.rancher.io/title';
const PREVIEW_ANNOTATION = 'dev.rancher.io/preview';
const DEFAULT_WORKSPACE_PORT = 8005;
const DEFAULT_WORKSPACE_SCHEME = 'http';
// Container waiting reasons that are a failure, not a stage of starting (mirror api.ts).
const FAILED_REASONS = ['CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull', 'InvalidImageName', 'CreateContainerConfigError', 'CreateContainerError'];

// The derivations below are ports of the browser's (api.ts stateOf/podDetail/replicaFailure/
// workspaceFrom/workspaceFromInstance), so a workspace reads the same whether the sidebar got it
// from the registrar or a page read it live.
function podDetail(pod) {
  if (!pod) return '';
  if (pod.metadata?.deletionTimestamp) return 'Terminating';
  const st = pod.status?.containerStatuses?.[0];
  const waiting = st?.state?.waiting;

  if (waiting?.reason) return `${ waiting.reason }${ st.restartCount ? `, restarted ${ st.restartCount } times` : '' }`;
  if (pod.status?.phase === 'Pending') return 'Waiting to be scheduled';
  if (st?.state?.running && !st.ready) return st.restartCount ? `Starting up, restarted ${ st.restartCount } times` : 'Starting up';

  return '';
}

function replicaFailure(deployment) {
  const c = (deployment?.status?.conditions || []).find((e) => e.type === 'ReplicaFailure' && e.status === 'True');

  return c?.message || '';
}

function stateOf(namespace, deployment, pod) {
  if (namespace?.metadata?.deletionTimestamp) return 'removing';
  if (!deployment) return 'creating';
  if ((deployment.spec?.replicas ?? 0) === 0) return 'stopped';
  if ((deployment.status?.readyReplicas ?? 0) > 0) return 'running';
  if (!pod && replicaFailure(deployment)) return 'error';
  const reason = pod?.status?.containerStatuses?.[0]?.state?.waiting?.reason || '';

  return FAILED_REASONS.some((f) => reason.includes(f)) ? 'error' : 'starting';
}

function workspaceFromLocal(ns, deployment, pod) {
  const a = ns.metadata?.annotations || {};
  const labels = ns.metadata?.labels || {};

  return {
    name:      labels[LABEL_WORKSPACE],
    title:     a[TITLE_ANNOTATION] || '',
    namespace: ns.metadata.name,
    cluster:   labels[LABEL_CLUSTER] || 'local',
    app:       labels[LABEL_APP] || '',
    port:      Number(a[PORT_ANNOTATION]) || DEFAULT_WORKSPACE_PORT,
    scheme:    a[SCHEME_ANNOTATION] === 'https' ? 'https' : DEFAULT_WORKSPACE_SCHEME,
    preview:   a[PREVIEW_ANNOTATION] === 'true',
    state:     stateOf(ns, deployment, pod),
    createdAt: ns.metadata.creationTimestamp || '',
    image:     deployment?.spec?.template?.spec?.containers?.[0]?.image || '',
    replicas:  deployment?.spec?.replicas ?? 0,
    ready:     deployment?.status?.readyReplicas ?? 0,
    detail:    podDetail(pod) || (pod ? '' : replicaFailure(deployment)),
  };
}

function workspaceFromInstance(inst) {
  const labels = inst.metadata?.labels || {};
  const values = inst.spec?.values || {};
  const name = labels[LABEL_WORKSPACE] || inst.metadata?.name || '';

  return {
    name,
    title:     '',
    namespace: inst.spec?.namespace || `dev-${ name }`,
    cluster:   labels[LABEL_CLUSTER] || 'local',
    app:       labels[LABEL_APP] || '',
    port:      Number(values.port) || DEFAULT_WORKSPACE_PORT,
    scheme:    values.scheme === 'https' ? 'https' : DEFAULT_WORKSPACE_SCHEME,
    preview:   inst.spec?.app === PREVIEW_APP,
    state:     'starting',
    createdAt: inst.metadata?.creationTimestamp || '',
    image:     '',
    replicas:  0,
    ready:     0,
    detail:    'coming up',
  };
}

// Index labelled objects by workspace name (last wins, as listWorkspaces' own map build does).
function byWorkspace(list) {
  const map = new Map();

  for (const item of list?.items || []) {
    const ws = item.metadata?.labels?.[LABEL_WORKSPACE];

    if (ws) map.set(ws, item);
  }

  return map;
}

async function reconcileRegistrar(instances) {
  // Local objects only; a downstream workspace's Deployment/pod live on its own cluster and are
  // reported into DOWNSTREAM_STATE by the agent pod instead (it alone can reach them).
  const [deps, pods, nss] = await Promise.all([
    k8s(`/apis/apps/v1/deployments?labelSelector=${ encodeURIComponent(LABEL_WORKSPACE) }`).catch(() => null),
    k8s(`/api/v1/pods?labelSelector=${ encodeURIComponent(LABEL_WORKSPACE) }`).catch(() => null),
    k8s(`/api/v1/namespaces?labelSelector=${ encodeURIComponent(LABEL_WORKSPACE) }`).catch(() => null),
  ]);

  // These three reads DECIDE each local workspace's state. If any failed, a workspace whose objects
  // we could not read falls to workspaceFromInstance ('starting') - wrong, and written with a fresh
  // timestamp the browser would trust over its own live path. Skip the write; the existing ConfigMap
  // ages into staleness and the browser falls back to querying clusters. Never publish a guess.
  if (!deps || !pods || !nss) {
    console.error('[dev-api] reconcileRegistrar: a local list read failed, leaving registrar unchanged this tick');

    return;
  }
  const depBy = byWorkspace(deps);
  const podBy = byWorkspace(pods);
  const nsBy = byWorkspace(nss);
  const downstream = (await readDoc(DOWNSTREAM_STATE, 'state.json').catch(() => null)) || {};
  const workspaces = [];

  for (const inst of instances.items || []) {
    const labels = inst.metadata?.labels || {};
    const name = labels[LABEL_WORKSPACE];

    if (!name) continue;
    const cluster = labels[LABEL_CLUSTER] || 'local';
    let ws;

    if (cluster === 'local' && nsBy.has(name)) {
      ws = workspaceFromLocal(nsBy.get(name), depBy.get(name), podBy.get(name));
    } else {
      ws = workspaceFromInstance(inst);
      if (cluster !== 'local') {
        const ds = downstream[name];

        if (ds?.state) {
          ws.state = ds.state;
          ws.detail = ds.detail || ws.detail;
          ws.replicas = ds.replicas ?? ws.replicas;
          ws.ready = ds.ready ?? ws.ready;
        }
      }
    }
    if (inst.metadata?.deletionTimestamp) ws.state = 'removing';
    workspaces.push(ws);
  }
  workspaces.sort((a, b) => a.name.localeCompare(b.name));

  await writeDoc(REGISTRAR, 'workspaces.json', { at: new Date().toISOString(), workspaces }, { 'dev.rancher.io/kind': 'registrar' });
}

// The server-side half of releaseWhenEmpty (appinstance.js): a workspace Installation with the
// cleanup finalizer stays Terminating until its Bundle is deleted and the finalizer cleared. Only
// workspace Installations that provision no cluster (all of them) - a cluster-provisioning instance
// is left to the browser, whose teardown also removes the downstream cluster.
async function finishDeletes(instances, bundles) {
  // A failed Bundle read arrives as null. Treating that as "no bundles" would clear a workspace's
  // cleanup finalizer while its Bundle (and the running release) still exist - the one thing the
  // finalizer exists to prevent. On any doubt, do nothing this tick, exactly as the instance read.
  if (!bundles) return;

  const bundlesBy = new Map();

  for (const b of bundles?.items || []) {
    const n = b.metadata?.name || '';

    if (n.startsWith(APPS_PLUS_PREFIX)) {
      const ws = n.slice(APPS_PLUS_PREFIX.length);

      if (!bundlesBy.has(ws)) bundlesBy.set(ws, []);
      bundlesBy.get(ws).push(b);
    }
  }

  for (const inst of instances.items || []) {
    const meta = inst.metadata || {};
    const name = meta.labels?.[LABEL_WORKSPACE];

    if (!name || !meta.deletionTimestamp) continue;
    if (!(meta.finalizers || []).includes(CLEANUP_FINALIZER)) continue;
    if (inst.spec?.provisionCluster?.enabled) continue;

    let remaining = false;

    for (const b of bundlesBy.get(name) || []) {
      remaining = true;
      if (!b.metadata?.deletionTimestamp) {
        await k8s(`/apis/fleet.cattle.io/v1alpha1/namespaces/${ b.metadata.namespace }/bundles/${ b.metadata.name }`, { method: 'DELETE' })
          .catch((e) => {
            if (e.status !== 404) console.error(`[dev-api] finishDeletes: bundle ${ b.metadata.name }:`, e.message || e);
          });
      }
    }
    if (remaining) continue; // wait for the Bundle to be gone before releasing the finalizer

    const left = (meta.finalizers || []).filter((f) => f !== CLEANUP_FINALIZER);

    await k8s(`${ INSTANCES }/${ meta.name }`, { method: 'PATCH', body: JSON.stringify({ metadata: { finalizers: left } }) })
      .then(() => console.log(`[dev-api] finished delete of ${ name } (cleanup finalizer cleared)`))
      .catch((e) => {
        if (e.status !== 404) console.error(`[dev-api] finishDeletes: clear finalizer ${ name }:`, e.message || e);
      });
  }
}

// The fast loop: finish deletes and refresh the registrar. Separate from reconcileTeardown so the
// nav stays fresh and deletes finish promptly without running the heavier orphan sweep as often.
async function reconcileWorkspaces() {
  const instances = await installations('reconcileWorkspaces');

  if (!instances) {
    return;
  }
  const bundles = await k8s(BUNDLES).catch(() => null);

  await finishDeletes(instances, bundles).catch((e) => console.error('[dev-api] finishDeletes failed:', e.message || e));
  await reconcileRegistrar(instances).catch((e) => console.error('[dev-api] reconcileRegistrar failed:', e.message || e));
}

// ── Workspace media (Review tab) ──────────────────────────────────────────────
const MEDIA_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.webm', '.mp4', '.mov']);

/** A workspace's artifacts tree on the node, as this pod sees it (read-only mount). */
function workspaceArtifactsRoot(ws) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(ws)) {
    return '';
  }

  return path.join(WORKSPACES_ROOT, ws, 'artifacts');
}

/**
 * Everything under a workspace's artifacts, newest first, with its path and type.
 *
 * `mediaOnly` because there are two callers with different needs. The review panel wants the
 * images and the recordings, which is what it can show. A card wants whatever the agent actually
 * left there - a log, a JSON report, a diff - because `wants` is no longer a closed list of
 * fourteen names and a card can surface anything in this tree. Filtering to media by default
 * would make the wider case the surprising one, so the filter is the caller's to ask for.
 */
function listWorkspaceMedia(ws, mediaOnly = false) {
  const root = workspaceArtifactsRoot(ws);

  if (!root) {
    return [];
  }

  const found = [];
  const walk = (dir, rel) => {
    if (found.length >= 300) {
      return;
    }

    let entries = [];

    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const relPath = rel ? `${ rel }/${ entry.name }` : entry.name;

      if (entry.isDirectory()) {
        walk(abs, relPath);
      } else if (!mediaOnly || MEDIA_EXTS.has(extOf(entry.name))) {
        let stat = { size: 0, mtimeMs: 0 };

        try {
          stat = fs.statSync(abs);
        } catch { /* raced deletion */ }

        found.push({
          path: relPath, name: entry.name, type: ARTIFACT_TYPES[extOf(entry.name)] || 'application/octet-stream', size: stat.size, mtimeMs: stat.mtimeMs,
        });
      }
    }
  };

  walk(root, '');

  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Resolve one artifact's absolute path, or '' if it escapes the tree or is gone.
 *
 * The extension-only check went with the lister's: a card can now list anything an agent left
 * here, and a listing of files that cannot be fetched is a listing of dead links. What stays is
 * the only check that was ever load-bearing - the resolved path has to be inside the workspace's
 * own artifacts directory, so `../../etc/passwd` resolves out and is refused. The type is still
 * reported from the extension (see ARTIFACT_TYPES), with a byte stream as the fallback.
 */
function workspaceMediaPath(ws, rel) {
  const root = workspaceArtifactsRoot(ws);

  if (!root) {
    return '';
  }

  const file = path.resolve(root, rel);

  if (file !== root && !file.startsWith(root + path.sep)) {
    return '';
  }

  try {
    return fs.statSync(file).isFile() ? file : '';
  } catch {
    return '';
  }
}

http.createServer(async(req, res) => {
  const url = new URL(req.url, 'http://dev-api');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PUT,DELETE', 'access-control-allow-headers': 'content-type' });
    res.end();

    return;
  }

  // One piece of evidence, as bytes rather than JSON: the file an agent attached to a comment,
  // read off the agent's workspace so it can be looked at before anything uploads it anywhere.
  const artifact = /^\/my-work\/pr\/\d+\/artifact$/.test(url.pathname) && req.method === 'GET';

  if (artifact) {
    const file = artifactFile(url.searchParams.get('path'), Number(url.pathname.split('/')[3]));

    if (!file) {
      return send(res, 404, { error: 'No such file in the agent workspace.' });
    }

    const type = ARTIFACT_TYPES[extOf(file)] || 'application/octet-stream';

    res.writeHead(200, {
      'content-type': type, 'content-length': fs.statSync(file).size, 'access-control-allow-origin': '*', 'cache-control': 'private, max-age=60',
    });
    fs.createReadStream(file).pipe(res);

    return;
  }

  // A workspace's built site, as a tarball: what a preview hosted on another cluster fetches
  // (previews.ts, shareWorkspace) through this Rancher's proxy with a token of the person's,
  // because nothing on that cluster can reach this node's disk any other way. Any directory
  // under `share/` is served, not only the Share tab's dashboard and storybook: a rancher-share
  // (the my-rancher-share skill) packs a shell build and extension builds under a name of its
  // own, and one workspace may hold several. It is a build once it has a page or a plugin list.
  const share = /^\/share\/([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)\.tar\.gz$/.exec(url.pathname);

  if (share && req.method === 'GET') {
    const dir = path.join(WORKSPACES_ROOT, share[1], 'share', share[2]);

    if (!['index.html', 'uiplugins.json', 'dashboard/index.html'].some((f) => fs.existsSync(path.join(dir, f)))) {
      return send(res, 404, { error: 'No build there yet.' });
    }
    res.writeHead(200, { 'content-type': 'application/gzip', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
    const tar = spawn('tar', ['-czf', '-', '-C', dir, '.']);

    tar.stdout.pipe(res);
    tar.on('error', () => res.end());
    req.on('close', () => tar.kill());

    return;
  }

  // The media an agent produced for a workspace - its repro and demo videos, its before/after
  // screenshots - listed and served from the workspace's own artifacts tree. The Review tab shows
  // these; a workspace pod cannot serve its own files and the browser cannot read the node disk,
  // so this pod, which has the tree mounted, serves them.
  const mediaList = /^\/workspace\/([a-z0-9][a-z0-9-]*)\/media$/.exec(url.pathname);

  if (mediaList && req.method === 'GET') {
    // `?media=1` keeps the old answer for the review panel; everything else gets the whole tree.
    return send(res, 200, { files: listWorkspaceMedia(mediaList[1], url.searchParams.get('media') === '1') });
  }

  // An image or a recording attached to a GitHub comment. The browser cannot fetch those
  // itself: `github.com/user-attachments/assets/…` redirects to a signed URL behind the
  // person's GitHub session, which a cross-site <img> does not carry. Fetched here with the
  // token and streamed back; `?meta=1` answers with the type alone, for choosing <img> or
  // <video> before anything is loaded. Only GitHub's own asset hosts.
  if (url.pathname === '/my-work/gh-asset' && req.method === 'GET') {
    const asset = url.searchParams.get('url') || '';

    if (!/^https:\/\/(github\.com\/user-attachments\/assets\/|github\.com\/[^/]+\/[^/]+\/assets\/|private-user-images\.githubusercontent\.com\/|user-images\.githubusercontent\.com\/|github\.com\/user-attachments\/files\/)/.test(asset)) {
      return send(res, 400, { error: 'Not a GitHub asset URL.' });
    }
    try {
      const got = await fetchGithubAsset(asset);

      if (url.searchParams.get('meta')) {
        return send(res, 200, { type: got.type, size: got.body?.length || got.tooBig || 0, tooBig: !!got.tooBig });
      }
      if (!got.body) {
        return send(res, 413, { error: 'The attachment is too large to show here; open it on GitHub.' });
      }
      res.writeHead(200, {
        'content-type':                got.type || 'application/octet-stream',
        'content-length':              got.body.length,
        'access-control-allow-origin': '*',
        'cache-control':               'private, max-age=3600',
      });
      res.end(got.body);
    } catch (e) {
      return send(res, e.status || 502, { error: `GitHub asset: ${ e.message }` });
    }

    return;
  }

  const mediaFile = /^\/workspace\/([a-z0-9][a-z0-9-]*)\/media\/file$/.exec(url.pathname);

  if (mediaFile && req.method === 'GET') {
    const file = workspaceMediaPath(mediaFile[1], url.searchParams.get('path') || '');

    if (!file) {
      return send(res, 404, { error: 'No such media in the workspace.' });
    }

    res.writeHead(200, {
      'content-type':                ARTIFACT_TYPES[extOf(file)] || 'application/octet-stream',
      'content-length':              fs.statSync(file).size,
      'access-control-allow-origin': '*',
      'accept-ranges':               'bytes',
      'cache-control':               'private, max-age=60',
    });
    fs.createReadStream(file).pipe(res);

    return;
  }

  try {
    for (const [method, pattern, handler] of routes) {
      const m = pattern.exec(url.pathname);

      if (m && req.method === method) {
        const body = method === 'POST' || method === 'PUT' ? await readBody(req) : {};

        return send(res, 200, await handler(m, url, body));
      }
    }

    return send(res, 404, { error: 'No such path.' });
  } catch (e) {
    return send(res, e.status || 500, { error: e.message });
  }
}).listen(PORT, () => {
  console.log(`[dev-api] listening on :${ PORT }`);

  // Finish workspace teardowns the browser did not, and keep finishing them. A minute apart, and
  // first a few seconds after boot rather than at the same instant everything else starts.
  const tick = () => reconcileTeardown().catch((e) => console.error('[dev-api] reconcile tick failed:', e.message || e));

  setTimeout(tick, 10_000);
  setInterval(tick, 60_000);

  // The fast loop: project the registrar the sidebar reads and finish deletes, more often than the
  // heavier orphan sweep above so the nav stays fresh and a delete completes within a few seconds.
  const fast = () => reconcileWorkspaces().catch((e) => console.error('[dev-api] reconcileWorkspaces tick failed:', e.message || e));

  setTimeout(fast, 3_000);
  setInterval(fast, 15_000);

  // Leases. A minute is the resolution a lease is worth: the tools it ends have been running
  // for an hour and a half, and a sweep that ran more often would only read the same namespaces
  // more often.
  const tools = () => reapTools().catch((e) => console.error('[dev-api] tool sweep failed:', e.message || e));

  setTimeout(tools, 20_000);
  setInterval(tools, 60_000);

  // The conversations in the agent pod: what finished, and what is asking, while no page was open.
  //
  // Thirty seconds for the listing, which is the one exec; five for the refresh, which is a stat
  // per conversation on a mount this pod already has. Five is below the browser's own fifteen
  // (workspace-status.ts, AGENTS_EVERY_MS), so nothing reading this is ever staler than what the
  // sidebar managed by itself. Staggered off the three loops above the way they are off each other.
  const listing = () => listingTick().catch((e) => console.error('[dev-api] conversation listing tick failed:', e.message || e));
  setTimeout(listing, 5_000);
  setInterval(listing, LISTING_MS);

});
