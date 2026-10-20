/**
 * A certificate is only asked for when the challenge could actually arrive.
 *
 * These two functions live inside certs/control.mjs, which is shipped to each cluster as one
 * file (scripts/gen-certs.mjs packs it verbatim into a ConfigMap) and which starts an HTTP
 * server and a sweep the moment it is imported - so it cannot be imported here, and it cannot
 * import a module of its own either. The functions are therefore lifted out of its source and
 * evaluated on their own.
 *
 * That is worth the awkwardness, because the failure this guards is silent in the dangerous
 * direction: a parser that reads an address out of a name it should not would make
 * `reachableHere` false for a live share, and the certificate would simply never be asked for.
 *
 * `node --test pkg/dev-extension/tests/*.test.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTROL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'certs', 'control.mjs');

/** One function's source, from `function <name>(` to its closing brace. */
function lift(source, name) {
  const at = source.indexOf(`function ${ name }(`);

  assert.ok(at >= 0, `${ name } is in control.mjs`);

  let depth = 0;

  for (let i = source.indexOf('{', at); i < source.length; i++) {
    if (source[i] === '{') {
      depth++;
    } else if (source[i] === '}') {
      depth--;
      if (depth === 0) {
        return source.slice(at, i + 1);
      }
    }
  }
  throw new Error(`${ name } does not close`);
}

const source = fs.readFileSync(CONTROL, 'utf8');
const module = `${ lift(source, 'addressOf') }\n${ lift(source, 'reachableHere') }\nexport { addressOf, reachableHere };`;
const { addressOf, reachableHere } = await import(`data:text/javascript,${ encodeURIComponent(module) }`);

test('the address a sslip.io name carries, in both spellings', () => {
  assert.equal(addressOf('otter.dev-extension.35.164.131.84.sslip.io'), '35.164.131.84');
  assert.equal(addressOf('35.164.131.84.sslip.io'), '35.164.131.84');
  // The dashed form sslip.io also answers, which a person may well have typed by hand.
  assert.equal(addressOf('otter.dev-extension.35-164-131-84.sslip.io'), '35.164.131.84');
  assert.equal(addressOf('35-164-131-84.sslip.io'), '35.164.131.84');
});

test('a name with no address in it yields nothing rather than a guess', () => {
  assert.equal(addressOf('shares.example.com'), '');
  assert.equal(addressOf('otter.dev-extension.sslip.io'), '');
  // Not an address, and must not be read as one just because it has digits in it.
  assert.equal(addressOf('build-19380.dev-extension.sslip.io'), '');
  assert.equal(addressOf(''), '');
});

test('a name pointing at this cluster is asked for', () => {
  const here = new Set(['35.164.131.84', '10.0.4.235']);

  assert.equal(reachableHere('otter.dev-extension.35.164.131.84.sslip.io', here), true);
  // The private address of the same node counts: what matters is whether a request for this
  // name reaches us, and the node answers on both.
  assert.equal(reachableHere('thing.dev-extension.10.0.4.235.sslip.io', here), true);
});

test('a name pointing at a node that is gone is skipped', () => {
  // The case this exists for: an instance rebuilt on a new node, its shares' Ingresses
  // re-delivered to the replacement still carrying the old node's address.
  const here = new Set(['35.164.131.84', '10.0.4.235']);

  assert.equal(reachableHere('lte-pr-19380-pr-19380.dev-extension.44.245.216.161.sslip.io', here), false);
  assert.equal(reachableHere('issue-18062-storybook.dev-extension.44.245.216.161.sslip.io', here), false);
});

test('unknown is never refused', () => {
  // A name with no address, and a cluster whose nodes could not be listed, both behave exactly
  // as they did before this check existed - otherwise a failed node read stops every renewal.
  assert.equal(reachableHere('shares.example.com', new Set(['35.164.131.84'])), true);
  assert.equal(reachableHere('x.dev-extension.44.245.216.161.sslip.io', new Set()), true);
});
