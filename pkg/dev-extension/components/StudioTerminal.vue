<script>
// A pane onto Extension Studio's agent pod, drawn by the Studio's own terminal.
//
// This extension shows terminals in three places - a workspace's conversation list, the review
// agent docked over a pull request, a discussion under one review comment - and every one of
// them opens on the same pod, the Studio's agent, through the same exec subresource and the same
// session cookie. So they are the same component: the Studio hands its PodTerminal over on
// `window.__extensionStudio` (see conversations.ts, studioApi) and this puts it where it is
// wanted and says what it should run. What is *not* here is a terminal: the socket protocol,
// the reconnect, the image paste and the clickable paths all live in one place, the Studio.
//
// `command` is the argv the pane runs, from the Studio's own `agent.command(id)` when it is a
// conversation and spelled out by the caller when it is something else - a kubectl exec into
// a workspace's own pod, say. `session` is the conversation id, for the Studio's default argv.
import { Banner } from '@components/Banner';
import { waitForStudio, STUDIO_API_SINCE } from '../conversations';

export default {
  name: 'StudioTerminal',

  components: { Banner },

  emits: ['state'],

  props: {
    /** The conversation this pane attaches to; the Studio derives the argv from it. */
    session: {
      type:    String,
      default: '',
    },

    /** What to exec instead, when it is not one of the Studio's own conversations. */
    command: {
      type:    Array,
      default: null,
    },

    /** claude, or a plain shell. Only read when `command` is not given. */
    mode: {
      type:    String,
      default: 'claude',
    },
  },

  data() {
    return {
      // The Studio's API once its bundle has loaded; null while waiting, false once given up.
      studio:  null,
      waited:  false,
    };
  },

  computed: {
    terminal() {
      return this.studio?.terminal?.component || null;
    },

    argv() {
      if (this.command?.length) {
        return this.command;
      }

      return this.studio && this.session ? this.studio.agent.command(this.session, this.mode) : null;
    },

    missing() {
      return this.waited && !this.terminal;
    },

    since() {
      return STUDIO_API_SINCE;
    },
  },

  async mounted() {
    this.studio = await waitForStudio();
    this.waited = true;

    if (!this.studio) {
      this.$emit('state', 'closed');
    }
  },

  methods: {
    onState(state) {
      this.$emit('state', state);
    },
  },
};
</script>

<template>
  <div class="studio-terminal">
    <Banner
      v-if="missing"
      color="warning"
      class="studio-terminal__missing"
    >
      Extension Studio {{ since }} or later is not loaded in this dashboard, and it is what draws the terminals here.
      Install or upgrade the <b>extension-studio</b> extension, then reload.
    </Banner>
    <component
      :is="terminal"
      v-else-if="terminal && argv"
      target="agent"
      :session="session || 'agent-1'"
      :command="argv"
      :mode="mode"
      class="studio-terminal__pane"
      @state="onState"
    />
    <div
      v-else
      class="studio-terminal__waiting text-muted"
    >
      <i class="icon icon-spinner icon-spin" /> Waiting for Extension Studio
    </div>
  </div>
</template>

<style lang="scss" scoped>
  .studio-terminal {
    display:        flex;
    flex-direction: column;
    flex:           1 1 auto;
    min-height:     0;
    min-width:      0;

    &__pane {
      flex:       1 1 auto;
      min-height: 0;
    }

    &__waiting {
      display:     flex;
      align-items: center;
      gap:         var(--dev-space-3);
      padding:     var(--dev-space-4);
    }

    &__missing { margin: var(--dev-space-4); }
  }
</style>
