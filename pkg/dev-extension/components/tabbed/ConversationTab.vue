<script>
// What one conversation's tab shows: its CLI's mark, coloured for what its agent is doing, its title (renamed in
// place), and a caret for its menu. The stage's conversation tabs and the drawer's are this one
// component, so they read as one thing.
//
// Everything you can do to a tab is in its own menu, rename and close included, which is what the caret opens -
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

    /** The agent's state, for the mark's colour (or the dot, with no mark). 'none' is neither. */
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
     * stage; the drawer passes the one it has. Rename and close are every tab's, so they are
     * always listed around these.
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
        rename: {
          id: 'rename', label: 'Rename', icon: 'icon-edit', what: 'Give this conversation a name',
        },
        close: {
          id: 'close', label: 'Close', icon: 'icon-close', what: 'End this conversation',
        },
        popout: {
          id: 'popout', label: 'Open it larger', icon: 'icon-external-link', what: 'Show this conversation over the page',
        },
        fork: {
          id: 'fork', label: 'Fork from here', icon: 'icon-copy', what: 'A second conversation that starts with this one\'s history behind it',
        },
      };

      return ['rename', ...(Array.isArray(this.actions) ? this.actions : []), 'close'].map((id) => rows[id]).filter(Boolean);
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
      if (id === 'rename') {
        this.startRename();
      } else {
        this.$emit(id);
      }
    },

    /** The middle button closes a tab, as it does in a browser. Not while a name is being typed. */
    onMiddle() {
      if (!this.renaming) {
        this.$emit('close');
      }
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
    @mousedown.middle.prevent
    @auxclick.middle.stop.prevent="onMiddle"
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
      <!--
        What the agent is doing, said by the CLI's own mark: coloured by how much it wants a
        person, and pulsing while it works. It was a dot and then the mark beside it, two glyphs
        and two gaps for what one glyph can say, in a strip where every pixel is a title's.
        The dot is left for a conversation no CLI has run yet, which has no mark to colour.
      -->
      <CliMark
        v-if="mark"
        class="conversation-tab__cli"
        :class="agent && agent !== 'none' ? `conversation-tab__cli--${ agent }` : ''"
        :mark="mark"
        :size="13"
        :status="agent && agent !== 'none' ? label : ''"
      />
      <span
        v-else-if="agent && agent !== 'none'"
        class="conversation-tab__dot"
        :class="`conversation-tab__dot--${ agent }`"
        :title="label"
      />
      <span
        class="conversation-tab__name"
        :title="title"
        @dblclick.stop.prevent="startRename"
      >{{ title }}</span>

      <!-- The tab's menu, on hover or focus, in reserved trailing space so the tab holds its width. -->
      <TabMenu
        v-if="menu.length"
        ref="menu"
        class="conversation-tab__control conversation-tab__control--menu"
        :items="menu"
        :busy="busy"
        :aria-label="`Actions for ${ title }`"
        @select="onMenu"
      />
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
    // Trailing room for the menu's caret (20px wide, at 4px), reserved so it can appear on hover
    // without moving the label.
    padding-right: 26px;

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

      // An agent that asked something: the one loud colour, see --status-asking.
      &--input    { background: var(--status-asking); }
      &--finished { background: var(--status-done); }
      &--idle     { background: var(--status-idle); }
    }

    // The mark, carrying the state the dot used to: the same colours, and the same opacity-only
    // pulse, so the title beside it never moves.
    &__cli {
      flex:         0 0 auto;
      margin-right: 6px;

      &--working {
        color:     var(--status-working);
        animation: conversation-tab-dot-pulse 1.4s ease-in-out infinite;
      }

      &--input    { color: var(--status-asking); }
      &--finished { color: var(--status-done); }
      &--idle     { color: var(--status-idle); }
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

    // The caret: absolute in the reserved trailing space, hidden until the tab is on show or
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

      &--menu { right: 4px; }
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
