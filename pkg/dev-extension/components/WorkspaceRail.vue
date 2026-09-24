<script>
// The stage rail: where a workspace's work is, what there is to look at, and the one thing to
// press. The default view of a workspace (WorkspaceDetail); the tabs are a link away.
//
// Every agent action here is a conversation in the agents extension - started with a prompt, or
// a prompt queued into the newest one - so it shows in the Conversations tab and can be talked
// to afterwards. Nothing runs an agent any other way.
import { Banner } from '@components/Banner';
import { RcButton } from '@components/RcButton';
import Tab from '@shell/components/Tabbed/Tab';
// The conversation tabs carry the agent status and the open-larger/close controls in the tab
// header itself (see ConversationTabbed), which is why there is no ConversationHeader bar below.
import ConversationTabbed from './tabbed/ConversationTabbed.vue';
import ConversationTab from './tabbed/ConversationTab.vue';
import StudioTerminal from './StudioTerminal.vue';
import WorkspaceReview from './WorkspaceReview.vue';
import WorkspacePr from './WorkspacePr.vue';
import WorkspaceBrowser from './WorkspaceBrowser.vue';
import WorkspaceShare from './WorkspaceShare.vue';
import DevModal from './DevModal.vue';
import PrButton from './pr/PrButton.vue';
import CommentDiscussion from './pr/CommentDiscussion.vue';
import CommentAttachments from './pr/CommentAttachments.vue';
import ArtifactViewer from './pr/ArtifactViewer.vue';
import {
  readStatusNow, knownStatus, provisionalStatus, agentLabel, agentStateOf, displayTone, setManualStage, clearManualStage, isManual
} from '../workspace-status';
import {
  stepsFor, gatherEvidence, ago, commitFiles, combinedFiles, contextRows, skillsFor, skillPrompt, skillTemplate, promptVars, expandPrompt, ACTION_TEMPLATES
} from '../workspace-rail';
import { prFile } from '../reviews';
import {
  listConversations, startConversation, queuePrompt, startPaneDetached, conversationStates, sendToPane, renameConversation, endConversation
} from '../conversations';
import { ensureWorkspaceReady, putArtifact, devServerState, stopDevServer, startDevServer} from '../workspace-tools';
import {
  startIssueFix, startPrReview, approvePr, mergePr, attachToPr, submitReview, updateComment, deleteComment, forgetPrDetail, DEFAULT_REPO
} from '../reviews';
import {
  readSkill, saveSkill, readPrompts, savePromptTemplate, resetPromptTemplate
} from '../skills';
import { markReadyForReview } from '../github';
import {
  deleteWorkspace, devFetch, workspaceMediaListUrl, setWorkspaceRunning, workspaceProxyUrl, secretValue
} from '../api';
import { DEV_PRODUCT, BLANK_CLUSTER, WORKSPACES_ROUTE } from '../config/constants';

const STATUS_MS = 15000;
const EVIDENCE_MS = 60000;
/**
 * How often the page asks GitHub where the work is, when nothing has been pressed. It used to
 * be five minutes, which is how long a stage that had already moved could sit there saying the
 * old thing. Anything the page itself does re-reads at once (see `settle`); this is for what
 * happens elsewhere - a reviewer approving, the developer pushing.
 */
const GITHUB_MS = 2 * 60000;

