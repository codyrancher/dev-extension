<script>
// The stage rail: where a workspace's work is, what there is to look at, and the one thing to
// press. The default view of a workspace (WorkspaceDetail); the tabs are a link away.
//
// Every agent action here is a conversation in the agents extension - started with a prompt, or
// a prompt queued into the newest one - so it shows in the Conversations tab and can be talked
// to afterwards. Nothing runs an agent any other way.
import { Banner } from '@components/Banner';
import { RcButton } from '@components/RcButton';
import StudioTerminal from './StudioTerminal.vue';
import WorkspaceReview from './WorkspaceReview.vue';
import WorkspacePr from './WorkspacePr.vue';
import WorkspaceBrowser from './WorkspaceBrowser.vue';
import WorkspaceShare from './WorkspaceShare.vue';
import DevModal from './DevModal.vue';
import {
  readStatusNow, knownStatus, provisionalStatus, agentLabel
} from '../workspace-status';
import {
  stepsFor, gatherEvidence, primaryLink, ago, commitFiles
} from '../workspace-rail';
import {
  listConversations, startConversation, queuePrompt, startPaneDetached, conversationStates
} from '../conversations';
import { ensureWorkspaceReady } from '../workspace-tools';
import {
  startIssueFix, startPrReview, approveAndMerge, DEFAULT_REPO
} from '../reviews';
import { markReadyForReview } from '../github';
import { deleteWorkspace } from '../api';
import { DEV_PRODUCT, BLANK_CLUSTER, WORKSPACES_ROUTE } from '../config/constants';

const STATUS_MS = 15000;
const EVIDENCE_MS = 60000;

