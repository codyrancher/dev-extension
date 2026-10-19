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
import StageSteps from '../components/StageSteps.vue';
import { NarrowMixin } from '../design/narrow';
import { myWork, issuesByNumber } from '../github';
import { readPrefs, savePrefs } from '../prefs';
import { DEFAULT_REPO } from '../reviews';
import { listAllWorkspaces, createWorkspace } from '../api';
import { defaultRancherValues } from '../ranchers';
import { startIssueFix } from '../reviews';
import { ago, stepsFor } from '../workspace-rail';
import { storedStages } from '../stages';
import {
  issueHeadersFor, issueRowsFrom, statusHue, milestoneDue,
  appForWorkspace, issueWorkspaceName, hasIssueWorkspace, issueWorkspaceLocation
} from '../issue-table';
import { SETTINGS_ROUTE, DEV_PRODUCT, BLANK_CLUSTER } from '../config/constants';

export default {
  name: 'DevIssueTracker',

  components: {
    SortableTable, Banner, RcButton, AsyncButton, StageSteps
  },

  mixins: [NarrowMixin],

  data() {
    return {
      issues:     [],
      workspaces: [],
      loading:    true,
      error:      '',
      statusError: '',
      /** The followed issues themselves, fetched from GitHub by number. */
      followed:   [],
      /** The stored stage of every workspace, by name. Read once, not once per row. */
      stages:     {},
      /** Issues followed that GitHub would not hand over, as `owner/repo#number`. */
      tracked:    [],
      /** What has been typed into the follow box. */
      adding:     '',
      addError:   '',
      busy:       false,
    };
  },

  computed: {
    headers() {
      return issueHeadersFor(this.narrow);
    },

    /**
     * The assigned issues and the followed ones, as one list.
     *
     * One table rather than two, because the question the page answers - what am I following
     * through its stages - does not care how an issue got here. A followed one carries
     * `followed` so its row can say so and offer to stop.
     */
    rows() {
      const mine = new Set(this.issues.map((issue) => issue.key));
      const extra = this.followed.filter((issue) => !mine.has(issue.key));

      return issueRowsFrom([...this.issues, ...extra.map((issue) => ({ ...issue, followed: true }))]);
    },

    /**
     * The stages an issue goes through, which are a fix's stages.
     *
     * The same list the workspace rail draws, from the same `stepsFor` - an issue assigned to
     * you is work to be done, so it travels assess, code, draft, review, feedback, merged.
     */
    steps() {
      return stepsFor('fix');
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

    /**
     * Where this issue has got to, or -1 for work that has not started.
     *
     * Read from the store rather than derived. `reconcileStage` decides a stage from GitHub and
     * the agent and writes it, which is right for the page about one workspace and wrong for a
     * list of forty: a tracker open on a second monitor would be reconciling work it is only
     * showing. So an issue with no workspace, or one the store has never seen, has no stage
     * yet - which is a true answer, and not the same as being at the first one.
     */
    stageIndexFor(issue) {
      const record = this.stages[issueWorkspaceName(this.workspaces, issue)] || this.stages[`issue-${ issue.number }`];

      return record ? this.steps.findIndex((step) => step.key === record.stage) : -1;
    },

    stageRoundFor(issue) {
      const record = this.stages[issueWorkspaceName(this.workspaces, issue)] || this.stages[`issue-${ issue.number }`];

      return record?.round || 1;
    },

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
        const [work, workspaces, stages, prefs] = await Promise.all([
          myWork(undefined, undefined, ['issues']),
          listAllWorkspaces().catch(() => []),
          storedStages().catch(() => ({})),
          readPrefs().catch(() => ({ trackedIssues: [] })),
        ]);

        this.issues = work.issues || [];
        this.statusError = work.projectStatusError || '';
        this.workspaces = workspaces.map((workspace) => workspace.name);
        this.stages = stages;
        this.tracked = prefs.trackedIssues || [];
        await this.readFollowed();
      } catch (e) {
        this.error = e.message || String(e);
      } finally {
        this.loading = false;
      }
    },

    /**
     * An issue key from whatever was typed: `19152`, `#19152`, a full GitHub URL, or
     * `owner/repo#19152`. Null when there is no number in it.
     *
     * Generous on purpose: the number is what somebody has to hand, and pasting the URL from
     * the tab they were just reading is the other half of the time.
     */
    parseIssueKey(text) {
      const raw = String(text || '').trim();
      const url = /github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/.exec(raw);

      if (url) {
        return `${ url[1] }#${ Number(url[2]) }`;
      }
      const qualified = /^([^/\s]+\/[^#\s]+)#(\d+)$/.exec(raw);

      if (qualified) {
        return `${ qualified[1] }#${ Number(qualified[2]) }`;
      }
      const bare = /^#?(\d+)$/.exec(raw);

      return bare ? `${ DEFAULT_REPO }#${ Number(bare[1]) }` : null;
    },

    /** The followed issues, read from GitHub a repository at a time. */
    async readFollowed() {
      const byRepo = {};

      for (const key of this.tracked) {
        const [repo, number] = String(key).split('#');

        if (repo && number) {
          (byRepo[repo] = byRepo[repo] || []).push(Number(number));
        }
      }

      const lists = await Promise.all(Object.entries(byRepo)
        .map(([repo, numbers]) => issuesByNumber(repo, numbers).catch(() => [])));

      this.followed = lists.flat();
    },

    async follow() {
      this.addError = '';
      const key = this.parseIssueKey(this.adding);

      if (!key) {
        this.addError = 'An issue number, or a link to one.';

        return;
      }
      if (this.tracked.includes(key)) {
        this.addError = `${ key } is already followed.`;

        return;
      }
      this.busy = true;

      try {
        const [repo, number] = key.split('#');
        const found = await issuesByNumber(repo, [Number(number)]);

        // Checked before it is saved: a number nobody can resolve would otherwise be followed
        // for ever as a row that never appears.
        if (!found.length) {
          this.addError = `${ key } could not be read. Check the number, and that the token can see that repository.`;

          return;
        }
        this.tracked = [...this.tracked, key];
        await savePrefs({ trackedIssues: this.tracked });
        this.followed = [...this.followed.filter((issue) => issue.key !== key), ...found];
        this.adding = '';
      } catch (e) {
        this.addError = e.message || String(e);
      } finally {
        this.busy = false;
      }
    },

    async unfollow(issue) {
      this.tracked = this.tracked.filter((key) => key !== issue.key);
      this.followed = this.followed.filter((one) => one.key !== issue.key);
      await savePrefs({ trackedIssues: this.tracked }).catch((e) => {
        this.error = e.message || String(e);
      });
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

    <!--
      Follow an issue GitHub will not hand over: somebody else's, or nobody's. A number is what
      a person has to hand; a pasted link is the other half of the time, so both work.
    -->
    <form
      class="dev-issue-tracker__follow"
      @submit.prevent="follow"
    >
      <input
        v-model="adding"
        type="text"
        class="dev-issue-tracker__follow-input"
        placeholder="Follow an issue: 19152, or a link to it"
        aria-label="Follow an issue"
        :disabled="busy"
      >
      <RcButton
        variant="secondary"
        size="small"
        type="submit"
        :disabled="busy || !adding.trim()"
      >
        {{ busy ? 'Reading…' : 'Follow' }}
      </RcButton>
      <span
        v-if="addError"
        class="dev-issue-tracker__follow-error"
      >{{ addError }}</span>
    </form>

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
      :sub-rows="true"
      :sub-expandable="true"
      :sub-expand-column="true"
    >
      <template #cell:number="{ row }">
        <a
          :href="row.url"
          target="_blank"
          rel="noopener noreferrer"
        >#{{ row.number }}</a>
        <span
          v-if="row.followed"
          class="dev-issue-tracker__followed"
          title="Followed; not assigned to you"
        >followed</span>
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
        <div class="dev-issue-tracker__actions">
          <AsyncButton
            mode="apply"
            action-label="Start fix"
            waiting-label="Opening"
            success-label="Opened"
            size="sm"
            @click="(done) => startFix(row, done)"
          />
          <RcButton
            v-if="row.followed"
            variant="link"
            size="small"
            title="Stop following this issue"
            @click="unfollow(row)"
          >
            Unfollow
          </RcButton>
        </div>
      </template>
      <!--
        The stages, under the issue they belong to.

        The same stepper the workspace rail draws (StageSteps) and the same stored stages, so
        an issue reads the same here as it does on its own workspace page. Read-only: this page
        lists stages, the rail is where one is moved.
      -->
      <template #sub-row="{ row, fullColspan }">
        <tr class="dev-issue-tracker__stages-row">
          <td :colspan="fullColspan">
            <StageSteps
              :steps="steps"
              :current-index="stageIndexFor(row)"
              :round="stageRoundFor(row)"
            />
            <p
              v-if="stageIndexFor(row) < 0"
              class="dev-issue-tracker__not-started"
            >
              Not started. Starting a workspace or a fix is what puts this issue on its first stage.
            </p>
          </td>
        </tr>
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

.dev-issue-tracker__stages-row td {
  padding: 8px 12px 12px 40px;
  background: var(--sortable-table-top-divider, var(--default));
}

.dev-issue-tracker__not-started {
  margin: 6px 0 0;
  color: var(--muted);
  font-size: 12px;
}

.dev-issue-tracker__follow {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin: 0 0 12px;
}

.dev-issue-tracker__follow-input {
  width: 320px;
  max-width: 100%;
}

.dev-issue-tracker__follow-error { color: var(--error); font-size: 12px; }

.dev-issue-tracker__followed {
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 8px;
  background: var(--default);
  color: var(--muted);
  font-size: 10px;
}

.dev-issue-tracker__actions {
  display: flex;
  align-items: center;
  gap: 6px;
  justify-content: flex-end;
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
