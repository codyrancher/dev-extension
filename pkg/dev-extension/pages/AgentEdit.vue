<script>
// Making or changing an agent: what it runs, where, and what sets it off. See agent-defs.ts.
import { Banner } from '@components/Banner';
import AsyncButton from '@shell/components/AsyncButton';
import LabeledSelect from '@shell/components/form/LabeledSelect';
import { LabeledInput } from '@components/Form/LabeledInput';
import { Checkbox } from '@components/Form/Checkbox';
import { RcButton } from '@components/RcButton';
import {
  getAgent, saveAgent, validName, cronValid, CRON_PRESETS
} from '../agent-defs';
import { listAllWorkspaces } from '../api';
import { listApps } from '../apps';
import { AGENT_SEED } from '../agent-seed.generated';
import {
  DEV_PRODUCT, BLANK_CLUSTER, AGENTS_ROUTE, DEFAULT_APP, DEV_API_IN_CLUSTER
} from '../config/constants';

const TRIGGERS = [
  { value: 'manual', label: 'By hand (Run now on its card)' },
  { value: 'cron', label: 'On a schedule (cron)' },
  { value: 'api', label: 'On an API call' },
  { value: 'resource', label: 'When a resource changes (coming next; kept, not yet fired)' },
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
        workspace:   { mode: 'new', name: '', app: DEFAULT_APP, prefix: '' },
        trigger:     { type: 'manual', cron: '0 9 * * 1-5', resource: { type: '', namespace: '', event: 'any' } },
        enabled:     true,
      },
      editing:    false,
      workspaces: [],
      apps:       [],
      error:      '',
      TRIGGERS,
      CRON_PRESETS,
    };
  },

  computed: {
    skills() {
      return Object.keys(AGENT_SEED)
        .map((k) => /^skills\/([^/]+)\/SKILL\.md(\.hbs)?$/.exec(k)?.[1])
        .filter(Boolean)
        .sort();
    },

    skillOptions() {
      return [{ value: '', label: 'Insert a skill…' }, ...this.skills.map((s) => ({ value: s, label: `/${ s }` }))];
    },

    workspaceOptions() {
      return this.workspaces.map((w) => ({ value: w.name, label: w.name }));
    },

    appOptions() {
      return this.apps.filter((a) => a.workspace).map((a) => ({ value: a.id, label: a.label || a.id }));
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
      if (this.def.workspace.mode === 'existing' && !this.def.workspace.name) {
        out.push('Pick the workspace it runs in.');
      }
      if (this.def.trigger.type === 'cron' && !cronValid(this.def.trigger.cron)) {
        out.push('The schedule is five cron fields: minute hour day month weekday.');
      }

      return out;
    },

    backTo() {
      return { name: AGENTS_ROUTE, params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER } };
    },
  },

  async fetch() {
    const name = this.$route.params.name;

    [this.workspaces, this.apps] = await Promise.all([
      listAllWorkspaces().catch(() => []),
      listApps(this.$store).catch(() => []),
    ]);
    this.workspaces = this.workspaces.filter((w) => !w.preview);

    if (name) {
      const found = await getAgent(name).catch(() => null);

      if (found) {
        this.def = {
          ...this.def,
          ...found,
          workspace: { ...this.def.workspace, ...(found.workspace || {}) },
          trigger:   { ...this.def.trigger, ...(found.trigger || {}), resource: { ...this.def.trigger.resource, ...(found.trigger?.resource || {}) } },
        };
        this.editing = true;
      }
    }
  },

  methods: {
    insertSkill(name) {
      if (!name) {
        return;
      }
      this.def.prompt = `/${ name } ${ this.def.prompt.replace(/^\s*\/[a-z0-9-]+\s*/i, '') }`.trimEnd() + (this.def.prompt.trim() ? '' : ' ');
    },

    preset(cron) {
      this.def.trigger.cron = cron;
    },

    async save(done) {
      this.error = '';
      if (this.problems.length) {
        this.error = this.problems.join(' ');
        done(false);

        return;
      }
      try {
        const def = JSON.parse(JSON.stringify(this.def));

        def.name = def.name.trim().toLowerCase();
        if (def.trigger.type !== 'cron') {
          delete def.trigger.cron;
        }
        if (def.trigger.type !== 'resource') {
          delete def.trigger.resource;
        }
        await saveAgent(def);
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
        A conversation that starts itself: what it opens with, where it runs, and what sets it off. Every run is an ordinary conversation in a workspace, with the PR and Review tabs to match.
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
      <div class="agent-edit__row">
        <LabeledSelect
          :value="''"
          :options="skillOptions"
          label="Skill"
          class="agent-edit__skill"
          @update:value="insertSkill"
        />
        <span class="text-muted agent-edit__hint">The skills the workspaces carry (the harness's). Picking one puts its invocation at the front of the prompt.</span>
      </div>
      <label class="agent-edit__label">Prompt - what the conversation opens with</label>
      <textarea
        v-model="def.prompt"
        class="agent-edit__prompt"
        rows="6"
        placeholder="/my-pr-full-review Review rancher/dashboard PR #<n> — harness portal context, file through $CLAUDE_HARNESS_API/my-work/pr/<n>."
      />
    </section>

    <section class="agent-edit__section">
      <h3>Where it runs</h3>
      <div class="agent-edit__choices">
        <label class="agent-edit__choice">
          <input
            v-model="def.workspace.mode"
            type="radio"
            value="new"
          >
          <span>A new workspace each run</span>
        </label>
        <label class="agent-edit__choice">
          <input
            v-model="def.workspace.mode"
            type="radio"
            value="existing"
          >
          <span>An existing workspace</span>
        </label>
      </div>
      <div
        v-if="def.workspace.mode === 'new'"
        class="agent-edit__row"
      >
        <LabeledSelect
          v-model:value="def.workspace.app"
          :options="appOptions"
          label="App"
        />
        <LabeledInput
          v-model:value="def.workspace.prefix"
          label="Workspace name prefix"
          :placeholder="def.name || 'agent'"
        />
      </div>
      <LabeledSelect
        v-else
        v-model:value="def.workspace.name"
        :options="workspaceOptions"
        label="Workspace"
      />
    </section>

    <section class="agent-edit__section">
      <h3>What sets it off</h3>
      <LabeledSelect
        v-model:value="def.trigger.type"
        :options="TRIGGERS"
        label="Trigger"
      />
      <template v-if="def.trigger.type === 'cron'">
        <LabeledInput
          v-model:value="def.trigger.cron"
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
      <template v-else-if="def.trigger.type === 'api'">
        <p class="agent-edit__hint">
          Anything in the cluster starts a run with:
        </p>
        <pre class="agent-edit__code">curl -s -X POST {{ apiUrl }} -H 'Content-Type: application/json' -d '{"note":"why"}'</pre>
        <p class="text-muted agent-edit__hint">
          The run is recorded at once and started by the next dashboard tick.
        </p>
      </template>
      <template v-else-if="def.trigger.type === 'resource'">
        <div class="agent-edit__row">
          <LabeledInput
            v-model:value="def.trigger.resource.type"
            label="Resource type"
            placeholder="management.cattle.io.cluster"
          />
          <LabeledInput
            v-model:value="def.trigger.resource.namespace"
            label="Namespace (optional)"
          />
          <LabeledSelect
            v-model:value="def.trigger.resource.event"
            :options="[{ value: 'any', label: 'any change' }, { value: 'created', label: 'created' }, { value: 'updated', label: 'updated' }, { value: 'deleted', label: 'deleted' }]"
            label="On"
          />
        </div>
        <p class="text-muted agent-edit__hint">
          Kept with the agent; the watcher that fires it is the next piece of this.
        </p>
      </template>
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
</style>
