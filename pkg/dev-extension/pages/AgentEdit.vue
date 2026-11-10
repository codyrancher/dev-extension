<script>
// Making or changing an automation: what it does - an agent conversation or a script - and what
// sets it off. dev-api runs it (agent-defs.ts says how); constraints on an event trigger are tried
// here, in the browser, against the events already recorded, before anything is saved.
import { Banner } from '@components/Banner';
import AsyncButton from '@shell/components/AsyncButton';
import LabeledSelect from '@shell/components/form/LabeledSelect';
import { LabeledInput } from '@components/Form/LabeledInput';
import { Checkbox } from '@components/Form/Checkbox';
import { RcButton } from '@components/RcButton';
import DevModal from '../components/DevModal.vue';
import DevPage from '../components/DevPage.vue';
import {
  getAgent, saveAgent, validName, cronValid, CRON_PRESETS, triggersOf, compileFilter, filterError, PROMPT_KEYS
} from '../agent-defs';
import { devFetch, clusterBase } from '../api';
import { listSkills, readSkill } from '../skills';
import { EVENT_NAMES } from '../dev-api/automation-events.mjs';
import {
  conditionLines, nameMatches, SCRIPT_TIMEOUT_S, SCRIPT_TIMEOUT_MAX_S
} from '../dev-api/automation-rules.mjs';
import { recentEvents, tryDefinition, OUTCOME_WORDS, stamp } from '../automations';
import {
  DEV_PRODUCT, BLANK_CLUSTER, AGENTS_ROUTE, DEV_API_IN_CLUSTER
} from '../config/constants';

const SCRIPT_EXAMPLE_STAGE = `# $EVENT_WORKSPACE reached $(jq -r .payload.toLabel "$EVENT_FILE").
echo "$EVENT_WORKSPACE: $EVENT_TITLE"`;

const SCRIPT_EXAMPLE = `# The event is on stdin as JSON, and in $EVENT_FILE.
# $EVENT_NAME, $EVENT_SUBJECT, $EVENT_URL, $EVENT_WORKSPACE and $EVENT_ACTOR are set.
echo "$EVENT_NAME on $EVENT_SUBJECT"
jq -r '.payload.comment.body // empty' < "$EVENT_FILE"`;

/**
 * Ready-made starts, from the Automations tab. The review one is the one asked for: every pull
 * request you are asked to review, reviewed the way the Review button does it, narrowed to the
 * repositories and the people you name.
 */
const TEMPLATES = {
  'review-requests': {
    def: {
      name: 'review-requests', description: 'Reviews each pull request I am asked to review, the way My Work\'s Review button does.', action: 'review',
    },
    evt: {
      source: 'github', names: 'pr.review-requested', repos: 'rancher/dashboard', authors: '', condition: '!p.draft',
    },
  },
  'stage-script': {
    def: {
      name: 'stage-merged', description: 'Runs a script when a workspace reaches Merged.', action: 'script', script: SCRIPT_EXAMPLE_STAGE,
    },
    evt: {
      source: 'workspace', names: 'stage.changed', repos: '', authors: '', condition: "p.to === 'merged'",
    },
  },
};

const EVENTS = [
  { value: 'any', label: 'any change' }, { value: 'created', label: 'created' }, { value: 'updated', label: 'updated' }, { value: 'deleted', label: 'deleted' },
];

