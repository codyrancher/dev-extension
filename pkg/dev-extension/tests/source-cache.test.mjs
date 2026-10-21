/**
 * The five rules the call sites had each written for themselves.
 *
 * `node --test pkg/dev-extension/tests/*.test.mjs`. The clock is injected, so none of these wait.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { source } from '../source-cache.mjs';

/** A clock the test moves by hand. */
function clock(start = 1_000) {
  let at = start;

  return { now: () => at, tick: (ms) => { at += ms; } };
}

test('calls that arrive together share one read', async() => {
  let reads = 0;
  const read = source(async() => { reads++; return 'v'; });

  const [a, b, c] = await Promise.all([read(), read(), read()]);

  assert.deepEqual([a, b, c], ['v', 'v', 'v']);
  assert.equal(reads, 1, 'the second and third callers joined the first request');
});

test('an answer is kept for its moment and no longer', async() => {
  const time = clock();
  let reads = 0;
  const read = source(async() => ++reads, { ttl: 25_000, now: time.now });

  assert.equal(await read(), 1);
  time.tick(24_000);
  assert.equal(await read(), 1, 'still inside the window');
  time.tick(2_000);
  assert.equal(await read(), 2, 'past it');
});

test('a failure is not kept, so the next caller retries', async() => {
  let reads = 0;
  const read = source(async() => {
    reads++;
    if (reads === 1) {
      throw new Error('upstream blinked');
    }

    return 'ok';
  });

  await assert.rejects(read(), /upstream blinked/);
  assert.equal(await read(), 'ok');
  assert.equal(reads, 2);
});

test('an answer that is not worth keeping is not kept', async() => {
  // The Secret store's rule: its read swallows its own failure and answers {}, and remembering
  // that pins "no token is set", which looks like a finished setup rather than a fault.
  let reads = 0;
  const answers = [{}, { github: 'x' }];
  const read = source(async() => answers[reads++] ?? {}, { keep: (got) => !!Object.keys(got).length });

  assert.deepEqual(await read(), {});
  assert.equal(read.size(), 0, 'the empty answer was dropped');
  assert.deepEqual(await read(), { github: 'x' });
  assert.equal(read.size(), 1);
});

test('somebody who knows better can throw it away', async() => {
  let reads = 0;
  const read = source(async(n) => `${ n }:${ ++reads }`);

  assert.equal(await read(7), '7:1');
  assert.equal(await read(7), '7:1');
  read.forget(7);
  assert.equal(await read(7), '7:2');

  await read(8);
  assert.equal(read.size(), 2);
  read.forget();
  assert.equal(read.size(), 0, 'no arguments forgets everything');
});

test('different arguments are different entries', async() => {
  let reads = 0;
  const read = source(async(repo, num) => `${ repo }#${ num }:${ ++reads }`);

  assert.equal(await read('rancher/dashboard', 19517), 'rancher/dashboard#19517:1');
  assert.equal(await read('rancher/dashboard', 19524), 'rancher/dashboard#19524:2');
  assert.equal(await read('rancher/dashboard', 19517), 'rancher/dashboard#19517:1');
  assert.equal(read.size(), 2);
});

test('a key of its own, when the arguments are not the identity', async() => {
  let reads = 0;
  const read = source(async(opts) => `${ opts.repo }:${ ++reads }`, { key: (opts) => opts.repo });

  await read({ repo: 'a', noise: 1 });
  await read({ repo: 'a', noise: 2 });
  assert.equal(read.size(), 1, 'the noise is not part of the identity');
  read.forget({ repo: 'a' });
  assert.equal(read.size(), 0);
});

test('for the life of the page is a ttl, not a second mechanism', async() => {
  const time = clock();
  let reads = 0;
  const read = source(async() => ++reads, { ttl: Infinity, now: time.now });

  assert.equal(await read(), 1);
  time.tick(86_400_000);
  assert.equal(await read(), 1);
});

test('a read forgotten while it was in flight does not take its successor with it', async() => {
  let reads = 0;
  let release;
  const read = source(async() => {
    reads++;
    if (reads === 1) {
      await new Promise((resolve) => {
        release = resolve;
      });
      throw new Error('the first read, failing late');
    }

    return 'second';
  });

  const first = read();

  read.forget();
  const second = read();

  release();
  await assert.rejects(first, /failing late/);
  assert.equal(await second, 'second');
  // The late failure removed its own entry only if it was still the one held - it was not.
  assert.equal(read.size(), 1);
  assert.equal(await read(), 'second', 'and the successor is still there');
});

test('a load that throws synchronously is a rejection, not a crash', async() => {
  const read = source(() => {
    throw new Error('bad arguments');
  });

  await assert.rejects(read(), /bad arguments/);
  assert.equal(read.size(), 0);
});

/*
 * `amend`: changing what is held, for the caller that already knows the answer.
 *
 * The case is a pull request's draft comment. Editing one is a local write that returns the
 * comment it wrote, and the only reason the page then re-read the whole pull request - half a
 * dozen GitHub calls - was to get that one field back into this map.
 */
test('amend changes the held value without reading again', async() => {
  let reads = 0;
  const read = source(async(n) => ({ n, body: `read ${ ++reads }` }), { ttl: 1000, log: null });

  assert.equal((await read(1)).body, 'read 1');
  assert.equal(read.amend((v) => ({ ...v, body: 'edited' }), 1), true);
  assert.equal((await read(1)).body, 'edited');
  assert.equal(reads, 1, 'the source was not asked again');
});

test('amend does nothing when nothing is held', async() => {
  const read = source(async(n) => ({ n }), { ttl: 1000, log: null });

  // Inventing an entry here would mean serving an answer this source never read.
  assert.equal(read.amend(() => ({ n: 'made up' }), 7), false);
  assert.equal(read.size(), 0);
});

test('an amendment that returns undefined keeps what was there', async() => {
  const read = source(async() => ({ comments: [{ id: 1 }] }), { ttl: 1000, log: null });

  await read();
  // A change that cannot find what it meant to amend must not empty the entry.
  read.amend(() => undefined);
  assert.deepEqual((await read()).comments, [{ id: 1 }]);
});

test('amend does not turn a failed read into a successful one', async() => {
  const read = source(async() => {
    throw new Error('github said no');
  }, { ttl: 1000, log: null });

  await assert.rejects(read(1));
  // The failure dropped the entry, so there is nothing to amend - and nothing is created.
  assert.equal(read.amend(() => ({ ok: true }), 1), false);
  await assert.rejects(read(1));
});

test('amend does not reset how old the entry is', async() => {
  let clock = 0;
  let reads = 0;
  const read = source(async() => ({ read: ++reads }), {
    ttl: 100, now: () => clock, log: null,
  });

  await read();
  clock = 60;
  read.amend((v) => ({ ...v, touched: true }));
  clock = 120;
  // Past the ttl measured from the original read, so this is a fresh one, amendment and all.
  assert.equal((await read()).read, 2);
});
