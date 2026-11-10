// A workspace's pod, made into the harness's project container, on first use.
//
// The harness built a container around each project: the checkout at /workspace/dashboard, the
// skills and rules beside it, `gh` signed in, git pointed at the fork, a browser next door with
// CDP open, and an env file with everything a skill reads. A workspace here is a pod that the
// rancher-dev App made with the checkout and the dev server in it, and this puts the rest in
// place, so that the harness's prompts and skills run in it unchanged. The one thing that is
// deliberately different is what CLAUDE.md says about the environment (CLAUDE.dev.md, which is
// the one seed file this extension ships, and the environment rule beside the skills).
//
// Every step is idempotent and lands under /workspace, which is a hostPath, so it survives the
// pod and is written once; the seed carries a hash so a changed skill reaches a workspace that
// already has the old one. Nothing here puts a token in a prompt, a transcript or a queue
// file: the secrets go into the workspace's .env, gh's hosts.yml and git's credential store, 0600
// and owned by the pane's user, the same three places the harness put them.

import {
  podExecDetail, workspacePod, workspaceContainerRestarts, workspaceNamespace, WORKSPACE_CONTAINER, githubToken, devFetch, secretValue, clusterBase, activeCluster, GITHUB_BROWSER_CDP, GITHUB_BROWSER_CDP_DOWNSTREAM, sharedBrowserCdp, OUR_VERSION
} from './api';
import { agentPod } from './agent';
import { readyFields, readyStampCurrent } from './agent-reads.mjs';
import {
  TOOLS_WANTED, READY_STAMP, seedMark as seedMarkOf, rootScript, nodeScript, rootCommand, nodeCommand,
  baseScript, seedCheckScript, seedCurrent, seedScript, toolsCheckScript, toolsMissing, toolsScript, rancherTokenScript, environmentScript, checkoutScript,
} from './workspace-provision.mjs';
import { podStateText } from './pod-state';
import { AGENT_SEED } from './agent-seed.generated';
import { UNREWRITE_B64 } from './apps';
import {
  DEV_API_IN_CLUSTER, workspaceRoot, isLte
} from './config/constants';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

// The scripts, the versions and the paths are workspace-provision.mjs's, shared with dev-api,
// which prepares a workspace itself when a review starts with no dashboard open.

/** Where the pod is: everything below execs into it. */
export interface WorkspaceTarget {
  workspace: string;
  namespace: string;
  pod: string;
}

/** What the harness knew about a project from its name: the issue or PR it was made for. */
export interface WorkspaceContext {
  issue?: number | null;
  pr?: number | null;
}

export async function workspaceTarget(workspace: string): Promise<WorkspaceTarget> {
  const pod = await workspacePod(workspace);

  if (!pod) {
    throw new Error(`Workspace ${ workspace } has no running pod yet; its conversations run there, so wait for it to start.`);
  }

  return { workspace, namespace: workspaceNamespace(workspace), pod };
}

