// What an agent's Confluence questions become. The search is spliced into CQL, so the one thing
// that must hold is that words stay words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  searchCql, searchLimit, pageText, pageAnswer, CONFLUENCE_LIMIT, CONFLUENCE_LIMIT_MAX, PAGE_TEXT_MAX
} from '../dev-api/confluence.mjs';

const params = (o) => new URLSearchParams(o);

test('a search is the words, as words, in pages', () => {
  assert.equal(searchCql(params({ q: 'fleet upgrade' })), 'text ~ "fleet upgrade" AND type = page');
  assert.equal(searchCql(params({ q: 'x', space: 'RANCHER' })), 'text ~ "x" AND type = page AND space = "RANCHER"');
  assert.equal(searchCql(params({ q: 'x', type: 'blogpost' })), 'text ~ "x" AND type = blogpost');
  assert.equal(searchCql(params({})), '');
});

test('a query cannot close its quotes and add clauses of its own', () => {
  assert.equal(searchCql(params({ q: 'a" OR space = "X' })), 'text ~ "a\\" OR space = \\"X" AND type = page');
  assert.equal(searchCql(params({ q: 'a\\' })), 'text ~ "a\\\\" AND type = page');
  assert.equal(searchCql(params({ q: 'x', space: 'A" OR 1=1' })), 'text ~ "x" AND type = page', 'a space that is not a key is dropped');
});

test('raw CQL goes through for whoever needs it', () => {
  assert.equal(searchCql(params({ cql: 'label = "release"', q: 'ignored' })), 'label = "release"');
});

test('a limit is bounded', () => {
  assert.equal(searchLimit(params({})), CONFLUENCE_LIMIT);
  assert.equal(searchLimit(params({ limit: '3' })), 3);
  assert.equal(searchLimit(params({ limit: '9999' })), CONFLUENCE_LIMIT_MAX);
  assert.equal(searchLimit(params({ limit: '-1' })), CONFLUENCE_LIMIT);
});

test('a page reads as text, with its structure kept', () => {
  const html = '<h2>Install</h2><p>Run &amp; wait&nbsp;now.</p><ul><li>one</li><li>two</li></ul>' +
    '<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table><pre>helm install x</pre><script>bad()</script>';

  assert.equal(pageText(html), '## Install\nRun & wait now.\n\n- one\n- two\na | b |\n1 | 2 |\n\n```\nhelm install x\n```');
});

test('a long page is cut, and says it was', () => {
  const page = pageAnswer({
    id: '7', title: 'T', space: { key: 'S' }, version: { number: 3, when: 'w' }, _links: { webui: '/x' }, body: { view: { value: 'a'.repeat(PAGE_TEXT_MAX + 5) } },
  }, 'https://c');

  assert.equal(page.text.length, PAGE_TEXT_MAX);
  assert.equal(page.truncated, true);
  assert.equal(page.url, 'https://c/x');
  assert.equal(page.version, 3);
});

test('the wiring: read-only, behind the stored token, and told to agents', () => {
  const server = fs.readFileSync(new URL('../dev-api/server.mjs', import.meta.url), 'utf8');
  const secrets = fs.readFileSync(new URL('../secrets.ts', import.meta.url), 'utf8');
  const doc = fs.readFileSync(new URL('../agent-seed/CLAUDE.dev.md', import.meta.url), 'utf8');

  assert.match(secrets, /key: +'CONFLUENCE_TOKEN'/);
  assert.match(server, /secretFromStores\('CONFLUENCE_TOKEN'\)/);
  assert.match(server, /url\.pathname\.startsWith\('\/confluence\/rest\/'\) && req\.method === 'GET'/);
  assert.match(doc, /\/confluence\/search\?q=/);
  // The drawer's conversations read this one instead; see shell.sh.
  assert.match(fs.readFileSync(new URL('../seed/agent/session-claude.md', import.meta.url), 'utf8'), /\/confluence\/search\?q=/);
});