export default {
  name: 'AgentEdit',

  components: {
    Banner, AsyncButton, LabeledSelect, LabeledInput, Checkbox, RcButton, DevModal, DevPage
  },

  data() {
    return {
      // The skills' names, from codyrancher/ai-skills through dev-api: not in this bundle.
      skillNames: [],
      def: {
        name:        '',
        description: '',
        action:      'agent',
        prompt:      '',
        script:      '',
        timeoutSec:  SCRIPT_TIMEOUT_S,
        enabled:     true,
      },
      // The triggers, as a form: by hand is always there; the rest are ticked on.
      on:       {
        cron: false, api: false, resource: false, event: false
      },
      /** The event trigger: names as typed, comma-separated, and the constraints. */
      evt:      {
        source: 'github', names: 'pr.*', repos: '', authors: '', condition: '!p.self'
      },
      /** What trying the constraints against recorded events found, or null. */
      triedEvents: null,
      trying:   false,
      OUTCOME_WORDS,
      SCRIPT_EXAMPLE,
      SCRIPT_TIMEOUT_MAX_S,
      tz:       Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      cron:     '0 9 * * 1-5',
      resource: {
        type: '', namespace: '', event: 'any', filter: '', edge: true,
      },
      /** What a Test of the filter found, or null. */
      tried:    null,
      PROMPT_KEYS,
      editing:  false,
      error:    '',
      /** The skill whose definition is open, or null. */
      doc:      null,
      /** Which suggestion Tab would take. */
      cursor:   0,
      CRON_PRESETS,
      EVENTS,
    };
  },

  computed: {
    /** The skills the agents carry, by name. */
    skills() {
      return this.skillNames;
    },

    /** The `/name` the prompt opens with, if it opens with one. */
    command() {
      return (/^\s*\/([a-z0-9-]+)/i.exec(this.def.prompt) || [])[1] || '';
    },

    /** Whether the prompt is still just that word, with nothing after it. */
    typing() {
      return /^\s*\/[a-z0-9-]*$/i.test(this.def.prompt);
    },

    known() {
      return !!this.command && this.skills.includes(this.command);
    },

    /** Typeahead: the skills the word so far could become, while it is being typed. */
    suggestions() {
      if (!this.typing || !/^\s*\//.test(this.def.prompt)) {
        return [];
      }
      const word = this.command.toLowerCase();

      return this.skills.filter((s) => s.startsWith(word) && s !== word).slice(0, 8);
    },

    apiUrl() {
      return `${ DEV_API_IN_CLUSTER }/agents/${ this.def.name || '<name>' }/trigger`;
    },

    problems() {
      const out = [];

      if (!validName(this.def.name)) {
        out.push('The name is lowercase letters, digits and dashes.');
      }
      if (this.def.action === 'script' && !this.def.script.trim()) {
        out.push('Write the script it runs.');
      }
      if (this.def.action === 'review' && !this.on.event) {
        out.push('A review runs on an event about a pull request: tick On an event.');
      }
      if (this.def.action === 'agent' && !this.def.prompt.trim()) {
        out.push('Say what the conversation should open with.');
      }
      if (this.on.event && this.eventProblem) {
        out.push(this.eventProblem);
      }
      if (this.on.cron && !cronValid(this.cron)) {
        out.push('The schedule is five cron fields: minute hour day month weekday.');
      }
      if (this.on.resource && !this.resource.type.trim()) {
        out.push('Say which resource type sets it off.');
      }
      if (this.on.resource && this.filterProblem) {
        out.push(`The filter does not compile: ${ this.filterProblem }`);
      }

      return out;
    },

    filterProblem() {
      return filterError(this.resource.filter);
    },

    /** The event names as a list, from what was typed. */
    eventNames() {
      return this.evt.names.split(/[,\s]+/).map((n) => n.trim()).filter(Boolean);
    },

    /** The names this source has, for the chips under the input. */
    knownNames() {
      return this.evt.source ? (EVENT_NAMES[this.evt.source] || []) : [...EVENT_NAMES.github, ...EVENT_NAMES.workspace];
    },

    /** A constraint that will not even parse, said before it is saved. */
    eventProblem() {
      for (const line of conditionLines(this.evt.condition)) {
        const problem = filterError(line);

        if (problem) {
          return `The constraint ${ line } does not parse: ${ problem }`;
        }
      }

      return '';
    },

    /** The definition as the form has it now, for trying and for saving. */
    draft() {
      const triggers = [{ type: 'manual' }];

      if (this.on.cron) {
        triggers.push({ type: 'cron', cron: this.cron.trim() });
      }
      if (this.on.api) {
        triggers.push({ type: 'api' });
      }
      if (this.on.resource) {
        triggers.push({
          type:     'resource',
          resource: {
            ...this.resource, type: this.resource.type.trim(), namespace: this.resource.namespace.trim(), filter: (this.resource.filter || '').trim(),
          },
        });
      }
      if (this.on.event) {
        triggers.push({
          type:  'event',
          event: {
            source: this.evt.source, names: this.eventNames, repos: this.listOf(this.evt.repos), authors: this.listOf(this.evt.authors).map((a) => a.replace(/^@/, '')), condition: this.evt.condition.trim(),
          },
        });
      }

      return {
        ...JSON.parse(JSON.stringify(this.def)),
        name:       this.def.name.trim().toLowerCase(),
        timeoutSec: Math.max(5, Math.min(SCRIPT_TIMEOUT_MAX_S, Number(this.def.timeoutSec) || SCRIPT_TIMEOUT_S)),
        tz:         this.tz,
        triggers,
      };
    },

    backTo() {
      return { name: AGENTS_ROUTE, params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER }, hash: '#automations' };
    },
  },

  watch: {
    suggestions() {
      this.cursor = 0;
    },
  },

  async fetch() {
    const name = this.$route.params.name;

    listSkills().then(({ skills }) => {
      this.skillNames = skills.map((s) => s.name).sort();
    }).catch(() => {});

    const template = !name && TEMPLATES[this.$route.query?.template];

    if (template) {
      this.def = { ...this.def, ...template.def };
      this.evt = { ...this.evt, ...template.evt };
      this.on.event = true;
    }

    if (name) {
      const found = await getAgent(name).catch(() => null);

      if (found) {
        this.def = {
          name:        found.name,
          description: found.description || '',
          action:      ['script', 'review'].includes(found.action) ? found.action : 'agent',
          prompt:      found.prompt || '',
          script:      found.script || '',
          timeoutSec:  found.timeoutSec || SCRIPT_TIMEOUT_S,
          enabled:     found.enabled !== false,
        };
        for (const t of triggersOf(found)) {
          if (t.type === 'cron') {
            this.on.cron = true;
            this.cron = t.cron || this.cron;
          } else if (t.type === 'api') {
            this.on.api = true;
          } else if (t.type === 'resource') {
            this.on.resource = true;
            this.resource = { ...this.resource, ...(t.resource || {}) };
          } else if (t.type === 'event') {
            this.on.event = true;
            this.evt = {
              source: t.event?.source || '', names: (t.event?.names || []).join(', '), repos: (t.event?.repos || []).join(', '), authors: (t.event?.authors || []).join(', '), condition: t.event?.condition || '',
            };
          }
        }
        this.editing = true;
      }
    }
  },

  methods: {
    /** A suggestion taken: the prompt opens with that skill, and the cursor is after it. */
    complete(name) {
      this.def.prompt = `/${ name } `;
      this.$nextTick(() => {
        const el = this.$refs.prompt;

        if (el) {
          el.focus();
          el.selectionStart = el.selectionEnd = el.value.length;
        }
      });
    },

    onKey(event) {
      if (!this.suggestions.length) {
        return;
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault();
        this.complete(this.suggestions[this.cursor] || this.suggestions[0]);
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        this.cursor = (this.cursor + 1) % this.suggestions.length;
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        this.cursor = (this.cursor + this.suggestions.length - 1) % this.suggestions.length;
      }
    },

    async showSkill(name) {
      const text = await readSkill(name).then((s) => s.content).catch(() => '');

      this.doc = { name, text: text || `There is no skill called /${ name }.` };
    },

    /** A placeholder as it is written, without putting `{{` in a template that reads it as one. */
    placeholder(key) {
      return `{${ '{' }${ key }}${ '}' }`;
    },

    preset(cron) {
      this.cron = cron;
    },

    /**
     * The filter against what is in the cluster now: how many of that type it accepts, and
     * which. A filter is a line of code somebody has to be able to check before an agent
     * starts opening conversations on the strength of it.
     */
    async testFilter(done) {
      this.tried = null;
      try {
        const type = this.resource.type.trim();
        const url = `${ clusterBase('local') }/v1/${ type }${ this.resource.namespace.trim() ? `/${ this.resource.namespace.trim() }` : '' }`;
        const list = await devFetch(url);
        const all = Array.isArray(list?.data) ? list.data : [];
        const match = compileFilter(this.resource.filter);
        const hits = all.filter((r) => match(r, 'updated'));

        this.tried = {
          total: all.length,
          hits:  hits.length,
          names: hits.slice(0, 6).map((r) => r.id || r.metadata?.name),
        };
        done(true);
      } catch (e) {
        this.tried = { error: e.message || String(e) };
        done(false);
      }
    },

    /** A comma- or space-separated field as a list. */
    listOf(text) {
      return String(text || '').split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
    },

    /** Whether a known name is already covered by a wildcard in the list, without being in it. */
    covered(name) {
      return !this.eventNames.includes(name) && this.eventNames.some((p) => p.includes('*')) && nameMatches(this.eventNames.filter((p) => p.includes('*')), name);
    },

    /** Add a known name to the list, or take it out if it is there. */
    toggleName(name) {
      const names = this.eventNames;

      this.evt.names = (names.includes(name) ? names.filter((n) => n !== name) : [...names, name]).join(', ');
    },

    /**
     * The trigger against what has been recorded: which events it listens to, and of those which
     * would have run it and which a constraint would have stopped. In this browser, on the form as
     * it stands - nothing is saved, and nothing runs.
     */
    async tryEvents() {
      this.trying = true;
      try {
        const { events, me } = await recentEvents(300);
        const found = tryDefinition({ ...this.draft, triggers: this.draft.triggers.filter((t) => t.type === 'event') }, events, me);

        this.triedEvents = {
          total:   events.length,
          reached: found.length,
          ran:     found.filter((f) => f.match.outcome === 'run').length,
          rows:    found.slice(0, 12),
        };
      } catch (e) {
        this.triedEvents = { error: e.message || String(e) };
      } finally {
        this.trying = false;
      }
    },

    stamp,

    async save(done) {
      this.error = '';
      if (this.problems.length) {
        this.error = this.problems.join(' ');
        done(false);

        return;
      }
      try {
        await saveAgent(this.draft);
        done(true);
        this.$router.push(this.backTo);
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },
  },
};
</script>

