/**
 * What Rancher's theme preference means, and what this product does differently with it.
 *
 * The theme is a *user* preference in Rancher: `shell/store/prefs.ts` declares it with
 * `asCookie` AND `asUserPreference`, so changing it writes a `R_THEME` cookie in the browser
 * you changed it in *and* `theme: ui-light` into the one `userpreferences` document attached to
 * your account. On the way back in, `loadCookies` reads the cookie and `loadServer` then
 * commits the server's copy over it - so the account's value is the one that decides, and the
 * cookie is only a pre-login guess.
 *
 * That is reasonable for a person with one account and several laptops. It is wrong here. Every
 * agent drives a dashboard signed in as the person it works for: the shared browser is their
 * session, and so is the dev server in each workspace. An agent reproducing "the text is
 * invisible in light mode" switches the theme, and the switch lands on the account - so the
 * person's own dashboard turns light, in another browser, minutes later, with nothing to point
 * at. `Shift+T` toggles the theme too, for anybody whose `plugin-developer` preference is set,
 * and the shortcut is only disabled inside inputs: a stray keystroke with focus on the page
 * body does the same thing silently.
 *
 * So in any dashboard this extension is loaded in, the theme becomes a setting of the *browser*
 * rather than of the account: see theme-local.ts. Two pieces -
 *
 *   - the pref is re-registered with `asUserPreference: false`, so a change writes the cookie
 *     and stops there and the account's copy is never written again;
 *   - the cookie is re-asserted whenever the store drifts from it, because `loadServer` runs on
 *     every boot *and* inside every other preference write, and each run would otherwise put
 *     the account's value back over this browser's choice.
 *
 * What is given up is the theme following you to a new browser. A browser with no cookie still
 * starts from the account's value, so a fresh one is not jarring; what it will not do is change
 * that value afterwards. The trade was made deliberately: one person's dashboard turning light
 * overnight is a real complaint, and "my new laptop opened in dark and I switched it once" is
 * not.
 *
 * Plain JavaScript and no imports, so `node --test` loads it directly - see
 * tests/theme-pref.test.mjs.
 */

/** What the pref may be set to, as Rancher's own `options` list has it. */
export const THEMES = ['light', 'dark', 'auto'];

/**
 * One spelling for the two that exist.
 *
 * The account's copy is written `ui-dark` (`mangleWrite`) and read back as `dark`
 * (`mangleRead`), while the cookie is written before either runs and holds the bare word. An
 * older dashboard wrote the prefixed form into the cookie as well, so both shapes are in the
 * wild and comparing them literally reports drift that is not there - which would have this
 * re-asserting the same value in a loop.
 */
export function normalTheme(value) {
  return String(value ?? '').trim().replace(/^ui-/, '');
}

/**
 * The definition to register so a theme change stays in this browser, or null when there is
 * nothing to do.
 *
 * Null for a pref that is already local, which is the second evaluation of this bundle on one
 * page - a UIPlugin can be loaded more than once - and for a dashboard whose prefs module has
 * no theme at all, where the right move is to leave Rancher's own behaviour alone rather than
 * invent a definition for it.
 */
export function localThemeDefinition(definition) {
  if (!definition || definition.asUserPreference === false) {
    return null;
  }

  // Spread rather than rebuilt: `parseJSON`, `asCookie`, `options`, `mangleRead` and
  // `mangleWrite` all still have to be exactly what Rancher declared, because the cookie and
  // the Preferences page both read them. Only who the value belongs to changes.
  return { ...definition, asUserPreference: false };
}

/**
 * What to commit locally when the store's theme has drifted from this browser's cookie, or ''
 * for "leave it".
 *
 * '' covers the two cases that are not drift: no cookie, where the account's value is the only
 * answer there is and should stand, and a cookie that already agrees. A value this does not
 * recognise is also left alone - the cookie is editable by hand and by any script on the page,
 * and `theme-wat` reaches the body as a class nothing is styled for, which is a blank
 * dashboard rather than a wrong-coloured one.
 */
export function themeToReassert(inStore, inCookie) {
  const want = normalTheme(inCookie);

  if (!want || !THEMES.includes(want)) {
    return '';
  }

  return want === normalTheme(inStore) ? '' : want;
}
