// The review scripts the Automations page offers, run with sh against a dev-api that only records.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import {
  REVIEW_PR_SCRIPT, REVIEW_PR_CONDITION, REVIEW_NEW_COMMITS_SCRIPT, REVIEW_NEW_COMMITS_CONDITION, ADDRESS_FEEDBACK_SCRIPT, ADDRESS_FEEDBACK_CONDITION, withoutReviewAction,
} from '../automation-scripts.mjs';
import { actionOf } from '../dev-api/automation-rules.mjs';

const hasShell = spawnSync('sh', ['-c', 'command -v curl']).status === 0;

/** Runs `script` on `payload` against a server answering `answer`; what it printed, exited with, and was asked. */
async function run(script, payload, answer = { status: 200, body: { note: 'Started Review #7 in lte-pr-7.' } }, extraEnv = {}) {
  const asked = [];
  const server = http.createServer((req, res) => {
    let body = '';

    req.on('data', (d) => { body += d; }).on('end', () => {
      asked.push({ method: req.method, url: req.url, type: req.headers['content-type'] || '', body });
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer.body));
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-script-'));
  const file = path.join(dir, 'event.json');

  fs.writeFileSync(file, JSON.stringify({ source: payload ? 'github' : 'manual', payload: payload || {} }));
  fs.writeFileSync(path.join(dir, 'script'), script);
  const out = await new Promise((resolve) => {
    const child = spawn('sh', [path.join(dir, 'script')], {
      env: {
        ...process.env, EVENT_WORKSPACE: '', ...extraEnv, EVENT_FILE: file, DEV_API: `http://127.0.0.1:${ server.address().port }`,
      },
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });

  server.close();
  fs.rmSync(dir, { recursive: true, force: true });

  return { ...out, asked };
}

test('a definition saved with the old review action reads as the script that does it now', () => {
  const old = {
    name: 'review-when-ready', action: 'review', prompt: '', script: '', timeoutSec: 600, triggers: [{ type: 'manual' }],
  };
  const now = withoutReviewAction(old);

  assert.equal(now.action, 'script');
  assert.equal(now.script, REVIEW_PR_SCRIPT);
  assert.equal(now.timeoutSec, 1800);
  assert.deepEqual(now.triggers, old.triggers);
  assert.equal(actionOf(now), 'script');
  const agent = { name: 'a', action: 'agent', prompt: 'hi' };

  assert.equal(withoutReviewAction(agent), agent, 'anything else is left as it is');
  assert.equal(withoutReviewAction(null), null);
});

test('the review condition: asked by name, not mine, not a draft, not reviewed by me yet', () => {
  assert.deepEqual(REVIEW_PR_CONDITION.split('\n'), ['!p.draft', '!p.roles.author', 'p.roles.requested', '!p.roles.reviewer']);
});

test('review script: asks dev-api for the review, with the title, and prints its one sentence', { skip: !hasShell && 'no sh/curl' }, async() => {
  const r = await run(REVIEW_PR_SCRIPT, {
    kind: 'pr', repo: 'rancher/dashboard', number: 7, title: 'Fix "quotes" & things',
  });

  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.asked.length, 1);
  assert.equal(r.asked[0].method, 'POST');
  assert.equal(r.asked[0].url, '/my-work/pr/7/review?repo=rancher/dashboard');
  assert.equal(r.asked[0].type, 'application/json');
  assert.deepEqual(JSON.parse(r.asked[0].body), { title: 'Fix "quotes" & things' });
  assert.equal(r.stdout.trim().split('\n').pop(), 'Started Review #7 in lte-pr-7.', 'the last line is what the run shows');
});

test('review script: by hand there is no pull request, so it says how to try it and asks nothing', { skip: !hasShell && 'no sh/curl' }, async() => {
  const r = await run(REVIEW_PR_SCRIPT, null);

  assert.equal(r.code, 2);
  assert.equal(r.asked.length, 0);
  assert.match(r.stderr, /Run an automation on this/);
});

test('review script: dev-api refusing is a failed run with its answer', { skip: !hasShell && 'no sh/curl' }, async() => {
  const r = await run(REVIEW_PR_SCRIPT, { kind: 'pr', repo: 'rancher/dashboard', number: 7 }, { status: 500, body: { error: 'no pod' } });

  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /no pod/);
});

test('new-commits script: posts the head and prints the note', { skip: !hasShell && 'no sh/curl' }, async() => {
  const r = await run(REVIEW_NEW_COMMITS_SCRIPT, {
    kind: 'pr', repo: 'rancher/dashboard', number: 9, head: 'abc123', commitsSince: 2,
  }, { status: 200, body: { note: 'Resumed Review #9 in lte-pr-9.' } });

  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.asked[0].url, '/my-work/pr/9/review-again?repo=rancher/dashboard&head=abc123');
  assert.equal(r.stdout.trim().split('\n').pop(), 'Resumed Review #9 in lte-pr-9.');
});

test('address-feedback script: into the event\'s workspace, for that PR, and prints the note', { skip: !hasShell && 'no sh/curl' }, async() => {
  const r = await run(ADDRESS_FEEDBACK_SCRIPT, {
    kind: 'pr', repo: 'rancher/dashboard', number: 12, review: { state: 'changes_requested', author: 'someone' },
  }, { status: 200, body: { note: 'Sent to Fix #11 in issue-11.' } }, { EVENT_WORKSPACE: 'issue-11' });

  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.asked[0].method, 'POST');
  assert.equal(r.asked[0].url, '/workspaces/issue-11/address-feedback?pr=12&repo=rancher/dashboard');
  assert.match(r.stdout, /someone's review of rancher\/dashboard#12 in issue-11/);
  assert.equal(r.stdout.trim().split('\n').pop(), 'Sent to Fix #11 in issue-11.');
});

test('address-feedback script: no workspace is nothing to do, and says so', { skip: !hasShell && 'no sh/curl' }, async() => {
  const r = await run(ADDRESS_FEEDBACK_SCRIPT, { kind: 'pr', repo: 'rancher/dashboard', number: 12 });

  assert.equal(r.code, 2);
  assert.equal(r.asked.length, 0);
});

test('address-feedback condition: my PR, changes asked for, a workspace that holds it', () => {
  assert.deepEqual(ADDRESS_FEEDBACK_CONDITION.split('\n'), ['p.roles.author', "p.review.state === 'changes_requested'", 'workspace']);
});

test('new-commits condition: asked again by name, or my review dismissed by the push', async() => {
  const vm = await import('node:vm');
  const { conditionScope } = await import('../dev-api/automation-rules.mjs');
  const holds = (payload) => REVIEW_NEW_COMMITS_CONDITION.split('\n').every((line) => vm.runInContext(`(${ line }\n)`, vm.createContext(conditionScope({ payload }, 'me'))));
  const base = {
    draft: false, roles: { author: false, requested: false }, newCommits: true, myReview: { state: 'APPROVED' },
  };

  assert.equal(holds(base), false, 'new commits alone: nobody asked, and my approval stands');
  assert.equal(holds({ ...base, roles: { author: false, requested: true } }), true, 'asked again by name');
  assert.equal(holds({ ...base, myReview: { state: 'DISMISSED' } }), true, 'the push dismissed my review (rancher/dashboard#19811)');
  assert.equal(holds({ ...base, myReview: { state: 'DISMISSED' }, newCommits: false }), false, 'nothing new to review');
  assert.equal(holds({ ...base, myReview: null }), false, 'never reviewed it');
});
