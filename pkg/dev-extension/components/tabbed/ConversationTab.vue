<script>
// What one conversation's tab shows: a dot for what its agent is doing, its title (renamed in
// place), and a rename and a close control. Deliberately identical to the agents panel's own tab
// (AgentPanel, in the agents extension) - the same dot, the same two controls in the same places -
// so the stage's conversation tabs and the drawer's read as one thing.
//
// The larger view and the fork are in the tab's own menu, which is what the caret opens -
// right-click opens the same list, so the gesture that used to pop the conversation out still
// works and now says what else it can do. It was a bare right-click with nothing on screen to
// advertise it, which is fine for one hidden action and no good at all for two.
//
// It goes in ConversationTabbed's `tab-header` slot. Purely presentational: it emits, and the page
// that owns the conversation does the renaming, popping and ending, because those are API calls.
import { agentLabel } from '../../workspace-status';
import { cliMark } from '../../agent-clis.mjs';
import CliMark from '../CliMark.vue';
import TabMenu from './TabMenu.vue';

export default {
  name: 'ConversationTab',

  components: { CliMark, TabMenu },

  emits: ['rename', 'popout', 'close', 'fork'],

  props: {
    /** The conversation this tab is for: `{ title }` is all it reads. */
    conversation: {
      type:     Object,
      required: true,
    },

    /** The agent's state, for the dot. 'none' draws none. */
    agent: {
      type:    String,
      default: 'none',
    },

    /** Whether this is the tab on show: its controls are drawn, so inactive tabs stay quiet. */
    active: {
      type:    Boolean,
      default: false,
    },

    /**
     * Which CLI holds this conversation, for the mark beside the dot. '' draws none.
     *
     * The dot says what the pane is DOING; this says what it IS, which you cannot otherwise
     * tell without opening the tab - and with two CLIs in one strip that is the first thing you
     * want to know. Absent for a conversation that has never run, because nothing has decided
     * yet.
     */
    cli: {
      type:    String,
      default: '',
    },

    /**
     * Which of the menu's actions this host offers, in the order they are listed.
     *
     * A prop because the two strips are not the same: a workspace's stage can open a
     * conversation over the page and the drawer cannot - it IS the thing over the page - so a
     * "Open it larger" there would be a row that did nothing. Default is both, which is the
     * stage; the drawer passes the one it has.
     */
    actions: {
      type:    Array,
      default: () => ['popout', 'fork'],
    },

    /** Something chosen from this tab's menu is still running; the caret says so. */
    busy: {
      type:    Boolean,
      default: false,
    },
  },

  data() {
    return {
      renaming: false,
      draft:    '',
    };
  },

  computed: {
    label() {
      return agentLabel(this.agent);
    },

    title() {
      return this.conversation.title || 'Conversation';
    },

    /** The CLI's mark, or '' for a conversation whose CLI nothing has decided. */
    mark() {
      return cliMark(this.cli || this.conversation.cli || '');
    },

    /**
     * The menu's rows, in the order the host asked for.
     *
     * Named here rather than passed in, so both strips call the same thing the same thing: a
     * drawer whose menu said "Branch it" and a stage whose menu said "Fork" would be two
     * features as far as anybody reading the product is concerned.
     */
    menu() {
      const rows = {
        popout: {
          id: 'popout', label: 'Open it larger', icon: 'icon-external-link', what: 'Show this conversation over the page',
        },
        fork: {
          id: 'fork', label: 'Fork from here', icon: 'icon-copy', what: 'A second conversation that starts with this one\'s history behind it',
        },
      };

      return (Array.isArray(this.actions) ? this.actions : []).map((id) => rows[id]).filter(Boolean);
    },
  },

  methods: {
    startRename() {
      this.renaming = true;
      this.draft = this.conversation.title || '';
      this.$nextTick(() => this.$refs.input?.focus?.());
    },

    commit() {
      if (!this.renaming) {
        return;
      }
      const title = this.draft.trim();

      this.renaming = false;
      if (title && title !== this.conversation.title) {
        this.$emit('rename', title);
      }
    },

    cancel() {
      this.renaming = false;
    },

    /** Right-click: the same list the caret opens, at the caret rather than at the pointer. */
    openMenu() {
      this.$refs.menu?.show?.();
    },

    /** One row chosen. The ids are the events, so a new row is a row and nothing else. */
    onMenu(id) {
      this.$emit(id);
    },
  },
};
</script>

