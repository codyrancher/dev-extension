// An Installation rendered the way the dashboard's Apps Plus model and dev-api both render it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { substituteValues, mergeAppValues, renderAppTemplates } from '../render-core.mjs';

const app = {
  metadata: { name: 'lte-workspace' },
  spec:     {
    values:    { image: 'img:1', repo: 'rancher/dashboard' },
    templates: [{ name: 'ns.yaml', content: 'name: ${namespace}\nws: ${install}\nrepo: ${repo}\nscript: ${ SA } ${unset}' }],
  },
};
const instance = { metadata: { name: 'lte-pr-9' }, spec: { app: 'lte-workspace', namespace: 'dev-lte-pr-9', values: { repo: 'rancher/other' } } };

test('the values: the App\'s, the Installation\'s on top, and the built-ins', () => {
  assert.deepEqual(mergeAppValues(app, instance), {
    image: 'img:1', repo: 'rancher/other', app: 'lte-workspace', install: 'lte-pr-9', instance: 'lte-pr-9', cluster: 'lte-pr-9', namespace: 'dev-lte-pr-9',
  });
});

test('only ours are substituted: a spaced ${ x } and an unknown ${y} are left as written', () => {
  assert.equal(substituteValues('${a} ${ a } ${b}', { a: 1 }), '1 ${ a } ${b}');
  assert.deepEqual(renderAppTemplates(app, instance), [{ name: 'ns.yaml', content: 'name: dev-lte-pr-9\nws: lte-pr-9\nrepo: rancher/other\nscript: ${ SA } ${unset}' }]);
});
