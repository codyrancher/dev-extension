<script>
import AppModal from '@shell/components/AppModal';
import LabeledSelect from '@shell/components/form/LabeledSelect';
import { Banner } from '@components/Banner';
import { RcButton } from '@components/RcButton';
import { importResource } from '../import-resource';
import { PROVISIONING_CLUSTER } from '../config/types';

/**
 * Import a live resource from any cluster as a template.
 *
 * Three questions in order, because each one narrows the next: which cluster, which type, which
 * resource. Nothing is fetched until the question before it is answered, so opening this costs
 * one list of clusters.
 *
 * ---------------------------------------------------------------------------
 * Why this fetches rather than using the store.
 *
 * The store's `cluster/` namespace holds one cluster - whichever the dashboard has in scope -
 * and this product declares `inStore: 'management'` because it owns none. So there is no
 * cluster store to ask, and asking for one would mean switching the dashboard's current cluster
 * out from under whoever is on this page. Rancher proxies every cluster at
 * `/k8s/clusters/<id>/v1/...` same-origin, and the browser sends the session with it, so a
 * plain fetch reaches any cluster the person can already reach - and reaches none they cannot,
 * because it is their session doing the reading.
 */
export default {
  name: 'ImportResourceModal',

  components: {
    AppModal, LabeledSelect, Banner, RcButton
  },

  props: {
    /**
     * Value names the app already uses, so an import can pick one nobody has claimed. Two
     * Deployments both parameterised to `${image}` is one install field setting both.
     */
    takenValues: {
      type:    Array,
      default: () => [],
    },
  },

  emits: ['close', 'imported'],

  async fetch() {
    // Every cluster Rancher manages, plus the local one, which is not a provisioning Cluster.
    const provisioned = await this.$store
      .dispatch('management/findAll', { type: PROVISIONING_CLUSTER })
      .catch(() => []);

    this.clusters = [
      { label: 'local', value: 'local' },
      ...provisioned
        .filter((cluster) => cluster.status?.clusterName && cluster.status.clusterName !== 'local')
        .map((cluster) => ({ label: cluster.metadata.name, value: cluster.status.clusterName })),
    ];
  },

  data() {
    return {
      clusters:  [],
      types:     [],
      resources: [],
      cluster:   'local',
      type:      null,
      resource:  null,
      loading:   false,
      error:     '',
    };
  },

  watch: {
    cluster() {
      this.type = null;
      this.resource = null;
      this.types = [];
      this.resources = [];
      this.loadTypes();
    },

    type() {
      this.resource = null;
      this.resources = [];
      this.loadResources();
    },
  },

  mounted() {
    this.loadTypes();
  },

  computed: {
    canImport() {
      return !!this.resource && !this.loading;
    },
  },

  methods: {
    /** One call to a cluster, as the person who is signed in. */
    async proxy(path) {
      const response = await fetch(`/k8s/clusters/${ this.cluster }/v1/${ path }`, {
        headers: { accept: 'application/json' }, credentials: 'same-origin',
      });

      if (!response.ok) {
        throw new Error(`${ response.status } from ${ path }`);
      }

      return response.json();
    },

    /**
     * The types worth offering.
     *
     * Everything a cluster has is 150-odd schemas, most of which nobody would put in an app.
     * The filter is deliberately about shape rather than a hard-coded list: a type that is
     * namespaced, can be listed and can be created is a type somebody could reasonably deploy,
     * and that includes CRDs this has never heard of, which a hard-coded list never would.
     */
    async loadTypes() {
      if (!this.cluster) {
        return;
      }

      this.loading = true;
      this.error = '';

      try {
        const schemas = await this.proxy('schemas');

        this.types = (schemas.data || [])
          .filter((schema) => (
            schema.attributes?.namespaced &&
            (schema.collectionMethods || []).includes('GET') &&
            (schema.collectionMethods || []).includes('POST')
          ))
          // The kind leads and the Steve id stays secondary: this list is the one no-YAML way
          // in, and "Deployment" is what somebody knows their resource as - `apps.deployment`
          // asks them to know API group naming first. The id still disambiguates the kinds
          // that exist in more than one group, and the label carries both so search matches
          // either.
          .map((schema) => ({
            label: `${ schema.attributes?.kind || schema.id } (${ schema.id })`,
            kind:  schema.attributes?.kind || schema.id,
            id:    schema.id,
            value: schema.id,
          }))
          .sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
      } catch (e) {
        this.error = `Could not read that cluster: ${ e.message }`;
      } finally {
        this.loading = false;
      }
    },

    async loadResources() {
      if (!this.type) {
        return;
      }

      this.loading = true;
      this.error = '';

      try {
        const list = await this.proxy(this.type);

        this.resources = (list.data || [])
          .map((item) => ({ label: item.id, value: item.id }))
          .sort((a, b) => a.label.localeCompare(b.label));
      } catch (e) {
        this.error = `Could not list ${ this.type }: ${ e.message }`;
      } finally {
        this.loading = false;
      }
    },

    /**
     * Fetch the one resource and hand back what it becomes.
     *
     * Read again by id rather than reusing the row from the list: a collection is allowed to
     * return a trimmed object, and importing a trimmed Deployment would produce a template
     * missing whatever the list happened to leave out.
     */
    async importSelected() {
      this.loading = true;
      this.error = '';

      try {
        const full = await this.proxy(`${ this.type }/${ this.resource }`);

        this.$emit('imported', importResource(full, this.takenValues));
        this.$emit('close');
      } catch (e) {
        this.error = `Could not import that resource: ${ e.message }`;
      } finally {
        this.loading = false;
      }
    },
  },
};
</script>

