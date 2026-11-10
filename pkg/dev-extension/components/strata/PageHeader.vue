<script setup lang="ts">
/** The top of a note or a label: what it is called, then pin and delete. */
defineProps<{ pinned: boolean; deleteTitle?: string }>();
const emit = defineEmits<{ (e: 'toggle-pin'): void; (e: 'delete'): void }>();
</script>

<template>
  <div class="strata-head">
    <slot name="leading" />
    <div class="strata-head__main">
      <slot />
    </div>
    <div class="strata-head__actions">
      <button
        type="button"
        class="strata-head__btn"
        :class="{ 'strata-head__btn--on': pinned }"
        :title="pinned ? 'Unpin' : 'Pin'"
        :aria-label="pinned ? 'Unpin' : 'Pin'"
        :aria-pressed="pinned"
        data-testid="strata-pin"
        @click="emit('toggle-pin')"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          :fill="pinned ? 'currentColor' : 'none'"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M12 17v5" /><path d="M9 2h6l-1 7h4l-2 4H8l-2-4h4L9 2z" />
        </svg>
      </button>
      <button
        type="button"
        class="strata-head__btn strata-head__btn--danger"
        :title="deleteTitle || 'Delete'"
        :aria-label="deleteTitle || 'Delete'"
        data-testid="strata-delete"
        @click="emit('delete')"
      >
        <i class="icon icon-delete" />
      </button>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.strata-head {
  display:     flex;
  align-items: center;
  gap:         var(--dev-space-4);
  flex-shrink: 0;

  &__main {
    display:     flex;
    flex:        1;
    align-items: center;
    min-width:   0;
  }

  &__actions {
    display:     flex;
    flex-shrink: 0;
    gap:         var(--dev-space-2);
  }

  &__btn {
    display:         inline-flex;
    align-items:     center;
    justify-content: center;
    width:           var(--dev-control);
    height:          var(--dev-control);
    min-height:      0;
    padding:         0;
    border:          1px solid transparent;
    border-radius:   var(--r-sm);
    background:      none;
    color:           var(--muted);
    font-size:       16px;
    line-height:     1;
    cursor:          pointer;

    &:hover { border-color: var(--border); color: var(--body-text); }
    &--on { color: var(--dev-accent); }
    &--danger:hover { color: var(--error); }
  }
}
</style>
