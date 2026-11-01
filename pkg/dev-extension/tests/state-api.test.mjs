// The pod's state service, run for real against a stub seed: every route's validation, the two
// answer bugs that sent reads back to exec, and the scripts shared with the browser's exec path.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  commandsScript, earlierScript, optionsHelpScript, optionsScript, optionsStateScript,
  originsScript, thinkingScript
} from '../agent-reads.mjs';

const PKG = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'a'.repeat(64);
const PORT = 18000 + (process.pid % 2000);

let dir;
let seed;
let home;
let child;

function write(file, text, mode = 0o755) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  fs.chmodSync(file, mode);
}

async function ask(url, token = TOKEN) {
  const resp = await fetch(`http://127.0.0.1:${ PORT }${ url }`, { headers: { 'x-state-token': token } });

  return { status: resp.status, version: resp.headers.get('x-state-api'), answer: await resp.json() };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

before(async() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-api-'));
  fs.chmodSync(dir, 0o755);
  seed = path.join(dir, 'seed');
  home = path.join(dir, 'home');
  fs.mkdirSync(seed);
  // Laid out the way /seed is: flat, with the shared modules beside the service.
  fs.copyFileSync(path.join(PKG, 'seed/agent/state-api.mjs'), path.join(seed, 'state-api.mjs'));
  fs.copyFileSync(path.join(PKG, 'agent-reads.mjs'), path.join(seed, 'agent-reads.mjs'));
  fs.copyFileSync(path.join(PKG, 'chat-read.mjs'), path.join(seed, 'chat-read.mjs'));
  // A list that records each run, says nothing for `empty`, fails for `broken`, hangs for `slow`.
  write(path.join(seed, 'sessions.sh'), [
    '#!/bin/sh',
    `echo run >> ${ dir }/runs-$2`,
    'case "$2" in empty*) exit 0;; broken) [ -f "$0.ok" ] || exit 1;; fails) exit 1;; slow) sleep 30;; esac',
    'echo "listing $1 $2"',
  ].join('\n'));
  write(path.join(home, '.local/bin/claude'), '#!/bin/sh\necho "Usage: claude --model <m> stub help"\n');
  write(path.join(home, '.claude/settings.json'), '{"model":"m1","alwaysThinkingEnabled":false}', 0o644);
  write(path.join(home, '.claude/commands/hello.md'), 'hi', 0o644);
  write(path.join(dir, 'token'), TOKEN, 0o600);
  execFileSync('chmod', ['-R', 'a+rX', home]);

  child = spawn(process.execPath, [path.join(seed, 'state-api.mjs')], {
    env: {
      ...process.env,
      STATE_API_PORT:       String(PORT),
      STATE_API_SEED:       seed,
      STATE_API_TOKEN_FILE: path.join(dir, 'token'),
      STATE_API_AGED_MS:    '300',
      STATE_API_WAIT_MS:    '2500',
    },
    stdio: 'ignore',
  });

  for (let i = 0; i < 100; i++) {
    try {
      await ask('/healthz');
      break;
    } catch {
      await sleep(100);
    }
  }
});

