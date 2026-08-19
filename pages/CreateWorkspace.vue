<script>
// Create a workspace: a name and a template, which is exactly what the harness asks for.
//
// Not CruResource, which is the shell's form chrome for editing one Steve resource: a
// workspace is three of them created together and there is no model to hand it. The inputs,
// the banner and the buttons are still the shell's.
import AsyncButton from '@shell/components/AsyncButton';
import LabeledSelect from '@shell/components/form/LabeledSelect';
import { LabeledInput } from '@components/Form/LabeledInput';
import { Banner } from '@components/Banner';
import { RcButton } from '@components/RcButton';
import {
  createWorkspace, workspaceNameError, workspaceNamespace, listClusters, readableBytes
} from '../api';
import { TEMPLATES, templateById } from '../templates';
import {
  DEV_PRODUCT, BLANK_CLUSTER, WORKSPACES_ROUTE, WORKSPACE_ROUTE
} from '../config/constants';

export default {
  name: 'DevCreateWorkspace',

  components: {
    AsyncButton, LabeledSelect, LabeledInput, Banner, RcButton
  },

  async fetch() {
    this.clusters = await listClusters().catch(() => []);

    // The one Rancher itself runs in, where a workspace has always gone, unless it is not on the
    // list: a person with access to one downstream cluster and not to local should not have a
    // form that opens on a cluster they cannot use.
    // The sidebar links here with a cluster already chosen, the way the Templates page links
    // here with a template. An unknown one falls back rather than leaving the form pointed at a
    // cluster that is not on the list.
    const asked = this.$route.query.cluster;
    const known = (id) => this.clusters.some((entry) => entry.id === id) && id;

    this.cluster = known(asked) || known('local') || this.clusters[0]?.id || 'local';
  },

  data() {
    // The Templates page links here with a template already chosen; an unknown one in the
    // query falls back rather than leaving the select empty and the form unsubmittable.
    const asked = this.$route.query.template;

    return {
      name:     '',
      // The clusters a workspace could be hosted on, and the one it will be.
      clusters: [],
      cluster:  'local',
      template: templateById(asked)?.id || TEMPLATES[0].id,
      error:    '',
      // The name is only complained about once it has been typed in and left alone, so the
      // form does not tell someone their first keystroke is invalid.
      touched:  false,
      options:  TEMPLATES.map((template) => ({ label: template.label, value: template.id })),
      cancelTo: { name: WORKSPACES_ROUTE, params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER } },
    };
  },

  computed: {
    /**
     * The clusters, each with what is left on it, which is what the select shows.
     *
     * MEM and DSK rather than the words: the label sits in a select a third of a form wide, and
     * a cluster whose numbers are truncated is a cluster you cannot choose between.
     */
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
      return templateById(this.template);
    },

    namespace() {
      return this.nameError ? '' : workspaceNamespace(this.name);
    },
  },

  watch: {
    // The error is about the name that was submitted, so editing the name is what ends it.
    // Left standing it would go on hiding the banner that says what the new name would make,
    // until the next press of Create.
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

      try {
        await createWorkspace(this.name, this.template, this.cluster);
        // Straight to the workspace rather than back to the list: the thing worth watching
        // next is the pod coming up, and that is on the detail page.
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
    </header>

    <Banner
      v-if="error"
      color="error"
      :label="error"
    />

    <div class="dev-create__form">
      <LabeledInput
        v-model:value="name"
        label="Workspace name"
        :required="true"
        placeholder="my-workspace"
        @blur="touched = true"
      />
      <LabeledSelect
        v-model:value="template"
        label="Template"
        :options="options"
        :clearable="false"
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
    <!--
      Not while a create has failed. This banner says what the name would make and the error
      above says why it did not, so on a name that is taken the page reads "a workspace called
      delta already exists" and "creates the namespace dev-delta" at the same time.
    -->
    <Banner
      v-else-if="namespace && !error"
      color="info"
      :label="`Creates the namespace ${ namespace } on ${ cluster }, running ${ selected.image }.`"
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
        :disabled="!name"
        @click="create"
      />
    </div>
  </div>
</template>

<style lang="scss" scoped>
  .dev-create {
    // The product's pages have no padding of their own: the shell's blank template hands the
    // router-view the whole pane so that a terminal and a browser frame can fill it. A form is
    // not one of those, so it puts its own back, the same 20px the other pages use.
    overflow-y: auto;
    padding:    var(--dev-space-5);
    max-width:  760px;

    header {
      display:       block;
      margin-bottom: var(--dev-space-5);

      h1 {
        margin-bottom: 0;
      }

      .subheader {
        margin: var(--dev-space-2) 0 0 0;
        color:  var(--muted);
      }
    }

    // Three across on a wide window and one on a narrow one, rather than a fixed pair: the
    // cluster's label carries two numbers and does not fit in half of what the name gets.
    &__form {
      display:               grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap:                   var(--dev-space-5);
      margin-bottom:         var(--dev-space-5);
    }

    &__description {
      max-width: 80ch;
      color:     var(--muted);
    }

    &__actions {
      display:         flex;
      gap:             var(--dev-space-4);
      justify-content: flex-end;
      margin-top:      var(--dev-space-5);
    }
  }
</style>
