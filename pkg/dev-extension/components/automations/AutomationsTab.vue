<script>
/**
 * The automations, as a table like every other list here: what each is, what it does and when, how
 * its last run went, and the two things a person does to one - run it, edit it. Its name opens the
 * rest: every run, and every event that reached it without running it, with the list or the
 * constraint that stopped it.
 *
 * Definitions are read from their ConfigMaps (agent-defs.ts); runs and attempts are dev-api's,
 * watched (`/automations/status`), so a run an event, a schedule or another dashboard starts shows
 * up here as it happens.
 */
import SortableTable from '@shell/components/SortableTable';
import { Banner } from '@components/Banner';
import { RcButton } from '@components/RcButton';
import DevDialog from '../DevDialog.vue';
import DevModal from '../DevModal.vue';
import AgentRunRow from '../AgentRunRow.vue';
import RunLog from './RunLog.vue';
import SMenu from '../ui/SMenu.vue';
import '../../design/studio';
import { NarrowMixin } from '../../design/narrow';
import { narrowed } from '../../issue-table';
import {
  listAgents, listRuns, runAutomation, deleteAgent, saveAgent, skillOf, triggersOf
} from '../../agent-defs';
import { watch } from '../../events';
import {
  STATUS_PATH, OUTCOME_WORDS, stamp
} from '../../automations';
import {
  DEV_PRODUCT, BLANK_CLUSTER, AGENT_EDIT_ROUTE, DEV_API_IN_CLUSTER
} from '../../config/constants';

const HEADERS = [
  {
    name: 'state', label: 'State', value: 'stateWord', sort: ['stateWord', 'name'], width: 100
  },
  {
    name: 'name', label: 'Name', value: 'name', sort: ['name'], width: 220
  },
  { name: 'what', label: 'Does', value: 'whatText' },
  {
    name: 'last', label: 'Last run', value: 'lastMs', sort: ['lastMs:desc'], width: 260
  },
  {
    name: 'actions', label: '', align: 'right', width: 60
  },
];

const NARROW = ['state', 'name', 'what', 'last', 'actions'];

const KIND_WORDS = { agent: 'Agent', script: 'Script', review: 'Review' };

/** What the cards' Did-not-run list keeps: blocked and erroring first, they are the ones to look at. */
const ATTEMPTS_SHOWN = 30;

