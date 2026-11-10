<script setup lang="ts">
/** "Note deleted · Undo" for five seconds after a delete; Undo brings the note back and opens it. */
import { ref, watch, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import { useNotesStore } from '../../strata/stores';
import { DEV_PRODUCT, BLANK_CLUSTER, STRATA_NOTE_ROUTE } from '../../config/constants';

const router = useRouter();
const notesStore = useNotesStore();
const show = ref(false);
let timer: ReturnType<typeof setTimeout>;

watch(() => notesStore.lastDeletedNoteId, (id) => {
  clearTimeout(timer);
  show.value = !!id;
  if (id) {
    timer = setTimeout(() => {
      show.value = false;
      notesStore.lastDeletedNoteId = null;
    }, 5000);
  }
}, { immediate: true });

onBeforeUnmount(() => clearTimeout(timer));

async function undo() {
  const id = notesStore.lastDeletedNoteId;

  if (!id) {
    return;
  }
  clearTimeout(timer);
  show.value = false;
  notesStore.lastDeletedNoteId = null;
  await notesStore.restoreNote(id);
  router.push({ name: STRATA_NOTE_ROUTE, params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER, id } });
}

function dismiss() {
  clearTimeout(timer);
  show.value = false;
  notesStore.lastDeletedNoteId = null;
}
</script>

<template>
  <Teleport to="body">
    <Transition name="strata-toast">
      <div
        v-if="show"
        class="strata-toast"
        role="status"
        data-testid="strata-undo-toast"
      >
        <span>Note deleted</span>
        <button
          type="button"
          class="strata-toast__undo"
          data-testid="strata-undo"
          @click="undo"
        >
          Undo
        </button>
        <button
          type="button"
          class="strata-toast__dismiss"
          aria-label="Dismiss"
          @click="dismiss"
        >
          <i class="icon icon-close" />
        </button>
      </div>
    </Transition>
  </Teleport>
</template>

<style lang="scss" scoped>
.strata-toast {
  position:      fixed;
  left:          50%;
  bottom:        calc(24px + env(safe-area-inset-bottom, 0px));
  z-index:       1200;
  display:       flex;
  align-items:   center;
  gap:           var(--dev-space-4);
  padding:       8px 10px 8px 16px;
  border:        1px solid var(--border);
  border-radius: var(--r-sm);
  background:    var(--body-bg);
  color:         var(--body-text);
  font-size:     14px;
  box-shadow:    0 8px 24px rgba(0, 0, 0, 0.25);
  transform:     translateX(-50%);

  &__undo, &__dismiss {
    min-height:    0;
    padding:       4px 8px;
    border:        0;
    border-radius: var(--r-sm);
    background:    none;
    line-height:   1.2;
    cursor:        pointer;
  }

  &__undo {
    color:       var(--dev-accent);
    font-weight: 600;

    &:hover { background: color-mix(in srgb, var(--dev-accent) 14%, transparent); }
  }

  &__dismiss {
    color: var(--muted);

    &:hover { color: var(--body-text); }
  }
}

.strata-toast-enter-active, .strata-toast-leave-active { transition: opacity 0.25s ease, transform 0.25s ease; }
.strata-toast-enter-from, .strata-toast-leave-to { opacity: 0; transform: translateX(-50%) translateY(16px); }
</style>
