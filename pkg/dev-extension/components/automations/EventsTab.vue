<script>
/**
 * The events log: everything dev-api has recorded, newest first, and what each did.
 *
 * A table like every other list in this product - SortableTable, which design/mobile.css turns into
 * one card per row on a phone - with the columns ordered for that card: where it came from and what
 * happened on the first line, what it is about on the second, then when, by whom, and what it set
 * off. A row opens into the whole event: its payload, which is what a constraint reads, and every
 * automation that listens to it with what happened there - it ran, or the list or the constraint
 * that stopped it.
 *
 * Muting a workspace hides its events here and keeps them from starting anything; they are still
 * recorded, and Show muted brings them back.
 */
import SortableTable from '@shell/components/SortableTable';
import { Banner } from '@components/Banner';
import { Checkbox } from '@components/Form/Checkbox';
import { RcButton } from '@components/RcButton';
import DevModal from '../DevModal.vue';
import RunLog from './RunLog.vue';
import { watch } from '../../events';
import { NarrowMixin } from '../../design/narrow';
import { narrowed } from '../../issue-table';
import {
  EVENTS_PATH, readEvent, setMutes, near, stamp, OUTCOME_WORDS
} from '../../automations';
import { listAgents, runAutomation } from '../../agent-defs';
import {
  DEV_PRODUCT, BLANK_CLUSTER, WORKSPACE_ROUTE
} from '../../config/constants';

const HEADERS = [
  {
    name: 'source', label: 'Source', value: 'source', sort: ['source', 'atMs:desc'], width: 100
  },
  {
    name: 'event', label: 'Event', value: 'name', sort: ['name', 'atMs:desc'], width: 190
  },
  {
    name: 'about', label: 'About', value: 'aboutText', sort: ['subject', 'atMs:desc']
  },
  {
    name: 'at', label: 'When', value: 'atMs', sort: ['atMs:desc'], width: 120
  },
  {
    name: 'by', label: 'By', value: 'actor', sort: ['actor', 'atMs:desc'], width: 130
  },
  {
    name: 'workspace', label: 'Workspace', value: 'workspace', sort: ['workspace', 'atMs:desc'], width: 150
  },
  {
    name: 'automations', label: 'Automations', value: 'outcomeText', width: 230
  },
];

/** What a phone keeps: the card's first line, what it is about, when, and what it set off. */
const NARROW = ['source', 'event', 'about', 'at', 'automations'];

const SOURCES = [
  { value: '', label: 'Every source' },
  { value: 'github', label: 'GitHub' },
  { value: 'workspace', label: 'Workspaces' },
];

