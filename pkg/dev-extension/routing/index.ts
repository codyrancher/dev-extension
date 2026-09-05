import { PluginRouteRecordRaw } from '@shell/core/types';
import {
  BLANK_CLUSTER,
  DEV_PRODUCT, WORKSPACES_PAGE, CREATE_PAGE, MY_WORK_PAGE, INSIGHTS_PAGE, SETTINGS_PAGE,
  DEV_SHELL_ROUTE, WORKSPACES_ROUTE, WORKSPACE_ROUTE, CREATE_ROUTE,
  MY_WORK_ROUTE, INSIGHTS_ROUTE, SETTINGS_ROUTE
} from '../config/constants';
import DevShell from '../pages/DevShell.vue';
import Workspaces from '../pages/Workspaces.vue';
import CreateWorkspace from '../pages/CreateWorkspace.vue';
import WorkspaceDetail from '../pages/WorkspaceDetail.vue';
import MyWork from '../pages/MyWork.vue';
import Insights from '../pages/Insights.vue';
import Settings from '../pages/Settings.vue';

const devMeta = { product: DEV_PRODUCT, cluster: BLANK_CLUSTER };

/**
 * The Dev product's pages, inside a page template of this product's own.
 *
 * `parent: 'blank'` is the shell's barest template, a `<main>` around a router-view, and it is
 * chosen for what it does not bring. The usual parent, `default`, renders Rancher's product
 * nav, which is the thing pages/DevShell.vue replaces; `plain` has no nav but wraps the page in
 * an IndentedPanel that is 90% wide and centred, and the two panes this product is mostly used
 * through are a terminal and an iframe that want the window. So DevShell supplies the header,
 * the sidebar and the terminal drawer itself, out of the shell's own components.
 *
 * What that costs, since it is a trade rather than a detail: Rancher's side nav is gone (that
 * is the point), and Header runs in `simple` mode, which drops the product title block at the
 * top left. The product switcher, the notifications, the user menu and this extension's own Dev
 * button are all in the part of the header that stays.
 *
 * Every page below is a child, so they share one sidebar rather than each drawing their own,
 * and their names are unchanged, so every link written against them still resolves.
 *
 * The create page is a sibling of the list rather than a child of it. Nested under
 * `workspaces/`, `create` would also match the detail route's `:workspace` param, and which of
 * the two won would come down to registration order.
 */
const devRoutes: PluginRouteRecordRaw[] = [
  {
    parent: 'blank',
    route:  {
      name:      DEV_SHELL_ROUTE,
      path:      `/${ DEV_PRODUCT }/c/:cluster`,
      component: DevShell,
      meta:      devMeta,
      children:  [
        {
          name: WORKSPACES_ROUTE, path: WORKSPACES_PAGE, component: Workspaces, meta: devMeta
        },
        {
          name: CREATE_ROUTE, path: CREATE_PAGE, component: CreateWorkspace, meta: devMeta
        },
        {
          // The tab is the hash rather than a path segment. pages/WorkspaceDetail.vue says why.
          name:      WORKSPACE_ROUTE,
          path:      `${ WORKSPACES_PAGE }/:workspace`,
          component: WorkspaceDetail,
          meta:      devMeta
        },
        // There is no terminal page. The terminal is the drawer along the bottom, opened
        // from the sidebar's terminal icon, and it stays there while you work on whatever
        // else is on screen. A page whose content was a sentence about another part of the
        // screen is the thing that was wrong with having one.
        {
          name: MY_WORK_ROUTE, path: MY_WORK_PAGE, component: MyWork, meta: devMeta
        },
        {
          name: INSIGHTS_ROUTE, path: INSIGHTS_PAGE, component: Insights, meta: devMeta
        },
        {
          name: SETTINGS_ROUTE, path: SETTINGS_PAGE, component: Settings, meta: devMeta
        },
      ],
    }
  }
];

export default devRoutes;
