<script>
// The moves the team's bug-triage runbook asks for, as a panel: the ones that write to a
// customer's ticket.
//
// It is one form and not six buttons, because the runbook's steps are not single writes. Review
// is "set Rancher Team, put it on somebody, move it to In Triage and say so in a comment" - four
// edits that the doc is explicit have to go together, and doing them separately is how three of
// four get done. So the panel composes one apply out of whatever is ticked, and dev-api does them
// in the order that is safe (comment, assignee, fields, then the move last, so a failed move
// never leaves a comment promising something that did not happen).
//
// Everything offered here is something Jira will accept: the statuses are that ticket's own legal
// transitions and the versions, teams and resolutions are its `editmeta` allowed values, read
// through `/options`. A free-text box that 400s on submit is not a choice.
import { mapGetters } from 'vuex';
import { RcButton } from '@components/RcButton';
import AsyncButton from '@shell/components/AsyncButton';
import Banner from '@components/Banner/Banner.vue';
import Stack from '../design/Stack.vue';
import Row from '../design/Row.vue';
import {
  jiraOptions, jiraProposal, jiraApply, dismissJiraRecommendation, amendJiraRecommendation, jiraEmbed, JIRA_BASE
} from '../jira';
import { devFetch, workspaceMediaListUrl } from '../api';
import { putArtifact } from '../workspace-tools';
import CommentAttachments from './pr/CommentAttachments.vue';
import { TRIAGE_MOVES } from '../jira-steps.mjs';
import { startConclusionDiscussion, sayInConversation } from '../reviews';
import { listConversations, paneCommand } from '../conversations';
import StudioTerminal from './StudioTerminal.vue';

/** A blank form: nothing ticked, nothing to send. */
function blank() {
  return {
    toStatus:        '',
    assignee:        null,
    comment:         '',
    team:            '',
    fixVersions:     [],
    affectsVersions: [],
    resolution:      '',
    duplicate:       '',
  };
}

