import { IPlugin } from '@shell/core/types';
import { ensureDevRbac, ensureWorkspaceApi } from './api';
import {
  PRODUCT_NAME, CUSTOM_PAGE_NAME, BLANK_CLUSTER, HOME_ROUTE,
  EXPLORER_PRODUCT, FLOOF_PAGE, FLOOF_ROUTE,
  DEV_PRODUCT, WORKSPACES_ROUTE
} from './config/constants';

// `store` is the raw Vuex store the extension manager hands to every product init, and
// $plugin.DSL takes it as `any`. There is no narrower type to reach for.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function init($plugin: IPlugin, store: any) {
  const { product, basicType, virtualType } = $plugin.DSL(store, PRODUCT_NAME);

  // `public` is what makes the product visible without a session, and the shell honours it at
  // runtime, but TypeMapProduct does not declare it. The dev build only warns; the production
  // build that `hmr: off` mode needs treats it as an error, so the literal is widened here.
  const productOpts: Record<string, unknown> = {
    icon:                'flask',
    public:              true,
    inStore:             'management',
    weight:              100,
    showClusterSwitcher: false,
    to:                  {
      name:   HOME_ROUTE,
      params: { product: PRODUCT_NAME, cluster: BLANK_CLUSTER }
    }
  };

  product(productOpts);

  virtualType({
    name:  CUSTOM_PAGE_NAME,
    label: 'Live Reload Demo',
    route: {
      name:   HOME_ROUTE,
      params: { product: PRODUCT_NAME, cluster: BLANK_CLUSTER }
    },
    weight: 100
  });

  basicType([CUSTOM_PAGE_NAME]);

  // Floof goes into Rancher's Cluster Explorer, not into this product.
  //
  // A second DSL() call scoped to 'explorer' is how an extension adds to a product it does
  // not own - the same virtualType/basicType calls, aimed at someone else's nav. `group:
  // 'Root'` puts it at the top level alongside Cluster and Workloads rather than inside a
  // resource group, matching how the shell registers its own non-resource pages.
  const explorer = $plugin.DSL(store, EXPLORER_PRODUCT);

  // `group`, `icon` and `exact` are all honoured by the nav at runtime and are what the shell's
  // own pages set, but ConfigureVirtualTypeOptions declares none of them. Spread rather than
  // written into the literal, because an excess property is an error where a spread of one is
  // not, and the production build that `hmr: off` needs treats it as an error. Same reason as
  // `public` above.
  const navOnly = { group: 'Root', icon: 'folder', exact: true } as Record<string, unknown>;

  explorer.virtualType({
    name:       FLOOF_PAGE,
    label:      'Floof',
    namespaced: false,
    weight:     99,
    route:      { name: FLOOF_ROUTE },
    ...navOnly
  });

  explorer.basicType([FLOOF_PAGE], 'Root');

  devProduct($plugin, store);
}

/**
 * The Dev product: the Claude Harness on Kubernetes.
 *
 * A second `product()` from a second DSL() call, which is how one extension registers two
 * unrelated products. It owns no cluster, so it takes BLANK_CLUSTER and hides the cluster
 * switcher, exactly as the demo product above does.
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
}
