<script>
// The Browser tab: a frame, and nothing else.
//
// There is no address bar, no Reload and no Open, and no banner explaining any of it. The tab
// exists only when there is something in it (see WorkspaceDetail, which is what decides that),
// so everything this used to say about why the frame was empty had nothing left to describe.
// Starting and stopping the browser is on the Sidecars tab, with every other sidecar's, rather
// than duplicated here.
//
// What is framed depends on the template, and the difference is not cosmetic:
//
//   - a template with a browser sidecar frames the browser, which is in the cluster with the
//     workspace. That is the only way to show a workspace served at an origin of its own: it is
//     on a development certificate nothing has accepted, and a subframe gets no certificate
//     interstitial to click through, so framing it directly shows nothing at all. Reload and an
//     address bar are the browser's own, inside the frame, which is why this has neither.
//   - a template without one frames the workspace through the apiserver's service proxy, on
//     Rancher's origin. A dashboard framed that way sends its API calls to Rancher rather than
//     to the dev server it came from, which is why the rancher template does not do this.
import {
  workspaceProxyUrl, workspaceNamespace, devFetch, clusterBase
} from '../api';

export default {
  name: 'WorkspaceBrowser',

  props: {
    workspace: {
      type:     Object,
      required: true,
    },
  },

  data() {
    return { browserPort: null, checked: false };
  },

  async fetch() {
    // Whether this workspace has a browser beside it: the rancher-dev App's Chromium container,
    // published on the Service as a port named `browser`. Read once; the Service does not change.
    const namespace = workspaceNamespace(this.workspace.name);
    const service = await devFetch(`${ clusterBase(this.workspace.cluster || 'local') }/v1/services/${ namespace }/${ namespace }`).catch(() => null);
    const port = (service?.spec?.ports || []).find((p) => p.name === 'browser');

    this.browserPort = port?.port || null;
    this.checked = true;
  },

  computed: {
    // The browser beside the workspace when there is one (its desktop, Chromium already on the
    // dev server and able to click through its certificate), else what the workspace itself
    // serves, through the apiserver's service proxy. The port and the scheme are the
    // workspace's own, written on its namespace by the App that made it.
    src() {
      if (!this.checked) {
        return '';
      }

      return this.browserPort
        ? workspaceProxyUrl(this.workspace.name, this.browserPort, 'http')
        : workspaceProxyUrl(this.workspace.name, this.workspace.port, this.workspace.scheme);
    },
  },
};
</script>

<template>
  <iframe
    v-if="src"
    class="workspace-browser"
    :src="src"
    title="What this workspace serves"
  />
  <div
    v-else
    class="workspace-browser"
  />
</template>

<style lang="scss" scoped>
  .workspace-browser {
    flex:       1 1 auto;
    min-height: 0;
    border:     0;
  }
</style>