/** The pod, waiting for it: a workspace just created takes minutes to clone and install. */
export async function waitForWorkspacePod(workspace: string, timeoutMs = 30 * 60 * 1000): Promise<WorkspaceTarget> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const pod = await workspacePod(workspace).catch(() => null);

    if (pod) {
      return { workspace, namespace: workspaceNamespace(workspace), pod };
    }
    if (Date.now() > deadline) {
      throw new Error(`Workspace ${ workspace } did not start within ${ Math.round(timeoutMs / 60000) } minutes.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

function b64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

/** A short hash of the seed, so a changed skill reaches a workspace that already has the old one. */
function seedVersion(): string {
  let h = 2166136261;
  const text = JSON.stringify(AGENT_SEED);

  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }

  return (h >>> 0).toString(16);
}

/** The API's seed version, which moves when a skill is edited (skills.ts), or '' when it cannot say. */
async function servedSeedVersion(): Promise<string> {
  const served = await devFetch(`${ clusterBase('local') }/api/v1/namespaces/dev-system/services/http:dev-api:8080/proxy/agent-seed/version`).catch(() => null);

  return served?.version || '';
}

/** What `.dev-seed` holds once this seed is laid out for this workspace. */
function seedMark(version: string, ctx: WorkspaceContext, workspace: string): string {
  return seedMarkOf(version, ctx, workspace);
}

/**
 * Run a script in the pod, as root.
 *
 * The script travels base64 and is run from a file, so nothing in it is ever quoted for a
 * shell: a token, a JSON document and an apostrophe in somebody's name all arrive intact.
 */
async function asRoot(target: WorkspaceTarget, script: string): Promise<string> {
  const file = `/tmp/.dev-${ Date.now().toString(36) }${ Math.random().toString(36).slice(2, 8) }.sh`;

  return ran(target, rootCommand(b64(rootScript(workspaceRoot(target.workspace), script)), file));
}

/**
 * One script in the workspace's pod, and the reason when it did not run.
 *
 * Every caller below checks a marker the script prints - `ENV-OK`, `TUNNEL-OK`, `CHECKOUT-OK` -
 * and reports a failure to whoever pressed the button. An exec that never ran prints no marker
 * and, through `podExecOnce`, carries no reason either: the apiserver's status is on a channel
 * that function drops. So "The workspace's environment could not be written:" ended at the
 * colon, which tells a person nothing and tells the next reader of this file nothing either.
 *
 * The script's own stderr is already folded into stdout by the `2>&1` above, so anything left
 * here is the exec itself failing - a pod that went away, a timeout, a refused socket - and
 * that is worth throwing rather than returning as an empty string.
 */
async function ran(target: WorkspaceTarget, command: string[]): Promise<string> {
  const { out, status } = await podExecDetail(target.namespace, target.pod, WORKSPACE_CONTAINER, command);

  if (!out && status) {
    throw new Error(status);
  }

  return out;
}

/** The same, as the pane's user, with its home: the user the checkout and the tmux server belong to. */
async function asNode(target: WorkspaceTarget, script: string): Promise<string> {
  const file = `/tmp/.dev-${ Date.now().toString(36) }${ Math.random().toString(36).slice(2, 8) }.sh`;

  return ran(target, nodeCommand(b64(nodeScript(workspaceRoot(target.workspace), script)), file));
}

/** Read something out of the checkout, as its owner. What the Review tab is drawn from. */
/**
 * The last answer about each workspace's dev server, in flight or just landed.
 *
 * Three components ask as a workspace page opens, and each was its own exec. `pgrep` sees only the
 * workspace pod, so this cannot move to the service, but they can share one. Stopping or starting
 * the server forgets the answer, so a person's own change is never hidden by this.
 *
 * Ten seconds, because the rail asks after its first status and evidence reads have landed, which
 * was about 4.4s in and past the three this used to be, so that read was a second exec. It still
 * needs the answer, for stopForStage. Nothing asks this on a beat shorter than the page's 15s.
 */
const DEV_SERVER_FRESH_MS = 10_000;
const devServerAsked = new Map<string, { at: number; answer: Promise<{ running: boolean; paused: boolean }> }>();

/**
 * Whether this workspace is running a dev server, and whether one has been stopped on purpose.
 *
 * One exec, from the page: `pgrep` for the server and a look for the pause file the supervisor
 * reads. Cheap enough to ask on every stage, which is the point - a webpack holding two
 * gigabytes for a workspace nobody is looking at is the most expensive idle thing on the node,
 * and it cannot be turned off from a page that does not know it is there.
 */
export function devServerState(workspace: string): Promise<{ running: boolean; paused: boolean }> {
  const held = devServerAsked.get(workspace);

  if (held && Date.now() - held.at < DEV_SERVER_FRESH_MS) {
    return held.answer;
  }

  const answer = readInWorkspace(workspace, [
    'cd $WS 2>/dev/null || exit 0',
    'pgrep -f "^[^ ]*node .*vue-cli-service serve" >/dev/null 2>&1 && echo RUNNING',
    '[ -f $WS/.dev-server.off ] && echo PAUSED',
  ].join('\n')).catch(() => null).then((out) => {
    // A failed read is not worth remembering: the next caller may as well try again.
    if (out === null && devServerAsked.get(workspace)?.answer === answer) {
      devServerAsked.delete(workspace);
    }

    return { running: !!out?.includes('RUNNING'), paused: !!out?.includes('PAUSED') };
  });

  devServerAsked.set(workspace, { at: Date.now(), answer });

  return answer;
}

/** Stop this workspace's dev server and keep it stopped, through the workspace's own command. */
export async function stopDevServer(workspace: string): Promise<string> {
  devServerAsked.delete(workspace);

  return readInWorkspace(workspace, 'cd $WS/dashboard 2>/dev/null || cd $WS; $WS/bin/dev-server stop 2>&1 | tail -2');
}

/** Let it run again. */
export async function startDevServer(workspace: string): Promise<string> {
  devServerAsked.delete(workspace);

  return readInWorkspace(workspace, 'cd $WS/dashboard 2>/dev/null || cd $WS; $WS/bin/dev-server start 2>&1 | tail -2');
}

export async function readInWorkspace(workspace: string, script: string): Promise<string> {
  return asNode(await workspaceTarget(workspace), script);
}

/** The harness read these off the project's name; so does this, when the caller does not say. */
export function contextFromName(workspace: string): WorkspaceContext {
  return {
    issue: Number(/(?:^|-)issue-(\d+)/.exec(workspace)?.[1]) || null,
    pr:    Number(/(?:^|-)pr-(\d+)/.exec(workspace)?.[1]) || null,
  };
}

// ── The steps ───────────────────────────────────────────────────────────────────────────────

/** Directories, ownership, and the system packages a recording needs (ffmpeg), as root. */
async function ensureBase(target: WorkspaceTarget): Promise<void> {
  const out = await asRoot(target, baseScript());

  if (!out.includes('BASE-OK')) {
    throw new Error(`The workspace pod could not be prepared: ${ out.trim().slice(-300) }`);
  }
}

/**
 * The seed: skills, rules, settings, CLAUDE.md and the helper scripts, laid out where the
 * harness put them.
 *
 * Pulled from the in-cluster API rather than pushed through exec: an exec command travels as
 * URL arguments, and a megabyte of them does not survive the apiserver proxy. The API carries
 * the same seed (see api.ts, ensureWorkspaceApi) and serves it as one JSON document; a few lines
 * of node lay the files out and render the `.hbs` ones the way the harness's template engine
 * did, with the workspace's name and its issue or PR number.
 */
async function ensureSeed(target: WorkspaceTarget, ctx: WorkspaceContext): Promise<void> {
  // A downstream workspace lays its seed out from the agent pod instead: the layout script fetches
  // the seed from the local dev-api, and a pod on another cluster cannot resolve that service, so
  // the fetch below would fail every time. The agent pod can reach it and has the workspace's tree
  // mounted, so it writes the seed there - the same files, the same .dev-seed marker (agents
  // mount-downstream.sh). Nothing to do from here for those. See downstream-conversation-mount.
  if (activeCluster() !== 'local') {
    return;
  }

  // The API's version, which moves when a skill is edited (skills.ts); the bundle's own when
  // the API cannot be asked.
  const version = seedMark(await servedSeedVersion() || seedVersion(), ctx, target.workspace);
  // The marker, and one file it is supposed to have written.
  //
  // A workspace made for an issue that had one before inherits whatever its old tree left on
  // the node, and a delete that only got part of the way leaves a directory with `artifacts`
  // and `dashboard` in it and nothing else. The marker was the only check, so a stale one
  // meant the seed was skipped and every command in that workspace failed on a missing
  // `bin/dev-shell` - which is the tunnel, so nothing worked at all. The wrapper is what the
  // seed exists to write; if it is not there, the seed has not run here whatever the marker
  // says.
  const current = await asNode(target, seedCheckScript());

  if (seedCurrent(current, version)) {
    return;
  }

  // The script that lays the files out rides in the seed itself (its `layout.mjs`), so
  // what travels here is a few lines: an exec command is URL arguments, and a script of any
  // size in it is a request something between here and the pod refuses.
  const out = await asNode(target, seedScript({
    workspace: target.workspace, issue: String(ctx.issue || ''), pr: String(ctx.pr || ''), cluster: activeCluster(), version, devApi: DEV_API_IN_CLUSTER,
  }));

  if (!out.includes('SEED-OK')) {
    throw new Error(`The skills could not be written into the workspace: ${ out.trim().slice(-300) }`);
  }
}

/**
 * `gh` and `jq`: downloaded once for the node, linked into the workspace's bin.
 *
 * The check is on the link's target rather than on the file being executable, so a workspace
 * seeded before the shared store existed - holding its own 54 MiB copy - is migrated the next
 * time it is seeded: `ln -sf` replaces the real file with the link and the copy's last name is
 * gone.
 *
 * The download lands on a temporary name and is moved into place with `mv -n`, which is the
 * whole concurrency story: two workspaces seeding at once each fetch, and the loser's copy is
 * discarded rather than written over a file the winner may already be executing.
 */
async function ensureTools(target: WorkspaceTarget): Promise<void> {
  const missing = toolsMissing(await asNode(target, toolsCheckScript()));

  if (!missing.length) {
    return;
  }

  const out = await asNode(target, toolsScript(missing));

  if (!out.includes('TOOLS-OK')) {
    throw new Error(`gh and jq could not be installed in the workspace: ${ out.trim().slice(-300) }`);
  }
}

/**
 * A Rancher API token for the person this dashboard is signed in as, minted here, once per
 * workspace.
 *
 * The harness had an admin password for its own Rancher; this Rancher is shared and its people
 * sign in with GitHub, so what the agent gets is a token for the user who made the workspace.
 * Kept in the workspace's .env and checked against the API before it is reused, so a token that was
 * revoked is replaced rather than handed on.
 */
async function rancherToken(target: WorkspaceTarget, browserRancher = ''): Promise<string> {
  const browser = /^https?:\/\/[^'\s]+$/.test(browserRancher) ? browserRancher.replace(/\/+$/, '') : '';
  const existing = (await asRoot(target, rancherTokenScript(browser))).trim();

  if (existing) {
    return existing;
  }

  const minted = await devFetch('/v3/tokens', {
    method: 'POST',
    body:   JSON.stringify({ type: 'token', description: `dev workspace ${ target.workspace }`, ttl: 0 }),
  }).catch(() => null);

  return minted?.token || '';
}

/**
 * The workspace's .env, ~/.bashrc, gh's hosts.yml, git's credential store and a kubeconfig: the
 * harness's init.sh, minus the parts a Rancher of one's own needed.
 *
 * `browserRancher` is the origin of the Rancher this dashboard is open on, and it exists to keep
 * `.env` from going stale in the one way it used to: the token is minted against that origin
 * (devFetch sends a relative path), while the host written into `.env` was always the pod's own
 * `$API` - the Rancher the workspace was built to develop against. When the two are different
 * Ranchers - the person is on the parent, the workspace targets a downstream it manages - the
 * token is the parent's and the URL is the downstream's, so every call in the workspace comes
 * back 401 and stays there, because re-minting produces another parent token. So rather than
 * write a fixed host, this writes the host the token actually answers 200 on: the workspace's
 * own target first, since that is what its dev server runs against, then the browser's Rancher
 * as the fallback the freshly-minted token is for. Only the broken case changes; a token that
 * already matches its target is left exactly as it was.
 */
async function ensureEnvironment(target: WorkspaceTarget, github: string, browserRancher = ''): Promise<void> {
  const rancher = await rancherToken(target, browserRancher);
  const login = github ? (await ghLogin(github)).login : '';
  const browser = /^https?:\/\/[^'\s]+$/.test(browserRancher) ? browserRancher.replace(/\/+$/, '') : '';
  const browserCdp = await workspaceBrowserCdp(target.workspace);

  const out = await asRoot(target, environmentScript({
    workspace:  target.workspace,
    rancher,
    github,
    login,
    browser,
    browserCdp,
    githubCdp: activeCluster() === 'local' ? GITHUB_BROWSER_CDP : GITHUB_BROWSER_CDP_DOWNSTREAM,
    devApi:    DEV_API_IN_CLUSTER,
  }));

  if (!out.includes('ENV-OK')) {
    throw new Error(`The workspace's environment could not be written: ${ out.trim().slice(-300) || 'the script ran and printed nothing, which should not happen' }`);
  }
}

