// Asking a workspace's pod less often: the two small helpers as they are, and what is wired to them.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { everyWhileShown, sharedRead } from '../read-pacing.mjs';

const PKG = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (file) => fs.readFileSync(path.join(PKG, file), 'utf8');

test('two asks while a read runs are one read, and the slower caller is not made to wait longer', async() => {
  let runs = 0;
  let land;
  const ask = sharedRead(() => {
    runs++;

    return new Promise((resolve) => {
      land = resolve;
    });
  }, 1000);
  const first = ask('w');

  await Promise.resolve();

  const second = ask('w');

  await new Promise((resolve) => setImmediate(resolve));
  land('branch');
  assert.deepEqual(await Promise.all([first, second]), ['branch', 'branch']);
  assert.equal(runs, 1);
});

test('the memo counts from the landing, lasts its window, and is per key', async() => {
  mock.timers.enable({ apis: ['Date'], now: 1000 });
  try {
    let runs = 0;
    const ask = sharedRead(async(key) => {
      runs++;
      // A read that takes longer than the window does not use the window up.
      mock.timers.tick(5000);

      return `${ key }${ runs }`;
    }, 1000);

    assert.equal(await ask('a'), 'a1');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await ask('a'), 'a1');
    mock.timers.tick(999);
    assert.equal(await ask('a'), 'a1');
    assert.equal(await ask('b'), 'b2');
    await new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(1000);
    assert.equal(await ask('a'), 'a3');
  } finally {
    mock.timers.reset();
  }
});

test('a failure is not remembered, and neither is what was forgotten', async() => {
  let runs = 0;
  const ask = sharedRead(async() => {
    runs++;
    if (runs === 1) {
      throw new Error('the pod was busy');
    }

    return runs;
  }, 60_000);

  await assert.rejects(ask('w'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await ask('w'), 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await ask('w'), 2);
  ask.forget('w');
  assert.equal(await ask('w'), 3);
});

function fakeDocument() {
  const listeners = new Set();

  return {
    visibilityState: 'visible',
    addEventListener:    (_, fn) => listeners.add(fn),
    removeEventListener: (_, fn) => listeners.delete(fn),
    change(state) {
      this.visibilityState = state;
      listeners.forEach((fn) => fn());
    },
    listeners,
  };
}

test('the beat runs while shown, rests while hidden, and catches up once on return', () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });
  try {
    const doc = fakeDocument();
    let runs = 0;
    const stop = everyWhileShown(() => runs++, 60_000, doc);

    mock.timers.tick(60_000);
    assert.equal(runs, 1, 'a beat while shown');

    doc.change('hidden');
    mock.timers.tick(10 * 60_000);
    assert.equal(runs, 1, 'nothing for ten minutes hidden');

    doc.change('visible');
    assert.equal(runs, 2, 'one read on return');
    mock.timers.tick(59_999);
    assert.equal(runs, 2, 'and the beat started over, so no second read straight after it');
    mock.timers.tick(1);
    assert.equal(runs, 3);

    doc.change('hidden');
    mock.timers.tick(10_000);
    doc.change('visible');
    assert.equal(runs, 3, 'back within the beat: nothing is owed');
    mock.timers.tick(50_000);
    assert.equal(runs, 4, 'and the beat is where it was');

    stop();
    mock.timers.tick(10 * 60_000);
    doc.change('hidden');
    doc.change('visible');
    assert.equal(runs, 4, 'stopped means stopped');
    assert.equal(doc.listeners.size, 0);
  } finally {
    mock.timers.reset();
  }
});

test('the wiring: the branch read is shared and the beats that exec rest when hidden', () => {
  const rail = source('components/WorkspaceRail.vue');
  const railReads = source('workspace-rail.ts');

  assert.match(railReads, /const readBranch[^=]*= sharedRead\(readBranchNow, BRANCH_FRESH_MS\)/);
  assert.match(railReads, /tried\('branch', readBranch\(workspace\)\)/);
  assert.doesNotMatch(rail, /setInterval\(\(\) => this\.refreshEvidence/);
  assert.match(rail, /everyWhileShown\(\(\) => this\.refreshEvidence\(\), EVIDENCE_MS\)/);
  assert.match(rail, /stopEvidenceBeat\?\.\(\)/);
  // An agent that has just stopped may have just committed, and the column should see it.
  assert.match(rail, /next\.agent !== 'working'\) \{\s+forgetBranch\(this\.workspace\.name\)/);

  assert.match(source('components/WorkspaceShare.vue'), /everyWhileShown\(\(\) => this\.refresh\(\), REFRESH_MS\)/);
  assert.match(source('components/WorkspaceReview.vue'), /everyWhileShown\(\(\) => refresh\(\), REFRESH_MS\)/);
  assert.match(source('pages/WorkspaceDetail.vue'), /visibilityState !== 'hidden' && Date\.now\(\) - this\.devPausedAt/);
});

test('the wiring: the dev server is read once as tools arrive, and the rail shares that read', () => {
  const tools = source('components/WorkspaceTools.vue');
  const watcher = tools.slice(tools.indexOf('this.stopTools = watch('), tools.indexOf('{ every: 20000 }'));

  assert.doesNotMatch(watcher, /readOwn/);
  assert.match(tools, /Promise\.all\(\[this\.read\(\), this\.readShares\(\), this\.readOwn\(\)\]\)/);
  assert.match(source('workspace-tools.ts'), /const DEV_SERVER_FRESH_MS = 10_000;/);
  assert.match(source('components/WorkspaceRail.vue'), /this\.devServer = await devServerState\(this\.workspace\.name\)/);
});

test('a rebuild is published whether or not the page is on show', () => {
  const share = source('components/WorkspaceShare.vue');
  const follow = share.slice(share.indexOf('refetchWhenBuilt(kind, hostedOn) {'), share.indexOf('async remove(kind, done)'));

  assert.match(follow, /rebuildPreview\(/);
  assert.doesNotMatch(follow, /visibilityState|everyWhileShown/);
});

test('the conversations strip\'s + checks the workspace before it starts anything, like the rail\'s', () => {
  for (const file of ['components/WorkspaceConversations.vue', 'components/WorkspaceRail.vue']) {
    const text = source(file);
    const start = text.slice(text.indexOf('async newConversation('));

    assert.ok(start.indexOf('await ensureWorkspaceReady(this.workspace.name)') > -1, file);
    assert.ok(start.indexOf('await ensureWorkspaceReady(this.workspace.name)') < start.indexOf('startConversation('), file);
  }
});
