<script>
// The automations, one card each: what it does, what sets it off, what it is doing and has done,
// and the events that reached it without running it - with the constraint that stopped each.
//
// Definitions are read from their ConfigMaps (agent-defs.ts); runs and attempts are dev-api's,
// watched (`/automations/status`), so a run started by an event, a schedule or another dashboard
// appears here as it happens. A run's line opens its log.
import { Banner } from '@components/Banner';
import AsyncButton from '@shell/components/AsyncButton';
import DevDialog from './DevDialog.vue';
import DevModal from './DevModal.vue';
import AgentRunRow from './AgentRunRow.vue';
import RunLog from './automations/RunLog.vue';
import {
  listAgents, listRuns, runAutomation, deleteAgent, skillOf, triggersOf
} from '../agent-defs';
import { readSkill } from '../skills';
import { watch } from '../events';
import {
  STATUS_PATH, OUTCOME_WORDS, stamp
} from '../automations';
import {
  DEV_PRODUCT, BLANK_CLUSTER, AGENT_EDIT_ROUTE, AGENTS_ROUTE, DEV_API_IN_CLUSTER
} from '../config/constants';

/** How many runs a card shows before the rest go behind its History link. */
const INLINE_RUNS = 4;

/** The definitions change by hand, so they are re-read now and then; runs are watched. */
const DEFS_MS = 15000;

export default {
  name: 'AgentCards',

  components: {
    Banner, AsyncButton, DevDialog, DevModal, AgentRunRow, RunLog
  },

  data() {
    return {
      agents:   [],
      status:   { runs: {}, attempts: {} },
      error:    '',
      timer:    null,
      unwatch:  null,
      loaded:   false,
      skill:    null,
      /** The automation whose full history is open, and its runs, or null. */
      history:  null,
      /** The run whose log is open, or ''. */
      runId:    '',
      /** Cards whose blocked attempts are unfolded. */
      unfolded: {},
      removing: null,
      OUTCOME_WORDS,
    };
  },

  computed: {
    cards() {
      return this.agents.map((def) => {
        const runs = this.status.runs?.[def.name] || [];
        const running = runs.filter((r) => ['starting', 'running', 'waiting', 'requested'].includes(r.state));
        const attempts = this.status.attempts?.[def.name] || [];

        return {
          def,
          kind:     def.action === 'script' ? 'script' : 'agent',
          skill:    def.action === 'script' ? '' : skillOf(def.prompt),
          running:  running.length,
          recent:   runs.slice(0, INLINE_RUNS),
          more:     runs.length > INLINE_RUNS,
          attempts,
          blocked:  attempts.filter((a) => a.outcome === 'blocked' || a.outcome === 'error').length,
          triggers: this.triggerWords(def),
        };
      });
    },

    newTo() {
      return { name: AGENT_EDIT_ROUTE, params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER } };
    },
  },

  async fetch() {
    await this.refresh();
  },

  mounted() {
    this.timer = setInterval(() => this.refresh(), DEFS_MS);
    this.unwatch = watch(STATUS_PATH, (value) => {
      this.status = value || { runs: {}, attempts: {} };
    }, { every: 5000 });
  },

  beforeUnmount() {
    clearInterval(this.timer);
    this.unwatch?.();
  },

  methods: {
    async refresh() {
      try {
        this.agents = await listAgents();
        this.error = '';
      } catch (e) {
        this.error = e.message || String(e);
      } finally {
        this.loaded = true;
      }
    },

    /** Each trigger as a short phrase, by hand always first. */
    triggerWords(def) {
      const words = ['by hand'];

      for (const t of triggersOf(def)) {
        if (t.type === 'cron') {
          words.push(`on a schedule: ${ t.cron }${ def.tz ? ` (${ def.tz })` : ' (UTC)' }`);
        } else if (t.type === 'api') {
          words.push('on an API call');
        } else if (t.type === 'resource') {
          words.push(`when ${ t.resource?.type || 'a resource' } is ${ t.resource?.event === 'any' ? 'changed' : (t.resource?.event || 'changed') }`);
        } else if (t.type === 'event') {
          const names = t.event?.names?.length ? t.event.names.join(', ') : 'any event';
          const from = t.event?.source ? ` from ${ t.event.source }` : '';
          const n = (t.event?.condition || '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//')).length;

          words.push(`on ${ names }${ from }${ n ? ` where ${ n } constraint${ n === 1 ? '' : 's' } hold` : '' }`);
        }
      }

      return [...new Set(words)];
    },

    hasApiTrigger(def) {
      return triggersOf(def).some((t) => t.type === 'api');
    },

    editTo(def) {
      return { name: AGENT_EDIT_ROUTE, params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER, name: def.name } };
    },

    eventsTo() {
      return { name: AGENTS_ROUTE, params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER }, hash: '#events' };
    },

    apiUrl(def) {
      return `${ DEV_API_IN_CLUSTER }/agents/${ def.name }/trigger`;
    },

    async run(def, done) {
      try {
        const run = await runAutomation(def.name, { trigger: 'manual' });

        done(true);
        if (run?.id) {
          this.runId = run.id;
        }
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },

    async openHistory(card) {
      this.history = { def: card.def, runs: null, attempts: card.attempts };
      this.history.runs = await listRuns(card.def.name).catch(() => []);
    },

    remove(def) {
      this.removing = def;
    },

    async reallyRemove() {
      const def = this.removing;

      this.removing = null;
      if (!def) {
        return;
      }
      try {
        await deleteAgent(def.name);
        await this.refresh();
      } catch (e) {
        this.error = e.message || String(e);
      }
    },

    async showSkill(name) {
      const text = await readSkill(name).then((s) => s.content).catch(() => '');

      this.skill = { name, text: text || `There is no skill called ${ name }; the workspace may still have one.` };
    },

    firstLine(text) {
      const line = String(text || '').split('\n').find((l) => l.trim() && !l.startsWith('#!')) || '';

      return line.length > 90 ? `${ line.slice(0, 90) }…` : line;
    },

    stamp,
  },
};
</script>