<template>
  <DevPage
    :title="editing ? `Edit ${ def.name }` : 'New automation'"
    lede="Something that runs by itself: what it does, and what sets it off."
    class="agent-edit"
  >

    <Banner
      v-if="error"
      color="error"
      :label="error"
    />

    <section class="agent-edit__section">
      <h3>What it is</h3>
      <LabeledInput
        v-model:value="def.name"
        label="Name"
        placeholder="morning-pr-review"
        :disabled="editing"
        required
      />
      <LabeledInput
        v-model:value="def.description"
        label="Description"
        placeholder="Reviews every PR that asks for me, first thing."
      />
    </section>

    <section class="agent-edit__section">
      <h3>What it does</h3>
      <div
        class="agent-edit__kinds"
        role="radiogroup"
        aria-label="What it does"
      >
        <label
          class="agent-edit__kind"
          :class="{ 'agent-edit__kind--on': def.action === 'agent' }"
        >
          <input
            v-model="def.action"
            type="radio"
            value="agent"
            data-testid="automation-kind-agent"
          >
          <span><strong>An agent</strong> - a conversation in the agents drawer, opened with a prompt or a skill</span>
        </label>
        <label
          class="agent-edit__kind"
          :class="{ 'agent-edit__kind--on': def.action === 'script' }"
        >
          <input
            v-model="def.action"
            type="radio"
            value="script"
            data-testid="automation-kind-script"
          >
          <span><strong>A script</strong> - run in the agent pod, with gh, git, kubectl and claude to hand</span>
        </label>
        <label
          class="agent-edit__kind"
          :class="{ 'agent-edit__kind--on': def.action === 'review' }"
        >
          <input
            v-model="def.action"
            type="radio"
            value="review"
            data-testid="automation-kind-review"
          >
          <span><strong>Review the pull request</strong> - what My Work's Review button does, on the PR the event is about</span>
        </label>
      </div>

      <p
        v-if="def.action === 'review'"
        class="text-muted agent-edit__hint"
      >
        A <code>pr-&lt;number&gt;</code> workspace, made on the Rancher you last chose if it is not there yet, and the my-pr-full-review skill in a conversation in it - the review panel fills in as it goes. One review per pull request at a time: an event for a PR already being reviewed is skipped, and says so. It is started by an open dashboard, since making and preparing a workspace takes your Rancher session; with none open it waits.
      </p>

      <template v-if="def.action === 'script'">
        <label class="agent-edit__label">Script - bash, unless it starts with <code>#!</code>. The event is on stdin as JSON; its output is the run's log.</label>
        <textarea
          v-model="def.script"
          class="agent-edit__prompt agent-edit__script"
          rows="10"
          spellcheck="false"
          :placeholder="SCRIPT_EXAMPLE"
          data-testid="automation-script"
        />
        <div class="agent-edit__row agent-edit__timeout">
          <LabeledInput
            v-model:value="def.timeoutSec"
            type="number"
            label="Time limit (seconds)"
            :min="5"
            :max="SCRIPT_TIMEOUT_MAX_S"
          />
          <p class="text-muted agent-edit__hint">
            Set for it: <code>EVENT_FILE</code>, <code>EVENT_ID</code>, <code>EVENT_SOURCE</code>, <code>EVENT_NAME</code>, <code>EVENT_SUBJECT</code>, <code>EVENT_TITLE</code>, <code>EVENT_URL</code>, <code>EVENT_ACTOR</code>, <code>EVENT_WORKSPACE</code>, <code>TRIGGER</code>, <code>RUN_ID</code>, <code>RUN_DIR</code> and <code>DEV_API</code>. It runs as the pane user, from <code>/workspace/conversations</code>.
          </p>
        </div>
      </template>
      <template v-else-if="def.action === 'agent'">
        <div class="agent-edit__prompt-head">
          <label class="agent-edit__label">Prompt - what the conversation opens with; start with <code>/</code> for a skill</label>
          <span
            v-if="command"
            class="agent-edit__command"
            :class="{ 'agent-edit__command--known': known, 'agent-edit__command--unknown': !known && !typing }"
          >
            <a
              v-if="known"
              href="#"
              :title="`Read the ${ command } skill`"
              data-testid="agent-skill-link"
              @click.prevent="showSkill(command)"
            >/{{ command }}</a>
            <template v-else-if="!typing">/{{ command }} is not a skill the agents have</template>
          </span>
        </div>
        <div class="agent-edit__prompt-wrap">
          <textarea
            ref="prompt"
            v-model="def.prompt"
            class="agent-edit__prompt"
            :class="{ 'agent-edit__prompt--skill': known }"
            rows="6"
            placeholder="/my-pr-full-review Review rancher/dashboard PR #<n> - harness portal context, file through $CLAUDE_HARNESS_API/my-work/pr/<n>."
            data-testid="agent-prompt"
            @keydown="onKey"
          />
          <ul
            v-if="suggestions.length"
            class="agent-edit__suggest"
            data-testid="agent-suggest"
          >
            <li
              v-for="(name, i) in suggestions"
              :key="name"
              :class="{ 'agent-edit__suggest--on': i === cursor }"
              @mousedown.prevent="complete(name)"
            >
              /{{ name }}
            </li>
          </ul>
        </div>
        <p class="text-muted agent-edit__hint">
          On an event, the prompt can name it: <code>{{ placeholder('event.subject') }}</code>, <code>{{ placeholder('event.title') }}</code>, <code>{{ placeholder('event.url') }}</code>, <code>{{ placeholder('payload.comment.body') }}</code> - any path into the event - and <code>{{ placeholder('event.file') }}</code> is a file holding all of it.
        </p>
      </template>
    </section>

    <section class="agent-edit__section">
      <h3>What sets it off</h3>
      <p class="agent-edit__always">
        <i class="icon icon-checkmark" /> By hand, always: <template v-if="def.action === 'review'">
          on any pull request's event in the log, with Run an automation on this
        </template><template v-else>
          Run now, on the Automations tab
        </template>
      </p>
      <div class="agent-edit__trigger">
        <Checkbox
          v-model:value="on.event"
          label="On an event - a workspace's stage moving, or something happening on an issue or PR you are part of"
          data-testid="automation-on-event"
        />
        <template v-if="on.event">
          <div class="agent-edit__row">
            <LabeledSelect
              v-model:value="evt.source"
              :options="[{ value: 'github', label: 'GitHub' }, { value: 'workspace', label: 'Workspaces' }, { value: '', label: 'Either' }]"
              label="From"
              class="agent-edit__source"
            />
            <LabeledInput
              v-model:value="evt.names"
              label="Events - comma-separated, * for any part; empty for all"
              placeholder="pr.commented, pr.reviewed, *.closed"
              data-testid="automation-event-names"
            />
          </div>
          <div class="agent-edit__names">
            <button
              v-for="n in knownNames"
              :key="n"
              type="button"
              class="agent-edit__name"
              :class="{ 'agent-edit__name--on': eventNames.includes(n), 'agent-edit__name--covered': covered(n) }"
              :title="covered(n) ? 'Already covered by a wildcard' : ''"
              @click="toggleName(n)"
            >
              {{ n }}
            </button>
          </div>
          <div class="agent-edit__row">
            <LabeledInput
              v-model:value="evt.repos"
              label="Repositories - only these; empty for all"
              placeholder="rancher/dashboard, rancher/ui-*"
              data-testid="automation-event-repos"
            />
            <LabeledInput
              v-model:value="evt.authors"
              label="Authors - only work by these people; empty for anyone"
              placeholder="nwmac, @codyrancher"
              data-testid="automation-event-authors"
            />
          </div>
          <label class="agent-edit__label">Constraints - one JavaScript expression per line, and every one must hold. They read <code>event</code> (<code>e</code>), its <code>payload</code> (<code>p</code>) and <code>me</code>, your GitHub login.</label>
          <textarea
            v-model="evt.condition"
            class="agent-edit__filter"
            :class="{ 'agent-edit__filter--bad': eventProblem }"
            rows="4"
            spellcheck="false"
            placeholder="!p.self
