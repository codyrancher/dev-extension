<script>
import ResourceTable from '@shell/components/ResourceTable';
import { STATE, AGE } from '@shell/config/table-headers';
import { RcButton } from '@components/RcButton';
import ActionMenu from '@shell/components/ActionMenuShell.vue';
import {
  APP, APP_INSTANCE, FLEET_BUNDLE, PROVISIONING_CLUSTER
} from '../config/types';

/**
 * The Apps and Instances list: apps as group headings, their instances as the rows.
 *
 * This replaces the default table for the App type (the shell resolves list/<type>.vue), so
 * ResourceList above it still draws the masthead and the Create App button - what is here is
 * only the table.
 *
 * The shape is Cluster Explorer's Projects and Namespaces, including the part that is easy to
 * miss: an app with no instances still has to appear. A table grouped by a field can only show
 * groups that some row is in, so an empty app contributes one placeholder row whose only job
 * is to carry the group, and a slot keyed by its id renders it as a single "no instances yet"
 * cell instead of a row of blank columns.
 */
export default {
  name: 'ListAppsAndInstances',

  // ResourceList renders this with `v-bind="$data"`, which includes its own `schema` (the App
  // type) and `rows` (empty, because defining fetch() below made this component responsible
  // for loading). Left to inherit, those land on the root ResourceTable as fall-through
  // attributes and quietly override the ones bound in the template - a table wired to the
  // wrong schema and no rows, with nothing logged.
  inheritAttrs: false,

  components: {
    ResourceTable, RcButton, ActionMenu
  },

  props: {
    loading: {
      type:    Boolean,
      default: false,
    },
  },

  /**
   * Defining fetch() here is what makes this component responsible for loading everything.
   * ResourceList checks for it and, finding one, skips its own fetch of the route's resource
   * entirely - so the apps have to be fetched here too, and the `rows` prop it would
   * otherwise have filled arrives empty.
   *
   * Bundles are here because an instance's state is Fleet's answer about its bundle, and the
   * state column would otherwise be permanently pending.
   */
  async fetch() {
    await Promise.all([
      this.$store.dispatch('management/findAll', { type: APP }),
      this.$store.dispatch('management/findAll', { type: APP_INSTANCE }),
      this.$store.dispatch('management/findAll', { type: FLEET_BUNDLE }),
      // An instance that provisions its own cluster reads its state off that cluster before
      // any bundle is meaningful, so the state column needs these loaded too.
      this.$store.dispatch('management/findAll', { type: PROVISIONING_CLUSTER }).catch(() => []),
    ]);
  },

  computed: {
    instanceSchema() {
      return this.$store.getters['management/schemaFor'](APP_INSTANCE);
    },

    instances() {
      return this.$store.getters['management/all'](APP_INSTANCE);
    },

    apps() {
      return this.$store.getters['management/all'](APP);
    },

    appsByName() {
      return this.apps.reduce((acc, app) => {
        acc[app.metadata?.name] = app;

        return acc;
      }, {});
    },

    /** Apps with nothing under them, which the group-by would otherwise drop entirely. */
    emptyApps() {
      const used = new Set(this.instances.map((instance) => instance.spec?.app));

      return this.apps.filter((app) => !used.has(app.metadata?.name));
    },

    placeholderRows() {
      return this.emptyApps.map((app) => ({
        _key:             `empty-${ app.id }`,
        id:               `empty-${ app.id }`,
        mainRowKey:       app.id,
        groupById:        app.metadata?.name,
        isPlaceholder:    true,
        app,
        availableActions: [],
      }));
    },

    /**
     * Instances whose app has been deleted are dropped rather than shown under an empty
     * heading: the group header reads everything it displays off the app, and a group with no
     * app is a row nobody can act on.
     */
    tableRows() {
      const live = this.instances.filter((instance) => !!this.appsByName[instance.spec?.app]);

      return [...live, ...this.placeholderRows];
    },

    headers() {
      return [
        STATE,
        {
          name:     'name',
          labelKey: 'tableHeaders.name',
          value:    'nameDisplay',
          sort:     ['nameSort'],
        },
        {
          name:      'clusters',
          labelKey:  'appsPlus.headers.clusters',
          value:     'targetDisplay',
          sort:      ['targetDisplay'],
          dashIfEmpty: true,
        },
        {
          // Not `namespace`: ResourceTable has its own handling for a column of that name
          // and removes this one out from under us.
          name:     'targetNamespace',
          labelKey: 'appsPlus.headers.namespace',
          value:    'targetNamespace',
          sort:     ['targetNamespace'],
        },
        {
          name:     'ready',
          labelKey: 'appsPlus.headers.ready',
          value:    'readyDisplay',
          align:    'left',
          width:    80,
        },
        AGE,
      ];
    },
  },

  data() {
    return { sweep: null };
  },

  /**
   * Finish other people's deletes.
   *
   * An installation carries a finalizer so that deleting it leaves a Terminating row rather
   * than an empty space while its cluster is still being torn down, and with no controller
   * behind these CRDs something in the browser has to take that finalizer off again. This page
   * is that something: it runs the check for every terminating row, so whoever has Apps and
   * Installations open finishes the job - including for a delete somebody else started, and for
   * one whose tab was closed halfway through.
   *
   * On a timer as well as on mount because what it waits for is not this page's data: a cluster
   * finishes tearing down in Rancher, and nothing about that arrives here as an update to a row
   * we are watching. Thirty seconds is the whole cost while nothing is terminating, since the
   * sweep does no work at all when the list has no such rows.
   */
  mounted() {
    this.releaseTerminating();
    this.sweep = setInterval(() => this.releaseTerminating(), 30000);
  },

  beforeUnmount() {
    if (this.sweep) {
      clearInterval(this.sweep);
      this.sweep = null;
    }
  },

  methods: {
    /**
     * Ask each terminating installation whether it may go yet.
     *
     * Sequential rather than parallel: each one asks Rancher for its cluster and its Bundles,
     * and a list with several mid-delete would otherwise open a burst of forced reads for no
     * gain - nobody is waiting on the second one finishing a moment sooner.
     */
    async releaseTerminating() {
      for (const instance of this.instances.filter((row) => row.isTerminating)) {
        await instance.releaseWhenEmpty().catch(() => false);
      }
    },

    appFor(group) {
      return group?.rows?.[0]?.app || null;
    },

    placeholderSlot(app) {
      return `main-row:${ app.id }`;
    },

    attentionCount(group) {
      return (group?.rows || []).filter((row) => row.needsAttention).length;
    },
  },
};
</script>

