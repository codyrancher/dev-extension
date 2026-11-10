<script setup lang="ts">
/**
 * The events log: everything dev-api has recorded, newest first, and what each did.
 *
 * A row is one event - when, from where, what, about what, by whom - and beside it every
 * automation that listens to that kind of event, with what happened there: it ran (and the run is
 * a click away), or it did not and why - the constraint that was false, the one that threw, the
 * automation switched off, the workspace muted. Opening a row shows the payload, which is what a
 * constraint is written against.
 *
 * Muting a workspace hides its events here and keeps them from starting anything; they are still
 * recorded, and Show muted brings them back.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { watch } from '../../events';
import {
  EVENTS_PATH, readEvent, pollNow, setMutes, near, stamp, OUTCOME_WORDS,
} from '../../automations';
import type { AutoEvent, EventsAnswer } from '../../automations';
import DevModal from '../DevModal.vue';
import RunLog from './RunLog.vue';
import {
  DEV_PRODUCT, BLANK_CLUSTER, WORKSPACE_ROUTE
} from '../../config/constants';

const data = ref<EventsAnswer | null>(null);
const now = ref(Date.now());
const source = ref<'' | 'github' | 'workspace'>('');
const query = ref('');
const showMuted = ref(false);
const onlyMatched = ref(false);
const open = ref<string>('');
const payloads = ref<Record<string, any>>({}); // eslint-disable-line @typescript-eslint/no-explicit-any
const polling = ref(false);
const error = ref('');
const runId = ref('');
const muteDraft = ref('');
let stopWatch: (() => void) | null = null;
let clock: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  stopWatch = watch(EVENTS_PATH, (value) => {
    data.value = value;
  }, { every: 5000 });
  clock = setInterval(() => {
    now.value = Date.now();
  }, 15_000);
});
onBeforeUnmount(() => {
  stopWatch?.();
  if (clock) {
    clearInterval(clock);
  }
});

const events = computed<AutoEvent[]>(() => data.value?.events || []);
const mutes = computed<string[]>(() => data.value?.mutes || []);
const mutedCount = computed(() => events.value.filter((e) => e.muted).length);

const shown = computed(() => {
  const q = query.value.trim().toLowerCase();

  return events.value.filter((e) => {
    if (!showMuted.value && e.muted) {
      return false;
    }
    if (source.value && e.source !== source.value) {
      return false;
    }
    if (onlyMatched.value && !e.matches?.length) {
      return false;
    }

    return !q || [e.name, e.subject, e.title, e.actor, e.workspace].some((x) => String(x || '').toLowerCase().includes(q));
  });
});

/** Workspaces the log has seen, for the mute picker: the ones worth muting are the noisy ones. */
const knownWorkspaces = computed(() => {
  const counts = new Map<string, number>();

  for (const e of events.value) {
    if (e.workspace && !mutes.value.includes(e.workspace)) {
      counts.set(e.workspace, (counts.get(e.workspace) || 0) + 1);
    }
  }

  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n }));
});

const github = computed(() => data.value?.sources?.github || {});
const stages = computed(() => data.value?.sources?.workspace || {});

const githubLine = computed(() => {
  const g = github.value;

  if (!g.at) {
    return 'not read yet';
  }
  const parts = [g.login ? `@${ g.login }` : '', g.ok === false ? `failed ${ near(g.at, now.value) }` : `read ${ near(g.at, now.value) }`];

  if (g.ok !== false && typeof g.items === 'number') {
    parts.push(`${ g.items } assigned`);
  }
  if (g.next) {
    parts.push(`next ${ near(g.next, now.value) }`);
  }

  return parts.filter(Boolean).join(' · ');
});

function workspaceTo(name: string) {
  return {
    name: WORKSPACE_ROUTE, params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER, workspace: name }
  };
}

async function toggle(e: AutoEvent) {
  open.value = open.value === e.id ? '' : e.id;
  if (open.value && !payloads.value[e.id]) {
    try {
      const full = await readEvent(e.id);

      payloads.value = { ...payloads.value, [e.id]: full.payload ?? {} };
    } catch (err: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
      payloads.value = { ...payloads.value, [e.id]: { error: err?.message || String(err) } };
    }
  }
}

