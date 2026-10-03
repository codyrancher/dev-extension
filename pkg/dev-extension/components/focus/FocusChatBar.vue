<script setup lang="ts">
/**
 * The bar across the bottom: the conversation, and the only thing on the page that is not a card.
 *
 * Two states, one element. Collapsed it is a single line - quiet enough to read past, saying
 * what it is for; expanded it is the conversation itself and a composer, with the deck dimmed
 * behind it rather than gone, because the card is still the subject.
 *
 * What it is *not* is a chat of its own. The prototype this came from kept its own history, and
 * a second place where half of what you asked ends up is the one thing this product should not
 * grow: the history in here is the product's conversation (the pane is handed in as a slot, see
 * pages/Focus.vue), so what you ask from a card is in the same place as what you ask anywhere
 * else - and still there tomorrow.
 *
 * Settings sits at one end and the queue at the other, and both stay put across the change of
 * state so the bar does not rearrange itself under the pointer.
 */
import { computed, ref, watch } from 'vue';
import AppIcon from './AppIcon.vue';
import IconButton from './IconButton.vue';

const props = defineProps<{
  open: boolean;
  /** The card the chat would be about, for the line that says so. */
  about?: string;
  /** Whether a conversation exists yet; until it does the bar says what pressing it will do. */
  live?: boolean;
  /** Something is on its way: the composer waits rather than pretending it sent. */
  busy?: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:open', open: boolean): void;
  (e: 'settings'): void;
  (e: 'queue'): void;
}>();

const preview = computed(() => {
  if (props.busy) {
    return 'Sending…';
  }
  if (props.about) {
    return `Ask about “${ props.about }”`;
  }

  return props.live ? 'Ask the agent' : 'Ask the agent about anything here';
});

</script>

<template>
  <!-- The dim behind an open bar: the deck is still there, just not what you are reading. -->
  <Transition name="veil">
    <div v-if="open" class="veil" @click="emit('update:open', false)" />
  </Transition>

  <section class="bar" :class="{ 'bar--open': open }" aria-label="The conversation">
    <IconButton name="settings" label="Settings" class="bar__end" @click="emit('settings')" />

    <div class="bar__middle">
      <Transition name="history">
        <div v-if="open" class="bar__history">
          <!-- The product's own conversation, handed in. See the note at the top. -->
          <slot name="history" />
        </div>
      </Transition>

      <div class="bar__line">
        <button
          v-if="!open"
          type="button"
          class="bar__peek"
          @click="emit('update:open', true)"
        >
          <AppIcon name="sparkle" :size="15" class="bar__peek-mark" />
          <span class="bar__peek-text">{{ preview }}</span>
          <AppIcon name="chevron-up" :size="15" class="bar__peek-chevron" />
        </button>

        <!--
          Open, there is no box here.
          
          The conversation handed in through the slot has its own composer - the real one, with
          the model, the slash commands, the attachments and the queue - and this bar used to draw
          a second textarea under it that sent the same text to the same place with none of that.
          Two boxes, one of them worse. What is left is the one control the bar still owns.
        -->
        <template v-else>
          <span v-if="about" class="bar__about" :title="about">about {{ about }}</span>
          <button type="button" class="bar__close" title="Close the conversation" aria-label="Close the conversation" @click="emit('update:open', false)">
            <AppIcon name="chevron-down" :size="16" />
          </button>
        </template>
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

.bar {
  position: fixed;
  z-index: 50;
  left: 50%;
  bottom: clamp(var(--s3), 2.4vh, var(--s5));
  display: flex;
  /*
   * Collapsed, the three pieces are one row and they line up on their middles. Open, the
   * middle one grows upward into a panel, and the two ends stay down with the composer rather
   * than floating half way up it.
   */
  align-items: center;
  gap: var(--s3);
  width: min(980px, calc(100vw - var(--s5)));
  transform: translateX(-50%);
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

/* ── Collapsed: one line, quiet ───────────────────────────────────────────── */
.bar__line {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--s2);
  padding: var(--s2);
  min-height: 42px;
}

.bar__peek {
  display: flex;
  align-items: center;
  gap: var(--s3);
  width: 100%;
  min-width: 0;
  padding: var(--s2) var(--s3);
  border: 0;
  border-radius: var(--r-md);
  background: transparent;
  color: var(--text-muted);
  font-size: var(--t-sm);
  text-align: left;
  cursor: pointer;
  transition: background var(--fast) var(--ease-out), color var(--fast) var(--ease-out);
}

.bar__peek:hover { background: rgba(255, 255, 255, 0.04); color: var(--text-dim); }
.bar__peek-mark { color: var(--accent); flex: none; }
.bar__peek-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bar__peek-chevron { flex: none; opacity: 0.6; transition: transform var(--base) var(--ease-spring); }
.bar__peek:hover .bar__peek-chevron { transform: translateY(-2px); }

/* ── Expanded: the history and the composer ───────────────────────────────── */
.bar__history {
  display: flex;
  flex-direction: column;
  /* A height rather than a maximum, and no scrolling of its own: what is handed in is the
     product's conversation pane, which sizes itself from its box and scrolls inside it. */
  height: min(52vh, 460px);
  min-height: 0;
  padding: var(--s3) var(--s3) 0;
  overflow: hidden;
}

.history-enter-active { transition: height var(--slow) var(--ease-out), opacity var(--base) var(--ease-out); }
.history-leave-active { transition: height var(--base) var(--ease-in-out), opacity var(--fast) linear; }
.history-enter-from,
.history-leave-to { height: 0; opacity: 0; }

.bar__about {
  flex: none;
  padding: 3px 9px;
  border-radius: var(--r-pill);
  background: var(--surface-sunk);
  color: var(--text-muted);
  font-size: var(--t-xs);
  white-space: nowrap;
}

.bar__close {
  display: grid;
  place-items: center;
  flex: none;
  width: 34px;
  height: 34px;
  border: 0;
  border-radius: var(--r-pill);
  cursor: pointer;
  transition: background var(--fast), color var(--fast), transform var(--fast) var(--ease-spring);
}

/* Whatever is handed in as the history fills the box it is given. */
.bar__history > :deep(*) { height: 100%; min-height: 0; }
</style>
