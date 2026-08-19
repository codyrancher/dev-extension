<script>
// My Work: the harness's landing page, and the first thing a person looks for.
//
// Two lists, in the order the harness has them: what is waiting on you, then what you wrote.
// Both come from one GraphQL request made by this page (see github.ts) rather than from a pod,
// so the token is only ever in the browser of the person it belongs to.
//
// The token comes from the same secret store Settings writes, which is per-user: two people
// looking at this page are looking at their own work, without either of them configuring
// anything here.
import SortableTable from '@shell/components/SortableTable';
import { Banner } from '@components/Banner';
import { RcButton } from '@components/RcButton';
import AsyncButton from '@shell/components/AsyncButton';
import { myWork, rerunFailed, dependabotAlerts } from '../github';
import {
  listAllWorkspaces, createWorkspace, queueConversation, listPrompts, getWorkspace
} from '../api';
import { TEMPLATES } from '../templates';
import { fillPrompt } from '../prompts';
import {
  DEV_PRODUCT, BLANK_CLUSTER, SETTINGS_ROUTE, WORKSPACE_ROUTE, CREATE_ROUTE
} from '../config/constants';

/** Columns shared by both tables, since the two differ only at their right-hand end. */
function columns(extra) {
  return [
    {
      name: 'state', label: 'State', value: 'draft', width: 90
    },
    {
      name: 'approved', label: 'Approved', value: 'approved', width: 90
    },
    {
      name: 'pr', label: 'PR', value: 'number', sort: ['number'], width: 90
    },
    // Which repository, because a PR number on its own does not say: these lists span every
    // repository a person touches, and `#2` and `#18777` are both perfectly ordinary.
    {
      name: 'repo', label: 'Repo', value: 'repo', sort: ['repo'], width: 130
    },
    {
      name: 'issue', label: 'Issue', value: 'issue.number', width: 90
    },
    { name: 'title', label: 'Title', value: 'title' },
    {
      name: 'ci', label: 'CI', value: 'checks.state', width: 190
    },
    ...extra,
    // The workspace for this pull request, which is the harness's Project column under the name
    // this product uses for the same thing.
    {
      name: 'workspace', label: 'Workspace', value: 'key', width: 130
    },
    {
      name: 'actions', label: 'Actions', align: 'right', width: 100
    },
  ];
}