/** A leased workspace has no Chromium of its own; it drives the shared one, by IP. */
function workspaceBrowserCdp(workspace: string): Promise<string> {
  return isLte(workspace) ? sharedBrowserCdp() : Promise.resolve('http://localhost:9222');
}

let ghLoginPromise: Promise<{ login: string; name: string; email: string }> | null = null;

/** Who the GitHub token is, for the fork's name and the commit identity. Asked once per page. */
function ghLogin(token: string): Promise<{ login: string; name: string; email: string }> {
  ghLoginPromise = ghLoginPromise || fetch('https://api.github.com/user', { headers: { authorization: `Bearer ${ token }`, accept: 'application/vnd.github+json' } })
    .then((r) => (r.ok ? r.json() : null))
    .then((u) => ({ login: u?.login || '', name: u?.name || u?.login || '', email: u?.email || (u?.login ? `${ u.login }@users.noreply.github.com` : '') }))
    .catch(() => ({ login: '', name: '', email: '' }));

  return ghLoginPromise;
}

/**
 * The checkout the way init.sh left it: the fork as origin and rancher/dashboard as upstream,
 * the identity, the credential helper, the harness's files kept out of the tree, and the PR
 * checked out when the workspace is for one. Plus playwright-core beside browser.mjs.
 */
async function ensureCheckout(target: WorkspaceTarget, ctx: WorkspaceContext, github: string): Promise<boolean> {
  const who = github ? await ghLogin(github) : { login: '', name: '', email: '' };
  const name = (await secretValue('GIT_NAME').catch(() => '')) || who.name;
  const email = (await secretValue('GIT_EMAIL').catch(() => '')) || who.email;
  const fork = who.login || 'codyrancher';
  const out = await asNode(target, checkoutScript({
    name, email, fork, github, pr: ctx.pr || 0,
  }));

  if (!out.includes('CHECKOUT-OK') && !out.includes('NO-CHECKOUT')) {
    throw new Error(`The checkout could not be set up: ${ out.trim().slice(-300) }`);
  }

  // False while the clone is running or a PR has not landed: the next load should try again.
  return !out.includes('NO-CHECKOUT') && !out.includes('CHECKOUT-PENDING');
}

// ── Knowing it has been done ────────────────────────────────────────────────────────────────

/** What a workspace's stamp says apart from when it was written and when its token runs out. */
interface WantedStamp {
  workspace: string;
  pod: string;
  boot: number;
  seed: string;
  tools: string;
  rancher: string;
  identity: string;
  bundle: string;
}

/** SHA-256 as hex, or '' where the page is not allowed to hash (a plain-http origin). */
async function sha256Hex(text: string): Promise<string> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));

    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return '';
  }
}

