// The browser's client for the pod's state service, run for real with node's type stripping against
// a stubbed exec and a fake network. What is pinned is how often a service gets restarted and what a
// restart costs the reads around it, since being wrong about either means more exec, not less.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PKG = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pod-state-'));

fs.writeFileSync(path.join(dir, 'pod-stub.mjs'), `
export const AGENT_BASE = '';
export const AGENT_NS = 'dev-agents';
export const AGENT_CONTAINER = 'agent';
export const podExecResult = (...args) => globalThis.podExec(...args);
`);
fs.writeFileSync(path.join(dir, 'pod-state.ts'), fs.readFileSync(path.join(PKG, 'pod-state.ts'), 'utf8').replace(/from '\.\/pod'/, "from './pod-stub.mjs'"));

const { podStateText, podFeedState, resetPodState, PodStateUnavailable } = await import(pathToFileURL(path.join(dir, 'pod-state.ts')).href);

process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

const POD = 'agent-0';
const TOKEN = 'a'.repeat(64);
const realFetch = globalThis.fetch;
const realNow = Date.now;
let clock;

const answer = (status, body) => new Response(JSON.stringify({ version: 3, ...body }), { status });
const text = (t) => answer(200, {
  ok: true, text: t, age: 0
});

/**
 * A pod. `serves` is what its service knows, and `seedHas` what a restart would bring it up knowing.
 * While `restarting` the port is closed, which the apiserver's proxy reports as a 503.
 */
function pod({ serves = ['/old'], seedHas = serves, restartTakes = 0 } = {}) {
  const it = {
    serves: new Set(serves), seedHas: new Set(seedHas), restarts: 0, starts: 0, restarting: false, asked: [],
  };

  globalThis.podExec = async(name, argv) => {
    const verb = argv[argv.length - 1];

    if (verb === 'restart') {
      it.restarts += 1;
      it.restarting = true;
      await new Promise((resolve) => setTimeout(resolve, restartTakes));
      it.serves = new Set(it.seedHas);
      it.restarting = false;
    } else {
      it.starts += 1;
    }

    return { stdout: `token ${ TOKEN }\n`, stderr: '', status: '' };
  };
  globalThis.fetch = async(url) => {
    const at = decodeURIComponent(url).split('/proxy')[1].split('?')[0];

    it.asked.push(at);
    if (it.restarting) {
      return new Response('no endpoints', { status: 503 });
    }

    return it.serves.has(at) ? text(`from ${ at }`) : answer(404, { ok: false });
  };

  return it;
}

/** Whether this read came over HTTP. */
async function viaHttp(route) {
  try {
    await podStateText(POD, route);

    return true;
  } catch (e) {
    assert.ok(e instanceof PodStateUnavailable, `only ever PodStateUnavailable, got ${ e }`);

    return false;
  }
}

afterEach(() => {
  resetPodState();
  globalThis.fetch = realFetch;
  Date.now = realNow;
});

function fakeClock() {
  clock = 1_000_000;
  Date.now = () => clock;
}

test('a route the service lacks earns one restart, and then it serves', async() => {
  const it = pod({ seedHas: ['/old', '/new'] });

  assert.equal(await viaHttp('/new'), true);
  assert.equal(it.restarts, 1);
  assert.equal(await viaHttp('/new'), true);
  assert.equal(it.restarts, 1);
  assert.equal(it.starts, 1, 'the token survives the restart, so that is the only other exec');
});

test('reads that 404 together share one restart, and each is answered over HTTP', async() => {
  const it = pod({ seedHas: ['/old', '/new', '/newer'], restartTakes: 20 });

  await viaHttp('/old');
  const reads = await Promise.all([viaHttp('/new'), viaHttp('/newer'), viaHttp('/new')]);

  assert.deepEqual(reads, [true, true, true]);
  assert.equal(it.restarts, 1);
});