export default {
  name: 'EventsTab',

  components: {
    SortableTable, Banner, Checkbox, RcButton, DevModal, RunLog
  },

  mixins: [NarrowMixin],

  emits: ['status'],

  data() {
    return {
      data:        null,
      now:         Date.now(),
      source:      '',
      showMuted:   false,
      onlyMatched: false,
      /** The event whose whole is open, with its payload once read, or null. */
      open:        null,
      runId:       '',
      error:       '',
      muteDraft:   '',
      defs:        [],
      runOn:       '',
      starting:    false,
      unwatch:     null,
      clock:       null,
      SOURCES,
      OUTCOME_WORDS,
    };
  },

  computed: {
    headers() {
      return this.narrow ? narrowed(HEADERS, NARROW) : HEADERS;
    },

    events() {
      return this.data?.events || [];
    },

    mutes() {
      return this.data?.mutes || [];
    },

    mutedCount() {
      return this.events.filter((e) => e.muted).length;
    },

    rows() {
      return this.events
        .filter((e) => (this.showMuted || !e.muted) && (!this.source || e.source === this.source) && (!this.onlyMatched || e.matches?.length))
        .map((e) => ({
          ...e,
          key:         e.id,
          atMs:        Date.parse(e.at) || 0,
          aboutText:   `${ e.subject } ${ e.title }`,
          outcomeText: (e.matches || []).map((m) => `${ m.automation } ${ OUTCOME_WORDS[m.outcome] || m.outcome }`).join(' '),
        }));
    },

    /** Workspaces the log has seen, for the mute picker, the noisiest first. */
    knownWorkspaces() {
      const counts = new Map();

      for (const e of this.events) {
        if (e.workspace && !this.mutes.includes(e.workspace)) {
          counts.set(e.workspace, (counts.get(e.workspace) || 0) + 1);
        }
      }

      return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n }));
    },

    github() {
      return this.data?.sources?.github || {};
    },

    stages() {
      return this.data?.sources?.workspace || {};
    },

    /** What GitHub is being read for, in the words My Work uses for the same sets. */
    githubSets() {
      const c = this.github.counts || {};
      const sets = [
        [c.assigned, 'assigned'], [c.requested, 'asked to review'], [c.reviewed, 'reviewed'], [c.authored, 'yours'],
      ].filter(([n]) => typeof n === 'number');

      return sets.map(([n, word]) => `${ n } ${ word }`).join(' · ');
    },

    /** The GitHub line, as one string so it wraps like a sentence rather than in pieces. */
    githubLine() {
      const g = this.github;
      const when = !g.at ? 'not read yet' : [g.ok === false ? `failed ${ near(g.at, this.now) }` : `read ${ near(g.at, this.now) }`, g.next ? `next ${ near(g.next, this.now) }` : ''].filter(Boolean).join(', ');

      return [g.login ? `@${ g.login }` : '', this.githubSets, when].filter(Boolean).join(' · ');
    },

    /** The automations a person might run on the open event, for trying one out on it. */
    runnable() {
      return this.defs.filter((d) => d.action !== 'review' || this.open?.event?.payload?.kind === 'pr');
    },
  },

  mounted() {
    this.unwatch = watch(EVENTS_PATH, (value) => {
      this.data = value;
      this.$emit('status', value);
    }, { every: 5000 });
    this.clock = setInterval(() => {
      this.now = Date.now();
    }, 15000);
  },

  beforeUnmount() {
    this.unwatch?.();
    clearInterval(this.clock);
  },

  methods: {
    stamp,

    workspaceTo(name) {
      return { name: WORKSPACE_ROUTE, params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER, workspace: name } };
    },

    async show(row) {
      const summary = this.events.find((e) => e.id === row.id) || row;

      this.open = { summary, event: null, error: '' };
      this.runOn = '';
      listAgents().then((defs) => {
        this.defs = defs;
      }).catch(() => {});
      try {
        const event = await readEvent(row.id);

        if (this.open?.summary.id === row.id) {
          this.open = { ...this.open, event };
        }
      } catch (e) {
        if (this.open?.summary.id === row.id) {
          this.open = { ...this.open, error: e.message || String(e) };
        }
      }
    },

    async changeMutes(next) {
      this.error = '';
      try {
        const saved = await setMutes(next);

        if (this.data) {
          this.data = {
            ...this.data, mutes: saved, events: this.data.events.map((e) => ({ ...e, muted: !!e.workspace && saved.includes(e.workspace) })),
          };
        }
      } catch (e) {
        this.error = e.message || String(e);
      }
    },

    mute(name) {
      if (name && !this.mutes.includes(name)) {
        this.changeMutes([...this.mutes, name]);
      }
      this.muteDraft = '';
    },

    unmute(name) {
      this.changeMutes(this.mutes.filter((m) => m !== name));
    },

    /** Run an automation on the open event, by hand: constraints are not checked, this is the person. */
    async runOnOpen() {
      if (!this.runOn || !this.open) {
        return;
      }
      this.starting = true;
      try {
        const run = await runAutomation(this.runOn, { eventId: this.open.summary.id });

        this.open = null;
        this.runId = run?.id || '';
      } catch (e) {
        this.open = { ...this.open, error: e.message || String(e) };
      } finally {
        this.starting = false;
      }
    },

    /** From a run back to the event that started it. */
    focusEvent(id) {
      this.runId = '';
      const e = this.events.find((x) => x.id === id);

      if (e) {
        this.show(e);
      }
    },

    whyText(m) {
      if (m.outcome === 'run') {
        return '';
      }
      if (m.condition && m.outcome === 'blocked') {
        return `was ${ String(m.reason).split(' was ').pop() }`;
      }
      if (m.condition && m.outcome === 'error') {
        return String(m.reason).replace(m.condition, '').trim();
      }

      return m.reason;
    },
  },
};
</script>