export default {
  name: 'WorkspaceRail',

  components: {
    Banner, RcButton, StudioTerminal, WorkspaceReview, WorkspacePr, WorkspaceBrowser, WorkspaceShare, DevModal
  },

  props: {
    workspace: {
      type:     Object,
      required: true,
    },
    pr: {
      type:    Number,
      default: 0,
    },
    issue: {
      type:    Number,
      default: 0,
    },
    logTail: {
      type:    String,
      default: '',
    },
  },

  emits: ['open-tab'],

  data() {
    return {
      status:      null,
      evidence:    [],
      /** The stage being looked at: the current one unless a past step was clicked. */
      viewing:     '',
      loading:     true,
      reading:     false,
      /** Which read of the first column is the current one; an older one landing is ignored. */
      readSeq:     0,
      /** The same for the status: one read at a time, and an older one landing cannot regress the stage. */
      statusSeq:   0,
      statusBusy:  false,
      /** A GitHub read that failed is tried again soon: the in-cluster API restarts for a minute after a publish. */
      statusRetry: 0,
      statusRetryTimer: 0,
      busy:        '',
      error:       '',
      notice:      '',
      timers:      [],
      /** The view open over the page: review, pr, browser or share. */
      modal:       '',
      /** Rows opened to look closer: commits (their patch, read once) and comments (their chain and code). */
      openCommits: {},
      /** A commit's files, read once when it is opened. */
      commitFiles: {},
      openComments: {},
      /** This workspace's conversations, and the one shown - the newest unless another is picked. */
      conversations: [],
      currentConversation: '',
      startingConversation: false,
    };
  },

  computed: {
    steps() {
      return stepsFor(this.status?.kind || 'other');
    },

    current() {
      return this.status?.stage || '';
    },

    currentIndex() {
      return this.steps.findIndex((s) => s.key === this.current);
    },

    /**
     * The stage being looked at: the one clicked, else the current one, else - while the
     * status is still being read - the kind's middle stage, whose column (the change, the
     * report, the PR) is what there is to look at whatever the stage turns out to be.
     */
    shown() {
      return this.viewing || this.current || (this.status?.kind === 'review' ? 'agent' : this.status?.kind === 'fix' ? 'code' : '');
    },

    shownLabel() {
      return this.steps.find((s) => s.key === this.shown)?.label || '';
    },

    lookingBack() {
      return !!this.viewing && this.viewing !== this.current;
    },

    agentLine() {
      return this.status ? agentLabel(this.status.agent) : '';
    },

    /**
     * The one thing to press now, and the tools beside it, by stage. `run` names the method.
     * A fix with no conversation at all is the stage before the rail: start it.
     */
    action() {
      const s = this.status;

      if (!s) {
        return null;
      }
      const link = primaryLink(s);
      const github = { label: 'Open on GitHub', run: 'openLink', arg: link };
      const conversation = { label: 'Open the conversation', run: 'openTab', arg: 'conversations' };

      if (s.kind === 'fix') {
        switch (s.stage) {
        case 'assess':
        case 'code':
          if (s.agent === 'none') {
            return {
              headline: 'Nothing has started on this issue', detail: 'Starts a conversation that reproduces the issue, fixes it, verifies the fix and opens a draft PR.', primary: { label: 'Start the fix', run: 'startFix' }, tools: [github],
            };
          }
          if (s.agent === 'input') {
            return {
              headline: 'The agent is waiting for an answer', detail: 'It asked something in its conversation and stopped until it hears back.', primary: { label: 'Answer it', run: 'openTab', arg: 'conversations' }, tools: [github],
            };
          }

          return {
            headline: s.agent === 'working' ? 'The agent is working on the fix' : 'The agent stopped before opening a PR', detail: s.agent === 'working' ? 'Follow along in the conversation, or ask it something below.' : 'Read its report on the left; ask it to carry on, or to change course, below.', primary: conversation, tools: [{ label: 'Open the PR flow again', run: 'startFix' }, github],
          };
        case 'draft':
          return {
            headline: 'The draft PR is ready for you to read', detail: 'Read the description and the change on the left. Marking it ready is yours; so is the reviewer, on GitHub.', primary: { label: 'Mark ready for review', run: 'markReady' }, tools: [{ label: 'Ask for a change', run: 'focusAsk' }, github],
          };
        case 'review':
          return {
            headline: 'Waiting for a reviewer', detail: 'Nothing to do here until someone comments. The agent can still be asked for something meanwhile.', primary: github, tools: [{ label: 'Ask the agent', run: 'focusAsk' }],
          };
        case 'feedback':
          return {
            headline: 'Reviewers left comments after your last push', detail: 'The agent reads each comment, answers or changes the code, re-verifies and pushes. You read its report before anything else happens.', primary: { label: 'Answer the feedback', run: 'answerFeedback' }, tools: [{ label: 'Re-verify the fix', run: 'reverify' }, { label: 'Ask the agent', run: 'focusAsk' }, github],
          };
        case 'merged':
          return {
            headline: s.label === 'Approved' ? 'Approved' : 'Merged', detail: 'The workspace can go; the PR and the conversation history stay on GitHub and in the agent pod.', primary: { label: 'Delete the workspace', run: 'remove' }, tools: [github],
          };
        }
      }
      if (s.kind === 'review') {
        switch (s.stage) {
        case 'agent':
          if (s.agent === 'none') {
            return {
              headline: 'No review has run yet', detail: 'Starts a review conversation over the PR; its findings land on the left as it goes.', primary: { label: 'Review this PR', run: 'startReview' }, tools: [github],
            };
          }

          return {
            headline: s.agent === 'working' ? 'The agent is reviewing' : 'The agent stopped', detail: 'Its findings land on the left as it goes; go through them once it is done.', primary: conversation, tools: [github],
          };
        case 'findings':
          return {
            headline: 'The agent\'s findings are ready for your pass', detail: 'Go through them, keep the ones you agree with, and submit the review as yours.', primary: { label: 'Go through the findings', run: 'openTab', arg: 'pr' }, tools: [{ label: 'Ask the agent', run: 'focusAsk' }, github],
          };
        case 'submitted':
          return {
            headline: 'Your review is with the developer', detail: 'This moves on when they push or reply.', primary: github, tools: [{ label: 'Approve and merge', run: 'approveMerge' }],
          };
        case 'response':
          return {
            headline: 'The developer responded', detail: 'New commits and replies since your review are on the left. The agent can review what changed against your comments.', primary: { label: 'Review the new commits', run: 'reviewAgain' }, tools: [{ label: 'Go through the findings', run: 'openTab', arg: 'pr' }, { label: 'Approve and merge', run: 'approveMerge' }, github],
          };
        case 'approved':
          return {
            headline: s.label === 'Merged' ? 'Merged' : 'Approved', detail: s.label === 'Merged' ? 'The workspace can go.' : 'Approved; merge it when CI is green.', primary: s.label === 'Merged' ? { label: 'Delete the workspace', run: 'remove' } : { label: 'Merge', run: 'approveMerge' }, tools: [github],
          };
        }
      }

      return null;
    },
  },

  watch: {
    'workspace.name'() {
      this.viewing = '';
      this.load();
    },
  },

  mounted() {
    this.load();
    this.loadConversations();
    this.timers = [
      // The agents every fifteen seconds; GitHub every five minutes and after an action - not
      // on every tick, which overlapped itself on a big PR.
      setInterval(() => this.refreshStatus(false), STATUS_MS),
      setInterval(() => this.refreshStatus(true), 5 * EVIDENCE_MS),
      setInterval(() => this.refreshEvidence(), EVIDENCE_MS),
    ];
  },

  beforeUnmount() {
    this.timers.forEach((t) => clearInterval(t));
    clearTimeout(this.statusRetryTimer);
  },

  methods: {
    ago,

    async load() {
      // What the sidebar last read is drawn now, or what the name alone says - the kind, the
      // steps, the links - and the fresh read lands behind it. The page is never blank for
      // GitHub's sake.
      this.status = knownStatus(this.workspace.name) || provisionalStatus(this.workspace.name);
      this.loading = false;
      this.refreshEvidence();
      await this.refreshStatus();
      await this.refreshEvidence();
    },

    async refreshStatus(github = true) {
      if (this.statusBusy) {
        return;
      }
      const seq = ++this.statusSeq;

      this.statusBusy = true;
      try {
        const before = this.status?.stage;
        const t0 = Date.now();
        const next = await readStatusNow(this.workspace.name, github);

        if (seq !== this.statusSeq) {
          return;
        }
        this.status = next;
        console.debug(`[rail] status ${ this.status.stage } in ${ Date.now() - t0 } ms (github=${ github })`); // eslint-disable-line no-console
        // A read that worked clears what an earlier one said: a dev-api restart is a minute.
        if (github) {
          this.error = '';
          this.statusRetry = 0;
        }
        this.loadConversations();
        // A stage that moved on is what the page is for; follow it unless a past one is open.
        if (before !== this.status.stage && !this.lookingBack) {
          this.viewing = '';
          this.refreshEvidence();
        }
      } catch (e) {
        console.debug(`[rail] status read failed (github=${ github }): ${ e?.message || e }`); // eslint-disable-line no-console
        this.error = e?.message || String(e);
        // Tried again in a moment, a few times: the failure is usually the API's own restart.
        if (github && this.statusRetry < 4) {
          this.statusRetry++;
          clearTimeout(this.statusRetryTimer);
          this.statusRetryTimer = setTimeout(() => this.refreshStatus(true), 5000 * this.statusRetry);
        }
      } finally {
        if (seq === this.statusSeq) {
          this.statusBusy = false;
        }
      }
    },

    async refreshEvidence() {
      if (!this.status || !this.shown) {
        return;
      }
      // Every call is a new read; an older one still in flight lands and is ignored. So a step
      // clicked during a read gets its own read at once rather than waiting the read out.
      const seq = ++this.readSeq;
      const stage = this.shown;
      const current = () => seq === this.readSeq && this.shown === stage;

      this.reading = true;
      try {
        const sections = await gatherEvidence(this.workspace.name, this.status, stage, (partial) => {
          console.debug(`[rail] evidence ${ seq } ${ stage } partial: ${ partial.map((s) => s.title).join(' | ') } current=${ current() }`); // eslint-disable-line no-console
          if (current()) {
            this.evidence = partial;
          }
        });
        if (current()) {
          this.evidence = sections;
        }
      } catch (e) {
        if (current()) {
          this.error = e?.message || String(e);
        }
      } finally {
        if (seq === this.readSeq) {
          this.reading = false;
        }
      }
    },

    look(step, index) {
      if (index > this.currentIndex) {
        return;
      }
      this.viewing = step.key === this.current ? '' : step.key;
      this.evidence = [];
      this.refreshEvidence();
    },

    backToNow() {
      this.viewing = '';
      this.evidence = [];
      this.refreshEvidence();
    },

    stepClass(step, index) {
      return {
        'workspace-rail__step--done':    index < this.currentIndex,
        'workspace-rail__step--now':     index === this.currentIndex,
        'workspace-rail__step--shown':   step.key === this.shown,
        'workspace-rail__step--future':  index > this.currentIndex,
      };
    },

    async run(action) {
      if (!action || this.busy) {
        return;
      }
      this.error = '';
      this.notice = '';
      this.busy = action.run;
      try {
        await this[action.run](action.arg);
      } catch (e) {
        this.error = e?.message || String(e);
      } finally {
        this.busy = '';
      }
    },

    openLink(url) {
      window.open(url, '_blank', 'noopener');
    },

    /** The conversation is on the page; every other view opens over it. */
    openTab(name) {
      if (name === 'conversations') {
        this.$refs.pane?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });

        return;
      }
      this.modal = name;
    },

    focusAsk() {
      this.openTab('conversations');
    },

    modalTitle() {
      return { review: 'Review the branch', pr: `PR${ this.status?.pr ? ` #${ this.status.pr }` : '' }`, browser: 'Browser', share: 'Share a build' }[this.modal] || '';
    },

    async toggleCommit(c, item) {
      const open = !this.openCommits[c.sha];

      this.openCommits = { ...this.openCommits, [c.sha]: open };
      if (open && !(c.sha in this.commitFiles)) {
        this.commitFiles = { ...this.commitFiles, [c.sha]: null };
        this.commitFiles = { ...this.commitFiles, [c.sha]: await commitFiles(this.workspace.name, item.pr || 0, c.sha).catch(() => []) };
      }
    },

    toggleComment(c) {
      this.openComments = { ...this.openComments, [c.id]: !(this.openComments[c.id] ?? !c.answered) };
    },

    async loadConversations() {
      this.conversations = await listConversations(this.workspace.name).catch(() => []);
      if (!this.conversations.some((c) => c.id === this.currentConversation)) {
        this.currentConversation = this.conversations[this.conversations.length - 1]?.id || '';
      }
    },

    async newConversation() {
      this.startingConversation = true;
      try {
        const c = await startConversation(this.workspace.name);

        await this.loadConversations();
        this.currentConversation = c.id;
      } catch (e) {
        this.error = e?.message || String(e);
      } finally {
        this.startingConversation = false;
      }
    },

    /**
     * The newest conversation of the workspace, or a new one: where a prompt goes. A newest
     * whose pane is gone is started again to read it - a prompt queued to nobody sat there.
     */
    async say(title, text) {
      await ensureWorkspaceReady(this.workspace.name);
      const conversations = await listConversations(this.workspace.name).catch(() => []);
      // The conversation about this work - the fix's, the review's, the feedback's - before a
      // scratch one somebody opened from the pane bar; the newest of those.
      const about = conversations.filter((c) => /^(Fix|Review|Feedback|Improve|CI) /.test(c.title || '') || (this.status?.pr && (c.title || '').includes(`#${ this.status.pr }`)));
      const newest = about[about.length - 1] || conversations[conversations.length - 1];

      if (newest && title === '') {
        await queuePrompt(newest.attach, text);
        const alive = (await conversationStates().catch(() => [])).find((c) => c.id === newest.id)?.alive;

        if (!alive) {
          await startPaneDetached(this.workspace.name, newest.id).catch(() => {});
        }
        await this.loadConversations();
        this.currentConversation = newest.id;
        this.openTab('conversations');

        return newest;
      }

      const started = await startConversation(this.workspace.name, title, text);

      await this.loadConversations();
      this.currentConversation = started.id;

      return started;
    },

    async startFix() {
      if (!this.issue) {
        throw new Error('This workspace is not named for an issue.');
      }
      await startIssueFix(this.$store, { number: this.issue, title: this.workspace.title || '' });
      this.notice = 'The fix conversation has started; it opens the PR when it is done.';
      await this.loadConversations();
      this.openTab('conversations');
      await this.refreshStatus();
    },

    /** A review of the PR, as its own conversation, watched from the pane. */
    async startReview() {
      if (!this.pr) {
        throw new Error('This workspace is not named for a PR.');
      }
      await startPrReview(this.$store, { number: this.pr, title: this.workspace.title || '' }, DEFAULT_REPO, this.workspace.name);
      this.notice = 'The review has started; its findings land on the left as it goes.';
      await this.loadConversations();
      this.openTab('conversations');
      await this.refreshStatus();
    },

    async markReady() {
      if (!this.status?.pr) {
        throw new Error('There is no PR to mark ready yet.');
      }
      await markReadyForReview(DEFAULT_REPO, this.status.pr);
      this.notice = `PR #${ this.status.pr } is ready for review. Request a reviewer on GitHub.`;
      await this.refreshStatus();
      await this.refreshEvidence();
    },

    async answerFeedback() {
      const pr = this.status?.pr;

      if (!pr) {
        throw new Error('There is no PR to answer feedback on.');
      }
      await this.say(`Feedback on #${ pr }`, `/my-pr-address-feedback Address the review feedback on ${ DEFAULT_REPO } PR #${ pr }: read every comment left since the last push, answer each one or change the code, re-verify, and push. Report what you changed and what you answered.`);
      this.notice = 'The agent is answering the feedback in a new conversation.';
      this.openTab('conversations');
    },

    async reverify() {
      const pr = this.status?.pr;

      await this.say('', `/my-fix-demonstrate Re-verify the fix on this branch${ pr ? ` (PR #${ pr })` : '' } and record a fresh video of the same walk.`);
      this.notice = 'Asked the agent to re-verify; the recording lands under Code and Draft PR.';
    },

    async reviewAgain() {
      const pr = this.status?.pr;

      await this.say('', `The developer pushed new commits and/or replied since the review of ${ DEFAULT_REPO } PR #${ pr } was submitted. Review what changed against the comments that were made: say which are addressed, which are not, and anything new the changes introduce. File through $CLAUDE_HARNESS_API/my-work/pr/${ pr }.`);
      this.notice = 'The agent is reviewing the new commits in the review conversation.';
      this.openTab('conversations');
    },

    async approveMerge() {
      const pr = this.status?.pr;

      if (!pr || !window.confirm(`Approve and merge PR #${ pr }?`)) {
        return;
      }
      await approveAndMerge(pr);
      this.notice = `PR #${ pr } approved and merged.`;
      await this.refreshStatus(true);
    },

    async remove() {
      if (!window.confirm(`Delete the workspace ${ this.workspace.name }? The PR and the conversations' transcripts stay.`)) {
        return;
      }
      await deleteWorkspace(this.$store, this.workspace.name);
      this.$router.push({ name: WORKSPACES_ROUTE, params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER } });
    },

  },
};
</script>