/**
 * Everything provisioning would take as input right now, without one exec, or null if any of it
 * cannot be known. Null means no skip and no stamp, so what happens is what always happened.
 *
 * Each field is here because changing it has to reach the workspace:
 * - `pod` and `boot`: a new pod or a restarted container has lost what apt installed. These also
 *   rule out a stamp left in an old tree by the workspace that last had this name.
 * - `seed`: the same string as `.dev-seed`, so a skill edit, a seed upgrade or a changed issue or
 *   PR reprovisions.
 * - `tools`: a version bump in this file.
 * - `rancher`: the origin this page is on, which ensureEnvironment writes as a fallback host. The
 *   pod's own $API only changes with its pod template, which makes a new pod.
 * - `identity`: a changed GitHub token, Git name or email and the shared browser's address. A hash
 *   because the file is in the tree and goes back over HTTP; the tree has the token already and a
 *   hash gives nobody else anything, since a token is too long to guess.
 * - `bundle`: this extension's release, because the seed does not cover the scripts in this file. A
 *   release that changes one reaches each workspace on its next load, at the cost of that load.
 *
 * An empty GitHub token gives null because the store reads as empty when it could not be read, and
 * a workspace must not be vouched for on the strength of that. Someone with no token at all pays
 * for provisioning on every load, as before.
 *
 * Another cluster's workspace gives null too: its tree is an sshfs mount the service will not read
 * (state-api.mjs, readStampFile), so a stamp there could never be believed and is not worth an exec.
 */
async function wantedStamp(target: WorkspaceTarget, ctx: WorkspaceContext, github: string): Promise<WantedStamp | null> {
  if (activeCluster() !== 'local') {
    return null;
  }

  const rancher = typeof window === 'undefined' ? '' : window.location.origin;
  const [served, boot, gitName, gitEmail, browserCdp] = await Promise.all([
    servedSeedVersion(),
    workspaceContainerRestarts(target.namespace, target.pod),
    secretValue('GIT_NAME').catch(() => ''),
    secretValue('GIT_EMAIL').catch(() => ''),
    workspaceBrowserCdp(target.workspace),
  ]);
  const identity = await sha256Hex(['dev-ready', target.workspace, github, gitName, gitEmail, browserCdp].join('\0'));

  if (!github || !rancher || !served || boot === null || !identity) {
    return null;
  }

  return {
    workspace: target.workspace,
    pod:       target.pod,
    boot,
    seed:      seedMark(served, ctx, target.workspace),
    tools:     TOOLS_WANTED,
    rancher,
    identity,
    bundle:    OUR_VERSION,
  };
}

/**
 * The stamp in a workspace's tree, as the agent pod's service reads it, or null.
 *
 * Null for every way this can fail: no agent pod, a service that is down or older than this route,
 * no file, a bad file, a downstream tree whose mount is not answering. All of them provision.
 */
async function readReadyStamp(workspace: string): Promise<{ stamp: ReturnType<typeof readyFields>; now: number; autoShared: boolean } | null> {
  try {
    const pod = await agentPod();

    if (!pod) {
      return null;
    }

    const text = await podStateText(pod, `/ready?workspace=${ encodeURIComponent(workspace) }`);

    if (!text) {
      return null;
    }

    const { now, autoShared } = JSON.parse(text);

    return { stamp: readyFields(text, workspace), now: Number(now), autoShared: autoShared === true };
  } catch {
    return null;
  }
}

/**
 * Whether the default share has already been made, if the service can say.
 *
 * False only means ask the workspace, so a service that cannot answer costs what it always did.
 */
export async function defaultShareMarked(workspace: string): Promise<boolean> {
  const found = await readReadyStamp(workspace);

  return !!found?.stamp && found.autoShared;
}

/**
 * Record what was just provisioned, as the last step of a run that got that far.
 *
 * Its own exec with no secret in it: the token comes out of the workspace's .env, which asNode has
 * already sourced. It vouches for what can be checked here and writes nothing otherwise, so the
 * next load provisions again. That covers what provisioning can finish without having done: npm's
 * failure is only printed, and a token that was written may not answer.
 *
 * apt is deliberately not one of those. It is optional, it runs in the background and it can fail
 * for reasons no reload fixes, and waiting on it would send the token through an exec URL on every
 * load for as long as a mirror is down. ensureBase has already started it, and the next action, or
 * the stamp running out, starts it again if it did not land.
 *
 * Reads the token's own record for its expiry. A record that will not say is 0, unknown, and then
 * only the TTL bounds it.
 */
async function writeReadyStamp(target: WorkspaceTarget, wanted: WantedStamp): Promise<void> {
  // Checked before it goes anywhere: these values are single-quoted below, and no valid one can
  // hold a quote. What could not be read back is not worth writing.
  if (!readyFields(JSON.stringify({ ...wanted, at: 1, expires: 0 }), target.workspace)) {
    console.debug(`[workspace] ${ target.workspace } not stamped: a field is not the shape the service accepts`); // eslint-disable-line no-console

    return;
  }

  const expiry = 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{let t={};try{t=JSON.parse(s)}catch{}console.log(t.expired===true||t.enabled===false?"dead":Math.floor(Date.parse(t.expiresAt||"")/1000)||0)})';
  const out = await asNode(target, [
    '[ -n "$RANCHER_TOKEN" ] && [ -n "$RANCHER_URL" ] || { echo READY-NOT no Rancher token; exit 0; }',
    '[ -x $WS/bin/dev-shell ] || { echo READY-NOT no dev-shell; exit 0; }',
    '[ -d $WS/node_modules/playwright-core ] || { echo READY-NOT no playwright-core; exit 0; }',
    '[ "$(curl -sk --max-time 10 -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $RANCHER_TOKEN" "$RANCHER_URL/v3/users?me=true")" = 200 ] || { echo READY-NOT the Rancher token does not answer; exit 0; }',
    `EXPIRES=$(curl -sk --max-time 10 -H "Authorization: Bearer $RANCHER_TOKEN" "$RANCHER_URL/v3/tokens/\${RANCHER_TOKEN%%:*}" | node -e '${ expiry }' 2>/dev/null)`,
    '[ "$EXPIRES" = dead ] && { echo READY-NOT the Rancher token is spent; exit 0; }',
    'case "$EXPIRES" in ""|*[!0-9]*) EXPIRES=0 ;; esac',
    `BODY='${ JSON.stringify(wanted).slice(0, -1) }'`,
    `F=${ READY_STAMP }.$$`,
    `printf '%s,"at":%s,"expires":%s}\\n' "$BODY" "$(date +%s)" "$EXPIRES" > "$F" && chmod 644 "$F" && mv -fT "$F" ${ READY_STAMP } && echo READY-OK`,
    'rm -f "$F"',
  ].join('\n'));

  if (!out.includes('READY-OK')) {
    console.debug(`[workspace] ${ target.workspace } not stamped: ${ out.trim().slice(-200) }`); // eslint-disable-line no-console
  }
}

