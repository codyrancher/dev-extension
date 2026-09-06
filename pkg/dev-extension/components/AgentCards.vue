<script>
// The agents, one card each: what it does, how it is set off, what it is doing and has done.
//
// Everything on a card is read from the agent's two ConfigMaps (agent-defs.ts) and refreshed
// on a short poll, so a run started from another dashboard, or by the API, appears here as it
// happens. Run starts a run now, whatever the trigger; the run's conversation is a link to the
// workspace it is in.
import { Banner } from '@components/Banner';
import AsyncButton from '@shell/components/AsyncButton';
import { RcButton } from '@components/RcButton';
import {
  listAgents, listRuns, runAgent, deleteAgent, skillOf
} from '../agent-defs';
import { AGENT_SEED } from '../agent-seed.generated';
import {
  DEV_PRODUCT, BLANK_CLUSTER, WORKSPACE_ROUTE, AGENT_EDIT_ROUTE, DEV_API_IN_CLUSTER
} from '../config/constants';

const REFRESH_MS = 10000;

export default {
  name: 'AgentCards',

  components: { Banner, AsyncButton, RcButton },

  data() {
    return {
      agents:  [],
      runs:    {},
      error:   '',
      timer:   null,
      loaded:  false,
      skill:   null,
      history: {},
    };
  },

  computed: {
    cards() {
      return this.agents.map((def) => {
        const runs = [...(this.runs[def.name] || [])].reverse();
        const running = runs.filter((r) => ['starting', 'running', 'requested'].includes(r.state));

        return {
          def,
          skill:   skillOf(def.prompt),
          running: running.length,
          recent:  runs.slice(0, this.history[def.name] ? 50 : 5),
          total:   runs.length,
          trigger: this.triggerLabel(def),
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
    this.timer = setInterval(() => this.refresh(), REFRESH_MS);
  },

  beforeUnmount() {
    clearInterval(this.timer);
  },

  methods: {
    async refresh() {
      try {
        const agents = await listAgents();
        const runs = {};

        await Promise.all(agents.map(async(def) => {
          runs[def.name] = await listRuns(def.name).catch(() => []);
        }));
        this.agents = agents;
        this.runs = runs;
        this.error = '';
      } catch (e) {
        this.error = e.message || String(e);
      } finally {
        this.loaded = true;
      }
    },

    triggerLabel(def) {
      const t = def.trigger || {};

      if (t.type === 'cron') {
        return `on a schedule: ${ t.cron }`;
      }
      if (t.type === 'api') {
        return 'on an API call';
      }
      if (t.type === 'resource') {
        return `when ${ t.resource?.type || 'a resource' } is ${ t.resource?.event === 'any' ? 'changed' : (t.resource?.event || 'changed') }`;
      }

      return 'by hand';
    },

    editTo(def) {
      return { name: AGENT_EDIT_ROUTE, params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER, name: def.name } };
    },

    runTo(run) {
      return run.workspace ? {
        name: WORKSPACE_ROUTE, params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER, workspace: run.workspace }, hash: '#conversations',
      } : null;
    },

    apiUrl(def) {
      return `${ DEV_API_IN_CLUSTER }/agents/${ def.name }/trigger`;
    },

    async run(def, done) {
      try {
        await runAgent(this.$store, def, 'manual');
        await this.refresh();
        done(true);
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },

    async remove(def) {
      if (!window.confirm(`Delete the agent "${ def.name }" and its run history? Its workspaces and conversations stay.`)) {
        return;
      }
      try {
        await deleteAgent(def.name);
        await this.refresh();
      } catch (e) {
        this.error = e.message || String(e);
      }
    },

    showSkill(name) {
      const text = AGENT_SEED[`skills/${ name }/SKILL.md`] || AGENT_SEED[`skills/${ name }/SKILL.md.hbs`] || '';

      this.skill = { name, text: text || `There is no skill called ${ name } in this dashboard's seed; the workspace may still have one.` };
    },

    when(iso) {
      if (!iso) {
        return '';
      }
      const d = new Date(iso);

      return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });
    },

    duration(run) {
      if (!run.startedAt) {
        return '';
      }
      const end = run.endedAt ? Date.parse(run.endedAt) : Date.now();
      const s = Math.max(0, Math.round((end - Date.parse(run.startedAt)) / 1000));

      return s < 60 ? `${ s }s` : s < 3600 ? `${ Math.round(s / 60) }m` : `${ (s / 3600).toFixed(1) }h`;
    },
  },
};
</script>

<template>
  <section class="agent-cards">
    <header class="agent-cards__head">
      <div>
        <h2 class="agent-cards__title">
          Agents
        </h2>
        <p class="agent-cards__sub text-muted">
          Conversations that start themselves: a prompt or skill, a workspace to run it in, and what sets it off.
        </p>
      </div>
      <RcButton
        variant="primary"
        size="small"
        :to="newTo"
        data-testid="agents-new"
      >
        New agent
      </RcButton>
    </header>

    <Banner
      v-if="error"
      color="error"
      :label="error"
    />

    <p
      v-if="loaded && !agents.length"
      class="agent-cards__empty text-muted"
    >
      No agents yet. Make one: a review that runs every morning on every PR that asks for you, a fix that starts when an issue is filed, a check that an API call sets off.
    </p>

    <div class="agent-cards__grid">
      <article
        v-for="card in cards"
        :key="card.def.name"
        class="agent-card"
        :class="{ 'agent-card--off': !card.def.enabled, 'agent-card--busy': card.running }"
        :data-testid="`agent-card-${ card.def.name }`"
      >
        <header class="agent-card__head">
          <span class="agent-card__name">{{ card.def.name }}</span>
          <span
            class="agent-card__badge"
            :class="{ 'agent-card__badge--on': card.running }"
          >{{ card.running ? `${ card.running } running` : 'idle' }}</span>
          <span
            v-if="!card.def.enabled"
            class="agent-card__badge agent-card__badge--off"
          >disabled</span>
        </header>
        <p class="agent-card__desc">
          {{ card.def.description || 'No description.' }}
        </p>
        <dl class="agent-card__facts">
          <dt>Runs</dt>
          <dd>
            <button
              v-if="card.skill"
              type="button"
              class="agent-card__link"
              :title="`Read the ${ card.skill } skill`"
              @click="showSkill(card.skill)"
            >/{{ card.skill }}</button>
            <span
              v-else
              class="agent-card__prompt"
              :title="card.def.prompt"
            >{{ card.def.prompt.slice(0, 80) }}{{ card.def.prompt.length > 80 ? '…' : '' }}</span>
          </dd>
          <dt>In</dt>
          <dd>{{ card.def.workspace.mode === 'new' ? `a new ${ card.def.workspace.app || 'rancher-dev' } workspace each time (${ card.def.workspace.prefix || card.def.name }-…)` : card.def.workspace.name }}</dd>
          <dt>Trigger</dt>
          <dd>
            {{ card.trigger }}
            <code
              v-if="card.def.trigger.type === 'api'"
              class="agent-card__code"
            >POST {{ apiUrl(card.def) }}</code>
          </dd>
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
          <RcButton
            variant="tertiary"
            size="small"
            :to="editTo(card.def)"
          >
            Edit
          </RcButton>
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
            <span>History</span>
            <span class="text-muted">{{ card.total }} run{{ card.total === 1 ? '' : 's' }}</span>
            <button
              v-if="card.total > 5"
              type="button"
              class="agent-card__link"
              @click="history = { ...history, [card.def.name]: !history[card.def.name] }"
            >
              {{ history[card.def.name] ? 'fewer' : 'all' }}
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
            <li
              v-for="run in card.recent"
              :key="run.id"
              class="agent-card__run"
              :class="`agent-card__run--${ run.state }`"
            >
              <span class="agent-card__run-state">{{ run.state }}</span>
              <span class="agent-card__run-when">{{ when(run.startedAt) }}</span>
              <span class="agent-card__run-trigger">{{ run.trigger }}</span>
              <router-link
                v-if="runTo(run)"
                :to="runTo(run)"
                class="agent-card__run-ws"
              >
                {{ run.workspace }}
              </router-link>
              <span class="agent-card__run-dur">{{ duration(run) }}</span>
              <span
                v-if="run.note"
                class="agent-card__run-note text-muted"
                :title="run.note"
              >{{ run.note }}</span>
            </li>
          </ul>
        </div>
      </article>
    </div>

    <Teleport to="body">
      <div
        v-if="skill"
        class="agent-skill"
        @click.self="skill = null"
      >
        <div class="agent-skill__panel">
          <header class="agent-skill__head">
            <span>/{{ skill.name }}</span>
            <button
              type="button"
              class="agent-card__link"
              @click="skill = null"
            >
              close
            </button>
          </header>
          <pre class="agent-skill__text">{{ skill.text }}</pre>
        </div>
      </div>
    </Teleport>
  </section>
</template>

<style lang="scss" scoped>
.agent-cards {
  padding: var(--dev-space-4) var(--dev-space-5) var(--dev-space-3);

  &__head {
    display:         flex;
    align-items:     flex-start;
    justify-content: space-between;
    gap:             var(--dev-space-4);
    margin-bottom:   var(--dev-space-3);
  }

  &__title { margin: 0; font-size: 18px; }
  &__sub { margin: 2px 0 0; font-size: 12px; }
  &__empty { font-size: 13px; }

  &__grid {
    display:               grid;
    grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
    gap:                   var(--dev-space-4);
  }
}

.agent-card {
  display:        flex;
  flex-direction: column;
  gap:            var(--dev-space-2);
  padding:        var(--dev-space-4);
  border:         1px solid var(--border);
  border-radius:  var(--border-radius);
  background:     var(--body-bg);

  &--busy { border-color: var(--dev-accent); }
  &--off { opacity: 0.7; }

  &__head { display: flex; align-items: center; gap: var(--dev-space-2); }
  &__name { font-weight: 600; font-size: 14px; }

  &__badge {
    font-size:      10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding:        1px 6px;
    border-radius:  10px;
    border:         1px solid var(--border);
    color:          var(--muted);

    &--on { color: var(--dev-accent); border-color: var(--dev-accent); }
    &--off { color: var(--warning); border-color: var(--warning); }
  }

  &__desc { margin: 0; font-size: 12px; color: var(--body-text); }

  &__facts {
    display:               grid;
    grid-template-columns: 56px 1fr;
    gap:                   2px var(--dev-space-3);
    margin:                0;
    font-size:             12px;

    dt { color: var(--muted); }
    dd { margin: 0; min-width: 0; }
  }

  &__code { display: block; font-size: 11px; word-break: break-all; margin-top: 2px; }
  &__prompt { color: var(--body-text); }

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

  &__actions { display: flex; align-items: center; gap: var(--dev-space-3); margin-top: var(--dev-space-1); }

  &__history { border-top: 1px solid var(--border); padding-top: var(--dev-space-2); }
  &__history-head { display: flex; gap: var(--dev-space-3); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 4px; }
  &__none { font-size: 12px; margin: 0; }

  &__runs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }

  &__run {
    display:     grid;
    grid-template-columns: 62px 96px 52px 1fr 40px;
    gap:         var(--dev-space-2);
    align-items: baseline;
    font-size:   11px;

    &--running .agent-card__run-state, &--starting .agent-card__run-state { color: var(--dev-accent); }
    &--failed .agent-card__run-state { color: var(--error); }
    &--done .agent-card__run-state { color: var(--success); }
    &--requested .agent-card__run-state { color: var(--warning); }
  }

  &__run-state { text-transform: uppercase; font-weight: 600; letter-spacing: 0.03em; }
  &__run-when, &__run-trigger, &__run-dur { color: var(--muted); }
  &__run-ws { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  &__run-note { grid-column: 1 / -1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
}

.agent-skill {
  position:        fixed;
  inset:           0;
  z-index:         3000;
  background:      rgba(0, 0, 0, 0.55);
  display:         flex;
  align-items:     center;
  justify-content: center;
  padding:         24px;

  &__panel {
    width:          min(900px, 94vw);
    height:         min(760px, 90vh);
    display:        flex;
    flex-direction: column;
    background:     var(--body-bg);
    border:         1px solid var(--border);
    border-radius:  10px;
    overflow:       hidden;
  }

  &__head { display: flex; justify-content: space-between; padding: 8px 14px; border-bottom: 1px solid var(--border); font-family: monospace; font-weight: 600; }
  &__text { flex: 1 1 auto; margin: 0; padding: 14px; overflow: auto; font-size: 12px; white-space: pre-wrap; }
}
</style>