<template>
  <div class="workspace-rail">
    <Banner
      v-if="error"
      color="error"
      :label="error"
    />
    <Banner
      v-if="notice"
      color="info"
      :label="notice"
    />
    <div
      v-if="loading && !status"
      class="workspace-rail__loading"
    >
      Reading where this workspace is…
    </div>
    <template v-if="status && steps.length">
      <div class="workspace-rail__head">
        <div class="workspace-rail__title">
          <span class="workspace-rail__name">{{ workspace.name }}</span>
          <span
            v-if="workspace.title || status.title"
            class="workspace-rail__subject"
          >{{ workspace.title || status.title }}</span>
        </div>
        <div class="workspace-rail__meta">
          <a
            v-for="link in status.links"
            :key="link.url"
            :href="link.url"
            target="_blank"
            rel="noopener noreferrer"
          >{{ link.label }}</a>
          <span
            v-if="agentLine"
            class="workspace-rail__agent"
            :class="`workspace-rail__agent--${ status.agent }`"
          ><i
            v-if="status.agent === 'working'"
            class="icon icon-spinner icon-spin"
          />{{ agentLine }}</span>
          <RcButton
            variant="tertiary"
            size="small"
            @click="openTab('conversations')"
          >
            Conversations
          </RcButton>
        </div>
      </div>

      <!-- The rail. A passed step is a way back to what it left behind. -->
      <ol class="workspace-rail__steps">
        <li
          v-for="(step, index) in steps"
          :key="step.key"
          class="workspace-rail__step"
          :class="stepClass(step, index)"
        >
          <button
            type="button"
            class="workspace-rail__step-btn"
            :disabled="index > currentIndex"
            :title="index < currentIndex ? `Look at what ${ step.label } left behind` : index === currentIndex ? 'Now' : 'Not yet'"
            @click="look(step, index)"
          >
            <span class="workspace-rail__dot">
              <i
                v-if="index < currentIndex"
                class="icon icon-checkmark"
              />
              <span v-else>{{ index + 1 }}</span>
            </span>
            <span class="workspace-rail__step-label">{{ step.label }}</span>
          </button>
        </li>
      </ol>

      <!-- The one thing to press. Stays on the current stage while a past one is being read. -->
      <div
        v-if="action"
        class="workspace-rail__action"
        :class="`workspace-rail__action--${ status.tone }`"
      >
        <div class="workspace-rail__action-text">
          <div class="workspace-rail__headline">{{ action.headline }}</div>
          <div class="workspace-rail__detail">{{ action.detail }}</div>
        </div>
        <div class="workspace-rail__buttons">
          <RcButton
            v-for="tool in action.tools"
            :key="tool.label"
            variant="secondary"
            :disabled="!!busy"
            @click="run(tool)"
          >
            {{ tool.label }}
          </RcButton>
          <RcButton
            variant="primary"
            :disabled="!!busy"
            @click="run(action.primary)"
          >
            <i
              v-if="busy === action.primary.run"
              class="icon icon-spinner icon-spin"
            />
            {{ action.primary.label }}
          </RcButton>
        </div>
      </div>

      <div class="workspace-rail__columns">
        <!-- Column one: what there is to judge, for the stage being looked at. -->
        <section class="workspace-rail__col">
          <div class="workspace-rail__col-head">
            <h3 class="workspace-rail__col-title">{{ lookingBack ? `What ${ shownLabel } left behind` : current ? 'What came back' : 'Reading where this is… meanwhile, the latest' }}</h3>
            <button
              v-if="lookingBack"
              type="button"
              class="workspace-rail__back"
              @click="backToNow"
            >
              Back to now
            </button>
            <i
              v-else-if="reading"
              class="icon icon-spinner icon-spin workspace-rail__reading"
            />
          </div>
          <div
            v-if="!evidence.length"
            class="workspace-rail__empty"
          >
            {{ reading ? 'Reading…' : 'Nothing to show for this stage yet.' }}
          </div>
          <div
            v-for="section in evidence"
            :key="section.title"
            class="workspace-rail__section"
          >
            <h4 class="workspace-rail__section-title">{{ section.title }}</h4>
            <template
              v-for="(item, i) in section.items"
              :key="i"
            >
              <div
                v-if="item.kind === 'text'"
                class="workspace-rail__text"
              >
                <span
                  v-if="item.at"
                  class="workspace-rail__when"
                >{{ ago(item.at) }}</span>
                <div
                  v-if="item.html"
                  class="workspace-rail__md"
                  v-html="item.html"
                />
                <template v-else>{{ item.text }}</template>
              </div>
              <dl
                v-else-if="item.kind === 'kv'"
                class="workspace-rail__kv"
              >
                <template
                  v-for="row in item.rows"
                  :key="row.k"
                >
                  <dt>{{ row.k }}</dt>
                  <dd :class="row.tone ? `workspace-rail__tone--${ row.tone }` : ''">{{ row.v }}</dd>
                </template>
              </dl>
              <ul
                v-else-if="item.kind === 'commits'"
                class="workspace-rail__list workspace-rail__list--plain"
              >
                <li
                  v-for="c in item.items"
                  :key="c.sha"
                  class="workspace-rail__commit"
                >
                  <button
                    type="button"
                    class="workspace-rail__row-btn"
                    :title="openCommits[c.sha] ? 'Hide the change' : 'Show the change'"
                    @click="toggleCommit(c, item)"
                  >
                    <i
                      class="icon"
                      :class="openCommits[c.sha] ? 'icon-chevron-down' : 'icon-chevron-right'"
                    /><code>{{ c.sha.slice(0, 7) }}</code> {{ c.message }} <span class="workspace-rail__when">{{ c.who }} · {{ ago(c.at) }}</span>
                  </button>
                  <div
                    v-if="openCommits[c.sha]"
                    class="workspace-rail__files"
                  >
                    <p
                      v-if="commitFiles[c.sha] === null"
                      class="workspace-rail__empty"
                    >Reading the change…</p>
                    <p
                      v-else-if="!(commitFiles[c.sha] || []).length"
                      class="workspace-rail__empty"
                    >The commit's diff could not be read.</p>
                    <div
                      v-for="f in commitFiles[c.sha] || []"
                      :key="f.path"
                      class="workspace-rail__file"
                    >
                      <div class="workspace-rail__file-head"><code>{{ f.path }}</code><span
                        v-if="f.status"
                        class="workspace-rail__tag"
                      >{{ f.status }}</span></div>
                      <table class="workspace-rail__code">
                        <tbody>
                          <tr
                            v-for="(r, k) in f.rows"
                            :key="k"
                            :class="`workspace-rail__code-row workspace-rail__code-row--${ r.type }`"
                          >
                            <td class="workspace-rail__lineno">{{ r.oldN ?? '' }}</td>
                            <td class="workspace-rail__lineno">{{ r.newN ?? '' }}</td>
                            <td class="workspace-rail__codecell"><span class="workspace-rail__sign">{{ r.type === 'add' ? '+' : r.type === 'del' ? '−' : ' ' }}</span><span v-html="r.html" /></td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                </li>
              </ul>
              <ul
                v-else-if="item.kind === 'files'"
                class="workspace-rail__list workspace-rail__list--files"
              >
                <li
                  v-for="f in item.items"
                  :key="f.path"
                ><code>{{ f.path }}</code><span
                  v-if="f.note"
                  class="workspace-rail__tag"
                >{{ f.note }}</span></li>
              </ul>
              <div
                v-else-if="item.kind === 'media'"
                class="workspace-rail__media"
              >
                <figure
                  v-for="m in item.items"
                  :key="m.url"
                  class="workspace-rail__figure"
                >
                  <video
                    v-if="m.video"
                    :src="m.url"
                    controls
                    preload="metadata"
                  />
                  <img
                    v-else
                    :src="m.url"
                    :alt="m.label"
                  >
                  <figcaption>{{ m.label }} · {{ ago(m.at) }}</figcaption>
                </figure>
              </div>
              <div
                v-else-if="item.kind === 'comments'"
                class="workspace-rail__comments"
              >
                <!--
                  One card per thread, in GitHub's order (the file's place in the PR, then the
                  line). The code it is on is the hunk, numbered both sides, the commented line
                  marked; every message is rendered, the PR's author told apart from the rest.
                -->
                <article
                  v-for="(c, j) in item.items"
                  :key="c.id || j"
                  class="workspace-rail__comment"
                  :class="{ 'workspace-rail__comment--open': !c.answered }"
                >
                  <header class="workspace-rail__comment-head">
                    <button
                      type="button"
                      class="workspace-rail__row-btn"
                      :title="(openComments[c.id] ?? !c.answered) ? 'Hide the code' : 'Show the code it is on'"
                      @click="toggleComment(c)"
                    ><i
                      class="icon"
                      :class="(openComments[c.id] ?? !c.answered) ? 'icon-chevron-down' : 'icon-chevron-right'"
                    /><code>{{ c.where }}</code></button>
                    <span
                      v-if="c.thread.length > 1"
                      class="workspace-rail__tag"
                    >{{ c.thread.length }} messages</span>
                    <span
                      v-if="!c.answered"
                      class="workspace-rail__tag workspace-rail__tag--open"
                    >{{ status.kind === 'review' && status.stage === 'response' ? 'no reply from the developer' : 'waiting on you' }}</span>
                    <a
                      v-if="c.url"
                      :href="c.url"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="workspace-rail__when"
                    >on GitHub</a>
                  </header>
                  <div
                    v-if="openComments[c.id] ?? !c.answered"
                    class="workspace-rail__file"
                  >
                    <table
                      v-if="c.rows.length"
                      class="workspace-rail__code"
                    >
                      <tbody>
                        <tr
                          v-for="(r, k) in c.rows"
                          :key="k"
                          :class="[`workspace-rail__code-row workspace-rail__code-row--${ r.type }`, { 'workspace-rail__code-row--marked': r.marked }]"
                        >
                          <td class="workspace-rail__lineno">{{ r.oldN ?? '' }}</td>
                          <td class="workspace-rail__lineno">{{ r.newN ?? '' }}</td>
                          <td class="workspace-rail__codecell"><span class="workspace-rail__sign">{{ r.type === 'add' ? '+' : r.type === 'del' ? '−' : ' ' }}</span><span v-html="r.html" /></td>
                        </tr>
                      </tbody>
                    </table>
                    <p
                      v-else
                      class="workspace-rail__empty"
                    >{{ c.noPatch ? 'The diff is too large for GitHub to send; open it there.' : c.path ? 'The line is not in the PR\'s diff any more.' : 'A comment on the PR as a whole.' }}</p>
                  </div>
                  <div class="workspace-rail__thread">
                    <div
                      v-for="(t, k) in c.thread"
                      :key="k"
                      class="workspace-rail__msg"
                      :class="t.author ? 'workspace-rail__msg--author' : 'workspace-rail__msg--other'"
                    >
                      <div class="workspace-rail__msg-head"><span class="workspace-rail__avatar">{{ (t.who || '?').slice(0, 1).toUpperCase() }}</span><strong>{{ t.who }}</strong><span
                        v-if="t.author"
                        class="workspace-rail__when"
                      >author</span><span class="workspace-rail__when">{{ ago(t.at) }}</span></div>
                      <div
                        class="workspace-rail__md"
                        v-html="t.html"
                      />
                    </div>
                  </div>
                </article>
              </div>
              <p
                v-else-if="item.kind === 'links'"
                class="workspace-rail__links"
              >
                <a
                  v-for="l in item.items"
                  :key="l.url"
                  :href="l.url"
                  target="_blank"
                  rel="noopener noreferrer"
                >{{ l.label }}</a>
              </p>
              <p
                v-else-if="item.kind === 'empty'"
                class="workspace-rail__empty"
              >{{ item.text }}</p>
            </template>
          </div>
        </section>

      </div>
      <DevModal
        v-if="modal"
        :title="modalTitle()"
        @close="modal = ''; loadConversations()"
      >
        <WorkspaceReview
          v-if="modal === 'review'"
          :workspace="workspace"
        />
        <WorkspacePr
          v-else-if="modal === 'pr'"
          :workspace="workspace"
          :pr="pr"
          :issue="issue"
        />
        <WorkspaceBrowser
          v-else-if="modal === 'browser'"
          :workspace="workspace"
        />
        <WorkspaceShare
          v-else-if="modal === 'share'"
          :workspace="workspace"
          :pr="pr"
          :issue="issue"
        />
      </DevModal>
    </template>
    <div
      v-else-if="!loading && !(status && steps.length)"
      class="workspace-rail__empty workspace-rail__empty--page"
    >
      This workspace is not named for an issue or a PR, so it has no stages.
    </div>
    <!--
      The conversations themselves - the standard terminal and chat, with the list of this
      workspace's conversations - so the agent is talked to right here, whatever the status
      reads say. The other views open over the page (DevModal) rather than instead of it.
    -->
    <section
      ref="pane"
      class="workspace-rail__col workspace-rail__col--pane"
    >
      <div class="workspace-rail__col-head">
        <h3 class="workspace-rail__col-title">Conversations</h3>
        <div class="workspace-rail__views">
          <button
            type="button"
            class="workspace-rail__back"
            @click="openTab('review')"
          >Review the branch</button>
          <button
            v-if="(status && status.pr) || issue"
            type="button"
            class="workspace-rail__back"
            @click="openTab('pr')"
          >PR file by file</button>
          <button
            type="button"
            class="workspace-rail__back"
            @click="openTab('browser')"
          >Browser</button>
          <button
            type="button"
            class="workspace-rail__back"
            @click="openTab('share')"
          >Share</button>
        </div>
      </div>
      <div class="workspace-rail__pane-bar">
        <select
          v-if="conversations.length"
          v-model="currentConversation"
          class="workspace-rail__select"
        >
          <option
            v-for="c in conversations"
            :key="c.id"
            :value="c.id"
          >{{ c.title }}</option>
        </select>
        <span
          v-else
          class="workspace-rail__empty"
        >No conversation yet.</span>
        <RcButton
          variant="tertiary"
          size="small"
          :disabled="startingConversation"
          @click="newConversation"
        >
          New conversation
        </RcButton>
      </div>
      <template
        v-for="c in conversations"
        :key="c.id"
      >
        <StudioTerminal
          v-if="c.id === currentConversation"
          class="workspace-rail__terminal"
          :session="c.id"
          :command="c.attach.command"
        />
      </template>
    </section>
  </div>
