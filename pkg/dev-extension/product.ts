import { IPlugin } from '@shell/core/types';
import { installDevResources } from './api';
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
    // Rancher's icon font has nothing that says "dev"; this is the extension's own mark.
    svg:                 require('./assets/dev-icon.svg'),
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

  /*
   * Everything this extension needs on this cluster, in one ordered pass.
   *
   * This was four calls side by side, each quietly catching its own failure: the identities, the
   * workspace API, the shared browser, and the default template. Three of them write into
   * `dev-system` and only one created it, so on a cluster that did not have it already the order
   * they happened to run in decided whether the other two worked. See installDevResources.
   */
  installDevResources(store).catch(() => {});

}
