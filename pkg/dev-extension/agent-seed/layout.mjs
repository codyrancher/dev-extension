// Lay the seed out in a workspace, the way the harness's template engine laid its files out in
// a project container. Run in the workspace pod as the pane's user, after the seed document
// was fetched to /tmp (see workspace-tools.ts, ensureSeed, which is what runs this).
//
//   DEV_PROJECT=pr-18840 DEV_PR=18840 DEV_SEED_FILE=/tmp/dev-seed.json node layout.mjs
//
// `.hbs` files are rendered with the workspace's name and its issue or PR number, exactly the
// variables the harness rendered them with; everything else is copied as it is. Skills, rules
// and settings go beside the checkout and beside /workspace, CLAUDE.md goes to /workspace with
// the environment's own section appended, browser.mjs and axtree.mjs to /workspace and the
// rest of bin/ to /workspace/bin.
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
const WORKDIR = process.env.DEV_WORKDIR || '/workspace/dashboard';
const HOME = process.env.DEV_HOME || '/workspace/.home';
const BIN = '/workspace/bin';
const roots = ['/workspace', WORKDIR];

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
    dests = ['/workspace/CLAUDE.md'];
    text = `${ text.trimEnd() }\n\n${ render(seed['CLAUDE.dev.md'] || '') }`;
  } else if (rel === 'bin/browser.mjs' || rel === 'bin/axtree.mjs') {
    dests = [path.join('/workspace', path.basename(rel))];
  } else if (rel.startsWith('bin/')) {
    dests = [path.join('/workspace', out)];
  } else {
    continue;
  }

  for (const dest of dests) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text);
    if (rel.startsWith('bin/') || dest.endsWith('.mjs')) {
      fs.chmodSync(dest, 0o755);
    }
    written++;
  }
}

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
