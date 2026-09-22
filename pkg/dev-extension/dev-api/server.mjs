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

/** The overrides: skill name -> SKILL.md text, and the ConfigMap's resourceVersion for the seed's version. */
async function skillOverrides() {
  try {
    const map = await k8s(`/api/v1/namespaces/${ NAMESPACE }/configmaps/${ SKILLS_MAP }`);
    const skills = {};

    for (const [key, value] of Object.entries(map.data || {})) {
      const m = /^skill__([a-z0-9-]+)$/.exec(key);

      if (m) {
        skills[m[1]] = value;
      }
    }

    return { skills, version: map.metadata?.resourceVersion || '' };
  } catch (e) {
    if (e.status === 404) {
      return { skills: {}, version: '' };
    }
    throw e;
  }
}

/** The seed the workspaces are laid out from: what shipped, the repository's files, then the edited skills. */
async function agentSeed() {
  const seed = { ...shippedSeed(), ...(await aiSkillsFiles()).files };
  const { skills } = await skillOverrides();

  for (const [name, content] of Object.entries(skills)) {
    seed[`skills/${ name }/SKILL.md`] = content;
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
  const { skills } = await skillOverrides();
  const names = Object.keys(seed).map((key) => /^skills\/([a-z0-9-]+)\/SKILL\.md$/.exec(key)?.[1]).filter(Boolean);

  for (const name of Object.keys(skills)) {
    if (!names.includes(name)) {
      names.push(name);
    }
  }

  return names.sort().map((name) => ({
    name, description: skillDescription(skills[name] ?? seed[`skills/${ name }/SKILL.md`]), overridden: name in skills,
  }));
}

async function readSkill(name) {
  if (!SKILL_NAME.test(name)) {
    throw failure(400, 'Not a skill name.');
  }
  const baked = (await aiSkillsFiles()).files[`skills/${ name }/SKILL.md`] || '';
  const { skills } = await skillOverrides();

  if (!baked && !(name in skills)) {
    throw failure(404, `There is no skill called ${ name }.`);
  }

  return {
    name, content: skills[name] ?? baked, baked, overridden: name in skills,
  };
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

async function writeSkillOverride(name, content) {
  const p = `/api/v1/namespaces/${ NAMESPACE }/configmaps/${ SKILLS_MAP }`;
  const data = { [`skill__${ name }`]: content };

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

/** The skill committed to the skills repository, on the branch every workspace is laid out from. */
async function commitSkill(name, content, message) {
  const filePath = `${ AI_SKILLS_ROOT }/.claude/skills/${ name }/SKILL.md`;
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
    message: message || `Skill ${ name }: updated from the Dev extension`,
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch:  AI_SKILLS_REF,
    ...(sha ? { sha } : {}),
  });

  return { committed: true, url: result.commit?.html_url || result.content?.html_url || '' };
}

/**
 * Save a skill: the override for every workspace, and - when asked - the commit to the repo.
 * Saving the shipped text back drops the override rather than keeping a copy of it.
 */
async function saveSkill(name, body) {
  if (!SKILL_NAME.test(name)) {
    throw failure(400, 'Not a skill name.');
  }
  const content = String(body?.content || '');

  if (!content.trim()) {
    throw failure(400, 'The skill is empty.');
  }
  const baked = (await aiSkillsFiles()).files[`skills/${ name }/SKILL.md`] || '';

  if (content === baked) {
    await dropSkillOverride(name);
  } else {
    await writeSkillOverride(name, content);
  }
  const commit = body?.commit ? await commitSkill(name, content, String(body?.message || '')) : null;

  // Committed, the repository has the text, so the override is a copy of it: pull the new commit
  // and let the override go, or the page keeps calling a committed skill "edited".
  if (commit) {
    const fresh = await aiSkillsFiles(true).catch(() => null);

    if (fresh?.files[`skills/${ name }/SKILL.md`] === content) {
      await dropSkillOverride(name);
    }
  }

  const { skills } = await skillOverrides();

  return { ok: true, overridden: name in skills, commit, version: await seedVersion() };
}

async function dropSkillOverride(name) {
  try {
    await k8s(`/api/v1/namespaces/${ NAMESPACE }/configmaps/${ SKILLS_MAP }`, { method: 'PATCH', body: JSON.stringify({ data: { [`skill__${ name }`]: null } }) });
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
  ['GET', /^\/skills\/([a-z0-9-]+)$/, async(m) => readSkill(m[1])],
  ['PUT', /^\/skills\/([a-z0-9-]+)$/, async(m, url, body) => saveSkill(m[1], body)],
  ['POST', /^\/skills\/([a-z0-9-]+)\/reset$/, async(m) => {
    if (!SKILL_NAME.test(m[1])) {
      throw failure(400, 'Not a skill name.');
    }
    await dropSkillOverride(m[1]);

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
  let live;

  try {
    const instances = await k8s(INSTANCES);

    live = new Set((instances.items || []).map((i) => i.metadata?.name).filter(Boolean));
  } catch (e) {
    // The apiserver did not answer. An empty set would read as "every workspace is gone" and
    // tear all of them down, so on any doubt this tick does nothing and waits for the next.
    console.error('[dev-api] reconcile: could not list installations, skipping tick:', e.message || e);

    return;
  }

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
  let instances;

  try {
    instances = await k8s(INSTANCES);
  } catch (e) {
    // An empty list would read as "everything is gone"; on any doubt do nothing this tick.
    console.error('[dev-api] reconcileWorkspaces: could not list installations, skipping tick:', e.message || e);

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

/** Every image and video under a workspace's artifacts, newest first, with its path and type. */
function listWorkspaceMedia(ws) {
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
      } else if (MEDIA_EXTS.has(extOf(entry.name))) {
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

/** Resolve one media file's absolute path, or '' if it escapes the tree, is not media, or is gone. */
function workspaceMediaPath(ws, rel) {
  const root = workspaceArtifactsRoot(ws);

  if (!root) {
    return '';
  }

  const file = path.resolve(root, rel);

  if (file !== root && !file.startsWith(root + path.sep)) {
    return '';
  }

  if (!MEDIA_EXTS.has(extOf(file))) {
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
  // because nothing on that cluster can reach this node's disk any other way.
  const share = /^\/share\/([a-z0-9][a-z0-9-]*)\/(dashboard|storybook)\.tar\.gz$/.exec(url.pathname);

  if (share && req.method === 'GET') {
    const dir = path.join(WORKSPACES_ROOT, share[1], 'share', share[2]);

    if (!fs.existsSync(path.join(dir, 'index.html'))) {
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
    return send(res, 200, { files: listWorkspaceMedia(mediaList[1]) });
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
});