p.comment.author !== 'dependabot[bot]'
e.workspace !== ''
p.labels.includes('QA/manual-test')"
            data-testid="automation-constraints"
          />
          <p
            v-if="eventProblem"
            class="agent-edit__bad"
          >
            {{ eventProblem }}
          </p>
          <div class="agent-edit__row agent-edit__try">
            <AsyncButton
              mode="apply"
              action-label="Try it on recent events"
              waiting-label="Trying"
              success-label="Tried"
              size="sm"
              data-testid="automation-try"
              @click="async (done) => { await tryEvents(); done(!(triedEvents && triedEvents.error)); }"
            />
            <span
              v-if="triedEvents && triedEvents.error"
              class="agent-edit__bad"
            >{{ triedEvents.error }}</span>
            <span
              v-else-if="triedEvents"
              class="text-muted agent-edit__hint"
              data-testid="automation-try-result"
            >Of the last {{ triedEvents.total }} events, {{ triedEvents.reached }} {{ triedEvents.reached === 1 ? 'is' : 'are' }} ones it listens to, and {{ triedEvents.ran }} would have run it.</span>
          </div>
          <ul
            v-if="triedEvents && triedEvents.rows && triedEvents.rows.length"
            class="agent-edit__tried"
          >
            <li
              v-for="row in triedEvents.rows"
              :key="row.event.id"
              :class="`agent-edit__tried--${ row.match.outcome }`"
            >
              <span class="agent-edit__tried-when">{{ stamp(row.event.at) }}</span>
              <code>{{ row.event.name }}</code>
              <span class="agent-edit__tried-subject">{{ row.event.subject }}</span>
              <span class="agent-edit__tried-why">
                <strong>{{ OUTCOME_WORDS[row.match.outcome] || row.match.outcome }}</strong>
                <code v-if="row.match.condition">{{ row.match.condition }}</code>
                <template v-else-if="row.match.outcome !== 'run'">{{ row.match.reason }}</template>
              </span>
            </li>
          </ul>
          <p class="text-muted agent-edit__hint">
            Every event it listens to is put to it as it is recorded, and the Events tab shows what happened: that it ran, or which constraint stopped it. At most three runs start from one batch of events. A muted workspace's events start nothing.
          </p>
        </template>
      </div>
      <div class="agent-edit__trigger">
        <Checkbox
          v-model:value="on.cron"
          label="On a schedule"
        />
        <template v-if="on.cron">
          <LabeledInput
            v-model:value="cron"
            :label="`Schedule (cron, five fields, in ${ tz })`"
            placeholder="0 9 * * 1-5"
          />
          <div class="agent-edit__presets">
            <button
              v-for="p in CRON_PRESETS"
              :key="p.cron"
              type="button"
              class="agent-edit__preset"
              @click="preset(p.cron)"
            >
              {{ p.label }}
            </button>
          </div>
          <p class="text-muted agent-edit__hint">
            Kept by the in-cluster API, in the zone this browser is in, so it runs whether or not a dashboard is open.
          </p>
        </template>
      </div>
      <div class="agent-edit__trigger">
        <Checkbox
          v-model:value="on.api"
          label="On an API call"
        />
        <template v-if="on.api">
          <pre class="agent-edit__code">curl -s -X POST {{ apiUrl }} -H 'Content-Type: application/json' -d '{"note":"why"}'</pre>
          <p class="text-muted agent-edit__hint">
            Anything in the cluster can call it. The run starts at once.
          </p>
        </template>
      </div>
      <div class="agent-edit__trigger">
        <Checkbox
          v-model:value="on.resource"
          label="When a resource changes"
        />
        <template v-if="on.resource">
          <div class="agent-edit__row">
            <LabeledInput
              v-model:value="resource.type"
              label="Resource type"
              placeholder="management.cattle.io.cluster"
              data-testid="agent-resource-type"
            />
            <LabeledInput
              v-model:value="resource.namespace"
              label="Namespace (optional)"
            />
            <LabeledSelect
              v-model:value="resource.event"
              :options="EVENTS"
              label="On"
            />
          </div>
          <label class="agent-edit__label">Which of them - a JavaScript expression over <code>resource</code> (or <code>r</code>) and <code>event</code>. Empty means all of them.</label>
          <textarea
            v-model="resource.filter"
            class="agent-edit__filter"
            :class="{ 'agent-edit__filter--bad': filterProblem }"
            rows="2"
            spellcheck="false"
            placeholder="r.spec.displayName === 'prod'
