<script>
// Making or changing an agent: what it runs, and what sets it off. Every run is a conversation
// in the agents drawer, here on this cluster (agent-defs.ts, drive).
import { Banner } from '@components/Banner';
import AsyncButton from '@shell/components/AsyncButton';
import LabeledSelect from '@shell/components/form/LabeledSelect';
import { LabeledInput } from '@components/Form/LabeledInput';
import { Checkbox } from '@components/Form/Checkbox';
import { RcButton } from '@components/RcButton';
import {
  getAgent, saveAgent, validName, cronValid, CRON_PRESETS, triggersOf
} from '../agent-defs';
import { AGENT_SEED } from '../agent-seed.generated';
import {
  DEV_PRODUCT, BLANK_CLUSTER, AGENTS_ROUTE, DEV_API_IN_CLUSTER
} from '../config/constants';

const EVENTS = [
  { value: 'any', label: 'any change' }, { value: 'created', label: 'created' }, { value: 'updated', label: 'updated' }, { value: 'deleted', label: 'deleted' },
];

export default {
  name: 'AgentEdit',

  components: {
    Banner, AsyncButton, LabeledSelect, LabeledInput, Checkbox, RcButton
  },

  data() {
    return {
      def: {
        name:        '',
        description: '',
        prompt:      '',
        enabled:     true,
      },
      // The triggers, as a form: by hand is always there; the rest are ticked on.
      on:       { cron: false, api: false, resource: false },
      cron:     '0 9 * * 1-5',
      resource: { type: '', namespace: '', event: 'any' },
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
    /** The skills the agents carry (the harness's), by name. */
    skills() {
      return Object.keys(AGENT_SEED)
        .map((k) => /^skills\/([^/]+)\/SKILL\.md(\.hbs)?$/.exec(k)?.[1])
        .filter(Boolean)
        .sort();
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
      if (!this.def.prompt.trim()) {
        out.push('Say what the conversation should open with.');
      }
      if (this.on.cron && !cronValid(this.cron)) {
        out.push('The schedule is five cron fields: minute hour day month weekday.');
      }
      if (this.on.resource && !this.resource.type.trim()) {
        out.push('Say which resource type sets it off.');
      }

      return out;
    },

    backTo() {
      return { name: AGENTS_ROUTE, params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER } };
    },
  },

  watch: {
    suggestions() {
      this.cursor = 0;
    },
  },

  async fetch() {
    const name = this.$route.params.name;

    if (name) {
      const found = await getAgent(name).catch(() => null);

      if (found) {
        this.def = {
          name: found.name, description: found.description || '', prompt: found.prompt || '', enabled: found.enabled !== false,
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

    showSkill(name) {
      const text = AGENT_SEED[`skills/${ name }/SKILL.md`] || AGENT_SEED[`skills/${ name }/SKILL.md.hbs`] || '';

      this.doc = { name, text: text || `There is no skill called /${ name } in this dashboard's seed.` };
    },

    preset(cron) {
      this.cron = cron;
    },

    async save(done) {
      this.error = '';
      if (this.problems.length) {
        this.error = this.problems.join(' ');
        done(false);

        return;
      }
      try {
        const triggers = [{ type: 'manual' }];

        if (this.on.cron) {
          triggers.push({ type: 'cron', cron: this.cron.trim() });
        }
        if (this.on.api) {
          triggers.push({ type: 'api' });
        }
        if (this.on.resource) {
          triggers.push({ type: 'resource', resource: { ...this.resource, type: this.resource.type.trim() } });
        }
        await saveAgent({
          ...JSON.parse(JSON.stringify(this.def)), name: this.def.name.trim().toLowerCase(), triggers,
        });
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
  <div class="agent-edit">
    <header class="agent-edit__head">
      <h1>{{ editing ? `Edit ${ def.name }` : 'New agent' }}</h1>
      <p class="text-muted">
        A conversation that starts itself, in the agents drawer: what it opens with, and what sets it off.
      </p>
    </header>

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
      <h3>What it runs</h3>
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
    </section>

    <section class="agent-edit__section">
      <h3>What sets it off</h3>
      <p class="agent-edit__always">
        <i class="icon icon-checkmark" /> By hand - Run now on its card, always.
      </p>
      <div class="agent-edit__trigger">
        <Checkbox
          v-model:value="on.cron"
          label="On a schedule"
        />
        <template v-if="on.cron">
          <LabeledInput
            v-model:value="cron"
            label="Schedule (cron, five fields, this browser's local time)"
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
            The clock is a dashboard with this product open. Nothing runs while none is; a run that was due then is not made up.
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
            Anything in the cluster can call it. The run is recorded at once and started by the next dashboard tick.
          </p>
        </template>
      </div>
      <div class="agent-edit__trigger">
        <Checkbox
          v-model:value="on.resource"
          label="When a resource changes (kept with the agent; the watcher that fires it is the next piece)"
        />
        <div
          v-if="on.resource"
          class="agent-edit__row"
        >
          <LabeledInput
            v-model:value="resource.type"
            label="Resource type"
            placeholder="management.cattle.io.cluster"
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
      </div>
      <Checkbox
        v-model:value="def.enabled"
        label="Enabled - a disabled agent keeps its definition and history and starts nothing"
      />
    </section>

    <div class="agent-edit__actions">
      <RcButton
        variant="tertiary"
        :to="backTo"
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

    <Teleport to="body">
      <div
        v-if="doc"
        class="agent-edit__modal"
        role="dialog"
        aria-modal="true"
        @click.self="doc = null"
      >
        <div class="agent-edit__modal-panel">
          <header class="agent-edit__modal-head">
            <code>/{{ doc.name }}</code>
            <span class="text-muted">the skill, as the agents carry it</span>
            <button
              type="button"
              class="agent-edit__modal-close"
              title="Close"
              @click="doc = null"
            >
              &times;
            </button>
          </header>
          <pre class="agent-edit__modal-body">{{ doc.text }}</pre>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style lang="scss" scoped>
.agent-edit {
  max-width: 860px;
  padding:   var(--dev-space-4) var(--dev-space-5) var(--dev-space-6);

  h1 { margin: 0 0 4px; font-size: 20px; }
  h3 { margin: 0 0 var(--dev-space-3); font-size: 14px; }

  &__head { margin-bottom: var(--dev-space-4); }

  &__section {
    display:        flex;
    flex-direction: column;
    gap:            var(--dev-space-3);
    padding:        var(--dev-space-4);
    margin-bottom:  var(--dev-space-4);
    border:         1px solid var(--border);
    border-radius:  var(--border-radius);
  }

  &__row { display: flex; gap: var(--dev-space-3); align-items: flex-end; flex-wrap: wrap; > * { flex: 1 1 220px; } }
  &__skill { flex: 0 1 320px; }
  &__hint { font-size: 12px; margin: 0; flex: 1 1 100%; }
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
    border-radius: var(--border-radius);
    resize:        vertical;
  }

  &__choices { display: flex; gap: var(--dev-space-5); }
  &__choice { display: flex; align-items: center; gap: var(--dev-space-2); font-size: 13px; cursor: pointer; }

  &__presets { display: flex; flex-wrap: wrap; gap: var(--dev-space-2); }
  &__preset {
    min-height:    0;
    padding:       3px 10px;
    font-size:     12px;
    border-radius: 12px;
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
    border-radius: var(--border-radius);
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
    border-radius: var(--border-radius);
    box-shadow:    0 8px 24px rgba(0, 0, 0, 0.25);
    font-family:   monospace;
    font-size:     13px;

    li { padding: 4px 12px; cursor: pointer; }
    li:hover, &--on { background: var(--accent-btn); color: var(--link); }
  }

  &__always { display: flex; align-items: center; gap: var(--dev-space-2); margin: 0 0 var(--dev-space-3); font-size: 13px; .icon { color: var(--success); } }
  &__trigger { display: flex; flex-direction: column; gap: var(--dev-space-2); padding: var(--dev-space-2) 0 var(--dev-space-3); border-top: 1px solid var(--border); }

  &__modal {
    position:        fixed;
    inset:           0;
    z-index:         3000;
    background:      rgba(0, 0, 0, 0.6);
    display:         flex;
    align-items:     center;
    justify-content: center;
    padding:         24px;
  }

  &__modal-panel {
    width:          min(900px, 96vw);
    height:         min(80vh, 900px);
    display:        flex;
    flex-direction: column;
    background:     var(--body-bg);
    color:          var(--body-text);
    border:         1px solid var(--border);
    border-radius:  10px;
    box-shadow:     0 12px 40px rgba(0, 0, 0, 0.45);
    overflow:       hidden;
  }

  &__modal-head { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--border); font-size: 12px; }
  &__modal-close { margin-left: auto; min-height: 0; height: 26px; padding: 0 8px; border: 1px solid var(--border); border-radius: 6px; background: transparent; color: var(--body-text); font-size: 18px; line-height: 24px; cursor: pointer; }
  &__modal-body { flex: 1 1 auto; margin: 0; padding: 14px 18px; overflow: auto; font-size: 12px; white-space: pre-wrap; word-break: break-word; }
}
</style>
