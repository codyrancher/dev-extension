// Which person's credentials this service acts with.
//
// dev-api has no caller identity and cannot have one on the path it is reached by: the browser
// arrives through Kubernetes' service proxy, which authenticates at the apiserver and then opens
// its own connection, so the caller's bearer token never reaches the backend - the only header
// this server has ever read is `range`. An agent arrives from inside the cluster with no user at
// all.
//
// With one secret store that is unambiguous. With two it was a coin toss between two people's
// credentials, which is the wrong kind of quiet: it would act as the wrong person and look like
// it worked. The rule below is that it now refuses instead, unless told whose to use.
//
// The rule is restated here rather than imported - server.mjs reads a service account token at
// import time and cannot be loaded - and that is a real limit of this test: it pins the rule,
// not the call site. The call site is one line in each of two token readers.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const store = (name, data) => ({ metadata: { name }, data });

/** The rule from `secretFromStores`. */
function pick(items, key, owner = '') {
  const holding = items.filter((s) => s.data?.[key]);

  if (!holding.length) {
    return '';
  }
  if (owner) {
    const named = holding.find((s) => s.metadata?.name === owner || s.metadata?.name === `dev-secrets-${ owner }`);

    return named ? Buffer.from(named.data[key], 'base64').toString('utf8').trim() : '';
  }
  if (holding.length > 1) {
    throw new Error(`${ holding.length } stores hold ${ key }`);
  }

  return Buffer.from(holding[0].data[key], 'base64').toString('utf8').trim();
}

test('one store is unambiguous', () => {
  assert.equal(pick([store('dev-secrets-alice', { GH_TOKEN: b64('alice-token') })], 'GH_TOKEN'), 'alice-token');
});

test('no store holding the key is empty, not an error', () => {
  // A token nobody has set is a thing the caller handles ("add one in Settings"), not a failure
  // of this service.
  assert.equal(pick([store('dev-secrets-alice', { JIRA_TOKEN: b64('j') })], 'GH_TOKEN'), '');
  assert.equal(pick([], 'GH_TOKEN'), '');
});

test('two stores refuse rather than guess', () => {
  const two = [
    store('dev-secrets-alice', { GH_TOKEN: b64('alice-token') }),
    store('dev-secrets-bob', { GH_TOKEN: b64('bob-token') }),
  ];

  assert.throws(() => pick(two, 'GH_TOKEN'), /2 stores hold GH_TOKEN/);
});

test('a named owner settles it, by either spelling', () => {
  const two = [
    store('dev-secrets-alice', { GH_TOKEN: b64('alice-token') }),
    store('dev-secrets-bob', { GH_TOKEN: b64('bob-token') }),
  ];

  assert.equal(pick(two, 'GH_TOKEN', 'bob'), 'bob-token', 'the bare owner name');
  assert.equal(pick(two, 'GH_TOKEN', 'dev-secrets-bob'), 'bob-token', 'the full secret name');
});

test('a named owner that holds nothing is empty, not somebody else', () => {
  // The failure this whole rule exists to prevent: never fall back to another person's token.
  const two = [
    store('dev-secrets-alice', { GH_TOKEN: b64('alice-token') }),
    store('dev-secrets-bob', { GH_TOKEN: b64('bob-token') }),
  ];

  assert.equal(pick(two, 'GH_TOKEN', 'carol'), '');
});

test('two stores where only one holds the key is still unambiguous', () => {
  const two = [
    store('dev-secrets-alice', { GH_TOKEN: b64('alice-token') }),
    store('dev-secrets-bob', { JIRA_TOKEN: b64('bob-jira') }),
  ];

  assert.equal(pick(two, 'GH_TOKEN'), 'alice-token');
  assert.equal(pick(two, 'JIRA_TOKEN'), 'bob-jira');
});
