<script>
// A view opened over the page rather than instead of it: the rail keeps the conversation and
// the evidence where they are, and the Review, PR, Browser and Share views come up in front of
// them, sized to the window, closed by the button or Esc.
export default {
  name: 'DevModal',

  props: {
    title: {
      type:    String,
      default: '',
    },
  },

  emits: ['close'],

  mounted() {
    this.onKey = (e) => e.key === 'Escape' && this.$emit('close');
    window.addEventListener('keydown', this.onKey);
  },

  beforeUnmount() {
    window.removeEventListener('keydown', this.onKey);
  },
};
</script>

<template>
  <Teleport to="body">
    <div
      class="dev-modal"
      role="dialog"
      :aria-label="title"
      @click.self="$emit('close')"
    >
      <div class="dev-modal__panel">
        <div class="dev-modal__head">
          <span class="dev-modal__title">{{ title }}</span>
          <button
            type="button"
            class="btn role-tertiary btn-sm"
            aria-label="Close"
            @click="$emit('close')"
          >
            <i class="icon icon-close" />
          </button>
        </div>
        <div class="dev-modal__body">
          <slot />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style lang="scss" scoped>
.dev-modal {
  position:        fixed;
  inset:           0;
  z-index:         1200;
  display:         flex;
  align-items:     center;
  justify-content: center;
  background:      rgba(0, 0, 0, .55);

  &__panel {
    display:        flex;
    flex-direction: column;
    width:          min(94vw, 1500px);
    height:         92vh;
    background:     var(--body-bg);
    border:         1px solid var(--border);
    border-radius:  var(--border-radius);
    box-shadow:     0 10px 40px rgba(0, 0, 0, .4);
    overflow:       hidden;
  }

  &__head {
    display:         flex;
    align-items:     center;
    justify-content: space-between;
    padding:         8px 8px 8px 16px;
    border-bottom:   1px solid var(--border);
  }

  &__title { font-weight: 700; }

  &__body {
    flex:       1 1 auto;
    min-height: 0;
    display:    flex;
    flex-direction: column;
    overflow:   auto;

    > * { flex: 1 1 auto; min-height: 0; }
  }
}
</style>
