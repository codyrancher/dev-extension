<script setup lang="ts">
/**
 * A panel that comes in from the side: the tasks list and the settings, which are the two things
 * the chat bar's ends open. One component, because they are the same object - a sheet over the
 * deck with a title and a close - and two would drift apart.
 */
import AppIcon from './AppIcon.vue';

defineProps<{ open: boolean; title: string; side?: 'left' | 'right' }>();
const emit = defineEmits<{ (e: 'close'): void }>();
</script>

<template>
  <Teleport to="body">
    <Transition name="sheet-veil">
      <div v-if="open" class="sheet-veil" @click="emit('close')" />
    </Transition>

    <Transition :name="side === 'left' ? 'sheet-left' : 'sheet-right'">
      <aside v-if="open" class="sheet" :class="`sheet--${ side || 'right' }`" role="dialog" :aria-label="title">
        <header class="sheet__head">
          <h2 class="sheet__title">{{ title }}</h2>
          <button type="button" class="sheet__close" aria-label="Close" @click="emit('close')">
            <AppIcon name="cross" :size="16" />
          </button>
        </header>
        <div class="sheet__body"><slot /></div>
      </aside>
    </Transition>
  </Teleport>
</template>

<style scoped>
.sheet-veil {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: rgba(6, 8, 14, 0.6);
  backdrop-filter: blur(4px);
}

.sheet {
  position: fixed;
  z-index: 61;
  top: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  width: min(420px, 92vw);
  border-left: 1px solid var(--border);
  background: var(--surface);
  box-shadow: var(--shadow-3);
}

.sheet--right { right: 0; }
.sheet--left { left: 0; border-left: 0; border-right: 1px solid var(--border); }

.sheet__head {
  display: flex;
  align-items: center;
  gap: var(--s3);
  padding: var(--s5);
  border-bottom: 1px solid var(--border);
}

.sheet__title { flex: 1 1 auto; font-size: var(--t-lg); }

.sheet__close {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--border);
  border-radius: var(--r-pill);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: color var(--fast), border-color var(--fast);
}

.sheet__close:hover { color: var(--text); border-color: var(--border-strong); }
.sheet__body { flex: 1 1 auto; overflow-y: auto; padding: var(--s5); }

.sheet-veil-enter-active,
.sheet-veil-leave-active { transition: opacity var(--base) var(--ease-out); }
.sheet-veil-enter-from,
.sheet-veil-leave-to { opacity: 0; }

.sheet-right-enter-active,
.sheet-left-enter-active { transition: transform var(--slow) var(--ease-spring); }
.sheet-right-leave-active,
.sheet-left-leave-active { transition: transform var(--base) var(--ease-in-out); }
.sheet-right-enter-from,
.sheet-right-leave-to { transform: translateX(100%); }
.sheet-left-enter-from,
.sheet-left-leave-to { transform: translateX(-100%); }
</style>