/** The steps, in order, and the stamp once all of them have really happened. */
async function provision(target: WorkspaceTarget, context: WorkspaceContext, github: string, wanted: WantedStamp | null): Promise<void> {
  await ensureBase(target);
  await ensureSeed(target, context);
  await ensureTools(target);
  await ensureEnvironment(target, github, typeof window === 'undefined' ? '' : window.location.origin);

  const checkedOut = await ensureCheckout(target, context, github);

  // A login that did not come back left the fork and hosts.yml on a fallback name, and that is
  // worth correcting on the next load.
  if (!wanted || !checkedOut || !(await ghLogin(github)).login) {
    return;
  }
  // The work is done by here, so a stamp that cannot be written costs the next load six execs and
  // must not fail whatever the person pressed.
  await writeReadyStamp(target, wanted).catch((e) => {
    console.debug(`[workspace] ${ target.workspace } not stamped: ${ e?.message || e }`); // eslint-disable-line no-console
  });
}

function checkedName(workspace: string): void {
  // An empty name is a caller bug, and a costly one: it would seed with no project, which is the
  // one input layout.mjs needs to place the tree. Refuse it here with a clear message rather than
  // let it reach the pod and fail deep in a build script.
  if (!workspace || !workspace.trim()) {
    throw new Error('ensureWorkspaceReady needs a workspace name; it was called with an empty one.');
  }
}

/**
 * Everything a harness skill needs in the workspace's pod. Safe to call before every action,
 * and cheap the second time: the seed is hashed, the tools are checked, the token is verified.
 *
 * For an action: something is about to run in this workspace, so this always does the work and
 * always checks the Rancher token. Only opening a page believes a stamp.
 *
 * Nothing uses what comes back but the pod's address, and most callers ignore that. The Rancher
 * token rancherToken finds or mints goes only to ensureEnvironment and is not returned from here.
 */
export async function ensureWorkspaceReady(workspace: string, ctx?: WorkspaceContext): Promise<WorkspaceTarget> {
  checkedName(workspace);

  const target = await workspaceTarget(workspace);
  const context = ctx || contextFromName(workspace);
  const github = await githubToken().catch(() => '');

  await provision(target, context, github, await wantedStamp(target, context, github).catch(() => null));

  return target;
}

/**
 * The same, for a page that is only opening: nothing happens if the workspace's stamp says it would
 * be the same work, and six execs and an exec URL with a token in it go unspent.
 *
 * ── A token that goes bad in the meantime ───────────────────────────────────────────────────
 *
 * rancherToken used to ask Rancher on every load, and skipping it needs something else to stop a
 * workspace sitting on a bad token. Two things do. A token whose record gives an expiry inside the
 * TTL never matches, so expiry is not a risk. And the stamp only lasts READY_TTL_MS.
 *
 * What that costs: a token revoked by hand goes unnoticed on page loads for at most an hour after
 * the last provisioning, where it used to be replaced on the next load. Whatever goes through
 * ensureWorkspaceReady does not wait for that: a send, either + button, the queued sweep. These
 * do not go through it and do wait, with the dead token in their environment: typing in the page's
 * shell tab, and a conversation started from a Focus card or a change set. A workspace nobody opens
 * and nobody acts on has always kept its bad token, and still does.
 *
 * What a stamp vouches for going missing is not a cost of this: the service checks the files are
 * still there before it answers (state-api.mjs, READY_NEEDS). What was in them is not checked.
 *
 * A forged stamp can only skip this one workspace's own provisioning. See agent-reads.mjs.
 */
export async function ensureWorkspaceOnOpen(workspace: string): Promise<WorkspaceTarget> {
  checkedName(workspace);

  const target = await workspaceTarget(workspace);
  const context = contextFromName(workspace);
  const github = await githubToken().catch(() => '');
  const wanted = await wantedStamp(target, context, github).catch(() => null);

  if (wanted) {
    const found = await readReadyStamp(workspace);

    if (found && readyStampCurrent(found.stamp, wanted, found.now)) {
      return target;
    }
  }
  await provision(target, context, github, wanted);

  return target;
}

// ── Talking to a conversation ───────────────────────────────────────────────────────────────

/**
 * What a conversation's pane is showing, stripped to printable ASCII.
 *
 * Read straight off tmux in the workspace pod, as the pane's own user (a tmux server is per
 * user). `running` is false when the conversation has no pane yet: nothing has attached to it
 * since the pod started, so whatever is queued for it has not run.
 */
export async function conversationPane(workspace: string, id: string, lines = 60): Promise<{ text: string; running: boolean }> {
  const target = await workspaceTarget(workspace);
  const out = await asNode(target, [
    `if tmux has-session -t mc-${ id } 2>/dev/null; then`,
    `tmux capture-pane -p -S -${ lines } -t mc-${ id } | tr -cd '\\11\\12\\15\\40-\\176' | sed -e 's/[[:space:]]*$//' | grep -v '^$' | tail -n ${ lines };`,
    'else echo BARN-NO-SESSION; fi',
  ].join(' '));

  return { running: !out.includes('BARN-NO-SESSION'), text: out.replace('BARN-NO-SESSION', '').trim() };
}

// ── Sharing: the checkout, built, for nginx to serve ────────────────────────────────────────

export type ShareKind = 'dashboard' | 'storybook';

/** The branch the checkout is on, and its head. */
export async function workspaceBranch(workspace: string): Promise<{ branch: string; sha: string }> {
  const { branch, sha } = await workspaceBranches(workspace);

  return { branch, sha };
}

export interface WorkspaceBranches {
  /** The branch the checkout is on, and its head. */
  branch: string;
  sha: string;
  /** Every local branch, with its head, the current one first. */
  branches: { name: string; sha: string }[];
}

