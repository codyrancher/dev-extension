<script>
// The stage rail: where a workspace's work is, what there is to look at, and the one thing to
// press. The default view of a workspace (WorkspaceDetail); the tabs are a link away.
//
// Every agent action here is a conversation in the agents extension - started with a prompt, or
// a prompt queued into the newest one - so it shows in the Conversations tab and can be talked
// to afterwards. Nothing runs an agent any other way.
import { Banner } from '@components/Banner';
import { RcButton } from '@components/RcButton';
import WorkspaceConversations from './WorkspaceConversations.vue';
import WorkspaceReview from './WorkspaceReview.vue';
import WorkspacePr from './WorkspacePr.vue';
import WorkspaceBrowser from './WorkspaceBrowser.vue';
import WorkspaceShare from './WorkspaceShare.vue';
import DevModal from './DevModal.vue';
import { readStatusNow, noteCoded, agentLabel } from '../workspace-status';
import {
  stepsFor, gatherEvidence, primaryLink, ago, commitPatch, diffRows
} from '../workspace-rail';
import {
  listConversations, startConversation, queuePrompt
} from '../conversations';
import { ensureWorkspaceReady } from '../workspace-tools';
import { startIssueFix, approveAndMerge, DEFAULT_REPO } from '../reviews';
import { markReadyForReview } from '../github';
import { deleteWorkspace } from '../api';
import { DEV_PRODUCT, BLANK_CLUSTER, WORKSPACES_ROUTE } from '../config/constants';

const STATUS_MS = 15000;
const EVIDENCE_MS = 60000;

