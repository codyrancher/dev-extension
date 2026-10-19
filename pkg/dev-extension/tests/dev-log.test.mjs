/**
 * The log, and the reads that write to it.
 *
 * `node --test pkg/dev-extension/tests/*.test.mjs`. The clock is held by the test, and the
 * console is a stub, so nothing here waits or prints.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeLog, LOG_KEEP } from '../dev-log.mjs';
import { source } from '../source-cache.mjs';

/** A clock the test moves by hand. */
function clock(start = 1_000) {
  let at = start;

  return { now: () => at, tick: (ms) => { at += ms; } };
}

/** A console that remembers instead of printing. */
function stub() {
  const warned = [];

  return { warned, warn: (...args) => warned.push(args) };
}

test('a note is kept and printed', () => {
  const out = stub();
  const log = makeLog({ now: () => 5, console: out });

  log.note('dev', 'the status of lte-issue-1 could not be read', new Error('502'));

  assert.deepEqual(log.lines(), [{
    at: 5, kind: 'note', scope: 'dev', what: 'the status of lte-issue-1 could not be read', detail: '502',
  }]);
  // Still in the browser's own log, because that is where a developer looks.
  assert.equal(out.warned.length, 1);
  assert.match(out.warned[0][0], /^\[dev\] the status/);
});

test('a read is kept and not printed', () => {
  const out = stub();
  const log = makeLog({ now: () => 7, console: out });

  log.record({
    source: 'pr-detail', key: 'rancher/dashboard#19517', ms: 240, outcome: 'read',
  });

  assert.equal(log.lines()[0].kind, 'read');
  assert.equal(out.warned.length, 0, 'a line per read would make the console unusable');
});

test('newest first, because that is the end anybody reads', () => {
  const time = clock();
  const log = makeLog({ now: time.now });

  log.note('dev', 'first');
  time.tick(10);
  log.note('dev', 'second');

  assert.deepEqual(log.lines().map((l) => l.what), ['second', 'first']);
  assert.deepEqual(log.lines(1).map((l) => l.what), ['second']);
});

test('a ring, so a page open all afternoon does not grow without end', () => {
  const log = makeLog({ keep: 3 });

  for (let i = 0; i < 10; i++) {
    log.note('dev', `line ${ i }`);
  }

  assert.equal(log.size(), 3);
  assert.deepEqual(log.lines().map((l) => l.what), ['line 9', 'line 8', 'line 7']);
  assert.equal(LOG_KEEP, 200);
});

test('a watcher sees each line, and one that throws does not lose it', () => {
  const log = makeLog();
  const seen = [];
  const stop = log.watch((line) => seen.push(line.what));

  log.watch(() => {
    throw new Error('a page that unmounted badly');
  });
  log.note('dev', 'something');

  assert.deepEqual(seen, ['something']);
  assert.equal(log.size(), 1);
  stop();
  log.note('dev', 'after');
  assert.deepEqual(seen, ['something'], 'and a watcher can stop watching');
});

test('a source writes one line per read, saying which kind it was', async() => {
  const time = clock();
  const log = makeLog({ now: time.now });
  let reads = 0;
  const read = source(async() => {
    time.tick(40);

    return ++reads;
  }, {
    name: 'pr-detail', ttl: 1_000, now: time.now, log,
  });

  await read(19517);
  await read(19517);

  assert.deepEqual(log.lines().map((l) => [l.source, l.key, l.outcome]).reverse(), [
    ['pr-detail', '[19517]', 'read'],
    ['pr-detail', '[19517]', 'kept'],
  ]);
  // How long it took is the point of logging a read that worked.
  assert.equal(log.lines(2).at(-1).ms, 40);
});

test('a read that failed says so, with why', async() => {
  const log = makeLog();
  const read = source(async() => {
    throw new Error('dev-api is restarting');
  }, { name: 'secret-store', log });

  await assert.rejects(read());

  const [line] = log.lines();

  assert.equal(line.outcome, 'failed');
  assert.equal(line.detail, 'dev-api is restarting');
});

test('an answer the source would not keep is logged as dropped, not as a read', async() => {
  const log = makeLog();
  const read = source(async() => ({}), { name: 'secret-store', keep: (got) => !!Object.keys(got).length, log });

  await read();

  assert.equal(log.lines()[0].outcome, 'dropped');
});
