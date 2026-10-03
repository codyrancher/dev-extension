<script setup lang="ts">
/**
 * One turn: who said it, what they said, what it did, and what came back.
 *
 * The prototype's shape - your own words on the right in the accent's wash, claude's on the
 * left in a sunk bubble, a quiet line of who and when above each. That shape used to be 155
 * lines of stylesheet over the drawer's chat, keyed on `.mc-chat--skin-loop`, which only worked
 * while the bar embedded the drawer (design/focus-chat.css, deleted with this change). It is a
 * component now, so a turn in the bar and a turn in the drawer are two renderings of the same
 * `ConversationTurn` rather than one rendering with a skin over it.
 *
 * `queued`, `inQueue` and `failed` are not this file's judgement: they come from the
 * reconciling in chat-state.mjs, which the verifier runs against a real claude. All this does
 * is say them out loud, because a message that claude has no record of has to be visible as
 * such - that is the whole reason the pending list exists.
 */
import { computed } from 'vue';
import ChatToolRow from './ChatToolRow.vue';
import type { ConversationTurn } from '../../chat-conversation';

const props = defineProps<{
  turn: ConversationTurn;
  /** Show the time it was written. */
  times?: boolean;
  /** Tool input and output open without being asked. */
  toolIo?: boolean;
  /** Thinking open without being asked. */
  thoughts?: boolean;
}>();

const emit = defineEmits<{
  (e: 'resend', turn: ConversationTurn): void;
}>();

const who = computed(() => {
  switch (props.turn.role) {
  case 'user': return 'You';
  case 'summary': return 'Summary';
  case 'note': return 'Claude Code';
  default: return 'Claude';
  }
});

/** What the time column says, which is sometimes not a time at all. */
const stamp = computed(() => {
  if (props.turn.failed) {
    return 'not recorded';
  }
  if (props.turn.inQueue) {
    return 'in claude’s queue';
  }
  if (props.turn.queued) {
    return 'sending';
  }
  if (!props.times || !props.turn.at) {
    return '';
  }
  const at = new Date(props.turn.at);

  return Number.isNaN(at.getTime()) ? '' : at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
});

/** A compact's summary is the conversation so far, folded: the first line until it is opened. */
const firstLine = computed(() => (props.turn.text || '').split('\n').find((l) => l.trim()) || '');
</script>

<template>
  <article
    class="turn"
    :class="[`turn--${ turn.role }`, { 'turn--queued': turn.queued, 'turn--failed': turn.failed }]"
  >
    <header class="turn__meta">
      <span class="turn__who">{{ who }}</span>
      <span v-if="stamp" class="turn__when">{{ stamp }}</span>
      <button
        v-if="turn.failed"
        type="button"
        class="turn__again"
        title="Nothing claude writes down mentions this message - not the transcript, not its input queue, not the submit hook. Usually the paste into the pane did not land."
        @click="emit('resend', turn)"
      >
        send again
      </button>
    </header>

    <!-- The model's thinking, when the transcript carries it. -->
    <details v-if="turn.thinking" class="turn__thought" :open="thoughts">
      <summary class="turn__thought-head">Thinking</summary>
      <pre class="turn__pre">{{ turn.thinking }}</pre>
    </details>

    <!--
      A summary folds; everything else is the body. `v-html` because the HTML is this product's
      own - renderMarkdown and renderPlain in chat.ts, which escape before they build.
    -->
    <details v-if="turn.role === 'summary'" class="turn__fold">
      <summary class="turn__fold-head">{{ firstLine }}</summary>
      <div class="turn__body turn__body--md" v-html="turn.html" />
    </details>
    <div
      v-else-if="turn.html"
      class="turn__body"
      :class="turn.role === 'user' ? 'turn__body--plain' : 'turn__body--md'"
      v-html="turn.html"
    />

    <ul v-if="turn.images.length" class="turn__shots">
      <li v-for="(image, i) in turn.images" :key="`${ i }-${ image.slice(0, 40) }`">
        <img v-if="image.startsWith('data:')" :src="image" class="turn__shot" alt="attached image">
        <span v-else class="turn__shot-name">{{ image }}</span>
      </li>
    </ul>

    <ChatToolRow
      v-for="call in turn.toolRows"
      :key="call.id"
      :call="call"
      :tool-io="toolIo"
    />
  </article>
</template>

<style scoped>
/*
 * A grid rather than a block, because `justify-self` is what puts your own words on the right -
 * and the right-hand side is how the prototype says "this one was you" without a colour or an
 * avatar.
 *
 * `min-width: 0` and `max-width` both, or neither does anything: a grid item's automatic
 * minimum is its content, and a conversation is full of things with no space to break at - a
 * URL, a path, a line of code.
 */
.turn {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  /* `0 0 auto` for the scroller above, which is a column flex: see ChatTurns. */
  flex: 0 0 auto;
  gap: var(--s1);
  min-width: 0;
  max-width: 78%;
}

.turn--user {
  justify-self: end;
  text-align: right;
}

.turn__meta {
  display: flex;
  align-items: baseline;
  gap: var(--s2);
  min-width: 0;
}

.turn--user .turn__meta { justify-content: flex-end; }