export default {
  name: 'DevMyWork',

  components: {
    SortableTable, Banner, RcButton, AsyncButton
  },

  async fetch() {
    await this.refresh();
  },

  data() {
    return {
      work:       null,
      error:      '',
      // The workspaces that exist, so a row can say whether it already has one. Names only:
      // this page is about pull requests and the sidebar is about workspaces.
      workspaces: [],
      // This person's own prompts, which is what a queued conversation opens on.
      prompts:    [],
      // The repository's open Dependabot advisories, and why they could not be read when they
      // could not be. A token without the security tab is an ordinary thing, not a page error.
      alerts:     [],
      alertError: '',
      issueHeaders: [
        {
          name: 'number', label: 'Issue', value: 'number', width: 90
        },
        { name: 'title', label: 'Title', value: 'title' },
        {
          name: 'repo', label: 'Repo', value: 'repo', sort: ['repo'], width: 130
        },
        // What the harness calls Area: the issue's own labels, which is how this team says which
        // part of the product something is about.
        {
          name: 'area', label: 'Area', value: 'labels', width: 220
        },
        {
          name: 'age', label: 'Age', value: 'createdAt', sort: ['createdAt'], width: 90
        },
        {
          name: 'workspace', label: 'Workspace', value: 'key', width: 130
        },
        {
          name: 'actions', label: 'Actions', align: 'right', width: 110
        },
      ],
      alertHeaders: [
        {
          name: 'severity', label: 'Severity', value: 'severity', sort: ['severity'], width: 100
        },
        { name: 'advisory', label: 'Advisory', value: 'summary' },
        {
          name: 'package', label: 'Package', value: 'packages', width: 160
        },
        {
          name: 'alerts', label: 'Alerts', value: 'alerts', width: 120
        },
        {
          name: 'fix', label: 'Fix', value: 'patched', width: 140
        },
        {
          name: 'actions', label: 'Action', align: 'right', width: 110
        },
      ],
      settingsTo: { name: SETTINGS_ROUTE, params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER } },
      // The two tables' own last columns: when you last reviewed something that is waiting on
      // you, and when anyone last said anything on something you wrote.
      reviewHeaders: columns([
        {
          name: 'reviewed', label: 'My last review', value: 'reviewedAt', width: 130
        },
        {
          name: 'updated', label: 'Updated', value: 'updatedAt', sort: ['updatedAt:desc'], width: 110
        },
      ]),
      mineHeaders: columns([
        {
          name: 'updated', label: 'Last update', value: 'updatedAt', sort: ['updatedAt:desc'], width: 110
        },
        {
          name: 'commented', label: 'Last comment', value: 'commentedAt', width: 120
        },
      ]),
    };
  },

  computed: {
    /** The repository this product's workspaces work on, from the template that clones it. */
    repo() {
      return TEMPLATES.find((template) => !!template.repo)?.repo || '';
    },

    /**
     * What is waiting on you, most urgent first.
     *
     * The default sort was "updated", which is activity rather than need: a pull request somebody
     * pushed to a minute ago is at the top whether or not it wants anything from you. This orders
     * by what a reviewer actually decides between:
     *
     *   1. never reviewed, because it is the only state where nothing has happened at all;
     *   2. not approved before approved, since an approved one is off your desk;
     *   3. green CI before red, because a review of a branch that does not build is a review that
     *      will be asked for again;
     *   4. oldest first inside all of that, so the one that has been waiting longest wins.
     */
    reviewing() {
      return [...(this.work?.reviewing || [])].sort((a, b) => (
        Number(!!a.reviewedAt) - Number(!!b.reviewedAt) ||
        Number(a.approved) - Number(b.approved) ||
        Number(!!a.checks?.failing) - Number(!!b.checks?.failing) ||
        Date.parse(a.updatedAt || 0) - Date.parse(b.updatedAt || 0)
      ));
    },

    /**
     * Your own, most urgent first.
     *
     * The other way round from the list above, because what these want from you is work rather
     * than judgement: something red is something to fix, and something nobody has commented on
     * is something to chase. Approved and green is the bottom of the list, which is where a pull
     * request that only needs merging belongs.
     */
    mine() {
      return [...(this.work?.mine || [])].sort((a, b) => (
        Number(!!b.checks?.failing) - Number(!!a.checks?.failing) ||
        Number(a.approved) - Number(b.approved) ||
        Number(a.draft) - Number(b.draft) ||
        Date.parse(a.updatedAt || 0) - Date.parse(b.updatedAt || 0)
      ));
    },

    /**
     * The repositories the two lists span, for the subtitle.
     *
     * Capped, because this is a line under a heading rather than a list: someone who reviews
     * widely has a dozen of them and the page's own title ends up on the second line.
     */
    repos() {
      const all = [...(this.work?.reviewing || []), ...(this.work?.mine || [])].map((pr) => pr.repo);
      const unique = [...new Set(all)];
      const shown = unique.slice(0, 3).join(', ');

      return unique.length > 3 ? `${ shown } and ${ unique.length - 3 } more` : shown;
    },
  },

  methods: {
    async refresh() {
      this.error = '';

      try {
        const [work, workspaces, prompts] = await Promise.all([
          myWork(),
          listAllWorkspaces().catch(() => []),
          listPrompts().catch(() => []),
        ]);

        this.work = work;
        this.workspaces = workspaces.map((workspace) => workspace.name);
        this.prompts = prompts;

        // Separately, and allowed to fail on its own: the alerts belong to a repository and need
        // a permission the rest of this page does not, so a token without it should cost that
        // section and nothing else.
        this.alertError = '';

        try {
          this.alerts = await dependabotAlerts(this.repo);
        } catch (e) {
          this.alerts = [];
          this.alertError = e.message || String(e);
        }
      } catch (e) {
        this.work = null;
        this.error = e.message || String(e);
      }
    },

    /**
     * The workspace a pull request would have, by name.
     *
     * `issue-18536` is what the harness calls the project for issue 18536, and the workspace
     * name rules here are the same shape (a DNS label), so the same name works. A PR that closes
     * no issue falls back to its own number, which is the only other stable thing about it.
     */
    workspaceName(pr) {
      return pr.issue ? `issue-${ pr.issue.number }` : `pr-${ pr.number }`;
    },

    /** Where its workspace is, when it has one, and where one would be made when it does not. */
    workspaceTo(pr) {
      const name = this.workspaceName(pr);

      if (this.workspaces.includes(name)) {
        return {
          name:   WORKSPACE_ROUTE,
          params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER, workspace: name },
        };
      }

      return {
        name:   CREATE_ROUTE,
        params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER },
        query:  { template: 'rancher', name },
      };
    },

    hasWorkspace(pr) {
      return this.workspaces.includes(this.workspaceName(pr));
    },

    /** The same two, for an issue, whose workspace is named for the issue rather than the PR. */
    hasIssueWorkspace(issue) {
      return this.workspaces.includes(`issue-${ issue.number }`);
    },

    issueWorkspaceTo(issue) {
      const name = `issue-${ issue.number }`;

      if (this.workspaces.includes(name)) {
        return {
          name:   WORKSPACE_ROUTE,
          params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER, workspace: name },
        };
      }

      return {
        name:   CREATE_ROUTE,
        params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER },
        query:  { template: 'rancher', name },
      };
    },

    /**
     * Review: make the workspace for this pull request, and open a conversation about it.
     *
     * Two halves, and the second is the point. A workspace with a checkout in it is a place to
     * work; a workspace with a conversation already asking about the right pull request is the
     * thing this page exists to save. The prompt is this person's own (see prompts.ts), and it
     * waits in the pod until the pane opens, so this does not have to wait for a workspace that
     * is still cloning.
     *
     * It ends on the workspace's Conversations tab, because that is where what it just queued
     * will appear.
     */
    async review(pr, done) {
      const prompt = this.prompts.find((entry) => entry.id === 'review-pr');

      return this.startWork(done, this.workspaceName(pr), prompt, {
        repo:  pr.repo,
        pr:    String(pr.number),
        issue: pr.issue ? String(pr.issue.number) : '',
        title: pr.title,
        url:   pr.url,
      });
    },

    /**
     * Wait for the pod, then write the prompt into it.
     *
     * A workspace that has just been created has no pod for a few seconds, and queueConversation
     * needs one to write a file. This is the only waiting the action does: everything after it
     * happens in the workspace, in its own time.
     */
    async queueWhenReady(name, text) {
      for (let attempt = 0; attempt < 20; attempt++) {
        const workspace = await getWorkspace(name).catch(() => null);

        if (workspace?.replicas) {
          try {
            await queueConversation(name, 1, text);

            return;
          } catch { /* no pod yet, which is what the next attempt is for */ }
        }

        await new Promise((resolve) => setTimeout(resolve, 3000));
      }

      throw new Error('The workspace did not start in time, so nothing was queued in it.');
    },

    /**
     * Start fix on an issue: the workspace for it, and a conversation already about it.
     *
     * The same two steps Review takes on a pull request, with the other prompt. The workspace is
     * named for the issue, which is what the harness calls the project for one, so pressing this
     * twice lands in the same workspace rather than making a second.
     */
    async startFix(issue, done) {
      const prompt = this.prompts.find((entry) => entry.id === 'fix-issue');

      return this.startWork(done, `issue-${ issue.number }`, prompt, {
        repo:  issue.repo,
        issue: String(issue.number),
        title: issue.title,
        url:   issue.url,
        pr:    '',
      });
    },

    /**
     * Start fix on a Dependabot advisory.
     *
     * Named for the advisory rather than the package, because one advisory is one piece of work
     * however many packages and files it touches. GHSA ids are lowercase-safe and already look
     * like a name.
     */
    async startAlertFix(alert, done) {
      const prompt = this.prompts.find((entry) => entry.id === 'fix-dependabot');

      return this.startWork(done, alert.ghsa.toLowerCase(), prompt, {
        repo:    this.repo,
        ghsa:    alert.ghsa,
        cve:     alert.cve || 'no CVE',
        title:   alert.summary,
        package: alert.packages.join(', '),
        files:   String(alert.files),
        fix:     alert.patched || 'not released yet',
        url:     alert.url,
      });
    },

    /**
     * The two steps every one of these actions is: make the workspace, queue the conversation.
     *
     * One function because the difference between fixing an issue, reviewing a pull request and
     * clearing an advisory is which prompt and what is substituted into it. Everything else -
     * creating the workspace if it is not there, waiting for its pod, going to it - is the same.
     */
    async startWork(done, name, prompt, values) {
      this.error = '';

      try {
        if (!this.workspaces.includes(name)) {
          await createWorkspace(name, 'rancher');
          this.workspaces = [...this.workspaces, name];
        }

        if (prompt) {
          await this.queueWhenReady(name, fillPrompt(prompt.text, values));
        }

        done(true);
        this.$router.push({
          name:   WORKSPACE_ROUTE,
          params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER, workspace: name },
          hash:   '#conversations',
        });
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },

    /** How severe, in the one word GitHub uses, coloured the way the rest of the page is. */
    severityTone(severity) {
      return {
        critical: 'error', high: 'error', medium: 'warning', low: 'muted'
      }[severity] || 'muted';
    },

    /**
     * Run the failed jobs again, on every workflow that has one.
     *
     * The rows are not refreshed afterwards, deliberately: GitHub takes a moment to move a rerun
     * job out of its failed state, and a table that redrew immediately would show the same red
     * counts and read as a button that did nothing. The next Refresh shows it.
     */
    async rerun(pr, done) {
      this.error = '';

      try {
        await Promise.all(pr.runs.map((run) => rerunFailed(pr.repo, run)));
        done(true);
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },

    /**
     * How long ago, in the one unit that is worth reading at a glance.
     *
     * The harness writes these as `5m ago`, `48d ago`, `2mo ago`, and that is the whole format:
     * a pull request nobody has touched for two months and one touched for forty-eight days are
     * different in a way that a date does not show and this does.
     */
    ago(when) {
      if (!when) {
        return 'never';
      }

      const minutes = Math.max(0, Math.round((Date.now() - Date.parse(when)) / 60000));

      if (minutes < 60) {
        return `${ minutes }m ago`;
      }

      if (minutes < 60 * 24) {
        return `${ Math.round(minutes / 60) }h ago`;
      }

      const days = Math.round(minutes / (60 * 24));

      return days < 60 ? `${ days }d ago` : `${ Math.round(days / 30) }mo ago`;
    },

    /**
     * What the CI cell says, as the harness says it: the counts that are the reason it is not a
     * tick, both of them, rather than whichever is worse.
     *
     * Nine pending and four failing are two different things to know and they are true at the
     * same time. The version that showed one number showed the failures and hid the fact that
     * half the run had not finished, which is the difference between "this is broken" and "this
     * is broken so far".
     */
    badges(checks) {
      if (!checks || !checks.total) {
        return [];
      }

      const out = [];

      if (checks.pending) {
        out.push({ label: `${ checks.pending } pending`, tone: 'warning' });
      }

      if (checks.failing) {
        out.push({ label: `${ checks.failing } failing`, tone: 'error' });
      }

      return out.length ? out : [{ label: '✓', tone: checks.state === 'SUCCESS' ? 'success' : 'muted' }];
    },
  },
};
</script>