async function poll() {
  polling.value = true;
  error.value = '';
  try {
    await pollNow();
  } catch (e: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
    error.value = e?.message || String(e);
  } finally {
    polling.value = false;
  }
}

async function changeMutes(next: string[]) {
  error.value = '';
  try {
    const saved = await setMutes(next);

    if (data.value) {
      data.value = {
        ...data.value, mutes: saved, events: data.value.events.map((e) => ({ ...e, muted: !!e.workspace && saved.includes(e.workspace) }))
      };
    }
  } catch (e: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
    error.value = e?.message || String(e);
  }
}

function mute(name: string) {
  if (name && !mutes.value.includes(name)) {
    changeMutes([...mutes.value, name]);
  }
  muteDraft.value = '';
}

function unmute(name: string) {
  changeMutes(mutes.value.filter((m) => m !== name));
}

/** Jump to an event from a run: show it, open it, and bring it into view. */
function focusEvent(id: string) {
  runId.value = '';
  query.value = '';
  source.value = '';
  showMuted.value = true;
  const e = events.value.find((x) => x.id === id);

  if (e) {
    open.value = '';
    toggle(e);
    setTimeout(() => document.getElementById(`event-${ id }`)?.scrollIntoView({ block: 'center' }), 50);
  }
}

const SOURCES = [
  { id: '', label: 'All' },
  { id: 'github', label: 'GitHub' },
  { id: 'workspace', label: 'Workspaces' },
] as const;
</script>