<template>
  <section class="agent-cards">
    <header class="agent-cards__head">
      <p class="agent-cards__sub text-muted">
        An agent conversation or a script, and what sets it off: by hand, a schedule, an API call, a resource changing, or an <router-link :to="eventsTo()">
          event
        </router-link> - a workspace's stage moving, something happening on an issue or PR assigned to you.
      </p>
      <router-link
        :to="newTo"
        class="btn role-primary btn-sm"
        data-testid="agents-new"
      >
        New automation
      </router-link>
    </header>

    <Banner
      v-if="error"
      color="error"
      :label="error"
    />

    <div
      v-if="loaded && !agents.length"
      class="agent-cards__empty"
    >
      <p class="text-muted">
        No automations yet. A review that starts when a PR assigned to you is pushed to, a script that posts to Slack when a workspace reaches Merged, a check every morning: each is one automation.
      </p>
    </div>

    <div class="agent-cards__grid">
      <article
        v-for="card in cards"
        :key="card.def.name"
        class="agent-card"
        :class="{ 'agent-card--off': !card.def.enabled, 'agent-card--busy': card.running }"
        :data-testid="`agent-card-${ card.def.name }`"
      >
        <header class="agent-card__head">
          <div class="agent-card__ident">
            <span class="agent-card__name">
              {{ card.def.name }}
              <span
                class="agent-card__kind"
                :class="`agent-card__kind--${ card.kind }`"
              >{{ card.kind }}</span>
            </span>
            <span class="agent-card__desc">{{ card.def.description || 'No description.' }}</span>
          </div>
          <span
            class="agent-card__pill"
            :class="{ 'agent-card__pill--on': card.running, 'agent-card__pill--off': !card.def.enabled }"
          >
            <i
              v-if="card.running"
              class="icon icon-spinner icon-spin"
            />
            {{ !card.def.enabled ? 'disabled' : card.running ? `${ card.running } running` : 'idle' }}
          </span>
        </header>

        <dl class="agent-card__facts">
          <div class="agent-card__fact">
            <dt>Runs</dt>
            <dd>
              <code
                v-if="card.kind === 'script'"
                class="agent-card__prompt"
                :title="card.def.script"
              >{{ firstLine(card.def.script) || '(empty script)' }}</code>
              <button
                v-else-if="card.skill"
                type="button"
                class="agent-card__skill"
                :title="`Read the ${ card.skill } skill`"
                @click="showSkill(card.skill)"
              >/{{ card.skill }}</button>
              <span
                v-else
                class="agent-card__prompt"
                :title="card.def.prompt"
              >{{ card.def.prompt.slice(0, 90) }}{{ card.def.prompt.length > 90 ? '…' : '' }}</span>
            </dd>
          </div>
          <div class="agent-card__fact">
            <dt>When</dt>
            <dd>
              <span
                v-for="w in card.triggers"
                :key="w"
                class="agent-card__trigger"
              >{{ w }}</span>
              <code
                v-if="hasApiTrigger(card.def)"
                class="agent-card__code"
                :title="apiUrl(card.def)"
              >POST …/agents/{{ card.def.name }}/trigger</code>
            </dd>
          </div>
        </dl>

        <div class="agent-card__actions">
          <AsyncButton
            mode="apply"
            action-label="Run now"
            waiting-label="Starting"
            success-label="Started"
            size="sm"
            @click="(done) => run(card.def, done)"
          />
          <router-link
            :to="editTo(card.def)"
            class="btn role-tertiary btn-sm"
            data-testid="agent-edit"
          >
            Edit
          </router-link>
          <button
            type="button"
            class="agent-card__link agent-card__delete"
            @click="remove(card.def)"
          >
            Delete
          </button>
        </div>

        <div class="agent-card__history">
          <div class="agent-card__history-head">
            <span>Runs</span>
            <button
              type="button"
              class="agent-card__link"
              data-testid="agent-history-all"
              @click="openHistory(card)"
            >
              all runs
            </button>
          </div>
          <p
            v-if="!card.recent.length"
            class="text-muted agent-card__none"
          >
            Never run.
          </p>
          <ul
            v-else
            class="agent-card__runs"
          >
            <AgentRunRow
              v-for="r in card.recent"
              :key="r.id"
              :run="r"
              @open="runId = r.id"
            />
          </ul>

          <template v-if="card.attempts.length">
            <button
              type="button"
              class="agent-card__attempts-head"
              :aria-expanded="unfolded[card.def.name] ? 'true' : 'false'"
              data-testid="agent-attempts"
              @click="unfolded = { ...unfolded, [card.def.name]: !unfolded[card.def.name] }"
            >
              {{ unfolded[card.def.name] ? '▾' : '▸' }} Did not run on {{ card.attempts.length }} event{{ card.attempts.length === 1 ? '' : 's' }}<template v-if="card.blocked">
                · {{ card.blocked }} stopped by a constraint
              </template>
            </button>
            <ul
              v-if="unfolded[card.def.name]"
              class="agent-card__attempts"
            >
              <li
                v-for="a in card.attempts.slice(0, 12)"
                :key="a.event.id"
                class="agent-attempt"
                :class="`agent-attempt--${ a.outcome }`"
              >
                <span class="agent-attempt__when">{{ stamp(a.at) }}</span>
                <span class="agent-attempt__event">{{ a.event.name }} · {{ a.event.subject }}</span>
                <span class="agent-attempt__why">
                  <strong>{{ OUTCOME_WORDS[a.outcome] || a.outcome }}</strong>
                  <code v-if="a.condition">{{ a.condition }}</code>
                  <template v-else>{{ a.reason }}</template>
                </span>
              </li>
            </ul>
          </template>
        </div>
      </article>
    </div>

    <DevDialog
      v-if="removing"
      :title="`Delete the automation ${ removing.name }?`"
      message="Its definition, its run history and the output of its runs go; the conversations it made stay in the drawer."
      confirm-label="Delete"
      danger
      @confirm="reallyRemove"
      @cancel="removing = null"
    />
    <DevModal
      v-if="history"
      size="wide"
      :title="history.def.name"
      @close="history = null"
    >
      <template #head>
        <span class="text-muted agent-skill__note">{{ history.runs ? `${ history.runs.length } run${ history.runs.length === 1 ? '' : 's' }` : 'reading…' }}</span>
      </template>
      <ul
        class="agent-card__runs agent-card__runs--all"
        data-testid="agent-history-modal"
      >
        <AgentRunRow
          v-for="r in history.runs || []"
          :key="r.id"
          :run="r"
          @open="runId = r.id"
        />
      </ul>
      <div
        v-if="history.attempts.length"
        class="agent-card__history-attempts"
      >
        <span class="agent-card__history-head">Events that did not run it</span>
        <ul class="agent-card__attempts">
          <li
            v-for="a in history.attempts"
            :key="a.event.id"
            class="agent-attempt"
            :class="`agent-attempt--${ a.outcome }`"
          >
            <span class="agent-attempt__when">{{ stamp(a.at) }}</span>
            <span class="agent-attempt__event">{{ a.event.name }} · {{ a.event.subject }}</span>
            <span class="agent-attempt__why">
              <strong>{{ OUTCOME_WORDS[a.outcome] || a.outcome }}</strong>
              <code v-if="a.condition">{{ a.condition }}</code>
              <template v-else>{{ a.reason }}</template>
            </span>
          </li>
        </ul>
      </div>
    </DevModal>
    <DevModal
      v-if="runId"
      size="wide"
      title="Run"
      @close="runId = ''"
    >
      <RunLog
        :run-id="runId"
        @event="$router.push(eventsTo())"
      />
    </DevModal>
    <DevModal
      v-if="skill"
      size="wide"
      :title="`/${ skill.name }`"
      @close="skill = null"
    >
      <pre class="agent-skill__text">{{ skill.text }}</pre>
    </DevModal>
  </section>