<template>
  <div class="dev-my-work">
    <header>
      <h1>My Work</h1>
      <p class="subheader">
        <span v-if="work">@{{ work.login }}<span v-if="repos"> &middot; {{ repos }}</span></span>
        <span v-else>What you wrote and what is waiting on you, from GitHub.</span>
      </p>
      <RcButton
        variant="tertiary"
        size="small"
        left-icon="refresh"
        @click="refresh"
      >
        Refresh
      </RcButton>
    </header>

    <!--
      A token that is missing and a token that is refused are different problems with the same
      shape, so the message says which and the button goes where either is fixed.
    -->
    <Banner
      v-if="error"
      color="warning"
    >
      <div class="dev-my-work__error">
        <span>{{ error }}</span>
        <RcButton
          variant="secondary"
          size="small"
          :to="settingsTo"
        >
          Go to Settings
        </RcButton>
      </div>
    </Banner>

    <template v-if="work">
      <h3>PRs with me as a reviewer <span class="dev-my-work__count">{{ reviewing.length }}</span></h3>
      <SortableTable
        :headers="reviewHeaders"
        :rows="reviewing"
        key-field="key"
        :table-actions="false"
        :row-actions="false"
        :search="false"
        :paging="true"
        :rows-per-page="5"
      >
        <template #cell:state="{ row }">
          <span :class="row.draft ? 'text-muted' : 'text-success'">{{ row.draft ? 'Draft' : 'Open' }}</span>
        </template>
        <template #cell:approved="{ row }">
          <span :class="row.approved ? 'text-success' : 'text-muted'">{{ row.approved ? '✓' : '' }}</span>
        </template>
        <template #cell:pr="{ row }">
          <a
            :href="row.url"
            target="_blank"
            rel="noopener noreferrer"
          >#{{ row.number }}</a>
        </template>
        <template #cell:repo="{ row }">
          <span class="dev-my-work__repo">{{ row.repo }}</span>
        </template>
        <template #cell:issue="{ row }">
          <a
            v-if="row.issue"
            :href="row.issue.url"
            target="_blank"
            rel="noopener noreferrer"
          >#{{ row.issue.number }}</a>
          <span
            v-else
            class="text-muted"
          >&ndash;</span>
        </template>
        <template #cell:ci="{ row }">
          <div class="dev-my-work__ci">
            <span
              v-for="badge in badges(row.checks)"
              :key="badge.label"
              class="dev-my-work__badge"
              :class="`dev-my-work__badge--${ badge.tone }`"
            >{{ badge.label }}</span>
            <!--
              Only where there is something to rerun. It reruns the failed jobs of every workflow
              that has one, which is usually a single run: see rerunFailed.
            -->
            <AsyncButton
              v-if="row.runs.length"
              mode="apply"
              action-label="Rerun"
              waiting-label="Asking"
              success-label="Asked"
              size="sm"
              @click="(done) => rerun(row, done)"
            />
          </div>
        </template>
        <!--
          The workspace for this pull request. One that exists is a link to it; one that does not
          is a link to the create page with the name already filled in, which is the harness's
          "Start project" under the word this product uses.
        -->
        <template #cell:workspace="{ row }">
          <RcButton
            variant="tertiary"
            size="small"
            :to="workspaceTo(row)"
          >
            {{ hasWorkspace(row) ? 'Workspace' : 'Start workspace' }}
          </RcButton>
        </template>
        <template #cell:actions="{ row }">
          <AsyncButton
            mode="apply"
            action-label="Review"
            waiting-label="Opening"
            success-label="Opened"
            size="sm"
            @click="(done) => review(row, done)"
          />
        </template>
        <template #cell:reviewed="{ row }">
          <span :class="row.reviewedAt ? '' : 'text-muted'">{{ ago(row.reviewedAt) }}</span>
        </template>
        <template #cell:updated="{ row }">
          {{ ago(row.updatedAt) }}
        </template>
      </SortableTable>

      <h3>My PRs <span class="dev-my-work__count">{{ mine.length }}</span></h3>
      <SortableTable
        :headers="mineHeaders"
        :rows="mine"
        key-field="key"
        :table-actions="false"
        :row-actions="false"
        :search="false"
        :paging="true"
        :rows-per-page="5"
      >
        <template #cell:state="{ row }">
          <span :class="row.draft ? 'text-muted' : 'text-success'">{{ row.draft ? 'Draft' : 'Open' }}</span>
        </template>
        <template #cell:approved="{ row }">
          <span :class="row.approved ? 'text-success' : 'text-muted'">{{ row.approved ? '✓' : '' }}</span>
        </template>
        <template #cell:pr="{ row }">
          <a
            :href="row.url"
            target="_blank"
            rel="noopener noreferrer"
          >#{{ row.number }}</a>
        </template>
        <template #cell:repo="{ row }">
          <span class="dev-my-work__repo">{{ row.repo }}</span>
        </template>
        <template #cell:issue="{ row }">
          <a
            v-if="row.issue"
            :href="row.issue.url"
            target="_blank"
            rel="noopener noreferrer"
          >#{{ row.issue.number }}</a>
          <span
            v-else
            class="text-muted"
          >&ndash;</span>
        </template>
        <template #cell:ci="{ row }">
          <div class="dev-my-work__ci">
            <span
              v-for="badge in badges(row.checks)"
              :key="badge.label"
              class="dev-my-work__badge"
              :class="`dev-my-work__badge--${ badge.tone }`"
            >{{ badge.label }}</span>
            <!--
              Only where there is something to rerun. It reruns the failed jobs of every workflow
              that has one, which is usually a single run: see rerunFailed.
            -->
            <AsyncButton
              v-if="row.runs.length"
              mode="apply"
              action-label="Rerun"
              waiting-label="Asking"
              success-label="Asked"
              size="sm"
              @click="(done) => rerun(row, done)"
            />
          </div>
        </template>
        <template #cell:updated="{ row }">
          {{ ago(row.updatedAt) }}
        </template>
        <!--
          The workspace for this pull request. One that exists is a link to it; one that does not
          is a link to the create page with the name already filled in, which is the harness's
          "Start project" under the word this product uses.
        -->
        <template #cell:workspace="{ row }">
          <RcButton
            variant="tertiary"
            size="small"
            :to="workspaceTo(row)"
          >
            {{ hasWorkspace(row) ? 'Workspace' : 'Start workspace' }}
          </RcButton>
        </template>
        <!--
          Nothing to do to your own pull request from here that GitHub does not do better, and the
          harness's own row says the same by leaving it empty.
        -->
        <template #cell:actions>
          <span class="text-muted">&ndash;</span>
        </template>
        <template #cell:commented="{ row }">
          <span :class="row.commentedAt ? '' : 'text-muted'">{{ ago(row.commentedAt) }}</span>
        </template>
      </SortableTable>
      <h3>Issues assigned to me <span class="dev-my-work__count">{{ work.issues.length }}</span></h3>
      <SortableTable
        :headers="issueHeaders"
        :rows="work.issues"
        key-field="key"
        default-sort-by="age"
        :table-actions="false"
        :row-actions="false"
        :search="false"
        :paging="true"
        :rows-per-page="5"
      >
        <template #cell:number="{ row }">
          <a
            :href="row.url"
            target="_blank"
            rel="noopener noreferrer"
          >#{{ row.number }}</a>
        </template>
        <template #cell:repo="{ row }">
          <span class="dev-my-work__repo">{{ row.repo }}</span>
        </template>
        <!-- The labels, as the chips the harness draws them as. -->
        <template #cell:area="{ row }">
          <span
            v-for="label in row.labels"
            :key="label"
            class="dev-my-work__area"
          >{{ label }}</span>
        </template>
        <template #cell:age="{ row }">
          {{ ago(row.createdAt) }}
        </template>
        <template #cell:workspace="{ row }">
          <RcButton
            variant="tertiary"
            size="small"
            :to="issueWorkspaceTo(row)"
          >
            {{ hasIssueWorkspace(row) ? 'Workspace' : 'Start workspace' }}
          </RcButton>
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

      <h3>
        Dependabot alerts <span class="dev-my-work__count">{{ alerts.length }}</span>
        <a
          v-if="repo"
          class="dev-my-work__link"
          :href="`https://github.com/${ repo }/security/dependabot`"
          target="_blank"
          rel="noopener noreferrer"
        >on GitHub</a>
      </h3>
      <!--
        One row per advisory rather than per alert: GitHub raises one alert per package per
        manifest, so a transitive dependency in three lockfiles is three alerts about one thing to
        do. The count says how many, and how many files they are in.
      -->
      <Banner
        v-if="alertError"
        color="info"
        :label="alertError"
      />
      <SortableTable
        v-else
        :headers="alertHeaders"
        :rows="alerts"
        key-field="key"
        default-sort-by="severity"
        :table-actions="false"
        :row-actions="false"
        :search="false"
        :paging="true"
        :rows-per-page="5"
      >
        <template #cell:severity="{ row }">
          <span
            class="dev-my-work__badge"
            :class="`dev-my-work__badge--${ severityTone(row.severity) }`"
          >{{ row.severity }}</span>
        </template>
        <template #cell:advisory="{ row }">
          <a
            :href="row.url"
            target="_blank"
            rel="noopener noreferrer"
          >{{ row.summary }}</a>
          <span class="dev-my-work__ids">{{ row.ghsa }}<template v-if="row.cve"> &middot; {{ row.cve }}</template></span>
        </template>
        <template #cell:package="{ row }">
          <span class="dev-my-work__repo">{{ row.packages.join(', ') }}</span>
        </template>
        <template #cell:alerts="{ row }">
          {{ row.alerts }} in {{ row.files }} file{{ row.files === 1 ? '' : 's' }}
        </template>
        <template #cell:fix="{ row }">
          <span :class="row.patched ? '' : 'text-muted'">{{ row.patched || 'no patch yet' }}</span>
        </template>
        <template #cell:actions="{ row }">
          <AsyncButton
            mode="apply"
            action-label="Start fix"
            waiting-label="Opening"
            success-label="Opened"
            size="sm"
            @click="(done) => startAlertFix(row, done)"
          />
        </template>
      </SortableTable>
    </template>
  </div>