<template>
  <section
    class="events"
    data-testid="automation-events"
  >
    <div class="events__sources">
      <div
        class="events__source"
        :class="{ 'events__source--bad': github.ok === false }"
        :title="github.error || 'The issues and pull requests assigned to you, read every three minutes: GitHub has no push channel for them short of a webhook on every repository.'"
      >
        <span class="events__dot" />
        <strong>GitHub</strong>
        <span class="text-muted">{{ githubLine }}</span>
        <span
          v-if="github.ok === false"
          class="events__err"
        >{{ github.error }}</span>
        <button
          type="button"
          class="btn role-secondary btn-sm"
          :disabled="polling"
          data-testid="automation-poll"
          @click="poll"
        >
          {{ polling ? 'Reading…' : 'Read now' }}
        </button>
      </div>
      <div
        class="events__source"
        :class="{ 'events__source--live': stages.live, 'events__source--bad': !stages.live && stages.error }"
        :title="stages.live ? 'Watched: a stage change is recorded as soon as it is stored.' : (stages.error || 'Read once a minute until the watch is back.')"
      >
        <span class="events__dot" />
        <strong>Stages</strong>
        <span class="text-muted">{{ stages.live ? 'live' : `read every minute${ stages.error ? ` · ${ stages.error }` : '' }` }}</span>
      </div>
    </div>

    <div class="events__tools">
      <div
        class="events__chips"
        role="group"
        aria-label="Source"
      >
        <button
          v-for="s in SOURCES"
          :key="s.id"
          type="button"
          class="events__chip"
          :class="{ 'events__chip--on': source === s.id }"
          :aria-pressed="source === s.id ? 'true' : 'false'"
          @click="source = s.id"
        >
          {{ s.label }}
        </button>
      </div>
      <input
        v-model="query"
        class="events__search"
        type="search"
        placeholder="Filter by name, PR, title, person, workspace"
        aria-label="Filter events"
      >
      <label class="events__check">
        <input
          v-model="onlyMatched"
          type="checkbox"
        > Reached an automation
      </label>
      <label class="events__check">
        <input
          v-model="showMuted"
          type="checkbox"
        > Show muted<template v-if="mutedCount"> ({{ mutedCount }})</template>
      </label>
    </div>

    <div class="events__mutes">
      <span class="events__label">Muted</span>
      <span
        v-if="!mutes.length"
        class="text-muted"
      >no workspaces</span>
      <span
        v-for="m in mutes"
        :key="m"
        class="events__muted"
      >
        {{ m }}
        <button
          type="button"
          :aria-label="`Unmute ${ m }`"
          title="Unmute"
          @click="unmute(m)"
        >×</button>
      </span>
      <select
        v-model="muteDraft"
        class="events__mute-pick"
        aria-label="Mute a workspace"
        data-testid="automation-mute-pick"
        @change="mute(muteDraft)"
      >
        <option value="">
          Mute a workspace…
        </option>
        <option
          v-for="w in knownWorkspaces"
          :key="w.name"
          :value="w.name"
        >
          {{ w.name }} ({{ w.n }})
        </option>
      </select>
    </div>

    <p
      v-if="error"
      class="events__error"
    >
      {{ error }}
    </p>

    <p
      v-if="!data"
      class="text-muted events__empty"
    >
      Reading the log…
    </p>
    <p
      v-else-if="!events.length"
      class="text-muted events__empty"
    >
      Nothing recorded yet. The first GitHub read is the baseline - what is already assigned to you - and only changes after it are events. A stage moving is one at once.
    </p>
    <p
      v-else-if="!shown.length"
      class="text-muted events__empty"
    >
      No event matches the filter.
    </p>

    <ol
      v-else
      class="events__list"
    >
      <li
        v-for="e in shown"
        :id="`event-${ e.id }`"
        :key="e.id"
        class="event"
        :class="{ 'event--open': open === e.id, 'event--muted': e.muted }"
        :data-testid="`automation-event-${ e.id }`"
      >
        <button
          type="button"
          class="event__row"
          :aria-expanded="open === e.id ? 'true' : 'false'"
          @click="toggle(e)"
        >
          <time
            class="event__at"
            :datetime="e.at"
            :title="e.at"
          >{{ stamp(e.at) }}</time>
          <span
            class="event__source"
            :class="`event__source--${ e.source }`"
          >{{ e.source }}</span>
          <code class="event__name">{{ e.name }}</code>
          <span class="event__what">
            <span class="event__subject">{{ e.subject }}</span>
            <span class="event__title">{{ e.title }}</span>
          </span>
          <span
            v-if="e.actor"
            class="event__actor"
            :class="{ 'event__actor--me': e.self }"
          >{{ e.self ? 'you' : `@${ e.actor }` }}</span>
          <span
            v-if="e.matches && e.matches.length"
            class="event__matches"
          >
            <span
              v-for="m in e.matches"
              :key="m.automation"
              class="event__match"
              :class="`event__match--${ m.outcome }`"
              :title="m.reason || `${ m.automation } ran`"
            >{{ m.automation }} · {{ OUTCOME_WORDS[m.outcome] || m.outcome }}</span>
          </span>
        </button>

        <div
          v-if="open === e.id"
          class="event__detail"
        >
          <div class="event__links">
            <a
              v-if="e.url"
              :href="e.url"
              target="_blank"
              rel="noopener noreferrer"
            >Open on GitHub ↗</a>
            <router-link
              v-if="e.workspace"
              :to="workspaceTo(e.workspace)"
            >
              {{ e.workspace }}
            </router-link>
            <button
              v-if="e.workspace && !mutes.includes(e.workspace)"
              type="button"
              class="event__mute"
              @click="mute(e.workspace)"
            >
              Mute {{ e.workspace }}
            </button>
            <button
              v-else-if="e.workspace"
              type="button"
              class="event__mute"
              @click="unmute(e.workspace)"
            >
              Unmute {{ e.workspace }}
            </button>
            <span class="text-muted event__id">{{ e.id }}</span>
          </div>

          <div class="event__evals">
            <span class="event__label">Automations</span>
            <p
              v-if="!e.matches || !e.matches.length"
              class="text-muted event__none"
            >
              No automation listens to {{ e.name }}{{ e.source === 'github' ? '' : ` from ${ e.source }` }}.
            </p>
            <ul v-else>
              <li
                v-for="m in e.matches"
                :key="m.automation"
                class="event__eval"
                :class="`event__eval--${ m.outcome }`"
              >
                <strong>{{ m.automation }}</strong>
                <span class="event__outcome">{{ OUTCOME_WORDS[m.outcome] || m.outcome }}</span>
                <template v-if="m.outcome === 'run'">
                  <button
                    v-if="m.runId"
                    type="button"
                    class="event__open-run"
                    @click="runId = m.runId"
                  >
                    See the run
                  </button>
                </template>
                <span
                  v-else-if="m.condition"
                  class="event__why"
                >
                  <code>{{ m.condition }}</code>
                  {{ m.outcome === 'error' ? m.reason.replace(m.condition, '').replace(/^\s*/, '') : `was ${ m.reason.split(' was ').pop() }` }}
                </span>
                <span
                  v-else
                  class="event__why"
                >{{ m.reason }}</span>
              </li>
            </ul>
          </div>

          <div class="event__payload">
            <span class="event__label">Payload <span class="text-muted">- what a constraint reads as <code>payload</code> or <code>p</code></span></span>
            <pre>{{ payloads[e.id] ? JSON.stringify(payloads[e.id], null, 2) : 'Reading…' }}</pre>
          </div>
        </div>
      </li>
    </ol>

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
  </section>
