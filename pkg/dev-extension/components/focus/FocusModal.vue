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
 *
 * The veil, the corner, Escape and the phone's full screen are DevModal's, the one dialog; this
 * is the sections down the side and the one that is open.
 */
import DevModal from '../DevModal.vue';

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

</script>

<template>
  <DevModal
    v-if="open"
    focus
    size="wide"
    :title="title"
    @close="emit('close')"
  >
    <div class="dialog">
      <!-- The sections, down the side: what this dialog is a dialog about. -->
      <nav class="dialog__rail">
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
          <h3 class="dialog__title">{{ here()?.label }}</h3>
          <p
            v-if="here()?.about"
            class="dialog__about"
          >{{ here()?.about }}</p>
        </header>

        <div class="dialog__body">
          <slot />
        </div>
      </div>
    </div>

    <template
      v-if="$slots.actions"
      #footer
    >
      <slot name="actions" />
    </template>
  </DevModal>
</template>

<style scoped>
/* The sections, then everything else. A fixed rail because its labels are four short words. */
.dialog {
  display: grid;
  grid-template-columns: 196px minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  flex: 1 1 auto;
  min-height: 0;
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
  flex: 0 0 auto;
  padding: var(--s4) var(--s5) 0;
}

.dialog__title { color: var(--text); font-size: var(--t-lg); }
.dialog__about { margin-top: 4px; color: var(--text-muted); font-size: var(--t-sm); max-width: 68ch; }

.dialog__body {
  flex: 1 1 auto;
  min-height: 0;
  padding: var(--s5);
  overflow-y: auto;
}

@media (max-width: 760px) {
  .dialog {
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

  .dialog__section { flex: 0 0 auto; }
  .dialog__head { padding: var(--s4) var(--s4) 0; }
  .dialog__body { padding: var(--s4); }
}
</style>