test('a read during a restart waits for it, rather than failing and opening the circuit', async() => {
  const it = pod({ seedHas: ['/old', '/new'], restartTakes: 30 });

  await viaHttp('/old');
  const pending = viaHttp('/new');

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(it.restarting, true);
  assert.equal(await viaHttp('/old'), true, 'not sent to exec');
  assert.equal(await pending, true);
  assert.equal(await viaHttp('/old'), true, 'and the pod is not on exec afterwards');
});

test('a read already in flight when the port closes costs that read, not the pod', async() => {
  const it = pod({ seedHas: ['/old', '/new'], restartTakes: 30 });
  const fetched = globalThis.fetch;
  let inFlight;

  await viaHttp('/old');
  globalThis.fetch = async(url) => {
    if (decodeURIComponent(url).includes('/slow')) {
      // Answered only once the restart has closed the port.
      await new Promise((resolve) => {
        inFlight = resolve;
      });

      return new Response('no endpoints', { status: 503 });
    }

    return fetched(url);
  };
  const slow = viaHttp('/slow');

  await new Promise((resolve) => setTimeout(resolve, 5));
  const restart = viaHttp('/new');

  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(it.restarting, true);
  inFlight();
  assert.equal(await slow, false, 'that one read uses exec');
  assert.equal(await restart, true);
  assert.equal(await viaHttp('/old'), true, 'and no other does');
  assert.equal(it.restarts, 1);
});

test('the port still closed just after the restart script returns does not open the circuit', async() => {
  const it = pod({ seedHas: ['/old', '/new'] });
  const fetched = globalThis.fetch;
  let refusals = 1;

  await viaHttp('/old');
  globalThis.fetch = async(url) => {
    if (it.restarts && refusals > 0) {
      refusals -= 1;

      return new Response('no endpoints', { status: 503 });
    }

    return fetched(url);
  };
  assert.equal(await viaHttp('/new'), false, 'that read uses exec');
  assert.equal(await viaHttp('/old'), true, 'and every other stays on HTTP');
});

test('a service that never gains the route is not restarted once a minute for ever', async() => {
  fakeClock();
  const it = pod();
  let onHttp = 0;
  let reads = 0;
  const MINUTES = 60;

  for (let minute = 0; minute < MINUTES; minute += 1) {
    assert.equal(await viaHttp('/new'), false, 'the route that is not there uses exec');
    reads += 1;
    onHttp += await viaHttp('/old') ? 1 : 0;
    clock += 60_000;
  }

  // One minute, then two, four, eight, sixteen, and thirty after that.
  assert.ok(it.restarts <= 7, `${ it.restarts } restarts in an hour`);
  assert.equal(onHttp, reads, 'and everything else stayed on HTTP for the whole hour');
});

test('a seed that arrives a minute late takes the second restart, and that is the end of it', async() => {
  fakeClock();
  const it = pod();

  assert.equal(await viaHttp('/new'), false);
  assert.equal(it.restarts, 1);

  // Inside the gap the route is not asked for, so the arrival cannot be noticed yet.
  it.seedHas = new Set(['/old', '/new']);
  clock += 30_000;
  assert.equal(await viaHttp('/new'), false);
  assert.equal(it.restarts, 1);

  clock += 31_000;
  assert.equal(await viaHttp('/new'), true);
  assert.equal(it.restarts, 2);

  for (let minute = 0; minute < 30; minute += 1) {
    clock += 60_000;
    assert.equal(await viaHttp('/new'), true);
  }
  assert.equal(it.restarts, 2);
});

test('one success starts the gaps over, so a later release is not left waiting half an hour', async() => {
  fakeClock();
  const it = pod();

  for (let i = 0; i < 4; i += 1) {
    await viaHttp('/new');
    clock += 8 * 60_000;
  }
  it.seedHas = new Set(['/old', '/new', '/later']);
  clock += 30 * 60_000;
  assert.equal(await viaHttp('/new'), true);
  const before = it.restarts;

  it.seedHas = new Set(['/old', '/new', '/later', '/latest']);
  clock += 61_000;
  assert.equal(await viaHttp('/latest'), true);
  assert.equal(it.restarts, before + 1);
});