r.status.conditions.some(c => c.type === 'Ready' && c.status !== 'True')"
            data-testid="agent-filter"
          />
          <p
            v-if="filterProblem"
            class="agent-edit__bad"
            data-testid="agent-filter-error"
          >
            {{ filterProblem }}
          </p>
          <div class="agent-edit__row agent-edit__try">
            <AsyncButton
              mode="apply"
              action-label="Test it"
              waiting-label="Listing"
              success-label="Listed"
              size="sm"
              :disabled="!resource.type.trim()"
              data-testid="agent-filter-test"
              @click="testFilter"
            />
            <span
              v-if="tried && tried.error"
              class="agent-edit__bad"
            >{{ tried.error }}</span>
            <span
              v-else-if="tried"
              class="text-muted agent-edit__hint"
              data-testid="agent-filter-result"
            >{{ tried.hits }} of {{ tried.total }} match now<template v-if="tried.names.length">: <code>{{ tried.names.join(', ') }}</code></template></span>
          </div>
          <Checkbox
            v-model:value="resource.edge"
            label="Only when it starts matching, rather than on every change while it matches"
          />
          <p class="text-muted agent-edit__hint">
            Watched by the in-cluster API, live, whether or not a dashboard is open; the filter reads the resource as Kubernetes returns it. Nothing fires the first time a type is looked at: that pass records what is already there, and after a restart what changed in between still fires. Each change that fires is in the Events log. The prompt can carry <code
              v-for="k in PROMPT_KEYS"
              :key="k"
              class="agent-edit__key"
            >{{ placeholder(k) }}</code>, filled with what changed. At most three runs start in any twenty seconds.
          </p>
        </template>
      </div>
      <Checkbox
        v-model:value="def.enabled"
        label="Enabled - a disabled automation keeps its definition and history and starts nothing"
      />
    </section>

    <div class="agent-edit__actions">
      <RcButton
        variant="tertiary"
        @click="$router.push(backTo)"
      >
        Cancel
      </RcButton>
      <AsyncButton
        mode="edit"
        :action-label="editing ? 'Save' : 'Create'"
        waiting-label="Saving"
        success-label="Saved"
        @click="save"
      />
    </div>

    <DevModal
      v-if="doc"
      size="wide"
      :title="`/${ doc.name }`"
      @close="doc = null"
    >
      <template #head>
        <span class="text-muted agent-edit__modal-note">the skill, as the agents carry it</span>
      </template>
      <pre class="agent-edit__modal-body">{{ doc.text }}</pre>
    </DevModal>
  </DevPage>
