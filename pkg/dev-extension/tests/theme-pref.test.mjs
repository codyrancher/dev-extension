/**
 * The theme is this browser's setting, and these are the two decisions that make it one.
 *
 * `node --test pkg/dev-extension/tests/*.test.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { localThemeDefinition, normalTheme, themeToReassert, THEMES } from '../theme-pref.mjs';

/** Rancher's own definition of the pref, as `shell/store/prefs.ts` creates it. */
const RANCHER = {
  def:              'auto',
  options:          THEMES,
  parseJSON:        true,
  asCookie:         true,
  asUserPreference: true,
  mangleRead:       (x) => x.replace(/^ui-/, ''),
  mangleWrite:      (x) => `ui-${ x }`,
};

test('the pref keeps everything but who it belongs to', () => {
  const local = localThemeDefinition(RANCHER);

  assert.equal(local.asUserPreference, false);
  // The cookie is now the only copy, so everything the cookie is written and read with has to
  // survive: a lost `parseJSON` writes `dark` where `"dark"` is read back.
  assert.equal(local.asCookie, true);
  assert.equal(local.parseJSON, true);
  assert.equal(local.def, 'auto');
  assert.deepEqual(local.options, THEMES);
  assert.equal(local.mangleWrite('dark'), 'ui-dark');
  assert.equal(local.mangleRead('ui-dark'), 'dark');
});

test('a pref that is already local, or missing, is left alone', () => {
  // The same page evaluating this bundle twice must not re-register, and a dashboard whose
  // prefs module has no theme is Rancher's business, not ours.
  assert.equal(localThemeDefinition({ ...RANCHER, asUserPreference: false }), null);
  assert.equal(localThemeDefinition(undefined), null);
  assert.equal(localThemeDefinition(null), null);
});

test('the browser\'s cookie wins when the account\'s value has drifted onto it', () => {
  // What `loadServer` does on every boot and inside every other preference write.
  assert.equal(themeToReassert('dark', 'light'), 'light');
  assert.equal(themeToReassert('light', 'dark'), 'dark');
  assert.equal(themeToReassert('dark', 'auto'), 'auto');
});

test('agreement is not drift, in either spelling', () => {
  assert.equal(themeToReassert('dark', 'dark'), '');
  // The account's copy is prefixed and an older dashboard wrote the cookie prefixed too;
  // comparing them literally would re-assert the same value for ever.
  assert.equal(themeToReassert('dark', 'ui-dark'), '');
  assert.equal(themeToReassert('ui-light', 'light'), '');
  assert.equal(normalTheme('ui-dark'), 'dark');
  assert.equal(normalTheme('  ui-light '), 'light');
  assert.equal(normalTheme(undefined), '');
});

test('a browser with no opinion takes the account\'s', () => {
  // The case that keeps a fresh browser from opening in something jarring: nothing stored here,
  // so whatever the account says stands.
  assert.equal(themeToReassert('dark', ''), '');
  assert.equal(themeToReassert('dark', undefined), '');
  assert.equal(themeToReassert('dark', null), '');
});

test('a cookie nothing is styled for is ignored rather than applied', () => {
  // The cookie is editable by hand and by any script on the page, and the value reaches the
  // body as a class name: `theme-wat` is an unstyled dashboard, which is worse than the wrong
  // colour. Only the three Rancher declares are honoured.
  assert.equal(themeToReassert('dark', 'wat'), '');
  assert.equal(themeToReassert('dark', 'ui-wat'), '');
  assert.equal(themeToReassert('dark', '{}'), '');
  assert.deepEqual(THEMES, ['light', 'dark', 'auto']);
});