export default {
  name: 'AutomationsTab',

  components: {
    SortableTable, Banner, RcButton, DevDialog, DevModal, AgentRunRow, RunLog, SMenu
  },

  mixins: [NarrowMixin],

  data() {
    return {
      agents:   [],
      status:   { runs: {}, attempts: {} },
      error:    '',
      loaded:   false,
      timer:    null,
      unwatch:  null,
      /** The automation whose runs are open: its definition, every run once read, its attempts. */
      open:     null,
      runId:    '',
      removing: null,
      starting: '',
      /** The automation being switched on or off, while that is saved. */
      toggling: '',
      OUTCOME_WORDS,
      KIND_WORDS,
    };
  },

  computed: {
    headers() {
      return this.narrow ? narrowed(HEADERS, NARROW) : HEADERS;
    },

    rows() {
      return this.agents.map((def) => {
        const runs = this.status.runs?.[def.name] || [];
        const live = runs.filter((r) => ['requested', 'starting', 'running', 'waiting'].includes(r.state)).length;
        const last = runs[0] || null;
        const kind = def.action === 'script' ? 'script' : 'agent';

        return {
          key:       def.name,
          name:      def.name,
          def,
          kind,
          live,
          last,
          lastMs:    last ? Date.parse(last.startedAt) || 0 : 0,
          stateWord: def.enabled === false ? 'off' : live ? 'running' : 'on',
          triggers:  this.triggerWords(def),
          does:      this.doesWords(def, kind),
          whatText:  `${ def.description || '' } ${ this.doesWords(def, kind) }`,
          attempts:  this.status.attempts?.[def.name] || [],
        };
      });
    },
  },

  async fetch() {
    await this.refresh();
  },

  mounted() {
    this.timer = setInterval(() => this.refresh(), 15000);
    this.unwatch = watch(STATUS_PATH, (value) => {
      this.status = value || { runs: {}, attempts: {} };
    }, { every: 5000 });
  },

  beforeUnmount() {
    clearInterval(this.timer);
    this.unwatch?.();
  },

  methods: {
    stamp,

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

    /** What it does, in a phrase: the skill or the start of the prompt, or the script's first line. */
    doesWords(def, kind) {
      if (kind === 'script') {
        const line = String(def.script || '').split('\n').find((l) => l.trim() && !l.startsWith('#')) || 'a script';

        return line.length > 70 ? `${ line.slice(0, 70) }…` : line;
      }
      const skill = skillOf(def.prompt);

      if (skill) {
        return `/${ skill }`;
      }

      return def.prompt.length > 70 ? `${ def.prompt.slice(0, 70) }…` : def.prompt;
    },

    /** Each trigger as a short phrase. By hand is always there and so goes unsaid. */
    triggerWords(def) {
      const words = [];

      for (const t of triggersOf(def)) {
        if (t.type === 'cron') {
          words.push(`at ${ t.cron } (${ def.tz || 'UTC' })`);
        } else if (t.type === 'api') {
          words.push('on an API call');
        } else if (t.type === 'resource') {
          words.push(`when a ${ t.resource?.type || 'resource' } is ${ t.resource?.event === 'any' ? 'changed' : (t.resource?.event || 'changed') }`);
        } else if (t.type === 'event') {
          const e = t.event || {};
          const names = e.names?.length ? e.names.join(', ') : 'any event';
          const repos = e.repos?.length ? ` in ${ e.repos.join(', ') }` : '';
          const authors = e.authors?.length ? ` by ${ e.authors.map((a) => `@${ String(a).replace(/^@/, '') }`).join(', ') }` : '';

          words.push(`on ${ names }${ repos }${ authors }`);
        }
      }

      return words.length ? words : ['by hand only'];
    },

    editTo(name, template = '') {
      return {
        name: AGENT_EDIT_ROUTE, params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER, ...(name ? { name } : {}) }, query: template ? { template } : {},
      };
    },

    apiUrl(def) {
      return `${ DEV_API_IN_CLUSTER }/agents/${ def.name }/trigger`;
    },

    hasApiTrigger(def) {
      return triggersOf(def).some((t) => t.type === 'api');
    },

    async run(row) {
      this.starting = row.name;
      this.error = '';
      try {
        const run = await runAutomation(row.name, { trigger: 'manual' });

        this.runId = run?.id || '';
      } catch (e) {
        this.error = e.message || String(e);
      } finally {
        this.starting = '';
      }
    },

    /** A row's menu: what can be done to one automation, the delete set apart at the end. */
    rowMenu(row) {
      const on = row.def.enabled !== false;

      return [
        {
          id: 'run', label: this.starting === row.name ? 'Starting…' : 'Run now', icon: 'play', disabled: this.starting === row.name,
        },
        { id: 'edit', label: 'Edit', icon: 'edit' },
        {
          id: 'toggle', label: on ? 'Disable' : 'Enable', icon: on ? 'stop' : 'check', disabled: this.toggling === row.name,
        },
        { divider: true },
        {
          id: 'delete', label: 'Delete', icon: 'trash', danger: true,
        },
      ];
    },

    onRowMenu(row, id) {
      if (id === 'run') {
        this.run(row);
      } else if (id === 'edit') {
        this.$router.push(this.editTo(row.name));
      } else if (id === 'toggle') {
        this.setEnabled(row, row.def.enabled === false);
      } else if (id === 'delete') {
        this.removing = row.def;
      }
    },

    /** On or off, saved back as it is otherwise; an automation that is off listens to nothing. */
    async setEnabled(row, enabled) {
      this.toggling = row.name;
      this.error = '';
      try {
        await saveAgent({ ...row.def, enabled });
        await this.refresh();
      } catch (e) {
        this.error = e.message || String(e);
      } finally {
        this.toggling = '';
      }
    },

    async show(row) {
      this.open = {
        def: row.def, kind: row.kind, triggers: row.triggers, attempts: row.attempts.slice(0, ATTEMPTS_SHOWN), runs: null
      };
      this.open.runs = await listRuns(row.name).catch(() => []);
    },

    async reallyRemove() {
      const def = this.removing;

      this.removing = null;
      this.open = null;
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

    lastWords(run) {
      if (!run) {
        return '';
      }

      return [stamp(run.startedAt), run.result || run.note || ''].filter(Boolean).join(' · ');
    },
  },
};
</script>