</template>

<style lang="scss" scoped>
.agent-cards {
  padding: var(--dev-space-4) var(--dev-inset) 0;

  &__head {
    display:         flex;
    align-items:     flex-start;
    justify-content: space-between;
    gap:             var(--dev-space-4);
    margin-bottom:   var(--dev-space-4);
  }

  &__sub { margin: 2px 0 0; font-size: 12px; max-width: 760px; }

  &__empty {
    padding:       var(--dev-space-5);
    border:        1px dashed var(--border);
    border-radius: var(--r-sm);
    font-size:     13px;
    text-align:    center;

    p { margin: 0; }
  }

  &__grid {
    display:               grid;
    grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
    gap:                   var(--dev-space-4);
  }
}

.agent-card {
  display:        flex;
  flex-direction: column;
  border:         1px solid var(--border);
  border-radius:  var(--r-sm);
  background:     var(--body-bg);
  overflow:       hidden;
  transition:     border-color 0.15s ease;

  &:hover { border-color: color-mix(in srgb, var(--dev-accent) 55%, var(--border)); }
  &--busy { border-color: var(--dev-accent); box-shadow: 0 0 0 1px color-mix(in srgb, var(--dev-accent) 30%, transparent); }
  &--off { opacity: 0.72; }

  // The band across the top: who it is and whether it is doing anything.
  &__head {
    display:         flex;
    align-items:     flex-start;
    justify-content: space-between;
    gap:             var(--dev-space-3);
    padding:         var(--dev-space-4) var(--dev-space-4) var(--dev-space-3);
    background:      color-mix(in srgb, var(--dev-accent) 6%, transparent);
    border-bottom:   1px solid var(--border);
  }

  &__ident { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  &__name { font-size: 15px; font-weight: 600; font-family: monospace; }
  &__desc { font-size: 12px; color: var(--muted); line-height: 1.4; }

  &__pill {
    flex:           0 0 auto;
    display:        inline-flex;
    align-items:    center;
    gap:            4px;
    font-size:      10px;
    font-weight:    600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding:        2px 8px;
    border-radius: var(--r-md);
    border:         1px solid var(--border);
    color:          var(--muted);
    background:     var(--body-bg);

    &--on { color: var(--dev-accent); border-color: var(--dev-accent); }
    &--off { color: var(--warning); border-color: var(--warning); }
  }

  // Three facts, one line each, the label in the margin.
  &__facts {
    display:        flex;
    flex-direction: column;
    gap:            4px;
    margin:         0;
    padding:        var(--dev-space-3) var(--dev-space-4);
    font-size:      12px;
  }

  &__fact {
    display:               grid;
    grid-template-columns: 56px 1fr;
    gap:                   var(--dev-space-3);
    align-items:           baseline;

    dt { color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; }
    dd { margin: 0; min-width: 0; }
    code { font-size: 11px; }
  }

  &__skill {
    background:  none;
    border:      0;
    padding:     0;
    min-height:  0;
    color:       var(--link);
    font-family: monospace;
    font-size:   12px;
    cursor:      pointer;

    &:hover { text-decoration: underline; }
  }

  &__prompt { color: var(--body-text); }
  &__trigger { text-transform: none; }
  &__code { display: block; font-size: 11px; color: var(--muted); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  &__link {
    background: none;
    border:     0;
    padding:    0;
    min-height: 0;
    color:      var(--link);
    cursor:     pointer;
    font-size:  12px;

    &:hover { text-decoration: underline; }
  }

  &__delete { color: var(--error); margin-left: auto; }

  &__actions {
    display:     flex;
    align-items: center;
    gap:         var(--dev-space-3);
    padding:     0 var(--dev-space-4) var(--dev-space-3);
  }

  &__history {
    border-top: 1px solid var(--border);
    padding:    var(--dev-space-3) var(--dev-space-4) var(--dev-space-4);
    background: color-mix(in srgb, var(--body-text) 3%, transparent);
  }

  &__history-head {
    display:        flex;
    gap:            var(--dev-space-3);
    align-items:    baseline;
    font-size:      10px;
    font-weight:    600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom:  6px;

    .agent-card__link { margin-left: auto; text-transform: none; letter-spacing: 0; font-weight: 400; font-size: 11px; }
  }

  &__none { font-size: 12px; margin: 0; }

  &__runs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
  &__runs--all { overflow: auto; padding-bottom: var(--dev-space-3); }

}

@keyframes agent-pulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(0.55); opacity: 0.5; }
}

