import { importTypes } from '@rancher/auto-import';
import { IPlugin, ActionLocation } from '@shell/core/types';
import routes from './routing';
import { stageResource } from './builder/state';
import { openBuilder, toggleBuilder, restoreBuilder } from './builder/overlay';
import { initPageMarks } from './builder/page-marks';
import { ADD_TO_APP_ACTION } from './config/types';

// Init the package
export default function(plugin: IPlugin): void {
  // Auto-import model, detail, edit, list and l10n from the folders. Both products' types are
  // picked up by the one call: they are folders of one package now (see apps-plus.ts).
  importTypes(plugin);

  // Provide plugin metadata from package.json
  plugin.metadata = require('./package.json');

  plugin.addRoutes(routes);

  // The product module is passed whole, not its init function: addProduct treats any
  // argument with a truthy `.name` as the newer metadata API, and a named function has one.
  plugin.addProduct(require('./product'));

  // ── Apps Plus ─────────────────────────────────────────────────────────────────────────────
  //
  // Its own product still, rather than pages under Dev: Apps and Installations are the layer
  // Dev is built on and are worth looking at on their own terms - and the Ranchers in the Dev
  // sidebar are Installations of an App (`rancher-single`) that somebody edits here. What has
  // changed is only that installing one extension installs both.
  plugin.addProduct(require('./apps-plus-product'));

  // The builder's handle in the dashboard's own header, which is the only control that is not
  // attached to a page - the drawer it opens outlives every page, so its handle has to as well.
  plugin.addAction(ActionLocation.HEADER, {}, {
    labelKey:   'appsPlus.builder.title',
    tooltipKey: 'appsPlus.builder.title',
    icon:       'icon-archive',
    invoke:     () => toggleBuilder(),
  });

  /**
   * "Add to Application", on every resource there is: a table action is handed the selected
   * rows, so collecting eight Deployments into an App costs the same as one.
   */
  plugin.addAction(ActionLocation.TABLE, {}, {
    action:   ADD_TO_APP_ACTION,
    labelKey: 'appsPlus.builder.add',
    icon:     'icon-flask',
    multiple: true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    invoke:   (_opts: any, resources: any[]) => {
      openBuilder();

      (resources || []).forEach((resource) => stageResource(resource));
    },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  // A drawer that was open when the page was left should be open when it comes back.
  restoreBuilder();

  // The switches that appear on a staged resource's own edit page.
  initPageMarks();
}
