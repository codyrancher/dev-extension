// The theme, made a setting of this browser instead of of the person's account.
//
// Why that is the right shape, and what it costs, is in theme-pref.mjs - read that first. This
// file is the two lines of wiring it describes, and the ordering problem they have to survive.
import { THEME } from '@shell/store/prefs';
import { whenDashboardStore } from './dashboard-app';
import { localThemeDefinition, themeToReassert } from './theme-pref.mjs';

/** The cookie Rancher keeps the theme in: `R_` + the pref's name, upper-cased. */
const THEME_COOKIE = 'R_THEME';

/** One install per page, however many times the bundle is evaluated. */
let installed = false;

/** This browser's own answer, or '' when it has never had one. */
function cookieTheme(store: any): string {
  try {
    return store.getters['cookies/get']({ key: THEME_COOKIE, options: { parseJSON: true } }) || '';
  } catch {
    // A dashboard with no cookies module, or a cookie that will not parse. Either way this
    // browser has no opinion, and the account's value is the better answer than none.
    return '';
  }
}

/**
 * Stop agents' theme changes landing on the person's account, and stop the account's value
 * landing on this browser.
 *
 * Both halves are needed and neither is enough alone. Without the re-registration a switch
 * still writes the account; without the watch the account still wins, because `loadServer` is a
 * get-before-set that runs inside *every* preference write - a pin, a visited page, a table
 * view - and commits the server's copy of every key it reads, this one included. The theme
 * would snap back seconds after it was changed, at whatever moment something unrelated was
 * saved, which is a worse bug than the one being fixed.
 *
 * The watch compares against the cookie rather than remembering what it last set, because the
 * cookie is the record: `set` writes it in the same tick as the local commit, so by the time a
 * watcher runs, "the store disagrees with the cookie" means precisely "this change came from
 * somewhere that was not this browser".
 */
export function keepThemeLocal(): void {
  if (installed) {
    return;
  }

  installed = true;

  whenDashboardStore((store) => {
    const definition = localThemeDefinition(store.state?.prefs?.definitions?.[THEME]);

    if (definition) {
      store.commit('prefs/setDefinition', { name: THEME, definition });
    }

    // The prefs module is Rancher's, so a dashboard old or new enough not to have this pref at
    // all gets nothing done to it rather than a theme invented for it.
    if (!store.state?.prefs?.definitions?.[THEME]) {
      return;
    }

    const reassert = () => {
      const want = themeToReassert(store.getters['prefs/get'](THEME), cookieTheme(store));

      if (want) {
        // `load`, not `set`: the local commit alone. `set` would write the cookie back (the
        // value it came from) and, before the re-registration above lands, the account too.
        store.commit('prefs/load', { key: THEME, value: want });
      }
    };

    // Now, for the load that has already happened by the time a UIPlugin is evaluated, and then
    // on every change - `loadCookies` and `loadServer` both arrive after this.
    reassert();
    store.watch(() => store.getters['prefs/get'](THEME), reassert);
  });
}
