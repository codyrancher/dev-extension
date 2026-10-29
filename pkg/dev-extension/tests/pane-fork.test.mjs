// What a fork's shell has to do, and in what order.
//
// The order is the whole of it: the new pane's id file has to name the copy BEFORE anything
// starts that pane, or claude-session.sh opens a conversation of its own and records that
// instead - the fork then resumes the wrong history and the copy sits unread. These check the
// shape of the script rather than run it; what running it does is checked by hand in the pod.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  forkScript, forkTitle, FORK_UUID_RE, PANE_FORK_RESULTS,
} from '../pane-fork.mjs';

const UUID = '0f2b1c3d-4e5f-6071-8293-a4b5c6d7e8f9';

const claude = () => forkScript({
  sessions:   '/workspace/sessions',
  source:     'p-w-1',
  target:     'p-w-2',
  uuid:       UUID,
  projectDir: '/workspace/.home/.claude/projects/-workspaces-w-dashboard',
});

test('the copy is claimed for the new pane, and nothing starts a pane', () => {
  const lines = claude();
  const claim = lines.findIndex((l) => l.includes(`/workspace/sessions/p-w-2.id`));
  const copy = lines.findIndex((l) => l.includes(`${ UUID }.jsonl`));

  assert.ok(copy >= 0 && claim > copy, 'the transcript is copied before it is claimed');
  assert.ok(!lines.some((l) => /shell\.sh|tmux/.test(l)), 'starting the pane is the caller\'s job');
});

test('the original is only ever read', () => {
  for (const line of claude()) {
    assert.ok(!/>\s*"?\/workspace\/sessions\/p-w-1\.id/.test(line), `writes the source id file: ${ line }`);
    assert.ok(!/\brm\b|\bmv\b/.test(line), `moves or removes something: ${ line }`);
  }
});

test('every outcome the script can reach is one PANE_FORK_RESULTS names', () => {
  const said = claude().join('\n').match(/done_ (\w+)/g).map((m) => m.slice('done_ '.length));

  assert.ok(said.length > 1);
  for (const word of said) {
    assert.ok(PANE_FORK_RESULTS.includes(word), `${ word } is not in PANE_FORK_RESULTS`);
  }
  assert.ok(said.includes('FORKED'), 'there is a way for it to succeed');
});

test('the uuid is written into the copy as well as onto it', () => {
  const text = claude().join('\n');

  assert.match(text, /sessionId/, 'the copy\'s own sessionId field is rewritten');
  assert.match(text, new RegExp(`printf '%s' ${ UUID } > "/workspace/sessions/p-w-2.id"`));
});

test('the node one-liner reads its first argument as argv[1]', () => {
  // `node -e` has no script path, so argv[1] is the first argument. Getting this wrong read the
  // destination as the source, which fails as NOCOPY and looks like a permissions problem.
  assert.match(claude().join('\n'), /const \[, from, to, id\] = process\.argv;/);
});

test('an agy conversation copies its brain directory and rewrites nothing', () => {
  const lines = forkScript({
    sessions: '/workspace/sessions',
    source:   'agent-1',
    target:   'agent-2',
    uuid:     UUID,
    brain:    '/workspace/.home/.gemini/antigravity-cli/brain',
  });
  const text = lines.join('\n');

  assert.match(text, /cp -r "\/workspace\/\.home\/\.gemini\/antigravity-cli\/brain\/\$src"/);
  assert.ok(!/\.jsonl/.test(text), 'agy has no transcript file to copy');
  // `sessionId` still appears: that is the state-file fallback, which both CLIs share. What agy
  // does not do is rewrite the field, because its conversation's id is a directory name.
  assert.ok(!/row\.sessionId = id/.test(text), 'agy keeps its id in a path, not in the lines');
});

test('a conversation that has never run is reported rather than guessed at', () => {
  const text = claude().join('\n');

  // The pane's own record first, then claude's hook - the same two places, in the same order,
  // as transcriptPathOf and the chat view.
  assert.ok(text.indexOf('p-w-1.id') < text.indexOf('p-w-1.state.json'));
  assert.match(text, /\[ -n "\$src" \] \|\| done_ NOID/);
});

test('forkTitle says fork once, whatever it is forking', () => {
  assert.equal(forkTitle('review 2'), 'Fork of review 2');
  assert.equal(forkTitle('Fork of review 2'), 'Fork of review 2');
  assert.equal(forkTitle('fork of review 2'), 'Fork of review 2');
  assert.equal(forkTitle(''), 'Fork of conversation');
  assert.equal(forkTitle(null), 'Fork of conversation');
  assert.equal(forkTitle('Fork of '), 'Fork of conversation');
  assert.ok(forkTitle('x'.repeat(200)).length <= 60);
});

test('FORK_UUID_RE takes a uuid and nothing else', () => {
  assert.ok(FORK_UUID_RE.test(UUID));
  assert.ok(!FORK_UUID_RE.test(''));
  assert.ok(!FORK_UUID_RE.test('../../etc/passwd'));
  assert.ok(!FORK_UUID_RE.test(`${ UUID };rm -rf /`));
  assert.ok(!FORK_UUID_RE.test(UUID.toUpperCase()), 'lowercase, so a path means one thing');
});
