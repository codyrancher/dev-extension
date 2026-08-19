<script>
// One terminal in Rancher's window manager drawer.
//
// The window manager owns the tab strip, the close buttons, the drag handle and keeping this
// alive across navigation. What is left for this component is the pane itself, which is the
// same DevTerminal the rest of the product uses, pointed at the dev server's pod with this
// tab's own tmux session.
//
// It is wrapped in the shell's own Window, which is what Rancher's container shell and logs
// use, so the strip along the bottom is in the place and the styling someone already expects
// per-tab controls to be in.
import Window from '@shell/components/Window/Window';
import DevTerminal from './DevTerminal.vue';
import { openTerminal } from '../terminals';

/**
 * The window manager's own tab strip, by the id the shell gives its bottom panel.
 *
 * Not `.tabs` on its own: that class is Rancher's for every tabbed thing on the page, including
 * the workspace's own tab strip, and a teleport to it would land the plus wherever the first one
 * happened to be.
 */
const STRIP = '#horizontal-window-manager .tabs';

export default {
  name: 'DevTerminalTab',

  components: { Window, DevTerminal },

  props: {
    // The window manager's own description of this tab.
    tab: {
      type:     Object,
      required: true,
    },

    // Whether the drawer is showing this tab rather than one of its siblings.
    active: {
      type:     Boolean,
      default:  false,
    },

    // Everything below arrives from the tab's attrs (see terminals.ts).
    session: {
      type:     String,
      required: true,
    },

    number: {
      type:     Number,
      required: true,
    },

    namespace: {
      type:     String,
      required: true,
    },

    labels: {
      type:     Object,
      required: true,
    },

    container: {
      type:     String,
      required: true,
    },
  },

  computed: {
    /**
     * What the exec runs: the pod's own tab entrypoint, with this terminal's session and a
     * directory of its own, which is what makes it a conversation of its own.
     */
    command() {
      return ['/bin/sh', '/seed/shell.sh', this.session, `/app/.sessions/${ this.session }`];
    },
  },

  data() {
    return {
      // The teleport's target, in data so the template can name it.
      STRIP,
      stripTimer: null,
      // Whether the tab strip is on the page yet. The teleport below needs its target to exist
      // when it renders, and this component is itself teleported into the panel, so the first
      // render can happen before the strip is there.
      striped: false,
    };
  },

  watch: {
    // A tab becoming the active one is the other moment the strip can appear, and the first tab
    // in a fresh drawer is mounted before the panel around it exists.
    active() {
      this.findStrip();
    },
  },

  mounted() {
    this.findStrip();
  },

  beforeUnmount() {
    clearTimeout(this.stripTimer);
  },

  methods: {
    /**
     * Wait for the tab strip to exist, then let the teleport render into it.
     *
     * This component is itself teleported into the panel, and on the first terminal of a session
     * that happens as the panel is being built: a single nextTick is sometimes too early, and a
     * teleport whose target is missing renders nothing and does not try again. So it looks a few
     * times and then stops, which is the difference between a plus that appears and one that
     * appears only on the second terminal.
     */
    findStrip(attempt = 0) {
      clearTimeout(this.stripTimer);
      this.striped = !!document.querySelector(STRIP);

      if (!this.striped && attempt < 10) {
        this.stripTimer = setTimeout(() => this.findStrip(attempt + 1), 100);
      }
    },

    /**
     * Add another terminal, from the end of the tab strip.
     *
     * Where the harness puts it, and where a plus belongs: beside the things it makes another of.
     * The window manager's strip is the shell's own and has no slot, so this is a teleport into
     * it rather than a component the shell renders. Only the active tab draws one, or there would
     * be a plus per terminal stacked on top of each other.
     */
    newTerminal() {
      openTerminal(this.$store);
    },
  },
};
</script>

<template>
  <Window :active="active">
    <template #title>
      <div class="dev-terminal-tab__bar">
        <span class="dev-terminal-tab__session">
          Terminal {{ number }}, session <code>{{ session }}</code> in the dev server's pod.
          Closing this tab leaves it running.
        </span>
      </div>
    </template>
    <template #body>
      <!--
        The plus, at the end of the strip the tabs are in. Inside the body slot rather than beside
        it: Window renders the slots it names and nothing else, so a teleport sitting as a bare
        child of it is never rendered at all and the plus never appears. See newTerminal.
      -->
      <Teleport
        v-if="active && striped"
        :to="STRIP"
      >
        <button
          v-clean-tooltip="'New terminal'"
          type="button"
          class="dev-terminal-tab__new"
          aria-label="New terminal"
          @click="newTerminal"
        >
          <i class="icon icon-plus" />
        </button>
      </Teleport>
      <DevTerminal
        class="dev-terminal-tab__terminal"
        :namespace="namespace"
        :labels="labels"
        :container="container"
        :command="command"
      />
    </template>
  </Window>
</template>

<style lang="scss">
  // Not scoped to the component's own tree: the plus is teleported into the shell's tab strip,
  // which is outside it, so a scoped rule would not reach it.
  .dev-terminal-tab__new {
    display:         flex;
    align-items:     center;
    justify-content: center;
    width:           28px;
    min-height:      0;
    margin:          0;
    padding:         0;
    border:          none;
    background:      transparent;
    color:           var(--body-text);
    cursor:          pointer;

    &:hover {
      color: var(--primary);
    }
  }

  .dev-terminal-tab {
    &__bar {
      display:     flex;
      align-items: center;
      gap:         10px;
      height:      100%;
    }

    &__session {
      color:     var(--muted);
      font-size: 12px;

      code {
        padding:     1px 4px;
        background:  transparent;
        font-family: monospace;
      }
    }

    &__terminal {
      height: 100%;
      // The drawer supplies the frame, so the pane inside it does not need a second one.
      border: none;
    }
  }
</style>
