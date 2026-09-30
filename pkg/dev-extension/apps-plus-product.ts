import { IPlugin } from '@shell/core/types';
import {
  PRODUCT_NAME, BLANK_CLUSTER, APP, APP_INSTANCE, LIST_ROUTE
} from './config/types';

/**
 * One global product in the side menu, with one page under it.
 *
 * The page is the App type's list, replaced by list/appsplus.io.app.vue - Apps as the group
 * headers and their instances as the rows, the shape Cluster Explorer uses for Projects and
 * Namespaces. Instances are a configured type but not a nav entry: they are only ever reached
 * through that list, and a second entry showing the same rows ungrouped would be two
 * descriptions of one thing.
 */
// `store` is the raw Vuex store the extension manager hands to every product init, and
// $plugin.DSL takes it as `any`. There is no narrower type to reach for.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function init($plugin: IPlugin, store: any) {
  const { product, basicType, configureType } = $plugin.DSL(store, PRODUCT_NAME);

  // `inStore: 'management'` because this product owns no cluster: its CRDs live in the local
  // cluster alongside Rancher's own, which is what the management store is. `to` is where the
  // side-menu button lands, and it has to carry the blank cluster param the route declares.
  const productOpts: Record<string, unknown> = {
    icon:                'flask',
    inStore:             'management',
    removable:           false,
    showClusterSwitcher: false,
    weight:              98,
    to:                  {
      name:   LIST_ROUTE,
      params: {
        product: PRODUCT_NAME, cluster: BLANK_CLUSTER, resource: APP
      }
    }
  };

  product(productOpts);

  // showState is off for Apps because an App is a definition and has no state to show; the
  // state column in this list belongs to the instances, which do.
  configureType(APP, {
    isCreatable:              true,
    isEditable:               true,
    isRemovable:              true,
    showState:                false,
    showAge:                  false,
    canYaml:                  true,
    listCreateButtonLabelKey: 'appsPlus.action.createApp',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  configureType(APP_INSTANCE, {
    isCreatable: true,
    isEditable:  true,
    isRemovable: true,
    showState:   true,
    showAge:     true,
    canYaml:     true,
  });

  basicType([APP]);
}