.agent-skill {
  &__note { font-size: 12px; font-weight: 400; }
  &__text { flex: 1 1 auto; margin: 0; padding: 14px; border: 0; border-radius: 0; background: transparent; overflow: auto; font-size: 12px; white-space: pre-wrap; }
}

/* ── Phones: one card per row, and a run's line drops the columns it can do without. ── */
@media (max-width: 760px) {
  .agent-cards {
    &__grid { grid-template-columns: 1fr; }

    &__head { flex-direction: column; gap: var(--dev-space-3); }
  }

  .agent-card {
    &__facts { grid-template-columns: 1fr; gap: var(--dev-space-1); }
    &__facts dt { margin-top: var(--dev-space-3); }
    &__actions { flex-wrap: wrap; }
  }
}

.agent-card__kind {
  margin-left:    6px;
  padding:        1px 6px;
  border-radius:  var(--r-sm);
  font-family:    var(--body-font, sans-serif);
  font-size:      10px;
  font-weight:    600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  vertical-align: middle;
  border:         1px solid var(--border);
  color:          var(--muted);

  &--agent { color: var(--dev-accent); border-color: color-mix(in srgb, var(--dev-accent) 50%, var(--border)); }
}

.agent-card__trigger { display: block; }

.agent-card__attempts-head {
  margin-top: 8px;
  min-height: 0;
  padding:    0;
  border:     0;
  background: none;
  color:      var(--muted);
  font-size:  12px;
  cursor:     pointer;

  &:hover { color: var(--body-text); }
}

.agent-card__attempts { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }

.agent-card__history-attempts { padding: var(--dev-space-3) var(--dev-space-4); border-top: 1px solid var(--border); }

.agent-attempt {
  display:               grid;
  grid-template-columns: 76px minmax(0, 1fr) minmax(0, 1.2fr);
  gap:                   var(--dev-space-3);
  font-size:             12px;
  align-items:           baseline;

  &__when { color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
  &__event { font-family: monospace; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  &__why { color: var(--muted); overflow-wrap: anywhere; strong { font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; margin-right: 4px; } code { color: var(--body-text); } }
  &--blocked strong { color: var(--warning); }
  &--error strong { color: var(--error); }
}

@media (max-width: 760px) {
  .agent-attempt { grid-template-columns: 1fr; gap: 0; }
}
</style>