<template>
  <div
    class="events"
    data-testid="automation-events"
  >
    <!-- What each source is doing, the way My Work's header says whose work it is reading. -->
    <div class="events__sources">
      <span
        class="events__source"
        :class="{ 'events__source--bad': github.ok === false }"
        :title="github.error || 'Read every three minutes: GitHub has no push channel for this short of a webhook on every repository.'"
      >
        <span class="events__dot" />
        <strong>GitHub</strong>
        <span>{{ githubLine }}</span>
      </span>
      <span
        class="events__source"
        :class="{ 'events__source--live': stages.live, 'events__source--bad': !stages.live && stages.error }"
        :title="stages.live ? 'Watched: a stage change is recorded the moment it is stored.' : (stages.error || '')"
      >
        <span class="events__dot" />
        <strong>Stages</strong>
        <span>{{ stages.live ? 'live' : 'read every minute' }}</span>
      </span>
    </div>

    <Banner
      v-if="github.ok === false"
      color="warning"
      :label="`GitHub could not be read: ${ github.error }`"
    />
    <Banner
      v-if="error"
      color="error"
      :label="error"
      :closable="true"
      @close="error = ''"
    />

    <div
      v-if="mutes.length"
      class="events__mutes"
    >
      <span class="events__label">Muted</span>
      <span
        v-for="m in mutes"
        :key="m"
        class="events__muted"
      >
        {{ m }}
        <a
          href="#"
          class="events__unmute"
          :aria-label="`Unmute ${ m }`"
          title="Unmute"
          @click.prevent="unmute(m)"
        >&times;</a>
      </span>
    </div>

    <SortableTable
      class="events__table"
      :headers="headers"
      :rows="rows"
      key-field="key"
      :table-actions="false"
      :row-actions="false"
      :search="true"
      :paging="true"
      :rows-per-page="20"
      :loading="!data"
      default-sort-by="at"
    >
      <template #header-left>
        <div class="events__filters">
          <select
            v-model="source"
            class="events__select"
            aria-label="Source"
          >
            <option
              v-for="s in SOURCES"
              :key="s.value"
              :value="s.value"
            >
              {{ s.label }}
            </option>
          </select>
          <select
            v-if="knownWorkspaces.length"
            v-model="muteDraft"
            class="events__select"
            aria-label="Mute a workspace"
            data-testid="automation-mute-pick"
            @change="mute(muteDraft)"
          >
            <option value="">
              Mute a workspace&hellip;
            </option>
            <option
              v-for="w in knownWorkspaces"
              :key="w.name"
              :value="w.name"
            >
              {{ w.name }} ({{ w.n }})
            </option>
          </select>
          <Checkbox
            v-model:value="onlyMatched"
            label="With automations"
          />
          <Checkbox
            v-model:value="showMuted"
            :label="mutedCount ? `Show muted (${ mutedCount })` : 'Show muted'"
          />
        </div>
      </template>

      <template #no-rows>
        <tr>
          <td :colspan="headers.length">
            <p class="text-muted events__empty">
              Nothing recorded yet. The first read of GitHub is the baseline - what you are already part of - and only changes after it are events. A stage moving is one at once.
            </p>
          </td>
        </tr>
      </template>

      <template #cell:source="{ row }">
        <span
          class="events__badge"
          :class="`events__badge--${ row.source }`"
        >{{ row.source === 'workspace' ? 'Stage' : 'GitHub' }}</span>
      </template>
      <template #cell:event="{ row }">
        <span class="events__name">{{ row.name }}</span>
      </template>
      <template #cell:about="{ row }">
        <a
          href="#"
          class="events__about"
          :class="{ 'events__about--muted': row.muted }"
          :data-testid="`automation-event-${ row.id }`"
          @click.prevent="show(row)"
        >
          <span class="events__subject">{{ row.subject }}</span>
          <span class="events__title">{{ row.title }}</span>
        </a>
      </template>
      <template #cell:at="{ row }">
        <time
          class="events__when"
          :datetime="row.at"
          :title="row.at"
        >{{ stamp(row.at) }}</time>
      </template>
      <template #cell:by="{ row }">
        <span
          v-if="row.actor"
          :class="{ 'events__me': row.self }"
        >{{ row.self ? 'you' : `@${ row.actor }` }}</span>
        <span
          v-else
          class="text-muted"
        >&ndash;</span>
      </template>
      <template #cell:workspace="{ row }">
        <router-link
          v-if="row.workspace"
          :to="workspaceTo(row.workspace)"
          class="events__ws"
        >
          {{ row.workspace }}
        </router-link>
        <span
          v-else
          class="text-muted"
        >&ndash;</span>
      </template>
      <template #cell:automations="{ row }">
        <span
          v-if="!row.matches || !row.matches.length"
          class="text-muted"
        >none listening</span>
        <span
          v-else
          class="events__outcomes"
        >
          <span
            v-for="m in row.matches"
            :key="m.automation"
            class="events__outcome"
            :class="`events__outcome--${ m.outcome }`"
            :title="m.reason || `${ m.automation } ran`"
          >{{ m.automation }} {{ OUTCOME_WORDS[m.outcome] || m.outcome }}</span>
        </span>
      </template>
    </SortableTable>

    <DevModal
      v-if="open"
      size="medium"
      :title="open.summary.name"
      @close="open = null"
    >
      <div
        class="event"
        data-testid="automation-event-detail"
      >
        <p class="event__about">
          <span class="events__subject">{{ open.summary.subject }}</span>
          {{ open.summary.title }}
        </p>
        <dl class="event__facts">
          <div>
            <dt>When</dt>
            <dd>{{ stamp(open.summary.at) }}</dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>{{ open.summary.source === 'workspace' ? 'Workspace stage' : 'GitHub' }}</dd>
          </div>
          <div v-if="open.summary.actor">
            <dt>By</dt>
            <dd>{{ open.summary.self ? 'you' : `@${ open.summary.actor }` }}</dd>
          </div>
          <div v-if="open.summary.workspace">
            <dt>Workspace</dt>
            <dd>
              <router-link :to="workspaceTo(open.summary.workspace)">
                {{ open.summary.workspace }}
              </router-link>
            </dd>
          </div>
        </dl>
        <div class="event__links">
          <a
            v-if="open.summary.url"
            :href="open.summary.url"
            target="_blank"
            rel="noopener noreferrer"
          >Open on GitHub</a>
          <a
            v-if="open.summary.workspace && !mutes.includes(open.summary.workspace)"
            href="#"
            @click.prevent="mute(open.summary.workspace)"
          >Mute {{ open.summary.workspace }}</a>
          <a
            v-else-if="open.summary.workspace"
            href="#"
            @click.prevent="unmute(open.summary.workspace)"
          >Unmute {{ open.summary.workspace }}</a>
        </div>

        <h4>Automations</h4>
        <p
          v-if="!open.summary.matches || !open.summary.matches.length"
          class="text-muted event__none"
        >
          No automation listens to {{ open.summary.name }}.
        </p>
        <ul
          v-else
          class="event__evals"
        >
          <li
            v-for="m in open.summary.matches"
            :key="m.automation"
            class="event__eval"
          >
            <span
              class="events__outcome"
              :class="`events__outcome--${ m.outcome }`"
            >{{ OUTCOME_WORDS[m.outcome] || m.outcome }}</span>
            <strong>{{ m.automation }}</strong>
            <a
              v-if="m.runId"
              href="#"
              @click.prevent="open = null; runId = m.runId"
            >See the run</a>
            <span
              v-else
              class="event__why"
            >
              <code v-if="m.condition">{{ m.condition }}</code>
              {{ whyText(m) }}
            </span>
          </li>
        </ul>

        <div
          v-if="runnable.length"
          class="event__try"
        >
          <select
            v-model="runOn"
            class="events__select"
            aria-label="Automation to run on this event"
          >
            <option value="">
              Run an automation on this&hellip;
            </option>
            <option
              v-for="d in runnable"
              :key="d.name"
              :value="d.name"
            >
              {{ d.name }}
            </option>
          </select>
          <RcButton
            variant="secondary"
            size="small"
            :disabled="!runOn || starting"
            @click="runOnOpen"
          >
            {{ starting ? 'Starting' : 'Run it' }}
          </RcButton>
        </div>

        <p
          v-if="open.error"
          class="event__error"
        >
          {{ open.error }}
        </p>

        <h4>Payload <span class="text-muted event__hint">what a constraint reads as <code>payload</code> or <code>p</code></span></h4>
        <pre class="event__payload">{{ open.event ? JSON.stringify(open.event.payload, null, 2) : 'Reading…' }}</pre>
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
        @event="focusEvent"
      />
    </DevModal>
  </div>
