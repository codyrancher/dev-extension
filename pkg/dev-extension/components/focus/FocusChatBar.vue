<script setup lang="ts">
/**
 * The bar across the bottom: the conversation, and the only thing on the page that is not a card.
 *
 * Two states, one element. Shut it is a single line you type into - quiet enough to read past,
 * and still a chat: what you type goes to the agent, Enter sends it, and the line says when
 * claude is working or waiting on you. Open it is the conversation itself over the dimmed deck,
 * because the card is still the subject.
 *
 * It used to be a *launcher*. Shut, it was a button reading `Ask about "<card>"`; pressed, it
 * revealed the product's whole conversation pane - the drawer's chat, with the drawer's own
 * composer, its terminal toggle and its idea of layout - handed in through a `history` slot and
 * then dressed with 155 lines of overrides keyed on `.mc-chat--skin-loop` (design/focus-chat.css,
 * deleted with this change) to look like this. So a bar that was meant to be a chat was a button
 * in front of a different chat, and the one thing it could not do was be typed into.
 *
 * What makes this possible without a second chat is chat-conversation.ts: the transcript, the
 * live state, the send path, the queue, the pending reconciling and the questions are a
 * composable now, and this file and ChatPane.vue are two skins over one of them. So what you
 * ask here is in the same conversation as what you ask anywhere else, accounted for the same
 * way, and still there tomorrow - which was the right instinct in the note this replaces, now
 * achieved by sharing the conversation rather than by embedding the view.
 *
 * Settings sits at one end and the queue at the other, and both stay put across the change of
 * state so the bar does not rearrange itself under the pointer.
 */
import {
  computed, nextTick, ref, watch,
} from 'vue';
import AppIcon from './AppIcon.vue';
import IconButton from './IconButton.vue';
import ChatTurns from '../chat/ChatTurns.vue';
import ChatComposer from '../chat/ChatComposer.vue';
import ChatQuestion from '../chat/ChatQuestion.vue';
import { useConversation, type ConversationTurn } from '../../chat-conversation';
import { readLook } from '../../look';
import { EXT_NS } from '../../pod';
import { AGENT_CONTAINER } from '../../agent';

const props = defineProps<{
  open: boolean;
  /** The card the chat would be about, for the line that says so. */
  about?: string;
  /**
   * That card written out, for the button that puts it in the message.
   *
   * One conversation serves the whole deck, so a question typed here arrives with no idea which
   * card was on screen when it was asked. Rather than prepending this to everything - most
   * messages are a follow-up in a thread that already knows - it is a button, and what it adds
   * is ordinary text the person can edit or delete.
   */
  context?: string;
  /**
   * The conversation this bar is: the agent pod's own, or a workspace's when a card with one
   * is asked about. Empty until the page makes one, which it does on the first open or ask -
   * arriving at the Focus page should not start a conversation.
   */
  session?: string;
  /**
   * The argv for a conversation that is not one of the agent pod's own. A workspace's runs in
   * the agent pod but in that workspace's checkout, which is a different `shell.sh` line - see
   * `paneCommand` in conversations.ts.
   */
  command?: string[] | null;
}>();

const emit = defineEmits<{
  (e: 'update:open', open: boolean): void;
  (e: 'settings'): void;
  (e: 'queue'): void;
  /** Somebody typed into the shut bar before the page had made a conversation. */
  (e: 'wake'): void;
}>();

/* ── The conversation ─────────────────────────────────────────────────────────────────────── */

/**
 * One conversation for this bar, switched rather than recreated.
 *
 * `enabled` is what keeps the page cheap: a poll is an exec into a pod every 1.5 seconds, and
 * the bar is on screen from the moment Focus loads while the conversation behind it is not made
 * until somebody opens or asks. So the bar reads nothing until it has a session.
 */
const chat = useConversation(() => ({
  session:   props.session || '',
  mode:      'claude' as const,
  command:   props.command || null,
  namespace: EXT_NS,
  container: AGENT_CONTAINER,
  imageDir:  '/workspace/.images',
  home:      '/workspace/.home',
  label:     'the agent',
  enabled:   !!props.session,
}));

// Destructured so the template reads them as plain names: a ref inside an object is not
// unwrapped in a template, only a top-level one is.
const {
  turns, working, pane, draft, canSend, sending, slashMatches, slashSpot, caret,
  grew, restarted, attached, file, error, pasting, pending,
} = chat;

/** The log's own preferences, shared with every other chat in the dashboard. See look.ts. */
const look = ref(readLook());

const composer = ref<InstanceType<typeof ChatComposer> | null>(null);