export default {
  name: 'JiraTriage',

  components: {
    RcButton, AsyncButton, Banner, Stack, Row, StudioTerminal, CommentAttachments,
  },

  props: {
    /** The bug, as `SURE-12345`. */
    bug: {
      type:     String,
      required: true,
    },

    /**
     * A move to open with the form already filled in, by id.
     *
     * The rail offers the runbook's moves as buttons, and pressing one has to land on the form
     * it fills in rather than on an empty one with the same move to find again. Applied once the
     * ticket is read, because a preset's edits are built from what Jira will accept.
     */
    move: {
      type:    String,
      default: '',
    },

    /**
     * The workspace whose conversations a discussion about the conclusion joins.
     *
     * Empty means no discussion is offered, which is honest rather than defensive: the pane
     * reaches the Jira routes through `$CLAUDE_HARNESS_API`, which only exists in a workspace's
     * pod, so a host that cannot name one has nowhere to hold the conversation.
     */
    workspace: {
      type:    String,
      default: '',
    },
  },

  /*
   * `state` is how the dialog's footer knows what to draw.
   *
   * The Apply and Close buttons used to be the last Row of this component, which put them
   * inside the scrolling body, left-aligned, under however many rows the form had - and on the
   * Approve panel beside it that came out as the answer sitting bottom-left under twenty
   * attachments. They belong in DevModal's footer, which is the host's to render, so what the
   * host needs is whether there is anything to apply.
   */
  emits: ['applied', 'close', 'state'],

  data() {
    return {
      /** What the ticket says now, the pending proposal, and the legal moves. */
      proposal: null,
      /** What Jira will accept for each field. */
      options:  null,
      form:     blank(),
      preset:   '',
      loading:  true,
      error:    '',
      done:     '',
      /** Whether the conclusion is being corrected, and the draft of it while it is. */
      editing:  false,
      edit:     { reason: '', comment: '' },
      /*
       * The discussion about the conclusion: the conversation it is held in, the line waiting to
       * go into it, and whether one is being opened.
       *
       * `talking` is the panel showing at all - a discussion that has been opened stays on the
       * page while the form below it is filled in, because the point of it is to get the wording
       * right before pressing Apply.
       */
      talking:  false,
      talk:     '',
      /** The conversation the discussion is held in, once there is one. */
      conversation: null,
      /*
       * The evidence: what will go onto the ticket when Apply is pressed, and what there is to
       * choose from.
       *
       * `staged` is the list, each `{ path, name, caption, kind, url, byAgent }`. Nothing is
       * uploaded until Apply - see the note on `stage` - so this is a plan rather than a record.
       * `media` is the workspace's own recordings and screenshots, read once when the ticket is,
       * and `busy` is the path being put into the workspace from this machine.
       */
      staged:   [],
      media:    [],
      busy:     '',
      opening:  false,
    };
  },

  computed: {
    ...mapGetters({ t: 'i18n/t' }),

    status() {
      return this.proposal?.current?.status || '';
    },

    /** The presets this status is for. A move the ticket cannot make is not offered. */
    presets() {
      const legal = new Set((this.proposal?.transitions || []).map((t) => t.name));

      return TRIAGE_MOVES
        .filter((p) => p.when.includes(this.status))
        .filter((p) => {
          const to = p.edits(this.options || { defaults: {} }).toStatus;

          return !to || legal.has(to);
        });
    },

    /** The proposal an agent left, if it is still waiting on somebody. */
    recommendation() {
      return this.proposal?.recommendation || null;
    },

    /**
     * The one move this dialog is for, when it was opened on one.
     *
     * Opened from a move's own button - "Another team", "Duplicate" - the dialog is about that
     * move and nothing else: it shows the fields the move has to ask for (`needs`) and says the
     * rest in a sentence. Opened from "Triage it" there is no move, and it is the whole form,
     * which is the thing to reach for when none of the seven is quite what happened.
     */
    focused() {
      return this.move ? (TRIAGE_MOVES.find((m) => m.id === this.move) || null) : null;
    },

    /**
     * What the focused move does without asking, as rows to read.
     *
     * Everything its `edits` decides that is not in `needs` and is not the comment - the comment
     * is shown in full, being the half a person actually writes. A move that decides nothing by
     * itself ("Ask the reporter" only moves the status) still gets its status row, which is the
     * one thing worth confirming before pressing Apply.
     */
    settled() {
      if (!this.focused) {
        return [];
      }
      const edits = this.focused.edits(this.options || { defaults: {} });
      const names = {
        toStatus: 'Moves it to', team: 'Rancher Team', assignee: 'Assign to', resolution: 'Resolution', fixVersions: 'Fix version', affectsVersions: 'Affects version', duplicate: 'Duplicate of',
      };

      return Object.keys(names)
        .filter((k) => !this.focused.needs.includes(k))
        .map((k) => ({ k: names[k], v: Array.isArray(edits[k]) ? edits[k].join(', ') : String(edits[k] ?? '') }))
        .filter((row) => row.v);
    },

    /**
     * Whether there is anything at all to send. An Apply that writes nothing is not an Apply.
     *
     * Evidence counts only when a PERSON put it there. The agent's own attachments are staged
     * the moment the panel opens - that is what they were gathered for - and if they counted,
     * opening this dialog and pressing Apply would put a video of the customer's cluster on
     * their ticket with not a word of explanation. So they ride along with a real change, and a
     * file chosen here is the deliberate act that makes Apply live on its own.
     */
    hasChange() {
      const f = this.form;

      return !!(f.toStatus || f.comment.trim() || f.assignee !== null || f.team || f.resolution
        || f.fixVersions.length || f.affectsVersions.length || f.duplicate.trim()
        || this.staged.some((a) => !a.byAgent));
    },

    /** The workspace's recordings and screenshots that are not already staged. */
    unstaged() {
      const on = new Set(this.staged.map((a) => a.path));

      return this.media.filter((f) => !on.has(this.artifactPath(f.path)));
    },

    jiraUrl() {
      return `${ JIRA_BASE }/browse/${ this.bug }`;
    },
  },

  /*
   * Everything the footer draws, told rather than read.
   *
   * A `$refs` lookup is not reactive in Vue 3, so a host reading `hasChange` off the ref would
   * draw an Apply that never stopped being disabled. `immediate` so the footer is right on the
   * first frame, and `proposal` is in here because until the ticket has been read there is
   * nothing to apply TO - which is the difference between a disabled Apply and no footer at all.
   */
  watch: {
    hasChange: { handler: 'tellHost', immediate: true },
    proposal:  { handler: 'tellHost', immediate: true },
  },

  async mounted() {
    await this.load();
    if (this.move) {
      this.choose(this.move);
    }
  },

  methods: {
    /**
     * Talk it through instead of rewriting it.
     *
     * A conversation in the bug's own workspace, scoped to this conclusion, the way a PR
     * comment's discussion is scoped to that comment (CommentDiscussion). The agent is told
     * what it concluded and given the route that amends it - see conclusionPrompt - so the two
     * halves of "this is nearly right" compose: argue about it here, and the corrected wording
     * is what "Fill the form in with it" then picks up.
     *
     * The conversation is reattached rather than restarted when one is already open for this
     * bug: a second press, or coming back to the dialog tomorrow, lands in the thread that was
     * already about it. Titled `Discuss <KEY>`, which is also what keeps it out of the stage's
     * tab strip - see railConversations.
     */
    async discuss() {
      if (this.opening) {
        return;
      }
      this.opening = true;
      this.error = '';

      try {
        const title = `Discuss ${ this.bug }`;
        const existing = (await listConversations(this.workspace).catch(() => [])).find((c) => c.title === title);

        this.conversation = existing || await startConclusionDiscussion(this.workspace, this.bug, this.recommendation, this.talk.trim());
        if (existing && this.talk.trim()) {
          await sayInConversation(existing, this.talk.trim());
        }
        this.talk = '';
        this.talking = true;
      } catch (e) {
        this.error = e?.message || String(e);
      } finally {
        this.opening = false;
      }
    },

    /** A further line into a discussion that is already running. */
    async say() {
      const message = this.talk.trim();

      if (!message || !this.conversation) {
        return;
      }
      this.talk = '';
      await sayInConversation(this.conversation, message).catch((e) => {
        this.error = e?.message || String(e);
      });
    },

    /**
     * Pick up whatever the discussion has corrected.
     *
     * The agent amends the proposal over the API, which this panel is holding a copy of - so
     * without this the conclusion on screen is the one from before the conversation. Re-read
     * rather than watched: a poll against Jira every few seconds while somebody types is not
     * worth what it would cost, and the person knows when they have settled it.
     */
    async reread(done) {
      try {
        await this.load();
        if (this.preset === 'recommendation') {
          this.preset = '';
          this.choose('recommendation');
        }
        done(true);
      } catch (e) {
        this.error = e?.message || String(e);
        done(false);
      }
    },

    /** The argv of the discussion's pane: claude in the workspace, reached through the agent pod. */
    paneFor(id) {
      return paneCommand(this.workspace, id);
    },

    /** Open the conclusion for correction, on a copy, so Cancel leaves what was filed alone. */
    startEdit() {
      this.edit = { reason: this.recommendation?.reason || '', comment: this.recommendation?.comment || '' };
      this.editing = true;
    },

    /**
     * Save the correction against the proposal.
     *
     * The stored recommendation is replaced in memory with what came back, so the form's preset
     * reads the corrected comment rather than the one that was wrong - "Fill the form in with
     * it" after an edit has to mean the edited one or the edit was for nothing.
     */
    async saveEdit(done) {
      try {
        const saved = await amendJiraRecommendation(this.bug, this.edit);

        if (this.proposal) {
          this.proposal = { ...this.proposal, recommendation: saved };
        }
        if (this.preset === 'recommendation') {
          this.choose('recommendation');
        }
        this.editing = false;
        done(true);
      } catch (e) {
        this.error = e?.message || String(e);
        done(false);
      }
    },

    /**
     * A path as the attach route wants it: relative to the workspace's artifacts.
     *
     * The media listing is already relative to that directory and the recommendation's paths
     * may be absolute, from the checkout, or relative - the route normalises all three
     * (jiraArtifactRel), so this only has to be consistent enough to compare two of them.
     */
    artifactPath(p) {
      return String(p || '').replace(/^\/workspaces\/[^/]+\//, '').replace(/^artifacts\//, '');
    },

    /**
     * Put a file on the list that Apply will upload, and name it in the comment.
     *
     * Nothing is uploaded here. Jira's attachment API writes to the customer's ticket the
     * instant it is called, and this panel's whole promise is that nothing reaches the reporter
     * until Apply - so an attach button that uploaded on the spot would be the one control here
     * that broke it. Apply sends the list and the route uploads before it comments, which also
     * fixes the ordering: a comment carrying `!shot.png|thumbnail!` that lands first shows the
     * markup as text until the file arrives.
     *
     * The embed goes into the comment box, where it can be moved, captioned or deleted like any
     * other line. A file nobody names is still attached - which is the right answer for a HAR
     * nobody wants to read but somebody may need.
     */
    stage(file, byAgent = false) {
      const path = this.artifactPath(file.path);

      if (!path || this.staged.some((a) => a.path === path)) {
        return;
      }
      const name = file.name || path.split('/').pop() || path;
      const kind = file.kind || (/\.(webm|mp4)$/i.test(name) ? 'video' : (/\.(png|jpe?g|gif|webp)$/i.test(name) ? 'image' : 'file'));

      this.staged = [...this.staged, {
        path, name, caption: file.caption || '', kind, url: file.url || null, byAgent,
      }];

      // Named in the comment only where there is a comment to name it in: a form opened on a
      // move that does not comment has nowhere to put the markup, and adding one would be this
      // panel writing prose of its own to a customer.
      if (this.shows('comment')) {
        const body = this.form.comment;
        const mark = jiraEmbed(name, kind);

        if (!body.includes(mark)) {
          this.form.comment = `${ body }${ !body || body.endsWith('\n') ? '' : '\n\n' }${ mark }\n`;
        }
      }
    },

    /** Off the list again, and out of the comment if that is where its markup still is. */
    unstage(path) {
      const gone = this.staged.find((a) => a.path === path);

      this.staged = this.staged.filter((a) => a.path !== path);
      if (gone) {
        this.form.comment = this.form.comment
          .split('\n')
          .filter((line) => line.trim() !== jiraEmbed(gone.name, gone.kind))
          .join('\n');
      }
    },

    /** Something from this machine: into the workspace's artifacts, then onto the list. */
    async stageUpload(event) {
      const file = event.target?.files?.[0];

      if (!file || !this.workspace) {
        return;
      }
      event.target.value = '';
      this.busy = file.name;
      this.error = '';
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = '';

        for (let i = 0; i < bytes.length; i += 8192) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        }
        const rel = await putArtifact(this.workspace, file.name, btoa(binary));

        this.stage({ path: rel, name: file.name });
        await this.loadMedia();
      } catch (e) {
        this.error = e?.message || String(e);
      } finally {
        this.busy = '';
      }
    },

    /**
     * The workspace's own recordings and screenshots, newest first.
     *
     * The same filter the approve panel uses: not the thousands of single frames a recording
     * leaves behind while it is being made, and videos before stills because a reproduction is
     * usually the thing being looked for. A failed read leaves whatever is listed alone.
     */
    async loadMedia() {
      if (!this.workspace) {
        return;
      }
      const files = await devFetch(workspaceMediaListUrl(this.workspace))
        .then((d) => (d?.files || [])
          .filter((f) => !/(^|\/)(tmp-frames|frames|\.cache)[^/]*\//.test(f.path) && !/\/f\d+\.(png|jpe?g)$/.test(f.path))
          .sort((a, b) => Number(/video/.test(b.type || '')) - Number(/video/.test(a.type || '')) || (b.mtimeMs || 0) - (a.mtimeMs || 0))
          .slice(0, 20))
        .catch(() => null);

      if (files) {
        this.media = files;
      }
    },

    /** Whether a field is this dialog's business: all of them, or the move's own. */
    shows(field) {
      return !this.focused || this.focused.needs.includes(field);
    },

    /** What the dialog's footer needs: whether the ticket is readable, and whether to enable Apply. */
    tellHost() {
      this.$emit('state', { ready: !!this.proposal, hasChange: this.hasChange });
    },

    async load() {
      this.loading = true;
      this.error = '';
      try {
        // Both at once: the proposal carries what the ticket says today and the legal moves, the
        // options carry what each field may be set to. Neither is useful without the other.
        const [proposal, options] = await Promise.all([jiraProposal(this.bug), jiraOptions(this.bug)]);

        this.proposal = proposal;
        this.options = options;
        /*
         * The agent's evidence, staged as the panel opens.
         *
         * It was gathered to go on the ticket - the conclusion above says so in as many words
         * ("the 29s video, the search comparison, and a screenshot of the empty search") - and
         * leaving it as prose naming three files meant the one step that put them where the
         * reporter could see them was the one step nobody did. So it is on the list already,
         * listed and removable, rather than something to remember.
         *
         * `byAgent` so it does not make Apply live by itself; see hasChange.
         */
        for (const file of proposal?.recommendation?.attachments || []) {
          this.stage(file, true);
        }
        // Not awaited: it is a third request and the form below does not need it to be drawn.
        this.loadMedia();
      } catch (e) {
        this.error = e.message || String(e);
      } finally {
        this.loading = false;
      }
    },

    /**
     * Fill the form in from a preset, or empty it again.
     *
     * The agent's proposal is a preset too - "what the agent concluded" - and it is the one that
     * comes with a reason attached. Choosing it a second time clears the form, so a preset
     * pressed by mistake is one press to undo rather than a form to re-empty by hand.
     */
    choose(id) {
      if (this.preset === id) {
        this.preset = '';
        this.form = blank();

        return;
      }
      this.preset = id;
      this.form = blank();

      if (id === 'recommendation') {
        const rec = this.recommendation;

        this.form = {
          ...blank(),
          toStatus:        rec.toStatus || '',
          assignee:        rec.assignee || null,
          comment:         rec.comment || '',
          team:            rec.fields?.team || '',
          fixVersions:     rec.fields?.fixVersions || [],
          affectsVersions: rec.fields?.affectsVersions || [],
          resolution:      rec.fields?.resolution || '',
          duplicate:       (rec.fields?.links || []).map((l) => l.key).join(', '),
        };

        return;
      }
      const preset = TRIAGE_MOVES.find((p) => p.id === id);
      const edits = preset ? preset.edits(this.options) : {};

      this.form = {
        ...blank(),
        ...edits,
        duplicate: (edits.links || []).map((l) => l.key).join(', '),
        links:     undefined,
      };
    },

    /**
     * Write it. One call, which dev-api orders: comment, assignee, fields, then the move.
     *
     * The duplicate is typed as a key and sent as a link, because the link type's name differs
     * between Jira instances and dev-api resolves it against the real list - what a person types
     * here is which bug, not which word Jira calls the relationship.
     */
    async apply(done) {
      this.error = '';
      this.done = '';
      try {
        const keys = this.form.duplicate.split(/[\s,]+/).map((k) => k.trim().toUpperCase()).filter(Boolean);
        const result = await jiraApply(this.bug, {
          toStatus:        this.form.toStatus || null,
          comment:         this.form.comment.trim(),
          assignee:        this.form.assignee,
          // Uploaded before anything else is written, which is the route's job rather than this
          // panel's: see jiraApply. The workspace rides along because the files are under its
          // artifacts and a bug's workspace is only derivable for the ones named after it.
          attachments:     this.staged.map((a) => a.path),
          workspace:       this.workspace || undefined,
          team:            this.form.team || undefined,
          fixVersions:     this.form.fixVersions.length ? this.form.fixVersions : undefined,
          affectsVersions: this.form.affectsVersions.length ? this.form.affectsVersions : undefined,
          resolution:      this.form.resolution || undefined,
          links:           keys.length ? keys.map((key) => ({ type: 'Duplicate', key })) : undefined,
          // Only a form filled in from the agent's proposal counts as taking that proposal. A
          // correction made beside it leaves it pending, because it is still waiting on an answer.
          recommendation:  this.preset === 'recommendation',
        });

        this.done = [this.form.comment.trim() ? 'commented' : '', result.status ? `moved to ${ result.status }` : '', ...(result.details || [])]
          .filter(Boolean).join(', ') || 'nothing to change';
        this.form = blank();
        this.preset = '';
        // On the ticket now, so the list empties: `load` below re-stages whatever the next
        // pending proposal carries, and an applied one carries nothing - it is no longer pending.
        this.staged = [];
        await this.load();
        this.$emit('applied');
        done(true);
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },

    async dismiss(done) {
      this.error = '';
      try {
        await dismissJiraRecommendation(this.bug);
        await this.load();
        done(true);
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },

    /** Put it on me, which is the one assignment the runbook asks for by name. */
    assignToMe() {
      const me = this.options?.defaults?.assignee || '';

      this.form.assignee = this.form.assignee === me ? null : me;
    },
  },
};
</script>

<template>
  <Stack
    gap="5"
    class="jira-triage"
  >
    <div
      v-if="loading"
      class="jira-triage__loading"
    >
      <i class="icon icon-spinner icon-spin" />
      <span>Reading {{ bug }} from Jira&hellip;</span>
    </div>

    <Banner
      v-if="error"
      color="error"
      :label="error"
    />

    <template v-if="proposal">
      <!--
        What the ticket says now. First, because every decision below is a change to one of
        these, and a panel that offers "move to In Triage" without saying where it is now is
        asking somebody to remember.
      -->
      <Stack
        gap="2"
        class="jira-triage__now"
      >
        <Row
          gap="4"
          align="center"
        >
          <a
            :href="jiraUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="jira-triage__key"
          >{{ bug }}</a>
          <span class="jira-triage__status">{{ status || 'unknown' }}</span>
          <span class="text-muted">{{ proposal.current.assignee || 'nobody' }}</span>
          <span
            v-if="proposal.current.team"
            class="text-muted"
          >team {{ proposal.current.team }}</span>
          <span
            v-else
            class="jira-triage__gap"
          >no team</span>
          <span
            v-if="proposal.current.affectsVersions.length"
            class="text-muted"
          >affects {{ proposal.current.affectsVersions.join(', ') }}</span>
          <span
            v-else
            class="jira-triage__gap"
          >no affects version</span>
        </Row>
      </Stack>

      <!--
        The agent's own conclusion, where one is waiting. Offered as a preset rather than applied
        for you: the step before Apply is the one the process requires, and a panel that filled
        the form in and pressed the button would be the crossover it forbids.
      -->
      <Stack
        v-if="recommendation"
        gap="3"
        class="jira-triage__rec"
      >
        <Row
          gap="4"
          align="center"
        >
          <strong>The agent's conclusion</strong>
          <span class="text-muted">{{ recommendation.action }}</span>
          <span
            v-if="recommendation.editedAt"
            class="text-muted jira-triage__note"
          >edited</span>
          <!--
            The conclusion is prose somebody disagrees with, so it is prose somebody can fix.
            It was read-only, which left "the agent got this wrong" with nowhere to go but Put
            it aside - and putting a conclusion aside throws away the evidence attached to it
            along with the one sentence that was wrong.
          -->
          <RcButton
            v-if="!editing"
            small
            class="jira-triage__edit"
            @click="startEdit"
          >Edit it</RcButton>
          <!--
            And the other way of putting it right: ask the agent about it. What is wrong with a
            conclusion is often a thing the agent knows and the person does not - which version
            it reproduced on, what the reporter's log actually said - and that is a conversation
            rather than a textarea. See `discuss`.
          -->
          <RcButton
            v-if="workspace && !talking"
            small
            class="jira-triage__edit"
            :disabled="opening"
            @click="discuss"
          >{{ opening ? 'Opening…' : 'Discuss it' }}</RcButton>
        </Row>
        <p
          v-if="recommendation.reason && !editing"
          class="jira-triage__why"
        >{{ recommendation.reason }}</p>
        <template v-if="editing">
          <textarea
            v-model="edit.reason"
            class="jira-triage__editor"
            rows="8"
            aria-label="The agent's conclusion"
          />
          <label class="jira-triage__head">The comment it proposed</label>
          <textarea
            v-model="edit.comment"
            class="jira-triage__editor"
            rows="4"
            aria-label="The comment it proposed"
            placeholder="Nothing is commented unless this has something in it."
          />
          <Row
            gap="3"
            align="center"
          >
            <AsyncButton
              mode="apply"
              action-label="Save the correction"
              waiting-label="Saving"
              success-label="Saved"
              size="sm"
              @click="(done) => saveEdit(done)"
            />
            <RcButton
              small
              @click="editing = false"
            >Cancel</RcButton>
            <span class="text-muted jira-triage__note">Saved against the proposal, not the ticket. Nothing reaches the reporter until Apply.</span>
          </Row>
        </template>

        <!--
          The discussion, under the conclusion it is about - the shape a PR comment's discussion
          has (CommentDiscussion), for the same reason: the thread belongs with the thing being
          argued about, not as another tab across the top of the page.

          It stays on the page while the form below is filled in, because the point of it is to
          settle the wording before Apply. The agent amends the proposal over the API, so
          "Re-read it" is how this panel picks that up - see `reread`.
        -->
        <Stack
          v-if="talking && conversation"
          gap="3"
          class="jira-triage__talk"
        >
          <StudioTerminal
            :key="conversation.id"
            class="jira-triage__term"
            :session="conversation.id"
            :command="paneFor(conversation.id)"
          />
          <Row
            gap="3"
            align="center"
          >
            <input
              v-model="talk"
              class="jira-triage__line"
              type="text"
              aria-label="Say something into the discussion"
              placeholder="Say something into the discussion — Enter to send"
              @keydown.enter.prevent="say"
            >
            <AsyncButton
              mode="apply"
              action-label="Re-read it"
              waiting-label="Reading"
              success-label="Re-read"
              size="sm"
              @click="(done) => reread(done)"
            />
            <RcButton
              small
              @click="talking = false"
            >Hide it</RcButton>
          </Row>
          <span class="text-muted jira-triage__note">The conversation keeps running when this is hidden. Nothing it says reaches the reporter — it corrects the proposal, and Apply is still yours to press.</span>
        </Stack>

        <Row
          gap="3"
          align="center"
        >
          <RcButton
            small
            :primary="preset === 'recommendation'"
            @click="choose('recommendation')"
          >{{ preset === 'recommendation' ? 'Filled in below' : 'Fill the form in with it' }}</RcButton>
          <a
            v-if="recommendation.github && recommendation.github.url"
            :href="recommendation.github.url"
            target="_blank"
            rel="noopener noreferrer"
          >File the GitHub issue it drafted</a>
          <a
            v-else-if="recommendation.github && recommendation.github.existingUrl"
            :href="recommendation.github.existingUrl"
            target="_blank"
            rel="noopener noreferrer"
          >The issue that already covers it</a>
          <AsyncButton
            mode="apply"
            action-label="Put it aside"
            waiting-label="Dismissing"
            success-label="Aside"
            size="sm"
            @click="(done) => dismiss(done)"
          />
        </Row>
      </Stack>

      <!--
        The runbook's moves. Each fills the form in rather than sending anything, so what goes to
        the customer is read before it goes.
      -->
      <Stack
        v-if="presets.length && !focused"
        gap="3"
      >
        <span class="jira-triage__head">What this bug needs</span>
        <Row
          gap="3"
          class="jira-triage__presets"
        >
          <RcButton
            v-for="p in presets"
            :key="p.id"
            small
            :primary="preset === p.id"
            :title="p.about"
            @click="choose(p.id)"
          >{{ p.label }}</RcButton>
        </Row>
        <p
          v-if="preset && preset !== 'recommendation'"
          class="jira-triage__about"
        >{{ (presets.find((p) => p.id === preset) || {}).about }}</p>
      </Stack>

      <!-- And the form itself, which is what any of them is. -->
      <Stack gap="4">
        <span class="jira-triage__head">{{ focused ? focused.label : 'The change' }}</span>
        <!--
          Opened on one move, the dialog is about that move: what it does by itself is said here
          rather than left as a row of selects whose answers are already decided, and only the
          fields it has to ask for are below. See `settled` and `needs`.
        -->
        <template v-if="focused">
          <p class="jira-triage__about">{{ focused.about }}</p>
          <ul
            v-if="settled.length"
            class="jira-triage__settled"
          >
            <li
              v-for="row in settled"
              :key="row.k"
            >
              <span class="text-muted">{{ row.k }}</span>
              <strong>{{ row.v }}</strong>
            </li>
          </ul>
        </template>

        <Row
          v-if="shows('toStatus') || shows('assignee')"
          gap="4"
          align="center"
        >
          <label v-if="shows('toStatus')">Move to</label>
          <select
            v-if="shows('toStatus')"
            v-model="form.toStatus"
          >
            <option value="">leave where it is</option>
            <option
              v-for="t in proposal.transitions"
              :key="t.id"
              :value="t.name"
            >{{ t.name }}</option>
          </select>

          <label v-if="shows('assignee')">Assign to</label>
          <select
            v-if="shows('assignee')"
            v-model="form.assignee"
          >
            <option :value="null">leave as it is</option>
            <option value="">nobody</option>
            <option
              v-for="u in options.assignees"
              :key="u.name"
              :value="u.name"
            >{{ u.label }}</option>
          </select>
          <RcButton
            v-if="shows('assignee')"
            small
            @click="assignToMe"
          >{{ options.defaults.assigneeLabel }}</RcButton>
        </Row>

        <Row
          v-if="shows('team') || shows('resolution')"
          gap="4"
          align="center"
        >
          <label v-if="shows('team')">Rancher Team</label>
          <select
            v-if="shows('team')"
            v-model="form.team"
          >
            <option value="">leave as it is</option>
            <option
              v-for="team in options.teams"
              :key="team"
              :value="team"
            >{{ team }}</option>
          </select>

          <label v-if="shows('resolution')">Resolution</label>
          <select
            v-if="shows('resolution')"
            v-model="form.resolution"
          >
            <option value="">none</option>
            <option
              v-for="r in options.resolutions"
              :key="r"
              :value="r"
            >{{ r }}</option>
          </select>
        </Row>

        <Row
          v-if="shows('affectsVersions') || shows('fixVersions')"
          gap="4"
          align="center"
        >
          <label v-if="shows('affectsVersions')">Affects version</label>
          <select
            v-if="shows('affectsVersions')"
            v-model="form.affectsVersions"
            multiple
            size="3"
          >
            <option
              v-for="v in options.affectsVersions"
              :key="v"
              :value="v"
            >{{ v }}</option>
          </select>

          <label v-if="shows('fixVersions')">Fix version</label>
          <select
            v-if="shows('fixVersions')"
            v-model="form.fixVersions"
            multiple
            size="3"
          >
            <option
              v-for="v in options.fixVersions"
              :key="v"
              :value="v"
            >{{ v }}</option>
          </select>
        </Row>

        <Row
          v-if="shows('duplicate')"
          gap="4"
          align="center"
        >
          <label>Duplicate of</label>
          <input
            v-model="form.duplicate"
            type="text"
            placeholder="SURE-11000"
          >
        </Row>

        <Stack gap="2">
          <label>Comment - the reporter reads this</label>
          <textarea
            v-model="form.comment"
            rows="6"
            placeholder="Nothing is commented unless this has something in it."
          />
        </Stack>

        <!--
          The evidence, under the comment it is named in.

          What the agent gathered is already on the list - that is what it gathered it for - and
          the rest of the workspace's recordings are a press away. Nothing is uploaded until
          Apply: see `stage`, which is also where the ordering is explained.
        -->
        <Stack
          v-if="workspace && shows('comment')"
          gap="3"
          class="jira-triage__attach"
        >
          <Row
            gap="3"
            align="center"
          >
            <span class="jira-triage__head">Attach to the ticket</span>
            <span
              v-if="staged.length"
              class="text-muted jira-triage__note"
            >{{ staged.length }} going on with Apply</span>
          </Row>

          <CommentAttachments
            v-if="staged.length"
            :attachments="staged"
            removable
            hint="uploaded on Apply"
            @remove="unstage"
          />

          <Row
            gap="3"
            align="center"
          >
            <RcButton
              small
              :disabled="!!busy"
              @click="$refs.file.click()"
            >
              <i
                v-if="busy"
                class="icon icon-spinner icon-spin"
              />
              From this machine&hellip;
            </RcButton>
            <input
              ref="file"
              type="file"
              accept="image/*,video/*,.txt,.log,.har,.json,.yaml,.yml"
              class="jira-triage__file"
              @change="stageUpload"
            >
            <span class="text-muted jira-triage__note">The reporter sees everything attached here. A recording of your own cluster is the thing to think twice about.</span>
          </Row>

          <ul
            v-if="unstaged.length"
            class="jira-triage__media"
          >
            <li
              v-for="f in unstaged"
              :key="f.path"
            >
              <button
                type="button"
                class="jira-triage__media-add"
                @click="stage(f)"
              >Attach</button>
              <code>{{ f.path }}</code>
            </li>
          </ul>
        </Stack>
      </Stack>

      <Banner
        v-if="done"
        color="success"
        :label="`${ bug }: ${ done }`"
      />

    </template>
  </Stack>
</template>

<style lang="scss" scoped>
.jira-triage {
  font-size: 13px;

  label {
    color: var(--muted);
    font-size: 12px;
    margin: 0;
    white-space: nowrap;
  }

  select, input[type='text'], textarea {
    background: var(--input-bg);
    color: var(--input-text);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    padding: 2px var(--dev-space-3);
    font-size: 13px;
  }

  textarea { width: 100%; font-family: inherit; }

  input[type='text'] { width: 20ch; }

  &__loading { display: flex; gap: var(--dev-space-3); align-items: center; color: var(--muted); }

  &__now {
    padding: var(--dev-space-3) var(--dev-space-4);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    background: var(--tabbed-container-bg);
  }

  &__key { font-weight: 600; }

  &__status { color: var(--status-waiting); font-weight: 600; }

  /* What the process says should be set and is not: the same red the queue's overdue ages use. */
  &__gap { color: var(--error); }

  &__rec {
    padding: var(--dev-space-4);
    border: 1px solid var(--border);
    border-left: 2px solid var(--dev-accent);
    border-radius: var(--r-md);
  }

  &__why { margin: 0; white-space: pre-wrap; }

  /* Pushed to the end of the heading row, so "Edit it" is not a third word in the title. */
  &__edit { margin-left: auto; }

  /*
   * The conclusion under correction. Monospace is wrong here - this is a sentence somebody
   * reads, not a prompt - but it keeps the body font and the panel's own measure.
   */
  &__editor {
    width:         100%;
    box-sizing:    border-box;
    min-height:    90px;
    padding:       var(--dev-space-4);
    border:        1px solid var(--border);
    border-radius: var(--dev-r-ctl);
    background:    var(--input-bg);
    color:         var(--body-text);
    font:          inherit;
    line-height:   1.5;
    resize:        vertical;
  }

  &__head { color: var(--muted); font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; }

  &__presets { flex-wrap: wrap; }

  &__about { margin: 0; color: var(--muted); max-width: 80ch; }

  /*
   * What a focused move does by itself, read rather than chosen: one line per field, the name
   * quiet and the value not, so the row that matters - "Moves it to  In Triage" - carries.
   */
  &__settled {
    display:        flex;
    flex-direction: column;
    gap:            var(--dev-space-2);
    margin:         0;
    padding:        0;
    list-style:     none;

    li {
      display:     flex;
      align-items: baseline;
      gap:         var(--dev-space-3);
    }
  }

  &__note { font-size: 11px; }

  /*
   * The evidence, set off from the fields above it the way the discussion is from the panel.
   *
   * The `--pr-*` declarations are not decoration. CommentAttachments draws its rows from that
   * palette, which panel.scss declares on `.pr-tokens` / `.pr-review` - and this panel is inside
   * a DevModal, which teleports to `<body>`, so it has neither ancestor and every one of those
   * vars would resolve to nothing: no frame on the thumbnail, no fill behind it. The same trap
   * panel.scss's own note is about. Declared here, on this section, because a custom property
   * inherits into a child component where a scoped rule does not reach it.
   */
  &__attach {
    --pr-bg:     var(--body-bg);
    --pr-bg-2:   var(--sortable-table-header-bg);
    --pr-border: var(--border);
    --pr-text:   var(--body-text);
    --pr-muted:  var(--muted);
    --pr-accent: var(--dev-accent);
    --pr-error:  var(--status-error);

    padding-top: var(--dev-space-4);
    border-top:  1px solid var(--border);
  }

  // The real control is the button beside it; a file input draws a second one nobody styled.
  &__file { display: none; }

  &__media {
    margin:     0;
    padding:    0;
    list-style: none;
    max-height: 168px;
    overflow-y: auto;

    li {
      display:     flex;
      align-items: center;
      gap:         var(--dev-space-3);
      padding:     var(--dev-space-1) 0;
      font-size:   12px;
    }

    code {
      overflow:      hidden;
      text-overflow: ellipsis;
      white-space:   nowrap;
    }
  }

  &__media-add {
    flex:          0 0 auto;
    min-height:    0;
    padding:       0 var(--dev-space-3);
    border:        1px solid var(--border);
    border-radius: var(--dev-r-ctl);
    background:    transparent;
    color:         var(--muted);
    font-size:     11px;
    line-height:   20px;
    cursor:        pointer;

    &:hover { color: var(--link); border-color: var(--link); }
  }

  /*
   * The discussion, inside a dialog that is 720px wide and scrolls. A fixed height rather than a
   * flexed one: the dialog's body is the scroller, so a terminal told to fill its parent in here
   * collapses to nothing - there is no height to fill.
   */
  &__talk {
    padding-top:   var(--dev-space-4);
    border-top:    1px solid var(--border);
  }

  &__term {
    height:        300px;
    min-height:    0;
    border:        1px solid var(--border);
    border-radius: var(--dev-r-ctl);
    overflow:      hidden;
  }

  &__line {
    flex:      1 1 auto;
    min-width: 0;
    height:    30px;
    padding:   0 var(--dev-space-3);
    font-size: 13px;
  }
}
</style>
