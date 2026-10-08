<script setup lang="ts">
/**
 * One conversation, inside a card.
 *
 * The third skin over chat-conversation.ts, after the drawer's pane and the deck's bar. The
 * composable already holds the transcript, the live state, the send path, the queue and the
 * questions, so what is here is layout: history, the question when there is one, and a box to
 * type in - at the size of a thing that sits inside a card rather than over the page.
 *
 * Why a third skin rather than the bar again. The bar is *one* conversation for the whole deck:
 * a question asked from a card arrived in whatever thread the bar happened to be on, and the
 * card's own answer - "Sent to the conversation below" - pointed somewhere else on the page.
 * Here the conversation belongs to the thing it is about. Several can be open at once, because
 * each one is its own component with its own composable, and an agent waiting on an answer can
 * be answered where the question is rather than by leaving Focus for the workspace page.
 *
 * What makes several affordable is `live`. A poll is an exec into a pod every 1.5 seconds, so a
 * chat that is collapsed or scrolled off reads nothing at all; the host says which one the
 * person is actually looking at. A conversation does not stop existing when it stops being
 * polled - it is a pane in the agent pod either way - so nothing is lost by going quiet.
 */
import { computed, nextTick, ref, watch } from 'vue';
import AppIcon from './AppIcon.vue';
import ChatTurns from '../chat/ChatTurns.vue';
import ChatComposer from '../chat/ChatComposer.vue';
import ChatQuestion from '../chat/ChatQuestion.vue';
import { useConversation } from '../../chat-conversation';
import { readLook } from '../../look';
import { EXT_NS } from '../../pod';
import { AGENT_CONTAINER } from '../../agent';

const props = withDefaults(defineProps<{
  /** The conversation this is: an id of a pane in the agent pod. */
  session: string;
  /** Its argv, when it runs in a workspace's checkout rather than the agent's own directory. */
  command?: string[] | null;
  /** Whether to read. False is a chat that is on the page but not being looked at. */
  live?: boolean;
  /** A line above the history saying which conversation this is. */
  title?: string;
  /** Something to put in the box, unsent, when the chat first appears. */
  draftText?: string;
  /** Buttons that fill the box with a ready-made question. */
  shortcuts?: { label: string; prompt: string }[];
}>(), {
  command: null, live: true, title: '', draftText: '', shortcuts: () => [],
});

const emit = defineEmits<{ (e: 'sent', text: string): void }>();

const chat = useConversation(() => ({
  session:   props.session || '',
  mode:      'claude' as const,
  command:   props.command || null,
  namespace: EXT_NS,
  container: AGENT_CONTAINER,
  imageDir:  '/workspace/.images',
  home:      '/workspace/.home',
  label:     'the agent',
  enabled:   !!props.session && props.live,
}));

// Destructured so the template reads them as plain names: a ref inside an object is not
// unwrapped in a template, only a top-level one is.
const {
  turns, working, pane, draft, canSend, sending, slashMatches, slashSpot, caret,
  grew, restarted, attached, error, pending,
} = chat;

const look = ref(readLook());
const composer = ref<InstanceType<typeof ChatComposer> | null>(null);

/** What the history says before anything has been said in it. */
const nothing = computed(() => {
  if (!props.session) {
    return 'Starting a conversation…';
  }
  if (!attached.value) {
    return 'Nothing is running here yet. Say something to start it.';
  }

  return 'Nothing has been said yet.';
});

/** A question handed in by the host, put in the box rather than sent. */
watch(() => props.draftText, (text) => {
  if (text && !draft.value) {
    draft.value = text;
    nextTick(() => composer.value?.focus?.());
  }
}, { immediate: true });

function use(prompt: string): void {
  draft.value = draft.value ? `${ draft.value.trimEnd() }\n\n${ prompt }` : prompt;
  nextTick(() => composer.value?.focus?.());
}

async function onSend(): Promise<void> {
  const text = draft.value;

  await chat.send();
  emit('sent', text);
}

function onPaste(event: ClipboardEvent): void {
  const images = [...(event.clipboardData?.items || [])].filter((i) => i.kind === 'file' && i.type.startsWith('image/'));

  if (!images.length) {
    return;
  }
  event.preventDefault();
  images.forEach((item) => chat.attachImage(item.getAsFile()));
}

function onCode(text: string): void {
  chat.code.value = text;
  chat.submitCode();
}
</script>

<template>
  <section class="ic" aria-label="The conversation">
    <div v-if="title || shortcuts.length" class="ic__head">
      <AppIcon name="sparkle" :size="13" class="ic__mark" />
      <span v-if="title" class="ic__title" :title="title">{{ title }}</span>
      <span class="ic__spacer" />
      <button
        v-for="shortcut in shortcuts"
        :key="shortcut.label"
        type="button"
        class="ic__shortcut"
        :title="shortcut.prompt"
        @click="use(shortcut.prompt)"
      >{{ shortcut.label }}</button>
    </div>

    <ChatTurns
      class="ic__turns"
      :turns="turns"
      :working="working"
      :status="pane.status"
      :empty="nothing"
      :times="look.times"
      :tool-io="look.toolIo"
      :thoughts="look.thoughts"
      :grew="grew"
      :restarted="restarted"
      @resend="chat.resend($event)"
      @stop="chat.stop()"
    />

    <!-- What it is waiting on, above the box so it cannot scroll away. -->
    <ChatQuestion
      v-if="pane.dialog"
      :dialog="pane.dialog"
      @choose="chat.choose($event)"
      @code="onCode"
    />

    <p v-if="error" class="ic__error">{{ error }}</p>
    <p v-else-if="pending.length" class="ic__pending">{{ pending.length }} waiting to go in.</p>

    <ChatComposer
      ref="composer"
      :model-value="draft"
      :busy="working"
      :sending="sending"
      :can-send="canSend"
      :matches="slashMatches"
      :typing="!!slashSpot"
      placeholder="Say something to the agent…"
      class="ic__box"
      @update:model-value="draft = $event"
      @caret="caret = $event"
      @pick="chat.pickCommand($event)"
      @paste="onPaste"
      @send="onSend"
    />
  </section>
</template>

<style scoped>
.ic {
  display: flex;
  flex-direction: column;
  gap: var(--s2);
  min-width: 0;
}

.ic__head {
  display: flex;
  align-items: center;
  gap: var(--s2);
  min-width: 0;
}

.ic__mark { color: var(--accent); flex: 0 0 auto; }

.ic__title {
  color: var(--text-muted);
  font-size: var(--t-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ic__spacer { flex: 1 1 auto; }

.ic__shortcut {
  flex: 0 0 auto;
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: var(--r-pill);
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: var(--t-xs);
  cursor: pointer;
}

.ic__shortcut:hover { color: var(--text); border-color: var(--accent); }

/* The history scrolls inside the card rather than growing it without bound. */
.ic__turns {
  max-height: 320px;
  overflow-y: auto;
  min-height: 0;
}

.ic__error { margin: 0; color: var(--bad, #f56c6c); font-size: var(--t-xs); }
.ic__pending { margin: 0; color: var(--text-muted); font-size: var(--t-xs); }
</style>