</template>

<style lang="scss" scoped>
  .dev-my-work {
    overflow-y: auto;
    padding:    var(--dev-space-5);

    header {
      display:       flex;
      align-items:   center;
      gap:           var(--dev-space-4);
      margin-bottom: var(--dev-space-5);

      h1 {
        margin-bottom: 0;
      }

      .subheader {
        flex:      1 1 auto;
        margin:    0;
        color:     var(--muted);
      }
    }

    h3 {
      margin: var(--dev-space-5) 0 var(--dev-space-3) 0;
    }

    // The row count beside a heading, which is the harness's, and quiet because it is a count
    // rather than part of the heading.
    &__count {
      margin-left: var(--dev-space-3);
      color:       var(--muted);
      font-size:   12px;
      font-weight: 400;
    }

    // The owner is the same for nearly every row, so it is there to be read when it differs
    // rather than to be read every time.
    &__repo {
      color:     var(--muted);
      font-size: 12px;
    }

    &__ci {
      display:     flex;
      align-items: center;
      gap:         var(--dev-space-3);
    }

    // The harness's own pill, in Rancher's colours. Not BadgeState, which takes a Rancher state
    // name and would have to be told that "4 failing" is one.
    &__badge {
      padding:       1px var(--dev-space-3);
      border-radius: 10px;
      font-size:     11px;
      white-space:   nowrap;

      &--warning {
        background: var(--warning-banner-bg, var(--warning));
        color:      var(--warning);
      }

      &--error {
        background: var(--error-banner-bg, var(--error));
        color:      var(--error);
      }

      &--success,
      &--muted {
        color: var(--success);
      }

      &--muted {
        color: var(--muted);
      }
    }

    // A label, as a chip. Several to a cell and they wrap, because an issue can carry four.
    &__area {
      display:       inline-block;
      margin:        1px var(--dev-space-2) 1px 0;
      padding:       1px var(--dev-space-3);
      border:        1px solid var(--border);
      border-radius: 10px;
      color:         var(--muted);
      font-size:     11px;
      white-space:   nowrap;
    }

    // The advisory's identifiers, under its own title, where the harness has them.
    &__ids {
      display:     block;
      color:       var(--muted);
      font-family: monospace;
      font-size:   11px;
    }

    &__link {
      margin-left: var(--dev-space-3);
      font-size:   12px;
      font-weight: 400;
    }

    &__error {
      display:     flex;
      align-items: center;
      gap:         var(--dev-space-4);
    }
  }
</style>
