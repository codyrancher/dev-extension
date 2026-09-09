// A workspace's pod, made into the harness's project container, on first use.
//
// The harness built a container around each project: the checkout at /workspace/dashboard, the
// skills and rules beside it, `gh` signed in, git pointed at the fork, a browser next door with
// CDP open, and an env file with everything a skill reads. A workspace here is a pod that the
// rancher-dev App made with the checkout and the dev server in it, and this puts the rest in
// place, so that the harness's prompts and skills run in it unchanged. The one thing that is
// deliberately different is what CLAUDE.md says about the environment (agent-seed/CLAUDE.dev.md
// and rules/environment.md).
//
// Every step is idempotent and lands under /workspace, which is a hostPath, so it survives the
// pod and is written once; the seed carries a hash so a changed skill reaches a workspace that
// already has the old one. Nothing here puts a token in a prompt, a transcript or a queue
// file: the secrets go into the workspace's .env, gh's hosts.yml and git's credential store, 0600
// and owned by the pane's user, the same three places the harness put them.

import {
  podExecOnce, workspacePod, workspaceNamespace, WORKSPACE_CONTAINER, githubToken, devFetch, secretValue
} from './api';
import { AGENT_SEED } from './agent-seed.generated';
import { UNREWRITE_B64 } from './apps';
import {
  DEV_API_IN_CLUSTER, workspaceRoot
} from './config/constants';

const GH_VERSION = '2.76.1';
const JQ_VERSION = '1.7.1';
// Paths inside the workspace, as the pod's shell sees them.
//
// `$WS` rather than a directory: a workspace's tree is at /workspaces/<name>, which asRoot and
// asNode below put in the shell's WS before anything here runs. Every script in this file goes
// through one of those two, so writing the tree's own name into thirty scripts would be thirty
// chances to write the wrong one.
const BIN = '$WS/bin';
const ENV_FILE = '$WS/.env';
const SEED_MARKER = '$WS/.dev-seed';

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

/**
 * Run a script in the pod, as root.
 *
 * The script travels base64 and is run from a file, so nothing in it is ever quoted for a
 * shell: a token, a JSON document and an apostrophe in somebody's name all arrive intact.
 */
async function asRoot(target: WorkspaceTarget, script: string): Promise<string> {
  const file = `/tmp/.dev-${ Date.now().toString(36) }${ Math.random().toString(36).slice(2, 8) }.sh`;
  const wrapped = `WS=${ workspaceRoot(target.workspace) }\n${ script }`;

  return podExecOnce(target.namespace, target.pod, WORKSPACE_CONTAINER, [
    '/bin/sh', '-c', `echo ${ b64(wrapped) } | base64 -d > ${ file } && /bin/bash ${ file } 2>&1; rc=$?; rm -f ${ file }; exit $rc`,
  ]);
}

/** The same, as the pane's user, with its home: the user the checkout and the tmux server belong to. */
async function asNode(target: WorkspaceTarget, script: string): Promise<string> {
  const file = `/tmp/.dev-${ Date.now().toString(36) }${ Math.random().toString(36).slice(2, 8) }.sh`;
  const wrapped = [
    `WS=${ workspaceRoot(target.workspace) }`,
    `export HOME=$WS/.home; export PATH=${ BIN }:$WS/.home/.local/bin:$PATH`,
    `set -a; [ -f ${ ENV_FILE } ] && . ${ ENV_FILE }; set +a`,
    script,
  ].join('\n');

  return podExecOnce(target.namespace, target.pod, WORKSPACE_CONTAINER, [
    '/bin/sh', '-c', `echo ${ b64(wrapped) } | base64 -d > ${ file } && chmod 755 ${ file } && if [ "$(id -u)" = 0 ]; then su node -s /bin/bash -c "/bin/bash ${ file }" 2>&1; else /bin/bash ${ file } 2>&1; fi; rc=$?; rm -f ${ file }; exit $rc`,
  ]);
}

