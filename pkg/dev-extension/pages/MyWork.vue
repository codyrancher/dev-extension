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
import { myWork } from '../github';
import {
  startPrReview, startIssueFix, startAlertFix, startDependabotReview, startCiTriage, mergePr, approveAndMerge,
  rerunFailedJobs, dependabotData, dependabotReviews, refreshDependabotReview, closeDependabotReview, listConversations
} from '../reviews';
import {
  listAllWorkspaces, createWorkspace
} from '../api';
import { listApps } from '../apps';
import { readPrefs, shownApps } from '../prefs';
import {
  DEV_PRODUCT, BLANK_CLUSTER, SETTINGS_ROUTE, WORKSPACE_ROUTE, CREATE_ROUTE, DEFAULT_APP
} from '../config/constants';
import { NarrowMixin } from '../design/narrow';

/** What a phone shows of a pull request: whether it is open, which one, what it is, and the way in. */
const NARROW_COLUMNS = ['state', 'pr', 'title', 'actions'];

/**
 * Columns shared by both tables, since the two differ only at their right-hand end.
 *
 * At phone width most of them go. Nine columns in 390px is nine columns of ellipsis, and the
 * question a phone is holding this table to answer is which pull request to open.
 */
function columns(extra, narrow = false) {
  const all = [
    {
      name: 'state', label: 'State', value: 'draft', width: 90
    },
    {
      name: 'approved', label: 'Approved', value: 'approved', width: 90
    },
    {
      name: 'pr', label: 'PR', value: 'number', sort: ['number'], width: 90
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

  return narrow ? all.filter((column) => NARROW_COLUMNS.includes(column.name)).map((column) => ({ ...column, width: column.name === 'title' ? undefined : column.width })) : all;
}

// ── Board status ──
// Ranked by how much of your attention a status wants: work in hand, then what is queued, then
// what needs a decision, then what waits on somebody else, then the parked columns. A status no
// board here uses ranks after these but ahead of the finished ones: a column anyone can add must
// not sink below Done. Generic names other boards use sit beside their equivalents.
const STATUS_ORDER = [
  'working', 'in progress',
  'next up', 'todo', 'to do',
  'to triage', 'triage', 'new',
  'review', 'in review',
  'qa working', 'qa review', 'to test',
  'backlog', 'ice box',
];
const STATUS_TERMINAL = ['done', 'closed'];

function statusRank(status) {
  if (!status) {
    return STATUS_ORDER.length + 2;
  }

  const name = status.name.toLowerCase();

  if (STATUS_TERMINAL.includes(name)) {
    return STATUS_ORDER.length + 1;
  }

  const i = STATUS_ORDER.indexOf(name);

  return i === -1 ? STATUS_ORDER.length : i;
}

// The board's own colour for a column, in this dashboard's palette. A board anyone can add a
// column to would otherwise leave every unfamiliar status looking identical.
const STATUS_HUE = {
  GRAY:   'muted',
  BLUE:   'info',
  GREEN:  'success',
  YELLOW: 'warning',
  ORANGE: 'warning',
  RED:    'error',
  PINK:   'accent',
  PURPLE: 'accent',
};

export default {
  name: 'DevMyWork',

  mixins: [NarrowMixin],

  components: {
    SortableTable, Banner, RcButton, AsyncButton
  },

  async fetch() {
    await this.refresh();
  },

  data() {
    return {
      apps:       [],
      work:       null,
      error:      '',
      // The workspaces that exist, so a row can say whether it already has one. Names only:
      // this page is about pull requests and the sidebar is about workspaces.
      workspaces: [],
      // This person's own prompts, which is what a queued conversation opens on.
      // The repository's open Dependabot advisories, and why they could not be read when they
      // could not be. A token without the security tab is an ordinary thing, not a page error.
      alerts:     [],
      botPrs:     [],
      botReviews: {},
      alertError: '',
      notice:     '',
      issueHeaders: [
        {
          name: 'number', label: 'Issue', value: 'number', width: 90
        },
        { name: 'title', label: 'Title', value: 'title' },
        // The board's Status column, sorted by how much of your attention a status wants rather
        // than alphabetically - the rank is a field on the row, see issueRows.
        {
          name: 'status', label: 'Status', value: 'statusRank', sort: ['statusRank', 'createdAt:desc'], width: 130
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
      botHeaders: [
        { name: 'pr', label: 'PR', value: 'number', width: 90 },
        { name: 'ci', label: 'CI', value: 'ci', width: 130 },
        { name: 'package', label: 'Package', value: 'packageName' },
        { name: 'updated', label: 'Updated', value: 'updatedAt', sort: ['updatedAt:desc'], width: 110 },
        { name: 'review', label: 'Review', value: 'number', width: 260 },
        { name: 'actions', label: '', align: 'right', width: 230 },
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
    };
  },

  computed: {
    // The two tables' own last columns: when you last reviewed something that is waiting on
    // you, and when anyone last said anything on something you wrote. Computed rather than
    // fixed, because which columns there are depends on how wide the window is.
    reviewHeaders() {
      return columns([
        {
          name: 'reviewed', label: 'My last review', value: 'reviewedAt', width: 130
        },
        {
          name: 'updated', label: 'Updated', value: 'updatedAt', sort: ['updatedAt:desc'], width: 110
        },
      ], this.narrow);
    },

    mineHeaders() {
      return columns([
        {
          name: 'updated', label: 'Last update', value: 'updatedAt', sort: ['updatedAt:desc'], width: 110
        },
        {
          name: 'commented', label: 'Last comment', value: 'commentedAt', width: 120
        },
      ], this.narrow);
    },

    /** The issues with their board rank on them, zero-padded so the table sorts it as text. */
    issueRows() {
      return (this.work?.issues || []).map((issue) => ({
        ...issue,
        statusRank: String(statusRank(issue.projectStatus)).padStart(2, '0'),
      }));
    },

    projectStatusError() {
      return this.work?.projectStatusError || '';
    },

    /**
     * The repository My Work is about: the one the default app clones, or the first app that
     * declares one. Apps Plus apps carry it as a `repo` value.
     */
    repo() {
      const preferred = this.apps.find((app) => app.id === DEFAULT_APP && app.repo);

      return (preferred || this.apps.find((app) => !!app.repo))?.repo || '';
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
        const [work, workspaces, apps, prefs] = await Promise.all([
          myWork(),
          listAllWorkspaces().catch(() => []),
          listApps(this.$store).catch(() => []),
          readPrefs().catch(() => ({ hiddenApps: [] })),
        ]);

        this.apps = shownApps(apps, prefs);

        this.work = work;
        this.workspaces = workspaces.map((workspace) => workspace.name);

        // Separately, and allowed to fail on its own: the alerts belong to a repository and need
        // a permission the rest of this page does not, so a token without it should cost that
        // section and nothing else.
        this.alertError = '';

        try {
          const dependabot = await dependabotData(this.repo);

          this.alerts = (dependabot.groups || []).map((group) => ({ ...group, key: group.slug }));
          this.botPrs = (dependabot.prs || []).map((pr) => ({ ...pr, key: pr.number, repo: this.repo }));
          this.botReviews = await dependabotReviews().catch(() => ({}));
          this.refreshBotReviews().catch(() => {});
        } catch (e) {
          this.alerts = [];
          this.botPrs = [];
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
        query:  { app: DEFAULT_APP, name },
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
        query:  { app: DEFAULT_APP, name },
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
    /** Review a PR: a workspace for it and a conversation running the review skill. */
    async review(pr, done) {
      this.error = '';

      try {
        const started = await startPrReview(this.$store, pr, pr.repo || this.repo);

        done(true);
        this.$router.push({
          name:   WORKSPACE_ROUTE,
          params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER, workspace: started.workspace },
          hash:   '#pr',
        });
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },

    /**
     * Wait for the pod, then write the prompt into it.
     *
     * A workspace that has just been created has no pod for a few seconds, and queueConversation
     * needs one to write a file. This is the only waiting the action does: everything after it
     * happens in the workspace, in its own time.
     */
    /**
     * Open a conversation in the workspace with a prompt queued for it.
     *
     * In the agent pod, namespaced by the workspace (see conversations.ts), so it is there the
     * moment the workspace exists rather than minutes later when its own pod has compiled. The
     * conversation opens with the prompt as its first message when its pane is first attached.
     */

    /**
     * Start fix on an issue: the workspace for it, and a conversation already about it.
     *
     * The same two steps Review takes on a pull request, with the other prompt. The workspace is
     * named for the issue, which is what the harness calls the project for one, so pressing this
     * twice lands in the same workspace rather than making a second.
     */
    async startFix(issue, done) {
      this.error = '';

      try {
        const started = await startIssueFix(this.$store, issue, issue.repo || this.repo);

        done(true);
        this.$router.push({
          name:   WORKSPACE_ROUTE,
          params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER, workspace: started.workspace },
          hash:   '#conversations',
        });
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },

    /**
     * Start fix on a Dependabot advisory.
     *
     * Named for the advisory rather than the package, because one advisory is one piece of work
     * however many packages and files it touches. GHSA ids are lowercase-safe and already look
     * like a name.
     */
    async startAlertFix(group, done) {
      this.error = '';

      try {
        const started = await startAlertFix(this.$store, group, this.repo);

        done(true);
        this.$router.push({
          name:   WORKSPACE_ROUTE,
          params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER, workspace: started.workspace },
          hash:   '#conversations',
        });
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },

    /**
     * The two steps every one of these actions is: make the workspace, queue the conversation.
     *
     * One function because the difference between fixing an issue, reviewing a pull request and
     * clearing an advisory is which prompt and what is substituted into it. Everything else -
     * creating the workspace if it is not there, waiting for its pod, going to it - is the same.
     */

    /** How severe, in the one word GitHub uses, coloured the way the rest of the page is. */
    statusHue(status) {
      return STATUS_HUE[(status?.color || '').toUpperCase()] || 'muted';
    },

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
        await rerunFailedJobs(pr);
        done(true);
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },

    /** Red CI on my PR: the harness's smart rerun, as a triage conversation. */
    async fixCi(pr, done) {
      this.error = '';

      try {
        const started = await startCiTriage(this.$store, pr, pr.repo || this.repo);

        done(true);
        this.$router.push({
          name:   WORKSPACE_ROUTE,
          params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER, workspace: started.workspace },
          hash:   '#conversations',
        });
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },

    async merge(pr, done) {
      this.error = '';

      if (!window.confirm(`Squash and merge #${ pr.number }?\n\n${ pr.title }`)) {
        done(false);

        return;
      }

      try {
        await mergePr(pr.number, pr.repo || this.repo);
        done(true);
        await this.refresh();
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },

    botReview(pr) {
      return this.botReviews[String(pr.number)] || null;
    },

    botVerdictLabel(pr) {
      const review = this.botReview(pr);

      if (!review) {
        return '';
      }
      if (review.verdict) {
        return review.verdict.toUpperCase();
      }

      return review.state === 'ended' ? 'no verdict' : 'reviewing';
    },

    botVerdictTone(pr) {
      const review = this.botReview(pr);

      if (!review || !review.verdict) {
        return 'muted';
      }

      return review.verdict === 'merge' ? 'success' : 'error';
    },

    async reviewBotPr(pr, done) {
      this.error = '';

      try {
        await startDependabotReview(this.$store, pr, this.repo);
        this.botReviews = await dependabotReviews().catch(() => this.botReviews);
        done(true);
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },

    /** Read every open bot review's pane and record what it says. */
    async refreshBotReviews() {
      for (const review of Object.values(this.botReviews)) {
        if (review.verdict) {
          continue;
        }

        const conversations = await listConversations(review.workspace).catch(() => []);
        const conversation = conversations.find((c) => c.id === review.conversation);

        if (conversation) {
          const next = await refreshDependabotReview(review, conversation.attach).catch(() => review);

          this.botReviews = { ...this.botReviews, [String(review.pr)]: next };
        }
      }
    },

    botConversationTo(pr) {
      const review = this.botReview(pr);

      return review ? {
        name:   WORKSPACE_ROUTE,
        params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER, workspace: review.workspace },
        hash:   '#conversations',
      } : null;
    },

    async closeBotReview(pr) {
      await closeDependabotReview(pr.number).catch(() => {});
      const next = { ...this.botReviews };

      delete next[String(pr.number)];
      this.botReviews = next;
    },

    async mergeBotPr(pr, done) {
      this.error = '';

      if (!window.confirm(`Approve and merge #${ pr.number }?\n\n${ pr.title }\n\nApproves, squash-merges, then deletes ${ pr.branch }.`)) {
        done(false);

        return;
      }

      try {
        const r = await approveAndMerge(pr.number, this.repo);
        const branch = r.steps.find((step) => step.step === 'delete-branch');

        this.notice = `#${ pr.number } approved, merged${ branch?.ok ? ', branch deleted' : '' }.`;
        done(true);
        await this.refresh();
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
      v-if="notice"
      color="success"
      :closable="true"
      :label="notice"
      @close="notice = ''"
    />
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
        <template #cell:actions="{ row }">
          <div class="dev-my-work__actions">
            <AsyncButton
              v-if="row.checks && row.checks.failing"
              mode="apply"
              action-label="Fix CI"
              waiting-label="Opening"
              success-label="Opened"
              size="sm"
              @click="(done) => fixCi(row, done)"
            />
            <AsyncButton
              mode="apply"
              action-label="Merge"
              waiting-label="Merging"
              success-label="Merged"
              size="sm"
              :disabled="!!(row.draft || (row.checks && (row.checks.failing || row.checks.pending)))"
              @click="(done) => merge(row, done)"
            />
          </div>
          <span class="text-muted">&ndash;</span>
        </template>
        <template #cell:commented="{ row }">
          <span :class="row.commentedAt ? '' : 'text-muted'">{{ ago(row.commentedAt) }}</span>
        </template>
      </SortableTable>
      <h3>Issues assigned to me <span class="dev-my-work__count">{{ work.issues.length }}</span></h3>
      <!--
        A blank Status column is almost always a missing scope rather than an untriaged board,
        and a tooltip on a dash is not where anyone looks for that. Said once, above the table.
      -->
      <Banner
        v-if="projectStatusError"
        color="warning"
      >
        {{ projectStatusError }}
        <a
          href="https://github.com/settings/tokens"
          target="_blank"
          rel="noopener noreferrer"
        >Edit the token</a>
      </Banner>
      <SortableTable
        :headers="issueHeaders"
        :rows="issueRows"
        key-field="key"
        default-sort-by="status"
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
        <template #cell:status="{ row }">
          <a
            v-if="row.projectStatus && row.projectStatus.url"
            :href="row.projectStatus.url"
            target="_blank"
            rel="noopener noreferrer"
            class="dev-my-work__status"
            :class="`dev-my-work__status--${ statusHue(row.projectStatus) }`"
            :title="row.projectStatus.project"
          >{{ row.projectStatus.name }}</a>
          <span
            v-else-if="row.projectStatus"
            class="dev-my-work__status"
            :class="`dev-my-work__status--${ statusHue(row.projectStatus) }`"
            :title="row.projectStatus.project"
          >{{ row.projectStatus.name }}</span>
          <span
            v-else
            class="text-muted"
            :title="projectStatusError || 'Not on a project board'"
          >—</span>
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
          >{{ row.title }}</a>
          <span class="dev-my-work__ids">{{ row.ghsaId }}<template v-if="row.cveId"> &middot; {{ row.cveId }}</template></span>
        </template>
        <template #cell:package="{ row }">
          <span class="dev-my-work__repo">{{ row.packages.join(', ') }}</span>
        </template>
        <template #cell:alerts="{ row }">
          {{ row.alerts.length }} in {{ row.manifests.length }} file{{ row.manifests.length === 1 ? '' : 's' }}
          <template v-if="row.prs.length"> &middot; <a
            v-for="pr in row.prs"
            :key="pr.number"
            :href="pr.url"
            target="_blank"
            rel="noopener noreferrer"
          >#{{ pr.number }}</a></template>
        </template>
        <template #cell:fix="{ row }">
          <span :class="row.patchedVersion ? '' : 'text-muted'">{{ row.patchedVersion || 'no patch yet' }}</span>
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

      <h3>
        Dependabot PRs <span class="dev-my-work__count">{{ botPrs.length }}</span>
      </h3>
      <!--
        The bot's open bumps as a merge queue, as the harness had them. Review runs the merge
        checklist in a conversation and reads its verdict off the pane; a MERGE verdict is what
        the Approve & merge button is for, so it lives on that verdict rather than on every row.
      -->
      <SortableTable
        :headers="botHeaders"
        :rows="botPrs"
        key-field="key"
        default-sort-by="updated"
        :table-actions="false"
        :row-actions="false"
        :search="false"
        :paging="true"
        :rows-per-page="8"
      >
        <template #cell:pr="{ row }">
          <a
            :href="row.url"
            target="_blank"
            rel="noopener noreferrer"
            :title="row.title"
          >#{{ row.number }}</a>
        </template>
        <template #cell:ci="{ row }">
          <span
            v-for="badge in badges(row.ci)"
            :key="badge.label"
            class="dev-my-work__badge"
            :class="`dev-my-work__badge--${ badge.tone }`"
          >{{ badge.label }}</span>
          <span
            v-if="row.ci && !row.ci.pending && !row.ci.failing"
            class="dev-my-work__badge dev-my-work__badge--success"
          >green</span>
        </template>
        <template #cell:package="{ row }">
          <span class="dev-my-work__repo">{{ row.packageName || row.title }}</span>
          <span
            v-if="row.fromVersion"
            class="dev-my-work__ids"
          >{{ row.fromVersion }} → {{ row.toVersion }}</span>
        </template>
        <template #cell:updated="{ row }">
          {{ ago(row.updatedAt) }}
        </template>
        <template #cell:review="{ row }">
          <template v-if="botReview(row)">
            <span
              class="dev-my-work__badge"
              :class="`dev-my-work__badge--${ botVerdictTone(row) }`"
            >{{ botVerdictLabel(row) }}</span>
            <span
              v-if="botReview(row).reason"
              class="dev-my-work__reason"
              :title="botReview(row).reason"
            >{{ botReview(row).reason }}</span>
            <router-link
              v-if="botConversationTo(row)"
              :to="botConversationTo(row)"
              class="dev-my-work__ids"
            >conversation</router-link>
          </template>
          <span
            v-else
            class="text-muted"
          >not reviewed</span>
        </template>
        <template #cell:actions="{ row }">
          <div class="dev-my-work__actions">
            <AsyncButton
              mode="apply"
              :action-label="botReview(row) ? 'Review again' : 'Review'"
              waiting-label="Opening"
              success-label="Opened"
              size="sm"
              @click="(done) => reviewBotPr(row, done)"
            />
            <AsyncButton
              v-if="botReview(row) && botReview(row).verdict === 'merge'"
              mode="apply"
              action-label="Approve & merge"
              waiting-label="Merging"
              success-label="Merged"
              size="sm"
              :disabled="!!(row.ci && (row.ci.failing || row.ci.pending))"
              @click="(done) => mergeBotPr(row, done)"
            />
            <RcButton
              v-if="botReview(row)"
              variant="tertiary"
              size="small"
              title="Forget this review"
              @click="closeBotReview(row)"
            >
              ×
            </RcButton>
          </div>
        </template>
      </SortableTable>
    </template>
  </div>
</template>

<style lang="scss" scoped>
  .dev-my-work__actions {
    display:         flex;
    justify-content: flex-end;
    gap:             var(--dev-space-2);
  }

  .dev-my-work__reason {
    display:       block;
    max-width:     240px;
    overflow:      hidden;
    white-space:   nowrap;
    text-overflow: ellipsis;
    color:         var(--muted);
    font-size:     12px;
  }

  .dev-my-work__status {
    display:         inline-block;
    padding:         1px 8px;
    border-radius:   12px;
    font-size:       11px;
    letter-spacing:  0.04em;
    text-transform:  uppercase;
    text-decoration: none;
    background:      var(--tabbed-container-bg);
    color:           var(--muted);

    &--info    { background: var(--info-banner-bg);    color: var(--info); }
    &--success { background: var(--success-banner-bg); color: var(--success); }
    &--warning { background: var(--warning-banner-bg); color: var(--warning); }
    &--error   { background: var(--error-banner-bg);   color: var(--error); }
    &--accent  { background: rgba(155, 191, 253, 0.16); color: var(--dev-accent); }
  }

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

/* ── Phones: a table of pull requests is wider than the screen, so it scrolls inside its own
   box; the page never does. See design/mobile.css for the shared half of this. ── */
@media (max-width: 760px) {
  .dev-my-work {
    h3 { margin-top: var(--dev-space-5); }

    header {
      flex-direction: column;
      align-items:    flex-start;
      gap:            var(--dev-space-2);
      margin-bottom:  var(--dev-space-4);
    }

    :deep(.sortable-table-header) { flex-wrap: wrap; }

    :deep(.sortable-table-wrapper) { overflow-x: auto; }
    :deep(table.sortable-table) { min-width: 640px; }
  }
}
</style>