</template>

<style lang="scss" scoped>
.events {
  display:        flex;
  flex-direction: column;
  gap:            var(--dev-space-3);

  &__sources {
    display:   flex;
    flex-wrap: wrap;
    gap:       var(--dev-space-2) var(--dev-space-5);
    color:     var(--muted);
    font-size: 13px;
  }

  &__source {
    display:     inline-flex;
    align-items: baseline;
    gap:         var(--dev-space-2);
    min-width:   0;

    strong { color: var(--body-text); font-weight: 600; }
  }

  &__dot {
    flex:          0 0 auto;
    width:         8px;
    height:        8px;
    border-radius: 50%;
    background:    var(--success);
  }

  &__source--live &__dot { box-shadow: 0 0 0 3px color-mix(in srgb, var(--success) 25%, transparent); }
  &__source--bad &__dot { background: var(--error); }

  &__mutes {
    display:     flex;
    flex-wrap:   wrap;
    align-items: center;
    gap:         var(--dev-space-2);
    font-size:   13px;
  }

  &__label {
    color:          var(--muted);
    font-size:      11px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  &__muted {
    display:       inline-flex;
    align-items:   center;
    gap:           var(--dev-space-1);
    padding:       0 var(--dev-space-1) 0 var(--dev-space-2);
    border:        1px solid var(--border);
    border-radius: var(--r-md, 12px);
    font-family:   monospace;
    font-size:     12px;
  }

  &__unmute { padding: 0 4px; color: var(--muted); text-decoration: none; &:hover { color: var(--error); } }

  &__select {
    width:         auto;
    max-width:     100%;
    min-height:    0;
    padding:       4px 8px;
    font-size:     13px;
    color:         var(--input-text);
    background:    var(--input-bg);
    border:        1px solid var(--border);
    border-radius: var(--dev-r-ctl, 4px);
  }

  &__filters {
    display:     flex;
    flex-wrap:   wrap;
    align-items: center;
    gap:         var(--dev-space-2) var(--dev-space-4);
  }

  &__empty { margin: var(--dev-space-3) 0; white-space: normal; }

  &__badge {
    display:        inline-block;
    padding:        0 6px;
    border:         1px solid var(--border);
    border-radius:  var(--r-sm, 4px);
    font-size:      11px;
    font-weight:    600;
    line-height:    18px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color:          var(--muted);

    &--workspace { color: var(--dev-accent); border-color: color-mix(in srgb, var(--dev-accent) 50%, var(--border)); }
  }

  &__name { font-family: monospace; font-size: 12px; }

  &__about {
    display:         flex;
    flex-wrap:       wrap;
    gap:             0 var(--dev-space-2);
    color:           var(--body-text);
    text-decoration: none;

    &:hover .events__title { text-decoration: underline; }
    &--muted { opacity: 0.55; }
  }

  &__subject { font-family: monospace; font-size: 12px; color: var(--muted); }
  &__title { min-width: 0; overflow-wrap: anywhere; }
  &__when { font-variant-numeric: tabular-nums; white-space: nowrap; color: var(--muted); }
  &__me { color: var(--dev-accent); }
  &__ws { font-family: monospace; font-size: 12px; }

  &__outcomes { display: inline-flex; flex-wrap: wrap; gap: 4px; }

  &__outcome {
    padding:       0 7px;
    border:        1px solid var(--border);
    border-radius: var(--r-md, 12px);
    font-size:     11px;
    line-height:   18px;
    white-space:   nowrap;

    &--run { color: var(--success); border-color: var(--success); }
    &--blocked, &--throttled { color: var(--warning); border-color: var(--warning); }
    &--error { color: var(--error); border-color: var(--error); }
    &--disabled, &--muted { color: var(--muted); }
  }
}

.event {
  display:        flex;
  flex-direction: column;
  gap:            var(--dev-space-3);
  padding:        var(--dev-space-4);
  overflow:       auto;

  h4 { margin: var(--dev-space-2) 0 0; font-size: 13px; }

  &__about { margin: 0; font-size: 14px; display: flex; flex-wrap: wrap; gap: 0 var(--dev-space-2); }

  &__facts {
    display:               grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap:                   var(--dev-space-2) var(--dev-space-4);
    margin:                0;

    dt { color: var(--muted); font-size: 11px; letter-spacing: 0.05em; text-transform: uppercase; }
    dd { margin: 2px 0 0; overflow-wrap: anywhere; }
  }

  &__links { display: flex; flex-wrap: wrap; gap: var(--dev-space-2) var(--dev-space-5); }

  &__none { margin: 0; }

  &__evals { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--dev-space-2); }

  &__eval { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--dev-space-1) var(--dev-space-2); }

  &__why { color: var(--muted); overflow-wrap: anywhere; code { border: 0; padding: 0 2px; } }

  &__try { display: flex; flex-wrap: wrap; align-items: center; gap: var(--dev-space-2); }

  &__error { margin: 0; color: var(--error); }

  &__hint { font-weight: 400; font-size: 12px; code { border: 0; padding: 0 2px; } }

  &__payload {
    margin:        0;
    padding:       var(--dev-space-3);
    max-height:    50vh;
    overflow:      auto;
    font-size:     12px;
    white-space:   pre-wrap;
    overflow-wrap: anywhere;
  }
}
</style>