<template>
  <!-- Right-click opens the tab's own menu, the caret below opens the same one, and the tab's
       click (in ConversationTabbed) still switches to it. -->
  <span
    class="conversation-tab"
    :class="{ 'conversation-tab--active': active }"
    @contextmenu.prevent.stop="openMenu"
  >
    <!--
      The name, double click to rename in place. The input swallows the clicks and keys it sits
      under so the tab does not select and the strip does not navigate while a name is typed.
    -->
    <input
      v-if="renaming"
      ref="input"
      v-model="draft"
      class="conversation-tab__rename"
      type="text"
      :aria-label="`Rename ${ title }`"
      @click.stop
      @mousedown.stop
      @dblclick.stop
      @keydown.enter.stop.prevent="commit"
      @keydown.esc.stop.prevent="cancel"
      @keydown.stop
      @blur="commit"
    >
    <template v-else>
      <!-- What the agent is doing, as a dot before the title - the agents panel's dot, exactly. -->
      <span
        v-if="agent && agent !== 'none'"
        class="conversation-tab__dot"
        :class="`conversation-tab__dot--${ agent }`"
        :title="label"
      />
      <CliMark
        v-if="mark"
        class="conversation-tab__cli"
        :mark="mark"
        :size="12"
      />
      <span
        class="conversation-tab__name"
        :title="title"
        @dblclick.stop.prevent="startRename"
      >{{ title }}</span>

      <!-- Rename, the tab's menu and close, on hover or focus, in reserved trailing space so the
           tab holds its width. All three sit at the tab's right edge, close outermost. -->
      <button
        v-clean-tooltip="'Rename'"
        type="button"
        class="conversation-tab__control conversation-tab__control--rename"
        aria-label="Rename conversation"
        @click.stop.prevent="startRename"
      >
        <i class="icon icon-edit" />
      </button>
      <TabMenu
        v-if="menu.length"
        ref="menu"
        class="conversation-tab__control conversation-tab__control--menu"
        :items="menu"
        :busy="busy"
        :aria-label="`Actions for ${ title }`"
        @select="onMenu"
      />
      <button
        v-clean-tooltip="'Close conversation'"
        type="button"
        class="conversation-tab__control conversation-tab__control--close"
        aria-label="Close conversation"
        @click.stop.prevent="$emit('close')"
      >
        <i class="icon icon-close" />
      </button>
    </template>
  </span>
</template>

<style lang="scss" scoped>
  .conversation-tab {
    position:    relative;
    display:     flex;
    align-items: center;
    min-width:   0;
    max-width:   200px;
    // Trailing room for the three controls (close at 4px, the menu's caret at 26px, rename at
    // 48px, each 20px wide), reserved so they can appear on hover without moving the label. It
    // was 48px for two; the third is the menu, which is what took the actions off a right-click
    // nothing advertised.
    padding-right: 70px;

    // The agent's state as a filled dot, coloured by how much it wants a person. The same 7px
    // circle and colours the agents panel's tabs use.
    &__dot {
      flex:          0 0 auto;
      width:         7px;
      height:        7px;
      margin-right:  6px;
      border-radius: 50%;
      background:    var(--status-idle);

      &--working {
        background: var(--status-working);
        // Opacity-only pulse: the dot keeps its size, so the title never moves.
        animation: conversation-tab-dot-pulse 1.4s ease-in-out infinite;
      }

      &--input    { background: var(--status-input); }
      &--finished { background: var(--status-done); }
      &--idle     { background: var(--status-idle); }
    }

    &__cli {
      flex:         0 0 auto;
      margin-right: 6px;
    }

    &__name {
      overflow:      hidden;
      text-overflow: ellipsis;
      white-space:   nowrap;
      min-width:     0;
    }

    &__rename {
      width:         100%;
      min-width:     80px;
      height:        22px;
      padding:       0 6px;
      border:        1px solid var(--border);
      border-radius: var(--dev-r-xs);
      background:    var(--body-bg);
      color:         var(--body-text);
      font-size:     13px;
    }

    // The controls: absolute in the reserved trailing space, hidden until the tab is on show or
    // the pointer/focus is on it. A 20px glyph at 0.6 opacity, full on a quiet hover surface -
    // the agents panel's tab-control, to the pixel.
    &__control {
      display:         none;
      position:        absolute;
      top:             50%;
      transform:       translateY(-50%);
      align-items:     center;
      justify-content: center;
      width:           20px;
      height:          20px;
      min-height:      0;
      padding:         0;
      border:          none;
      border-radius: var(--dev-r-xs);
      background:      none;
      color:           var(--body-text);
      cursor:          pointer;
      opacity:         0.6;

      .icon { font-size: 12px; }

      &:hover { opacity: 1; background: var(--default-hover-bg, var(--body-bg)); }

      &--close { right: 4px; }
      &--menu { right: 26px; }
      &--rename { right: 48px; }

      &--close:hover { color: var(--error); }
    }

    // The menu is a component rather than a button, so the shared rules reach it through the
    // same class; `display: none` on it hides its caret with the rest.
    &--active .conversation-tab__control,
    &:hover .conversation-tab__control,
    &:focus-within .conversation-tab__control { display: flex; }

    // ...and while its list is open the caret stays put, or choosing a row would mean chasing a
    // control that vanished when the pointer left the tab.
    &__control--menu:has(.tab-menu__caret--open) { display: flex; }
  }

  @keyframes conversation-tab-dot-pulse {
    0%, 100% { opacity: 1; }
    50%      { opacity: 0.35; }
  }
</style>