/**
 * What the shut line says when it is empty.
 *
 * It is a placeholder now rather than a sentence on a button, which is the difference between
 * "press this to ask" and "ask". Named after the card when there is one, because that is what
 * nine of ten questions from this deck are about.
 */
const hint = computed(() => (props.about ? `Ask about \u201c${ props.about }\u201d` : 'Ask the agent about anything here'));

/** The short word for what is going on: the shut bar's chip, and the open bar's status line. */
const doing = computed<{ kind: string; text: string } | null>(() => {
  if (error.value) {
    return { kind: 'error', text: error.value.slice(0, 90) };
  }
  if (pasting.value) {
    return { kind: 'busy', text: pasting.value };
  }
  if (pane.value.dialog) {
    return { kind: 'ask', text: 'Claude is waiting for you' };
  }
  if (working.value) {
    return { kind: 'busy', text: pane.value.status || 'Working' };
  }
  if (!props.session) {
    return null;
  }
  if (pane.value.gone) {
    return { kind: 'error', text: 'Claude is not running in this conversation' };
  }
  if (pending.value.some((p: { failed?: boolean }) => p.failed)) {
    return { kind: 'error', text: 'A message was not delivered' };
  }

  return null;
});

/** What the log says when there is nothing in it, which depends on why there is nothing. */
const nothing = computed(() => {
  if (!props.session) {
    return 'Starting a conversation\u2026';
  }
  if (!attached.value) {
    return 'Nothing is running in this conversation yet. Say something to start it.';
  }
  if (!file.value) {
    return 'Waiting for the conversation to begin.';
  }

  return 'Nothing has been said yet.';
});

/* ── Typing and sending ───────────────────────────────────────────────────────────────────── */

function setOpen(open: boolean): void {
  emit('update:open', open);
}

/**
 * Typing into the shut bar before the page has made a conversation.
 *
 * The page makes one on the first open or ask, and typing is an ask that has not finished yet -
 * so the first keystroke wakes it, and by the time Enter is pressed there is somewhere for the
 * message to go. Without this the first thing anybody typed went nowhere, which is the failure
 * this bar is meant to be the end of.
 */
/** Put the card's own description at the top of what is being written. */
function addContext(): void {
  const text = props.context || '';

  if (!text || draft.value.includes(text.trim().split('\n')[0])) {
    return;
  }
  onDraft(text + draft.value);
  setOpen(true);
  nextTick(() => composer.value?.focus?.());
}

function onDraft(text: string): void {
  draft.value = text;
  if (text && !props.session) {
    emit('wake');
  }
}

/**
 * Wait for the page to hand over a conversation id.
 *
 * Polled rather than watched because this is called from a handler rather than from setup, and
 * a `watch` created there is a watcher outside the component's scope - it would have to be
 * stopped by hand and would leak the first time an early return forgot to.
 */
