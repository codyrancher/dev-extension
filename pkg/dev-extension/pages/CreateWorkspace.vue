<script>
// Create a workspace: a name, an Apps Plus app to make it from, and a cluster to put it on.
//
// The app list is Apps Plus's own. There is no template of this product's to pick from any
// more - see apps.ts - so what is offered here is every App in the cluster, with a link to
// where one is made or changed. A workspace of an App is an Installation of it, which is why
// the banner below the form says so rather than naming an image.
import AsyncButton from '@shell/components/AsyncButton';
import LabeledSelect from '@shell/components/form/LabeledSelect';
import { LabeledInput } from '@components/Form/LabeledInput';
import { Banner } from '@components/Banner';
import { RcButton } from '@components/RcButton';
import {
  createWorkspace, workspaceNameError, workspaceNamespace, listClusters, readableBytes
} from '../api';
import { listApps, appsPlusAvailable } from '../apps';
import { readPrefs, shownApps } from '../prefs';
import {
  DEV_PRODUCT, BLANK_CLUSTER, WORKSPACES_ROUTE, WORKSPACE_ROUTE, DEFAULT_APP, APP
} from '../config/constants';

export default {
  name: 'DevCreateWorkspace',

  components: {
    AsyncButton, LabeledSelect, LabeledInput, Banner, RcButton
  },

  async fetch() {
    const [clusters, apps, prefs] = await Promise.all([
      listClusters().catch(() => []),
      listApps(this.$store).catch((e) => {
        this.appsError = e.message || String(e);

        return [];
      }),
      readPrefs().catch(() => ({ hiddenApps: [] })),
    ]);

    this.clusters = clusters;
    // The ones this person kept (Settings), plus whichever a link asked for by name.
    const asked = this.$route.query.app || this.$route.query.template;

    // Workspace apps only: a build or a browser is not something to create a workspace of.
    this.apps = shownApps(apps, prefs).concat(apps.filter((app) => app.id === asked && prefs.hiddenApps.includes(app.id))).filter((app) => app.workspace);

    const askedCluster = this.$route.query.cluster;
    const known = (id) => this.clusters.some((entry) => entry.id === id) && id;

    this.cluster = known(askedCluster) || known('local') || this.clusters[0]?.id || 'local';

    // `app` is the query the sidebar and My Work send; `template` is what older links said.
    const askedApp = this.$route.query.app || this.$route.query.template;
    const knownApp = (id) => this.apps.some((app) => app.id === id) && id;

    this.app = knownApp(askedApp) || knownApp(DEFAULT_APP) || this.apps[0]?.id || '';
  },

  data() {
    return {
      name:      String(this.$route.query.name || ''),
      clusters:  [],
      cluster:   'local',
      rancherUrl: '',
      apps:      [],
      app:       '',
      appsError: '',
      error:     '',
      touched:   false,
      cancelTo:  { name: WORKSPACES_ROUTE, params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER } },
    };
  },

  computed: {
    appsPlus() {
      return appsPlusAvailable(this.$store);
    },

    appOptions() {
      return this.apps.map((app) => ({
        value: app.id,
        label: app.description ? `${ app.label } - ${ app.description.slice(0, 80) }` : app.label,
      }));
    },

    clusterOptions() {
      return this.clusters.map((entry) => ({
        value: entry.id,
        label: `${ entry.name } (MEM ${ readableBytes(entry.memoryFree) }, DSK ${ readableBytes(entry.diskFree) })`,
      }));
    },

    nameError() {
      return workspaceNameError(this.name);
    },

    shownNameError() {
      return this.touched ? this.nameError : '';
    },

    selected() {
      return this.apps.find((app) => app.id === this.app) || null;
    },

    namespace() {
      return this.nameError ? '' : workspaceNamespace(this.name);
    },

    /** Where Apps Plus lists its apps: the place a template is made or changed. */
    appsTo() {
      return {
        name:   'c-cluster-product-resource',
        params: {
          product: 'fleet', cluster: BLANK_CLUSTER, resource: APP
        },
      };
    },
  },

  watch: {
    name() {
      this.error = '';
    },
  },

  methods: {
    async create(done) {
      this.touched = true;
      this.error = '';

      if (this.nameError) {
        done(false);

        return;
      }

      if (!this.app) {
        this.error = 'Pick an Apps Plus app to make the workspace from.';
        done(false);

        return;
      }

      try {
        await createWorkspace(this.$store, this.name, this.app, this.cluster, this.rancherUrl.trim() ? { rancherUrl: this.rancherUrl.trim().replace(/\/$/, '') } : {});
        this.$router.push({
          name:   WORKSPACE_ROUTE,
          params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER, workspace: this.name },
        });
        done(true);
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },
  },
};
</script>

