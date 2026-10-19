<script>
/**
 * The issues assigned to you, followed through their stages.
 *
 * My Work's Issues tab answers "what am I holding" at a glance and moves on. This page is where
 * one of them is followed: the same rows and the same columns (see issue-table.js, which both
 * read), with room under each for the stages the work goes through.
 *
 * Its own page rather than a third tab on My Work, because the two are read at different times -
 * My Work is the morning list, this is open while the work happens - and because a row here
 * expands, which is not a thing the glance should start doing.
 */
import SortableTable from '@shell/components/SortableTable';
import { Banner } from '@components/Banner';
import { RcButton } from '@components/RcButton';
import AsyncButton from '@shell/components/AsyncButton';
import { NarrowMixin } from '../design/narrow';
import { myWork } from '../github';
import { listAllWorkspaces, createWorkspace } from '../api';
import { defaultRancherValues } from '../ranchers';
import { startIssueFix } from '../reviews';
import { ago } from '../workspace-rail';
import {
  issueHeadersFor, issueRowsFrom, statusHue, milestoneDue,
  appForWorkspace, issueWorkspaceName, hasIssueWorkspace, issueWorkspaceLocation
} from '../issue-table';
import { SETTINGS_ROUTE, DEV_PRODUCT, BLANK_CLUSTER } from '../config/constants';

