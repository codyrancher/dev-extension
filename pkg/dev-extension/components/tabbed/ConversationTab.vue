<script>
// What one conversation's tab shows: its title (renamed in place), a dot for what its agent is
// doing, and the two things the old ConversationHeader bar carried - open it larger, close it.
//
// It goes in ConversationTabbed's `tab-header` slot, so the conversation tabs carry all of this
// themselves rather than nesting inside a second bar that repeated it. Purely presentational,
// like ConversationHeader was: it emits, and the page that owns the conversation does the
// renaming, popping and ending, because those are API calls and this is not where they live.
import { agentIcon, agentLabel } from '../../workspace-status';

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
    icon() {
      return agentIcon(this.agent);
    },

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
  <span
    class="conversation-tab"
    :class="{ 'conversation-tab--active': active }"
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
    <span
      v-else
      class="conversation-tab__name"
      :title="title"
      @dblclick.stop.prevent="startRename"
    >{{ title }}</span>

    <!-- What the agent is doing, as a dot: the mark the sidebar and the rail use too. -->
    <i
      v-if="icon"
      class="conversation-tab__status icon"
      :class="[icon, `conversation-tab__status--${ agent }`]"
      :title="label"
    />

    <!-- Rename, open larger, then close: on the tab on show, or on hover, so inactive tabs are
         quiet. Rename is a button as well as the name's double-click, so it is findable. -->
    <button
      v-clean-tooltip="'Rename'"
      type="button"
      class="conversation-tab__control"
      aria-label="Rename conversation"
      @click.stop.prevent="startRename"
    >
      <i class="icon icon-edit" />
    </button>
    <button
      v-clean-tooltip="'Open it larger'"
      type="button"
      class="conversation-tab__control"
      aria-label="Open it larger"
      @click.stop.prevent="$emit('popout')"
    >
      <i class="icon icon-external-link" />
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
  </span>
</template>

<style lang="scss" scoped>
  .conversation-tab {
    display:     inline-flex;
    align-items: center;
    gap:         6px;
    min-width:   0;

    &__name {
      overflow:      hidden;
      text-overflow: ellipsis;
      white-space:   nowrap;
      max-width:     220px;
    }

    &__rename {
      height:    22px;
      min-width: 0;
      max-width: 220px;
      padding:   0 6px;
      font-size: 13px;
    }

    // The agent's state, coloured by how much it wants a person - the same vocabulary as the
    // rail's __agent and the sidebar's __agent.
    &__status {
      font-size: 11px;
      color:     var(--muted);

      &--working  { color: var(--primary); }
      &--input    { color: var(--warning); }
      &--finished { color: var(--success); }
    }

    // The controls are quiet until the tab is on show or the pointer is on it, so a strip of
    // inactive tabs reads as titles and dots rather than a row of buttons. They hold their space
    // the whole time (visibility, not display), so a tab does not change width when it is hovered.
    // The same treatment the agents panel's tab controls have, which reads better than the
    // filled square: a 20px glyph at 0.6 opacity, full and on a quiet hover surface when the
    // pointer is on it. Held in layout (visibility) so the tab keeps its width.
    &__control {
      display:         inline-flex;
      visibility:      hidden;
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

      &--close:hover { color: var(--error); }
    }

    &--active .conversation-tab__control,
    &:hover .conversation-tab__control { visibility: visible; }
  }
</style>
