<script>
// What a leased workspace has attached, and the two buttons that change it.
//
// A leased (`lte-`) workspace holds the work and runs nothing: a dev server, a storybook, a
// Rancher and a browser are attached while the work needs them and released when it does not.
// This is that list, and it is a component of its own because both views onto a workspace need
// it - the stage rail, which only exists for a workspace named after an issue or a pull request,
// and the tabbed view, which is what everything else gets.
//
// Every button here is one call to dev-api, which is also what the agent's `tools` command
// calls. So a dev server attached from a conversation appears on this list, and one released
// here is gone for the agent too; there is no second path that can drift.
import {
  workspaceTools, startTool, stopTool, renewTool, toolHref, toolState, TOOLS, TOOL_ORDER
} from '../tools';
import { DEFAULT_LEASE_MINUTES } from '../config/constants';

export default {
  name: 'WorkspaceTools',

  props: {
    /** The workspace's name. */
    workspace: {
      type:     String,
      required: true,
    },

    /**
     * Whether this workspace's stage has nothing to serve - a fix waiting on a reviewer, or one
     * already merged. The dev server is released once when it becomes true, because a webpack
     * compiling for somebody who is not coming back is the most expensive idle thing on the
     * node. Never against a person who has just attached one: see `kept` below.
     */
    idleStage: {
      type:    Boolean,
      default: false,
    },
  },

  emits: ['notice', 'error'],

  data() {
    return {
      tools:    [],
      busy:     '',
      /** Whether this visit has already released the dev server for a stage that cannot use it. */
      released: false,
      timer:    null,
    };
  },

  computed: {
    /**
     * Every kind, running or not, in the order they are offered.
     *
     * All four are listed whether or not they are attached, because the list's job is as much to
     * say what *can* be attached as what is: the agent knows the four, and the person looking at
     * the page should not have to.
     */
    rows() {
      return TOOL_ORDER.map((kind) => {
        const tool = this.tools.find((t) => t.kind === kind) || { kind, workspace: this.workspace, running: false };

        return {
          ...TOOLS[kind], kind, tool, state: toolState(tool), href: toolHref(tool),
        };
      });
    },
  },

  watch: {
    idleStage() {
      this.releaseForStage();
    },
  },

  async fetch() {
    await this.read();
  },

  mounted() {
    // A tool that was just attached is still starting, and its lease is counting down while
    // nobody is pressing anything, so the list refreshes itself.
    this.timer = setInterval(() => this.read().catch(() => {}), 20000);
  },

  beforeUnmount() {
    clearInterval(this.timer);
  },

  methods: {
    async read() {
      if (!this.workspace) {
        return;
      }
      this.tools = await workspaceTools(this.workspace).catch(() => []);
      await this.releaseForStage();
    },

    /**
     * Attach one, or renew the lease on one that is already up.
     *
     * The lease is the point of the arrangement: a tool nobody releases goes by itself, so the
     * cost of forgetting is the rest of an hour and a half rather than the rest of the week.
     */
    async attach(kind) {
      this.busy = kind;
      try {
        const tool = await startTool(this.workspace, kind, DEFAULT_LEASE_MINUTES);

        this.replace(tool);
        this.$emit('notice', kind === 'browser'
          ? 'The browser tool is attached: a window and a session of its own on the shared browser.'
          : `The ${ TOOLS[kind].label.toLowerCase() } is starting, and is leased for ${ DEFAULT_LEASE_MINUTES } minutes.`);
        // It takes a moment to have a pod; read it back so the row stops saying "starting" by
        // itself rather than on the next visit.
        setTimeout(() => this.read().catch(() => {}), 4000);
      } catch (e) {
        this.$emit('error', e);
      } finally {
        this.busy = '';
      }
    },

    /** Give it back. Everything it was holding goes with its namespace. */
    async release(kind) {
      this.busy = kind;
      try {
        await stopTool(this.workspace, kind);
        this.replace({ kind, workspace: this.workspace, running: false });
        this.$emit('notice', `The ${ TOOLS[kind].label.toLowerCase() } is released.`);
      } catch (e) {
        this.$emit('error', e);
      } finally {
        this.busy = '';
      }
    },

    /** Another lease's worth, for work that is not finished. */
    async extend(kind) {
      this.busy = kind;
      try {
        this.replace(await renewTool(this.workspace, kind, DEFAULT_LEASE_MINUTES));
      } catch (e) {
        this.$emit('error', e);
      } finally {
        this.busy = '';
      }
    },

    replace(tool) {
      this.tools = [...this.tools.filter((t) => t.kind !== tool.kind), tool];
    },

    /** Release the dev server for a stage that cannot use it, once per visit. */
    async releaseForStage() {
      const server = this.tools.find((tool) => tool.kind === 'dev-server');
      let kept = false;

      try {
        kept = !!sessionStorage.getItem(`dev-extension.dev-server-kept.${ this.workspace }`);
      } catch { /* no storage: the release applies, which is the cheaper default */ }

      if (kept || this.released || !this.idleStage || !server?.running) {
        return;
      }
      this.released = true;
      try {
        await stopTool(this.workspace, 'dev-server');
        this.replace({ kind: 'dev-server', workspace: this.workspace, running: false });
        this.$emit('notice', 'The dev server is released while this waits on a reviewer; attach it again when you need it.');
      } catch (e) {
        console.debug(`[tools] releasing the dev server: ${ e?.message || e }`); // eslint-disable-line no-console
      }
    },
  },
};
</script>

