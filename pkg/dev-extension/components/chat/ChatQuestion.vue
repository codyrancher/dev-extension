<script setup lang="ts">
/**
 * What the pane is asking, when it is asking something a text box cannot answer.
 *
 * Three shapes, which are the three Claude Code actually puts up: a numbered list with one
 * answer marked, a yes/no, and the login flow (a URL, then a code to paste back). What goes
 * back is keystrokes into the same pane, which is why the options carry a `key`: pressing one
 * of these is pressing the number on a keyboard, and the terminal beside this would have done
 * the same thing.
 *
 * It is drawn above the composer rather than in the log, because it is not something that was
 * said - it is the conversation waiting on you, and a question that scrolled away with the
 * transcript was a conversation that looked idle while it was blocked.
 */
import { ref } from 'vue';
import type { ConversationDialog } from '../../chat-conversation';

defineProps<{
  dialog: ConversationDialog;
}>();

const emit = defineEmits<{
  (e: 'choose', option: { key: string }): void;
  (e: 'code', text: string): void;
}>();

const code = ref('');

function sendCode(): void {
  const text = code.value.trim();

  if (text) {
    emit('code', text);
    code.value = '';
  }
}
</script>

<template>
  <section class="ask" :class="`ask--${ dialog.kind }`">
    <p v-if="dialog.header" class="ask__head">{{ dialog.header }}</p>
    <pre v-if="dialog.prompt" class="ask__prompt">{{ dialog.prompt }}</pre>

    <div v-if="dialog.options.length" class="ask__options">
      <button
        v-for="option in dialog.options"
        :key="option.key"
        type="button"
        class="ask__option"
        :class="{ 'ask__option--on': option.selected }"
        :title="option.description || ''"
        @click="emit('choose', option)"
      >
        <span class="ask__key">{{ option.key }}</span>
        <span class="ask__label">{{ option.label }}</span>
        <span v-if="option.description" class="ask__desc">{{ option.description }}</span>
      </button>
    </div>

    <div v-else class="ask__login">
      <a
        v-if="dialog.url"
        :href="dialog.url"
        target="_blank"
        rel="noopener noreferrer"
        class="ask__option"
      >Open the sign-in page</a>
      <div class="ask__code">
        <input
          v-model="code"
          type="text"
          class="ask__field"
          placeholder="Paste the code here"
          @keydown.enter.prevent="sendCode"
        >
        <button type="button" class="ask__option" @click="sendCode">Send</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.ask {
  display: flex;
  flex-direction: column;
  /* `0 0 auto`: it sits between a scroller and a composer, and both of those will squeeze it. */
  flex: 0 0 auto;
  gap: var(--s2);
  min-width: 0;
  margin: 0 var(--s3) var(--s2);
  border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
  border-radius: var(--r-md);
  padding: var(--s3);
  background: var(--accent-wash);
}

.ask__head {
  margin: 0;
  color: var(--text);
  font-size: var(--t-sm);
  font-weight: 650;
}

.ask__prompt {
  max-height: 180px;
  margin: 0;
  overflow: auto;
  color: var(--text-dim);
  font-family: var(--font);
  font-size: var(--t-sm);
  line-height: 1.5;
  white-space: pre-wrap;
}

.ask__options {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s2);
}

.ask__option {
  display: inline-flex;
  align-items: center;
  gap: var(--s2);
  /* `--control-h` is 32px; the floor under anything pressable in this view is 30. */
  min-height: var(--control-h);
  padding: 0 var(--s3);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-pill);
  background: var(--surface-raised);
  color: var(--text);
  font-size: var(--t-sm);
  cursor: pointer;
  text-decoration: none;
}

.ask__option:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.ask__option--on {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--ink-on-kind);
}

.ask__key {
  color: var(--text-faint);
  font-family: var(--mono);
  font-size: var(--t-xs);
}

.ask__option--on .ask__key { color: var(--ink-on-kind); }

.ask__label { min-width: 0; }

.ask__desc {
  color: var(--text-muted);
  font-size: var(--t-xs);
}

.ask__login {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--s2);
}

.ask__code {
  display: flex;
  gap: var(--s2);
}

.ask__field {
  min-height: var(--control-h);
  padding: 0 var(--s3);
  border: 1px solid var(--border);
  border-radius: var(--r-pill);
  background: var(--surface-sunk);
  color: var(--text);
  font-size: var(--t-sm);
}
</style>