after(() => {
  child?.kill('SIGKILL');
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ── The two bugs ─────────────────────────────────────────────────────────────────────────── */

test('a script that succeeded with nothing to say has answered, and that is not refused', async() => {
  const { answer } = await ask('/project-sessions?project=empty');

  assert.equal(answer.ok, true);
  assert.equal(answer.text, '');
  assert.equal(answer.age >= 0, true);
});

test('an empty answer is coalesced like any other, not run again for every ask', async() => {
  await ask('/project-sessions?project=empty2');
  await ask('/project-sessions?project=empty2');
  await ask('/project-sessions?project=empty2');
  assert.equal(fs.readFileSync(path.join(dir, 'runs-empty2'), 'utf8').trim().split('\n').length, 1);
});

test('an answer nobody asked about for a while is refreshed before it is handed back', async() => {
  const first = await ask('/project-sessions?project=idle');

  assert.equal(first.answer.ok, true);
  // Past FRESH_MS, which is what makes it refresh at all, as well as past the test's AGED_MS.
  await sleep(2700);

  const second = await ask('/project-sessions?project=idle');

  assert.ok(second.answer.age < 300, `age ${ second.answer.age } would be refused by a browser`);
});

test('a script that was working and is now failing still answers at once, with its age', async() => {
  write(path.join(seed, 'sessions.sh.ok'), '');
  assert.equal((await ask('/project-sessions?project=broken')).answer.ok, true);
  fs.rmSync(path.join(seed, 'sessions.sh.ok'));
  await sleep(2700);
  await ask('/project-sessions?project=broken'); // notices the failure
  await sleep(100);

  const started = Date.now();
  const { answer } = await ask('/project-sessions?project=broken');

  assert.ok(Date.now() - started < 1000, 'not waited for');
  assert.equal(answer.ok, true);
  assert.equal(answer.stale, true);
  assert.ok(answer.age > 300, 'and the browser can see how old it is');
});

test('a read that fails from the start has no answer, so the browser uses exec', async() => {
  const { answer } = await ask('/project-sessions?project=fails');

  assert.equal(answer.ok, false);
  assert.equal(answer.text, '');
});

test('a slow first read is given up on inside the browser\'s clock, not at its end', async() => {
  const started = Date.now();
  const { answer } = await ask('/project-sessions?project=slow');

  assert.equal(answer.ok, false);
  assert.ok(Date.now() - started < 4000, 'bounded by the wait');
});

/* ── What a route accepts ─────────────────────────────────────────────────────────────────── */

const HOSTILE = ['$(touch /tmp/pwned)', '`id`', 'a;b', 'a b', '../..', 'a\nb', 'a|b', "a'b", 'a"b', ''];

for (const route of ['/options?home=', '/commands?home=', '/thinking?home=']) {
  test(`${ route } refuses anything that is not plainly a value`, async() => {
    for (const value of HOSTILE) {
      const { status, answer } = await ask(`${ route }${ encodeURIComponent(value) }`);

      assert.equal(status, 200, 'a refusal, not a route the browser would restart over');
      assert.equal(answer.ok, false, value);
      assert.equal(answer.text, '');
    }
  });
}

test('/options and friends refuse a home that walks upwards, though every character is allowed', async() => {
  for (const route of ['/options', '/commands', '/thinking']) {
    assert.equal((await ask(`${ route }?home=/workspace/../etc`)).answer.ok, false);
  }
});

test('/earlier checks each of its arguments', async() => {
  const good = {
    file: `${ home }/x.jsonl`, start: '10', n: 'abcd1234', home,
  };
  const bad = [
    { file: '/etc/passwd' },
    { file: '/a/../b.jsonl' },
    { file: '/a/$(id).jsonl' },
    { file: '' },
    { start: '-1' },
    { start: '1.5' },
    { start: 'x' },
    { start: '1;id' },
    { n: 'A B' },
    { n: '' },
    { home: '/a/../b' },
  ];

  for (const over of bad) {
    const { answer } = await ask(`/earlier?${ new URLSearchParams({ ...good, ...over }) }`);

    assert.equal(answer.ok, false, JSON.stringify(over));
  }
  const missing = new URLSearchParams(good);

  missing.delete('start');
  assert.equal((await ask(`/earlier?${ missing }`)).answer.ok, false);
});

test('a new route needs the token like every other', async() => {
  for (const route of ['/options?home=/a', '/commands?home=/a', '/thinking?home=/a', '/origins', '/earlier']) {
    assert.equal((await ask(route, 'wrong')).status, 401, route);
  }
});

test('the version did not move: adding a path is not a change of shape', async() => {
  assert.equal((await ask('/healthz')).version, '3');
  assert.match(fs.readFileSync(path.join(PKG, 'pod-state.ts'), 'utf8'), /const WANT_VERSION = 3;/);
});

/* ── The same bytes as the exec path ──────────────────────────────────────────────────────── */

function bash(script, env = {}) {
  return execFileSync('/bin/bash', ['-c', script], {
    encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'ignore'],
  });
}

test('git on a workspace\'s tree is not served from the agent pod', () => {
  const service = fs.readFileSync(path.join(PKG, 'seed/agent/state-api.mjs'), 'utf8');
  const reads = fs.readFileSync(path.join(PKG, 'agent-reads.mjs'), 'utf8');
  const rail = fs.readFileSync(path.join(PKG, 'workspace-rail.ts'), 'utf8');

  // The tree's own .home/.local/bin, clean filters and gpg.program all ran here, on a page view.
  assert.doesNotMatch(service, /'\/branch'/);
  assert.doesNotMatch(reads, /\bgit (log|diff|merge-base|rev-parse)\b/);
  assert.doesNotMatch(rail, /podStateText/);
  assert.match(rail, /await readInWorkspace\(workspace, script\)/);
});

test('nothing streamed runs a one-off read every couple of seconds', () => {
  const client = fs.readFileSync(path.join(PKG, 'pod-state.ts'), 'utf8');
  const feedName = client.slice(client.indexOf('function feedName('), client.indexOf('function feedOf('));

  assert.doesNotMatch(feedName, /options|commands|thinking|earlier|origins/);
});

test('/options answers what readOptions\' exec answers, with the help kept and the rest fresh', async() => {
  const exec = bash(optionsScript(), { HOME: home, PATH: `${ home }/.local/bin:${ process.env.PATH }`, ANTHROPIC_MODEL: '' });
  const url = `/options?${ new URLSearchParams({ home }) }`;
  const { answer } = await ask(url);

  assert.equal(answer.ok, true, answer.error);
  assert.equal(answer.text.replace(/@@ENV\n[\s\S]*?@@FILES/, ''), exec.replace(/@@ENV\n[\s\S]*?@@FILES/, ''));
  assert.match(answer.text, /^@@HELP\nUsage: claude/);
  assert.match(answer.text, /@@FILES\nm1\n/);

  // A change of model is seen at once, and claude is not asked again to see it.
  write(path.join(home, '.claude/settings.json'), '{"model":"m2"}', 0o644);
  write(path.join(home, '.local/bin/claude'), '#!/bin/sh\necho "changed help"\n');

  const again = (await ask(url)).answer.text;

  assert.match(again, /@@FILES\nm2\n/);
  assert.match(again, /Usage: claude/);
  write(path.join(home, '.claude/settings.json'), '{"model":"m1","alwaysThinkingEnabled":false}', 0o644);
});

test('/options refuses when claude says nothing, rather than remembering that for ten minutes', async() => {
  const silent = path.join(dir, 'silent');

  write(path.join(silent, '.local/bin/claude'), '#!/bin/sh\nexit 0\n');
  execFileSync('chmod', ['-R', 'a+rX', silent]);
  const url = `/options?${ new URLSearchParams({ home: silent }) }`;

  assert.equal((await ask(url)).answer.ok, false);
  write(path.join(silent, '.local/bin/claude'), '#!/bin/sh\necho later\n');
  assert.match((await ask(url)).answer.text, /later/);
});

test('/thinking and /commands answer what their scripts answer', async() => {
  const q = new URLSearchParams({ home });

  assert.equal((await ask(`/thinking?${ q }`)).answer.text, bash(thinkingScript(), { HOME: home }));
  const commands = (await ask(`/commands?${ q }`)).answer.text;

  assert.match(commands, /^CMD .*\/commands\/hello\.md$/m);
  assert.match(commands, /@@END\n$/);
});

test('/commands says @@END with nothing to list, so an empty list is told from no read', async() => {
  const empty = path.join(dir, 'nothing');

  fs.mkdirSync(empty);
  fs.chmodSync(empty, 0o755);
  const { answer } = await ask(`/commands?${ new URLSearchParams({ home: empty }) }`);

  assert.equal(answer.ok, true);
  assert.equal(answer.text, '@@END\n');
});

test('/earlier returns the page before the offset, framed as the exec read frames it', async() => {
  const file = path.join(home, 'x.jsonl');

  write(file, 'line1\nline2\nline3\n', 0o644);
  const { answer } = await ask(`/earlier?${ new URLSearchParams({
    file, start: '12', n: 'abcd1234', home,
  }) }`);

  assert.equal(answer.ok, true, answer.error);
  assert.equal(answer.text, bash(earlierScript({ file, start: 12, nonce: 'abcd1234' })));
  assert.match(answer.text, /@@FROM-abcd1234 0\n@@BACK-abcd1234\nline1\nline2\n\n@@ENDBACK-abcd1234/);
});

test('the origins script answers nothing rather than failing when there are no markers', () => {
  // /workspace/sessions does not exist under test, and an empty directory has no *.by to glob.
  assert.equal(bash(originsScript()), '');
  assert.match(originsScript(), /\/workspace\/sessions/);
});

test('/origins succeeds on a pod with no markers: an empty listing is an answer', async() => {
  const { answer } = await ask('/origins');

  assert.equal(answer.ok, true);
  assert.equal(answer.text, '');
});

test('three reads in one moment do not share a script file', async() => {
  const q = new URLSearchParams({ home });
  const answers = await Promise.all([
    ask(`/thinking?${ q }`), ask(`/thinking?${ q }`), ask(`/commands?${ q }`), ask(`/commands?${ q }`), ask(`/thinking?${ q }`),
  ]);

  for (const { answer } of answers) {
    assert.equal(answer.ok, true);
    assert.notEqual(answer.text, '');
  }
});

/* ── The stream ───────────────────────────────────────────────────────────────────────────── */

test('the stream pushes a name, says when it does not know one, and an empty answer is ok', async() => {
  const stop = new AbortController();
  const resp = await fetch(`http://127.0.0.1:${ PORT }/stream?watch=sessions:streamed,sessions:empty,branch:x`, {
    headers: { 'x-state-token': TOKEN }, signal: stop.signal,
  });
  const reader = resp.body.getReader();
  const decode = new TextDecoder();
  let seen = '';

  // `"name":` because the first frame lists every name it was asked to watch.
  while (!['branch:x', 'sessions:empty', 'sessions:streamed'].every((n) => seen.includes(`"name":"${ n }"`))) {
    const { value, done } = await reader.read();

    if (done) {
      break;
    }
    seen += decode.decode(value);
  }
  stop.abort();

  const pushed = seen.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)));

  assert.equal(pushed.find((p) => p.name === 'sessions:empty').ok, true);
  assert.match(pushed.find((p) => p.name === 'sessions:streamed').text, /listing list streamed/);
  assert.equal(pushed.find((p) => p.name === 'branch:x').unknown, true);
});