test('a service of the wrong version still goes back to exec and is still replaced', async() => {
  fakeClock();
  const it = pod();
  let version = 2;

  globalThis.fetch = async() => (it.restarting ? new Response('', { status: 503 }) : new Response(JSON.stringify({
    version, ok: true, text: 'x', age: 0
  }), { status: 200 }));
  const exec = globalThis.podExec;

  globalThis.podExec = async(...args) => {
    const out = await exec(...args);

    if (args[1].at(-1) === 'restart' && it.seedSynced) {
      version = 3;
    }

    return out;
  };

  assert.equal(await viaHttp('/old'), false, 'replaced before the seed synced, and still old');
  assert.equal(it.restarts, 1);
  it.seedSynced = true;
  clock += 61_000;
  assert.equal(await viaHttp('/old'), true, 'the cooldown is over and the second replacement worked');
  assert.equal(it.restarts, 2);
});

test('an outage of the pod itself still opens the circuit', async() => {
  fakeClock();
  const it = pod();

  await viaHttp('/old');
  globalThis.fetch = async() => new Response('', { status: 503 });
  assert.equal(await viaHttp('/old'), false);
  const asked = it.asked.length;

  globalThis.fetch = async() => {
    it.asked.push('asked');

    return text('x');
  };
  assert.equal(await viaHttp('/old'), false, 'left alone for the cooldown');
  assert.equal(it.asked.length, asked, 'without a request');
  clock += 61_000;
  assert.equal(await viaHttp('/old'), true);
  assert.equal(it.restarts, 0);
});

test('the stream comes back after a blip, and is never what starts the service', async() => {
  fakeClock();
  const it = pod({ serves: ['/sessions'] });
  const streams = [];
  const fetched = globalThis.fetch;
  const realTimeout = globalThis.setTimeout;

  // The settle and retry delays, short enough to wait for.
  globalThis.setTimeout = (fn, ms, ...rest) => realTimeout(fn, Math.min(ms, 5), ...rest);
  try {
    globalThis.fetch = async(url, opts) => {
      if (decodeURIComponent(url).includes('/stream')) {
        streams.push(url);

        return new Response(new ReadableStream({
          start(c) {
            opts.signal.addEventListener('abort', () => c.error(new Error('aborted')));
          },
        }), { status: 200 });
      }

      return fetched(url);
    };

    // Nothing has read this pod, so no token: asking to watch must not exec to get one.
    assert.equal(await viaHttp('/sessions'), true);
    assert.equal(it.starts, 1, 'the read started it');
    await new Promise((resolve) => realTimeout(resolve, 40));
    assert.equal(it.starts, 1, 'and the stream did not');
    assert.ok(streams.length >= 1, 'the stream followed the read');
    assert.equal(podFeedState(POD).live, true);

    // A blip: the circuit opens and takes the stream with it.
    const live = globalThis.fetch;
    const before = streams.length;

    globalThis.fetch = async(url, opts) => (decodeURIComponent(url).includes('/stream') ? live(url, opts) : new Response('', { status: 500 }));
    assert.equal(await viaHttp('/old-route-with-no-feed'), false);
    assert.equal(podFeedState(POD).live, false);
    await new Promise((resolve) => realTimeout(resolve, 20));
    assert.equal(streams.length, before, 'not while the circuit is open');

    // The cooldown ends, and until a read earns a token the stream has no business getting one:
    // on a cluster that forbids pods/proxy that would be an exec a minute on top of the read's.
    globalThis.fetch = live;
    clock += 61_000;
    const starts = it.starts;

    await new Promise((resolve) => realTimeout(resolve, 20));
    assert.equal(it.starts, starts, 'the stream did not start the service');
    assert.equal(streams.length, before);

    // A read closes the circuit: the stream reopens with nothing else asking.
    assert.equal(await viaHttp('/sessions'), true);
    await new Promise((resolve) => realTimeout(resolve, 40));
    assert.ok(streams.length > before, 'and it is back');
    assert.equal(podFeedState(POD).live, true);
  } finally {
    globalThis.setTimeout = realTimeout;
    resetPodState();
  }
});
