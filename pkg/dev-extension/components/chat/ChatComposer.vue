<script setup lang="ts">
/**
 * The box you type into, in one of two shapes.
 *
 * `single` is one line - the Focus bar when it is shut, where the whole point is that you can
 * type into the thing that is already on screen instead of pressing it to reveal a chat. Open,
 * it is the same component grown to a few lines with the controls under it. Same keys, same
 * typeahead, same send: a second composer that only had half of those is the thing the deck's
 * bar used to draw, which is why the bar's own note said "two boxes, one of them worse".
 *
 * What it does *not* own is the draft or the sending. Those belong to the conversation (see
 * chat-conversation.ts), so what you type in the bar and what you type in the drawer go the
 * same way, are reconciled against the transcript the same way, and show up as the same turn.
 */
import { computed, nextTick, ref, watch } from 'vue';
import type { ChatCommand } from '../../chat-conversation';

const props = defineProps<{
  modelValue: string;
  /** One line, no control row: the bar when it is shut. */
  single?: boolean;
  placeholder?: string;
  /** claude is mid-turn: what is typed now joins its input queue, and the box says so. */
  busy?: boolean;
  sending?: boolean;
  canSend?: boolean;
  /** The commands matching what is being typed, from the conversation. */
  matches?: ChatCommand[];
  /** How far through a command name the cursor is, so the menu closes when it is done. */
  typing?: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', text: string): void;
  (e: 'send'): void;
  (e: 'caret', at: number): void;
  (e: 'pick', command: ChatCommand): void;
  (e: 'paste', event: ClipboardEvent): void;
  /** The one-line field wants to be the panel: somebody put the cursor in it, or sent. */
  (e: 'expand'): void;
}>();

const box = ref<HTMLTextAreaElement | null>(null);
const index = ref(0);
const dismissed = ref(false);
const focused = ref(false);

/** The menu is open while a name is still being typed and there is something to offer. */
const menu = computed(() => !!props.typing && !dismissed.value && !!props.matches?.length);

/**
 * Size the box to what is in it, up to the maximum the stylesheet sets.
 *
 * Height to `auto` first, or scrollHeight only ever reports the height it already has and the
 * box grows and never shrinks. Driven by a watcher on the value rather than by the input
 * handler, so text put in from somewhere else - a card in the deck asking something, a pasted
 * path, the box cleared after a send - sizes it too.
 */
function autoGrow(): void {
  const el = box.value;

  if (!el || props.single) {
    return;
  }
  el.style.height = 'auto';
  el.style.height = `${ el.scrollHeight }px`;
}

watch(() => props.modelValue, (now, before) => {
  index.value = 0;
  if (!now.startsWith('/') || now.slice(0, 1) !== before.slice(0, 1)) {
    dismissed.value = false;
  }
  nextTick(autoGrow);
});

watch(() => props.single, () => nextTick(autoGrow));

function onInput(event: Event): void {
  const el = event.target as HTMLTextAreaElement;

  emit('update:modelValue', el.value);
  emit('caret', el.selectionStart ?? el.value.length);
}

function onCaret(event: Event): void {
  const el = event.target as HTMLTextAreaElement;

  emit('caret', el.selectionStart ?? el.value.length);
}

function move(by: number): void {
  const n = props.matches?.length || 0;

  index.value = n ? (index.value + by + n) % n : 0;
}

function pick(command: ChatCommand | undefined): void {
  if (command) {
    emit('pick', command);
    index.value = 0;
    nextTick(() => box.value?.focus());
  }
}

function onKeydown(event: KeyboardEvent): void {
  // While the typeahead is open it owns the keys that move and choose. Enter picks the
  // highlighted command rather than sending, which is the one place this changes what a key
  // already did - and only while a menu is visibly open beside the box.
  if (menu.value) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      move(event.key === 'ArrowDown' ? 1 : -1);

      return;
    }
    if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey && !event.isComposing)) {
      event.preventDefault();
      pick(props.matches?.[index.value] || props.matches?.[0]);

      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      dismissed.value = true;

      return;
    }
  }

  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    send();
  }
}

/**
 * Send, and - from the one-line shape - open, because the reply has to land somewhere you can
 * see it. Asking first and showing second is what the bar is for.
 */
function send(): void {
  if (props.single) {
    emit('expand');
  }
  emit('send');
}

function focus(): void {
  nextTick(() => box.value?.focus());
}

defineExpose({ focus, autoGrow });
</script>