</template>

<style lang="scss" scoped>
.agent-edit {
  max-width: 900px;

  h3 { margin: 0 0 var(--dev-space-3); font-size: 14px; }


  &__section {
    display:        flex;
    flex-direction: column;
    gap:            var(--dev-space-3);
    padding:        var(--dev-space-4);
    margin-bottom:  var(--dev-space-4);
    border:         1px solid var(--border);
    border-radius:  var(--r-sm);
  }

  &__row { display: flex; gap: var(--dev-space-3); align-items: flex-end; flex-wrap: wrap; > * { flex: 1 1 220px; } }
  &__skill { flex: 0 1 320px; }
  &__hint { font-size: 12px; margin: 0; flex: 1 1 100%; }
  /* Rancher boxes every <code>; inside a sentence of help it is a word, not a field. */
  &__hint code, &__label code { border: 0; padding: 0 2px; }
  &__label { font-size: 12px; color: var(--muted); }

  &__prompt {
    width:         100%;
    min-height:    120px;
    font-family:   monospace;
    font-size:     12px;
    padding:       var(--dev-space-3);
    background:    var(--body-bg);
    color:         var(--body-text);
    border:        1px solid var(--border);
    border-radius: var(--r-sm);
    resize:        vertical;
  }

  &__choices { display: flex; gap: var(--dev-space-5); }
  &__choice { display: flex; align-items: center; gap: var(--dev-space-2); font-size: 13px; cursor: pointer; }

  &__presets { display: flex; flex-wrap: wrap; gap: var(--dev-space-2); }
  &__preset {
    min-height:    0;
    padding:       3px 10px;
    font-size:     12px;
    border-radius: var(--r-md);
    border:        1px solid var(--border);
    background:    transparent;
    color:         var(--body-text);
    cursor:        pointer;

    &:hover { border-color: var(--dev-accent); color: var(--dev-accent); }
  }

  &__code {
    margin:        0;
    padding:       var(--dev-space-3);
    font-size:     12px;
    white-space:   pre-wrap;
    word-break:    break-all;
    background:    color-mix(in srgb, var(--body-text) 5%, transparent);
    border-radius: var(--r-sm);
  }

  &__actions { display: flex; gap: var(--dev-space-3); justify-content: flex-end; }
}

