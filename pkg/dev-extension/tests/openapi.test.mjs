// The spec has to agree with the routes beside it.
//
// server.mjs says why it serves its spec instead of generating one: "it has to agree with
// `routes` in this same file: a spec kept somewhere else is a spec that drifts the first time a
// path changes." That is an argument for keeping them together, not a mechanism - nothing
// actually checked. This is the mechanism.
//
// Static on purpose. server.mjs reads a service account token at import time, so it cannot be
// loaded here; the source is read as text and the two lists are compared. That is enough to
// catch the failure that matters: a documented path that no route serves, which sends an agent
// at a 404 with the spec's own authority behind it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'dev-api', 'server.mjs'), 'utf8');

/** The paths the spec claims, as written in the OPENAPI block. */
function documentedPaths() {
  const start = source.indexOf('const OPENAPI = {');

  assert.ok(start > 0, 'the spec block is still called OPENAPI');
  const block = source.slice(start, source.indexOf('\n};', start));

  return [...new Set([...block.matchAll(/^\s{4}'(\/[^']*)':/gm)].map((m) => m[1]))];
}

/**
 * Every pattern that serves a path, from both places this file declares them.
 *
 * There are two, which is worth knowing before trusting this: a declarative table of
 * `['GET', /^.../ , fn]` entries, and a handful of imperative `/^.../.exec(url.pathname)`
 * checks in the handler for the routes that stream or need the raw response. A check that knew
 * only about the table would call the second kind undocumented and be wrong about it.
 */
function routePatterns() {
  const table = [...source.matchAll(/\['(?:GET|POST|PUT|DELETE)', \/\^([^/]*(?:\\\/[^/]*)*)\/[a-z]*,/g)]
    .map((m) => m[1]);
  const imperative = [...source.matchAll(/=\s*\/\^([^/]*(?:\\\/[^/]*)*)\/[a-z]*\.exec\(url\.pathname\)/g)]
    .map((m) => m[1]);

  return [...table, ...imperative];
}

/** A documented path with its `{placeholders}` turned into something a route pattern matches. */
function asConcrete(spec) {
  return spec
    .replace(/\{num\}/g, '42')
    .replace(/\{id\}/g, 'agent-1')
    // A check id is a number in the route, and substituting a word for it made the route look
    // missing. The placeholders are not interchangeable; each stands for a real shape.
    .replace(/\{checkId\}/g, '7')
    .replace(/\{kind\}/g, 'dev-server')
    // Any other placeholder, camelCase included - `{checkId}` is one, and a lower-case-only
    // pattern silently left it in the path and then called the route missing.
    .replace(/\{[A-Za-z]+\}/g, 'thing');
}

test('the spec block is where this test thinks it is', () => {
  assert.ok(documentedPaths().length >= 10, 'found the documented paths');
  assert.ok(routePatterns().length >= 30, 'found the route table');
  assert.ok(
    routePatterns().some((p) => p.includes('media')),
    'found the imperative routes too, not just the table',
  );
});

test('every documented path is served by a route', () => {
  const patterns = routePatterns().map((raw) => {
    try {
      return new RegExp(`^${ raw.replace(/\\\//g, '/') }`);
    } catch {
      return null;
    }
  }).filter(Boolean);

  const orphans = documentedPaths().filter((spec) => {
    const concrete = asConcrete(spec);

    return !patterns.some((re) => re.test(concrete));
  });

  assert.deepEqual(orphans, [], 'these paths are in the spec and in no route');
});

test('the spec names an operationId for every operation it documents', () => {
  const start = source.indexOf('const OPENAPI = {');
  const block = source.slice(start, source.indexOf('\n};', start));
  const verbs = [...block.matchAll(/^\s{6}(get|post|put|delete):\s*\{/gm)].length;
  const ids = [...block.matchAll(/operationId:/g)].length;

  // An operation with no id is one an agent cannot name when it asks for help with it.
  assert.equal(ids, verbs, `${ verbs } operations, ${ ids } operationIds`);
});