async function waitForSession(timeoutMs = 8000): Promise<boolean> {
  const until = Date.now() + timeoutMs;

  // Asked once and then waited for. Asking on every turn of the loop would be eight requests
  // for one conversation, and the page's own guard is the only thing stopping that becoming
  // eight conversations - see `wakeChat` in pages/Focus.vue. One is clearer than two.
  emit('wake');
  while (!props.session && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  return !!props.session;
}

async function onSend(): Promise<void> {
  // Or `send` would paste into a pane whose id is the empty string.
  if (!props.session && !await waitForSession()) {
    return;
  }
  await chat.send();
}

/**
 * A card asking something, through the bar rather than past it.
 *
 * Every "ask" on every card in this deck - `Which ones matter?`, `Is it safe?`, `What changed?`,
 * `Who should review this?` - used to queue its prompt through the agent API and then open the
 * shell's terminal drawer over the card you had just asked about. They come through here now, so
 * a card's question is accounted for exactly like one typed: it shows as yours, it is reconciled
 * against the transcript, and the answer arrives in the bar that is already on screen. See
 * pages/Focus.vue.
 */
async function ask(prompt: string): Promise<boolean> {
  if (!props.session && !await waitForSession()) {
    return false;
  }
  setOpen(true);

  return chat.ask(prompt);
}

function focusBox(): void {
  composer.value?.focus();
}

/** Opening is also focusing: the first thing anybody does with an open chat is type in it. */
watch(() => props.open, (open) => {
  if (open) {
    nextTick(focusBox);
  }
});

/** An image pasted into the box: into the pod beside the pane, its path into the message. */
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

/**
 * The two answers that are not part of the conversation, and were being dropped.
 *
 * You can type anything into this box, including the things Claude Code answers somewhere other
 * than the conversation. `/cost` and `/status` print to the terminal and nowhere else, so the
 * conversation reads the pane back and hands over a `panel`; `/mcp` and `/permissions` open a
 * full-screen picker in the pane that no chat can draw, and the conversation says so with
 * `takenOver`. The drawer has a modal for the first and a warning with an Escape button for the
 * second. The bar had neither, so typing `/cost` into it did nothing anybody could see and
 * typing `/mcp` left the pane in a picker that ate every message typed afterwards.
 *
 * One line and a way out is enough here: the deck is not where somebody drives a terminal UI,
 * and the whole of `/usage` does not belong over a card. Escape is the one control that always
 * has to exist.
 */
const panel = chat.panel;
const takenOver = chat.takenOver;

function closePanel(): void {
  chat.panel.value = null;
}

/**
 * A path in what was said.
 *
 * The bar has no file viewer of its own - that is the drawer's, and a modal over a modal over
 * the deck is three layers for one file - so this says where it is and, when it is gone, says
 * that instead. Which is the half of it that matters: a path an agent named an hour ago is
 * usually either in the workspace or deleted, and silence does not distinguish them.
 */
const noted = ref('');
let noteTimer: ReturnType<typeof setTimeout> | null = null;

async function onPath(path: string): Promise<void> {
  const there = await chat.pathExists(path).catch(() => false);

  noted.value = there ? path : `${ path } is not in the workspace (any more).`;
  if (noteTimer) {
    clearTimeout(noteTimer);
  }
  noteTimer = setTimeout(() => {
    noted.value = '';
  }, 6000);
}

defineExpose({ ask, focus: focusBox });
</script>

<template>
  <!-- The dim behind an open bar: the deck is still there, just not what you are reading. -->
  <Transition name="veil">
    <div v-if="open" class="veil" @click="setOpen(false)" />
  </Transition>

  <section class="bar" :class="{ 'bar--open': open }" aria-label="The conversation">
    <IconButton name="settings" label="Settings" class="bar__end" @click="emit('settings')" />

    <div class="bar__middle">
      <Transition name="history">
        <div v-if="open" class="bar__history">
          <div class="bar__subject">
            <AppIcon name="sparkle" :size="14" class="bar__mark" />
            <span v-if="about" class="u-pill bar__about" :title="about">about {{ about }}</span>
            <button
              v-if="context"
              type="button"
              class="bar__context"
              title="Put this card's details into the message"
              @click="addContext"
            >
              <AppIcon name="plus" :size="12" />
              Add this card
            </button>
            <span class="bar__spacer" />
            <button
              type="button"
              class="bar__close"
              title="Close the conversation"
              aria-label="Close the conversation"
              @click="setOpen(false)"
            >
              <AppIcon name="chevron-down" :size="16" />
            </button>
          </div>

          <ChatTurns
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
            @path="onPath"
            @stop="chat.stop()"
          />

          <!-- The conversation waiting on you, above the composer so it cannot scroll away. -->
          <ChatQuestion
            v-if="pane.dialog"
            :dialog="pane.dialog"
            @choose="chat.choose($event)"
            @code="onCode"
          />

          <!--
            A pane the bar cannot draw, and the one way out of it that always exists. See the
            note on `takenOver` above; without this a typed `/mcp` was a conversation that
            silently stopped accepting messages.
          -->
          <div v-if="takenOver" class="bar__takeover">
            <span class="bar__takeover-text">Claude Code is showing something here the chat cannot draw.</span>
            <button type="button" class="bar__out" title="Send Escape to close it" @click="chat.escapePane()">Escape</button>
          </div>

          <!-- What the terminal printed for a command that answers only there. -->
          <div v-if="panel" class="bar__panel">
            <span class="bar__panel-title">{{ panel.title }}</span>
            <button type="button" class="bar__out" title="Close" aria-label="Close" @click="closePanel">Close</button>
            <pre class="bar__panel-text">{{ panel.text }}</pre>
          </div>

          <p v-if="noted || doing" class="bar__status" :class="doing ? `bar__status--${ doing.kind }` : ''">
            {{ noted || doing?.text }}
          </p>
        </div>
      </Transition>

      <div class="bar__line">
        <!--
          Shut, the mark says what this is; working, it says so where the sentence was, which is
          the one place on the page with room for it.
        -->
        <button
          v-if="!open && doing"
          type="button"
          class="bar__doing"
          :class="`bar__doing--${ doing.kind }`"
          :title="doing.text"
          @click="setOpen(true)"
        >
          <span class="bar__pip" />
          <span class="bar__doing-text">{{ doing.text }}</span>
        </button>
        <AppIcon v-else-if="!open" name="sparkle" :size="15" class="bar__mark" />

        <!--
          The one box. Shut it is one line and the chevron beside it opens the conversation;
          open it is the same component with room to write in. Nothing here keeps a draft of
          its own - see chat-conversation.ts - so what is typed shut is still there open.
        -->
        <ChatComposer
          ref="composer"
          :model-value="draft"
          :single="!open"
          :placeholder="open ? undefined : hint"
          :busy="working"
          :sending="sending"
          :can-send="canSend"
          :matches="slashMatches"
          :typing="!!slashSpot"
          class="bar__box"
          @update:model-value="onDraft"
          @caret="caret = $event"
          @pick="chat.pickCommand($event)"
          @paste="onPaste"
          @send="onSend"
          @expand="setOpen(true)"
        />
      </div>
    </div>

    <IconButton name="tasks" label="Everything waiting" class="bar__end" @click="emit('queue')" />
  </section>
</template>

<style scoped>
.veil {
  position: fixed;
  inset: 0;
  z-index: 40;
  background: rgba(6, 8, 14, 0.55);
  backdrop-filter: blur(3px);
}

.veil-enter-active,
.veil-leave-active { transition: opacity var(--base) var(--ease-out); }
.veil-enter-from,
.veil-leave-to { opacity: 0; }

/*
 * Over the card, and the width of the card.
 *
 * It was `left: 50%` with `width: min(980px, …)` and a `translateX(-50%)`, so it was centred on the
 * window: measured at 1024px that put its left edge at x=22, underneath the 196px pins column, and
 * made it 234px wider than the 746px card whose title it prints. The sentence `Ask about "<this
 * card's title>"` was centred on the window rather than on the thing it is about.
 *
 * The page publishes the two numbers that place the card - the pins column's width and the deck's
 * own left and right padding - as tokens on `.dev-focus`, so the bar is inset by exactly those and
 * then centred inside what is left, which is how `.deck__top` places the card. Same box, one
 * spine. See `--pins-w` in pages/Focus.vue.
 */
.bar {
  position: fixed;
  z-index: 50;
  left: calc(var(--pins-w, 0px) + var(--deck-pad-l, var(--s4)));
  right: var(--deck-pad-r, var(--s4));
  bottom: clamp(var(--s3), 2.4vh, var(--s5));
  display: flex;
  /*
   * Shut, the three pieces are one row and they line up on their middles. Open, the middle one
   * grows upward into a panel, and the two ends stay down with the composer rather than
   * floating half way up it.
   */
  align-items: center;
  gap: var(--s3);
  /* The card's own box: `min(1680px, 100%)`, centred in whatever the insets leave. */
  width: auto;
  max-width: min(1680px, 100%);
  margin-inline: auto;
}

.bar__end { flex: none; box-shadow: var(--shadow-2); }

.bar__middle {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  background: color-mix(in srgb, var(--surface) 86%, transparent);
  backdrop-filter: blur(14px) saturate(1.2);
  box-shadow: var(--shadow-2);
  overflow: hidden;
  transition: border-color var(--base) var(--ease-out), box-shadow var(--base) var(--ease-out);
}

.bar--open { align-items: flex-end; }

.bar--open .bar__middle {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-3);
}