/** The checkout's branches, for a Share tab picking one to build. */
export async function workspaceBranches(workspace: string): Promise<WorkspaceBranches> {
  const out = await readInWorkspace(workspace, [
    `cd $WS/dashboard 2>/dev/null || exit 0`,
    'echo "@@HEAD $(git rev-parse --abbrev-ref HEAD 2>/dev/null) $(git rev-parse --short HEAD 2>/dev/null)"',
    "git for-each-ref --sort=-committerdate --format='%(refname:short) %(objectname:short)' refs/heads 2>/dev/null | head -n 60",
  ].join('\n')).catch(() => '');
  const lines = out.trim().split('\n');
  const head = lines.find((l) => l.startsWith('@@HEAD ')) || '@@HEAD';
  const [branch = '', sha = ''] = head.replace('@@HEAD', '').trim().split(/\s+/);
  const branches = lines.filter((l) => !l.startsWith('@@HEAD') && l.trim()).map((l) => {
    const [name, bsha = ''] = l.trim().split(/\s+/);

    return { name, sha: bsha };
  });

  branches.sort((a, b) => (a.name === branch ? -1 : b.name === branch ? 1 : 0));

  return { branch, sha, branches };
}

/**
 * Build the checkout as it is - the branch it is on, uncommitted changes included - into
 * <workspace>/share/<kind>, where the dashboard-preview App's nginx serves it from (apps.ts,
 * sourceDir). In a tmux session of its own in the workspace pod, so it outlives this page and
 * can be watched; into a `.next` directory that is swapped in when it succeeds, so the link
 * keeps serving the last good build while the next one compiles.
 *
 * `base` is where a dashboard build routes and fetches its assets (previews.ts, previewBase);
 * a Storybook is a plain static site and ignores it.
 */
export async function buildShare(workspace: string, kind: ShareKind, base: string, ref = ''): Promise<'started' | 'already-building'> {
  const target = await workspaceTarget(workspace);
  const script = [
    '#!/bin/bash',
    // Its own, because this one is written to a file and run later by the builder Job, outside
    // the runners below that put WS in the shell for a script they carry.
    `WS=${ workspaceRoot(workspace) }`,
    'KIND=$1; BASE=$2; REF=$3',
    `cd $WS/dashboard || exit 1`,
    'mkdir -p $WS/.share $WS/share',
    'S=$WS/.share/$KIND.status; L=$WS/.share/$KIND.log',
    'branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null); sha=$(git rev-parse --short HEAD 2>/dev/null)',
    // Never built in the checkout itself. The dev server running there shares
    // node_modules/.cache with anything else that builds there, and a production build that
    // reads the dev server's cached script blocks comes out half compiled (a <script setup>
    // component whose template was never attached: RcButton rendered nothing, so the shared
    // login page had no buttons). So the source is staged: a worktree of the branch asked for,
    // or a copy of the working tree as it is, uncommitted changes included; node_modules come
    // along as hard links (the same files, no second install) minus the cache; the staging
    // goes when the build is done.
    'WT=$WS/.share/src-$KIND',
    'git worktree remove --force $WT >/dev/null 2>&1; rm -rf $WT; mkdir -p $WT',
    'if [ -n "$REF" ] && [ "$REF" != "$branch" ]; then',
    '  rmdir $WT; git worktree add --detach $WT "$REF" >/dev/null 2>&1 || { echo "failed $(date -u +%FT%TZ) $REF unknown $BASE" > $S; exit 1; }',
    '  branch=$REF; sha=$(git -C $WT rev-parse --short HEAD 2>/dev/null)',
    'else',
    "  tar --exclude=./node_modules --exclude='./*/node_modules' --exclude='./pkg/*/node_modules' --exclude=./.git -cf - . | tar -C $WT -xf -",
    'fi',
    "for d in $(find . -maxdepth 3 -name node_modules -type d -not -path '*/node_modules/*'); do mkdir -p $WT/$(dirname $d); cp -al $d $WT/$d; rm -rf $WT/$d/.cache; done",
    'cd $WT',
    // The BASE is recorded, not just the branch and the sha.
    //
    // A build is routed for where it will be served - `/dashboard/` on a public name, the proxy
    // path behind this Rancher - and the two are not interchangeable: a build routed for one and
    // served on the other loads its scripts from an address that answers 401 and HTML, which the
    // browser reports as "Refused to execute script ... MIME type". That is what a share pod
    // fetching a build made for the other base looks like, and nothing could tell, because the
    // status said `ok` either way. A fifth field, so a reader that splits on whitespace and takes
    // four is unaffected - shareStatus does exactly that.
    'echo "building $(date -u +%FT%TZ) $branch $sha $BASE" > $S',
    // At the lowest priority either way: a build is background work, and one that takes the whole
    // node has taken k3s down with it. In the builder it is alone with a limit of its own, so it
    // takes the cores and the heap it was given; anywhere else it leaves half the node alone.
    'if [ "$SHARE_CPUS" = all ]; then',
    '  RUN="nice -n 19"',
    'else',
    '  CORES=$(nproc 2>/dev/null || echo 2); HALF=$(( CORES / 2 )); [ "$HALF" -lt 1 ] && HALF=1',
    '  RUN="nice -n 19 taskset -c 0-$((HALF - 1))"',
    'fi',
    '{',
    '  export NODE_OPTIONS=--max_old_space_size=${SHARE_HEAP_MB:-4096}',
    '  rm -rf $WS/share/$KIND.next',
    '  if [ "$KIND" = storybook ]; then',
    '    $RUN yarn build-storybook && cp -r storybook/storybook-static $WS/share/$KIND.next',
    '  else',
    '    ROUTER_BASE=$BASE RESOURCE_BASE=$BASE OUTPUT_DIR=$WS/share/$KIND.next $RUN yarn build && node $WS/.share/unrewrite.js $WS/share/$KIND.next/index.html',
    '  fi',
    '} > $L 2>&1',
    'RC=$?',
    `cd $WS/dashboard && git worktree remove --force $WT >/dev/null 2>&1; rm -rf $WT`,
    'if [ $RC -eq 0 ] && [ -f $WS/share/$KIND.next/index.html ]; then',
    // The swap, by rename only. `mv a b` puts a *inside* b when b is a directory, so the site
    // has to be out of the way before the new one takes its name - and the old one is moved
    // aside under a name nothing else can hold, rather than to a fixed `.old` that a previous
    // build may have left behind and this one may not have the rights to delete (a build run
    // as root once leaves a directory the pane user cannot remove). Renaming needs write on
    // the parent and nothing else, so it works whoever owns what is there.
    '  OLD=$WS/share/$KIND.old-$(date +%s)-$$',
    '  [ -e $WS/share/$KIND ] && mv $WS/share/$KIND $OLD',
    '  if mv $WS/share/$KIND.next $WS/share/$KIND; then',
    '    echo "ok $(date -u +%FT%TZ) $branch $sha $BASE" > $S',
    '  else',
    '    [ -e $OLD ] && mv $OLD $WS/share/$KIND',
    '    echo "failed $(date -u +%FT%TZ) $branch $sha $BASE" > $S',
    '  fi',
    '  rm -rf $WS/share/$KIND.old-* $WS/share/$KIND.old 2>/dev/null',
    'else',
    '  echo "failed $(date -u +%FT%TZ) $branch $sha $BASE" > $S',
    'fi',
    '',
  ].join('\n');
  const out = await asNode(target, [
    'mkdir -p $WS/.share',
    `echo ${ UNREWRITE_B64 } | base64 -d > $WS/.share/unrewrite.js`,
    `echo ${ b64(script) } | base64 -d > $WS/.share/build.sh && chmod +x $WS/.share/build.sh`,
    'echo SCRIPT-OK',
  ].join('\n'));

  if (!out.includes('SCRIPT-OK')) {
    throw new Error(`The build script could not be written into the workspace: ${ out.trim().slice(-300) }`);
  }

  return startBuilder(workspace, kind, base, ref);
}