<template>
  <div class="workspace-tools">
    <span class="workspace-tools__label">Tools</span>
    <div class="workspace-tools__rows">
      <div
        v-for="row in rows"
        :key="row.kind"
        class="workspace-tools__row"
        :class="{ 'workspace-tools__row--up': row.tool.running }"
        :title="row.what"
      >
        <i
          class="icon workspace-tools__icon"
          :class="row.icon"
        />
        <span class="workspace-tools__name">{{ row.label }}</span>
        <span class="workspace-tools__state">{{ row.state }}</span>
        <a
          v-if="row.href && row.tool.ready"
          :href="row.href"
          target="_blank"
          rel="noopener noreferrer"
          class="workspace-tools__link"
        >Open</a>
        <button
          v-if="row.tool.running"
          class="workspace-tools__link"
          :disabled="!!busy"
          title="Another lease's worth, for work that is not finished."
          @click="extend(row.kind)"
        >
          Renew
        </button>
        <button
          v-if="row.tool.running"
          class="workspace-tools__link"
          :disabled="!!busy"
          title="Give it back now. Everything it was holding goes with it."
          @click="release(row.kind)"
        >
          Release
        </button>
        <button
          v-else
          class="workspace-tools__link"
          :disabled="!!busy"
          :title="row.what"
          @click="attach(row.kind)"
        >
          Attach
        </button>
        <i
          v-if="busy === row.kind"
          class="icon icon-spinner icon-spin"
        />
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.workspace-tools {
  display:        flex;
  flex-direction: column;
  gap:            8px;
  padding:        10px 12px;
  border:         1px solid var(--border);
  border-radius:  var(--border-radius);
  background:     var(--box-bg);

  &__label {
    font-size:      11px;
    font-weight:    700;
    letter-spacing: .06em;
    text-transform: uppercase;
    color:          var(--input-label);
  }

  &__rows {
    display:        flex;
    flex-direction: column;
    gap:            2px;
    width:          100%;
  }

  &__row {
    display:     flex;
    align-items: center;
    gap:         8px;
    padding:     3px 0;
    font-size:   12px;
    color:       var(--input-label);

    // Attached is the state worth reading off the list at a glance, because it is the one that
    // is costing something.
    &--up {
      color: var(--body-text);

      .workspace-tools__name { font-weight: 600; }
    }
  }

  &__icon {
    font-size:  14px;
    width:      16px;
    text-align: center;
  }

  &__name { min-width: 76px; }

  &__state {
    flex:          1;
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
    opacity:       .8;
  }

  &__link {
    background: none;
    border:     none;
    padding:    0;
    font-size:  12px;
    color:      var(--link);
    cursor:     pointer;

    &:hover { text-decoration: underline; }

    &:disabled {
      opacity: .5;
      cursor:  default;
    }
  }
}
</style>
