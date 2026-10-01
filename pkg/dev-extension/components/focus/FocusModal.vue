<script setup lang="ts">
/**
 * The settings, as a dialog over the deck.
 *
 * It was a 420px sheet sliding in from the side, which is the right shape for a list and the
 * wrong one for everything that is in here: a chart of twenty-four weights, a gallery of cards
 * drawn as cards, a queue of thirty rows. All three were being folded into a column a third of
 * the screen wide and read like a form in a drawer.
 *
 * So: a dialog in the middle, as wide as the content wants, with the sections down the left and
 * one of them open on the right. The deck dims behind it rather than disappearing - it is what
 * everything in here is about - and the whole thing closes on Escape, on the veil, and on the
 * one control in the corner.
 */
import { onBeforeUnmount, onMounted } from 'vue';
import AppIcon from './AppIcon.vue';

export interface ModalSection {
  id: string;
  label: string;
  /** How many things are in it, when that is a number worth seeing from outside. */
  count?: number;
  /** One line about what the section is for, under the title. */
  about?: string;
}

const props = defineProps<{
  open: boolean;
  title: string;
  sections: ModalSection[];
  current: string;
}>();

const emit = defineEmits<{ (e: 'close'): void; (e: 'select', id: string): void }>();

const here = () => props.sections.find((section) => section.id === props.current) || props.sections[0];

function onKey(event: KeyboardEvent) {
  if (props.open && event.key === 'Escape') {
    event.stopPropagation();
    emit('close');
  }
}

onMounted(() => window.addEventListener('keydown', onKey, true));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true));
</script>

<template>
  <!--
    Teleported to the body, and carrying the view's own class with it.

    `.dev-focus` is where this view's tokens are declared - its palette, its spacing scale, its
    type - and a dialog moved to the end of the document is outside that element. Without the
    class every `var(--s3)` in here resolves to nothing: the padding collapses, the colours fall
    back to the dashboard's, and the dialog renders as the shell's idea of a form. Measured
    rather than guessed - the rows came back with `padding: 0px` and 44px chips.
  -->
  <Teleport to="body">
    <div class="dev-focus dev-focus--overlay">
    <Transition name="veil">
      <div
        v-if="open"
        class="veil"
        @click="emit('close')"
      />
    </Transition>

    <Transition name="dialog">
      <div
        v-if="open"
        class="dialog"
        role="dialog"
        :aria-label="title"
      >
        <!-- The sections, down the side: what this dialog is a dialog about. -->
        <nav class="dialog__rail">
          <h2 class="dialog__brand">{{ title }}</h2>
          <button
            v-for="section in sections"
            :key="section.id"
            type="button"
            class="dialog__section"
            :class="{ 'dialog__section--on': section.id === current }"
            @click="emit('select', section.id)"
          >
            <span class="dialog__section-label">{{ section.label }}</span>
            <span
              v-if="section.count !== undefined"
              class="dialog__section-count"
            >{{ section.count }}</span>
          </button>
        </nav>

        <div class="dialog__main">
          <header class="dialog__head">
            <div class="dialog__head-text">
              <h3 class="dialog__title">{{ here()?.label }}</h3>
              <p
                v-if="here()?.about"
                class="dialog__about"
              >{{ here()?.about }}</p>
            </div>
            <button
              type="button"
              class="dialog__close"
              aria-label="Close"
              @click="emit('close')"
            >
              <AppIcon name="cross" :size="16" />
            </button>
          </header>

          <div class="dialog__body">
            <slot />
          </div>

          <footer
            v-if="$slots.actions"
            class="dialog__foot"
          >
            <slot name="actions" />
          </footer>
        </div>
      </div>
    </Transition>
    </div>
  </Teleport>
</template>

<style scoped>
/* A box of nothing: it exists to carry the class, and the two things in it are fixed. */
.dev-focus--overlay {
  position: fixed;
  inset: 0;
  z-index: 60;
  pointer-events: none;
}

.dev-focus--overlay > * { pointer-events: auto; }

