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

const seed = JSON.parse(fs.readFileSync(process.env.DEV_SEED_FILE || '/tmp/dev-seed.json', 'utf8'));
const rancherUrl = process.env.API || process.env.RANCHER_URL || '';
const ctx = {
  projectName: process.env.DEV_PROJECT || '',
  issueNumber: process.env.DEV_ISSUE || '',
  prNumber:    process.env.DEV_PR || '',
  rancherUrl,
  rancherHost: rancherUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, ''),
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
  } else if (rel === 'CLAUDE.md.hbs') {
    dests = [path.join(ROOT, 'CLAUDE.md')];
    text = `${ text.trimEnd() }\n\n${ render(seed['CLAUDE.dev.md'] || '') }`;
  } else if (rel.startsWith('browser-a11y/')) {
    // The accessibility stack the *browser* container runs: AT-SPI, speech and Orca are
    // session-local, so they live over there and this side only calls them (bin/a11y). The
    // browser mounts these two directories from the same volume - `init` as its own
    // /custom-cont-init.d, so the session bus is up before Chromium starts.
    dests = [path.join(ROOT, '.a11y', rel.slice('browser-a11y/'.length) === path.basename(rel) ? 'opt' : 'init', path.basename(rel))];
  } else if (rel === 'bin/browser.mjs' || rel === 'bin/axtree.mjs') {
    dests = [path.join(ROOT, path.basename(rel))];
  } else if (rel.startsWith('bin/')) {
    dests = [path.join(ROOT, out)];
  } else {
    continue;
  }

  const body = rewriteRoot(text);

  for (const dest of dests) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body);
    if (rel.startsWith('bin/') || rel.startsWith('browser-a11y/') || dest.endsWith('.mjs')) {
      fs.chmodSync(dest, 0o755);
    }
    written++;
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
  '# As the pod, not as the person. That home also holds the kubeconfig the person\'s Rancher',
  '# token was written into, and when that expires - which is the thing this whole arrangement',
  '# exists to stop mattering - every command in every conversation would start failing with',
  '# "you must be logged in to the server". An empty KUBECONFIG sends kubectl to the pod\'s own',
  '# service account, which is what is entitled to exec into a workspace anyway.',
  'KUBECONFIG=/dev/null',
  'export KUBECONFIG',
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
  'exec kubectl exec -i -n "$NS" "deploy/$NS" -c workspace -- \\',
  '  setpriv --reuid=1000 --regid=1000 --init-groups \\',
  '  /usr/bin/env HOME="$WS/.home" WSD="$WS" DIR="$DIR" \\',
  '  /bin/bash -lc \'cd "$DIR" 2>/dev/null || cd "$WSD/dashboard" || exit 1; PATH="$WSD/bin:$WSD/.home/.local/bin:$PATH"; set -a; [ -f "$WSD/.env" ] && . "$WSD/.env"; set +a; eval "$1"\' bash "$1"',
  '',
].join('\n');

fs.mkdirSync(BIN, { recursive: true });
fs.writeFileSync(path.join(BIN, 'dev-shell'), wrapper);
fs.chmodSync(path.join(BIN, 'dev-shell'), 0o755);
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