/** Read something out of the checkout, as its owner. What the Review tab is drawn from. */
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
  const out = await asRoot(target, [
    'set -e',
    `mkdir -p ${ BIN } $WS/.claude $WS/artifacts/a11y $WS/.kube $WS/.queue $WS/.home/.local/bin $WS/.home/.config/gh`,
    // The apt path is root's and the rootfs is the pod's, so this repeats after a restart; it is
    // in the background because a review should not wait a minute for ffmpeg it may never use.
    'if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v lsof >/dev/null 2>&1; then',
    '  if [ ! -f /tmp/.dev-apt ]; then touch /tmp/.dev-apt; (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg jq lsof iproute2 >/dev/null 2>&1; rm -f /tmp/.dev-apt) >$WS/.apt.log 2>&1 & fi',
    'fi',
    `git config --global --add safe.directory $WS/dashboard 2>/dev/null || true`,
    `chown -R node:node ${ BIN } $WS/.claude $WS/artifacts $WS/.kube $WS/.queue $WS/.home/.local $WS/.home/.config 2>/dev/null || true`,
    'echo BASE-OK',
  ].join('\n'));

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
  const version = `${ seedVersion() }:${ ctx.issue || '' }:${ ctx.pr || '' }:${ target.workspace }`;
  const current = await asNode(target, `cat ${ SEED_MARKER } 2>/dev/null || true`);

  if (current.trim() === version) {
    return;
  }

  // The script that lays the files out rides in the seed itself (agent-seed/layout.mjs), so
  // what travels here is a few lines: an exec command is URL arguments, and a script of any
  // size in it is a request something between here and the pod refuses.
  const out = await asNode(target, [
    'set -e',
    'S=/tmp/dev-seed.$$.json; L=/tmp/dev-layout.$$.mjs',
    `curl -fsS ${ DEV_API_IN_CLUSTER }/agent-seed -o $S`,
    `node -e "const s=require(process.argv[1]);require('fs').writeFileSync(process.argv[2],s['layout.mjs'])" $S $L`,
    `DEV_PROJECT=${ target.workspace } DEV_ISSUE=${ ctx.issue || '' } DEV_PR=${ ctx.pr || '' } DEV_SEED_FILE=$S DEV_ROOT=$WS DEV_WORKDIR=$WS/dashboard DEV_HOME=$WS/.home node $L`,
    `echo '${ version }' > ${ SEED_MARKER }`,
    'rm -f $S $L',
    'echo SEED-OK',
  ].join('\n'));

  if (!out.includes('SEED-OK')) {
    throw new Error(`The skills could not be written into the workspace: ${ out.trim().slice(-300) }`);
  }
}