.veil {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: rgba(6, 8, 14, 0.62);
  backdrop-filter: blur(4px);
}

.dialog {
  position: fixed;
  top: 50%;
  left: 50%;
  z-index: 61;
  display: grid;
  /* The rail, then everything else. A fixed rail because its labels are four short words. */
  grid-template-columns: 196px minmax(0, 1fr);
  width: min(1040px, 94vw);
  height: min(720px, 86vh);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-xl);
  background: var(--surface);
  box-shadow: var(--shadow-3);
  overflow: hidden;
  transform: translate(-50%, -50%);
}

/* ── The sections ──────────────────────────────────────────────────────────────────────────── */
.dialog__rail {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--s4) var(--s3);
  border-right: 1px solid var(--border);
  background: var(--surface-sunk);
}

.dialog__brand {
  padding: 0 var(--s3) var(--s3);
  color: var(--text-muted);
  font-size: var(--t-xs);
  font-weight: 650;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.dialog__section {
  display: flex;
  align-items: center;
  gap: var(--s2);
  height: 36px;
  padding: 0 var(--s3);
  border-radius: var(--r-sm);
  color: var(--text-muted);
  font-size: var(--t-sm);
  text-align: left;
  transition: background var(--fast), color var(--fast);
}

.dialog__section:hover { color: var(--text); background: var(--surface-raised); }

.dialog__section--on {
  background: var(--accent-wash);
  color: var(--accent);
  font-weight: 600;
}

.dialog__section-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.dialog__section-count {
  flex: 0 0 auto;
  color: var(--text-faint);
  font-size: var(--t-xs);
  font-variant-numeric: tabular-nums;
}

.dialog__section--on .dialog__section-count { color: var(--accent); }

/* ── What is open ──────────────────────────────────────────────────────────────────────────── */
.dialog__main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.dialog__head {
  display: flex;
  align-items: flex-start;
  gap: var(--s4);
  padding: var(--s5) var(--s5) var(--s4);
  border-bottom: 1px solid var(--border);
}

.dialog__head-text { min-width: 0; }
.dialog__title { color: var(--text); font-size: var(--t-lg); }
.dialog__about { margin-top: 4px; color: var(--text-muted); font-size: var(--t-sm); max-width: 68ch; }

.dialog__close {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 32px;
  height: 32px;
  margin-left: auto;
  border: 1px solid var(--border);
  border-radius: var(--r-pill);
  color: var(--text-muted);
  transition: color var(--fast), border-color var(--fast);
}

.dialog__close:hover { color: var(--text); border-color: var(--border-strong); }

.dialog__body {
  flex: 1 1 auto;
  min-height: 0;
  padding: var(--s5);
  overflow-y: auto;
}

.dialog__foot {
  display: flex;
  align-items: center;
  gap: var(--s2);
  flex: 0 0 auto;
  padding: var(--s4) var(--s5);
  border-top: 1px solid var(--border);
  background: var(--surface-sunk);
}

/* ── Coming and going ──────────────────────────────────────────────────────────────────────── */
.veil-enter-active { transition: opacity var(--base) var(--ease-out); }
.veil-leave-active { transition: opacity var(--fast) linear; }
.veil-enter-from,
.veil-leave-to { opacity: 0; }

.dialog-enter-active { transition: opacity var(--base) var(--ease-out), transform var(--base) var(--ease-spring); }
.dialog-leave-active { transition: opacity var(--fast) linear, transform var(--fast) var(--ease-in-out); }
.dialog-enter-from,
.dialog-leave-to { opacity: 0; transform: translate(-50%, -46%) scale(0.98); }

@media (max-width: 820px) {
  .dialog {
    width: 96vw;
    height: 90vh;
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
  }

  /* On a phone the sections are a strip across the top, not a column beside the content. */
  .dialog__rail {
    flex-direction: row;
    overflow-x: auto;
    border-right: 0;
    border-bottom: 1px solid var(--border);
  }

  .dialog__brand { display: none; }
  .dialog__section { flex: 0 0 auto; }
}
</style>
