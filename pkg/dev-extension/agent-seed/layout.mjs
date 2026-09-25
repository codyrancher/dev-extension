// Lay the seed out in a workspace, the way the harness's template engine laid its files out in
// a project container. Run in the workspace pod as the pane's user, after the seed document
// was fetched to /tmp (see workspace-tools.ts, ensureSeed, which is what runs this).
//
//   DEV_PROJECT=pr-18840 DEV_PR=18840 DEV_SEED_FILE=/tmp/dev-seed.json node layout.mjs
//
// `.hbs` files are rendered with the workspace's name and its issue or PR number, exactly the
// variables the harness rendered them with; everything else is copied as it is. Skills, rules
// and settings go beside the checkout and beside the tree's root, CLAUDE.md goes to the root
// with the environment's own section appended, browser.mjs and axtree.mjs to the root and the
// rest of bin/ to <root>/bin.
//
// The harness had one project per container, so every one of these files says /workspace. Here
// one node holds many, at /workspaces/<name>, and the agent pod that runs the conversations has
// all of them mounted at once - so a file that said /workspace would name somebody else's tree,
// or nothing. Every file laid out is rewritten as it is written (see rewriteRoot): one rule,
// applied once, rather than the same edit made by hand in forty-odd skills that came from the
// harness and are still worth taking updates from.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const seed = JSON.parse(fs.readFileSync(process.env.DEV_SEED_FILE || '/tmp/dev-seed.json', 'utf8'));
const rancherUrl = process.env.API || process.env.RANCHER_URL || '';
const ctx = {
  projectName: process.env.DEV_PROJECT || '',
  issueNumber: process.env.DEV_ISSUE || '',
  prNumber:    process.env.DEV_PR || '',
  // The cluster this workspace runs on. Empty or `local` means this Rancher's own cluster, where
  // the agent pod's service account can exec into the pod directly; anything else is a downstream
  // cluster reached through the Rancher proxy - see the dev-shell tunnel below.
  cluster:     process.env.DEV_CLUSTER || '',
  // A leased workspace (`lte-`) holds the tree and the command-line tools and runs nothing:
  // a dev server, a storybook, a Rancher or a browser is attached to it while the work needs
  // one and released when it does not. The rules and CLAUDE.md say different things about the
  // environment depending on which kind this is, so they are rendered with this.
  leased:      /^lte-/.test(process.env.DEV_PROJECT || process.env.PROJECT_NAME || '') ? '1' : '',
  rancherUrl,
  rancherHost: rancherUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, ''),
  // The shared github-browser's CDP: a local workspace reaches it by service name; a downstream one
  // gets the agent pod's tunnel of it into this pod's localhost:9223 (see tunnel-browser.sh).
  githubBrowserCdp: (process.env.DEV_CLUSTER && process.env.DEV_CLUSTER !== 'local')
    ? 'http://127.0.0.1:9223'
    : 'http://github-browser.dev-system.svc.cluster.local:9222',
};
// This workspace's tree. Everything below is under it.
//
// Resolved defensively. A dropped DEV_ROOT *and* DEV_PROJECT used to fall straight back to
// `/workspace`, the harness's root - which does not exist in a dev-extension workspace pod, so
// every mkdir below failed with an opaque EACCES and the whole workspace failed to come up. So
// when neither is given, find the one tree a workspace pod actually holds under /workspaces
// before considering that fallback, and keep the harness default only where /workspace is real.
let ROOT = process.env.DEV_ROOT || (ctx.projectName ? `/workspaces/${ ctx.projectName }` : '');
if (!ROOT) {
  // DEV_ROOT and DEV_PROJECT were both dropped. The workspace pod still names itself in its
  // container env (PROJECT_NAME / HARNESS_PROJECT), so use that when its tree exists under
  // /workspaces - which is what stops a lost env from landing the whole seed at `/workspace`,
  // the harness root that does not exist here, where every mkdir then EACCESes and the
  // workspace never comes up.
  const named = process.env.PROJECT_NAME || process.env.HARNESS_PROJECT || '';

  if (named && fs.existsSync(`/workspaces/${ named }`)) {
    ROOT = `/workspaces/${ named }`;
    ctx.projectName = ctx.projectName || named;
  }
}
if (!ROOT) {
  ROOT = '/workspace';
}
// A workspace pod that is not the harness has no writable `/workspace`. Refuse to seed into it
// with a clear message rather than fail one mkdir at a time with EACCES on `/workspace/bin`.
if (ROOT === '/workspace' && !fs.existsSync('/workspace')) {
  console.error('layout: no workspace root found - set DEV_ROOT or DEV_PROJECT, or run where PROJECT_NAME names a tree under /workspaces.');
  process.exit(1);
}
const WORKDIR = process.env.DEV_WORKDIR || `${ ROOT }/dashboard`;
const HOME = process.env.DEV_HOME || `${ ROOT }/.home`;
const BIN = `${ ROOT }/bin`;
const roots = [ROOT, WORKDIR];