.agent-edit {
  &__prompt-head { display: flex; align-items: baseline; gap: var(--dev-space-3); flex-wrap: wrap; }

  &__command {
    font-family: monospace;
    font-size:   12px;

    a { color: var(--success); font-weight: 600; text-decoration: underline dotted; }
    &--unknown { color: var(--error); }
  }

  &__prompt-wrap { position: relative; }
  &__prompt--skill { border-color: var(--success) !important; }

  &__suggest {
    position:      absolute;
    left:          0;
    top:           calc(1.6em + 14px);
    z-index:       5;
    margin:        0;
    padding:       4px 0;
    list-style:    none;
    min-width:     260px;
    background:    var(--body-bg);
    border:        1px solid var(--border);
    border-radius: var(--r-sm);
    box-shadow:    0 8px 24px rgba(0, 0, 0, 0.25);
    font-family:   monospace;
    font-size:     13px;

    li { padding: 4px 12px; cursor: pointer; }
    li:hover, &--on { background: var(--accent-btn); color: var(--link); }
  }

  &__filter {
    width:       100%;
    min-height:  56px;
    padding:     8px 10px;
    font-family: monospace;
    font-size:   12px;
    color:       var(--input-text);
    background:  var(--input-bg);
    border:      1px solid var(--border);
    border-radius: var(--dev-r-ctl);
    resize:      vertical;

    &--bad { border-color: var(--error); }
  }

  &__bad { color: var(--error); font-size: 12px; margin: 0; }
  &__key { margin-right: 4px; }
  &__try { align-items: center; > * { flex: 0 0 auto; } }

  &__always { display: flex; align-items: center; gap: var(--dev-space-2); margin: 0 0 var(--dev-space-3); font-size: 13px; .icon { color: var(--success); } }
  &__trigger { display: flex; flex-direction: column; gap: var(--dev-space-2); padding: var(--dev-space-2) 0 var(--dev-space-3); border-top: 1px solid var(--border); }

  &__modal-note { font-size: 12px; font-weight: 400; }

  &__kinds { display: flex; gap: var(--dev-space-3); flex-wrap: wrap; }

  &__kind {
    flex:          1 1 260px;
    display:       flex;
    align-items:   flex-start;
    gap:           var(--dev-space-2);
    margin:        0;
    padding:       var(--dev-space-3);
    border:        1px solid var(--border);
    border-radius: var(--r-sm);
    font-size:     12px;
    cursor:        pointer;

    input { margin-top: 2px; }
    strong { font-size: 13px; }
    &--on { border-color: var(--dev-accent); background: color-mix(in srgb, var(--dev-accent) 6%, transparent); }
  }

  &__script { min-height: 200px; }
  &__timeout { align-items: flex-start; > :first-child { flex: 0 0 180px; } }
  &__source { flex: 0 0 180px !important; }

  &__names { display: flex; flex-wrap: wrap; gap: 4px; }

  &__name {
    min-height:    0;
    padding:       1px 8px;
    border:        1px solid var(--border);
    border-radius: var(--r-md);
    background:    transparent;
    color:         var(--muted);
    font-family:   monospace;
    font-size:     11px;
    line-height:   1.5;
    cursor:        pointer;

    &:hover { color: var(--body-text); }
    &--on { color: var(--dev-accent); border-color: var(--dev-accent); }
    &--covered { color: var(--dev-accent); border-style: dashed; border-color: color-mix(in srgb, var(--dev-accent) 60%, var(--border)); }
  }

  &__tried {
    list-style: none;
    margin:     0;
    padding:    0;
    display:    flex;
    flex-direction: column;
    gap:        3px;
    font-size:  12px;

    li { display: grid; grid-template-columns: 76px auto minmax(0, 1fr) minmax(0, 1.4fr); gap: var(--dev-space-2); align-items: baseline; }
    strong { font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; margin-right: 4px; }
  }

  &__tried-when { color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
  &__tried-subject { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-family: monospace; font-size: 11px; }
  &__tried-why { color: var(--muted); overflow-wrap: anywhere; code { color: var(--body-text); } }
  &__tried--run strong { color: var(--success); }
  &__tried--blocked strong { color: var(--warning); }
  &__tried--error strong { color: var(--error); }
  &__modal-body { flex: 1 1 auto; margin: 0; padding: 14px 18px; border: 0; border-radius: 0; background: transparent; overflow: auto; font-size: 12px; white-space: pre-wrap; word-break: break-word; }
}

/* ── Phones: the form is one column and the buttons are full width. ── */
@media (max-width: 760px) {
  .agent-edit {
    &__row { flex-direction: column; align-items: stretch; }
    &__row > * { flex: 1 1 auto; }
    &__actions { flex-direction: column-reverse; }
    &__actions > * { width: 100%; }
    &__suggest { width: 100%; min-width: 0; }
    &__tried li { grid-template-columns: 1fr; gap: 0; }
  }
}
</style>