<template>
  <div class="box" :class="{ 'box--single': single, 'box--focus': focused }">
    <!--
      The commands, while one is being typed. Above the box rather than below it, because the
      box is at the bottom of the page in both shapes and a menu under it would be off-screen.
    -->
    <ul v-if="menu" class="box__menu">
      <li v-for="(command, i) in matches" :key="command.name">
        <button
          type="button"
          class="box__item"
          :class="{ 'box__item--on': i === index }"
          @mouseenter="index = i"
          @click="pick(command)"
        >
          <span class="box__name">{{ command.name }}</span>
          <span class="box__help">{{ command.help }}</span>
          <span class="box__source">{{ command.source }}</span>
        </button>
      </li>
    </ul>

    <div class="box__row">
      <textarea
        ref="box"
        class="box__field"
        rows="1"
        :value="modelValue"
        :placeholder="placeholder || (busy ? 'Queue the next message…' : 'Message Claude — / for commands')"
        title="Enter to send, Shift+Enter for a new line, / for commands"
        @input="onInput"
        @keydown="onKeydown"
        @keyup="onCaret"
        @click="onCaret"
        @select="onCaret"
        @paste="emit('paste', $event)"
        @focus="focused = true; emit('expand')"
        @blur="focused = false"
      />

      <!--
        No chevron. Putting the cursor in the box is the whole of the intention it asked you to
        declare a second time, so focus opens the conversation and the button was one press
        between wanting to type and typing.
      -->
      <button
        type="button"
        class="box__send"
        :disabled="!canSend"
        :title="canSend ? 'Send' : 'Nothing to send'"
        @click="send"
      >
        {{ sending ? '…' : '↑' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.box {
  position: relative;
  display: flex;
  flex-direction: column;
  /* Between a scroller above and the bar's edge below: it must not be squeezed by either. */
  flex: 0 0 auto;
  min-width: 0;
}

.box__row {
  display: flex;
  align-items: flex-end;
  gap: var(--s2);
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  padding: var(--s2);
  background: var(--surface-sunk);
  transition: border-color var(--fast) var(--ease-out);
}

.box--focus .box__row { border-color: var(--accent); }

/*
 * Shut, the bar is already a bordered, raised surface with a rounded end. A second border
 * inside it is a frame in a frame, which is what the prototype's own note objected to - so in
 * the one-line shape the field is just the field, and the bar is the box.
 */
.box--single .box__row {
  border-color: transparent;
  background: none;
  padding: var(--s1) var(--s2);
}

.box--single.box--focus .box__row { border-color: transparent; }

.box__field {
  flex: 1 1 auto;
  /*
   * A minimum of 30, which is the floor under anything in this view you can press, and a
   * maximum so a pasted essay does not push the deck off the top of the window. Resizing is
   * `autoGrow`'s job and `resize: none` is what stops the browser doing it differently.
   */
  min-height: 30px;
  max-height: 180px;
  min-width: 0;
  padding: var(--s1) var(--s2);
  overflow-y: auto;
  border: 0;
  background: none;
  color: var(--text);
  font-family: var(--font);
  font-size: var(--t-sm);
  line-height: 1.5;
  resize: none;
}

.box--single .box__field {
  /* One line, and one line only: the bar is 56px and the deck is measured against that. */
  max-height: 30px;
  overflow: hidden;
}

.box__field:focus { outline: none; }
.box__field::placeholder { color: var(--text-faint); }

.box__send {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 30px;
  height: 30px;
  border-radius: var(--r-pill);
  cursor: pointer;
  transition: background var(--fast) var(--ease-out), color var(--fast) var(--ease-out);
}


.box__send {
  background: var(--accent);
  color: var(--ink-on-kind);
  font-size: var(--t-sm);
  font-weight: 700;
}

.box__send:hover:not(:disabled) { background: var(--accent-hover); }

.box__send:disabled {
  background: var(--surface-raised);
  color: var(--text-faint);
  cursor: default;
}

.box__menu {
  position: absolute;
  right: 0;
  bottom: 100%;
  left: 0;
  z-index: 2;
  max-height: 220px;
  margin: 0 0 var(--s2);
  overflow-y: auto;
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  background: var(--surface-raised);
  box-shadow: var(--shadow-2);
  padding: var(--s1);
  list-style: none;
}

.box__item {
  display: flex;
  align-items: center;
  gap: var(--s2);
  width: 100%;
  min-height: 30px;
  min-width: 0;
  border-radius: var(--r-sm);
  padding: 0 var(--s2);
  color: var(--text-dim);
  font-size: var(--t-xs);
  text-align: left;
  cursor: pointer;
}

.box__item--on,
.box__item:hover { background: var(--accent-wash); color: var(--text); }

.box__name {
  flex: 0 0 auto;
  color: var(--accent);
  font-family: var(--mono);
}

.box__help {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--text-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.box__source {
  flex: 0 0 auto;
  color: var(--text-faint);
  font-size: var(--t-2xs);
}
</style>
