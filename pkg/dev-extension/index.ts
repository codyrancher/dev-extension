import { defineAsyncComponent } from 'vue';
import { importTypes } from '@rancher/auto-import';
import { IPlugin } from '@shell/core/types';
import routes from './routing';

// Init the package
export default function(plugin: IPlugin): void {
  // Auto-import model, detail, edit from the folders
  importTypes(plugin);

  // Provide plugin metadata from package.json
  plugin.metadata = require('./package.json');

  plugin.addRoutes(routes);

  // The product module is passed whole, not its init function: addProduct treats any
  // argument with a truthy `.name` as the newer metadata API, and a named function has one.
  plugin.addProduct(require('./product'));

  // The body of a terminal tab in Rancher's window manager, the drawer along the bottom of the
  // page. The window manager resolves a tab's component by name through this registry whenever
  // the tab names an extension (see its composables/useComponentsMount.ts), which is why this
  // is registered rather than imported by whoever opens the tab.
  //
  // Async because the drawer is opened rarely and pulls xterm in with it, and because a tab is
  // resolved when it is opened rather than when the extension loads.
  plugin.register(
    'component',
    'DevTerminalTab',
    defineAsyncComponent(() => import('./components/DevTerminalTab.vue')) as unknown as Function
  );
}
