<script>
// What one conversation's tab shows: a dot for what its agent is doing, its title (renamed in
// place), and a rename and a close control. Deliberately identical to the agents panel's own tab
// (AgentPanel, in the agents extension) - the same dot, the same two controls in the same places -
// so the stage's conversation tabs and the drawer's read as one thing.
//
// The larger view is not a button here: right-click a tab for it. A button for it made three
// controls where the agents panel has two, which is what broke the match.
//
// It goes in ConversationTabbed's `tab-header` slot. Purely presentational: it emits, and the page
// that owns the conversation does the renaming, popping and ending, because those are API calls.
import { agentLabel } from '../../workspace-status';

export default {
  name: 'ConversationTab',

  emits: ['rename', 'popout', 'close'],

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
  },
};
</script>

<template>
  <!-- Right-click opens the conversation larger; the tab's own click (in ConversationTabbed) still
       switches to it. -->
  <span
    class="conversation-tab"
    :class="{ 'conversation-tab--active': active }"
    @contextmenu.prevent.stop="$emit('popout')"
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
      <span
        class="conversation-tab__name"
        :title="title"
        @dblclick.stop.prevent="startRename"
      >{{ title }}</span>

      <!-- Rename and close, on hover or focus, in reserved trailing space so the tab holds its
           width. The rename pencil is left of the close, both at the tab's right edge. -->
      <button
        v-clean-tooltip="'Rename'"
        type="button"
        class="conversation-tab__control conversation-tab__control--rename"
        aria-label="Rename conversation"
        @click.stop.prevent="startRename"
      >
        <i class="icon icon-edit" />
      </button>
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
    // Trailing room for the two controls (close at 4px, rename at 26px, each 20px wide), reserved
    // so they can appear on hover without moving the label - the agents panel's measure exactly.
    padding-right: 48px;

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
      border-radius: 3px;
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
      border-radius:   3px;
      background:      none;
      color:           var(--body-text);
      cursor:          pointer;
      opacity:         0.6;

      .icon { font-size: 12px; }

      &:hover { opacity: 1; background: var(--default-hover-bg, var(--body-bg)); }

      &--close { right: 4px; }
      &--rename { right: 26px; }

      &--close:hover { color: var(--error); }
    }

    &--active .conversation-tab__control,
    &:hover .conversation-tab__control,
    &:focus-within .conversation-tab__control { display: flex; }
  }

  @keyframes conversation-tab-dot-pulse {
    0%, 100% { opacity: 1; }
    50%      { opacity: 0.35; }
  }
</style>