/**
 * The harness's `/workspace` becomes this workspace's own tree.
 *
 * Deliberately blunt: a whole-word match on the path, so `/workspace/x` and a bare `/workspace`
 * both move and `/workspaces/other/x` - already correct - is left alone.
 */
function rewriteRoot(text) {
  return ROOT === '/workspace' ? text : text.replace(/\/workspace(?=[/'"`\s:)\]}]|$)/g, ROOT);
}

function render(text) {
  return text
    .replace(/\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (m, key, body) => (ctx[key] ? body : ''))
    // The harness's Rancher was reachable as <project>-rancher; here it is what $RANCHER_HOST_NAME says.
    .replace(/https:\/\/\{\{projectName\}\}-rancher/g, 'https://$RANCHER_HOST_NAME')
    .replace(/\{\{(\w+)\}\}/g, (m, key) => (ctx[key] == null ? '' : String(ctx[key])));
}

/**
 * What this workspace is for, written into CLAUDE.md after its first section.
 *
 * The file comes from codyrancher/ai-skills as plain text, and which issue or pull request a
 * workspace was made for is not something a repository shared by every workspace can say. So the
 * section the harness template produced with `{{#if issueNumber}}` is added here instead.
 */
function withWorkspaceSection(text) {
  const section = ctx.issueNumber
    ? `# Issue\nThis project is for issue https://github.com/rancher/dashboard/issues/${ ctx.issueNumber }\n`
    : ctx.prNumber ? `# Pull Request\nThis project is for PR https://github.com/rancher/dashboard/pull/${ ctx.prNumber }\n` : '';
  const second = text.search(/\n# /);

  if (!section || second < 0) {
    return text;
  }

  return `${ text.slice(0, second + 1) }${ section }\n${ text.slice(second + 1) }`;
}

for (const root of roots) {
  for (const dir of ['skills', 'rules']) {
    fs.rmSync(path.join(root, '.claude', dir), { recursive: true, force: true });
  }
}

let written = 0;

for (const [rel, raw] of Object.entries(seed)) {
  const isHbs = rel.endsWith('.hbs');
  const out = isHbs ? rel.slice(0, -4) : rel;
  let text = isHbs ? render(raw) : raw;
  let dests = [];

  if (rel.startsWith('skills/') || rel.startsWith('rules/')) {
    dests = roots.map((root) => path.join(root, '.claude', out));
  } else if (out === 'settings.json') {
    dests = roots.map((root) => path.join(root, '.claude', 'settings.json'));
  } else if (rel === 'CLAUDE.md' || rel === 'CLAUDE.md.hbs') {
    dests = [path.join(ROOT, 'CLAUDE.md')];
    text = `${ withWorkspaceSection(text).trimEnd() }\n\n${ render(seed['CLAUDE.dev.md'] || '') }`;
  } else if (rel.startsWith('browser-a11y/')) {
    // The accessibility stack the *browser* container runs: AT-SPI, speech and Orca are
    // session-local, so they live over there and this side only calls them (bin/a11y). The
    // browser mounts these two directories from the same volume - `init` as its own
    // /custom-cont-init.d, so the session bus is up before Chromium starts.
    dests = [path.join(ROOT, '.a11y', rel.slice('browser-a11y/'.length) === path.basename(rel) ? 'opt' : 'init', path.basename(rel))];
  } else if (rel.startsWith('githooks/')) {
    // Not in the checkout: `git clean -xfd` and a fresh clone both take .git/hooks with them,
    // and the tree is re-cloned more often than the seed is laid out. It lives beside the
    // workspace's other seeded files and git is pointed at it below.
    dests = [path.join(ROOT, '.githooks', path.basename(rel))];
  } else if (rel === 'bin/browser.mjs' || rel === 'bin/axtree.mjs') {
    dests = [path.join(ROOT, path.basename(rel))];
  } else if (rel.startsWith('bin/')) {
    dests = [path.join(ROOT, out)];
  } else {
    continue;
  }

  const body = rewriteRoot(text);

  // A rule or skill whose whole body is inside an `{{#if}}` that did not apply renders to
  // nothing. Writing the empty file would put a heading-less rule in front of the agent that
  // says nothing at all, so it is simply not laid out - which is how a rule can be written for
  // one kind of workspace and be absent from the other.
  if ((rel.startsWith('rules/') || rel.startsWith('skills/')) && !body.trim()) {
    continue;
  }

  for (const dest of dests) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body);
    if (rel.startsWith('bin/') || rel.startsWith('browser-a11y/') || rel.startsWith('githooks/') || dest.endsWith('.mjs')) {
      fs.chmodSync(dest, 0o755);
    }
    written++;
  }
}

// Point git at the seeded hooks, so commit-msg runs for every commit made in this workspace.
//
// Set globally rather than in the checkout: the seed is laid out once per workspace but the
// tree gets re-cloned, and `.git/hooks` does not survive that. Global config does, and it also
// covers a repo an agent clones later. Nothing in this workspace ships hooks of its own for it
// to shadow - rancher/dashboard has no husky - and the only hook here strips AI attribution.
const HOOKS = path.join(ROOT, '.githooks');

if (fs.existsSync(HOOKS)) {
  const git = (args, opts = {}) => {
    try {
      execFileSync('git', args, { env: { ...process.env, HOME }, stdio: 'ignore', ...opts });
    } catch { /* no git, or no checkout yet: the global setting below is the one that matters */ }
  };

  git(['config', '--global', 'core.hooksPath', HOOKS]);
  if (fs.existsSync(path.join(WORKDIR, '.git'))) {
    git(['config', 'core.hooksPath', HOOKS], { cwd: WORKDIR });
  }
}

// The tunnel: how a conversation about this workspace runs a command *in* this workspace.
//
// claude runs in the agent pod - one login for every conversation in the dashboard, which is
// why it is there rather than here - and it runs every command through whatever
// CLAUDE_CODE_SHELL_PREFIX names, with the command as one argument. This is what it names.
//
// It carries the command into this workspace's pod, as the workspace user, with the pod's own
// login shell: `.env`, PATH, the toolchain, the dev server on localhost and the browser
// sidecar beside it are all there, and none of them are in the agent pod. The working
// directory comes along too, which is the whole reason a workspace's tree is at the same path
// on both sides.
//
// Written here rather than baked into the agent pod because a workspace knows its own name and
// the pod does not: one wrapper per workspace, laid out with everything else it needs.
const downstream = ctx.cluster && ctx.cluster !== 'local';
const wrapper = [
  '#!/bin/sh',
  '# Run one command inside this workspace\'s pod. Written by the seed; see layout.mjs.',
  `NS=dev-${ ctx.projectName }`,
  `WS=${ ROOT }`,
  '',
  '# kubectl is installed into the agent pod\'s own home, which an exec\'s PATH does not have.',
  'PATH=/workspace/.home/.local/bin:/usr/local/bin:$PATH',
  'export PATH',
  '',
  ...(downstream ? [
    '# This workspace runs on a downstream cluster, whose pods this pod\'s own service account',
    '# cannot reach. Go through the Rancher proxy with the durable token the agent pod carries',
    '# (the downstream-exec Secret), read fresh on each command so a rotated token is picked up.',
    'DS=/var/run/downstream-exec',
    'DRURL=$(cat "$DS/rancherUrl" 2>/dev/null)',
    'DTOKEN=$(cat "$DS/token" 2>/dev/null)',
    `KARGS="--server=$DRURL/k8s/clusters/${ ctx.cluster } --token=$DTOKEN --insecure-skip-tls-verify=true"`,
  ] : [
    '# As the pod, not as the person. That home also holds the kubeconfig the person\'s Rancher',
    '# token was written into, and when that expires - which is the thing this whole arrangement',
    '# exists to stop mattering - every command in every conversation would start failing with',
    '# "you must be logged in to the server". An empty KUBECONFIG sends kubectl to the pod\'s own',
    '# service account, which is what is entitled to exec into a workspace anyway.',
    'KUBECONFIG=/dev/null',
    'export KUBECONFIG',
    'KARGS=',
  ]),
  '',
  '# The pane\'s own hooks stay here. claude runs its hooks through this wrapper too (they are',
  '# shell commands, and CLAUDE_CODE_SHELL_PREFIX applies to every one), but a hook is about the',
  '# pane - what claude is doing (chat-hook.mjs), the login it refreshed (claude-credentials.mjs',
  '# push) - and its scripts, its state files and its environment (MC_SESSION) are all in this',
  '# pod. Tunnelled, it found no /seed/chat-hook.mjs in the workspace and the chat never learned',
  '# claude was waiting on a question.',
  'case "$1" in',
  '  *"/seed/chat-hook.mjs"*|*"/seed/claude-credentials.mjs"*) exec /bin/sh -c "$1" ;;',
  'esac',
  '',
  '# Where claude is working. `pwd` rather than $PWD: this is run as a program, not from a',
  '# shell, so PWD is whatever the pane exported and pwd is the truth. A command run from',
  '# somewhere the workspace does not have - the agent pod\'s own home - lands in the checkout.',
  'DIR=$(pwd)',
  'case "$DIR" in',
  '  "$WS"|"$WS"/*) ;;',
  '  *) DIR=$WS/dashboard ;;',
  'esac',
  '',
  '# One level of quoting, and the command is never part of it: it arrives as an argument and',
  '# is run by `eval "$1"`, so an apostrophe or a here-document in it is just text.',
  '#',
  '# PATH is spelled out rather than left to a profile: this is a non-interactive login shell,',
  '# which reads ~/.profile and not ~/.bashrc, and the workspace\'s own commands - a11y, gh,',
  '# wait-for-sidecars, rancher-login.mjs - live in its bin.',
  'exec kubectl $KARGS exec -i -n "$NS" "deploy/$NS" -c workspace -- \\',
  '  setpriv --reuid=1000 --regid=1000 --init-groups \\',
  '  /usr/bin/env HOME="$WS/.home" WSD="$WS" DIR="$DIR" \\',
  '  /bin/bash -lc \'cd "$DIR" 2>/dev/null || cd "$WSD/dashboard" || exit 1; PATH="$WSD/bin:$WSD/.home/.local/bin:$PATH"; set -a; [ -f "$WSD/.env" ] && . "$WSD/.env"; set +a; eval "$1"\' bash "$1"',
  '',
].join('\n');

fs.mkdirSync(BIN, { recursive: true });
fs.writeFileSync(path.join(BIN, 'dev-shell'), wrapper);
fs.chmodSync(path.join(BIN, 'dev-shell'), 0o755);
written++;

// The supervised dev server, as a command: what it runs against, pointing it elsewhere, its
// log. This is what an agent has instead of a server of its own. The pod's serve.sh
// (apps.ts, WORKSPACE_SERVE) restarts its server when the retarget file this writes changes,
// and stands down while any other server runs - two webpacks are more than the pod's memory,
// and the OOM kill that follows takes the container, and every command of the conversation
// that started the second one, with it.
const devServer = [
  '#!/bin/bash',
  '# The dev server of this workspace, which its pod keeps running. Written by the seed; see layout.mjs.',
  '#',
  '#   dev-server status        what is running, on which port, against which Rancher',
  '#   dev-server stop          stop it and keep it stopped (frees ~2 GB; nothing restarts it)',
  '#   dev-server start         let it run again after a stop',
  '#   dev-server --api URL     point the server at another Rancher (it restarts: 1-3 minutes)',
  '#   dev-server reset         back to the Rancher the pod was given',
  '#   dev-server restart       restart it as it is (also stops any second server in the pod)',
  '#   dev-server logs [N]      the last N lines of its output (default 60)',
  '#',
  '# Never start a second dev server: two of them exceed the pod\'s memory and the container is',
  '# killed under both, along with every command you are running in it.',
  `WS=\${WSD:-${ ROOT }}`,
  '# In a leased workspace the dev server is not in this pod at all: it is a tool with a pod and',
  '# a lease of its own, so there is no process here to look for and no pause file to write. Every',
  '# verb hands over to `tools`, which means a skill written for the all-in-one workspace still',
  '# does the right thing here without knowing which kind it is in.',
  'case "${WS##*/}" in lte-*)',
  '  T="$(dirname "$0")/tools"',
  '  [ -x "$T" ] || T=tools',
  '  case "${1:-status}" in',
  '    status|"") exec "$T" list ;;',
  '    stop) exec "$T" stop dev-server ;;',
  '    start) exec "$T" start dev-server ;;',
  '    restart) "$T" stop dev-server >/dev/null 2>&1; exec "$T" start dev-server ;;',
  '    logs) exec "$T" logs dev-server "${2:-60}" ;;',
  '    --api|api) exec "$T" target dev-server "$2" ;;',
  '    reset) exec "$T" start dev-server ;;',
  '    *) exec "$T" list ;;',
  '  esac ;;',
  'esac',
  'PORT=$(cat "$WS/.dev-server.port" 2>/dev/null || echo 8005)',
  'RETARGET=$WS/.dev-server.env',
  'PAUSED=$WS/.dev-server.off',
  'LOG=$WS/.dev-server.log',
  'servers() { pgrep -f "^[^ ]*node .*vue-cli-service serve" 2>/dev/null; }',
  'envof() { tr "\\0" "\\n" < "/proc/$1/environ" 2>/dev/null | grep "^$2=" | cut -d= -f2-; }',
  'portof() { ss -ltnp 2>/dev/null | grep "pid=$1," | awk \'{print $4}\' | sed "s/.*://" | head -1; }',
  'ready() { curl -sk -m 5 -o /dev/null "https://localhost:$PORT/" 2>/dev/null || curl -s -m 5 -o /dev/null "http://localhost:$PORT/" 2>/dev/null; }',
  'status() {',
  '  local any="" p',
  '  for p in $(servers); do any=1; echo "dev server pid $p, port ${PORT_OF:-$(portof "$p")}: API=$(envof "$p" API) RANCHER_URL=$(envof "$p" RANCHER_URL)"; done',
  '  [ -n "$any" ] || echo "no dev server is running right now; the pod restarts it on its own (dev-server logs)"',
  '  if ready; then echo "https://localhost:$PORT answers"; else echo "https://localhost:$PORT does not answer yet"; fi',
  '  [ -f "$PAUSED" ] && echo "stopped on purpose: $PAUSED is there, so the pod will not start one (dev-server start)"',
  '  [ -f "$RETARGET" ] && echo "retargeted by dev-server --api: $(tr "\\n" " " < "$RETARGET")"',
  '  return 0',
  '}',
  '# Until a server other than the ones running before has come up and the port answers.',
  'wait_new() {',
  '  local before=" $(echo $1) " i p fresh',
  '  for i in $(seq 1 72); do',
  '    sleep 5',
  '    fresh=""',
  '    for p in $(servers); do case "$before" in *" $p "*) ;; *) fresh=1 ;; esac; done',
  '    if [ -n "$fresh" ] && ready; then status; return 0; fi',
  '    [ $(( i % 6 )) -eq 0 ] && echo "still compiling ($(( i * 5 ))s)..."',
  '  done',
  '  echo "the dev server did not answer within 6 minutes; see dev-server logs" >&2',
  '  status',
  '  return 1',
  '}',
  'case "${1:-status}" in',
  '  status) status ;;',
  // Stopped on purpose, and the pod's supervisor honours it: it reads this file and stands
  // down. A workspace under review serves nothing, and a webpack holding two gigabytes for
  // nobody is the most expensive idle thing on the node.
  '  stop)',
  '    : > "$PAUSED"',
  '    for p in $(servers); do kill -TERM -- "-$(ps -o pgid= -p "$p" | tr -d " ")" 2>/dev/null || kill -TERM "$p" 2>/dev/null; done',
  '    sleep 2',
  '    [ -z "$(servers)" ] && echo "the dev server is stopped and will stay stopped (dev-server start to bring it back)" || echo "asked it to stop; the supervisor takes it down within ten seconds"',
  '    ;;',
  '  start)',
  '    rm -f "$PAUSED"',
  '    echo "the dev server may run again; the pod starts it within ten seconds (1-3 minutes to compile)"',
  '    ;;',
  '  logs) tail -n "${2:-60}" "$LOG" 2>/dev/null | sed "s/\\x1b\\[[0-9;]*[A-Za-z]//g; s/\\x1b\\[[0-9;]*[A-Za-z]//g" | grep -v "^[[:space:]]*$" ;;',
  '  --api|api)',
  '    U=${2%/}',
  '    case "$U" in http://*|https://*) ;; *) echo "usage: dev-server --api https://rancher.example.com" >&2; exit 2 ;; esac',
  '    before=$(servers)',
  '    printf "API=%s\\nRANCHER_URL=%s\\n" "$U" "$U" > "$RETARGET"',
  '    echo "pointing the dev server at $U; it restarts and compiles again (1-3 minutes)"',
  '    wait_new "$before" ;;',
  '  reset)',
  '    before=$(servers)',
  '    rm -f "$RETARGET"',
  '    echo "back to the pod\'s own Rancher; the dev server restarts (1-3 minutes)"',
  '    wait_new "$before" ;;',
  '  restart)',
  '    before=$(servers)',
  '    for p in $before; do kill -TERM -- "-$(ps -o pgid= -p "$p" | tr -d " ")" 2>/dev/null || kill -TERM "$p" 2>/dev/null; done',
  '    echo "stopped; the pod starts the dev server again (1-3 minutes)"',
  '    wait_new "$before" ;;',
  '  *) sed -n "2,9p" "$0" ;;',
  'esac',
  '',
].join('\n');

fs.writeFileSync(path.join(BIN, 'dev-server'), devServer);
fs.chmodSync(path.join(BIN, 'dev-server'), 0o755);
written++;

// The tools a leased workspace attaches, as a command.
//
// A leased workspace (`lte-`) holds the work and the command-line tools and runs nothing: a dev
// server, a storybook, a Rancher to test against and a browser are each a thing with a pod (or,
// for the browser, a context on the shared one) that is started when the work needs it and
// released when it does not. Every verb here is one call to dev-api, which is also what the
// button on the workspace page calls - so a tool attached from a conversation shows up on the
// page, and one released on the page is gone here.
//
// The lease is the part that matters. Nothing here has to be released by hand for the node to
// get its memory back: dev-api sweeps a tool whose lease has run out, and takes every tool with
// the workspace when the workspace goes. Releasing is simply the polite version, and it is
// worth doing, because the sweep's patience is an hour and a half.
const tools = [
  '#!/bin/bash',
  '# The tools this workspace can attach. Written by the seed; see layout.mjs.',
  '#',
  '#   tools                    what is attached, and how long each lease has left',
  '#   tools start <kind>       attach one: dev-server, browser, storybook, rancher',
  '#   tools stop <kind>        give it back now (everything it holds goes with it)',
  '#   tools renew <kind>       another lease, for work that is not finished',
  '#   tools url <kind>         where it answers, for curl or the browser',
  '#   tools logs <kind> [N]    the last N lines from its pod (default 60)',
  '#',
  '# Attach a tool when you need it and release it when you are done. A dev server is two',
  '# gigabytes and every core it can get; a Rancher is another two. They are leased, so nothing',
  '# is lost if you forget - but until the lease runs out, the node is carrying it for nobody.',
  'set -o pipefail',
  'API=${CLAUDE_HARNESS_API:-${HARNESS_API:-http://dev-api.dev-system.svc:8080}}',
  `WS=\${PROJECT_NAME:-\${HARNESS_PROJECT:-$(basename "\${WSD:-${ ROOT }}")}}`,
  'KIND=$2',
  'case "$KIND" in devserver|dev|server) KIND=dev-server ;; esac',
  // node rather than jq: jq arrives with the toolbelt a minute or two into the pod's life, node
  // is the image. One formatter, fed the API's own JSON.
  'fmt() {',
  '  node -e \'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{',
  '    let j; try { j = JSON.parse(s); } catch { console.error(s.slice(0,400)); process.exit(1); }',
  '    if (j.error) { console.error(j.error); process.exit(1); }',
  '    const rows = j.tools || [j];',
  '    const left = (t) => { const ms = Date.parse(t.expires||"") - Date.now(); return Number.isFinite(ms) ? (ms<=0?"lease over":(ms<3600000?`${Math.round(ms/60000)}m left`:`${Math.round(ms/3600000)}h left`)) : ""; };',
  '    for (const t of rows.sort((a,b)=>a.kind.localeCompare(b.kind))) {',
  '      if (!t.running) { console.log(`${t.kind.padEnd(11)} not attached`); continue; }',
  '      const what = t.kind === "browser" ? "attached" : (t.ready ? "ready" : (t.detail || "starting"));',
  '      console.log(`${t.kind.padEnd(11)} ${what}${left(t)?`, ${left(t)}`:""}${t.url?`  ${t.url}`:""}`);',
  '    }',
  '  })\'',
  '}',
  'req() { curl -fsS -m 120 -X "$1" -H "content-type: application/json" ${3:+-d "$3"} "$API$2"; }',
  'need_kind() { case "$KIND" in dev-server|browser|storybook|rancher) ;; *) echo "which tool? dev-server, browser, storybook or rancher" >&2; exit 2 ;; esac; }',
  'case "${1:-list}" in',
  '  list|status|ls) req GET "/tools/$WS" | fmt ;;',
  '  start|attach|up)',
  '    need_kind',
  '    req POST "/tools/$WS/$KIND" "{\\"minutes\\":${3:-90}}" | fmt || exit 1',
  '    [ "$KIND" = dev-server ] && echo "it compiles for a minute or two before it answers; tools list says when it is ready"',
  '    exit 0 ;;',
  '  stop|release|down) need_kind; req DELETE "/tools/$WS/$KIND" >/dev/null && echo "$KIND released" ;;',
  '  renew|extend) need_kind; req POST "/tools/$WS/$KIND/renew" "{\\"minutes\\":${3:-90}}" | fmt ;;',
  // Re-attaching with a value is how a tool is changed: dev-api renders the App again, the
  // Deployment takes the new env and the pod comes back on it. Same call, one more field.
  '  target|--api)',
  '    need_kind',
  '    U=${3%/}',
  '    case "$U" in http://*|https://*) ;; *) echo "usage: tools target dev-server https://rancher.example.com" >&2; exit 2 ;; esac',
  '    req POST "/tools/$WS/$KIND" "{\\"minutes\\":90,\\"values\\":{\\"rancherUrl\\":\\"$U\\"}}" | fmt || exit 1',
  '    echo "pointed at $U; it restarts and compiles again (1-3 minutes)"',
  '    exit 0 ;;',
  '  url) need_kind; req GET "/tools/$WS/$KIND" | node -e \'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=JSON.parse(s);if(!t.running){console.error(`the ${t.kind} tool is not attached (tools start ${t.kind})`);process.exit(1);}console.log(t.url||t.cdp||"");})\' ;;',
  '  logs)',
  '    need_kind',
  '    kubectl logs -n "dev-$WS-$KIND" "deploy/dev-$WS-$KIND" --tail="${3:-60}" 2>&1 | sed "s/\\x1b\\[[0-9;]*[A-Za-z]//g" ;;',
  '  *) sed -n "2,12p" "$0" ;;',
  'esac',
  '',
].join('\n');

fs.writeFileSync(path.join(BIN, 'tools'), tools);
fs.chmodSync(path.join(BIN, 'tools'), 0o755);
written++;

// The same commands in the pane's own bin, which is the one on every pane's PATH.
fs.mkdirSync(path.join(HOME, '.local', 'bin'), { recursive: true });
for (const name of fs.readdirSync(BIN)) {
  const link = path.join(HOME, '.local', 'bin', name);

  try {
    fs.unlinkSync(link);
  } catch { /* was not there */ }
  try {
    fs.symlinkSync(path.join(BIN, name), link);
  } catch { /* a real file of that name stays */ }
}

console.log(`${ written } files laid out for ${ ctx.projectName }`);
