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
import { workspaceProxyUrl, sidecarProxyUrl } from '../api';
import { templateById, templateBrowser } from '../templates';

export default {
  name: 'WorkspaceBrowser',

  props: {
    workspace: {
      type:     Object,
      required: true,
    },
  },

  computed: {
    template() {
      return templateById(this.workspace.template);
    },

    /** The browser this frames, when the template has one. */
    browser() {
      return templateBrowser(this.template);
    },

    src() {
      if (this.browser) {
        return sidecarProxyUrl(this.workspace.name, this.browser);
      }

      return this.template ? workspaceProxyUrl(this.workspace.name, this.template.port, this.template.scheme) : '';
    },
  },
};
</script>

<template>
  <iframe
    class="workspace-browser"
    :src="src"
    title="What this workspace serves"
  />
</template>

<style lang="scss" scoped>
  .workspace-browser {
    flex:       1 1 auto;
    min-height: 0;
    border:     0;
  }
</style>