<template>
  <ResourceTable
    class="apps-plus-list"
    :schema="instanceSchema"
    :headers="headers"
    :rows="tableRows"
    :loading="loading || $fetchState.pending"
    group-by="groupById"
    :groupable="true"
    group-tooltip="appsPlus.headers.app"
    key-field="_key"
  >
    <template #group-by="group">
      <div class="app-bar">
        <div
          v-trim-whitespace
          class="group-tab"
        >
          <div class="app-name">
            <router-link
              v-if="appFor(group.group)?.detailLocation"
              :to="appFor(group.group).detailLocation"
            >
              {{ appFor(group.group).nameDisplay }}
            </router-link>
            <span v-else>{{ appFor(group.group)?.nameDisplay }}</span>
            <!-- The title repeats the text because the badge is the part that clips at narrow
                 widths, and an ellipsis with no way to read the rest is a dead end. -->
            <span
              v-if="attentionCount(group.group)"
              class="attention"
              :title="t('appsPlus.list.needsAttention', { count: attentionCount(group.group) })"
            >
              {{ t('appsPlus.list.needsAttention', { count: attentionCount(group.group) }) }}
            </span>
          </div>
          <!-- One line, and the whole thing on hover. A description long enough to wrap used to
               push the group header past the row it heads and cover the installation under it. -->
          <div
            v-if="appFor(group.group)?.description"
            v-clean-tooltip="appFor(group.group).description"
            class="description text-muted text-small"
          >
            {{ appFor(group.group).description }}
          </div>
        </div>
        <div class="right mr-10">
          <rc-button
            v-if="appFor(group.group)"
            variant="secondary"
            class="mr-5"
            :to="appFor(group.group).createInstanceLocation"
          >
            {{ t('appsPlus.action.createInstance') }}
          </rc-button>
          <ActionMenu
            v-if="appFor(group.group)"
            :resource="appFor(group.group)"
            data-testid="app-actions"
            :button-aria-label="t('appsPlus.action.appActions', { name: appFor(group.group).nameDisplay })"
          />
        </div>
      </div>
    </template>

    <template #cell:name="{row}">
      <router-link
        v-if="row.detailLocation"
        :to="row.detailLocation"
      >
        {{ row.nameDisplay }}
      </router-link>
      <span v-else>{{ row.nameDisplay }}</span>
    </template>

    <template
      v-for="app in emptyApps"
      :key="app.id"
      #[placeholderSlot(app)]="{ fullColspan }"
    >
      <tr class="main-row">
        <td
          class="empty text-center"
          :colspan="fullColspan"
        >
          {{ t('appsPlus.list.noInstances') }}
        </td>
      </tr>
    </template>
  </ResourceTable>
</template>

<style lang="scss" scoped>
.apps-plus-list {
  & :deep() {
    .app-bar {
      contain: inline-size;
      display: flex;
      flex-direction: row;
      justify-content: space-between;
      align-items: center;
      // The shell sizes a group header for a single line, and anything taller spills out of the
      // row and paints over the installation underneath it - which reads as the description
      // wrapping around the row, and silently swallows the clicks meant for the links in it.
      // The description below is kept to one line, so the header fits what it is given.
      min-height: 40px;

      // The name and the description share the one line the shell gives a group header. Stacked,
      // the description hung below the row and painted over the installation under it.
      .group-tab {
        max-width: calc(100% - 260px);
        min-width: 0;
        display: flex;
        flex-direction: row;
        align-items: baseline;
        gap: 10px;
      }

      .app-name {
        display: flex;
        flex-direction: row;
        align-items: center;
        line-height: 30px;
        flex-shrink: 0;

        // The name never gives way to the badge: shrinking it force-broke "loop-web" in half,
        // and of the two the badge is the one that can afford to clip.
        > :first-child {
          flex-shrink: 0;
        }
      }

      // The full text is on the tooltip; this is the one line there is room for.
      .description {
        flex: 1;
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      // The same pair of tokens as the Warning state pill a few columns over: near-white on
      // the raw warning yellow was unreadable, and this row should not invent its own idea of
      // what a warning looks like anyway.
      .attention {
        margin-left: 10px;
        padding: 1px 8px;
        border-radius: var(--border-radius);
        background: var(--warning-badge, var(--warning-banner));
        color: var(--on-warning-banner);
        font-size: 11px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
    }

    td.empty {
      padding: 12px;
    }
  }
}
</style>
