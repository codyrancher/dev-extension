import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { branchOfHead, reflogHasCommits, branchState } from '../dev-api/branch-state.mjs';

const line = (message) => `${ 'a'.repeat(40) } ${ 'b'.repeat(40) } Agent <a@b> 1730000000 +0000\t${ message }`;

test('branchOfHead reads the branch and nothing from a detached HEAD', () => {
  assert.equal(branchOfHead('ref: refs/heads/fix-1234\n'), 'fix-1234');
  assert.equal(branchOfHead('0123456789abcdef0123456789abcdef01234567\n'), '');
  assert.equal(branchOfHead(''), '');
});

test('reflogHasCommits: a commit counts, a fast-forward does not, a reset to a remote clears', () => {
  assert.equal(reflogHasCommits([line('branch: Created from HEAD')].join('\n')), false);
  assert.equal(reflogHasCommits([line('branch: Created from HEAD'), line('commit: Fix the thing')].join('\n')), true);
  assert.equal(reflogHasCommits([line('checkout: moving'), line('commit (amend): Fix')].join('\n')), true);
  assert.equal(reflogHasCommits([line('merge upstream/master: Fast-forward')].join('\n')), false);
  assert.equal(reflogHasCommits([line('commit: Fix'), line('reset: moving to upstream/master')].join('\n')), false);
  assert.equal(reflogHasCommits([line('commit: Fix'), line('reset: moving to HEAD~1')].join('\n')), true);
  assert.equal(reflogHasCommits([line('rebase (pick): Fix')].join('\n')), true);
  assert.equal(reflogHasCommits(''), false);
});

test('branchState reads a checkout on disk, and says null where there is none', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-'));
  const git = path.join(root, 'lte-issue-1', 'dashboard', '.git');

  fs.mkdirSync(path.join(git, 'logs', 'refs', 'heads'), { recursive: true });
  fs.writeFileSync(path.join(git, 'HEAD'), 'ref: refs/heads/fix-1\n');
  assert.deepEqual(branchState(root, 'lte-issue-1', { fs, path }), { branch: 'fix-1', coded: false });
  fs.writeFileSync(path.join(git, 'logs', 'refs', 'heads', 'fix-1'), `${ line('branch: Created from HEAD') }\n${ line('commit: Fix') }\n`);
  assert.deepEqual(branchState(root, 'lte-issue-1', { fs, path }), { branch: 'fix-1', coded: true });
  assert.deepEqual(branchState(root, 'missing', { fs, path }), { branch: '', coded: null });
  assert.deepEqual(branchState(root, '../etc', { fs, path }), { branch: '', coded: null });
  fs.rmSync(root, { recursive: true, force: true });
});
