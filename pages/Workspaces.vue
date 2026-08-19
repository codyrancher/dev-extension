<script>
// The workspaces list: the harness's home page, on Kubernetes.
//
// The rows are plain objects rather than Steve models, so this is SortableTable directly
// instead of ResourceTable: there is no single schema behind a workspace (it is a namespace
// joined to a Deployment) and nothing for ResourceTable's schema-driven columns to read.
// Everything else about the table is the shell's, including the state badge and the live age.
import SortableTable from '@shell/components/SortableTable';
import Loading from '@shell/components/Loading';
import { Banner } from '@components/Banner';
import { RcButton } from '@components/RcButton';
import ConfirmDeleteWorkspace from '../components/ConfirmDeleteWorkspace.vue';
import { listAllWorkspaces, setWorkspaceRunning } from '../api';
import { lastWorkspace, lastTab } from '../recent';
import {
  DEV_PRODUCT, BLANK_CLUSTER, WORKSPACE_ROUTE, CREATE_ROUTE, DEFAULT_WORKSPACE_TAB
} from '../config/constants';

// How often the list re-reads the cluster. Workspaces change state without anything on this
// page doing it (a pull finishes, a pod crashes), and Steve's websocket only carries
// resources the store is watching, which these are not.
const REFRESH_MS = 5000;

export default {
  name: 'DevWorkspaces',

  components: {
    SortableTable, Loading, Banner, RcButton, ConfirmDeleteWorkspace
  },

  async fetch() {
    this.rows = await listAllWorkspaces();

    // Straight through to a workspace. This page is the product's landing route, so pressing Dev
    // in Rancher's rail arrives here, and what somebody wants on arriving is a workspace rather
    // than a list of them: the one they were in, or failing that the first one there is.
    //
    // Which leaves this list on screen in exactly one case, which is the one it is useful in:
    // there are no workspaces yet, and what it shows is how to make one.
    //
    // `replace` rather than `push`, so Back goes where it went before rather than bouncing off
    // this page and being redirected again.
    // Unless it was asked for. The redirect makes the landing route useful and would otherwise
    // make this page unreachable, and it is the only place a workspace can be stopped: a
    // crash-looping one is exactly when somebody needs it. The sidebar's template heading links
    // here with this, which is the way back in.
    const asked = this.$route.query.all !== undefined;
    const last = lastWorkspace();
    const going = asked ? null : (this.rows.find((row) => row.name === last) || this.rows[0]);

    if (going) {
      this.$router.replace({
        name:   WORKSPACE_ROUTE,
        params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER, workspace: going.name },
        hash:   `#${ lastTab() || DEFAULT_WORKSPACE_TAB }`,
      });
    }
  },

  data() {
    return {
      rows:         [],
      error:        '',
      // The workspace a delete has been asked for, and is waiting on a confirmation for.
      deleting:     null,
      // Names with a start or stop in flight, so their buttons cannot be pressed twice
      // before the list has caught up with the first press.
      busy:         [],
      refreshTimer: null,
      createTo:     { name: CREATE_ROUTE, params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER } },
      headers:      [
        {
          name:          'state',
          label:         'State',
          value:         'state',
          sort:          ['state', 'name'],
          formatter:     'BadgeStateFormatter',
          // `arbitrary` is what lets the formatter colour a bare string; without it it wants
          // a Steve model with a stateBackground of its own.
          formatterOpts: { arbitrary: true },
          width:         120,
        },
        {
          name: 'name', label: 'Name', value: 'name', sort: ['name']
        },
        {
          name: 'template', label: 'Template', value: 'templateLabel', sort: ['templateLabel', 'name']
        },
        {
          name: 'namespace', label: 'Namespace', value: 'namespace', sort: ['namespace']
        },
        {
          name:      'age',
          label:     'Age',
          value:     'createdAt',
          sort:      ['createdAt:desc'],
          formatter: 'LiveDate',
          width:     100,
        },
        {
          name: 'actions', label: '', align: 'right', width: 230
        },
      ],
    };
  },

  mounted() {
    this.refreshTimer = setInterval(() => this.refresh(), REFRESH_MS);
  },

  beforeUnmount() {
    clearInterval(this.refreshTimer);
  },

  methods: {
    workspaceTo(workspace) {
      return {
        name:   WORKSPACE_ROUTE,
        params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER, workspace: workspace.name },
      };
    },

    // The poll, deliberately quieter than $fetch: a failure here is usually a request that
    // raced a page change, and replacing the table with an error because one poll missed
    // would be worse than showing the previous rows for another five seconds.
    async refresh() {
      try {
        this.rows = await listAllWorkspaces();
      } catch { /* the next poll will say if it is more than a blip */ }
    },

    isBusy(workspace) {
      return this.busy.includes(workspace.name);
    },

    async run(workspace, action) {
      this.error = '';
      this.busy = [...this.busy, workspace.name];

      try {
        await action();
        await this.refresh();
      } catch (e) {
        this.error = e.message || String(e);
      } finally {
        this.busy = this.busy.filter((name) => name !== workspace.name);
      }
    },

    start(workspace) {
      return this.run(workspace, () => setWorkspaceRunning(workspace.name, true));
    },

    stop(workspace) {
      return this.run(workspace, () => setWorkspaceRunning(workspace.name, false));
    },

    // Deleting a workspace deletes its namespace, which is not something to do on a stray
    // click, so it is asked about by name first.
    confirmDelete(workspace) {
      this.error = '';
      this.deleting = workspace;
    },

    onDeleted() {
      this.deleting = null;
      this.refresh();
    },

    onDeleteError(message) {
      this.deleting = null;
      this.error = message;
    },
  },
};
</script>

