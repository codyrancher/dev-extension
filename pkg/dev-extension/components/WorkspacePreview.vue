<script>
// A static preview, from its own page: the link, what it was built at, and the two things to
// do with it - rebuild at the ref's current head, or take it down. See previews.ts.
import { Banner } from '@components/Banner';
import AsyncButton from '@shell/components/AsyncButton';
import { previewState, rebuildPreview, deleteWorkspace } from '../previews';
import { DEV_PRODUCT, BLANK_CLUSTER, WORKSPACES_ROUTE } from '../config/constants';

const REFRESH_MS = 8000;

export default {
  name: 'WorkspacePreview',

  components: { Banner, AsyncButton },

  props: {
    workspace: { type: Object, required: true },
  },

  async fetch() {
    await this.refresh();
  },

  data() {
    return {
      state: null, error: '', timer: null,
    };
  },

  mounted() {
    this.timer = setInterval(() => this.refresh(), REFRESH_MS);
  },

  beforeUnmount() {
    clearInterval(this.timer);
  },

  methods: {
    async refresh() {
      try {
        this.state = await previewState(this.$store, this.workspace.name.replace(/^preview-/, ''), this.workspace.cluster);
      } catch (e) {
        this.error = e.message || String(e);
      }
    },

    async rebuild(done) {
      try {
        await rebuildPreview(this.workspace.name.replace(/^preview-/, ''), this.workspace.cluster);
        await this.refresh();
        done(true);
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },

    async remove(done) {
      try {
        await deleteWorkspace(this.$store, this.workspace.name);
        done(true);
        this.$router.push({ name: WORKSPACES_ROUTE, params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER }, query: { all: null } });
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },
  },
};
</script>

<template>
  <div class="workspace-preview">
    <Banner
      v-if="error"
      color="error"
      :label="error"
    />
    <template v-if="state">
      <p>
        <span
          class="workspace-preview__state"
          :class="`workspace-preview__state--${ state.state }`"
        >{{ state.state }}</span>
        <span class="text-muted"> {{ state.detail }}</span>
      </p>
      <p v-if="state.url && state.state === 'serving'">
        <a
          :href="state.url"
          target="_blank"
          rel="noopener noreferrer"
          class="workspace-preview__link"
        >{{ state.url }}</a>
      </p>
      <dl class="workspace-preview__facts">
        <dt>Built at</dt>
        <dd><code>{{ state.ref }}</code></dd>
        <dt>Talks to</dt>
        <dd>{{ state.rancherUrl }}</dd>
      </dl>
      <p class="text-muted">
        Share the link. A reviewer opens it and logs in to that Rancher; nothing else is theirs to set up.
      </p>
      <div class="workspace-preview__actions">
        <AsyncButton
          mode="apply"
          action-label="Rebuild at current head"
          waiting-label="Restarting"
          success-label="Rebuilding"
          size="sm"
          @click="rebuild"
        />
        <AsyncButton
          mode="delete"
          action-label="Remove preview"
          waiting-label="Removing"
          success-label="Removed"
          size="sm"
          @click="remove"
        />
      </div>
    </template>
  </div>
</template>

<style lang="scss" scoped>
  .workspace-preview {
    padding: var(--dev-space-5);

    &__state {
      padding:        1px 8px;
      border-radius:  12px;
      font-size:      11px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      background:     var(--warning-banner-bg);
      color:          var(--warning);

      &--serving { background: var(--success-banner-bg); color: var(--success); }
      &--failed  { background: var(--error-banner-bg);   color: var(--error); }
    }

    &__link { font-size: 16px; font-weight: 600; word-break: break-all; }

    &__facts {
      display:               grid;
      grid-template-columns: max-content 1fr;
      gap:                   var(--dev-space-2) var(--dev-space-4);
      margin:                var(--dev-space-4) 0;

      dt { color: var(--muted); }
      dd { margin: 0; }
    }

    &__actions { display: flex; gap: var(--dev-space-3); }
  }
</style>
