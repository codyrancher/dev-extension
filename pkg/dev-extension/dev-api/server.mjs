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
import zlib from 'node:zlib';

const PORT = Number(process.env.PORT || 8080);
const ROOT = 'https://kubernetes.default.svc';
const SA = '/var/run/secrets/kubernetes.io/serviceaccount';
const TOKEN = fs.readFileSync(`${ SA }/token`, 'utf8').trim();
const NAMESPACE = process.env.DEV_SYSTEM_NAMESPACE || 'dev-system';
const DEFAULT_REPO = process.env.DEV_REPO || 'rancher/dashboard';

const APPS = '/apis/appsplus.io/v1alpha1/apps';
const INSTANCES = '/apis/appsplus.io/v1alpha1/appinstances';
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
  const body = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const error = new Error(body.message || `${ response.status } from ${ path }`);

    error.status = response.status;
    throw error;
  }

  return body;
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

async function jobLogTail(repo, jobId, keepBytes = 256_000, capBytes = 25_000_000) {
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

function failureExcerpt(log, maxLines = 120) {
  const clean = log.split('\n').map((l) => l.replace(/\r$/, '').replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, '').replace(ANSI_RE, ''));
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
    return { text: clean.slice(-40).join('\n').trim(), matched: false };
  }

  const start = Math.max(0, first - 4);
  const end = Math.min(clean.length, Math.max(last + 6, start + 20));
  const window = clean.slice(start, end);
  const text = (window.length > maxLines ? [...window.slice(0, maxLines - 20), '...', ...window.slice(-20)] : window).join('\n').trim();

  return { text, matched: true };
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

/** The seed the workspaces are laid out from, as the ConfigMap carries it (gzipped) or used to. */
function agentSeed() {
  try {
    return JSON.parse(zlib.gunzipSync(Buffer.from(fs.readFileSync('/seed/seed.json.gz.b64', 'utf8'), 'base64')).toString('utf8'));
  } catch {
    return JSON.parse(fs.readFileSync('/seed/seed.json', 'utf8'));
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
 * A path an agent wrote (`/workspace/artifacts/x.webm`, or relative to it) as a file here, or
 * null. Looked for in the PR's own workspace first, then in any workspace, then in the agent
 * pod's directory, which is where a review ran before workspaces were the harness's containers.
 */
function artifactFile(given, num = null) {
  const rel = String(given || '').replace(/^\/?workspace\//, '').replace(/^\/+/, '');

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
  const mapGhComment = (c, pending) => ({
    id: c.id, path: c.path, line: c.line ?? c.original_line ?? null, side: c.side || 'RIGHT', author: c.user?.login, body: c.body, createdAt: c.created_at, inReplyTo: c.in_reply_to_id ?? null, pending,
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
      date:    c.commit?.author?.date || null,
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

const routes = [
  ['GET', /^\/$/, async() => ({ api: 'ok', templates: (await apps()).map((app) => app.id) })],
  ['GET', /^\/templates$/, async() => ({ templates: await apps() })],
  // The skills and rules a review or fix agent needs, as the extension bundled them. Served to
  // the agent pod because an exec command is URL arguments and this is half a megabyte.
  ['GET', /^\/agent-seed$/, async() => agentSeed()],
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

    return makeWorkspace(body.name, body.app || body.template || 'rancher-dev', body.cluster || 'local');
  }],

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
});
