<script>
// The bar above one conversation's pane: its name, what its agent is doing, and the three
// things every conversation can have done to it - renamed, opened larger, closed.
//
// It exists so the stage's Conversations tab and the global Conversations page show a
// conversation the same way. Both had a list that could rename and close a row (DevList), but
// the pane itself said nothing: no name over it, no live agent state, no way to blow it up. This
// is that surface, and it is purely presentational - it emits, and the page that owns the
// conversation does the renaming, popping and ending, because those are API calls and this is
// not where they live.
import { agentIcon, agentLabel } from '../workspace-status';

export default {
  name: 'ConversationHeader',

  emits: ['rename', 'popout', 'close'],

  props: {
    /** The conversation this bar is for: `{ id, title }` is all it reads. */
    conversation: {
      type:     Object,
      required: true,
    },

    /** The agent's state, for the dot and the label. 'none' draws neither. */
    agent: {
      type:    String,
      default: 'none',
    },
  },

  data() {
    return {
      renaming: false,
      draft:    '',
    };
  },

  computed: {
    /** The agent's mark and its words, from the one place the sidebar and rail read them too. */
    icon() {
      return agentIcon(this.agent);
    },

    label() {
      return agentLabel(this.agent);
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
  <div class="conversation-header">
    <!-- The name, editable in place: a pencil, or a double click on the name itself. -->
    <div class="conversation-header__name-wrap">
      <template v-if="!renaming">
        <span
          class="conversation-header__name"
          :title="conversation.title"
          @dblclick.prevent="startRename"
        >{{ conversation.title || 'Conversation' }}</span>
        <button
          v-clean-tooltip="'Rename'"
          type="button"
          class="conversation-header__control conversation-header__control--reveal"
          :aria-label="`Rename ${ conversation.title || 'conversation' }`"
          @click="startRename"
        >
          <i class="icon icon-edit" />
        </button>
      </template>
      <input
        v-else
        ref="input"
        v-model="draft"
        class="conversation-header__rename"
        type="text"
        :aria-label="`Rename ${ conversation.title || 'conversation' }`"
        @keydown.enter.prevent="commit"
        @keydown.esc.prevent="cancel"
        @blur="commit"
      >
    </div>

    <!-- What the agent is doing, said the same way the sidebar and the rail say it. -->
    <span
      v-if="label"
      class="conversation-header__status"
      :class="`conversation-header__status--${ agent }`"
      :title="label"
    >
      <i
        v-if="icon"
        class="icon"
        :class="icon"
      />{{ label }}
    </span>

    <div class="conversation-header__controls">
      <button
        v-clean-tooltip="'Open it larger'"
        type="button"
        class="conversation-header__control"
        aria-label="Open it larger"
        @click="$emit('popout')"
      >
        <i class="icon icon-external-link" />
      </button>
      <button
        v-clean-tooltip="'Close conversation'"
        type="button"
        class="conversation-header__control conversation-header__control--close"
        aria-label="Close conversation"
        @click="$emit('close')"
      >
        <i class="icon icon-close" />
      </button>
    </div>
  </div>
</template>

<style lang="scss" scoped>
  .conversation-header {
    display:       flex;
    align-items:   center;
    gap:           var(--dev-space-3);
    flex:          0 0 auto;
    min-height:    36px;
    padding:       var(--dev-space-2) var(--dev-space-3);
    border-bottom: 1px solid var(--border);

    // The reveal-on-hover pencil is quiet until the pointer is on the bar, like DevList's.
    &:hover .conversation-header__control--reveal { opacity: 1; }

    &__name-wrap {
      display:     flex;
      align-items: center;
      gap:         var(--dev-space-2);
      flex:        1 1 auto;
      min-width:   0;
    }

    &__name {
      overflow:      hidden;
      text-overflow: ellipsis;
      white-space:   nowrap;
      font-size:     13px;
      font-weight:   600;
      color:         var(--body-text);
    }

    &__rename {
      flex:      1 1 auto;
      min-width: 0;
      max-width: 320px;
      height:    24px;
      padding:   0 6px;
      font-size: 13px;
    }

    // The agent's state: a mark and its words, coloured by how much it wants a person - the
    // same vocabulary as the rail's __agent and the sidebar's __agent.
    &__status {
      display:     inline-flex;
      align-items: center;
      gap:         5px;
      flex:        0 0 auto;
      font-size:   11px;
      color:       var(--muted);

      .icon { font-size: 11px; }

      &--working  { color: var(--primary); }
      &--input    { color: var(--warning); }
      &--finished { color: var(--success); }
    }

    &__controls {
      display:     inline-flex;
      align-items: center;
      gap:         2px;
      flex:        0 0 auto;
    }

    &__control {
      display:         inline-flex;
      align-items:     center;
      justify-content: center;
      width:           24px;
      height:          24px;
      min-height:      24px;
      padding:         0;
      border:          none;
      border-radius:   var(--border-radius);
      background:      transparent;
      color:           var(--muted);
      cursor:          pointer;

      .icon { font-size: 13px; }

      &:hover { background: var(--nav-hover, var(--accent-btn)); color: var(--body-text); }

      &--reveal { opacity: 0; &:focus-visible { opacity: 1; } }

      &--close:hover { color: var(--error); }
    }
  }
</style>