export default {
  name: 'DevIssueTracker',

  components: {
    SortableTable, Banner, RcButton, AsyncButton
  },

  mixins: [NarrowMixin],

  data() {
    return {
      issues:     [],
      workspaces: [],
      loading:    true,
      error:      '',
      statusError: '',
    };
  },

  computed: {
    headers() {
      return issueHeadersFor(this.narrow);
    },

    rows() {
      return issueRowsFrom(this.issues);
    },

    settingsTo() {
      return { name: SETTINGS_ROUTE, params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER } };
    },
  },

  mounted() {
    this.refresh();
  },

  methods: {
    ago,
    statusHue,
    milestoneDue,

    hasWorkspace(issue) {
      return hasIssueWorkspace(this.workspaces, issue);
    },

    workspaceTo(issue) {
      return issueWorkspaceLocation(this.workspaces, issue);
    },

    /**
     * Only the issues. `myWork` takes the sections to read, and this page shows one of the four -
     * asking for all of them would read the two pull request searches as well, which at the live
     * account's size is the bulk of the request and nothing this page draws.
     */
    async refresh() {
      this.error = '';
      this.loading = true;

      try {
        const [work, workspaces] = await Promise.all([
          myWork(undefined, undefined, ['issues']),
          listAllWorkspaces().catch(() => []),
        ]);

        this.issues = work.issues || [];
        this.statusError = work.projectStatusError || '';
        this.workspaces = workspaces.map((workspace) => workspace.name);
      } catch (e) {
        this.error = e.message || String(e);
      } finally {
        this.loading = false;
      }
    },

    async startWorkspace(issue, done) {
      this.error = '';

      try {
        const name = issueWorkspaceName(this.workspaces, issue);

        if (!this.workspaces.includes(name)) {
          await createWorkspace(this.$store, name, appForWorkspace(name), undefined, await defaultRancherValues(this.$store));
        }
        await this.refresh();
        done(true);
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },

    async startFix(issue, done) {
      this.error = '';

      try {
        await startIssueFix(this.$store, issue, issue.repo || undefined);
        await this.refresh();
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
  <div class="dev-issue-tracker">
    <h1>
      Issue tracker
      <span class="dev-issue-tracker__lede">The issues assigned to you, and where each one has got to.</span>
    </h1>

    <Banner
      v-if="error"
      color="warning"
    >
      <div class="dev-issue-tracker__error">
        <span>{{ error }}</span>
        <RcButton
          variant="secondary"
          size="small"
          @click="$router.push(settingsTo)"
        >
          Go to Settings
        </RcButton>
      </div>
    </Banner>

    <!--
      A blank Status column is almost always a missing scope rather than an untriaged board,
      and a tooltip on a dash is not where anyone looks for that. Said once, above the table.
    -->
    <Banner
      v-if="statusError"
      color="warning"
    >
      {{ statusError }}
    </Banner>

    <div
      v-if="loading && !issues.length"
      class="dev-issue-tracker__loading"
    >
      <i class="icon icon-spinner icon-spin" />
      <span>Reading the issues assigned to you&hellip;</span>
    </div>

    <SortableTable
      v-else
      :headers="headers"
      :rows="rows"
      key-field="key"
      default-sort-by="status"
      :table-actions="false"
      :row-actions="false"
      :search="true"
      :paging="true"
      :rows-per-page="25"
    >
      <template #cell:number="{ row }">
        <a
          :href="row.url"
          target="_blank"
          rel="noopener noreferrer"
        >#{{ row.number }}</a>
      </template>

      <template #cell:status="{ row }">
        <a
          v-if="row.projectStatus && row.projectStatus.url"
          :href="row.projectStatus.url"
          target="_blank"
          rel="noopener noreferrer"
          class="dev-issue-tracker__status"
          :class="`dev-issue-tracker__status--${ statusHue(row.projectStatus) }`"
          :title="row.projectStatus.project"
        >{{ row.projectStatus.name }}</a>
        <span
          v-else-if="row.projectStatus"
          class="dev-issue-tracker__status"
          :class="`dev-issue-tracker__status--${ statusHue(row.projectStatus) }`"
          :title="row.projectStatus.project"
        >{{ row.projectStatus.name }}</span>
        <span
          v-else
          class="text-muted"
          title="Not on a project board"
        >&mdash;</span>
      </template>

      <template #cell:milestone="{ row }">
        <a
          v-if="row.milestone && row.milestoneUrl"
          :href="row.milestoneUrl"
          target="_blank"
          rel="noopener noreferrer"
          :title="milestoneDue(row)"
        >{{ row.milestone }}</a>
        <span
          v-else-if="row.milestone"
          :title="milestoneDue(row)"
        >{{ row.milestone }}</span>
        <span
          v-else
          class="text-muted"
          title="Not in a milestone"
        >&mdash;</span>
      </template>

      <template #cell:age="{ row }">
        {{ ago(row.createdAt) }}
      </template>

      <!-- An em dash where nothing says, rather than `ago('')`, which reads an unparseable
           date as now and would answer "just now". See MyWork's Assigned column. -->
      <template #cell:assigned="{ row }">
        <span
          v-if="row.assignedAt"
          :title="row.assignedAt"
        >{{ ago(row.assignedAt) }}</span>
        <span
          v-else
          class="text-muted"
          title="Nothing in the issue's timeline says when it was assigned"
        >&mdash;</span>
      </template>

      <template #cell:workspace="{ row }">
        <RcButton
          v-if="hasWorkspace(row)"
          variant="tertiary"
          size="small"
          @click="$router.push(workspaceTo(row))"
        >
          Workspace
        </RcButton>
        <AsyncButton
          v-else
          mode="apply"
          action-label="Start workspace"
          waiting-label="Starting"
          success-label="Started"
          size="sm"
          @click="(done) => startWorkspace(row, done)"
        />
      </template>

      <template #cell:actions="{ row }">
        <AsyncButton
          mode="apply"
          action-label="Start fix"
          waiting-label="Opening"
          success-label="Opened"
          size="sm"
          @click="(done) => startFix(row, done)"
        />
      </template>
    </SortableTable>
  </div>
</template>

<style lang="scss" scoped>
.dev-issue-tracker {
  padding: 0 0 var(--dev-space-6, 24px);

  h1 {
    display: flex;
    align-items: baseline;
    gap: 12px;
    flex-wrap: wrap;
  }
}

.dev-issue-tracker__lede {
  color: var(--muted);
  font-size: 14px;
  font-weight: normal;
}

.dev-issue-tracker__error {
  display: flex;
  align-items: center;
  gap: 12px;
  justify-content: space-between;
}

.dev-issue-tracker__loading {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 24px 0;
  color: var(--muted);
}

/* The board's own colours, as My Work draws them. */
.dev-issue-tracker__status {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 12px;
  white-space: nowrap;
  background: var(--default);
  color: var(--body-text);
}

.dev-issue-tracker__status--muted   { background: var(--default); color: var(--muted); }
.dev-issue-tracker__status--info    { background: var(--info-banner-bg); color: var(--info); }
.dev-issue-tracker__status--success { background: var(--success-banner-bg); color: var(--success); }
.dev-issue-tracker__status--warning { background: var(--warning-banner-bg); color: var(--warning); }
.dev-issue-tracker__status--error   { background: var(--error-banner-bg); color: var(--error); }
.dev-issue-tracker__status--accent  { background: var(--primary-banner-bg, var(--default)); color: var(--primary); }
</style>