/* ── Shut: one line you can type into ─────────────────────────────────────── */
/*
 * `--s1` vertically rather than `--s2`.
 *
 * The line used to hold a 36px button under 8px of padding either side and measured 54px, and
 * `--bar-h` - the room the deck holds back for this - is 56px. The composer's one-line shape is
 * a 30px field in 8px of its own, so the same `--s2` here would have made the bar 60px and the
 * deck would have been measured against a number that was no longer true.
 */
.bar__line {
  display: flex;
  align-items: center;
  gap: var(--s2);
  padding: var(--s1) var(--s2);
  min-height: 40px;
}

.bar__mark { color: var(--accent); flex: none; }
.bar__box { flex: 1 1 auto; min-width: 0; }

/*
 * What it is doing, shut: a pip and a few words where the sentence used to be.
 *
 * Shut, this bar had no way at all to say that claude was mid-turn or - worse - that it was
 * blocked on a question, because it was a button whose only job was to open something else. A
 * conversation you cannot see is the one that most needs to be able to say so.
 */
.bar__doing {
  display: flex;
  align-items: center;
  flex: 0 1 auto;
  gap: var(--s2);
  min-height: 30px;
  min-width: 0;
  max-width: 45%;
  padding: 0 var(--s2);
  border-radius: var(--r-pill);
  color: var(--text-muted);
  font-size: var(--t-xs);
  cursor: pointer;
}