</template>

<style lang="scss" scoped>
.workspace-rail {
  display:        flex;
  flex-direction: column;
  gap:            16px;
  padding:        16px 24px 24px;
  height:         100%;
  min-height:     0;
  overflow:       auto;

  &__head {
    display:         flex;
    align-items:     flex-start;
    justify-content: space-between;
    gap:             16px;
  }

  &__title {
    display:        flex;
    flex-direction: column;
    gap:            2px;
    min-width:      0;
  }

  &__name {
    font-size:   20px;
    font-weight: 700;
  }

  &__subject {
    color: var(--muted);
  }

  &__meta {
    display:     flex;
    align-items: center;
    gap:         14px;
    flex:        0 0 auto;
    font-size:   13px;
  }

  &__agent {
    display:     inline-flex;
    align-items: center;
    gap:         6px;
    color:       var(--muted);

    &--working { color: var(--primary); }
    &--input { color: var(--warning); }
  }

  // The rail
  &__steps {
    display:    flex;
    list-style: none;
    margin:     4px 0 0;
    padding:    0;
  }

  &__step {
    flex:     1 1 0;
    position: relative;

    // The line between dots: from this dot's centre to the next's.
    &::after {
      content:    '';
      position:   absolute;
      top:        13px;
      left:       50%;
      right:      -50%;
      height:     2px;
      background: var(--border);
    }

    &:last-child::after { display: none; }
    &--done::after { background: var(--primary); }
  }

  &__step-btn {
    position:       relative;
    z-index:        1;
    display:        flex;
    flex-direction: column;
    align-items:    center;
    gap:            6px;
    width:          100%;
    padding:        0;
    border:         0;
    background:     transparent;
    color:          var(--muted);
    font:           inherit;
    cursor:         pointer;

    &:disabled { cursor: default; }
  }

  &__dot {
    display:         flex;
    align-items:     center;
    justify-content: center;
    width:           26px;
    height:          26px;
    border-radius:   50%;
    border:          2px solid var(--border);
    background:      var(--body-bg);
    font-size:       12px;
    font-weight:     700;

    .icon { font-size: 12px; }
  }

  &__step--done &__dot {
    background:   var(--primary);
    border-color: var(--primary);
    color:        #fff;
  }

  &__step--now &__dot {
    border-color: var(--warning);
    color:        var(--warning);
    box-shadow:   0 0 0 4px rgba(255, 228, 122, .15);
  }

  &__step--now &__step-label { color: var(--body-text); font-weight: 700; }
  &__step--shown &__step-label { text-decoration: underline; text-underline-offset: 3px; }
  &__step--done &__step-btn:hover &__step-label { color: var(--body-text); }

  &__step-label { font-size: 12px; }

  // The one thing to press
  &__action {
    display:         flex;
    align-items:     center;
    justify-content: space-between;
    gap:             20px;
    padding:         16px 20px;
    border:          1px solid var(--border);
    border-radius:   var(--border-radius);
    background:      var(--box-bg);

    &--attention { border-color: var(--warning); }
    &--green { border-color: var(--success); }
    &--working { border-color: var(--primary); }
  }

  &__action-text {
    display:        flex;
    flex-direction: column;
    gap:            4px;
    min-width:      0;
  }

  &__headline {
    font-size:   16px;
    font-weight: 700;
  }

  &__detail {
    color:     var(--muted);
    font-size: 13px;
    margin:    0;
  }

  &__buttons {
    display:     flex;
    gap:         8px;
    flex:        0 0 auto;
    align-items: center;
  }

  // The two columns
  &__columns {
    display:               grid;
    grid-template-columns: minmax(0, 1fr);
    gap:                   16px;
    align-items:           start;
  }

  &__col--pane {
    padding: 10px 12px;
  }

  &__terminal {
    height:     70vh;
    min-height: 480px;
  }

  &__pane-bar {
    display:     flex;
    align-items: center;
    gap:         10px;
  }

  &__select {
    height:        30px;
    max-width:     420px;
    padding:       0 8px;
    border:        1px solid var(--border);
    border-radius: var(--border-radius);
    background:    var(--input-bg);
    color:         var(--body-text);
    font:          inherit;
  }

  &__md {
    line-height:   1.45;
    overflow-wrap: anywhere;
    white-space:   normal;

    :deep(p) { margin: 0 0 8px; }
    :deep(p:last-child) { margin-bottom: 0; }
    :deep(h1), :deep(h2), :deep(h3), :deep(h4) { margin: 10px 0 6px; font-size: 14px; }
    :deep(h1) { font-size: 16px; }
    :deep(ul), :deep(ol) { margin: 0 0 8px; padding-left: 20px; }
    :deep(code) { font-size: 12px; background: var(--body-bg); padding: 1px 4px; border-radius: 3px; }
    :deep(pre) { background: var(--body-bg); border: 1px solid var(--border); border-radius: var(--border-radius); padding: 8px 10px; overflow-x: auto; }
    :deep(pre code) { background: transparent; padding: 0; }
    :deep(img) { max-width: 100%; }
    :deep(blockquote) { margin: 0 0 8px; padding-left: 10px; border-left: 3px solid var(--border); color: var(--muted); }
    :deep(table) { border-collapse: collapse; }
    :deep(td), :deep(th) { border: 1px solid var(--border); padding: 2px 6px; }
  }

  &__files {
    display:        flex;
    flex-direction: column;
    gap:            8px;
    margin:         6px 0 8px;
  }

  &__file {
    border:        1px solid var(--border);
    border-radius: var(--border-radius);
    overflow:      hidden;
    background:    var(--body-bg);
  }

  &__file-head {
    display:     flex;
    align-items: center;
    gap:         8px;
    padding:     4px 8px;
    border-bottom: 1px solid var(--border);
    font-size:   12px;
  }

  &__code {
    width:           100%;
    border-collapse: collapse;
    font-family:     ui-monospace, 'SFMono-Regular', Menlo, monospace;
    font-size:       12px;
    line-height:     1.45;
    display:         block;
    max-height:      460px;
    overflow:        auto;

    tbody { display: table; width: 100%; }
  }

  &__lineno {
    width:       40px;
    padding:     0 6px;
    text-align:  right;
    color:       var(--muted);
    user-select: none;
    white-space: nowrap;
    vertical-align: top;
  }

  &__codecell {
    padding:     0 8px 0 4px;
    white-space: pre;
  }

  &__sign {
    display:     inline-block;
    width:       10px;
    color:       var(--muted);
  }

  &__code-row--add { background: rgba(152, 195, 121, .12); }
  &__code-row--del { background: rgba(224, 108, 117, .12); }
  &__code-row--hunk { background: var(--box-bg); color: var(--link); }
  &__code-row--marked { outline: 2px solid var(--warning); outline-offset: -2px; }
  &__code-row--marked td { background: rgba(255, 228, 122, .12); }

  &__msg {
    padding:       8px 10px;
    border-radius: var(--border-radius);
    border:        1px solid var(--border);
    background:    var(--body-bg);

    &--author { border-left: 3px solid var(--primary); }
    &--other { border-left: 3px solid var(--warning); background: var(--box-bg); }
  }

  &__msg-head {
    display:       flex;
    align-items:   center;
    gap:           8px;
    margin-bottom: 4px;
    font-size:     12px;
  }

  &__avatar {
    display:         inline-flex;
    align-items:     center;
    justify-content: center;
    width:           20px;
    height:          20px;
    border-radius:   50%;
    background:      var(--primary);
    color:           #fff;
    font-size:       11px;
    font-weight:     700;
  }

  &__views {
    display: flex;
    gap:     12px;
  }

  &__list--plain {
    list-style: none;
    padding:    0;
  }

  &__row-btn {
    display:     inline-flex;
    align-items: center;
    gap:         6px;
    flex-wrap:   wrap;
    border:      0;
    background:  transparent;
    color:       var(--body-text);
    font:        inherit;
    text-align:  left;
    padding:     2px 0;
    cursor:      pointer;

    .icon { font-size: 10px; color: var(--muted); }
  }

  &__diff {
    margin:        6px 0 8px;
    padding:       8px 10px;
    border:        1px solid var(--border);
    border-radius: var(--border-radius);
    background:    var(--body-bg);
    font-size:     12px;
    line-height:   1.45;
    max-height:    420px;
    overflow:      auto;
    white-space:   pre;

    &--add { color: #98c379; background: rgba(152, 195, 121, .12); display: inline-block; min-width: 100%; }
    &--del { color: #e06c75; background: rgba(224, 108, 117, .12); display: inline-block; min-width: 100%; }
    &--hunk { color: var(--link); }
    &--file { color: var(--muted); font-weight: 700; }
  }

  &__comment-more {
    margin-top: 8px;
  }

  &__thread {
    display:        flex;
    flex-direction: column;
    gap:            6px;
    margin-top:     6px;
  }

  &__col {
    display:        flex;
    flex-direction: column;
    gap:            12px;
    padding:        14px 16px;
    border:         1px solid var(--border);
    border-radius:  var(--border-radius);
    background:     var(--box-bg);
    min-width:      0;
  }

  &__col-head {
    display:         flex;
    align-items:     center;
    justify-content: space-between;
    gap:             10px;
  }

  &__col-title {
    margin:         0;
    font-size:      12px;
    font-weight:    700;
    letter-spacing: .06em;
    text-transform: uppercase;
    color:          var(--muted);
  }

  &__back {
    border:     0;
    background: transparent;
    color:      var(--link);
    font:       inherit;
    font-size:  13px;
    cursor:     pointer;
    padding:    0;
  }

  &__reading { color: var(--muted); font-size: 12px; }

  &__section {
    display:        flex;
    flex-direction: column;
    gap:            8px;
  }

  &__section-title {
    margin:      0;
    font-size:   13px;
    font-weight: 700;
  }

  &__text {
    margin:      0;
    white-space: pre-wrap;
    line-height: 1.45;
    max-height:  360px;
    overflow:    auto;
  }

  &__when {
    display:      inline-block;
    margin-right: 8px;
    color:        var(--muted);
    font-size:    12px;
  }

  &__kv {
    display:               grid;
    grid-template-columns: 90px minmax(0, 1fr);
    gap:                   4px 12px;
    margin:                0;
    font-size:             13px;

    dt { color: var(--muted); }
    dd { margin: 0; overflow-wrap: anywhere; }
  }

  &__tone--ok { color: var(--success); }
  &__tone--bad { color: var(--error); }
  &__tone--warn { color: var(--warning); }

  &__list {
    margin:     0;
    padding:    0 0 0 18px;
    font-size:  13px;
    line-height: 1.5;

    code { font-size: 12px; }

    &--files { column-gap: 24px; }
  }

  &__tag {
    display:       inline-block;
    margin-left:   6px;
    padding:       0 6px;
    border-radius: 9px;
    font-size:     11px;
    background:    var(--disabled-bg);
    color:         var(--body-text);

    &--open { background: rgba(255, 228, 122, .18); color: var(--warning); }
  }

  &__media {
    display:               grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap:                   10px;
  }

  &__figure {
    margin: 0;

    video, img {
      width:         100%;
      border-radius: var(--border-radius);
      background:    #000;
    }

    figcaption {
      font-size: 12px;
      color:     var(--muted);
    }
  }

  &__comments {
    display:        flex;
    flex-direction: column;
    gap:            8px;
  }

  &__comment {
    padding:       10px 12px;
    border:        1px solid var(--border);
    border-radius: var(--border-radius);
    background:    var(--body-bg);

    &--open { border-color: var(--warning); }
  }

  &__comment-head {
    display:     flex;
    align-items: center;
    gap:         8px;
    font-size:   12px;
    margin-bottom: 4px;

    code { font-size: 11px; color: var(--muted); }
  }

  &__comment-body {
    white-space: pre-wrap;
    font-size:   13px;
    line-height: 1.45;
  }

  &__links { display: flex; gap: 12px; margin: 0; }

  &__empty {
    color:     var(--muted);
    font-size: 13px;
    margin:    0;

    &--page { padding: 24px; }
  }

  &__loading { color: var(--muted); padding: 24px; }

  &__ask {
    width:         100%;
    box-sizing:    border-box;
    padding:       8px 10px;
    border:        1px solid var(--border);
    border-radius: var(--border-radius);
    background:    var(--input-bg);
    color:         var(--body-text);
    font:          inherit;
    resize:        vertical;
  }
}
</style>