<template>
  <div
    class="autos"
    data-testid="automations-list"
  >
    <Banner
      v-if="error"
      color="error"
      :label="error"
      :closable="true"
      @close="error = ''"
    />

    <!-- Ready-made: the one that is asked for most, set up and waiting for its lists. -->
    <div class="autos__templates">
      <span class="autos__label">Start from</span>
      <router-link
        :to="editTo('', 'review-requests')"
        class="autos__template"
        data-testid="automation-template-review"
      >
        Review PRs I'm asked to review
      </router-link>
      <router-link
        :to="editTo('', 'review-new-commits')"
        class="autos__template"
        data-testid="automation-template-review-again"
      >
        Review new commits when I'm asked again
      </router-link>
      <router-link
        :to="editTo('', 'address-feedback')"
        class="autos__template"
        data-testid="automation-template-address-feedback"
      >
        Address feedback when a review asks for changes
      </router-link>
      <router-link
        :to="editTo('', 'stage-script')"
        class="autos__template"
      >
        Run a script when a workspace changes stage
      </router-link>
    </div>

    <SortableTable
      :headers="headers"
      :rows="rows"
      key-field="key"
      :table-actions="false"
      :row-actions="false"
      :search="rows.length > 8"
      :paging="rows.length > 20"
      :rows-per-page="20"
      :loading="!loaded"
      default-sort-by="name"
    >
      <template #no-rows>
        <tr>
          <td :colspan="headers.length">
            <p class="text-muted autos__empty">
              No automations yet. A review that starts when you are asked for one, a script that posts somewhere when a workspace reaches Merged, a check every morning: each is one automation.
            </p>
          </td>
        </tr>
      </template>

      <template #cell:state="{ row }">
        <span
          class="autos__state"
          :class="`autos__state--${ row.stateWord }`"
        >
          <span class="autos__dot" />
          {{ row.stateWord === 'running' ? `${ row.live } running` : row.stateWord }}
        </span>
      </template>
      <template #cell:name="{ row }">
        <a
          href="#"
          class="autos__name"
          :data-testid="`agent-card-${ row.name }`"
          @click.prevent="show(row)"
        >{{ row.name }}</a>
        <span
          class="autos__kind"
          :class="`autos__kind--${ row.kind }`"
        >{{ KIND_WORDS[row.kind] }}</span>
      </template>
      <template #cell:what="{ row }">
        <div class="autos__what">
          <span v-if="row.def.description">{{ row.def.description }}</span>
          <span class="autos__does">{{ row.does }}</span>
          <span
            v-for="w in row.triggers"
            :key="w"
            class="autos__when"
          >{{ w }}</span>
        </div>
      </template>
      <template #cell:last="{ row }">
        <a
          v-if="row.last"
          href="#"
          class="autos__last"
          :class="`autos__last--${ row.last.state }`"
          :title="row.last.result || row.last.note || ''"
          @click.prevent="runId = row.last.id"
        >
          <span class="autos__last-state">{{ row.last.state === 'requested' ? 'queued' : row.last.state }}</span>
          {{ lastWords(row.last) }}
        </a>
        <span
          v-else
          class="text-muted"
        >never run</span>
      </template>
      <template #cell:actions="{ row }">
        <div class="autos__actions">
          <SMenu
            :items="rowMenu(row)"
            :aria-label="`Actions for ${ row.name }`"
            data-testid="automation-actions"
            @select="onRowMenu(row, $event)"
          >
            <template #trigger>
              <i class="icon icon-actions" />
            </template>
          </SMenu>
        </div>
      </template>
    </SortableTable>

    <DevModal
      v-if="open"
      size="wide"
      :title="open.def.name"
      @close="open = null"
    >
      <template #head>
        <span class="text-muted autos__modal-note">{{ KIND_WORDS[open.kind] }} &middot; {{ open.triggers.join(' · ') }}</span>
      </template>
      <div
        class="autos__detail"
        data-testid="agent-history-modal"
      >
        <p
          v-if="open.def.description"
          class="autos__desc"
        >
          {{ open.def.description }}
        </p>
        <p
          v-if="hasApiTrigger(open.def)"
          class="text-muted autos__api"
        >
          From inside the cluster: <code>POST {{ apiUrl(open.def) }}</code>
        </p>

        <h4>Runs <span class="text-muted">{{ open.runs ? open.runs.length : '…' }}</span></h4>
        <p
          v-if="open.runs && !open.runs.length"
          class="text-muted autos__none"
        >
          Never run.
        </p>
        <ul
          v-else
          class="autos__runs"
        >
          <AgentRunRow
            v-for="r in open.runs || []"
            :key="r.id"
            :run="r"
            @open="runId = r.id"
          />
        </ul>

        <h4>Did not run on <span class="text-muted">{{ open.attempts.length }}</span></h4>
        <p
          v-if="!open.attempts.length"
          class="text-muted autos__none"
        >
          Every event it listens to has run it.
        </p>
        <ul
          v-else
          class="autos__attempts"
        >
          <li
            v-for="a in open.attempts"
            :key="a.event.id"
            class="autos__attempt"
          >
            <span class="autos__attempt-when">{{ stamp(a.at) }}</span>
            <span class="autos__attempt-event">{{ a.event.name }} &middot; {{ a.event.subject }}</span>
            <span
              class="autos__attempt-why"
              :class="`autos__attempt-why--${ a.outcome }`"
            >
              <strong>{{ OUTCOME_WORDS[a.outcome] || a.outcome }}</strong>
              <code v-if="a.condition">{{ a.condition }}</code>
              <template v-else>{{ a.reason }}</template>
            </span>
          </li>
        </ul>

        <div class="autos__detail-actions">
          <RcButton
            variant="tertiary"
            size="small"
            @click="$router.push(editTo(open.def.name))"
          >
            Edit
          </RcButton>
          <RcButton
            variant="tertiary"
            size="small"
            class="autos__delete"
            @click="removing = open.def"
          >
            Delete
          </RcButton>
        </div>
      </div>
    </DevModal>

    <DevModal
      v-if="runId"
      size="wide"
      title="Run"
      @close="runId = ''"
    >
      <RunLog :run-id="runId" />
    </DevModal>

    <DevDialog
      v-if="removing"
      :title="`Delete the automation ${ removing.name }?`"
      message="Its definition, its run history and the output of its runs go; the conversations and workspaces it made stay."
      confirm-label="Delete"
      danger
      @confirm="reallyRemove"
      @cancel="removing = null"
    />
  </div>
