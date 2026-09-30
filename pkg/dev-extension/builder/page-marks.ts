// Mounting the page-mark overlay: the "Allow editing in installation" switches that sit on
// Rancher's own resource edit pages (see components/PageMarks.vue).
//
// Its own Vue app on `document.body`, for the same reason the drawer is one: the switches have
// to outlive every page, because they belong to whatever resource page is open while the drawer
// holds that resource. It adopts the dashboard's context the same way (components, directives,
// provides, globals) so `t()` and the theme variables work inside it.

import { createApp } from 'vue';
import PageMarks from '../components/PageMarks.vue';

const HOST_ID = 'apps-plus-page-marks';

function dashboardApp(): any {
  return (document.querySelector('#app') as any)?.__vue_app__ || null;
}

let mounted = false;

/**
 * Mount the overlay once the dashboard exists to adopt a context from.
 *
 * Polling, like restoreBuilder and for the same reason: a cold load evaluates this bundle
 * before Vue has mounted `#app`, and the dashboard does not announce itself. The overlay
 * renders nothing until the drawer is open with an app and a staged resource, so mounting it
 * unconditionally costs one empty div and a timer.
 */
export function initPageMarks(): void {
  if (mounted) {
    return;
  }

  const attempt = (left: number) => {
    if (mounted) {
      return;
    }

    const host = dashboardApp();

    if (!host) {
      if (left > 0) {
        setTimeout(() => attempt(left - 1), 250);
      }

      return;
    }

    let el = document.getElementById(HOST_ID);

    if (!el) {
      el = document.createElement('div');
      el.id = HOST_ID;
      document.body.appendChild(el);
    }

    const app = createApp(PageMarks);

    Object.assign(app._context.components, host._context.components);
    Object.assign(app._context.directives, host._context.directives);
    Object.assign(app._context.provides, host._context.provides);
    Object.defineProperties(
      app.config.globalProperties,
      Object.getOwnPropertyDescriptors(host.config.globalProperties),
    );

    app.mount(el);
    mounted = true;
  };

  attempt(40);
}