</template>

<style lang="scss" scoped>
.events {
  display:        flex;
  flex-direction: column;
  gap:            var(--dev-space-3);
  padding:        var(--dev-space-4) var(--dev-inset) 0;

  &__sources { display: flex; flex-wrap: wrap; gap: var(--dev-space-3); }

  &__source {
    display:       flex;
    align-items:   center;
    gap:           var(--dev-space-2);
    padding:       6px 6px 6px 12px;
    border:        1px solid var(--border);
    border-radius: var(--r-sm);
    font-size:     12px;
    min-width:     0;
    flex-wrap:     wrap;

    .btn { min-height: 0; padding: 3px 10px; font-size: 12px; line-height: 1.4; }
  }

  &__dot {
    width:         8px;
    height:        8px;
    border-radius: 50%;
    background:    var(--success);
    flex:          0 0 auto;
  }

  &__source--live &__dot { box-shadow: 0 0 0 3px color-mix(in srgb, var(--success) 25%, transparent); }
  &__source--bad &__dot { background: var(--error); }
  &__err { color: var(--error); max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  &__tools { display: flex; align-items: center; gap: var(--dev-space-3); flex-wrap: wrap; }

  &__chips { display: flex; gap: 2px; padding: 2px; border: 1px solid var(--border); border-radius: var(--r-md); }

  &__chip {
    min-height:    0;
    padding:       3px 12px;
    border:        0;
    border-radius: var(--r-md);
    background:    none;
    color:         var(--muted);
    font-size:     12px;
    line-height:   1.5;
    cursor:        pointer;

    &--on { background: var(--dev-accent); color: #fff; }
  }

  &__search {
    flex:          1 1 240px;
    max-width:     420px;
    min-height:    0;
    padding:       5px 10px;
    font-size:     12px;
    color:         var(--input-text);
    background:    var(--input-bg);
    border:        1px solid var(--border);
    border-radius: var(--dev-r-ctl);
  }

  &__check { display: flex; align-items: center; gap: 6px; font-size: 12px; margin: 0; cursor: pointer; }

  &__mutes { display: flex; align-items: center; gap: var(--dev-space-2); flex-wrap: wrap; font-size: 12px; }
  &__label { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }

  &__muted {
    display:       inline-flex;
    align-items:   center;
    gap:           4px;
    padding:       1px 4px 1px 8px;
    border:        1px solid var(--border);
    border-radius: var(--r-md);
    font-family:   monospace;

    button { min-height: 0; padding: 0 4px; border: 0; background: none; color: var(--muted); cursor: pointer; font-size: 14px; line-height: 1.2; }
    button:hover { color: var(--error); }
  }

  &__mute-pick {
    min-height:    0;
    width:         auto;
    padding:       2px 6px;
    font-size:     12px;
    color:         var(--input-text);
    background:    var(--input-bg);
    border:        1px solid var(--border);
    border-radius: var(--dev-r-ctl);
  }

  &__error { color: var(--error); margin: 0; font-size: 12px; }
  &__empty { margin: var(--dev-space-4) 0; font-size: 13px; }

  &__list { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--r-sm); }
}

.event {
  border-bottom: 1px solid var(--border);

  &:last-child { border-bottom: 0; }
  &--muted { opacity: 0.55; }
  &--open { background: color-mix(in srgb, var(--dev-accent) 4%, transparent); }

  &__row {
    display:               grid;
    grid-template-columns: 76px 74px minmax(150px, 190px) minmax(0, 1fr) auto auto;
    align-items:           center;
    gap:                   var(--dev-space-3);
    width:                 100%;
    min-height:            0;
    padding:               7px 12px;
    border:                0;
    background:            none;
    color:                 var(--body-text);
    text-align:            left;
    font-size:             12px;
    line-height:           1.4;
    cursor:                pointer;

    &:hover { background: color-mix(in srgb, var(--body-text) 4%, transparent); }
    &:focus-visible { outline: 2px solid var(--dev-accent); outline-offset: -2px; }
  }

  &__at { color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }

  &__source {
    justify-self:   start;
    padding:        1px 6px;
    border-radius:  var(--r-sm);
    font-size:      10px;
    font-weight:    600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border:         1px solid var(--border);
    color:          var(--muted);

    &--github { color: var(--body-text); }
    &--workspace { color: var(--dev-accent); border-color: color-mix(in srgb, var(--dev-accent) 50%, var(--border)); }
  }

  &__name { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; background: none; padding: 0; border: 0; }

  &__what { display: flex; gap: var(--dev-space-2); min-width: 0; overflow: hidden; }
  &__subject { font-family: monospace; white-space: nowrap; color: var(--muted); }
  &__title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  &__actor { color: var(--muted); white-space: nowrap; &--me { color: var(--dev-accent); } }

  &__matches { display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }

  &__match {
    padding:       1px 7px;
    border-radius: var(--r-md);
    font-size:     11px;
    white-space:   nowrap;
    border:        1px solid var(--border);

    &--run { color: var(--success); border-color: var(--success); }
    &--blocked, &--throttled { color: var(--warning); border-color: var(--warning); }
    &--error { color: var(--error); border-color: var(--error); }
    &--disabled, &--muted { color: var(--muted); }
  }

  &__detail {
    display:        flex;
    flex-direction: column;
    gap:            var(--dev-space-3);
    padding:        4px 12px 14px 98px;
    font-size:      12px;
  }

  &__links { display: flex; align-items: center; gap: var(--dev-space-4); flex-wrap: wrap; }
  &__id { margin-left: auto; font-family: monospace; font-size: 11px; }

  &__mute, &__open-run {
    min-height: 0;
    padding:    0;
    border:     0;
    background: none;
    color:      var(--link);
    font-size:  12px;
    line-height: 1.4;
    cursor:     pointer;

    &:hover { text-decoration: underline; }
  }

  &__label { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); code { text-transform: none; letter-spacing: 0; } }
  &__none { margin: 4px 0 0; }

  &__evals ul { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }

  &__eval {
    display:     flex;
    align-items: baseline;
    gap:         var(--dev-space-2);
    flex-wrap:   wrap;
  }

  &__outcome {
    font-size:      10px;
    font-weight:    600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  &__eval--run &__outcome { color: var(--success); }
  &__eval--blocked &__outcome, &__eval--throttled &__outcome { color: var(--warning); }
  &__eval--error &__outcome { color: var(--error); }
  &__eval--disabled &__outcome, &__eval--muted &__outcome { color: var(--muted); }

  &__why { color: var(--muted); overflow-wrap: anywhere; code { color: var(--body-text); } }

  &__payload pre {
    margin:        4px 0 0;
    padding:       var(--dev-space-3);
    max-height:    360px;
    overflow:      auto;
    font-size:     11px;
    white-space:   pre-wrap;
    overflow-wrap: anywhere;
    background:    color-mix(in srgb, var(--body-text) 5%, transparent);
    border-radius: var(--r-sm);
  }
}

@media (max-width: 760px) {
  .event {
    &__row {
      grid-template-columns: auto auto minmax(0, 1fr);
      grid-template-areas: 'at source name' 'what what what' 'actor matches matches';
      row-gap: 4px;
    }

    &__at { grid-area: at; }
    &__source { grid-area: source; }
    &__name { grid-area: name; }
    &__what { grid-area: what; }
    &__actor { grid-area: actor; }
    &__matches { grid-area: matches; }
    &__detail { padding-left: 12px; }
  }
}
</style>