</template>

<style lang="scss" scoped>
.autos {
  display:        flex;
  flex-direction: column;
  gap:            var(--dev-space-3);

  &__label {
    color:          var(--muted);
    font-size:      11px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  &__templates {
    display:     flex;
    flex-wrap:   wrap;
    align-items: center;
    gap:         var(--dev-space-2) var(--dev-space-4);
    font-size:   13px;
  }

  &__template { white-space: nowrap; }

  &__empty { margin: var(--dev-space-3) 0; white-space: normal; }

  &__state {
    display:        inline-flex;
    align-items:    center;
    gap:            var(--dev-space-2);
    font-size:      12px;
    text-transform: capitalize;
    color:          var(--muted);

    &--running { color: var(--dev-accent); }
    &--on { color: var(--success); }
  }

  &__dot {
    width:         8px;
    height:        8px;
    border-radius: 50%;
    background:    currentColor;
  }

  &__state--running &__dot { animation: autos-pulse 1.4s infinite ease-in-out; }

  &__name { font-family: monospace; font-weight: 600; margin-right: var(--dev-space-2); }

  &__kind {
    display:        inline-block;
    padding:        0 6px;
    border:         1px solid var(--border);
    border-radius:  var(--r-sm, 4px);
    font-size:      10px;
    font-weight:    600;
    line-height:    16px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color:          var(--muted);

    &--agent, &--review { color: var(--dev-accent); border-color: color-mix(in srgb, var(--dev-accent) 50%, var(--border)); }
  }

  &__what {
    display:        flex;
    flex-direction: column;
    gap:            2px;
    min-width:      0;
  }

  &__does { font-family: monospace; font-size: 12px; overflow-wrap: anywhere; }
  &__when { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }

  &__last {
    color:           var(--body-text);
    text-decoration: none;
    overflow-wrap:   anywhere;

    &:hover { text-decoration: underline; }
  }

  &__last-state {
    margin-right:   var(--dev-space-1);
    font-size:      10px;
    font-weight:    600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color:          var(--muted);
  }

  &__last--done &__last-state { color: var(--success); }
  &__last--failed &__last-state { color: var(--error); }
  &__last--running &__last-state, &__last--starting &__last-state { color: var(--dev-accent); }
  &__last--waiting &__last-state, &__last--requested &__last-state { color: var(--warning); }

  &__actions {
    display:         flex;
    justify-content: flex-end;

    // Rancher's row action button: a bordered square holding the three dots.
    :deep(.s-menu__trigger) {
      justify-content: center;
      width:           32px;
      height:          32px;
      padding:         0;
      border:          1px solid var(--border);
      border-radius:   var(--border-radius);
      color:           var(--body-text);

      &:hover, &.s-menu__trigger--open { border-color: var(--primary); color: var(--primary); }
    }
  }

  &__modal-note { font-size: 12px; font-weight: 400; }

  &__detail {
    display:        flex;
    flex-direction: column;
    gap:            var(--dev-space-3);
    padding:        var(--dev-space-4);
    overflow:       auto;

    h4 { margin: var(--dev-space-2) 0 0; font-size: 13px; span { font-weight: 400; margin-left: var(--dev-space-2); } }
  }

  &__desc, &__api, &__none { margin: 0; }
  &__api code { border: 0; padding: 0; }

  &__runs { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--r-sm, 4px); }

  &__attempts { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--dev-space-2); }

  &__attempt {
    display:               grid;
    grid-template-columns: 90px minmax(0, 1fr) minmax(0, 1.3fr);
    gap:                   var(--dev-space-3);
    align-items:           baseline;
    font-size:             12px;
  }

  &__attempt-when { color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
  &__attempt-event { font-family: monospace; overflow-wrap: anywhere; }

  &__attempt-why {
    color:         var(--muted);
    overflow-wrap: anywhere;

    strong { margin-right: var(--dev-space-1); font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase; }
    code { border: 0; padding: 0 2px; color: var(--body-text); }

    &--blocked strong, &--throttled strong { color: var(--warning); }
    &--error strong { color: var(--error); }
  }

  &__detail-actions {
    display:     flex;
    gap:         var(--dev-space-2);
    padding-top: var(--dev-space-3);
    border-top:  1px solid var(--border);
  }

  &__delete { margin-left: auto; color: var(--error); }
}

@keyframes autos-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

@media (max-width: 760px) {
  .autos__attempt { grid-template-columns: 1fr; gap: 0; }
  .autos__actions { justify-content: flex-start; }
}
</style>