/* ── The scripts are one definition ───────────────────────────────────────────────────────── */

test('the browser builds these reads from the shared module, not from copies of them', () => {
  const chat = fs.readFileSync(path.join(PKG, 'chat-conversation.ts'), 'utf8');
  const agent = fs.readFileSync(path.join(PKG, 'agent.ts'), 'utf8');

  assert.doesNotMatch(chat, /'claude --help 2>/);
  assert.doesNotMatch(chat, /for root in/);
  assert.doesNotMatch(agent, /for f in \*\.by/);
});

test('optionsScript is its two halves, which is what lets the service cache only one of them', () => {
  assert.equal(optionsScript(), `${ optionsHelpScript() }\n${ optionsStateScript() }`);
  assert.match(optionsHelpScript(), /claude --help/);
  assert.doesNotMatch(optionsStateScript(), /claude --help/);
});

test('every route has a fallback: the client only ever reads through podStateText', () => {
  const chat = fs.readFileSync(path.join(PKG, 'chat-conversation.ts'), 'utf8');

  for (const route of ['/options', '/commands', '/thinking', '/earlier']) {
    assert.ok(chat.includes(`\`${ route }?`), route);
  }
  assert.match(chat, /async function runRead[\s\S]*?PodStateUnavailable[\s\S]*?return run\(script, timeoutMs\);/);
  assert.ok(commandsScript().endsWith('echo @@END'));
});
