<script setup lang="ts">
/**
 * The conversation, scrolled.
 *
 * Everything about *what* a turn is comes in as a prop - the composable worked it out - so the
 * only things this owns are the two that are genuinely about being on a screen: where the
 * scroller is, and whether to follow the bottom.
 *
 * `grew` and `restarted` are counters rather than events because the conversation has no
 * emitter: it is a composable, and a host that watched a boolean would miss two polls that
 * landed in the same tick. A log follows the bottom only while the person is already there, so
 * reading back is never interrupted; a restart - the first load, a different conversation, a
 * subagent's transcript - goes to the bottom unconditionally, because that is where the
 * conversation is.
 *
 * Paths are handled by delegation rather than by a handler per link: `linkPaths` in chat.ts
 * writes `data-path` into the rendered HTML, and there are hundreds of them in a long log.
 */
import { computed, nextTick, ref, watch } from 'vue';
import ChatTurn from './ChatTurn.vue';
import type { ConversationTurn } from '../../chat-conversation';

const props = defineProps<{
  turns: ConversationTurn[];
  /** claude is mid-turn, and what it says it is doing. */
  working?: boolean;
  status?: string;
  /** What to say when there is nothing yet, which depends on why there is nothing. */
  empty?: string;
  times?: boolean;
  toolIo?: boolean;
  thoughts?: boolean;
  /** Bumped by the conversation when a poll landed transcript, and when it landed a new one. */
  grew?: number;
  restarted?: number;
}>();

const emit = defineEmits<{
  (e: 'resend', turn: ConversationTurn): void;
  (e: 'path', path: string): void;
  (e: 'stop'): void;
}>();

const log = ref<HTMLElement | null>(null);
const atBottom = ref(true);

function scrollToEnd(force = false): void {
  const el = log.value;

  if (el && (force || atBottom.value)) {
    el.scrollTop = el.scrollHeight;
    atBottom.value = true;
  }
}

/*
 * Your own messages, one at a time, either way.
 *
 * The drawer has had this for a while and it is the quickest way back to a question you asked
 * twenty turns ago - the agent's answers are long, yours are short, and scrolling past them is
 * most of the work of finding one. The deck's chats render through this component, so putting it
 * here gives it to the bar and to every inline chat at once.
 */
const mineAt = ref(-1);

/* Whether stepping is worth offering: one message of yours needs no way to find it. */
const mineCount = computed(() => props.turns.filter((turn) => turn.role === 'user').length);

function stepMine(direction: number): void {
  const el = log.value;
  const mine = [...(el?.querySelectorAll('.turn--user') || [])] as HTMLElement[];

  if (!el || !mine.length) {
    return;
  }
  const next = mineAt.value < 0
    ? (direction > 0 ? 0 : mine.length - 1)
    : Math.min(mine.length - 1, Math.max(0, mineAt.value + direction));

  mineAt.value = next;
  mine.forEach((one) => one.classList.remove('turn--found'));
  mine[next].classList.add('turn--found');

  /*
   * The log's own scrollTop, not `scrollIntoView`.
   *
   * `scrollIntoView` walks every scrollable ancestor, and this component is inside a card
   * inside a deck: it moved the whole page and left it somewhere it would not come back from,
   * which is the fault `showInPane` was written for in ChangeSet. Here the scroller is known,
   * so the sum is simple and nothing outside it moves.
   */
  el.scrollTop = Math.max(0, mine[next].offsetTop - el.clientHeight / 2 + mine[next].offsetHeight / 2);
  atBottom.value = false;
}

/* A new message means the marked one is no longer where you left off. */
watch(() => props.turns.length, () => { mineAt.value = -1; });

function onScroll(): void {
  const el = log.value;

  atBottom.value = !!el && el.scrollHeight - el.scrollTop - el.clientHeight < 40;
}

/** A click anywhere in the log that landed on something with a path. */
function onClick(event: MouseEvent): void {
  const hit = (event.target as HTMLElement | null)?.closest?.('[data-path]') as HTMLElement | null;

  if (!hit) {
    return;
  }
  event.preventDefault();
  emit('path', hit.dataset.path || '');
}

watch(() => props.grew, () => nextTick(() => scrollToEnd()));
watch(() => props.restarted, () => nextTick(() => scrollToEnd(true)));
// The turns themselves, for anything that changes the height without the transcript growing:
// a thumbnail arriving, a tool row opened, the bar going from one line to a panel.
//
// A message the person has just sent goes to the bottom wherever they were reading: it is drawn
// the moment it is sent, and the poll that would otherwise bring it into view is half a second
// behind it.
watch(() => props.turns.length, (now, before) => {
  const sent = now > before && !!props.turns[now - 1]?.queued;

  nextTick(() => scrollToEnd(sent));
});
// The working row is one more row at the bottom, and it arrives between polls too.
watch(() => props.working, (now) => now && nextTick(() => scrollToEnd()));

defineExpose({ scrollToEnd, atBottom });
</script>