.turn__who {
  color: var(--text-faint);
  font-size: var(--t-xs);
  font-weight: 650;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.turn__when {
  color: var(--text-faint);
  font-size: var(--t-2xs);
}

/* Said out loud, and pressable, so a message claude never saw can be sent again. */
.turn__again {
  min-height: 30px;
  padding: 0 var(--s2);
  border-radius: var(--r-sm);
  color: var(--danger);
  font-size: var(--t-xs);
  cursor: pointer;
}

.turn__again:hover { background: var(--danger-wash); }

.turn__body {
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  padding: var(--s3) var(--s4);
  background: var(--surface-sunk);
  color: var(--text-dim);
  font-size: var(--t-sm);
  line-height: 1.55;
  overflow-wrap: anywhere;
  text-align: left;
}

/* Yours is the accent's wash, which is the one place the prototype uses colour in the chat. */
.turn--user .turn__body {
  border-color: color-mix(in srgb, var(--accent) 34%, transparent);
  background: var(--accent-wash);
  color: var(--text);
}

.turn--note .turn__body,
.turn--summary .turn__body {
  border-style: dashed;
  background: transparent;
  color: var(--text-muted);
}

/* On its way, not yet in the conversation: the same words, dimmed. */
.turn--queued .turn__body { opacity: 0.65; }
.turn--failed .turn__body { border-color: color-mix(in srgb, var(--danger) 45%, transparent); }

.turn__thought,
.turn__fold { flex: 0 0 auto; min-width: 0; }

.turn__thought-head,
.turn__fold-head {
  display: flex;
  align-items: center;
  gap: var(--s2);
  min-height: 30px;
  min-width: 0;
  overflow: hidden;
  border-radius: var(--r-sm);
  padding: 0 var(--s2);
  color: var(--text-muted);
  font-size: var(--t-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
  list-style: none;
}

.turn__thought-head::-webkit-details-marker,
.turn__fold-head::-webkit-details-marker { display: none; }

.turn__thought-head::before,
.turn__fold-head::before {
  content: '▸';
  flex: 0 0 auto;
  color: var(--text-faint);
}

.turn__thought[open] > .turn__thought-head::before,
.turn__fold[open] > .turn__fold-head::before { content: '▾'; }

.turn__pre {
  max-height: 260px;
  margin: 0;
  overflow: auto;
  border-radius: var(--r-sm);
  background: var(--surface-sunk);
  padding: var(--s2);
  color: var(--text-muted);
  font-family: var(--mono);
  font-size: var(--t-xs);
  line-height: 1.5;
  white-space: pre-wrap;
  text-align: left;
}

.turn__shots {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.turn__shot {
  max-width: 200px;
  max-height: 140px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
}

.turn__shot-name {
  color: var(--text-muted);
  font-family: var(--mono);
  font-size: var(--t-xs);
}
</style>

<style>
/*
 * What the markdown renderer writes, which is markup this component does not own and therefore
 * cannot style from a scoped block. Namespaced on `.turn__body` so it reaches nothing else.
 *
 * Not `:deep()` from the scoped block above: `v-html` content carries no scope attribute at
 * all, so `:deep` would work here and the rules would still be duplicated per component that
 * renders a body. One sheet, named after the class it is for.
 */
.turn__body p { margin: 0 0 var(--s2); }
.turn__body > :last-child { margin-bottom: 0; }

.turn__body h3,
.turn__body h4,
.turn__body h5,
.turn__body h6 {
  margin: var(--s3) 0 var(--s2);
  color: var(--text);
  font-size: var(--t-sm);
  font-weight: 650;
}

.turn__body ul,
.turn__body ol { margin: 0 0 var(--s2); padding-left: var(--s4); }
.turn__body li { margin: 0 0 var(--s1); }

.turn__body code {
  border-radius: var(--r-sm);
  background: var(--surface-raised);
  padding: 0 var(--s1);
  font-family: var(--mono);
  font-size: var(--t-xs);
}

.turn__body pre {
  max-height: 300px;
  margin: 0 0 var(--s2);
  overflow: auto;
  border-radius: var(--r-sm);
  background: var(--ground-deep);
  padding: var(--s2);
  white-space: pre;
}

.turn__body pre code {
  background: none;
  padding: 0;
  line-height: 1.5;
}

.turn__body blockquote {
  margin: 0 0 var(--s2);
  border-left: 2px solid var(--border-strong);
  padding-left: var(--s3);
  color: var(--text-muted);
}

.turn__body a { color: var(--accent); }

/* A path in what was said, as something to open. Hydrated with a thumbnail by the host. */
.turn__body .mc-chat__path {
  color: var(--accent);
  cursor: pointer;
  text-decoration: underline dotted;
}

.turn__body .mc-chat__media { display: inline-block; vertical-align: middle; }
.turn__body .mc-chat__thumb { max-width: 120px; max-height: 80px; border-radius: var(--r-sm); }

.turn__body .mc-chat__paste summary {
  color: var(--text-muted);
  font-size: var(--t-xs);
  cursor: pointer;
}

.turn__body .mc-chat__table-wrap { overflow-x: auto; }
.turn__body table { border-collapse: collapse; font-size: var(--t-xs); }
.turn__body th,
.turn__body td {
  border: 1px solid var(--border);
  padding: var(--s1) var(--s2);
  text-align: left;
}
</style>