<template>
  <AppModal
    :width="640"
    name="import-resource"
    @close="$emit('close')"
  >
    <div class="import">
      <h4 class="import__title">
        {{ t('appsPlus.import.title') }}
      </h4>

      <Banner
        color="info"
        :label="t('appsPlus.import.hint')"
      />

      <LabeledSelect
        v-model:value="cluster"
        class="mb-10"
        :options="clusters"
        :label="t('appsPlus.import.cluster')"
      />

      <LabeledSelect
        v-model:value="type"
        class="mb-10"
        :options="types"
        :searchable="true"
        :disabled="!types.length"
        :label="t('appsPlus.import.type')"
      >
        <template #option="opt">
          {{ opt.kind }} <span class="import__type-id">{{ opt.id }}</span>
        </template>
        <template #selected-option="opt">
          {{ opt.kind }} <span class="import__type-id">{{ opt.id }}</span>
        </template>
      </LabeledSelect>

      <LabeledSelect
        v-model:value="resource"
        class="mb-10"
        :options="resources"
        :searchable="true"
        :disabled="!resources.length"
        :label="t('appsPlus.import.resource')"
      />

      <Banner
        v-if="error"
        color="error"
        :label="error"
      />

      <div class="import__buttons">
        <RcButton
          variant="secondary"
          @click="$emit('close')"
        >
          {{ t('generic.cancel') }}
        </RcButton>
        <RcButton
          variant="primary"
          :disabled="!canImport"
          @click="importSelected"
        >
          {{ t('appsPlus.import.action') }}
        </RcButton>
      </div>
    </div>
  </AppModal>
</template>

<style lang="scss" scoped>
.import {
  padding: 16px;

  &__title {
    margin-bottom: 12px;
  }

  &__buttons {
    display:         flex;
    justify-content: flex-end;
    gap:             8px;
    margin-top:      16px;
  }
}

// Not nested under .import: the dropdown these render in is appended to <body>, outside it.
// The scoped attribute still travels with the slot content, so this stays this component's.
.import__type-id {
  color:       var(--muted);
  font-size:   12px;
  margin-left: 6px;
}
</style>