export default {
  name: 'WorkspaceRail',

  components: {
    Banner, RcButton, WorkspaceConversations, WorkspaceReview, WorkspacePr, WorkspaceBrowser, WorkspaceShare, DevModal
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
      busy:        '',
      error:       '',
      notice:      '',
      timers:      [],
      /** The view open over the page: review, pr, browser or share. */
      modal:       '',
      /** Rows opened to look closer: commits (their patch, read once) and comments (their chain and code). */
      openCommits: {},
      patches:     {},
      openComments: {},
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

    shown() {
      return this.viewing || this.current;
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
              headline: 'No review has run yet', detail: 'Starts a review conversation over the PR.', primary: { label: 'Review this PR', run: 'openTab', arg: 'pr' }, tools: [github],
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
    this.timers = [
      setInterval(() => this.refreshStatus(), STATUS_MS),
      setInterval(() => this.refreshEvidence(), EVIDENCE_MS),
    ];
  },

  beforeUnmount() {
    this.timers.forEach((t) => clearInterval(t));
  },

  methods: {
    ago,

    async load() {
      this.loading = true;
      await this.refreshStatus();
      await this.refreshEvidence();
      this.loading = false;
    },

    async refreshStatus() {
      try {
        const before = this.status?.stage;

        this.status = await readStatusNow(this.workspace.name);
        // A read that worked clears what an earlier one said: a dev-api restart is a minute.
        this.error = '';
        // A stage that moved on is what the page is for; follow it unless a past one is open.
        if (before && before !== this.status.stage && !this.lookingBack) {
          this.viewing = '';
          this.refreshEvidence();
        }
      } catch (e) {
        this.error = e?.message || String(e);
      }
    },

    async refreshEvidence() {
      if (!this.status || this.reading) {
        return;
      }
      this.reading = true;
      try {
        const sections = await gatherEvidence(this.workspace.name, this.status, this.shown);
        const branch = sections.find((s) => s.title === 'The change');

        // The status module learns from here whether the branch has commits (assess vs code).
        noteCoded(this.workspace.name, !!branch);
        this.evidence = sections;
        this.error = '';
      } catch (e) {
        this.error = e?.message || String(e);
      } finally {
        this.reading = false;
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

    async toggleCommit(c) {
      const open = !this.openCommits[c.sha];

      this.openCommits = { ...this.openCommits, [c.sha]: open };
      if (open && !(c.sha in this.patches)) {
        this.patches = { ...this.patches, [c.sha]: 'Reading…' };
        this.patches = { ...this.patches, [c.sha]: (await commitPatch(this.workspace.name, c.sha).catch((e) => `Could not read the commit: ${ e?.message || e }`)) || 'Nothing to show.' };
      }
    },

    toggleComment(c) {
      this.openComments = { ...this.openComments, [c.id]: !this.openComments[c.id] };
    },

    rows(patch) {
      return diffRows(patch);
    },

    /** The newest conversation of the workspace, or a new one: where a prompt goes. */
    async say(title, text) {
      await ensureWorkspaceReady(this.workspace.name);
      const conversations = await listConversations(this.workspace.name).catch(() => []);
      const newest = conversations[conversations.length - 1];

      if (newest && title === '') {
        await queuePrompt(newest.attach, text);

        return newest;
      }

      return startConversation(this.workspace.name, title, text);
    },

    async startFix() {
      if (!this.issue) {
        throw new Error('This workspace is not named for an issue.');
      }
      await startIssueFix(this.$store, { number: this.issue, title: this.workspace.title || '' });
      this.notice = 'The fix conversation has started; it opens the PR when it is done.';
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
      await this.refreshStatus();
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
    <template v-else-if="status && steps.length">
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
            <h3 class="workspace-rail__col-title">{{ lookingBack ? `What ${ shownLabel } left behind` : 'What came back' }}</h3>
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
              <p
                v-if="item.kind === 'text'"
                class="workspace-rail__text"
              ><span
                v-if="item.at"
                class="workspace-rail__when"
              >{{ ago(item.at) }}</span>{{ item.text }}</p>
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
                    @click="toggleCommit(c)"
                  >
                    <i
                      class="icon"
                      :class="openCommits[c.sha] ? 'icon-chevron-down' : 'icon-chevron-right'"
                    /><code>{{ c.sha.slice(0, 7) }}</code> {{ c.message }} <span class="workspace-rail__when">{{ c.who }} · {{ ago(c.at) }}</span>
                  </button>
                  <pre
                    v-if="openCommits[c.sha]"
                    class="workspace-rail__diff"
                  ><span
                    v-for="(r, k) in rows(patches[c.sha] || '')"
                    :key="k"
                    :class="r.cls ? `workspace-rail__diff--${ r.cls }` : ''"
                  >{{ r.text }}
</span></pre>
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
                <div
                  v-for="(c, j) in item.items"
                  :key="c.id || j"
                  class="workspace-rail__comment"
                  :class="{ 'workspace-rail__comment--open': !c.answered }"
                >
                  <button
                    type="button"
                    class="workspace-rail__comment-head workspace-rail__row-btn"
                    :title="c.context || c.thread.length > 1 ? 'Show the code and the chain' : 'Nothing more to show'"
                    @click="toggleComment(c)"
                  ><i
                    class="icon"
                    :class="openComments[c.id] ? 'icon-chevron-down' : 'icon-chevron-right'"
                  /><strong>{{ c.who }}</strong><code>{{ c.where }}</code><span class="workspace-rail__when">{{ ago(c.at) }}</span><span
                    v-if="c.thread.length > 1"
                    class="workspace-rail__tag"
                  >{{ c.thread.length }} in chain</span><span
                    v-if="!c.answered"
                    class="workspace-rail__tag workspace-rail__tag--open"
                  >open</span></button>
                  <div class="workspace-rail__comment-body">{{ c.body }}</div>
                  <div
                    v-if="openComments[c.id]"
                    class="workspace-rail__comment-more"
                  >
                    <pre
                      v-if="c.context"
                      class="workspace-rail__diff"
                    ><span
                      v-for="(r, k) in rows(c.context)"
                      :key="k"
                      :class="r.cls ? `workspace-rail__diff--${ r.cls }` : ''"
                    >{{ r.text }}
</span></pre>
                    <p
                      v-else
                      class="workspace-rail__empty"
                    >The line is not in the PR's diff any more.</p>
                    <div
                      v-if="c.thread.length > 1"
                      class="workspace-rail__thread"
                    >
                      <div
                        v-for="(t, k) in c.thread"
                        :key="k"
                        class="workspace-rail__thread-msg"
                      ><span class="workspace-rail__comment-head"><strong>{{ t.who }}</strong><span class="workspace-rail__when">{{ ago(t.at) }}</span></span><span class="workspace-rail__comment-body">{{ t.body }}</span></div>
                    </div>
                  </div>
                </div>
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

        <!--
          Column two: the conversations themselves - the standard terminal and chat, with the
          list of this workspace's conversations - so the agent is talked to right here. The
          other views open over the page (DevModal) rather than instead of it.
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
                v-if="status.pr || issue"
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
          <WorkspaceConversations
            class="workspace-rail__conversations"
            :workspace="workspace"
            :log-tail="logTail"
          />
        </section>
      </div>

      <DevModal
        v-if="modal"
        :title="modalTitle()"
        @close="modal = ''"
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
      v-else
      class="workspace-rail__empty workspace-rail__empty--page"
    >
      This workspace is not named for an issue or a PR, so it has no stages.
      <a @click.prevent="openTab('conversations')">Open its conversations instead.</a>
    </div>
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
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap:                   16px;
    align-items:           start;
  }

  &__col--pane {
    position: sticky;
    top:      0;
    padding:  10px 12px;
  }

  &__conversations {
    min-height: 70vh;
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
    padding-left:   10px;
    border-left:    2px solid var(--border);
  }

  &__thread-msg {
    display:        flex;
    flex-direction: column;
    gap:            2px;
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
