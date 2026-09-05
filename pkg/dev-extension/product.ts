import { IPlugin } from '@shell/core/types';
import { ensureDevRbac, ensureWorkspaceApi } from './api';
import { ensureDefaultApp } from './apps';
import { BLANK_CLUSTER, DEV_PRODUCT, WORKSPACES_ROUTE } from './config/constants';

// `store` is the raw Vuex store the extension manager hands to every product init, and
// $plugin.DSL takes it as `any`. There is no narrower type to reach for.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function init($plugin: IPlugin, store: any) {
  devProduct($plugin, store);
}

/**
 * The Dev product: the Claude Harness on Kubernetes.
 *
 * It owns no cluster, so it takes BLANK_CLUSTER and hides the cluster switcher.
 *
 * It registers no nav entries, because it does not use Rancher's nav: its pages are children of
 * a page template of their own which draws the sidebar (see routing/index.ts). The `product()`
 * call still matters, since that is what puts Dev in the product switcher and tells the header
 * whose page this is.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function devProduct($plugin: IPlugin, store: any) {
  const { product, basicType, virtualType } = $plugin.DSL(store, DEV_PRODUCT);

  // See the note above productOpts: `public` is honoured at runtime but not declared on
  // TypeMapProduct, so the literal is widened for the production build's sake.
  const devOpts: Record<string, unknown> = {
    icon:                'terminal',
    public:              true,
    inStore:             'management',
    weight:              99,
    showClusterSwitcher: false,
    to:                  {
      name:   WORKSPACES_ROUTE,
      params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER }
    }
  };

  product(devOpts);

  // No virtualTypes and no basicTypes for this product: its navigation is its own sidebar
  // (see components/DevSidebar.vue and pages/DevShell.vue), and registering entries that
  // nothing renders would leave two descriptions of the same list.

  // The identities the terminals run as, and the namespace holding the credentials they share.
  // Create-if-missing, so a cluster that already has them keeps what it has, and quiet, for the
  // same reason the fetch above is: this runs for every user on every load.
  ensureDevRbac().catch(() => {});

  // The workspace API, for everything that is not a person: an action with no browser and no
  // Rancher session can still ask for a workspace. Same rule as above - create if missing, quiet
  // if the person looking cannot create any of it. See ensureWorkspaceApi.
  ensureWorkspaceApi().catch(() => {});

  // The App a fresh Rancher gets, so there is a template on day one. Templates are Apps Plus
  // apps (see apps.ts); this one is what the built-in rancher template used to be. Create if
  // missing and never overwrite, so an edit made in Apps Plus is kept.
  ensureDefaultApp(store).catch(() => {});
}
