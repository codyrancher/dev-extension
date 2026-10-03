<script setup lang="ts">
/**
 * A long piece of prose, read over the card rather than on it.
 *
 * A pull request's description is the one artifact with no natural size: three lines on one and
 * two screens on the next. Put on the card it either takes the card - which is what happened, a
 * description eating the space the diff was supposed to be in - or it is clipped to a few lines,
 * which is a paragraph cut off mid-sentence and no use to anybody.
 *
 * So the card carries a control that says what it is and how much there is, and this opens it at
 * a readable width over the top. The same shape as the whole-file view, for the same reason: it
 * is a thing you dip into and come back from.
 */
import {
  onBeforeUnmount, onMounted
} from 'vue';
import AppIcon from './AppIcon.vue';
import Markdown from './Markdown.vue';
import { holdOverlay, releaseOverlay } from './overlay';

const props = defineProps<{ title: string; text: string; at?: string }>();

const emit = defineEmits<{ (e: 'close'): void }>();

function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.stopPropagation();
    emit('close');
  }
}

onMounted(() => {
  holdOverlay();
  window.addEventListener('keydown', onKey, true);
});

onBeforeUnmount(() => {
  releaseOverlay();
  window.removeEventListener('keydown', onKey, true);
});
</script>

<template>
  <!-- Teleported and carrying the view's class: the deck transforms every card it holds. -->
  <Teleport to="body">
    <div class="dev-focus said-layer">
      <div class="said-veil" @click="emit('close')" />

      <div class="said" role="dialog" :aria-label="title">
        <header class="said__head">
          <span class="said__title">{{ title }}</span>
          <span v-if="at" class="said__at">{{ at }}</span>
          <button type="button" class="said__close" aria-label="Close" @click="emit('close')">
            <AppIcon name="cross" :size="15" />
          </button>
        </header>

        <!--
          The prose, through the one component that draws prose. This dialog had its own
          `renderMd` call and its own fourteen `:deep()` blocks - h1-h3, p, ul/ol, li, a, strong,
          code, pre, pre code, table, th, td - the same declarations as Markdown.vue down to the
          `padding: 1px 5px` on code and the `width: max-content` on a table, written twice on
          the same evening. What is left here is the scroll container and the padding, which is
          the only part a dialog has an opinion about.
        -->
        <div class="said__body">
          <Markdown :text="props.text" />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.said-layer { position: fixed; inset: 0; z-index: 70; }

.said-veil {
  position: fixed;
  inset: 0;
  background: rgba(6, 8, 14, 0.62);
  backdrop-filter: blur(4px);
}

.said {
  position: fixed;
  top: 50%;
  left: 50%;
  display: flex;
  flex-direction: column;
  /* 78ch of prose: the width a paragraph is read at, not the width the window happens to be. */
  width: min(860px, 92vw);
  height: min(760px, 84vh);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-xl);
  background: var(--surface);
  box-shadow: var(--shadow-3);
  overflow: hidden;
  transform: translate(-50%, -50%);
}

.said__head {
  display: flex;
  align-items: center;
  gap: var(--s3);
  flex: 0 0 auto;
  padding: var(--s3) var(--s4);
  border-bottom: 1px solid var(--border);
  background: var(--surface-sunk);
}

.said__title { color: var(--text); font-size: var(--t-sm); font-weight: 650; }
.said__at { color: var(--text-faint); font-size: var(--t-xs); }

.said__close {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 30px;
  height: 30px;
  margin-left: auto;
  border: 1px solid var(--border);
  border-radius: var(--r-pill);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}

.said__close:hover { border-color: var(--border-strong); color: var(--text); }

.said__body {
  flex: 1 1 auto;
  min-height: 0;
  padding: var(--s5);
  overflow: hidden auto;
}
</style>
