/**
 * The running dashboard's own Vue app and store, for the code that has no component to ask.
 *
 * There is no import for either: `@shell/config/store` builds a store, and the one this page is
 * actually using is the one already mounted on `#app`. Vue 3 leaves the app it mounted on the
 * element, so this reads that rather than constructing a second store which would answer about
 * nobody.
 *
 * Lifted out of overlay.ts when the theme needed the same wait. Two copies of a 30-line poll
 * with a deadline is how one of them ends up subtly different from the other.
 */

/** How long to keep looking for the dashboard's app, and how often. See `whenDashboardStore`. */
const APP_POLL_MS = 200;
const APP_WAIT_MS = 30000;

/**
 * Null is a real answer and every caller has to fail safe on it: on the login page, or before
 * the app has mounted, there is no store and no user to ask about.
 */
export function dashboardApp(): any {
  return (document.querySelector('#app') as any)?.__vue_app__ || null;
}

export function dashboardStore(): any {
  return dashboardApp()?.config?.globalProperties?.$store || null;
}

/**
 * Wait for the dashboard's own Vue app, then hand over its store.
 *
 * A poll, and the reason it is one is worth stating because the first version of this had no
 * wait at all and simply did nothing. A UIPlugin is evaluated during the dashboard's bootstrap,
 * inside `extendApp`, which is *before* `vueApp.mount('#app')` - so at the moment it runs there
 * is no `#app.__vue_app__` to read a store off, and asking once answers null on every cold
 * load. The drawer restored perfectly when the bundle happened to be re-evaluated later, and
 * never on a refresh, which is the case it exists for.
 *
 * It is a poll rather than an event because mounting is not one: Vue sets `__vue_app__` on the
 * element and announces nothing. The deadline is what keeps it from being a leak - a page where
 * the app never mounts is a broken page, not one to keep asking about.
 *
 * Returns a cancel, for a caller that can be torn down before the app arrives: the dev server
 * replacing this bundle leaves the old module's poll running otherwise, and it would hand the
 * store to code that has already been disposed.
 */
export function whenDashboardStore(then: (store: any) => void): () => void {
  const store = dashboardStore();

  if (store) {
    then(store);

    return () => undefined;
  }

  const deadline = Date.now() + APP_WAIT_MS;

  let waiting: any = setInterval(() => {
    const ready = dashboardStore();

    if (!ready && Date.now() < deadline) {
      return;
    }

    stop();

    if (ready) {
      then(ready);
    }
  }, APP_POLL_MS);

  function stop() {
    if (waiting) {
      clearInterval(waiting);
      waiting = null;
    }
  }

  return stop;
}
