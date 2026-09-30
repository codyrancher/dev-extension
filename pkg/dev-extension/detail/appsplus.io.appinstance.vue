<script>
import ResourceTabs from '@shell/components/form/ResourceTabs';
import SortableTable from '@shell/components/SortableTable';
import Tab from '@shell/components/Tabbed/Tab';
import { Banner } from '@components/Banner';
import { RcButton } from '@components/RcButton';
import {
  FLEET_BUNDLE, FLEET_BUNDLE_DEPLOYMENT, APP, PROVISIONING_CLUSTER, REGISTRATION_TOKEN, steveType
} from '../config/types';
import { undeclaredWarnings } from '../render';

/**
 * What one instance actually deployed, and what Fleet says about it.
 *
 * The rendered YAML is recomputed from the app rather than read back off the Bundle, so a
 * template edited since the last deploy shows as what would be deployed. The Bundle summary
 * beside it is the other half of that: what is on the clusters right now.
 */
export default {
  name: 'DetailAppInstance',

  components: {
    ResourceTabs, Tab, Banner, RcButton, SortableTable
  },

  props: {
    value: {
      type:     Object,
      required: true,
    },
  },

  data() {
    return { registrationToken: null };
  },

  async fetch() {
    await Promise.all([
      this.$store.dispatch('management/findAll', { type: APP }),
      this.$store.dispatch('management/findAll', { type: FLEET_BUNDLE }),
      this.$store.dispatch('management/findAll', { type: FLEET_BUNDLE_DEPLOYMENT }).catch(() => []),
      this.$store.dispatch('management/findAll', { type: PROVISIONING_CLUSTER }).catch(() => []),
    ]);

    // A custom cluster is joined by running a command on a machine, and Rancher publishes it
    // on a token in the management cluster's own namespace. Only worth fetching once there is
    // a cluster to join.
    const namespace = this.value.managementClusterNamespace;

    if (namespace) {
      const tokens = await this.$store
        .dispatch('management/findAll', { type: REGISTRATION_TOKEN })
        .catch(() => []);

      this.registrationToken = tokens
        .find((token) => token.metadata?.namespace === namespace) || null;
    }
  },

  computed: {
    resources() {
      return this.value.renderedResources || [];
    },

    /**
     * What this installation was asked, and how it answered: each of the app's declared values
     * with its default and the override made here, plus any override for a value the app no
     * longer declares - those substitute into nothing and deserve to be visible, not silent.
     */
    valueRows() {
      const app = this.value.app;
      const defaults = app?.spec?.values || {};
      const labels = app?.spec?.valueLabels || {};
      const overrides = this.value.spec?.values || {};
      const names = new Set([...Object.keys(defaults), ...Object.keys(overrides)]);

      return [...names].sort().map((name) => ({
        name,
        label:    labels[name] || '',
        default:  defaults[name],
        override: overrides[name],
      }));
    },

    /** See the app detail page: templates using `${...}` the app never declared. */
    undeclared() {
      return undeclaredWarnings(this.value.app);
    },

    /**
     * The banner explains the same condition the state pill beside it shows, so it wears the
     * same colour: a yellow Warning next to a calm blue explanation reads as two opinions.
     */
    stateBannerColor() {
      const state = this.value.state;

      if (state === 'error') {
        return 'error';
      }

      return state === 'warning' ? 'warning' : 'info';
    },

    /**
     * Deployed resources, each with a link to the cluster it is on.
     *
     * Fleet reports a cluster by the name of its provisioning.cattle.io Cluster, while the
     * explorer is addressed by the management cluster id, so the two have to be matched up
     * here - `status.clusterName` on the provisioning cluster is that id.
     */
    deployedHeaders() {
      return [
        {
          name: 'state', labelKey: 'appsPlus.deployed.state', value: 'stateLabel', width: 125, sort: ['ready', 'kind', 'name']
        },
        {
          name: 'kind', labelKey: 'appsPlus.deployed.kind', value: 'kind', sort: ['kind', 'name']
        },
        {
          name: 'name', labelKey: 'appsPlus.deployed.name', value: 'name', sort: ['name']
        },
        {
          name: 'namespace', labelKey: 'appsPlus.deployed.namespace', value: 'namespace', sort: ['namespace', 'name']
        },
        {
          name: 'cluster', labelKey: 'appsPlus.deployed.cluster', value: 'clusterName', sort: ['clusterName', 'name']
        },
      ];
    },

    deployedRows() {
      let clusters = [];

      try {
        clusters = this.$store.getters['management/all'](PROVISIONING_CLUSTER) || [];
      } catch {
        clusters = [];
      }

      const idByName = {};

      clusters.forEach((cluster) => {
        const id = cluster.status?.clusterName;

        if (id) {
          idByName[cluster.metadata?.name] = id;
        }
      });

      return this.value.deployedResources.map((row) => {
        const id = idByName[row.clusterName];
        const resource = steveType({ apiVersion: row.apiVersion, kind: row.kind });
        // A namespaced resource and a cluster-scoped one are different routes in the explorer,
        // and the resource is only addressable at all once its cluster has a management id.
        const to = !id ? null : row.namespace ? {
          name:   'c-cluster-product-resource-namespace-id',
          params: {
            cluster: id, product: 'explorer', resource, namespace: row.namespace, id: row.name
          },
        } : {
          name:   'c-cluster-product-resource-id',
          params: {
            cluster: id, product: 'explorer', resource, id: row.name
          },
        };

        return {
          ...row,
          to,
          stateLabel: row.ready ? this.t('appsPlus.deployed.ready') : this.t('appsPlus.deployed.notReady'),
          clusterTo:  id ? { name: 'c-cluster-explorer', params: { cluster: id } } : null,
        };
      });
    },

    cluster() {
      return this.value.provisionedCluster;
    },

    /** The command that joins a machine to a custom cluster, once Rancher has published one. */
    nodeCommand() {
      return this.registrationToken?.status?.nodeCommand || null;
    },
  },
};
</script>