export default {
  name: 'WorkspaceRail',

  components: {
    Banner, RcButton, ConversationTabbed, ConversationTab, Tab, StudioTerminal, WorkspaceReview, WorkspacePr, WorkspaceBrowser, WorkspaceShare, DevModal, PrButton, CommentDiscussion, CommentAttachments, ArtifactViewer
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

  emits: ['open-tab', 'switch-view'],

  data() {
    return {
      status:      null,
      evidence:    [],
      /** The stage being looked at: the current one unless a past step was clicked. */
      viewing:     '',
      /** The screenshot or recording open in the pan-and-zoom viewer, if any. */
      shot:        null,
      /** Whether this visit has already made sure the workspace can be worked in. */
      tunnelChecked: false,
      /**
       * The workspace's dev server: whether one is up, and whether it was stopped on purpose.
       * Read behind the page, so the button that stops it only appears when there is one.
       */
      devServer:     { running: false, paused: false },
      /** Whether this visit has already stopped the server for a stage that does not need it. */
      autoStopped:   false,
      /** Whether the person is holding this workspace's stage by hand, and whether the picker is open. */
      manual:      false,
      stagePicker: false,
      loading:     true,
      reading:     false,
      /** Which read of the first column is the current one; an older one landing is ignored. */
      readSeq:     0,
      /** The stage the column currently shows, so a refresh of it is not allowed to shrink it. */
      evidenceStage: '',
      /** The same for the status: one read at a time, and an older one landing cannot regress the stage. */
      statusSeq:   0,
      statusBusy:  false,
      /** A GitHub read that failed is tried again soon: the in-cluster API restarts for a minute after a publish. */
      statusRetry: 0,
      statusRetryTimer: 0,
      /** The same for the column: a PR that would not read is asked for again rather than left out. */
      evidenceRetry: 0,
      evidenceRetryTimer: 0,
      busy:        '',
      error:       '',
      notice:      '',
      timers:      [],
      /** The view open over the page: review, pr, browser or share. */
      modal:       '',
      /** The prompt a button would send, opened with a middle click: what runs, and the skill behind it. */
      inspecting:  null,
      skillDraft:  '',
      skillSaving: '',
      /** The approval being written: its message, what is attached to it, and any trouble. */
      approving:   null,
      /** How loudly to say what went wrong: an API that is restarting is not a failure. */
      errorTone:   'error',
      /** The second look after a change to the PR; cleared when the page goes. */
      settleTimer: null,
      /** A GitHub read queued because the agent just stopped; cleared when the page goes. */
      agentSettleTimer: null,
      /** Which sections are folded away: `{ [title]: true }`, seeded from the section itself. */
      shut:        {},
      /** The conversation, in its own window over the page. */
      popped:      false,
      /** The workspace's own recordings and screenshots, for attaching to one. */
      media:       [],
      /** Attaching or approving, for the spinner. */
      approveBusy: '',
      /** The edited prompt templates, shared through the API, by the action's key. */
      prompts:     {},
      promptDraft: '',
      promptSaving: '',
      /** Which thread each paged section is showing, by that section's title. */
      pages:       {},
      /** Rows opened to look closer: commits (their patch, read once) and comments (their chain and code). */
      openCommits: {},
      /** A commit's files, read once when it is opened. */
      commitFiles: {},
      /** Every commit of a "since" list as one diff, when asked for. */
      combined: {},
      /** Lines read above and below a thread's hunk, when the person asks for more context. */
      moreAbove: {},
      moreBelow: {},
      openComments: {},
      /**
       * A finding of yours, being worked on here rather than over on the PR page: which one is
       * being edited and its draft, which have a discussion open with the agent and the
       * conversation each one is attached to, and which is mid-request.
       */
      editingId:  0,
      editDraft:  '',
      discussing: {},
      discussSession: {},
      commentBusy: 0,
      /** This workspace's conversations, and the one shown - the newest unless another is picked. */
      conversations: [],
      currentConversation: '',
      /**
       * The conversations whose pane is up right now, by id, with the state each one is in.
       * A running agent is watched on the page rather than behind a button: the panel under
       * the action bar shows it at every stage, for a fix and for a review both.
       */
      live:     {},
      /** Which live conversation the panel is showing, when more than one is running. */
      liveShown: '',
      /** Which conversation is being brought back up right now, by id, so its button can wait. */
      resuming:  '',
    };
  },

  computed: {
    /** Which time round the work is at this step: 1 unless a review of yours has already gone. */
    round() {
      return this.status?.round || 1;
    },

    /** The findings on the page that have not been submitted: what an action here acts on. */
    findingCount() {
      return this.evidence
        .flatMap((section) => section.items)
        .filter((item) => item.kind === 'comments')
        .flatMap((item) => item.items)
        .filter((c) => c.local).length;
    },

    /** The repository these workspaces are of. One, for now, as everywhere else here. */
    repo() {
      return DEFAULT_REPO;
    },

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
     * The conversations with a pane up, newest last, each carrying the state its agent is in.
     *
     * `live` is the states poll; `conversations` is what they are called and how to attach to
     * one. A conversation only appears here once both know about it, which is what stops a
     * pane being drawn for an id whose command is not loaded yet.
     */
    liveConversations() {
      return this.conversations
        .filter((c) => this.live[c.id])
        .map((c) => ({ ...c, agent: this.live[c.id] }));
    },

    /** The one the panel draws: the picked tab while it is still running, else the newest. */
    shownLive() {
      const live = this.liveConversations;

      return live.find((c) => c.id === this.liveShown) || live[live.length - 1] || null;
    },

    /**
     * Every conversation this workspace has, running or not, newest last - so the strip is there
     * on every stage the moment the work has a conversation, not only while a pane is up. A
     * conversation with no pane (the agent finished, or the pod was restarted) still shows as a
     * tab; opening it resumes it (resumeConversation), rather than a conversation that plainly
     * exists being invisible until something happens to be running.
     */
    railConversations() {
      return this.conversations.map((c) => ({
        ...c, alive: !!this.live[c.id], agent: this.live[c.id] || 'idle',
      }));
    },

    /** The one the panel draws, across running and not: the picked tab, else the newest. */
    shownConversation() {
      const all = this.railConversations;

      return all.find((c) => c.id === this.liveShown) || all[all.length - 1] || null;
    },

    /**
     * The one thing to press now, and the tools beside it, by stage. `run` names the method.
     * A fix with no conversation at all is the stage before the rail: start it.
     */
    /**
     * The whole action box follows the step being looked at, not only its buttons: a past
     * stage that kept the current one's headline read as if the page had not moved at all.
     */
    action() {
      const s = this.status;

      if (!s) {
        return null;
      }
      const stage = this.shown;
      // No "open on GitHub" among these: the header already links the issue and the PR, and
      // what belongs here is what the page itself can do - the steps that would otherwise be
      // taken by hand.
      const conversation = { label: 'Open the conversation', run: 'openTab', arg: 'conversations' };

      if (s.kind === 'fix') {
        switch (stage) {
        case 'assess':
          // An issue workspace is here to be fixed, so "Fix it" is the action at this stage whatever
          // the agent is doing: it runs the whole my-issue-fix flow - reproduce, fix, verify, open a
          // draft PR. It is the primary while nothing is being worked, and a tool while the agent is
          // mid-assessment so it does not cut across a conversation already going. The assessment
          // skills (reproduce, root cause) sit beside it under "Ask the agent".
          if (s.agent === 'input') {
            return {
              headline: 'The agent is waiting for an answer', detail: 'It asked something in its conversation and stopped until it hears back.', primary: { label: 'Answer it', run: 'openTab', arg: 'conversations' }, tools: [{ label: 'Fix it', run: 'startFix' }],
            };
          }
          if (s.agent === 'working') {
            return {
              headline: 'The agent is looking at the issue', detail: 'Follow along in the conversation, or tell it to go ahead and fix it.', primary: conversation, tools: [{ label: 'Fix it', run: 'startFix' }],
            };
          }

          return {
            headline: s.agent === 'none' ? 'Nothing has started on this issue' : 'The agent stopped before opening a PR', detail: 'Fix it starts a conversation that reproduces the issue, fixes it, verifies the fix and opens a draft PR.', primary: { label: 'Fix it', run: 'startFix' }, tools: s.agent === 'none' ? [] : [conversation],
          };
        case 'code':
          if (s.agent === 'input') {
            return {
              headline: 'The agent is waiting for an answer', detail: 'It asked something in its conversation and stopped until it hears back.', primary: { label: 'Answer it', run: 'openTab', arg: 'conversations' }, tools: [],
            };
          }

          return {
            headline: s.agent === 'working' ? 'The agent is working on the fix' : 'The agent stopped before opening a PR', detail: s.agent === 'working' ? 'Follow along in the conversation, or ask it something below.' : 'Read its report on the left; ask it to carry on, or to change course, below.', primary: conversation, tools: [{ label: 'Open the PR flow again', run: 'startFix' }],
          };
        case 'draft':
          return {
            headline: 'The draft PR is ready for you to read', detail: 'Read the description and the change on the left. Marking it ready is yours; so is the reviewer, on GitHub.', primary: { label: 'Mark ready for review', run: 'markReady' }, tools: [{ label: 'Ask for a change', run: 'focusAsk' }],
          };
        case 'review':
          return {
            headline: 'Waiting for a reviewer', detail: 'Nothing here is yours until someone comments. The agent can still be asked for something meanwhile.', primary: { label: 'Ask the agent', run: 'focusAsk' }, tools: [],
          };
        case 'feedback':
          return {
            headline: 'Reviewers left comments after your last push', detail: 'The agent reads each comment, answers or changes the code, re-verifies and pushes. You read its report before anything else happens.', primary: { label: 'Answer the feedback', run: 'answerFeedback' }, tools: [{ label: 'Re-verify the fix', run: 'reverify' }, { label: 'Ask the agent', run: 'focusAsk' }],
          };
        case 'merged':
          return {
            headline: s.label === 'Approved' ? 'Approved' : 'Merged', detail: 'The workspace can go; the PR and the conversation history stay on GitHub and in the agent pod.', primary: { label: 'Delete the workspace', run: 'remove' }, tools: s.label === 'Approved' ? [{ label: 'Merge', run: 'merge' }] : [],
          };
        }
      }
      if (s.kind === 'review') {
        switch (stage) {
        case 'agent':
          if (s.agent === 'none') {
            return {
              headline: 'No review has run yet', detail: 'Starts a review conversation over the PR; its findings land on the left as it goes.', primary: { label: 'Review this PR', run: 'startReview' }, tools: [],
            };
          }

          return {
            headline: s.agent === 'working' ? 'The agent is reviewing' : 'The agent stopped', detail: 'Its findings land on the left as it goes; go through them once it is done.', primary: conversation, tools: [],
          };
        case 'findings':
          // A pass ends one of three ways, and all three are here: send the findings back as
          // changes to make, approve with them attached, or approve and let them go. Each
          // marked-good finding rides along; the cards on the left are where they are read.
          //
          // A pass after a review of yours is another round of the same step, so it says so
          // and offers the agent another look at what the developer did.
          // Every finding went, so the two buttons that carry findings back to GitHub have
          // nothing to carry. The pass is still yours: ship it, or send the agent round again.
          if (s.label === 'nothing left to go through') {
            return {
              headline: 'Nothing left from the agent\'s pass',
              detail:   'Its findings have all been read and cleared. Ship the PR, or ask for another look.',
              primary:  { label: 'Ship it', run: 'openApprove' },
              tools:    [
                { label: 'Review this PR again', run: s.reviewed ? 'reviewAgain' : 'startReview' },
                { label: 'Open the whole PR', run: 'openTab', arg: 'pr' },
                { label: 'Ask the agent', run: 'focusAsk' },
              ],
            };
          }

          return {
            headline: s.reviewed ? 'A new pass over what the agent found in the developer\'s changes' : 'The agent\'s findings are ready for your pass',
            detail:   s.reviewed ? 'The findings are on the left, under them what the agent looked at, then the commits and threads of this round.' : 'Go through them on the left: keep the ones you agree with, then send them back or approve.',
            primary:  { label: 'Ask for changes', run: 'requestChanges' },
            tools:    [
              { label: 'Ship it with comments', run: 'shipWithComments' },
              { label: 'Ship it', run: 'openApprove' },
              ...(s.reviewed ? [{ label: 'Review the new commits again', run: 'reviewAgain' }] : []),
              { label: 'Open the whole PR', run: 'openTab', arg: 'pr' },
              { label: 'Ask the agent', run: 'focusAsk' },
            ],
          };
        case 'submitted':
          return {
            headline: 'Your review is with the developer', detail: 'This moves on when they push or reply. Your comments are on the left; the PR and its diff are a click away.', primary: { label: 'Approve', run: 'openApprove' }, tools: [{ label: 'Go through the findings', run: 'openTab', arg: 'pr' }, { label: 'Review the branch', run: 'openTab', arg: 'review' }],
          };
        case 'response':
          // Nothing is filed yet: what the agent finds puts the rail back on Your pass, which
          // is where findings are gone through, whichever round it is.
          return {
            headline: 'The developer responded', detail: 'New commits and replies since your review are on the left. The agent can review what changed against your comments; what it finds comes back here as a second pass.', primary: { label: 'Review the new commits', run: 'reviewAgain' }, tools: [{ label: 'Open the whole PR', run: 'openTab', arg: 'pr' }, { label: 'Approve', run: 'openApprove' }],
          };
        case 'approved':
          return {
            // Your part is over either way: merging is the author's, so what is left here is
            // to let the workspace go. The conversations and the PR outlive it.
            headline: s.label === 'Merged' ? 'Merged' : 'Approved', detail: s.label === 'Merged' ? 'Nothing left to do; the workspace can go.' : 'Your review is done. The author merges; the workspace can go whenever you are finished with it.', primary: { label: 'Delete the workspace', run: 'remove' }, tools: [],
          };
        }
      }

      return null;
    },
  },

  watch: {
    evidence() {
      this.$nextTick(() => this.watchMedia());
    },

    'workspace.name'() {
      this.viewing = '';
      this.load();
    },
  },

  mounted() {
    this.load();
    this.loadConversations();
    readPrompts().then((p) => {
      this.prompts = p;
    }).catch(() => {});
    this.refreshLive();
    this.timers = [
      // The agents every fifteen seconds; GitHub every five minutes and after an action - not
      // on every tick, which overlapped itself on a big PR.
      setInterval(() => this.refreshStatus(false), STATUS_MS),
      // Which panes are up, on the same beat as the status: the panel under the action bar
      // appears and goes on its own as agents start and stop.
      setInterval(() => this.refreshLive(), STATUS_MS),
      setInterval(() => this.refreshStatus(true), GITHUB_MS),
      setInterval(() => this.refreshEvidence(), EVIDENCE_MS),
    ];
  },

  beforeUnmount() {
    this.timers.forEach((t) => clearInterval(t));
    clearTimeout(this.statusRetryTimer);
    clearTimeout(this.evidenceRetryTimer);
    clearTimeout(this.settleTimer);
    clearTimeout(this.agentSettleTimer);
  },

  methods: {
    ago,
    agentLabel,
    displayTone,

    async load() {
      // What the sidebar last read is drawn now, or what the name alone says - the kind, the
      // steps, the links - and the fresh read lands behind it. The page is never blank for
      // GitHub's sake.
      this.status = knownStatus(this.workspace.name) || provisionalStatus(this.workspace.name);
      this.loading = false;
      this.refreshEvidence();
      this.ensureTunnel();
      await this.refreshStatus();
      await this.refreshEvidence();
      this.readDevServer();
    },

    /** What the workspace's dev server is doing, for the button and the automatic stop. */
    async readDevServer() {
      if (!this.workspace?.name) {
        return;
      }
      this.devServer = await devServerState(this.workspace.name).catch(() => ({ running: false, paused: false }));
      await this.stopForStage();
    },

    /**
     * Stop the dev server for a stage that cannot use it.
     *
     * A fix whose PR is up is waiting on a person, not on a page: there is nothing to look at
     * in a dev server until somebody comes back with a comment, and a webpack holding two
     * gigabytes in the meantime is the most expensive idle thing on the node. The same is true
     * once the work is merged. Done once per visit, and never for a stage where the server is
     * the point - assessing, coding, reading a draft, answering feedback, or any review, where
     * the reviewer may well want the app in front of them.
     */
    async stopForStage() {
      const idle = ['review', 'merged'];
      let kept = false;

      try {
        kept = !!sessionStorage.getItem(`dev-extension.dev-server-kept.${ this.workspace.name }`);
      } catch { /* no storage: the stop applies, which is the old behaviour */ }

      // Never against a person who has just started it, and never twice in one visit.
      if (kept || this.autoStopped || !this.devServer.running || this.status?.kind !== 'fix' || !idle.includes(this.status?.stage)) {
        return;
      }
      this.autoStopped = true;
      try {
        await stopDevServer(this.workspace.name);
        this.devServer = { running: false, paused: true };
        this.notice = 'The dev server is stopped while this waits on a reviewer; start it again from the button when you need it.';
      } catch (e) {
        console.debug(`[rail] stopping the dev server: ${ e?.message || e }`); // eslint-disable-line no-console
      }
    },

    /** Start it again, because somebody pressed the button. */
    async startServer() {
      this.busy = 'startServer';
      this.error = '';
      try {
        const said = await startDevServer(this.workspace.name);

        // Remembered for this browser: the automatic stop must not undo a person's start the
        // next time they open the workspace, which is what made this feel like a fight.
        try {
          sessionStorage.setItem(`dev-extension.dev-server-kept.${ this.workspace.name }`, '1');
        } catch { /* a browser without storage just gets the stop again */ }
        this.devServer = { running: true, paused: false };
        this.notice = said.trim().split('\n').pop() || 'The dev server is starting; it takes a minute or two to compile.';
      } catch (e) {
        this.noteError(e);
      } finally {
        this.busy = '';
      }
    },

    /** Stop it because somebody pressed the button. */
    async stopServer() {
      this.busy = 'stopServer';
      this.error = '';
      try {
        const said = await stopDevServer(this.workspace.name);

        this.devServer = { running: false, paused: true };
        this.notice = said.trim().split('\n').pop() || 'The dev server is stopped.';
      } catch (e) {
        this.noteError(e);
      } finally {
        this.busy = '';
      }
    },

    /**
     * Make sure this workspace can be worked in, once per visit, behind the page.
     *
     * A workspace made for an issue that had one before starts on whatever its old tree left
     * on the node, and nothing else asks for the seed until somebody starts a conversation -
     * so a workspace with a conversation already in it (inherited from the one before) had no
     * `bin/dev-shell` and every command in it failed on a missing file. Asked for here
     * instead, where opening the workspace is the thing that happens first.
     *
     * Cheap when everything is in place, and never in the way: it does not block the draw, and
     * a failure is a line in the page rather than an empty page.
     */
    async ensureTunnel() {
      if (this.tunnelChecked || !this.workspace?.name) {
        return;
      }
      this.tunnelChecked = true;
      try {
        await ensureWorkspaceReady(this.workspace.name);
      } catch (e) {
        console.debug(`[rail] workspace setup: ${ e?.message || e }`); // eslint-disable-line no-console
      }
    },

    /**
     * Say what went wrong, in the register it deserves.
     *
     * "no endpoints available for service dev-api" is what the cluster says for the half minute
     * after the in-cluster API is replaced, which happens on the first page load after this
     * extension is updated. Nothing is broken and nothing needs doing, so it does not get the
     * red banner an actual failure gets.
     */
    noteError(e) {
      const message = e?.message || String(e);

      if (/no endpoints available for service/i.test(message)) {
        this.error = 'The in-cluster API is restarting after an update. This page picks itself up in a moment.';
        this.errorTone = 'warning';

        return;
      }
      this.error = message;
      this.errorTone = 'error';
    },

    async refreshStatus(github = true) {
      if (this.statusBusy) {
        return;
      }
      const seq = ++this.statusSeq;

      this.statusBusy = true;
      try {
        const before = this.status?.stage;
        const beforeAgent = this.status?.agent;
        const t0 = Date.now();
        const next = await readStatusNow(this.workspace.name, github);

        if (seq !== this.statusSeq) {
          return;
        }
        this.status = next;
        this.manual = isManual(this.workspace.name);
        // An agent that has just stopped working may have opened a PR or sent a review this second;
        // rather than wait out the two-minute GitHub poll for the stage to catch up, ask now. The
        // short wait lets GitHub reflect what the agent did, and this only fires on the agent-state
        // tick (github=false), so it does not chase its own tail.
        if (!github && beforeAgent === 'working' && next.agent !== 'working') {
          clearTimeout(this.agentSettleTimer);
          this.agentSettleTimer = setTimeout(() => this.refreshStatus(true), 2500);
        }
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
        this.noteError(e);
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
        const fresh = this.evidenceStage !== stage;

        const sections = await gatherEvidence(this.workspace.name, this.status, stage, (partial) => {
          console.debug(`[rail] evidence ${ seq } ${ stage } partial: ${ partial.map((s) => s.title).join(' | ') } current=${ current() }`); // eslint-disable-line no-console
          // A refresh of the stage already on the page never shows less than it had: the
          // column would empty and regrow every minute under whoever is reading it.
          if (current() && (fresh || partial.length >= this.evidence.length)) {
            this.evidence = partial;
            this.evidenceStage = stage;
          }
        });
        if (current()) {
          this.evidence = sections;
          this.evidenceStage = stage;
        }
        // A section that says it could not be read is asked for again in a few seconds, a
        // few times: the usual cause is the in-cluster API restarting, which is a minute.
        const failed = sections.some((x) => x.title === 'The pull request could not be read');

        clearTimeout(this.evidenceRetryTimer);
        if (failed && this.evidenceRetry < 5) {
          this.evidenceRetry++;
          this.evidenceRetryTimer = setTimeout(() => this.refreshEvidence(), 4000 * this.evidenceRetry);
        } else if (!failed) {
          this.evidenceRetry = 0;
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
      this.evidenceStage = '';
      this.refreshEvidence();
    },

    backToNow() {
      this.viewing = '';
      this.evidence = [];
      this.evidenceStage = '';
      this.refreshEvidence();
    },

    /**
     * Set the stage by hand when the heuristics have it wrong. It holds against the agent-state
     * guesses, and is superseded only when a hard GitHub fact overtakes it (the PR merges, a real
     * one opens, a review goes out) - so a correction sticks without freezing the work in place.
     */
    async chooseStage(key) {
      this.stagePicker = false;
      if (key === this.current && this.manual) {
        return;
      }
      try {
        await setManualStage(this.workspace.name, key);
        this.manual = true;
        await this.refreshStatus(true);
      } catch (e) {
        this.noteError(e);
      }
    },

    /** Hand the stage back to the automatic heuristics. */
    async stageToAuto() {
      try {
        await clearManualStage(this.workspace.name);
        this.manual = false;
        await this.refreshStatus(true);
      } catch (e) {
        this.noteError(e);
      }
    },

    /**
     * A step this review went through in an earlier round: after a first review, Submitted and
     * Developer responded are behind you as well as ahead, so they keep their ticks rather than
     * going back to being plain numbers.
     */
    /**
     * A click on a screenshot inside a rendered body: open it in the viewer.
     *
     * Delegated, because the bodies are markdown rendered to HTML and their images are not
     * this template's elements. Only images: a click anywhere else in a report is a click on
     * text, and a link is still a link.
     */
    openShot(event) {
      const img = event?.target;

      if (!img || img.tagName !== 'IMG' || !img.src || img.closest('a')) {
        return;
      }
      event.preventDefault();
      this.shot = { src: img.src, name: img.alt || 'screenshot', caption: '' };
    },

    /** Whether a section is folded: what was chosen for it here, else what it asked for. */
    isShut(section) {
      return this.shut[section.title] ?? !!section.collapsed;
    },

    toggleSection(section) {
      this.shut = { ...this.shut, [section.title]: !this.isShut(section) };
    },

    doneBefore(index) {
      return this.round > 1 && !!this.steps[index] && ['submitted', 'response'].includes(this.steps[index].key) && index > this.currentIndex;
    },

    stepClass(step, index) {
      return {
        'workspace-rail__step--done':    index < this.currentIndex,
        'workspace-rail__step--now':     index === this.currentIndex,
        'workspace-rail__step--shown':   step.key === this.shown,
        'workspace-rail__step--future':  index > this.currentIndex,
        'workspace-rail__step--again':   this.doneBefore(index),
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
        this.noteError(e);
      } finally {
        this.busy = '';
      }
    },

    /** The conversation is on the page; every other view opens over it. */
    openTab(name) {
      // A conversation is its own window now, so "go to the conversation" opens it rather
      // than scrolling to a pane that is no longer on the page.
      if (name === 'conversations') {
        this.popped = true;

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

    /** What names an action's prompt in the shared store: the skill, or the method it runs. */
    keyOf(action) {
      return action?.skill || action?.run || '';
    },

    /** The template an action sends - the edited one where there is one, else what shipped. */
    templateOf(action) {
      const key = this.keyOf(action);

      return this.prompts[key] || (action?.skill ? skillTemplate(action) : ACTION_TEMPLATES[action?.run] || '');
    },

    /** Everything a template may write, with what each one is right now. */
    varsNow() {
      return [
        ...promptVars(this.status, this.issue, this.workspace.name),
        { name: 'contextClause', value: this.status?.pr ? ` - its context: $CLAUDE_HARNESS_API/my-work/pr/${ this.status.pr }.` : '.', about: 'Where to read the PR, or just a full stop' },
      ];
    },

    /**
     * The prompt an action sends, with the variables filled in. '' for the actions that are
     * not an agent's: marking a PR ready, merging, opening a view.
     */
    promptOf(run) {
      const template = this.prompts[run] || ACTION_TEMPLATES[run] || '';

      return template ? expandPrompt(template, this.varsNow()) : '';
    },

    /**
     * The middle button, on `mousedown` (so the browser's autoscroll never starts) and again
     * on `auxclick` (which is where a click of it lands). Either one opens what the button
     * sends; the second is ignored because the first already opened it.
     */
    onAux(action, event) {
      if (event.button !== 1 || !this.startsAgent(action)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.type === 'mousedown') {
        this.inspect(action, event);
      }
    },

    /** Whether pressing this starts an agent - the actions that queue a prompt or run a skill. */
    startsAgent(action) {
      return !!action && (!!action.skill || !!this.promptOf(action.run));
    },

    /**
     * Which of the two groups a button belongs in. "Your call" is the decisions only the
     * person makes - mark ready, approve, merge, delete. Everything that ends up in a
     * conversation with the agent belongs on the agent's side, whether it queues a prompt
     * itself or only puts the cursor in the box below: a button reading "Ask the agent"
     * under a heading reading "Your call" says nothing at all.
     */
    agentSide(action) {
      if (!action) {
        return false;
      }

      return this.startsAgent(action) || action.run === 'focusAsk' || (action.run === 'openTab' && action.arg === 'conversations');
    },

    /** The skill a prompt runs, if it opens with one. */
    skillIn(prompt) {
      return /^\/([a-z0-9-]+)/.exec(prompt || '')?.[1] || '';
    },

    /**
     * Middle click: what this button actually sends, and the skill behind it, read from the
     * seed the workspaces are laid out from - editable here, saved for every workspace and
     * optionally committed, the same way the Skills page does it.
     */
    async inspect(action, event) {
      if (event) {
        event.preventDefault();
      }
      const template = this.templateOf(action);

      if (!template) {
        return;
      }
      const key = this.keyOf(action);
      const skill = action.skill || this.skillIn(expandPrompt(template, this.varsNow()));

      this.inspecting = {
        label: action.label, action, key, skill, content: '', error: '', edited: !!this.prompts[key],
      };
      this.promptDraft = template;
      this.skillDraft = '';
      if (skill) {
        try {
          const read = await readSkill(skill);

          this.inspecting = { ...this.inspecting, content: read.content, overridden: read.overridden };
          this.skillDraft = read.content;
        } catch (e) {
          this.inspecting = { ...this.inspecting, error: `The skill ${ skill } could not be read: ${ e?.message || e }` };
        }
      }
    },

    /** A variable as it is written in a template, and putting one into the draft. */
    varToken(v) {
      return `{${ '{' } ${ v.name } }${ '}' }`;
    },

    insertVar(v) {
      this.promptDraft = `${ this.promptDraft }${ this.promptDraft.endsWith(' ') || !this.promptDraft ? '' : ' ' }${ this.varToken(v) }`;
    },

    /** The prompt as it would be sent right now, with the draft's variables filled in. */
    promptPreview() {
      return expandPrompt(this.promptDraft, this.varsNow());
    },

    /** Send the draft as it stands, without keeping it. */
    async sendDraft() {
      const action = this.inspecting?.action;

      if (!action || this.promptSaving) {
        return;
      }
      this.promptSaving = 'send';
      try {
        await this.say(action.fresh ? `${ action.label } #${ this.status?.pr || this.issue }` : '', this.promptPreview(), !action.fresh);
        this.notice = `${ action.label }: sent as edited; the agent is on it below.`;
        this.inspecting = null;
      } catch (e) {
        this.inspecting = { ...this.inspecting, error: e?.message || String(e) };
      } finally {
        this.promptSaving = '';
      }
    },

    /** Keep the draft as what this button sends, for every workspace and everyone. */
    async savePrompt() {
      if (!this.inspecting || this.promptSaving) {
        return;
      }
      this.promptSaving = 'save';
      try {
        await savePromptTemplate(this.inspecting.key, this.promptDraft);
        this.prompts = { ...this.prompts, [this.inspecting.key]: this.promptDraft };
        this.inspecting = { ...this.inspecting, edited: true };
        this.notice = `${ this.inspecting.label }: this is what the button sends from now on.`;
      } catch (e) {
        this.inspecting = { ...this.inspecting, error: e?.message || String(e) };
      } finally {
        this.promptSaving = '';
      }
    },

    async resetPrompt() {
      if (!this.inspecting || this.promptSaving) {
        return;
      }
      this.promptSaving = 'reset';
      try {
        await resetPromptTemplate(this.inspecting.key);
        const { [this.inspecting.key]: gone, ...rest } = this.prompts;

        this.prompts = rest;
        this.promptDraft = this.templateOf(this.inspecting.action);
        this.inspecting = { ...this.inspecting, edited: false };
      } catch (e) {
        this.inspecting = { ...this.inspecting, error: e?.message || String(e) };
      } finally {
        this.promptSaving = '';
      }
    },

    async saveInspected(commit) {
      if (!this.inspecting?.skill || this.skillSaving) {
        return;
      }
      this.skillSaving = commit ? 'commit' : 'save';
      try {
        await saveSkill(this.inspecting.skill, this.skillDraft, commit, `Skill ${ this.inspecting.skill }: edited from a workspace`);
        this.inspecting = { ...this.inspecting, content: this.skillDraft, overridden: true };
        this.notice = `${ this.inspecting.skill } saved${ commit ? ' and committed' : '' }; every workspace picks it up.`;
      } catch (e) {
        this.inspecting = { ...this.inspecting, error: e?.message || String(e) };
      } finally {
        this.skillSaving = '';
      }
    },

    /** The skills worth running where the work is; each one is a prompt into its conversation. */
    skillButtons() {
      return this.status ? skillsFor(this.status.kind, this.shown) : [];
    },

    /**
     * The stage's own actions, split by what they are rather than by where they were written:
     * anything that sends a prompt belongs beside the skills, and "your call" holds only the
     * decisions - reading the findings, marking ready, merging, deleting.
     */
    actionsFor(kind) {
      if (!this.action) {
        return [];
      }
      const all = [...this.action.tools, { ...this.action.primary, isPrimary: true }];

      return all.filter((a) => (kind === 'agent' ? this.agentSide(a) : !this.agentSide(a)));
    },

    /**
     * The tools for verifying the work by hand, kept apart from the decisions in their own group.
     * They belong at the two stages where you look at a running build - Code, while the fix is
     * being written, and Your pass, while a PR is being reviewed - and nowhere a build is not the
     * point. A preview has no dev server of its own to drive, so it gets none of these.
     */
    verifyTools() {
      const s = this.status;

      if (!s || this.lookingBack || this.workspace?.preview) {
        return [];
      }
      // The current stage, not the one being viewed (`shown` falls back to a middle stage before the
      // first status read, which would flash these on a workspace that is really elsewhere). Looking
      // back is already excluded above, so current and shown agree whenever this returns anything.
      const here = (s.kind === 'fix' && this.current === 'code') || (s.kind === 'review' && this.current === 'findings');

      if (!here) {
        return [];
      }

      return [
        { label: this.workspace?.state === 'stopped' ? 'Start the dev server' : 'Stop the dev server', run: 'toggleServer' },
        { label: 'Open the app', run: 'openApp' },
        { label: 'Copy password', run: 'copyPassword' },
      ];
    },

    /** Start the dev server if it is stopped, else stop it; the page's own poll flips the label. */
    async toggleServer() {
      const start = this.workspace?.state === 'stopped';

      await setWorkspaceRunning(this.workspace.name, start, this.workspace.cluster || 'local');
      this.notice = start ? 'Starting the dev server - it is ready to open once it says Running.' : 'Stopping the dev server.';
    },

    /** Open the workspace's running app in a new tab, to look at the change for real. */
    openApp() {
      const w = this.workspace;

      // A stopped deployment has no endpoints, so the proxy would open to an error page. Say so
      // rather than hand back a dead tab. (Kept synchronous - window.open must run in the click.)
      if (w?.state !== 'running') {
        this.notice = 'Start the dev server first, then Open the app shows the running build.';

        return;
      }
      window.open(workspaceProxyUrl(w.name, w.port, w.scheme), '_blank', 'noopener');
    },

    /** Copy the saved Rancher password so it can be pasted into the app's login page (user "admin"). */
    async copyPassword() {
      const password = await secretValue('RANCHER_PASSWORD').catch(() => '');

      if (!password) {
        this.notice = 'No Rancher password is saved yet. Add one in Settings (the gear, top right) and this copies it for the login page.';

        return;
      }
      try {
        await navigator.clipboard.writeText(password);
        this.notice = 'Password copied. Paste it into the app\'s login page, with the user "admin".';
      } catch {
        this.error = 'The browser would not let this copy to the clipboard.';
      }
    },

    async runSkill(button) {
      if (this.busy) {
        return;
      }
      this.busy = button.skill;
      this.error = '';
      this.notice = '';
      try {
        const text = skillPrompt(button, this.status, this.issue, this.workspace.name, this.templateOf(button));

        await this.say(button.fresh ? `${ button.label } #${ this.status.pr || this.issue }` : '', text, !button.fresh);
        this.notice = `${ button.label }: the agent is on it in the conversation below.`;
      } catch (e) {
        this.error = e?.message || String(e);
      } finally {
        this.busy = '';
      }
    },

    /*
     * A finding of yours, acted on where it is read. These are the PR panel's own actions on a
     * pending comment - mark it good, edit the wording, talk it over with the agent, drop it -
     * because going through the findings is the whole of this stage, and sending someone to
     * another page to do it is the thing the rail exists to stop.
     */

    /** Mark a finding good, or take the mark off: the same toggle the PR panel has. */
    async markGood(c) {
      await this.changeComment(c, () => updateComment(this.status.pr, c.id, { status: c.status === 'approved' ? 'pending' : 'approved' }));
    },

    startEdit(c) {
      this.editingId = c.id;
      this.editDraft = c.thread?.[0]?.body || c.body || '';
    },

    cancelEdit() {
      this.editingId = 0;
      this.editDraft = '';
    },

    async saveEdit(c) {
      const body = this.editDraft.trim();

      if (!body) {
        return;
      }
      await this.changeComment(c, () => updateComment(this.status.pr, c.id, { body }));
      this.editingId = 0;
      this.editDraft = '';
    },

    async dropFinding(c) {
      // eslint-disable-next-line no-alert
      if (!window.confirm('Delete this finding? It has not been submitted to GitHub, so it only goes from here.')) {
        return;
      }
      await this.changeComment(c, () => deleteComment(this.status.pr, c.id));
    },

    /** Talk one finding over with the agent, in a conversation of its own under the card. */
    toggleDiscuss(c) {
      this.discussing = { ...this.discussing, [c.id]: !this.discussing[c.id] };
    },

    rememberDiscussion(c, session) {
      this.discussSession = { ...this.discussSession, [c.id]: session };
    },

    /** One change to a finding: run it, forget the memoised PR, and read the column again. */
    async changeComment(c, run) {
      if (this.commentBusy) {
        return;
      }
      this.commentBusy = c.id;
      this.error = '';
      try {
        await run();
        forgetPrDetail(this.status.pr);
        await this.refreshEvidence();
        this.refreshStatus(true);
      } catch (e) {
        this.error = e?.message || String(e);
      } finally {
        this.commentBusy = 0;
      }
    },

    /** Everything pushed since a moment, as one diff: the commits of that section together. */
    async showCombined(item) {
      const key = item.items.map((c) => c.sha).join(',');

      if (this.combined[key]) {
        this.combined = { ...this.combined, [key]: null };

        return;
      }
      this.combined = { ...this.combined, [key]: 'reading' };
      const files = await combinedFiles(item.pr, item.items.map((c) => c.sha)).catch(() => []);

      this.combined = { ...this.combined, [key]: files.length ? files : 'none' };
    },

    /** The commits of a section that can be shown as one diff, if it has any. */
    combinedItem(section) {
      return section.items.find((item) => item.kind === 'commits' && item.items.length > 1 && item.pr) || null;
    },

    combinedFor(item) {
      return this.combined[item.items.map((c) => c.sha).join(',')];
    },

    /**
     * More of the file around a thread's hunk, read from the PR's head and put above or below
     * the rows it already has.
     */
    async extend(c, where) {
      const store = where === 'up' ? this.moreAbove : this.moreBelow;
      const had = store[c.id] || 0;
      const rows = c.rows.filter((r) => r.newN);

      if (!rows.length || !c.headSha || !c.path) {
        return;
      }
      const first = rows[0].newN - had;
      const last = rows[rows.length - 1].newN + had;
      const from = where === 'up' ? Math.max(1, first - 20) : last + 1;
      const to = where === 'up' ? first - 1 : last + 20;

      if (to < from) {
        return;
      }
      try {
        const text = await prFile(this.status.pr, c.path, c.headSha);
        const extra = contextRows(c.path, text, from, to);

        if (where === 'up') {
          this.moreAbove = { ...this.moreAbove, [c.id]: had + extra.length, [`${ c.id }-rows`]: [...extra, ...(this.moreAbove[`${ c.id }-rows`] || [])] };
        } else {
          this.moreBelow = { ...this.moreBelow, [c.id]: had + extra.length, [`${ c.id }-rows`]: [...(this.moreBelow[`${ c.id }-rows`] || []), ...extra] };
        }
      } catch (e) {
        this.error = `More of ${ c.path } could not be read: ${ e?.message || e }`;
      }
    },

    /**
     * An attachment GitHub no longer has - some of the older ones are simply gone, and 404 to
     * the signed-in browser too - shows its caption rather than a broken picture. Attached
     * after each render, once per element; the HTML itself comes from the comment bodies, so
     * there is nowhere in it to put a handler.
     */
    watchMedia() {
      for (const img of this.$el?.querySelectorAll?.('.md-body img:not([data-watched])') || []) {
        img.dataset.watched = '1';
        img.addEventListener('error', () => {
          const gone = document.createElement('span');

          gone.className = 'workspace-rail__gone';
          gone.textContent = img.getAttribute('alt') ? `${ img.getAttribute('alt') } (the attachment is no longer on GitHub)` : 'An attachment that is no longer on GitHub';
          img.replaceWith(gone);
        }, { once: true });
      }
    },

    /** Which thread a paged section is on, clamped to what it holds. */
    pageOf(section, item) {
      return Math.min(this.pages[section.title] || 0, Math.max(0, item.items.length - 1));
    },

    shownThreads(section, item) {
      return item.paged && item.items.length > 1 ? [item.items[this.pageOf(section, item)]] : item.items;
    },

    turn(section, item, by) {
      this.goTo(section, Math.min(Math.max(0, this.pageOf(section, item) + by), item.items.length - 1));
    },

    goTo(section, index) {
      this.pages = { ...this.pages, [section.title]: index };
    },

    rowsAround(c) {
      return [...(this.moreAbove[`${ c.id }-rows`] || []), ...c.rows, ...(this.moreBelow[`${ c.id }-rows`] || [])];
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

    /**
     * Which of this workspace's conversations have a pane up, and what each is doing.
     *
     * `conversationStates` is one exec for every workspace at once, so this filters rather than
     * asks for its own. A conversation that has just been started is not in `conversations`
     * yet, so the listing is refreshed when the set of live ids changes.
     */
    /** Tabbed says which conversation is on show; the terminal follows it. */
    onLiveTab({ tab }) {
      this.liveShown = tab.name;
    },

    /** The live conversation a tab is for; its `name` is the conversation id (see the Tab loop). */
    liveByTab(name) {
      return this.liveConversations.find((c) => c.id === name) || null;
    },

    /** A tab's conversation across running and not - what the strip's headers and bodies read. */
    byTab(name) {
      return this.railConversations.find((c) => c.id === name) || null;
    },

    /**
     * Bring a conversation whose pane is gone back up, and show it. The pane is started detached
     * in the agent pod on the same id, so the transcript, the name and the scrollback are all
     * still there - the terminal below attaches to it once the next `refreshLive` sees it alive.
     * Nothing is started until this is pressed: opening the workspace never revives an agent.
     */
    async resumeConversation(conversation) {
      if (this.resuming) {
        return;
      }
      this.resuming = conversation.id;
      try {
        await startPaneDetached(conversation.workspace || this.workspace.name, conversation.id);
        this.liveShown = conversation.id;
        await this.refreshLive();
      } catch (e) {
        this.noteError(e);
      } finally {
        this.resuming = '';
      }
    },

    /** The larger view, on the conversation the panel is showing rather than the select's. */
    popLive() {
      if (this.shownLive) {
        this.currentConversation = this.shownLive.id;
      }
      this.popped = true;
    },

    /** Rename a live conversation from its tab header, then re-read so the tab's label follows. */
    async renameLive(conversation, title) {
      await renameConversation(conversation.workspace || this.workspace.name, conversation.id, title).catch(() => {});
      await this.refreshLive();
    },

    /** Close a live conversation from its tab header; the next tick drops it from the strip. */
    async closeLive(conversation) {
      await endConversation(conversation.workspace || this.workspace.name, conversation.id).catch(() => {});
      await this.refreshLive();
    },

    async refreshLive() {
      const states = await conversationStates().catch(() => null);

      if (!states) {
        return;
      }

      const next = {};

      for (const c of states) {
        if (c.workspace === this.workspace.name && c.alive) {
          next[c.id] = agentStateOf(c);
        }
      }
      const before = Object.keys(this.live).sort().join(',');
      const after = Object.keys(next).sort().join(',');

      this.live = next;

      if (before !== after) {
        // A pane that appeared may be a conversation this page has never listed.
        await this.loadConversations();
      }
      // Keep the picked tab even when its pane dies: a conversation that stopped stays on show as
      // a resumable tab rather than vanishing. Only drop the selection if the conversation is gone
      // from the workspace altogether (ended, its record removed).
      if (this.liveShown && !next[this.liveShown] && !this.conversations.some((c) => c.id === this.liveShown)) {
        this.liveShown = '';
      }
    },

    async loadConversations() {
      this.conversations = await listConversations(this.workspace.name).catch(() => []);
      if (!this.conversations.some((c) => c.id === this.currentConversation)) {
        this.currentConversation = this.conversations[this.conversations.length - 1]?.id || '';
      }
    },

    /**
     * The newest conversation of the workspace, or a new one: where a prompt goes. A newest
     * whose pane is gone is started again to read it - a prompt queued to nobody sat there.
     */
    async say(title, text, reuse = !title) {
      await ensureWorkspaceReady(this.workspace.name);
      const conversations = await listConversations(this.workspace.name).catch(() => []);
      // The conversation about this work - the fix's, the review's, the feedback's - before a
      // scratch one somebody opened from the pane bar; the newest of those.
      const about = conversations.filter((c) => /^(Fix|Review|Feedback|Improve|CI) /.test(c.title || '') || (this.status?.pr && (c.title || '').includes(`#${ this.status.pr }`)));
      const newest = about[about.length - 1] || conversations[conversations.length - 1];

      if (newest && reuse) {
        const alive = (await conversationStates().catch(() => [])).find((c) => c.id === newest.id)?.alive;

        if (alive) {
          // Typed into the pane, because a queued prompt is only read when claude starts: on a
          // conversation already running it would sit in the queue and nothing would happen.
          await sendToPane(newest.id, text);
        } else {
          await queuePrompt(newest.attach, text);
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
      const edited = this.prompts.startFix;

      if (edited) {
        await this.say(`Fix #${ this.issue }`, expandPrompt(edited, this.varsNow()));
      } else {
        await startIssueFix(this.$store, { number: this.issue, title: this.workspace.title || '' });
      }
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
      const editedReview = this.prompts.startReview;

      if (editedReview) {
        await this.say(`Review #${ this.pr }`, expandPrompt(editedReview, this.varsNow()));
      } else {
        await startPrReview(this.$store, { number: this.pr, title: this.workspace.title || '' }, DEFAULT_REPO, this.workspace.name);
      }
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
      await this.settle();
    },

    async answerFeedback() {
      const pr = this.status?.pr;

      if (!pr) {
        throw new Error('There is no PR to answer feedback on.');
      }
      // Into the fix's own conversation when there is one - it has the context of every round -
      // and a new one named for the PR otherwise.
      await this.say(`Feedback on #${ pr }`, this.promptOf('answerFeedback'), true);
      this.notice = 'The agent is answering the feedback in a new conversation.';
      this.openTab('conversations');
    },

    async reverify() {
      const pr = this.status?.pr;

      void pr;
      await this.say('', this.promptOf('reverify'));
      this.notice = 'Asked the agent to re-verify; the recording lands under Code and Draft PR.';
    },

    async reviewAgain() {
      const pr = this.status?.pr;

      void pr;
      await this.say('', this.promptOf('reviewAgain'));
      this.notice = 'The agent is reviewing the new commits in the review conversation.';
      this.openTab('conversations');
    },

    /** The approval, written rather than fired: a message, and the evidence for it. */
    /**
     * Read the PR again after changing it on GitHub, and once more in a moment.
     *
     * Two things stood between pressing Approve and the rail saying Approved: the read of a PR
     * is memoised for 25 seconds, so the read straight after the change returned the copy the
     * page was already drawn from, and the page's own GitHub tick is five minutes. Approving
     * therefore looked like nothing had happened for minutes. So the memo is dropped first,
     * and because GitHub takes a moment to agree with itself about a review it has just
     * accepted, the whole thing is done again a few seconds later.
     */
    async settle() {
      const pr = this.status?.pr;

      if (pr) {
        forgetPrDetail(pr);
      }
      await this.refreshStatus(true);
      await this.refreshEvidence();
      clearTimeout(this.settleTimer);
      this.settleTimer = setTimeout(() => {
        if (pr) {
          forgetPrDetail(pr);
        }
        this.refreshStatus(true);
      }, 6000);
    },

    /**
     * The findings, as a review on GitHub. `event` is what the review says: changes to make,
     * or an approval carrying the comments. Only findings marked good go - submitReview
     * refuses while any is still pending, which is what marking them good is for.
     *
     * It is asked for out loud first: this is the moment the comments stop being yours and
     * become public, and there is no unsending them.
     */
    async submitFindings(event) {
      if (!this.status?.pr) {
        throw new Error('This workspace is not named for a PR.');
      }
      const n = this.findingCount;
      const what = event === 'REQUEST_CHANGES' ? 'as changes to make' : 'as an approval';

      // eslint-disable-next-line no-alert
      if (!window.confirm(`Submit ${ n || 'the' } finding${ n === 1 ? '' : 's' } to PR #${ this.status.pr } ${ what }? They become public comments on GitHub.`)) {
        return;
      }
      const { url, posted } = await submitReview(this.status.pr, this.repo, event);

      this.notice = `${ posted } comment${ posted === 1 ? '' : 's' } posted to PR #${ this.status.pr } ${ what }.${ url ? ` ${ url }` : '' }`;
      await this.settle();
    },

    requestChanges() {
      return this.submitFindings('REQUEST_CHANGES');
    },

    shipWithComments() {
      return this.submitFindings('APPROVE');
    },

    async openApprove() {
      if (!this.status?.pr) {
        throw new Error('This workspace is not named for a PR.');
      }
      this.approving = { message: '', attached: [], error: '' };
      // What is worth attaching: the recordings and screenshots, newest first - not the
      // thousands of single frames a recording leaves behind while it is being made.
      this.media = await devFetch(workspaceMediaListUrl(this.workspace.name))
        .then((d) => (d?.files || [])
          .filter((f) => !/(^|\/)(tmp-frames|frames|\.cache)[^/]*\//.test(f.path) && !/\/f\d+\.(png|jpe?g)$/.test(f.path))
          .sort((a, b) => Number(/video/.test(b.type || '')) - Number(/video/.test(a.type || '')) || (b.mtimeMs || 0) - (a.mtimeMs || 0))
          .slice(0, 20))
        .catch(() => []);
    },

    /** One of the workspace's own recordings onto the PR, and into the message. */
    async attach(file) {
      if (this.approveBusy) {
        return;
      }
      this.approveBusy = file.path;
      try {
        // The media list is relative to the workspace's artifacts; the upload wants the path
        // from the workspace's root, which is where `putArtifact` already puts its own.
        const path = file.path.startsWith('artifacts/') ? file.path : `artifacts/${ file.path }`;
        const { embed, name } = await attachToPr(this.status.pr, path);
        const message = this.approving.message;

        this.approving = {
          ...this.approving,
          message:  `${ message }${ !message || message.endsWith('\n') ? '' : '\n\n' }${ embed }\n`,
          attached: [...this.approving.attached, name],
          error:    '',
        };
      } catch (e) {
        this.approving = { ...this.approving, error: e?.message || String(e) };
      } finally {
        this.approveBusy = '';
      }
    },

    /** Something from the person's own machine: into the workspace, then onto the PR. */
    async attachFile(event) {
      const file = event.target?.files?.[0];

      if (!file) {
        return;
      }
      event.target.value = '';
      this.approveBusy = file.name;
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = '';

        for (let i = 0; i < bytes.length; i += 8192) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        }
        const rel = await putArtifact(this.workspace.name, file.name, btoa(binary));

        this.approveBusy = '';
        await this.attach({ path: rel, name: file.name });
      } catch (e) {
        this.approving = { ...this.approving, error: e?.message || String(e) };
        this.approveBusy = '';
      }
    },

    async approve() {
      if (this.approveBusy) {
        return;
      }
      this.approveBusy = 'approve';
      try {
        const { url, discarded } = await approvePr(this.status.pr, this.approving.message.trim());

        this.approving = null;
        this.notice = `PR #${ this.status.pr } approved${ discarded ? `; ${ discarded } unsubmitted comment${ discarded === 1 ? '' : 's' } dropped` : '' }.${ url ? ` ${ url }` : '' }`;
        await this.settle();
      } catch (e) {
        this.approving = { ...this.approving, error: e?.message || String(e) };
      } finally {
        this.approveBusy = '';
      }
    },

    /** Merging, for a fix whose PR is the person's own. A reviewer never sees this. */
    async merge() {
      const pr = this.status?.pr;

      if (!pr || !window.confirm(`Merge PR #${ pr }?`)) {
        return;
      }
      await mergePr(pr);
      this.notice = `PR #${ pr } merged.`;
      await this.settle();
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
  <!--
    `pr-review` is the PR panel's own class: it carries that panel's colour tokens and its diff,
    file and comment rules (components/pr/panel.scss, imported below), so the code and the
    comments here are drawn exactly as the PR page draws them.
  -->
  <div class="workspace-rail pr-review">
    <Banner
      v-if="error"
      :color="errorTone"
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
          <!--
            The name, what the agent is doing, and the way out of this view, in that order and
            against each other. What the agent is doing belongs to the name, not to the row: on
            the far side of the header it read as one more link among the PR's.
          -->
          <div class="workspace-rail__name-row">
            <span class="workspace-rail__name">{{ workspace.name }}</span>
            <span
              v-if="agentLine"
              class="workspace-rail__agent"
              :class="`workspace-rail__agent--${ status.agent }`"
            >({{ agentLine }})</span>
            <a
              class="workspace-rail__view-switch"
              href="#"
              @click.prevent="$emit('switch-view', 'tabs')"
            >(Tabbed view)</a>
          </div>
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
            :title="index < currentIndex ? `Look at what ${ step.label } left behind` : index === currentIndex ? (round > 1 ? `Now, round ${ round }` : 'Now') : doneBefore(index) ? `Done in round ${ round - 1 }; ahead of you again` : 'Not yet'"
            @click="look(step, index)"
          >
            <span class="workspace-rail__dot">
              <i
                v-if="index < currentIndex || doneBefore(index)"
                class="icon icon-checkmark"
              />
              <span v-else>{{ index + 1 }}</span>
            </span>
            <span class="workspace-rail__step-label">{{ step.label }}</span>
            <!--
              Which time round this is. The same step twice with nothing to tell the two apart
              reads as no progress, so a pass that follows a review of yours says "round 2" and
              the steps it has already been through keep their ticks.
            -->
            <span
              v-if="index === currentIndex && round > 1"
              class="workspace-rail__round"
            >round {{ round }}</span>
          </button>
        </li>
      </ol>

      <!--
        Set the stage by hand when the heuristics get it wrong. A held stage stands against the
        agent-state guesses; a hard GitHub fact (a merge, a real PR, a review) still moves it on.
      -->
      <div
        v-if="steps.length && !lookingBack"
        class="workspace-rail__manual"
      >
        <template v-if="manual">
          <span class="workspace-rail__manual-note">Stage set by hand.</span>
          <button
            type="button"
            class="workspace-rail__manual-btn"
            @click="stageToAuto"
          >Back to automatic</button>
        </template>
        <template v-else-if="stagePicker">
          <span class="workspace-rail__manual-note">Set the stage to</span>
          <button
            v-for="s in steps"
            :key="s.key"
            type="button"
            class="workspace-rail__manual-chip"
            :class="{ 'workspace-rail__manual-chip--on': s.key === current }"
            @click="chooseStage(s.key)"
          >{{ s.label }}</button>
          <button
            type="button"
            class="workspace-rail__manual-btn"
            @click="stagePicker = false"
          >cancel</button>
        </template>
        <button
          v-else
          type="button"
          class="workspace-rail__manual-btn"
          @click="stagePicker = true"
        >Wrong stage?</button>
      </div>

      <!-- The one thing to press. Stays on the current stage while a past one is being read. -->
      <div
        v-if="action"
        class="workspace-rail__action"
        :class="`workspace-rail__action--${ displayTone(status) }`"
      >
        <div class="workspace-rail__action-text">
          <div
            v-if="lookingBack"
            class="workspace-rail__looking-back"
          >Looking back at {{ shownLabel }} · <button
            type="button"
            class="workspace-rail__back"
            @click="backToNow"
          >back to now</button></div>
          <div class="workspace-rail__headline">{{ action.headline }}</div>
          <div class="workspace-rail__detail">{{ action.detail }}</div>
        </div>
        <div class="workspace-rail__buttons">
          <!--
            Two groups, and the gap between them is the point: what to ask the agent to do
            here, then what to decide. Each skill is a prompt into this workspace's
            conversation, so what it starts is watched and talked to below.
          -->
          <div
            v-if="skillButtons().length || actionsFor('agent').length"
            class="workspace-rail__group"
          >
            <span class="workspace-rail__group-label">Ask the agent</span>
            <div class="workspace-rail__group-buttons">
              <RcButton
                v-for="a in actionsFor('agent')"
                :key="a.label"
                :variant="a.isPrimary ? 'primary' : 'secondary'"
                :disabled="!!busy"
                title="Middle click to see the prompt and the skill"
                @click="run(a)"
                @mousedown="onAux(a, $event)"
                @auxclick="onAux(a, $event)"
              >
                <i
                  v-if="busy === a.run"
                  class="icon icon-spinner icon-spin"
                />
                {{ a.label }}
              </RcButton>
              <RcButton
                v-for="button in skillButtons()"
                :key="button.skill"
                variant="secondary"
                :disabled="!!busy"
                :title="`${ button.note } · middle click to see the prompt and the skill`"
                @click="runSkill(button)"
                @mousedown="onAux(button, $event)"
                @auxclick="onAux(button, $event)"
              >
                <i
                  v-if="busy === button.skill"
                  class="icon icon-spinner icon-spin"
                />
                {{ button.label }}
              </RcButton>
            </div>
          </div>
          <div
            v-if="verifyTools().length"
            class="workspace-rail__group workspace-rail__group--verify"
          >
            <span class="workspace-rail__group-label">Verify the work</span>
            <div class="workspace-rail__group-buttons">
              <RcButton
                v-for="a in verifyTools()"
                :key="a.label"
                variant="secondary"
                :disabled="!!busy"
                @click="run(a)"
              >
                <i
                  v-if="busy === a.run"
                  class="icon icon-spinner icon-spin"
                />
                {{ a.label }}
              </RcButton>
            </div>
          </div>
          <div
            v-if="actionsFor('you').length || devServer.running"
            class="workspace-rail__group workspace-rail__group--decide"
          >
            <span class="workspace-rail__group-label">Your call</span>
            <div class="workspace-rail__group-buttons">
              <!--
                Only while there is one to stop. A dev server costs about two gigabytes of the
                node whether or not anybody is looking at it, and every stage of every
                workspace can have one, so the button belongs wherever the server is - not on
                one page somebody has to remember.
              -->
              <RcButton
                v-if="devServer.running"
                variant="secondary"
                :disabled="!!busy"
                title="Stop this workspace's dev server and keep it stopped, freeing about 2 GB."
                @click="stopServer"
              >
                <i
                  v-if="busy === 'stopServer'"
                  class="icon icon-spinner icon-spin"
                />
                Stop the dev server
              </RcButton>
              <!--
                And back again. Without this the only way to undo a stop was the agent's own
                command line, which is a poor answer to a button that stopped it - and this
                product stops one by itself when a fix reaches In review.
              -->
              <RcButton
                v-if="devServer.paused"
                variant="secondary"
                :disabled="!!busy"
                title="Let this workspace run its dev server again. It takes a minute or two to compile."
                @click="startServer"
              >
                <i
                  v-if="busy === 'startServer'"
                  class="icon icon-spinner icon-spin"
                />
                Start the dev server
              </RcButton>
              <RcButton
                v-for="a in actionsFor('you')"
                :key="a.label"
                :variant="a.isPrimary ? 'primary' : 'secondary'"
                :disabled="!!busy"
                @click="run(a)"
              >
                <i
                  v-if="busy === a.run"
                  class="icon icon-spinner icon-spin"
                />
                {{ a.label }}
              </RcButton>
            </div>
          </div>
        </div>
      </div>

      <!--
        The running agent, under the button that started it.

        A conversation used to be reachable only through a button that opened it over the page,
        which meant the one thing actually happening was the one thing not on screen. While a
        pane is up it belongs here, at every stage and for a fix and a review both.

        ConversationTabbed is the product's own tab strip (a fork of the shell's), so more than
        one running agent looks like every other set of tabs in Rancher. It hides an inactive tab
        with v-show rather than unmounting it, so the terminal inside each one is mounted only
        while that tab is the shown one: a terminal per conversation is not free, and two attached
        to one session fight over it.

        Each tab carries its own title, agent status and open-larger/close in its header (the
        `tab-header` slot), so one running conversation still shows as a single tab rather than as
        a bar of its own.
      -->
      <section
        v-if="railConversations.length"
        class="workspace-rail__live"
      >
        <ConversationTabbed
          class="workspace-rail__live-tabs"
          :default-tab="shownConversation ? shownConversation.id : ''"
          @changed="onLiveTab"
        >
          <template #tab-header="{ tab }">
            <ConversationTab
              v-if="byTab(tab.name)"
              :conversation="byTab(tab.name)"
              :agent="byTab(tab.name).agent"
              :active="tab.active"
              @rename="renameLive(byTab(tab.name), $event)"
              @popout="popLive"
              @close="closeLive(byTab(tab.name))"
            />
          </template>
          <Tab
            v-for="(c, i) in railConversations"
            :key="c.id"
            :name="c.id"
            :label="c.title || 'Conversation'"
            :weight="railConversations.length - i"
          >
            <StudioTerminal
              v-if="shownConversation && shownConversation.id === c.id && c.alive && !popped"
              :key="c.id"
              class="workspace-rail__live-terminal"
              :session="c.id"
              :command="c.attach.command"
            />
            <div
              v-else-if="shownConversation && shownConversation.id === c.id && !c.alive"
              class="workspace-rail__resume"
            >
              <div class="workspace-rail__resume-text">
                This conversation is not running right now. Its history is kept — open it to read it and carry on.
              </div>
              <RcButton
                primary
                :disabled="resuming === c.id"
                @click="resumeConversation(c)"
              >
                <i
                  v-if="resuming === c.id"
                  class="icon icon-spinner icon-spin"
                />
                {{ resuming === c.id ? 'Opening…' : 'Open conversation' }}
              </RcButton>
            </div>
          </Tab>
        </ConversationTabbed>
      </section>

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
            <div class="workspace-rail__section-head">
              <!--
                Every section folds; only the pull request opens shut, because it is the frame
                the rest is read inside rather than something that happened.
              -->
              <h4 class="workspace-rail__section-title">
                <button
                  type="button"
                  class="workspace-rail__fold"
                  :title="isShut(section) ? 'Show this' : 'Fold this away'"
                  @click="toggleSection(section)"
                >
                  <i
                    class="icon"
                    :class="isShut(section) ? 'icon-chevron-right' : 'icon-chevron-down'"
                  />{{ section.title }}
                </button>
              </h4>
              <!--
                The "as one diff" link belongs on the title's row: it is about the list under
                it, and on a row of its own it cost more height than the two commits it was
                offering to combine.
              -->
              <button
                v-if="combinedItem(section)"
                type="button"
                class="workspace-rail__back"
                @click="showCombined(combinedItem(section))"
              >{{ combinedFor(combinedItem(section)) ? 'Hide the combined diff' : `All ${ combinedItem(section).items.length } commits${ combinedItem(section).since ? ` since ${ combinedItem(section).since }` : '' } as one diff` }}</button>
            </div>
            <template
              v-for="(item, i) in (isShut(section) ? [] : section.items)"
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
                  class="md-body workspace-rail__md"
                  @click="openShot"
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
              <template v-else-if="item.kind === 'commits'">
                <div
                  v-if="combinedFor(item) === 'reading'"
                  class="workspace-rail__empty"
                >Reading the combined diff…</div>
                <div
                  v-else-if="combinedFor(item) === 'none'"
                  class="workspace-rail__empty"
                >The combined diff could not be read.</div>
                <div
                  v-else-if="combinedFor(item)"
                  class="workspace-rail__files"
                >
                  <div
                    v-for="f in combinedFor(item)"
                    :key="f.path"
                    class="prm-file"
                  >
                    <div class="prm-file-head"><code>{{ f.path }}</code><span
                      v-if="f.status"
                      class="workspace-rail__tag"
                    >{{ f.status }}</span></div>
                    <table class="diff-table">
                      <tbody>
                        <tr
                          v-for="(r, k) in f.rows"
                          :key="k"
                          class="diff-row"
                          :class="r.type"
                        >
                          <td class="lineno">{{ r.oldN ?? '' }}</td>
                          <td class="lineno">{{ r.newN ?? '' }}</td>
                          <td class="code"><span class="sign">{{ r.type === 'add' ? '+' : r.type === 'del' ? '−' : ' ' }}</span><span v-html="r.html" /></td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
                <ul class="workspace-rail__list workspace-rail__list--plain">
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
                      class="prm-file"
                    >
                      <div class="prm-file-head"><code>{{ f.path }}</code><span
                        v-if="f.status"
                        class="workspace-rail__tag"
                      >{{ f.status }}</span></div>
                      <table class="diff-table">
                        <tbody>
                          <tr
                            v-for="(r, k) in f.rows"
                            :key="k"
                            class="diff-row"
                            :class="r.type"
                          >
                            <td class="lineno">{{ r.oldN ?? '' }}</td>
                            <td class="lineno">{{ r.newN ?? '' }}</td>
                            <td class="code"><span class="sign">{{ r.type === 'add' ? '+' : r.type === 'del' ? '−' : ' ' }}</span><span v-html="r.html" /></td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                  </li>
                </ul>
              </template>
              <!--
                The change, read in the tool built for it: file tree, whole-file context, the
                diff options, all of it over the page. The column used to list every path with
                its own accordion, which was thirty-one rows of nothing much.
              -->
              <div
                v-if="item.kind === 'review'"
                class="workspace-rail__review-open"
              >
                <PrButton
                  size="sm"
                  variant="primary"
                  @click="openTab('review')"
                >
                  {{ item.label }}
                </PrButton>
              </div>
              <div
                v-if="item.kind === 'media'"
                class="workspace-rail__media"
              >
                <!--
                  Thumbnails, not the media itself. A report with eight screenshots in it is a
                  page of screenshots you scroll past to read the report; at this size the set
                  is legible at a glance and any one of them opens in the viewer that pans and
                  zooms, which is where a screenshot is actually read.
                -->
                <figure
                  v-for="m in item.items"
                  :key="m.url"
                  class="workspace-rail__figure"
                >
                  <button
                    type="button"
                    class="workspace-rail__thumb"
                    :title="`${ m.label } · open`"
                    @click="shot = { src: m.url, name: m.label, caption: ago(m.at) }"
                  >
                    <video
                      v-if="m.video"
                      :src="m.url"
                      preload="metadata"
                      muted
                    />
                    <img
                      v-else
                      :src="m.url"
                      :alt="m.label"
                      loading="lazy"
                    >
                    <span
                      v-if="m.video"
                      class="workspace-rail__thumb-play"
                    >▶</span>
                  </button>
                  <figcaption>{{ m.label }} · {{ ago(m.at) }}</figcaption>
                </figure>
              </div>
              <div
                v-else-if="item.kind === 'comments'"
                class="workspace-rail__comments"
              >
                <!--
                  One thread at a time where there are many: the pager walks them in GitHub's
                  order, and a number jumps straight to one. A thread still waiting on an
                  answer is marked in the pager too, so it can be found without walking.
                -->
                <div
                  v-if="item.paged && item.items.length > 1"
                  class="workspace-rail__pager"
                >
                  <button
                    type="button"
                    class="workspace-rail__page-step"
                    :disabled="pageOf(section, item) === 0"
                    @click="turn(section, item, -1)"
                  >‹ Previous</button>
                  <span class="workspace-rail__page-nums">
                    <button
                      v-for="(c, n) in item.items"
                      :key="c.id || n"
                      type="button"
                      class="workspace-rail__page-num"
                      :class="{
                        'workspace-rail__page-num--on': n === pageOf(section, item),
                        'workspace-rail__page-num--approved': !c.answered && c.local && c.status === 'approved',
                        'workspace-rail__page-num--open': !c.answered && !(c.local && c.status === 'approved'),
                      }"
                      :title="`${ c.where }${ c.answered ? '' : c.status === 'approved' ? ' · approved' : ' · waiting' }`"
                      @click="goTo(section, n)"
                    >{{ n + 1 }}</button>
                  </span>
                  <button
                    type="button"
                    class="workspace-rail__page-step"
                    :disabled="pageOf(section, item) >= item.items.length - 1"
                    @click="turn(section, item, 1)"
                  >Next ›</button>
                  <span class="workspace-rail__page-of">{{ pageOf(section, item) + 1 }} of {{ item.items.length }}</span>
                </div>
                <!--
                  One card per thread, in GitHub's order (the file's place in the PR, then the
                  line). The code it is on is the hunk, numbered both sides, the commented line
                  marked; every message is rendered, the PR's author told apart from the rest.
                -->
                <article
                  v-for="(c, j) in shownThreads(section, item)"
                  :key="c.id || j"
                  class="workspace-rail__thread-card"
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
                    <!--
                      A local finding you have marked good reads as approved, in green, here and in
                      the pager - not "waiting on you", which is only for one you have not been
                      through yet. A submitted comment (answered) shows neither; its state is its own.
                    -->
                    <span
                      v-if="!c.answered && c.local && c.status === 'approved'"
                      class="workspace-rail__tag workspace-rail__tag--approved"
                    >approved</span>
                    <span
                      v-else-if="!c.answered"
                      class="workspace-rail__tag workspace-rail__tag--open"
                    >{{ status.kind === 'review' && shown === 'response' ? 'no reply from the developer' : 'waiting on you' }}</span>
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
                    class="prm-file"
                  >
                    <template v-if="c.rows.length">
                      <button
                        v-if="c.path && c.headSha && status.pr"
                        type="button"
                        class="workspace-rail__expander"
                        title="Show the lines above"
                        @click="extend(c, 'up')"
                      >↑ more above</button>
                      <table class="diff-table">
                        <tbody>
                          <tr
                            v-for="(r, k) in rowsAround(c)"
                            :key="k"
                            class="diff-row"
                            :class="[r.type, { 'on-comment-line': r.marked }]"
                          >
                            <td class="lineno">{{ r.oldN ?? '' }}</td>
                            <td class="lineno">{{ r.newN ?? '' }}</td>
                            <td class="code"><span class="sign">{{ r.type === 'add' ? '+' : r.type === 'del' ? '−' : ' ' }}</span><span v-html="r.html" /></td>
                          </tr>
                        </tbody>
                      </table>
                      <button
                        v-if="c.path && c.headSha && status.pr"
                        type="button"
                        class="workspace-rail__expander"
                        title="Show the lines below"
                        @click="extend(c, 'down')"
                      >↓ more below</button>
                    </template>
                    <p
                      v-else
                      class="workspace-rail__empty"
                    >{{ c.noPatch ? 'The diff is too large for GitHub to send; open it there.' : c.path ? 'The line is not in the PR\'s diff any more.' : 'A comment on the PR as a whole.' }}</p>
                  </div>
                  <div class="workspace-rail__thread">
                    <!--
                      The highlight is on the comment, not the thread: a message that arrived
                      since the last round, and the one still waiting for an answer - the last
                      of an unanswered thread - carry the same yellow border.
                    -->
                    <div
                      v-for="(t, k) in c.thread"
                      :key="k"
                      class="comment"
                      :class="[t.author ? 'workspace-rail__msg--author' : 'gh-comment', { 'workspace-rail__msg--flag': t.isNew || (!c.answered && k === c.thread.length - 1) }]"
                    >
                      <div class="comment-head">
                        <span class="workspace-rail__avatar">{{ (t.who || '?').slice(0, 1).toUpperCase() }}</span>
                        <span class="comment-author">{{ t.who }}</span>
                        <span
                          v-if="t.author"
                          class="comment-age"
                        >author</span>
                        <span class="comment-age">{{ ago(t.at) }}</span>
                        <span
                          v-if="t.isNew"
                          class="workspace-rail__tag workspace-rail__tag--new"
                        >new</span>
                      </div>
                      <div
                        class="comment-body md-body"
                        @click="openShot"
                        v-html="t.html"
                      />
                    </div>
                  </div>
                  <CommentAttachments
                    v-if="c.attachments && c.attachments.length"
                    :pr="status.pr"
                    :attachments="c.attachments"
                  />
                  <!--
                    A finding of yours that has not gone to GitHub yet: the PR panel's own
                    actions on it, here, because going through the findings is this stage and
                    sending someone to another page to do it is what the rail is for.
                  -->
                  <div
                    v-if="c.local && editingId === c.id"
                    class="workspace-rail__edit"
                  >
                    <textarea
                      v-model="editDraft"
                      class="workspace-rail__edit-text"
                      rows="6"
                    />
                    <div class="workspace-rail__comment-actions">
                      <PrButton
                        size="sm"
                        variant="primary"
                        :disabled="commentBusy === c.id"
                        @click="saveEdit(c)"
                      >
                        Save
                      </PrButton>
                      <PrButton
                        size="sm"
                        @click="cancelEdit"
                      >
                        Cancel
                      </PrButton>
                    </div>
                  </div>
                  <div
                    v-else-if="c.local"
                    class="workspace-rail__comment-actions"
                  >
                    <PrButton
                      size="sm"
                      :variant="c.status === 'approved' ? 'success' : 'primary'"
                      :disabled="commentBusy === c.id"
                      @click="markGood(c)"
                    >
                      {{ c.status === 'approved' ? 'Approved' : 'Mark good' }}
                    </PrButton>
                    <PrButton
                      size="sm"
                      @click="startEdit(c)"
                    >
                      Edit
                    </PrButton>
                    <PrButton
                      size="sm"
                      :variant="discussing[c.id] ? 'accent' : 'default'"
                      @click="toggleDiscuss(c)"
                    >
                      {{ discussing[c.id] ? 'Discussing' : 'Discuss' }}
                    </PrButton>
                    <PrButton
                      size="sm"
                      variant="danger"
                      :disabled="commentBusy === c.id"
                      @click="dropFinding(c)"
                    >
                      Delete
                    </PrButton>
                  </div>
                  <CommentDiscussion
                    v-if="c.local && discussing[c.id]"
                    :pr="status.pr"
                    :repo="repo"
                    :workspace="workspace.name"
                    :comment="c"
                    :session="discussSession[c.id] || ''"
                    @session="rememberDiscussion(c, $event)"
                    @close="toggleDiscuss(c)"
                  />
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
      <!-- A screenshot or a recording, in the viewer that pans and zooms. -->
      <Teleport to="body">
        <ArtifactViewer
          v-if="shot"
          :src="shot.src"
          :name="shot.name"
          :caption="shot.caption"
          @close="shot = null"
        />
      </Teleport>

      <!-- The approval: what it says, and the evidence that goes with it. -->
      <DevModal
        v-if="approving"
        :title="`Approve PR #${ status.pr }`"
        @close="approving = null"
      >
        <div class="workspace-rail__inspect">
          <Banner
            v-if="approving.error"
            color="error"
            :label="approving.error"
          />
          <!--
            Approving drops whatever findings have not been submitted: the point of this button
            is "nothing to say", and a comment left behind in the workspace would never reach
            anybody. Said here rather than discovered afterwards in the notice.
          -->
          <Banner
            v-if="findingCount"
            color="warning"
            :label="`${ findingCount } finding${ findingCount === 1 ? '' : 's' } here ${ findingCount === 1 ? 'has' : 'have' } not been submitted. Approving drops ${ findingCount === 1 ? 'it' : 'them' }; to send ${ findingCount === 1 ? 'it' : 'them' } instead, close this and use Ship it with comments.`"
          />
          <section class="workspace-rail__section">
            <h4 class="workspace-rail__section-title">Your message</h4>
            <textarea
              v-model="approving.message"
              class="workspace-rail__prompt-edit"
              placeholder="What convinced you. Markdown, and anything you attach below lands here."
            />
            <p class="workspace-rail__detail">Goes on the PR as the approval's body. Leave it empty to approve without a word.</p>
          </section>

          <section class="workspace-rail__section">
            <h4 class="workspace-rail__section-title">
              Attach
              <span
                v-if="approving.attached.length"
                class="workspace-rail__tag"
              >{{ approving.attached.length }} attached</span>
            </h4>
            <p class="workspace-rail__detail">The workspace's own recordings and screenshots - what the agent made while reviewing - or a file from this machine. Each one is uploaded to GitHub and embedded in the message.</p>
            <div class="workspace-rail__group-buttons">
              <RcButton
                variant="secondary"
                :disabled="!!approveBusy"
                @click="$refs.approveFile.click()"
              >
                From this machine…
              </RcButton>
              <input
                ref="approveFile"
                type="file"
                accept="image/*,video/*"
                class="workspace-rail__file"
                @change="attachFile"
              >
            </div>
            <ul
              v-if="media.length"
              class="workspace-rail__list workspace-rail__list--plain"
            >
              <li
                v-for="f in media"
                :key="f.path"
                class="workspace-rail__media-row"
              >
                <button
                  type="button"
                  class="workspace-rail__page-step"
                  :disabled="!!approveBusy"
                  @click="attach(f)"
                >
                  <i
                    v-if="approveBusy === f.path"
                    class="icon icon-spinner icon-spin"
                  />
                  Attach
                </button>
                <code>{{ f.path }}</code>
                <span class="workspace-rail__when">{{ ago(new Date(f.mtimeMs).toISOString()) }}</span>
              </li>
            </ul>
            <p
              v-else
              class="workspace-rail__empty"
            >This workspace has no recordings yet.</p>
          </section>

          <div class="workspace-rail__group-buttons">
            <RcButton
              variant="primary"
              :disabled="!!approveBusy"
              @click="approve"
            >
              <i
                v-if="approveBusy === 'approve'"
                class="icon icon-spinner icon-spin"
              />
              Approve
            </RcButton>
            <RcButton
              variant="tertiary"
              :disabled="!!approveBusy"
              @click="approving = null"
            >
              Cancel
            </RcButton>
          </div>
        </div>
      </DevModal>

      <!-- What a button sends, and the skill it runs, editable for every workspace. -->
      <DevModal
        v-if="inspecting"
        :title="`${ inspecting.label }: what it runs`"
        @close="inspecting = null"
      >
        <div class="workspace-rail__inspect">
          <Banner
            v-if="inspecting.error"
            color="error"
            :label="inspecting.error"
          />
          <section class="workspace-rail__section">
            <h4 class="workspace-rail__section-title">
              The prompt
              <span
                v-if="inspecting.edited"
                class="workspace-rail__tag"
              >edited here</span>
            </h4>
            <textarea
              v-model="promptDraft"
              class="workspace-rail__prompt-edit"
              spellcheck="false"
            />
            <p class="workspace-rail__detail">It goes to this workspace's conversation, so the run is watched and talked to like any other.</p>

            <h4 class="workspace-rail__section-title">What goes in</h4>
            <table class="workspace-rail__vars">
              <tbody>
                <tr
                  v-for="v in varsNow()"
                  :key="v.name"
                >
                  <td>
                    <button
                      type="button"
                      class="workspace-rail__var"
                      title="Put this in the prompt"
                      @click="insertVar(v)"
                    >{{ varToken(v) }}</button>
                  </td>
                  <td class="workspace-rail__var-value">{{ v.value || '—' }}</td>
                  <td class="workspace-rail__var-about">{{ v.about }}</td>
                </tr>
              </tbody>
            </table>
            <p class="workspace-rail__detail">Anything else is left alone, so a shell variable like <code>$CLAUDE_HARNESS_API</code> reaches the agent as it is written and is expanded in the workspace.</p>

            <h4 class="workspace-rail__section-title">As it will be sent</h4>
            <pre class="workspace-rail__prompt">{{ promptPreview() }}</pre>
            <div class="workspace-rail__group-buttons">
              <RcButton
                variant="primary"
                :disabled="!!promptSaving || !promptDraft.trim()"
                @click="sendDraft"
              >
                <i
                  v-if="promptSaving === 'send'"
                  class="icon icon-spinner icon-spin"
                />
                Send this now
              </RcButton>
              <RcButton
                variant="secondary"
                :disabled="!!promptSaving || promptDraft === templateOf(inspecting.action)"
                @click="savePrompt"
              >
                <i
                  v-if="promptSaving === 'save'"
                  class="icon icon-spinner icon-spin"
                />
                Save as what this button sends
              </RcButton>
              <RcButton
                v-if="inspecting.edited"
                variant="tertiary"
                :disabled="!!promptSaving"
                @click="resetPrompt"
              >
                Back to the shipped prompt
              </RcButton>
            </div>
          </section>
          <section
            v-if="inspecting.skill"
            class="workspace-rail__section"
          >
            <h4 class="workspace-rail__section-title">
              {{ inspecting.skill }}/SKILL.md
              <span
                v-if="inspecting.overridden"
                class="workspace-rail__tag"
              >edited here</span>
            </h4>
            <textarea
              v-model="skillDraft"
              class="workspace-rail__skill"
              spellcheck="false"
            />
            <div class="workspace-rail__group-buttons">
              <RcButton
                variant="secondary"
                :disabled="!!skillSaving || skillDraft === inspecting.content"
                @click="saveInspected(false)"
              >
                <i
                  v-if="skillSaving === 'save'"
                  class="icon icon-spinner icon-spin"
                />
                Save to all workspaces
              </RcButton>
              <RcButton
                variant="primary"
                :disabled="!!skillSaving || skillDraft === inspecting.content"
                @click="saveInspected(true)"
              >
                <i
                  v-if="skillSaving === 'commit'"
                  class="icon icon-spinner icon-spin"
                />
                Save and commit
              </RcButton>
            </div>
          </section>
        </div>
      </DevModal>

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
      The other ways to look at this work. The conversation itself used to sit here behind a
      list and a button; it is up under the action bar now, so what is left is the views, which
      open over the page (DevModal) rather than instead of it.
    -->
    <section class="workspace-rail__col workspace-rail__col--pane">
      <div class="workspace-rail__col-head">
        <h3 class="workspace-rail__col-title">Other views</h3>
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
      <!-- The bigger view of whichever conversation the panel above is showing. -->
      <DevModal
        v-if="popped"
        :title="`${ workspace.name } · ${ (conversations.find((c) => c.id === currentConversation) || {}).title || 'conversation' }`"
        @close="popped = false"
      >
        <div class="workspace-rail__popped">
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
        </div>
      </DevModal>
    </section>
  </div>
</template>

<!-- The PR panel's stylesheet, so this page and that one are one vocabulary. -->
<style lang="scss" scoped src="./pr/panel.scss"></style>

<style lang="scss" scoped>
.workspace-rail {
  display:        flex;
  flex-direction: column;
  gap:            16px;
  // The view switch sits in its own row above this now, so the top padding is a gap not a margin.
  padding:        8px 24px 24px;
  height:         100%;
  min-height:     0;
  overflow:       auto;

  &__head {
    display:         flex;
    align-items:     baseline;
    justify-content: space-between;
    gap:             24px;
    flex-wrap:       wrap;
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
    gap:         16px;
    flex:        0 0 auto;
    font-size:   13px;
    white-space: nowrap;
  }

  &__agent {
    display:     inline-flex;
    align-items: center;
    gap:         6px;
    color:       var(--muted);

    &--working { color: var(--status-working); }
    &--input { color: var(--status-input); }
  }

  // The rail
  &__steps {
    display:    flex;
    list-style: none;
    margin:     8px 0 4px;
    padding:    0 8px;
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

  /* Which time round this step is being taken. Small, beside the label, never instead of it. */
  &__round {
    margin-left:    6px;
    padding:        1px 6px;
    border:         1px solid var(--warning);
    border-radius:  10px;
    color:          var(--warning);
    font-size:      10px;
    font-weight:    700;
    letter-spacing: .04em;
    text-transform: uppercase;
    white-space:    nowrap;
  }

  /* Setting the stage by hand: a quiet row under the rail, out of the way until it is wanted. */
  &__manual {
    display:     flex;
    flex-wrap:   wrap;
    align-items: center;
    gap:         6px;
    margin-top:  8px;
    font-size:   11px;
  }

  &__manual-note {
    color: var(--muted);
  }

  &__manual-btn {
    padding:       0;
    border:        0;
    background:    transparent;
    color:         var(--link);
    font:          inherit;
    text-decoration: underline;
    cursor:        pointer;
  }

  &__manual-chip {
    padding:       1px 8px;
    border:        1px solid var(--border);
    border-radius: 10px;
    background:    var(--box-bg);
    color:        var(--body-text);
    font:         inherit;
    font-size:    11px;
    cursor:       pointer;

    &:hover { border-color: var(--link); }

    &--on {
      border-color: var(--primary);
      color:        var(--primary);
    }
  }

  /* A step this review has already been through once, waiting ahead of you again. */
  &__step--again &__dot {
    border-style: dashed;
    opacity:      .85;
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
    gap:             32px;
    flex-wrap:       wrap;
    padding:         18px 20px;
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
    min-width:      260px;
    max-width:      440px;
    flex:           0 1 auto;
  }

  &__looking-back {
    font-size:      11px;
    font-weight:    700;
    letter-spacing: .06em;
    text-transform: uppercase;
    color:          var(--pr-muted);
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
    gap:         16px;
    flex:        1 1 auto;
    align-items: stretch;
    justify-content: flex-end;
    flex-wrap:   wrap;
  }

  // Two fenced groups: what to ask the agent for, and what to decide. The fence is what says
  // they are different kinds of thing - a gap alone did not.
  &__group {
    display:        flex;
    flex-direction: column;
    gap:            8px;
    align-items:    flex-start;
    justify-content: flex-start;
    padding:        10px 12px;
    border:         1px solid var(--pr-border);
    border-radius:  var(--border-radius);
    background:     var(--pr-bg);

    &--decide { border-color: var(--pr-accent); }
  }

  // Every button the same size, whatever it does - and its label in the middle of it: the
  // shared button styles align text to the start, which reads as shifted once a minimum width
  // makes the box wider than the words.
  &__group :deep(button) {
    display:         inline-flex;
    align-items:     center;
    justify-content: center;
    text-align:      center;
    height:          36px;
    min-width:       150px;
    white-space:     nowrap;
  }

  &__group-label {
    font-size:      11px;
    font-weight:    700;
    letter-spacing: .06em;
    text-transform: uppercase;
    color:          var(--pr-muted);
  }

  &__group-buttons {
    display:   flex;
    gap:       8px;
    flex-wrap: wrap;
  }

  &__inspect {
    display:        flex;
    flex-direction: column;
    gap:            18px;
    padding:        16px 20px;
    min-height:     0;
  }

  &__file { display: none; }

  &__media-row {
    display:       flex;
    align-items:   center;
    gap:           10px;
    padding:       3px 0;
    border-bottom: 1px solid var(--pr-border);

    code { font-size: 11px; color: var(--pr-muted); }
    &:last-child { border-bottom: 0; }
  }

  &__prompt-edit {
    width:         100%;
    box-sizing:    border-box;
    min-height:    110px;
    padding:       10px 12px;
    border:        1px solid var(--pr-border);
    border-radius: var(--border-radius);
    background:    var(--input-bg);
    color:         var(--pr-text);
    font-family:   var(--pr-mono);
    font-size:     12.5px;
    line-height:   1.5;
    resize:        vertical;
  }

  // A reference table, so the rows are tight and everything on one line sits on that line's
  // middle: the chip is taller than the words beside it, and top-alignment left them floating.
  &__vars {
    width:           100%;
    border-collapse: collapse;
    font-size:       12px;

    td {
      padding:        3px 12px 3px 0;
      vertical-align:  middle;
      line-height:     1.35;
      border-bottom:   1px solid var(--pr-border);
    }

    td:first-child { width: 1%; white-space: nowrap; }
    td:last-child { padding-right: 0; }
    tr:last-child td { border-bottom: 0; }
  }

  &__var {
    display:       block;
    border:        1px solid var(--pr-border);
    border-radius: var(--border-radius);
    background:    var(--pr-bg-2);
    color:         var(--pr-accent);
    font-family:   var(--pr-mono);
    font-size:     11.5px;
    line-height:   1.35;
    padding:       1px 6px;
    cursor:        pointer;
    white-space:   nowrap;

    &:hover { background: var(--pr-el-hover); }
  }

  &__var-value {
    color:       var(--pr-text);
    font-family: var(--pr-mono);
    word-break:  break-word;
  }

  &__var-about { color: var(--pr-muted); }

  &__prompt {
    margin:        0;
    padding:       10px 12px;
    border:        1px solid var(--pr-border);
    border-radius: var(--border-radius);
    background:    var(--pr-bg-2);
    font-family:   var(--pr-mono);
    font-size:     12px;
    line-height:   1.5;
    white-space:   pre-wrap;
    word-break:    break-word;
  }

  &__skill {
    width:         100%;
    box-sizing:    border-box;
    min-height:    46vh;
    padding:       10px 12px;
    border:        1px solid var(--pr-border);
    border-radius: var(--border-radius);
    background:    var(--input-bg);
    color:         var(--pr-text);
    font-family:   var(--pr-mono);
    font-size:     12.5px;
    line-height:   1.5;
    resize:        vertical;
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

  // The running agent under the action bar. A fixed height on purpose: it is something to
  // glance at while reading the stage below it, and left to grow it took the whole page.
  // The name and what the agent is doing read as one thing, so the gap between them is a word
  // space rather than the header's.
  &__name-row {
    display:     flex;
    align-items: baseline;
    gap:         6px;
    flex-wrap:   wrap;
    min-width:   0;
  }

  // No box of its own: the tabbed strip below is the box. A bordered, padded wrapper around it
  // made two boxes nested, which is what this drops.
  &__live {
    display:        flex;
    flex-direction: column;
  }

  &__live-head {
    display:     flex;
    align-items: center;
    gap:         10px;
    flex-wrap:   wrap;
  }

  &__live-terminal {
    height:     360px;
    min-height: 0;
  }

  // A conversation that is not running: shown in the terminal's place so the strip keeps its
  // shape, with the one button that brings it back up. No box of its own - the tab panel around
  // it is the only frame - just the text and the button, centred.
  &__resume {
    display:         flex;
    flex-direction:  column;
    align-items:     center;
    gap:             12px;
    padding:         24px 20px;
    min-height:      120px;
    justify-content: center;
    text-align:      center;
  }

  &__resume-text {
    color:     var(--muted);
    font-size: 13px;
    max-width: 52ch;
  }

  &__popped {
    height:  calc(100vh - 140px);
    padding: 0 4px 4px;
  }


  &__terminal {
    height:     100%;
    min-height: 0;
  }



  &__md {
    overflow-wrap: anywhere;
    white-space:   normal;

    :deep(video) { max-width: 100%; border-radius: var(--border-radius); background: #000; }

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

  // The file box, the diff table, the comment card and the markdown body all come from
  // panel.scss (`prm-file`, `diff-table`, `comment`, `md-body`). What is left here is this
  // page's own: the thread card around a comment chain, and the two expanders.
  /* The actions on one of your own findings, as the PR panel has them. */
  &__comment-actions {
    display:   flex;
    flex-wrap: wrap;
    gap:       6px;
    padding:   8px 0 2px;
  }

  &__review-open {
    display:     flex;
    padding-top: 2px;
  }

  &__edit {
    display:        flex;
    flex-direction: column;
    gap:            6px;
    padding-top:    8px;
  }

  &__edit-text {
    width:         100%;
    min-height:    90px;
    box-sizing:    border-box;
    padding:       8px;
    border:        1px solid var(--pr-border, var(--border));
    border-radius: var(--border-radius);
    background:    var(--pr-bg-2, var(--box-bg));
    color:         var(--body-text);
    font:          inherit;
    font-size:     13px;
    resize:        vertical;
  }

  &__thread-card {
    border:        1px solid var(--pr-border);
    border-radius: var(--border-radius);
    background:    var(--pr-bg-2);
    padding:       12px 14px;
    display:       flex;
    flex-direction: column;
    gap:           10px;

  }

  &__msg--author { border-left: 3px solid var(--pr-accent); }

  // What the person still has to deal with: new since the last round, or unanswered.
  &__msg--flag {
    border-color: var(--pr-warning);
    background:   var(--pr-warning-fill);
  }

  &__gone {
    display:       inline-block;
    padding:       2px 8px;
    border:        1px dashed var(--pr-border);
    border-radius: var(--border-radius);
    color:         var(--pr-muted);
    font-size:     12px;
  }

  &__expander {
    display:     block;
    width:       100%;
    border:      0;
    border-bottom: 1px solid var(--pr-border);
    background:  var(--pr-bg-2);
    color:       var(--pr-accent);
    font:        inherit;
    font-size:   11px;
    padding:     2px 0;
    cursor:      pointer;

    &:hover { background: var(--pr-el-hover); }
    &:last-child { border-bottom: 0; border-top: 1px solid var(--pr-border); }
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
    width:       100%;
    border:      0;
    background:  transparent;
    color:       var(--body-text);
    font:        inherit;
    text-align:  left;
    padding:     2px 0;
    cursor:      pointer;

    .icon { font-size: 10px; color: var(--muted); }

    /*
     * The theme pads every `code` by 5px all round, which on a one-line row is most of the
     * row's height spent on a seven-character sha.
     */
    code {
      padding:     0 5px;
      line-height: 1.5;
    }

    /* Who and when sit at the end of the row, so the messages read down the left. */
    .workspace-rail__when { margin-left: auto; margin-right: 0; }
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
    gap:            14px;
    padding:        12px 14px;
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

  /*
   * These read as links and text, not as buttons, but they are buttons - and the theme gives
   * every button a 40px minimum height. Left alone, one "as one diff" link stood in more room
   * than the two commits it offered to combine, and every commit row was a 40px band holding
   * 15px of text. Height comes from the line here, as it does for text.
   */
  &__back,
  &__row-btn,
  &__expander,
  &__page-step,
  &__page-num {
    min-height:  0;
    line-height: 1.4;
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
    padding-bottom: 0;
  }

  /* The section's title and whatever acts on the whole section, on one row. */
  &__section-head {
    display:         flex;
    align-items:     baseline;
    justify-content: space-between;
    gap:             12px;
    min-height:      0;
  }

  &__section-title {
    margin:      0;
    font-size:   13px;
    font-weight: 700;
  }

  &__fold {
    display:     inline-flex;
    align-items: center;
    gap:         6px;
    min-height:  0;
    padding:     0;
    border:      0;
    background:  transparent;
    color:       inherit;
    font:        inherit;
    line-height: 1.4;
    cursor:      pointer;

    .icon {
      font-size: 10px;
      color:     var(--muted);
    }

    &:hover .icon { color: var(--link); }
  }

  &__text {
    margin:      0;
    white-space: pre-wrap;
    line-height: 1.45;
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

  &__tone--ok { color: var(--status-done); }
  &__tone--bad { color: var(--status-error); }
  &__tone--warn { color: var(--status-input); }

  &__list {
    margin:     0;
    padding:    0 0 0 18px;
    font-size:  13px;
    line-height: 1.5;

    code { font-size: 12px; }

    &--files { column-gap: 24px; }
  }

  // The little status words - "4 messages", "no reply from the developer", "new". Room around
  // the text on both axes, and a line of their own height, so they read as badges rather than
  // as words with a tint behind them.
  &__tag {
    display:       inline-flex;
    align-items:   center;
    margin-left:   6px;
    padding:       3px 10px;
    border-radius: 10px;
    font-size:     11px;
    line-height:   1.2;
    font-weight:   600;
    white-space:   nowrap;
    background:    var(--disabled-bg);
    color:         var(--body-text);

    &--open { background: var(--pr-warning-fill); color: var(--pr-warning); }
    &--approved { background: var(--pr-success-fill); color: var(--pr-success); }
    &--new { background: var(--pr-accent-fill); color: var(--pr-accent); }
  }

  /*
   * One thumbnail: a fixed box the media is fitted into, so a set of screenshots is a row
   * rather than a column of full-width pictures. Clicking opens the viewer that pans and
   * zooms, which is where a screenshot is actually read.
   */
  &__thumb {
    position:      relative;
    display:       block;
    width:         148px;
    height:        96px;
    padding:       0;
    border:        1px solid var(--border);
    border-radius: var(--border-radius);
    background:    var(--box-bg);
    overflow:      hidden;
    cursor:        zoom-in;
    min-height:    0;

    img,
    video {
      width:      100%;
      height:     100%;
      object-fit: cover;
      display:    block;
    }

    &:hover { border-color: var(--link); }
  }

  &__thumb-play {
    position:      absolute;
    inset:         auto 4px 4px auto;
    padding:       0 5px;
    border-radius: 3px;
    background:    rgba(0, 0, 0, .55);
    color:         #fff;
    font-size:     10px;
  }

  /*
   * A screenshot inside a report or a comment is the same size, and opens the same way. These
   * are markdown images, so the rule reaches them by element rather than by class; `:deep`,
   * because a scoped stylesheet does not stamp its attribute on v-html content.
   */
  :deep(.workspace-rail__md img),
  :deep(.comment-body img) {
    max-width:      148px;
    max-height:     96px;
    object-fit:     cover;
    border:         1px solid var(--border);
    border-radius:  var(--border-radius);
    cursor:         zoom-in;
    vertical-align: middle;
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
    gap:            12px;
  }

  &__pager {
    display:     flex;
    align-items: center;
    gap:         10px;
    flex-wrap:   wrap;
    padding:     4px 0 2px;
  }

  &__page-step {
    display:         inline-flex;
    align-items:     center;
    justify-content: center;
    border:          1px solid var(--pr-border);
    border-radius: var(--border-radius);
    background:    var(--pr-bg);
    color:         var(--pr-text);
    font:          inherit;
    font-size:     12px;
    padding:       3px 10px;
    cursor:        pointer;

    &:disabled { opacity: .4; cursor: default; }
    &:not(:disabled):hover { background: var(--pr-el-hover); }
  }

  &__page-nums {
    display:   flex;
    gap:       4px;
    flex-wrap: wrap;
  }

  &__page-num {
    display:         inline-flex;
    align-items:     center;
    justify-content: center;
    min-width:       26px;
    border:        1px solid transparent;
    border-radius: var(--border-radius);
    background:    var(--pr-bg);
    color:         var(--pr-muted);
    font:          inherit;
    font-size:     12px;
    padding:       2px 6px;
    cursor:        pointer;

    &:hover { color: var(--pr-text); }
    &--open { color: var(--pr-warning); border-color: var(--pr-warning); }
    &--approved { color: var(--pr-success); border-color: var(--pr-success); }
    &--on {
      background:   var(--pr-accent);
      border-color: var(--pr-accent);
      color:        var(--pr-on-accent);
      font-weight:  700;
    }
  }

  &__page-of {
    margin-left: auto;
    color:       var(--pr-muted);
    font-size:   12px;
  }

  &__comment-head {
    display:     flex;
    align-items: center;
    gap:         10px;
    font-size:   12px;
    flex-wrap:   wrap;

    code {
      font-size:     11px;
      color:         var(--pr-muted);
      padding:       3px 8px;
      border:        1px solid var(--pr-border);
      border-radius: var(--border-radius);
      background:    var(--pr-bg);
    }
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
