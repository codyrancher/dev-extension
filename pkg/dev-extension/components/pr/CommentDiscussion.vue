<script>
// Inline discussion for one pending review comment, or for a few selected lines: a box to open
// with, then the Studio's terminal onto a conversation scoped to that comment.
//
// The harness ran these in its own container; here each is a conversation in the workspace,
// namespaced like the rest (see conversations.ts) so the Studio's drawer never lists it, and
// drawn by the Studio's own pane (StudioTerminal). Self-contained so several can run side by
// side under different comments. The conversation persists in the agent pod; the panel above
// remembers which conversation belongs to which comment, so closing and reopening reattaches.
import { Banner } from '@components/Banner';
import StudioTerminal from '../StudioTerminal.vue';
import PrButton from './PrButton.vue';
import {
  startDiscussion, sayInConversation, discussPrompt, linesPrompt, DEFAULT_REPO
} from '../../reviews';
import { listConversations, paneCommand } from '../../conversations';

export default {
  name: 'CommentDiscussion',

  components: {
    Banner, StudioTerminal, PrButton
  },

  emits: ['close', 'session'],

  props: {
    pr: {
      type:     Number,
      required: true,
    },
    repo: {
      type:    String,
      default: DEFAULT_REPO,
    },
    /** The workspace whose conversations this joins. */
    workspace: {
      type:     String,
      required: true,
    },
    /** Either a filed comment, or a bare line range - a conversation about code with nothing filed. */
    comment: {
      type:    Object,
      default: null,
    },
    lines: {
      type:    Object,
      default: null,
    },
    initialMessage: {
      type:    String,
      default: '',
    },
    /** A conversation already opened for this comment - reattach rather than ask for an opener. */
    session: {
      type:    String,
      default: '',
    },
  },

  data() {
    return {
      draft:    this.initialMessage || '',
      starting: false,
      error:    '',
      current:  this.session || '',
      state:    '',
    };
  },

  computed: {
    where() {
      if (this.lines) {
        return `${ this.lines.path }:${ this.lines.startLine ? `${ this.lines.startLine }-${ this.lines.line }` : this.lines.line }`;
      }

      if (this.comment?.path) {
        return `${ this.comment.path }${ this.comment.line ? `:${ this.comment.line }` : '' }`;
      }

      return 'PR-level';
    },

    title() {
      if (this.lines) {
        return `Discuss ${ this.lines.path.split('/').pop() }:${ this.lines.line }`;
      }

      return `Discuss comment #${ this.comment?.id }`;
    },
  },

  mounted() {
    if (!this.current) {
      this.$nextTick(() => this.$refs.input?.focus());
    }
  },

  methods: {
    async start() {
      if (this.starting) {
        return;
      }

      this.starting = true;
      this.error = '';

      try {
        const message = this.draft.trim();
        const prompt = this.lines
          ? linesPrompt(this.pr, this.lines, message, this.repo)
          : discussPrompt(this.pr, this.comment, message, this.repo);
        const conversation = await startDiscussion(this.workspace, this.title, prompt);

        this.current = conversation.id;
        this.draft = '';
        this.$emit('session', conversation.id);
      } catch (e) {
        this.error = e.message || String(e);
      } finally {
        this.starting = false;
      }
    },

    /** The argv of one conversation's pane: claude in the workspace's pod, reached through the agent pod. */
    paneFor(id) {
      return paneCommand(this.workspace, id);
    },

    /** Reattached to a conversation somebody typed into before: a new line goes into it. */
    async say() {
      const message = this.draft.trim();

      if (!message || !this.current) {
        return;
      }

      const conversation = (await listConversations(this.workspace).catch(() => [])).find((c) => c.id === this.current);

      if (conversation) {
        await sayInConversation(conversation, message).catch((e) => {
          this.error = e.message || String(e);
        });
        this.draft = '';
      }
    },
  },
};
</script>

<template>
  <div class="cd">
    <div class="cd__header">
      <span class="cd__title">Discussion</span>
      <span class="cd__loc">{{ where }}</span>
      <span
        v-if="current"
        class="cd__session"
      >{{ current }}</span>
      <PrButton
        variant="ghost"
        size="mini"
        class="cd__close"
        title="Close discussion (the conversation keeps running)"
        @click="$emit('close')"
      >
        &times;
      </PrButton>
    </div>
    <Banner
      v-if="error"
      color="error"
      :label="error"
      class="cd__error"
    />
    <div
      v-if="!current"
      class="cd__compose"
    >
      <textarea
        ref="input"
        v-model="draft"
        class="cd__textarea"
        :placeholder="lines
          ? 'Opening message (optional) - Enter to open; the selected code goes to the agent as context'
          : 'Opening message (optional) - Enter to open; the comment goes to the agent as context'"
        :disabled="starting"
        @keydown.enter.exact.prevent="start"
      />
      <div class="cd__actions">
        <span
          v-if="starting"
          class="cd__hint"
        >Opening a conversation in the agent pod</span>
        <PrButton
          variant="primary"
          size="sm"
          :disabled="starting"
          @click="start"
        >
          {{ starting ? 'Opening…' : 'Start discussion' }}
        </PrButton>
      </div>
    </div>
    <StudioTerminal
      v-else
      :session="current"
      :command="paneFor(current)"
      class="cd__term"
      @state="state = $event"
    />
  </div>
</template>

<style lang="scss" scoped>
  .cd {
    height:         320px;
    display:        flex;
    flex-direction: column;
    margin-top:     var(--dev-space-2);
    border:         1px solid var(--pr-border);
    border-left:    3px solid var(--pr-accent);
    border-radius:  var(--border-radius);
    overflow:       hidden;
    background:     var(--pr-bg);
    max-width:      900px;

    &__header {
      display:       flex;
      align-items:   center;
      gap:           var(--dev-space-3);
      padding:       var(--dev-space-2) var(--dev-space-4);
      background:    var(--pr-bg-2);
      border-bottom: 1px solid var(--pr-border);
      flex-shrink:   0;
      font-size:     12px;
    }

    &__title {
      font-weight:    600;
      color:          var(--pr-text);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-size:      10px;
    }

    &__loc {
      font-family:   monospace;
      color:         var(--pr-accent);
      overflow:      hidden;
      text-overflow: ellipsis;
      white-space:   nowrap;
      flex:          1;
      min-width:     0;
    }

    &__session { color: var(--pr-muted); font-family: monospace; font-size: 11px; }

    &__close { font-size: 16px; line-height: 1; padding: 0 var(--dev-space-2); }

    &__error { margin: var(--dev-space-2) var(--dev-space-4); }

    &__compose {
      flex:           1;
      min-height:     0;
      display:        flex;
      flex-direction: column;
      gap:            var(--dev-space-3);
      padding:        var(--dev-space-4);
    }

    &__textarea {
      flex:          1;
      min-height:    0;
      background:    var(--pr-bg);
      color:         var(--pr-text);
      border:        1px solid var(--pr-border);
      border-radius: var(--border-radius);
      padding:       var(--dev-space-3) var(--dev-space-4);
      font-family:   inherit;
      font-size:     13px;
      line-height:   1.5;
      resize:        none;
      outline:       none;

      &:focus { border-color: var(--pr-accent); }
    }

    &__actions {
      display:         flex;
      align-items:     center;
      justify-content: flex-end;
      gap:             var(--dev-space-4);
      font-size:       12px;
    }

    &__hint { color: var(--pr-muted); }

    &__term { flex: 1; min-height: 0; }
  }
</style>