<template>
  <Loading v-if="$fetchState.pending" />
  <div
    v-else
    class="dev-workspaces"
  >
    <header>
      <div>
        <h1>Workspaces</h1>
        <p class="subheader">
          Every workspace is a namespace with a Deployment and a Service in it. Starting and
          stopping scales that Deployment; deleting removes the namespace.
        </p>
      </div>
      <RcButton
        variant="primary"
        :to="createTo"
      >
        Create
      </RcButton>
    </header>

    <Banner
      v-if="$fetchState.error"
      color="error"
      :label="`Could not list workspaces: ${ $fetchState.error }`"
    />
    <Banner
      v-else-if="error"
      color="error"
      :label="error"
    />

    <SortableTable
      :headers="headers"
      :rows="rows"
      key-field="name"
      default-sort-by="name"
      :table-actions="false"
      :row-actions="false"
      :paging="true"
    >
      <template #cell:name="{ row }">
        <router-link :to="workspaceTo(row)">
          {{ row.name }}
        </router-link>
      </template>

      <template #cell:actions="{ row }">
        <div class="dev-workspaces__actions">
          <RcButton
            v-if="row.state === 'stopped'"
            variant="tertiary"
            size="small"
            left-icon="play"
            :disabled="isBusy(row)"
            @click="start(row)"
          >
            Start
          </RcButton>
          <RcButton
            v-else
            variant="tertiary"
            size="small"
            left-icon="pause"
            :disabled="isBusy(row) || row.state === 'removing'"
            @click="stop(row)"
          >
            Stop
          </RcButton>
          <RcButton
            variant="tertiary"
            size="small"
            left-icon="terminal"
            :to="workspaceTo(row)"
          >
            Open
          </RcButton>
          <RcButton
            variant="tertiary"
            size="small"
            left-icon="trash"
            :disabled="row.state === 'removing'"
            @click="confirmDelete(row)"
          >
            Delete
          </RcButton>
        </div>
      </template>

      <template #no-rows>
        <tr>
          <td :colspan="headers.length">
            <span class="text-muted">There are no workspaces yet. Create one to get started.</span>
          </td>
        </tr>
      </template>
    </SortableTable>

    <ConfirmDeleteWorkspace
      v-if="deleting"
      :workspace="deleting"
      @close="deleting = null"
      @deleted="onDeleted"
      @error="onDeleteError"
    />
  </div>
</template>

<style lang="scss" scoped>
  .dev-workspaces {
    header {
      display:        flex;
      align-items:    flex-start;
      gap:            var(--dev-space-5);
      margin-bottom:  var(--dev-space-5);

      h1 {
        margin-bottom: 0;
      }

      .subheader {
        max-width: 80ch;
        margin:    var(--dev-space-2) 0 0 0;
        color:     var(--muted);
      }

      // Push the create button to the far edge, where every other Rancher list page has it.
      > :last-child {
        margin-left: auto;
      }
    }

    &__actions {
      display:         flex;
      gap:             var(--dev-space-3);
      justify-content: flex-end;
    }
  }
</style>
