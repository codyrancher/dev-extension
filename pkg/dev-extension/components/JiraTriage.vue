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
  jiraOptions, jiraProposal, jiraApply, dismissJiraRecommendation, JIRA_BASE
} from '../jira';
import { TRIAGE_MOVES } from '../jira-steps.mjs';

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
    RcButton, AsyncButton, Banner, Stack, Row,
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

    /** Whether there is anything at all to send. An Apply that writes nothing is not an Apply. */
    hasChange() {
      const f = this.form;

      return !!(f.toStatus || f.comment.trim() || f.assignee !== null || f.team || f.resolution
        || f.fixVersions.length || f.affectsVersions.length || f.duplicate.trim());
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
        </Row>
        <p
          v-if="recommendation.reason"
          class="jira-triage__why"
        >{{ recommendation.reason }}</p>
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
        v-if="presets.length"
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
        <span class="jira-triage__head">The change</span>

        <Row
          gap="4"
          align="center"
        >
          <label>Move to</label>
          <select v-model="form.toStatus">
            <option value="">leave where it is</option>
            <option
              v-for="t in proposal.transitions"
              :key="t.id"
              :value="t.name"
            >{{ t.name }}</option>
          </select>

          <label>Assign to</label>
          <select v-model="form.assignee">
            <option :value="null">leave as it is</option>
            <option value="">nobody</option>
            <option
              v-for="u in options.assignees"
              :key="u.name"
              :value="u.name"
            >{{ u.label }}</option>
          </select>
          <RcButton
            small
            @click="assignToMe"
          >{{ options.defaults.assigneeLabel }}</RcButton>
        </Row>

        <Row
          gap="4"
          align="center"
        >
          <label>Rancher Team</label>
          <select v-model="form.team">
            <option value="">leave as it is</option>
            <option
              v-for="team in options.teams"
              :key="team"
              :value="team"
            >{{ team }}</option>
          </select>

          <label>Resolution</label>
          <select v-model="form.resolution">
            <option value="">none</option>
            <option
              v-for="r in options.resolutions"
              :key="r"
              :value="r"
            >{{ r }}</option>
          </select>
        </Row>

        <Row
          gap="4"
          align="center"
        >
          <label>Affects version</label>
          <select
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

          <label>Fix version</label>
          <select
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

  &__head { color: var(--muted); font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; }

  &__presets { flex-wrap: wrap; }

  &__about { margin: 0; color: var(--muted); max-width: 80ch; }

  &__note { font-size: 11px; }
}
</style>
