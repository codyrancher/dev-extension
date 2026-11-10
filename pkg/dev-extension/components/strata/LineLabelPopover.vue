<script setup lang="ts">
/** "Label this line": at the pointer on a screen, a sheet along the bottom on a phone. */
import LabelSearchInput from './LabelSearchInput.vue';

const props = defineProps<{
  open: boolean;
  pos: { x: number; y: number } | null;
  isMobile: boolean;
  selectedIds: string[];
}>();

const emit = defineEmits<{ (e: 'toggle', labelId: string): void; (e: 'close'): void }>();

/** Kept inside the window: a right-click near the right or bottom edge would push it off. */
function place() {
  if (!props.pos) {
    return undefined;
  }
  const x = Math.max(8, Math.min(props.pos.x, window.innerWidth - 280));
  const y = Math.max(8, Math.min(props.pos.y, window.innerHeight - 120));

  return { top: `${ y }px`, left: `${ x }px` };
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="strata-line-veil"
      @click="emit('close')"
    />
    <div
      v-if="open && pos"
      class="strata-line-pop"
      :class="{ 'strata-line-pop--sheet': isMobile }"
      :style="isMobile ? undefined : place()"
      data-testid="strata-line-popover"
      @keydown.escape="emit('close')"
    >
      <div class="strata-line-pop__head">
        <span>Label this line</span>
        <button
          type="button"
          class="strata-line-pop__close"
          aria-label="Close"
          @click="emit('close')"
        >
          <i class="icon icon-close" />
        </button>
      </div>
      <LabelSearchInput
        :selected-ids="selectedIds"
        placeholder="Search or create label..."
        :direction="isMobile ? 'inline' : 'down'"
        autofocus
        @toggle="emit('toggle', $event)"
      />
    </div>
  </Teleport>
</template>

<style lang="scss" scoped>
.strata-line-veil {
  position: fixed;
  inset:    0;
  z-index:  1100;
}

.strata-line-pop {
  position:      fixed;
  z-index:       1101;
  width:         270px;
  padding:       var(--dev-space-4);
  border:        1px solid var(--border);
  border-radius: var(--r-sm);
  background:    var(--body-bg);
  color:         var(--body-text);
  box-shadow:    0 8px 24px rgba(0, 0, 0, 0.25);

  &--sheet {
    left:          0;
    right:         0;
    bottom:        0;
    width:         auto;
    padding:       var(--dev-space-5) var(--dev-space-5) calc(var(--dev-space-5) + env(safe-area-inset-bottom, 0px));
    border-radius: var(--r-sm) var(--r-sm) 0 0;
  }

  &__head {
    display:         flex;
    align-items:     center;
    justify-content: space-between;
    margin-bottom:   var(--dev-space-4);
    color:           var(--muted);
    font-size:       12px;
    font-weight:     600;
  }

  &__close {
    min-height:  0;
    padding:     2px;
    border:      0;
    background:  none;
    color:       var(--muted);
    line-height: 1;
    cursor:      pointer;

    &:hover { color: var(--body-text); }
  }
}
</style>