.bar__doing:hover { background: rgba(255, 255, 255, 0.04); color: var(--text-dim); }

.bar__doing-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bar__pip {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: var(--r-pill);
  background: currentColor;
}

.bar__doing--busy { color: var(--accent); }
.bar__doing--busy .bar__pip { animation: bar-pulse 1.4s infinite ease-in-out; }
.bar__doing--ask { color: var(--warning); }
.bar__doing--error { color: var(--danger); }

@keyframes bar-pulse {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 1; }
}

/* ── Open: the conversation, and what it is about ─────────────────────────── */
.bar__history {
  display: flex;
  flex-direction: column;
  /*
   * A height rather than a maximum: the panel should not resize itself as the conversation
   * grows, which it would do on every poll. `min-height: 0` so the scroller inside it is the
   * thing that scrolls - without it a flex column hands its child the child's content height
   * and the whole panel grows instead.
   */
  height: min(52vh, 460px);
  min-height: 0;
  overflow: hidden;
}

.history-enter-active { transition: height var(--slow) var(--ease-out), opacity var(--base) var(--ease-out); }
.history-leave-active { transition: height var(--base) var(--ease-in-out), opacity var(--fast) linear; }
.history-enter-from,
.history-leave-to { height: 0; opacity: 0; }

.bar__subject {
  display: flex;
  align-items: center;
  /* `0 0 auto`, or this row is squeezed to nothing by the scroller under it. */
  flex: 0 0 auto;
  gap: var(--s2);
  min-width: 0;
  padding: var(--s2) var(--s3) 0;
}

.bar__spacer { flex: 1 1 auto; }

/* `.u-pill` carries the box; the bar's subject tag is a sunk surface and a quiet colour. */
.bar__about {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  background: var(--surface-sunk);
  color: var(--text-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bar__close {
  display: grid;
  place-items: center;
  flex: none;
  width: 30px;
  height: 30px;
  border: 0;
  border-radius: var(--r-pill);
  color: var(--text-muted);
  cursor: pointer;
  transition: background var(--fast), color var(--fast);
}

.bar__close:hover { background: var(--surface-raised); color: var(--text); }

/* One line under the conversation: what it is doing, or what it just said about a file. */
.bar__status {
  flex: 0 0 auto;
  min-width: 0;
  overflow: hidden;
  margin: 0;
  padding: 0 var(--s4) var(--s1);
  color: var(--text-muted);
  font-size: var(--t-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bar__status--error { color: var(--danger); }
.bar__status--ask { color: var(--warning); }

/*
 * The two notices, which are a row rather than a modal: a dialog over a dialog over the deck is
 * three layers for one sentence. `flex: 0 0 auto` on both, because the scroller above them will
 * take every pixel it is allowed to.
 */
.bar__takeover,
.bar__panel {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  flex-wrap: wrap;
  gap: var(--s2);
  min-width: 0;
  margin: 0 var(--s3) var(--s2);
  border: 1px solid color-mix(in srgb, var(--warning) 45%, transparent);
  border-radius: var(--r-md);
  padding: var(--s2) var(--s3);
  background: var(--warning-wash);
  color: var(--text-dim);
  font-size: var(--t-xs);
}

.bar__takeover-text,
.bar__panel-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bar__panel-title { font-family: var(--mono); font-weight: 650; }

.bar__panel {
  border-color: var(--border-strong);
  background: var(--surface-sunk);
}

.bar__panel-text {
  flex: 1 1 100%;
  max-height: 140px;
  margin: 0;
  overflow: auto;
  color: var(--text-muted);
  font-family: var(--mono);
  font-size: var(--t-xs);
  line-height: 1.45;
  white-space: pre-wrap;
}

.bar__out {
  flex: none;
  min-height: 30px;
  padding: 0 var(--s3);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-pill);
  color: var(--text);
  font-size: var(--t-xs);
  cursor: pointer;
}

.bar__out:hover { border-color: var(--accent); color: var(--accent); }

.bar--open .bar__line { padding: 0 var(--s3) var(--s3); min-height: 0; }

/* "Add this card": quiet beside the subject line, and the same height as the pill next to it. */
.bar__context {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 6px;
  padding: 2px 8px;
  border: 1px solid var(--dev-line, #2b3240);
  border-radius: 999px;
  background: transparent;
  color: var(--dev-muted, #9aa3b2);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}

.bar__context:hover {
  color: var(--dev-text, #e6e9ef);
  border-color: var(--dev-accent, #4f8cff);
}
</style>