/** `gh` and `jq`, static builds, in the workspace's bin. Downloaded once; the bin is on a hostPath. */
async function ensureTools(target: WorkspaceTarget): Promise<void> {
  const have = await asNode(target, `for t in gh jq; do [ -x ${ BIN }/$t ] && printf '%s ' $t; done; true`);
  const missing = ['gh', 'jq'].filter((tool) => !have.includes(tool));

  if (!missing.length) {
    return;
  }

  const steps = ['set -e'];

  if (missing.includes('jq')) {
    steps.push(`curl -fsSL -o ${ BIN }/jq https://github.com/jqlang/jq/releases/download/jq-${ JQ_VERSION }/jq-linux-amd64 && chmod +x ${ BIN }/jq`);
  }
  if (missing.includes('gh')) {
    steps.push(`curl -fsSL https://github.com/cli/cli/releases/download/v${ GH_VERSION }/gh_${ GH_VERSION }_linux_amd64.tar.gz | tar -xz -C /tmp && mv /tmp/gh_${ GH_VERSION }_linux_amd64/bin/gh ${ BIN }/gh && rm -rf /tmp/gh_${ GH_VERSION }_linux_amd64`);
  }
  steps.push(`for f in gh jq; do ln -sf ${ BIN }/$f $WS/.home/.local/bin/$f; done`, 'echo TOOLS-OK');

  const out = await asNode(target, steps.join('\n'));

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
  const existing = (await asRoot(target, [
    `T=$(grep '^RANCHER_TOKEN=' ${ ENV_FILE } 2>/dev/null | cut -d= -f2-)`,
    'U="${API:-$RANCHER_URL}"',
    `BR='${ browser }'`,
    `PREV=$(grep '^RANCHER_URL=' ${ ENV_FILE } 2>/dev/null | cut -d= -f2-)`,
    // Reused when it still answers on any host it might be for - its target, the one .env
    // records, or the browser's Rancher - not only on $U. A token that is good against the
    // parent must not be thrown away and re-minted on every call just because the workspace's
    // own target is a downstream it does not match; ensureEnvironment writes the host it is for.
    '[ -n "$T" ] || exit 0',
    'for C in "$U" "$PREV" "$BR"; do',
    '  [ -n "$C" ] || continue',
    '  if [ "$(curl -sk -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $T" "$C/v3/users?me=true")" = 200 ]; then echo "$T"; exit 0; fi',
    'done',
  ].join('\n'))).trim();

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

  const out = await asRoot(target, [
    'set -e',
    'U="${API:-$RANCHER_URL}"',
    `BR='${ browser }'`,
    `T='${ rancher }'`,
    // The host the token authenticates against, not the one the pod was built with: the
    // workspace's own target first (its dev server runs against it), then the .env host already
    // there, then the browser's Rancher (which is what a freshly-minted token is for). Whichever
    // answers 200 is the one that is written; if none do the token is genuinely spent, and the
    // intended target is kept so the file still names the right Rancher for when it is renewed.
    `PREV=$(grep '^RANCHER_URL=' ${ ENV_FILE } 2>/dev/null | cut -d= -f2-)`,
    'PICK=""',
    'for C in "$U" "$PREV" "$BR"; do',
    '  [ -n "$C" ] || continue',
    '  if [ -n "$T" ] && [ "$(curl -sk -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $T" "$C/v3/users?me=true")" = 200 ]; then PICK="$C"; break; fi',
    'done',
    'if [ -n "$PICK" ]; then U="$PICK"; fi',
    'H=$(echo "$U" | sed -e "s|^https\\?://||" -e "s|/.*$||")',
    'umask 077',
    `cat > ${ ENV_FILE } <<EOF`,
    'API=$U',
    'RANCHER_URL=$U',
    'RANCHER_HOST_NAME=$H',
    `RANCHER_TOKEN=${ rancher }`,
    `HARNESS_API=${ DEV_API_IN_CLUSTER }`,
    `CLAUDE_HARNESS_API=${ DEV_API_IN_CLUSTER }`,
    `HARNESS_PROJECT=${ target.workspace }`,
    `PROJECT_NAME=${ target.workspace }`,
    'CLAUDE_BROWSER_CDP=http://localhost:9222',
    `GH_TOKEN=${ github }`,
    `GITHUB_TOKEN=${ github }`,
    'KUBECONFIG=$WS/.kube/config',
    'EOF',
    `chown node:node ${ ENV_FILE } && chmod 600 ${ ENV_FILE }`,
    // bashrc: the same three lines init.sh appended, once.
    `touch $WS/.home/.bashrc`,
    `grep -q 'source $WS/.env' $WS/.home/.bashrc || printf '%s\\n' '# dev extension (the harness put the same in init.sh)' 'set -a; source $WS/.env; set +a' 'export PATH=$WS/bin:$PATH' >> $WS/.home/.bashrc`,
    `chown node:node $WS/.home/.bashrc`,
    // gh and git, the way init.sh did them.
    github ? `cat > $WS/.home/.config/gh/hosts.yml <<EOF
github.com:
    oauth_token: ${ github }
    user: ${ login || 'codyrancher' }
    git_protocol: https
EOF
chown -R node:node $WS/.home/.config/gh && chmod 600 $WS/.home/.config/gh/hosts.yml
echo "https://${ login || 'codyrancher' }:${ github }@github.com" > $WS/.git-credentials && chown node:node $WS/.git-credentials && chmod 600 $WS/.git-credentials` : 'true',
    // kubectl, at the Rancher's local cluster, as the token's user.
    rancher ? `cat > $WS/.kube/config <<EOF
apiVersion: v1
kind: Config
clusters:
- name: local
  cluster:
    server: $U/k8s/clusters/local
    insecure-skip-tls-verify: true
users:
- name: local
  user:
    token: ${ rancher }
contexts:
- name: local
  context:
    cluster: local
    user: local
current-context: local
EOF
chown -R node:node $WS/.kube && chmod 600 $WS/.kube/config` : 'true',
    'echo ENV-OK',
  ].join('\n'));

  if (!out.includes('ENV-OK')) {
    throw new Error(`The workspace's environment could not be written: ${ out.trim().slice(-300) }`);
  }
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
async function ensureCheckout(target: WorkspaceTarget, ctx: WorkspaceContext, github: string): Promise<void> {
  const who = github ? await ghLogin(github) : { login: '', name: '', email: '' };
  const name = (await secretValue('GIT_NAME').catch(() => '')) || who.name;
  const email = (await secretValue('GIT_EMAIL').catch(() => '')) || who.email;
  const fork = who.login || 'codyrancher';
  const out = await asNode(target, [
    `cd $WS/dashboard 2>/dev/null || { echo NO-CHECKOUT; exit 0; }`,
    name ? `git config user.name ${ JSON.stringify(name) }` : 'true',
    email ? `git config user.email ${ JSON.stringify(email) }` : 'true',
    github ? 'git config credential.helper "store --file=$WS/.git-credentials"' : 'true',
    `if git remote get-url origin 2>/dev/null | grep -q 'github.com/rancher/dashboard'; then git remote rename origin upstream; git remote add origin https://github.com/${ fork }/dashboard.git; fi`,
    'git remote get-url upstream >/dev/null 2>&1 || git remote add upstream https://github.com/rancher/dashboard.git',
    'mkdir -p .git/info',
    // The harness's three, plus what this environment leaves in the tree: the App's install
    // marker and the file claude keeps beside a checkout it was started in.
    "for P in '.mcp.json' '.claude/' '.vscode/' '.install-done' '.claude.json' 'vue.config.orig.js'; do grep -qxF \"$P\" .git/info/exclude 2>/dev/null || echo \"$P\" >> .git/info/exclude; done",
    // An earlier version marked the checkout's vue.config.js skip-worktree; the App no longer
    // touches that file (see apps.ts, WORKSPACE_SERVE), and the mark broke its boot. Undone.
    'git update-index --no-skip-worktree vue.config.js 2>/dev/null || true',
    'git checkout -- vue.config.js 2>/dev/null || true',
    // The PR's head, once, and only onto a clean default branch: a workspace somebody has
    // already worked in is theirs.
    ctx.pr ? `if [ ! -f $WS/.pr-checkout ] && [ -z "$(git status --porcelain --untracked-files=no)" ] && git rev-parse --abbrev-ref HEAD | grep -qE '^(master|main)$'; then git fetch --depth 200 upstream pull/${ ctx.pr }/head:pr-${ ctx.pr } && git checkout pr-${ ctx.pr } && echo ${ ctx.pr } > $WS/.pr-checkout; fi` : 'true',
    '[ -d $WS/node_modules/playwright-core ] || (cd $WS && npm install --no-save --silent playwright-core >/dev/null 2>&1 || echo "playwright-core install failed")',
    'echo CHECKOUT-OK',
  ].join('\n'));

  if (!out.includes('CHECKOUT-OK') && !out.includes('NO-CHECKOUT')) {
    throw new Error(`The checkout could not be set up: ${ out.trim().slice(-300) }`);
  }
}

/**
 * Everything a harness skill needs in the workspace's pod. Safe to call before every action,
 * and cheap the second time: the seed is hashed, the tools are checked, the token is verified.
 */
export async function ensureWorkspaceReady(workspace: string, ctx?: WorkspaceContext): Promise<WorkspaceTarget> {
  // An empty name is a caller bug, and a costly one: it would seed with no project, which is the
  // one input layout.mjs needs to place the tree. Refuse it here with a clear message rather than
  // let it reach the pod and fail deep in a build script.
  if (!workspace || !workspace.trim()) {
    throw new Error('ensureWorkspaceReady needs a workspace name; it was called with an empty one.');
  }

  const target = await workspaceTarget(workspace);
  const context = ctx || contextFromName(workspace);
  const github = await githubToken().catch(() => '');

  await ensureBase(target);
  await ensureSeed(target, context);
  await ensureTools(target);
  await ensureEnvironment(target, github, typeof window === 'undefined' ? '' : window.location.origin);
  await ensureCheckout(target, context, github);

  return target;
}

// ── Talking to a conversation ───────────────────────────────────────────────────────────────

/**
 * Queue a prompt for a conversation to open with, or say something into one that is running.
 *
 * The pane's runner (shell.sh, then claude-session.sh, both in the workspace's /seed) reads
 * `<queue>/<id>`: on its first start as the opening prompt, and afterwards as the
 * next thing said. The conversation need not be running yet; that is the point of a queue.
 */
export async function queuePrompt(workspace: string, id: string, prompt: string): Promise<void> {
  const target = await workspaceTarget(workspace);
  const out = await asRoot(target, [
    `mkdir -p $WS/.queue`,
    `echo ${ b64(prompt) } | base64 -d > $WS/.queue/${ id }`,
    `chown -R node:node $WS/.queue`,
    // A pane that is already running has read its queue and will not look again, so what is
    // said to it is typed into it: the text pasted as one block, then Enter. Through tmux's
    // buffer rather than send-keys, so nothing in the prompt is ever a key name.
    `su node -c 'if tmux has-session -t mc-${ id } 2>/dev/null; then tmux load-buffer -b devq $WS/.queue/${ id } && tmux paste-buffer -b devq -t mc-${ id } -d -p && sleep 0.5 && tmux send-keys -t mc-${ id } Enter && rm -f $WS/.queue/${ id } && echo TYPED; fi' 2>/dev/null`,
    'echo QUEUE-OK',
  ].join('\n'));

  if (!out.includes('QUEUE-OK')) {
    throw new Error('The prompt could not be queued in the workspace.');
  }
}

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

/** End the pane in the workspace pod: the tmux session and everything claude started in it. */
export async function endPane(workspace: string, id: string): Promise<void> {
  const target = await workspaceTarget(workspace).catch(() => null);

  if (!target) {
    return;
  }
  await asNode(target, `tmux kill-session -t mc-${ id } 2>/dev/null || true`);
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
/** One shell word, single-quoted; '' for nothing. */
function shellQuote(value: string): string {
  return value ? `'${ value.replace(/'/g, `'\\''`) }'` : "''";
}

export async function buildShare(workspace: string, kind: ShareKind, base: string, ref = ''): Promise<'started' | 'already-building'> {
  const target = await workspaceTarget(workspace);
  const script = [
    '#!/bin/bash',
    // Its own, because this one is written to a file and run later by tmux, outside the runners
    // below that put WS in the shell for a script they carry.
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
    '  rmdir $WT; git worktree add --detach $WT "$REF" >/dev/null 2>&1 || { echo "failed $(date -u +%FT%TZ) $REF unknown" > $S; exit 1; }',
    '  branch=$REF; sha=$(git -C $WT rev-parse --short HEAD 2>/dev/null)',
    'else',
    "  tar --exclude=./node_modules --exclude='./*/node_modules' --exclude='./pkg/*/node_modules' --exclude=./.git -cf - . | tar -C $WT -xf -",
    'fi',
    "for d in $(find . -maxdepth 3 -name node_modules -type d -not -path '*/node_modules/*'); do mkdir -p $WT/$(dirname $d); cp -al $d $WT/$d; rm -rf $WT/$d/.cache; done",
    'cd $WT',
    'echo "building $(date -u +%FT%TZ) $branch $sha" > $S',
    // On half the cores and at the lowest priority: a build is background work, and one that
    // takes the whole node has taken k3s down with it.
    'CORES=$(nproc 2>/dev/null || echo 2); HALF=$(( CORES / 2 )); [ "$HALF" -lt 1 ] && HALF=1',
    'RUN="nice -n 19 taskset -c 0-$((HALF - 1))"',
    '{',
    '  export NODE_OPTIONS=--max_old_space_size=4096',
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
    '    echo "ok $(date -u +%FT%TZ) $branch $sha" > $S',
    '  else',
    '    [ -e $OLD ] && mv $OLD $WS/share/$KIND',
    '    echo "failed $(date -u +%FT%TZ) $branch $sha" > $S',
    '  fi',
    '  rm -rf $WS/share/$KIND.old-* $WS/share/$KIND.old 2>/dev/null',
    'else',
    '  echo "failed $(date -u +%FT%TZ) $branch $sha" > $S',
    'fi',
    '',
  ].join('\n');
  const out = await asNode(target, [
    'mkdir -p $WS/.share',
    `echo ${ UNREWRITE_B64 } | base64 -d > $WS/.share/unrewrite.js`,
    `echo ${ b64(script) } | base64 -d > $WS/.share/build.sh && chmod +x $WS/.share/build.sh`,
    `if tmux has-session -t mc-share-${ kind } 2>/dev/null; then echo ALREADY; else tmux new-session -d -s mc-share-${ kind } -c $WS/dashboard "$WS/.share/build.sh ${ kind } ${ base } ${ shellQuote(ref) }" && echo STARTED; fi`,
  ].join('\n'));

  if (out.includes('ALREADY')) {
    return 'already-building';
  }
  if (!out.includes('STARTED')) {
    throw new Error(`The build could not be started in the workspace: ${ out.trim().slice(-300) }`);
  }

  return 'started';
}

export interface ShareBuild {
  state: 'none' | 'building' | 'ok' | 'failed' | 'stopped';
  at: string;
  branch: string;
  sha: string;
  /** The last lines of the build's output, for a failure or a build in progress. */
  log: string;
  /** Whether something is building it right now (a tmux session in the workspace). */
  running: boolean;
}

/** What each kind's build in the workspace is up to, off its status file and the tail of its log. */
export async function shareStatus(workspace: string): Promise<Record<ShareKind, ShareBuild>> {
  const out = await readInWorkspace(workspace, [
    'for k in dashboard storybook; do',
    '  echo "@@KIND $k"; cat $WS/.share/$k.status 2>/dev/null || echo none',
    // Whether it is still going, as against what it last wrote: a build whose pod restarted
    // leaves "building" behind for ever, and a tab that believes it is watching one is a tab
    // that never says the thing that happened.
    '  if tmux has-session -t mc-share-$k 2>/dev/null; then echo "@@ALIVE yes"; else echo "@@ALIVE no"; fi',
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
    const alive = /@@ALIVE yes/.test(head);
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