<template>
  <div class="turns">
    <div
      ref="log"
      class="turns__log"
      @click="onClick"
      @scroll.passive="onScroll"
    >
      <p v-if="!turns.length && empty" class="turns__empty">{{ empty }}</p>

      <ChatTurn
        v-for="turn in turns"
        :key="turn.key"
        :turn="turn"
        :times="times"
        :tool-io="toolIo"
        :thoughts="thoughts"
        @resend="emit('resend', $event)"
      />

      <!-- Working: said where the next message will appear, moving, so it reads as happening. -->
      <div v-if="working" class="turns__working">
        <span class="turns__dots"><i /><i /><i /></span>
        <span class="turns__status">{{ status || 'Working' }}</span>
        <button type="button" class="turns__stop" @click="emit('stop')">Stop</button>
      </div>
    </div>

    <!--
      Back to the bottom, only while you are not there.

      Over the log rather than in a row of its own: a row that appears and disappears between
      the transcript and the composer moves both of them, and this view has been through that
      with four other rows already.
    -->
    <!--
      Where you have been, and where the newest is. Only while there is something to step
      through: a chat with one message of yours in it does not need a way to find it.
    -->
    <div class="turns__nav">
      <template v-if="mineCount > 1">
        <button type="button" class="turns__jump" title="Your previous message" @click="stepMine(-1)">↑ mine</button>
        <button type="button" class="turns__jump" title="Your next message" @click="stepMine(1)">↓ mine</button>
      </template>
      <Transition name="turns-jump">
        <button
          v-if="!atBottom"
          type="button"
          class="turns__jump"
          title="Jump to the newest"
          @click="scrollToEnd(true)"
        >
          ↓ newest
        </button>
      </Transition>
    </div>
  </div>
</template>

<style scoped>
/* The two controls that find a message, kept together at the corner the jump already used. */
.turns__nav {
  position: absolute;
  right: var(--turns-gutter, var(--s3));
  bottom: var(--s3);
  display: flex;
  gap: var(--s1, 4px);
  z-index: 2;
}

/* Where stepping landed. A ring, because changing the background would read as a new state. */
.turn--found { box-shadow: 0 0 0 2px var(--accent); border-radius: var(--r-sm); }

.turns {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
}

/*
 * A column flex with a gap, which is what gives the deck's chat its rhythm - and the reason
 * every child in here carries `flex: 0 0 auto`. A flex child shrinks below its content by
 * default, and a turn that is squeezed and does not clip paints over the turn under it.
 */
.turns__log {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  gap: var(--s4);
  min-height: 0;
  overflow-y: auto;
  padding: var(--s4) var(--s4) var(--s2);
  /*
   * The scrollbar sits on the element's edge, outside its padding - so in a panel it rides the
   * wall while everything else in there is inset. A host that wants it brought in sets this;
   * zero by default, so the drawer's pane is unchanged.
   */
  margin-right: var(--turns-gutter, 0);
  overscroll-behavior: contain;
}

.turns__empty {
  flex: 0 0 auto;
  margin: auto;
  color: var(--text-muted);
  font-size: var(--t-sm);
  text-align: center;
}

.turns__working {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  gap: var(--s3);
  color: var(--text-muted);
  font-size: var(--t-sm);
}

.turns__dots {
  display: inline-flex;
  flex: 0 0 auto;
  gap: var(--s1);
}

.turns__dots i {
  width: 6px;
  height: 6px;
  border-radius: var(--r-pill);
  background: var(--text-muted);
  animation: turns-pulse 1.4s infinite ease-in-out;
}

.turns__dots i:nth-child(2) { animation-delay: 0.16s; }
.turns__dots i:nth-child(3) { animation-delay: 0.32s; }

@keyframes turns-pulse {
  0%, 80%, 100% { opacity: 0.25; }
  40% { opacity: 1; }
}

.turns__status {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.turns__stop {
  flex: 0 0 auto;
  min-height: 30px;
  padding: 0 var(--s3);
  border-radius: var(--r-pill);
  color: var(--accent);
  font-size: var(--t-xs);
  cursor: pointer;
}

.turns__stop:hover { background: var(--accent-wash); }

/*
 * The buttons themselves are in the flow now; `.turns__nav` places the row.
 *
 * This was `position: absolute` with its own right and bottom, which was fine while it was the
 * only one of them - and would have stacked all three in the same corner the moment there were
 * three, because each would have positioned against the same containing block rather than
 * sitting beside its neighbour.
 */
.turns__jump {
  flex: 0 0 auto;
  min-height: 30px;
  padding: 0 var(--s3);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-pill);
  background: var(--surface-raised);
  box-shadow: var(--shadow-2);
  color: var(--text-dim);
  font-size: var(--t-xs);
  cursor: pointer;
}

.turns__jump:hover { color: var(--text); }

.turns-jump-enter-active,
.turns-jump-leave-active { transition: opacity var(--fast) var(--ease-out); }
.turns-jump-enter-from,
.turns-jump-leave-to { opacity: 0; }
</style>