<template>
  <div>
    <Banner
      v-if="value.stateDescription"
      :color="stateBannerColor"
      :label="value.stateDescription"
    />

    <div
      v-if="value.provisionsCluster"
      class="cluster-panel mb-20"
    >
      <div class="cluster-panel__head">
        <h3>{{ t('appsPlus.instance.ownedCluster') }}</h3>
        <router-link
          v-if="cluster?.detailLocation"
          :to="cluster.detailLocation"
        >
          {{ value.clusterName }}
        </router-link>
        <span
          v-else
          class="text-muted"
        >{{ value.clusterName }}</span>
      </div>

      <Banner
        v-if="!value.clusterReady"
        color="warning"
        :label="t('appsPlus.instance.clusterNotReady')"
      />

      <template v-if="nodeCommand && value.needsNodesRegistered">
        <p class="text-muted">
          {{ t('appsPlus.instance.registrationHint') }}
        </p>
        <pre class="rendered__body">{{ nodeCommand }}</pre>
      </template>
    </div>

    <ResourceTabs
      :value="value"
      :need-events="false"
      :need-related="false"
    >
      <Tab
        v-if="value.provisionsCluster"
        name="cluster"
        :label="t('appsPlus.instance.clusterPreview')"
        :weight="11"
      >
        <div class="rendered">
          <div class="rendered__name">
            {{ value.clusterName }}
          </div>
          <pre class="rendered__body">{{ value.renderedClusterTemplate }}</pre>
        </div>
      </Tab>

      <Tab
        name="deployed"
        :label="t('appsPlus.instance.deployed')"
        :weight="10.7"
      >
        <SortableTable
          v-if="deployedRows.length"
          :rows="deployedRows"
          :headers="deployedHeaders"
          key-field="key"
          default-sort-by="kind"
          :table-actions="false"
          :row-actions="false"
          :paging="true"
        >
          <template #cell:state="{row}">
            <span :class="row.ready ? 'deployed__state--ready' : 'deployed__state--not'">
              {{ row.stateLabel }}
            </span>
            <div
              v-if="row.message"
              class="text-muted text-small"
            >
              {{ row.message }}
            </div>
          </template>

          <template #cell:name="{row}">
            <router-link
              v-if="row.to"
              :to="row.to"
            >
              {{ row.name }}
            </router-link>
            <span v-else>{{ row.name }}</span>
          </template>

          <template #cell:namespace="{row}">
            <span v-if="row.namespace">{{ row.namespace }}</span>
            <span
              v-else
              class="text-muted"
            >&mdash;</span>
          </template>

          <template #cell:cluster="{row}">
            <router-link
              v-if="row.clusterTo"
              :to="row.clusterTo"
            >
              {{ row.clusterName }}
            </router-link>
            <span v-else>{{ row.clusterName }}</span>
          </template>
        </SortableTable>
        <Banner
          v-else
          color="info"
          :label="t('appsPlus.deployed.none')"
        />
      </Tab>

      <Tab
        name="values"
        :label="t('appsPlus.instance.values')"
        :weight="10.5"
        :error="!!undeclared.length"
      >
        <Banner
          v-for="reference in undeclared"
          :key="reference.file"
          color="warning"
        >
          {{ t('appsPlus.values.undeclared', reference) }}
          <router-link
            v-if="value.app?.editLocation"
            :to="value.app.editLocation"
          >
            {{ t('appsPlus.values.undeclaredDeclareEdit', { app: value.app.nameDisplay }) }}
          </router-link>
        </Banner>
        <table
          v-if="valueRows.length"
          class="values-table"
        >
          <thead>
            <tr>
              <th>{{ t('appsPlus.values.key') }}</th>
              <th>{{ t('appsPlus.values.default') }}</th>
              <th>{{ t('appsPlus.values.override') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in valueRows"
              :key="row.name"
            >
              <td>
                <div
                  v-if="row.label"
                  class="values-table__label"
                >
                  {{ row.label }}
                </div>
                <code>{{ row.name }}</code>
              </td>
              <td>
                <span v-if="String(row.default ?? '').trim() !== ''">{{ row.default }}</span>
                <span
                  v-else
                  class="text-muted"
                >—</span>
              </td>
              <td>
                <span v-if="String(row.override ?? '').trim() !== ''">{{ row.override }}</span>
                <span
                  v-else
                  class="text-muted"
                >—</span>
              </td>
            </tr>
          </tbody>
        </table>
        <!-- See the app detail page: "declares no values" must not sit under a warning that
             just said a template refers to one. -->
        <Banner
          v-else-if="!undeclared.length"
          color="info"
          :label="t('appsPlus.values.none')"
        />
      </Tab>

      <Tab
        name="resources"
        :label="t('appsPlus.instance.preview')"
        :weight="10"
      >
        <div
          v-for="file in resources"
          :key="file.name"
          class="rendered"
        >
          <div class="rendered__name">
            {{ file.name }}
          </div>
          <pre class="rendered__body">{{ file.content }}</pre>
        </div>
        <Banner
          v-if="!resources.length"
          color="warning"
          :label="t('appsPlus.app.noTemplates')"
        />
      </Tab>
    </ResourceTabs>
  </div>
</template>

<style lang="scss" scoped>
.deployed__state {
  font-weight: 600;
}

.deployed__state--ready {
  color: var(--success);
}

.deployed__state--not {
  color: var(--warning);
}

.cluster-panel {
  border: 1px solid var(--border);
  border-radius: var(--border-radius);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;

  &__head {
    display: flex;
    align-items: baseline;
    gap: 10px;

    h3 {
      margin: 0;
      font-size: 14px;
    }
  }
}

.rendered {
  margin-bottom: 16px;

  &__name {
    font-family: monospace;
    font-size: 12px;
    padding: 6px 10px;
    background: var(--nav-bg);
    border: 1px solid var(--border);
    border-bottom: none;
    border-radius: var(--border-radius) var(--border-radius) 0 0;
  }

  &__body {
    margin: 0;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: 0 0 var(--border-radius) var(--border-radius);
    overflow-x: auto;
  }
}

.values-table {
  border-collapse: collapse;
  min-width: 50%;

  th {
    text-align: left;
    font-weight: 600;
    font-size: 12px;
    color: var(--muted);
    padding: 6px 24px 6px 0;
    border-bottom: 1px solid var(--border);
  }

  td {
    padding: 8px 24px 8px 0;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }

  &__label {
    font-weight: 600;
  }
}
</style>
