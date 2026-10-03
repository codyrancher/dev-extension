<script setup lang="ts">
/**
 * One tool call: what it was, in one line, and what went in and came back if you ask.
 *
 * `<details>` rather than a button and a flag, because this is a disclosure and nothing else -
 * a log of two hundred rows that each needed an entry in an `openTools` map is two hundred
 * reactive keys to decide something the browser already decides. The default comes from the
 * person's `toolIo` preference, so a row opens closed or open and then does as it is told.
 *
 * Drawn with the Focus view's tokens, which resolve inside `.dev-focus`. Nothing here knows
 * where it is mounted, so a second host brings the tokens and gets the same row.
 */
import type { ConversationTurn } from '../../chat-conversation';

defineProps<{
  call: ConversationTurn['toolRows'][number];
  /** Tool input and output open without being asked: the person's preference. */
  toolIo?: boolean;
}>();

/** A result long enough to be a file is cut: the whole of it belongs in the file viewer. */
const CUT = 6000;
</script>

<template>
  <details
    class="tool"
    :class="{ 'tool--error': call.resultIsError, 'tool--running': call.result === undefined }"
    :open="toolIo"
  >
    <summary class="tool__head">
      <span class="tool__name">{{ call.name }}</span>
      <!-- The summary carries marked-up paths, which is why it is HTML and not text. -->
      <span class="tool__what" v-html="call.summaryHtml" />
      <span v-if="call.result === undefined" class="tool__state">…</span>
    </summary>
    <div class="tool__io">
      <span class="tool__label">in</span>
      <pre class="tool__pre">{{ JSON.stringify(call.input, null, 2) }}</pre>
      <template v-if="call.result !== undefined">
        <span class="tool__label">out</span>
        <pre class="tool__pre tool__pre--out">{{ call.result.slice(0, CUT) }}{{ call.result.length > CUT ? '\n…' : '' }}</pre>
      </template>
    </div>
  </details>

  <!-- An image the tool returned is worth seeing without opening the row. -->
  <div v-if="call.images && call.images.length" class="tool__shots">
    <img
      v-for="(image, i) in call.images"
      :key="i"
      :src="image"
      class="tool__shot"
      alt="image the tool returned"
    >
  </div>
</template>

<style scoped>
.tool {
  /*
   * `flex: 0 0 auto`, which the rest of this view has learned the hard way: a flex child's
   * default is to shrink below its content, and a row that does not clip then paints over the
   * row under it. A tool row inside a turn inside a scroller is two flex parents deep.
   */
  flex: 0 0 auto;
  min-width: 0;
  margin-top: var(--s1);
  border-left: 2px solid var(--border);
  padding-left: var(--s2);
  color: var(--text-muted);
  font-size: var(--t-xs);
}

.tool--error { border-left-color: var(--danger); }
.tool--running { border-left-color: var(--accent); }

.tool__head {
  display: flex;
  align-items: center;
  gap: var(--s2);
  /* 30px is the floor under anything pressable in this view; a summary is pressable. */
  min-height: 30px;
  min-width: 0;
  border-radius: var(--r-sm);
  padding: 0 var(--s2);
  cursor: pointer;
  list-style: none;
}

.tool__head::-webkit-details-marker { display: none; }
.tool__head:hover { background: var(--surface-sunk); }

.tool__head::before {
  content: '▸';
  flex: 0 0 auto;
  color: var(--text-faint);
  font-size: var(--t-2xs);
}

.tool[open] > .tool__head::before { content: '▾'; }

.tool__name {
  flex: 0 0 auto;
  color: var(--text-dim);
  font-family: var(--mono);
  font-weight: 650;
}

.tool__what {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  font-family: var(--mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool__state { flex: 0 0 auto; color: var(--accent); }

.tool__io {
  display: flex;
  flex-direction: column;
  gap: var(--s1);
  padding: var(--s2);
}

.tool__label {
  color: var(--text-faint);
  font-size: var(--t-2xs);
  font-weight: 650;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.tool__pre {
  max-height: 240px;
  margin: 0;
  overflow: auto;
  border-radius: var(--r-sm);
  background: var(--surface-sunk);
  padding: var(--s2);
  color: var(--text-dim);
  font-family: var(--mono);
  font-size: var(--t-xs);
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.tool__pre--out { color: var(--text-muted); }

.tool__shots {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  gap: var(--s2);
  margin-top: var(--s2);
}

.tool__shot {
  max-width: 180px;
  max-height: 120px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
}
</style>
