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
  stepsFor, gatherEvidence, ago, commitFiles, combinedFiles, contextRows, skillsFor, skillPrompt
} from '../workspace-rail';
import { prFile } from '../reviews';
import {
  listConversations, startConversation, queuePrompt, startPaneDetached, conversationStates
} from '../conversations';
import { ensureWorkspaceReady } from '../workspace-tools';
import {
  startIssueFix, startPrReview, approveAndMerge, reviewPrompt, fixPrompt, DEFAULT_REPO
} from '../reviews';
import { readSkill, saveSkill } from '../skills';
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
      // No "open on GitHub" among these: the header already links the issue and the PR, and
      // what belongs here is what the page itself can do - the steps that would otherwise be
      // taken by hand.
      const conversation = { label: 'Open the conversation', run: 'openTab', arg: 'conversations' };

      if (s.kind === 'fix') {
        switch (s.stage) {
        case 'assess':
        case 'code':
          if (s.agent === 'none') {
            return {
              headline: 'Nothing has started on this issue', detail: 'Starts a conversation that reproduces the issue, fixes it, verifies the fix and opens a draft PR.', primary: { label: 'Start the fix', run: 'startFix' }, tools: [],
            };
          }
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
            headline: 'Waiting for a reviewer', detail: 'Nothing to do here until someone comments. The agent can still be asked for something meanwhile.', primary: { label: 'Ask the agent', run: 'focusAsk' }, tools: [],
          };
        case 'feedback':
          return {
            headline: 'Reviewers left comments after your last push', detail: 'The agent reads each comment, answers or changes the code, re-verifies and pushes. You read its report before anything else happens.', primary: { label: 'Answer the feedback', run: 'answerFeedback' }, tools: [{ label: 'Re-verify the fix', run: 'reverify' }, { label: 'Ask the agent', run: 'focusAsk' }],
          };
        case 'merged':
          return {
            headline: s.label === 'Approved' ? 'Approved' : 'Merged', detail: 'The workspace can go; the PR and the conversation history stay on GitHub and in the agent pod.', primary: { label: 'Delete the workspace', run: 'remove' }, tools: [],
          };
        }
      }
      if (s.kind === 'review') {
        switch (s.stage) {
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
          return {
            headline: 'The agent\'s findings are ready for your pass', detail: 'Go through them, keep the ones you agree with, and submit the review as yours.', primary: { label: 'Go through the findings', run: 'openTab', arg: 'pr' }, tools: [{ label: 'Ask the agent', run: 'focusAsk' }],
          };
        case 'submitted':
          return {
            headline: 'Your review is with the developer', detail: 'This moves on when they push or reply.', primary: { label: 'Approve and merge', run: 'approveMerge' }, tools: [],
          };
        case 'response':
          return {
            headline: 'The developer responded', detail: 'New commits and replies since your review are on the left. The agent can review what changed against your comments.', primary: { label: 'Review the new commits', run: 'reviewAgain' }, tools: [{ label: 'Go through the findings', run: 'openTab', arg: 'pr' }, { label: 'Approve and merge', run: 'approveMerge' }],
          };
        case 'approved':
          return {
            headline: s.label === 'Merged' ? 'Merged' : 'Approved', detail: s.label === 'Merged' ? 'The workspace can go.' : 'Approved; merge it when CI is green.', primary: s.label === 'Merged' ? { label: 'Delete the workspace', run: 'remove' } : { label: 'Merge', run: 'approveMerge' }, tools: [],
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
    clearTimeout(this.evidenceRetryTimer);
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

    /**
     * The prompt an action sends, verbatim - what the middle click shows. '' for the actions
     * that are not an agent's: marking a PR ready, merging, opening a view.
     */
    promptOf(run) {
      const pr = this.status?.pr || 0;

      switch (run) {
      case 'startFix':
        return fixPrompt(this.issue, DEFAULT_REPO);
      case 'startReview':
        return reviewPrompt(pr, DEFAULT_REPO);
      case 'answerFeedback':
        return `/my-pr-address-feedback Address the review feedback on ${ DEFAULT_REPO } PR #${ pr }: read every comment left since the last push, answer each one or change the code, re-verify, and push. Report what you changed and what you answered.`;
      case 'reverify':
        return `/my-fix-demonstrate Re-verify the fix on this branch${ pr ? ` (PR #${ pr })` : '' } and record a fresh video of the same walk.`;
      case 'reviewAgain':
        return `The developer pushed new commits and/or replied since the review of ${ DEFAULT_REPO } PR #${ pr } was submitted. Review what changed against the comments that were made: say which are addressed, which are not, and anything new the changes introduce. File through $CLAUDE_HARNESS_API/my-work/pr/${ pr }.`;
      default:
        return '';
      }
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
      const prompt = action.skill ? skillPrompt(action, this.status, this.issue) : this.promptOf(action.run);

      if (!prompt) {
        return;
      }
      const skill = action.skill || this.skillIn(prompt);

      this.inspecting = {
        label: action.label, prompt, skill, content: '', error: '',
      };
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

    async runSkill(button) {
      if (this.busy) {
        return;
      }
      this.busy = button.skill;
      this.error = '';
      this.notice = '';
      try {
        const text = skillPrompt(button, this.status, this.issue);

        await this.say(button.fresh ? `${ button.label } #${ this.status.pr || this.issue }` : '', text, !button.fresh);
        this.notice = `${ button.label }: the agent is on it in the conversation below.`;
      } catch (e) {
        this.error = e?.message || String(e);
      } finally {
        this.busy = '';
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
    async say(title, text, reuse = !title) {
      await ensureWorkspaceReady(this.workspace.name);
      const conversations = await listConversations(this.workspace.name).catch(() => []);
      // The conversation about this work - the fix's, the review's, the feedback's - before a
      // scratch one somebody opened from the pane bar; the newest of those.
      const about = conversations.filter((c) => /^(Fix|Review|Feedback|Improve|CI) /.test(c.title || '') || (this.status?.pr && (c.title || '').includes(`#${ this.status.pr }`)));
      const newest = about[about.length - 1] || conversations[conversations.length - 1];

      if (newest && reuse) {
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
      // Into the fix's own conversation when there is one - it has the context of every round -
      // and a new one named for the PR otherwise.
      await this.say(`Feedback on #${ pr }`, `/my-pr-address-feedback Address the review feedback on ${ DEFAULT_REPO } PR #${ pr }: read every comment left since the last push, answer each one or change the code, re-verify, and push. Report what you changed and what you answered.`, true);
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
  <!--
    `pr-review` is the PR panel's own class: it carries that panel's colour tokens and its diff,
    file and comment rules (components/pr/panel.scss, imported below), so the code and the
    comments here are drawn exactly as the PR page draws them.
  -->
  <div class="workspace-rail pr-review">
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
          <!--
            Two groups, and the gap between them is the point: what to ask the agent to do
            here, then what to decide. Each skill is a prompt into this workspace's
            conversation, so what it starts is watched and talked to below.
          -->
          <div
            v-if="skillButtons().length"
            class="workspace-rail__group"
          >
            <span class="workspace-rail__group-label">Ask the agent</span>
            <div class="workspace-rail__group-buttons">
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
          <div class="workspace-rail__group workspace-rail__group--decide">
            <span
              v-if="action.tools.length"
              class="workspace-rail__group-label"
            >Then</span>
            <div class="workspace-rail__group-buttons">
              <RcButton
                v-for="tool in action.tools"
                :key="tool.label"
                variant="secondary"
                :disabled="!!busy"
                :title="startsAgent(tool) ? 'Middle click to see the prompt and the skill' : ''"
                @click="run(tool)"
                @mousedown="onAux(tool, $event)"
                @auxclick="onAux(tool, $event)"
              >
                {{ tool.label }}
              </RcButton>
              <RcButton
                variant="primary"
                :disabled="!!busy"
                :title="startsAgent(action.primary) ? 'Middle click to see the prompt and the skill' : ''"
                @click="run(action.primary)"
                @mousedown="onAux(action.primary, $event)"
                @auxclick="onAux(action.primary, $event)"
              >
                <i
                  v-if="busy === action.primary.run"
                  class="icon icon-spinner icon-spin"
                />
                {{ action.primary.label }}
              </RcButton>
            </div>
          </div>
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
                  class="md-body workspace-rail__md"
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
                  v-if="item.items.length > 1 && item.pr"
                  class="workspace-rail__combined-bar"
                >
                  <button
                    type="button"
                    class="workspace-rail__back"
                    @click="showCombined(item)"
                  >{{ combinedFor(item) ? 'Hide the combined diff' : `All ${ item.items.length } commits${ item.since ? ` since ${ item.since }` : '' } as one diff` }}</button>
                </div>
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
                      :class="{ 'workspace-rail__page-num--on': n === pageOf(section, item), 'workspace-rail__page-num--open': !c.answered }"
                      :title="`${ c.where }${ c.answered ? '' : ' · waiting' }`"
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
                            :class="[r.type, { 'in-comment-range': r.marked }]"
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
            <h4 class="workspace-rail__section-title">The prompt, as it is sent</h4>
            <pre class="workspace-rail__prompt">{{ inspecting.prompt }}</pre>
            <p class="workspace-rail__detail">It goes to this workspace's conversation, so the run is watched and talked to like any other.</p>
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

    &--working { color: var(--primary); }
    &--input { color: var(--warning); }
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
    padding:        10px 12px;
    border:         1px solid var(--pr-border);
    border-radius:  var(--border-radius);
    background:     var(--pr-bg);

    &--decide {
      align-items:  flex-end;
      border-color: var(--pr-accent);
    }
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

  &__combined-bar {
    display:       flex;
    justify-content: flex-end;
    margin-bottom: 6px;
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
    gap:            18px;
    padding:        16px 18px;
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
    gap:            10px;
    padding-bottom: 4px;
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
    &--new { background: var(--pr-accent-fill); color: var(--pr-accent); }
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