<template>
  <div class="dev-create">
    <header>
      <h1>Create Workspace</h1>
      <p class="subheader">
        A workspace is an installation of an Apps Plus app. The app says what runs;
        <router-link :to="appsTo">
          Apps Plus
        </router-link>
        is where one is made or changed.
      </p>
    </header>

    <Banner
      v-if="error"
      color="error"
      :label="error"
    />

    <Banner
      v-if="!appsPlus"
      color="warning"
      label="Apps Plus is not installed in this Rancher, and it is what holds workspace templates. Install the apps-plus extension and reload."
    />
    <Banner
      v-else-if="appsError"
      color="error"
      :label="`Could not read the apps: ${ appsError }`"
    />
    <Banner
      v-else-if="!$fetchState.pending && !apps.length"
      color="info"
    >
      There are no Apps Plus apps yet, so there is nothing to make a workspace from.
      <router-link :to="appsTo">
        Make one in Apps Plus
      </router-link>.
    </Banner>

    <div class="dev-create__form">
      <LabeledInput
        v-model:value="name"
        label="Workspace name"
        :required="true"
        placeholder="my-workspace"
        @blur="touched = true"
      />

      <LabeledSelect
        v-model:value="app"
        label="App"
        :options="appOptions"
        option-label="label"
        option-key="value"
        :reduce="(entry) => entry.value"
        :clearable="false"
        :disabled="!apps.length"
      />

      <!--
        The Rancher the workspace's dev server talks to. Empty is the one this cluster belongs
        to; a team's shared Rancher goes here when the infrastructure is kept apart from the
        tools, which is the usual arrangement. Only the apps that declare a rancherUrl value use
        it; the rest ignore it.
      -->
      <LabeledInput
        v-model:value="rancherUrl"
        label="Rancher URL (optional)"
        placeholder="https://rancher.example.com - empty means the one this cluster belongs to"
      />

      <!--
        Which cluster hosts it. The free memory and disk are beside each name because that is the
        question somebody is actually answering: not which cluster, but which one has room for a
        checkout, an install and a compile.
      -->
      <LabeledSelect
        v-model:value="cluster"
        label="Cluster"
        :options="clusterOptions"
        option-label="label"
        option-key="value"
        :reduce="(entry) => entry.value"
        :clearable="false"
      />
    </div>

    <Banner
      v-if="shownNameError"
      color="error"
      :label="shownNameError"
    />
    <Banner
      v-else-if="namespace && selected && !error"
      color="info"
      :label="`Installs ${ selected.label } as ${ name } on ${ cluster }, in the namespace ${ namespace }.`"
    />

    <div class="dev-create__actions">
      <RcButton
        variant="secondary"
        :to="cancelTo"
      >
        Cancel
      </RcButton>
      <AsyncButton
        mode="create"
        :disabled="!name || !app"
        @click="create"
      />
    </div>
  </div>
</template>

<style lang="scss" scoped>
  .dev-create {
    padding: var(--dev-space-5);

    header {
      margin-bottom: var(--dev-space-5);
    }

    .subheader {
      color: var(--muted);
    }

    &__form {
      display:        flex;
      flex-direction: column;
      gap:            var(--dev-space-4);
      max-width:      640px;
      margin-bottom:  var(--dev-space-4);
    }

    &__actions {
      display:         flex;
      justify-content: flex-end;
      gap:             var(--dev-space-3);
      max-width:       640px;
      margin-top:      var(--dev-space-4);
    }
  }
</style>
