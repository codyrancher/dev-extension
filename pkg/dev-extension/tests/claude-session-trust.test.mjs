// claude-session.sh's answer_trust: claude's "Is this a project you trust?" answered yes for the
// pane's own folder - and nothing else on a pane touched. Run for real, against a fake tmux.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = fs.readFileSync(new URL('../seed/claude-session.sh', import.meta.url), 'utf8');
const FN = SCRIPT.slice(SCRIPT.indexOf('answer_trust() {'), SCRIPT.indexOf('\n}\n', SCRIPT.indexOf('answer_trust() {')) + 3);

const TRUST = [
  ' Accessing workspace:', ' /workspaces/lte-pr-1233/dashboard',
  ' Quick safety check: Is this a project you created or one you trust?',
  ' ❯ No, exit', '   Yes, I trust this folder', ' Enter to confirm · Esc to cancel',
].join('\n');
const PROMPT = ['❯ ', '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n');

function run(screen) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-'));
  const log = path.join(dir, 'keys.log');

  fs.writeFileSync(path.join(dir, 'screen.txt'), screen);
  fs.writeFileSync(path.join(dir, 'tmux'), `#!/bin/sh
case "$1" in
  capture-pane) cat "${ dir }/screen.txt" ;;
  send-keys) echo "$4" >> "${ log }" ;;
esac
`, { mode: 0o755 });
  // The real loop sleeps 2s a turn; a sleep that does not makes this a test, not a wait.
  fs.writeFileSync(path.join(dir, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const r = spawnSync('bash', ['-c', `${ FN }\nanswer_trust`], {
    env: { ...process.env, PATH: `${ dir }:${ process.env.PATH }`, TMUX_PANE: '%7' }, encoding: 'utf8', timeout: 20_000,
  });

  return { status: r.status, keys: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [] };
}

test('the trust question is answered yes: Down to it, then Enter', () => {
  const r = run(TRUST);

  assert.equal(r.status, 0);
  assert.deepEqual(r.keys, ['Down', 'Enter']);
});

test('a pane already at its prompt is left alone', () => {
  assert.deepEqual(run(PROMPT).keys, []);
});

test('any other question on the pane is not answered', () => {
  assert.deepEqual(run(' Which color?\n ❯ 1. Red\n   2. Green\n Enter to select').keys, []);
});

test('the loop trusts the folder again right before each start, and watches it', () => {
  const block = SCRIPT.slice(SCRIPT.indexOf('OPEN=()'), SCRIPT.indexOf('if [ -n "$CONVERSATION" ]; then'));

  assert.match(block, /TRUST_DIRS="\$PWD" node \/seed\/claude-defaults\.mjs/);
  assert.match(block, /answer_trust &/);
});