// ── The builder ────────────────────────────────────────────────────────────────────────────
//
// A share is built in a Job of its own, not in the workspace's pod. The pod is capped at 5Gi and
// already holds the dev server; a production build of the dashboard asks Node for a 4Gi heap, and
// the two together put the container over its limit, so the kernel killed it - taking the dev
// server, the panes and the conversation with it, and leaving the build "failed ... killed".
//
// The Job mounts the same node directory the workspace does, so it reads the same checkout and
// writes the same `share/<kind>` output and `.share/<kind>.status`; nothing else about the build
// changes. It runs as the workspace's user (1000) so what it writes stays theirs.
const BUILDER_MEMORY = '12Gi';
const BUILDER_CPU = '4';
const BUILDER_HEAP_MB = '8192';

/** The name the skills' share.sh uses too, so a build started either way is the same build. */
function builderName(kind: ShareKind): string {
  return `share-build-${ kind }`;
}

/** The builder Job for this kind, if one exists. `active` is Kubernetes' own count of running pods. */
async function builderJob(workspace: string, kind: ShareKind): Promise<Json | null> {
  return devFetch(`${ clusterBase('local') }/v1/batch.jobs/${ workspaceNamespace(workspace) }/${ builderName(kind) }`).catch(() => null);
}

async function startBuilder(workspace: string, kind: ShareKind, base: string, ref: string): Promise<'started' | 'already-building'> {
  const namespace = workspaceNamespace(workspace);
  const root = workspaceRoot(workspace);
  const existing = await builderJob(workspace, kind);

  if (existing?.status?.active) {
    return 'already-building';
  }
  if (existing) {
    // Finished, and a Job's spec cannot be replaced: take the old one (and its pod) away first.
    await devFetch(`${ clusterBase('local') }/v1/batch.jobs/${ namespace }/${ builderName(kind) }?propagationPolicy=Foreground`, { method: 'DELETE' }).catch(() => null);
    for (let i = 0; i < 30 && await builderJob(workspace, kind); i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  await devFetch(`${ clusterBase('local') }/v1/batch.jobs`, {
    method: 'POST',
    body:   JSON.stringify({
      apiVersion: 'batch/v1',
      kind:       'Job',
      metadata:   { name: builderName(kind), namespace, labels: { 'dev.rancher.io/workspace': workspace, 'dev.rancher.io/share': kind } },
      spec:       {
        backoffLimit: 0,
        // Long enough to read the pod's own logs after a failure, short enough not to pile up.
        ttlSecondsAfterFinished: 1800,
        template:                {
          metadata: { labels: { 'dev.rancher.io/workspace': workspace, 'dev.rancher.io/share': kind } },
          spec:     {
            restartPolicy:   'Never',
            securityContext: { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
            containers:      [{
              name:       'build',
              image:      'node:24',
              command:    ['/bin/bash', `${ root }/.share/build.sh`, kind, base, ref],
              workingDir: `${ root }/dashboard`,
              env:        [
                { name: 'HOME', value: `${ root }/.home` },
                { name: 'WS', value: root },
                // Alone in this container, so the build takes the cores and the heap it was given.
                { name: 'SHARE_CPUS', value: 'all' },
                { name: 'SHARE_HEAP_MB', value: BUILDER_HEAP_MB },
                // The same caches the workspace itself installs into, so a staged build finds
                // what `yarn install` already downloaded rather than fetching it again.
                { name: 'YARN_CACHE_FOLDER', value: '/workspaces/.shared/yarn' },
                { name: 'CYPRESS_CACHE_FOLDER', value: '/workspaces/.shared/cypress' },
                { name: 'npm_config_cache', value: '/workspaces/.shared/npm' },
                { name: 'PLAYWRIGHT_BROWSERS_PATH', value: '/workspaces/.shared/playwright' },
              ],
              resources:    { requests: { cpu: '500m', memory: '1Gi' }, limits: { cpu: BUILDER_CPU, memory: BUILDER_MEMORY } },
              volumeMounts: [{ name: 'work', mountPath: '/workspaces' }],
            }],
            volumes: [{ name: 'work', hostPath: { path: '/var/lib/rancher/dev-workspaces', type: 'DirectoryOrCreate' } }],
          },
        },
      },
    }),
  });

  return 'started';
}

export interface ShareBuild {
  state: 'none' | 'building' | 'ok' | 'failed' | 'stopped';
  at: string;
  branch: string;
  sha: string;
  /** The last lines of the build's output, for a failure or a build in progress. */
  log: string;
  /** Whether something is building it right now (the builder Job for this kind). */
  running: boolean;
}

/** What each kind's build in the workspace is up to, off its status file and the tail of its log. */
export async function shareStatus(workspace: string): Promise<Record<ShareKind, ShareBuild>> {
  // Whether a build is still going is the builder Job's to say, as against what the status file
  // last wrote: a build whose Job was killed leaves "building" behind for ever, and a tab that
  // believes it is watching one is a tab that never says the thing that happened.
  const live: Record<string, boolean> = {};

  for (const kind of ['dashboard', 'storybook'] as ShareKind[]) {
    live[kind] = !!(await builderJob(workspace, kind))?.status?.active;
  }
  const out = await readInWorkspace(workspace, [
    'for k in dashboard storybook; do',
    '  echo "@@KIND $k"; cat $WS/.share/$k.status 2>/dev/null || echo none',

    '  echo "@@LOG"; tail -n 12 $WS/.share/$k.log 2>/dev/null | cut -c1-200',
    'done',
  ].join('\n')).catch(() => '');
  const result: Record<ShareKind, ShareBuild> = {
    dashboard: {
      state: 'none', at: '', branch: '', sha: '', log: '', running: false,
    },
    storybook: {
      state: 'none', at: '', branch: '', sha: '', log: '', running: false,
    },
  };

  for (const chunk of out.split('@@KIND ').slice(1)) {
    const [head, log = ''] = chunk.split('@@LOG');
    const lines = head.trim().split('\n');
    const kind = lines[0]?.trim() as ShareKind;
    const alive = !!live[kind];
    const [written = 'none', at = '', branch = '', sha = ''] = (lines[1] || 'none').trim().split(/\s+/);
    // "building" and nothing building it means the build died with whatever was running it -
    // the pod restarted, the node ran out of memory, somebody killed the session. Its log is
    // the last thing it said, which is where the reason is.
    const state = written === 'building' && !alive ? 'stopped' : written;

    if (kind in result) {
      result[kind] = {
        state: (['building', 'ok', 'failed', 'stopped'].includes(state) ? state : 'none') as ShareBuild['state'], at, branch, sha, log: log.trim(), running: alive,
      };
    }
  }

  return result;
}

/**
 * Write bytes into a workspace's artifacts, so that something from the person's own machine
 * can be attached to a review the same way an agent's recording is. Under `artifacts/review`,
 * named safely, and owned by the workspace's user.
 */
export async function putArtifact(workspace: string, name: string, base64: string): Promise<string> {
  const safe = (name || 'attachment').replace(/[^A-Za-z0-9._-]/g, '-').slice(-80);
  const rel = `artifacts/review/${ Date.now().toString(36) }-${ safe }`;
  const target = await workspaceTarget(workspace);
  const out = await asNode(target, [
    `mkdir -p $WS/artifacts/review`,
    `printf %s '${ base64.replace(/'/g, "") }' | base64 -d > $WS/${ rel }`,
    `[ -s $WS/${ rel } ] && echo PUT-OK`,
  ].join('\n'));

  if (!out.includes('PUT-OK')) {
    throw new Error(`${ name } could not be written into ${ workspace }: ${ out.trim().slice(-200) }`);
  }

  return rel;
}

/** Base64 goes into the pod this many characters at a time: an exec's command is its URL, and a URL has a length. */
const SAVE_CHUNK = 3072;
/** How many of those are in flight at once. */
const SAVE_PARALLEL = 6;

/** The file is not what it was when it was opened: an agent wrote it in the meantime. */
export class ArtifactChanged extends Error {
  /** Read by the viewer, which is not this module's and does not import its classes. */
  code = 'changed';
}

/**
 * Write text over a file under a workspace's artifacts, as the workspace's own user.
 *
 * Through the workspace's pod, not the in-cluster API: that has the tree mounted read-only, and
 * is meant to. So it is an exec, and an exec carries its command in the URL - the text goes in
 * as numbered pieces, several at a time, and is put together, counted and only then written
 * over the file, so a piece that did not arrive leaves the file as it was.
 *
 * `was` is the SHA-256 of the bytes the editor opened. An agent is usually still working in
 * this tree, and a save that silently replaced what it wrote a minute ago would be a save that
 * loses work; when the file no longer hashes to that, this throws ArtifactChanged instead.
 */
export async function saveArtifact(workspace: string, relPath: string, text: string, was = ''): Promise<void> {
  const rel = String(relPath || '').replace(/^\/+/, '');

  if (!rel || rel.split('/').some((part) => !part || part === '.' || part === '..') || /['\0\n\r]/.test(rel) || !/^[0-9a-f]*$/.test(was)) {
    throw new Error(`${ relPath } is not a file under the workspace's artifacts.`);
  }
  const target = await workspaceTarget(workspace);
  const file = `"$WS"/artifacts/'${ rel }'`;
  const stage = `/tmp/.dev-save-${ Date.now().toString(36) }${ Math.random().toString(36).slice(2, 8) }`;
  const encoded = b64(text);
  const bytes = new TextEncoder().encode(text).length;
  const ready = await asNode(target, [
    `f=${ file }`,
    '[ -f "$f" ] || { echo SAVE-MISSING; exit 0; }',
    // A link out of the tree is not a file in it, whatever its path says.
    'case "$(realpath -- "$f")" in "$(realpath -- "$WS/artifacts")"/*) ;; *) echo SAVE-MISSING; exit 0 ;; esac',
    was ? `[ "$(sha256sum < "$f" | cut -d' ' -f1)" = ${ was } ] || { echo SAVE-CHANGED; exit 0; }` : '',
    `mkdir -p ${ stage } && echo SAVE-READY`,
  ].join('\n'));

  if (ready.includes('SAVE-CHANGED')) {
    throw new ArtifactChanged(`${ rel } changed in the workspace after it was opened here.`);
  }
  if (!ready.includes('SAVE-READY')) {
    throw new Error(ready.includes('SAVE-MISSING') ? `${ rel } is not in the workspace any more.` : `${ workspace } did not answer: ${ ready.trim().slice(-200) || 'nothing came back' }`);
  }

  const pieces: string[] = [];

  for (let i = 0; i < encoded.length; i += SAVE_CHUNK) {
    pieces.push(encoded.slice(i, i + SAVE_CHUNK));
  }
  for (let i = 0; i < pieces.length; i += SAVE_PARALLEL) {
    await Promise.all(pieces.slice(i, i + SAVE_PARALLEL).map((piece, n) => asNode(target, `printf %s '${ piece }' > ${ stage }/part-${ String(i + n).padStart(6, '0') }`)));
  }

  const out = await asNode(target, [
    `f=${ file }`,
    `cat ${ stage }/part-* 2>/dev/null | base64 -d > ${ stage }/whole`,
    // Counted before it is written: a piece that never arrived must not become the file.
    `if [ "$(wc -c < ${ stage }/whole)" = ${ bytes } ]; then cat ${ stage }/whole > "$f" && echo SAVE-OK; else echo SAVE-SHORT; fi`,
    `rm -rf ${ stage }`,
  ].join('\n'));

  if (!out.includes('SAVE-OK')) {
    throw new Error(out.includes('SAVE-SHORT') ? `${ rel } did not reach the workspace whole, so it was left as it was. Save again.` : `${ rel } could not be written: ${ out.trim().slice(-200) || 'nothing came back' }`);
  }
}
