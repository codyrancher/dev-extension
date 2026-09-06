<script>
// A small dialog of this product's own: a question, an optional answer box, two buttons.
//
// The browser's prompt() and confirm() ask the same things in the browser's chrome, which
// looks like nothing else on the page and cannot be styled. This is teleported over the
// page, answers Enter and Escape, and puts the caret in the box when there is one.
export default {
  name: 'DevDialog',

  props: {
    title:        { type: String, required: true },
    message:      { type: String, default: '' },
    /** Ask for text: the box, its placeholder and its starting value. */
    input:        { type: Boolean, default: false },
    placeholder:  { type: String, default: '' },
    value:        { type: String, default: '' },
    confirmLabel: { type: String, default: 'OK' },
    cancelLabel:  { type: String, default: 'Cancel' },
    /** A destructive confirmation: the confirm button is red. */
    danger:       { type: Boolean, default: false },
  },

  emits: ['confirm', 'cancel'],

  data() {
    return { text: this.value };
  },

  mounted() {
    this.onKey = (event) => {
      if (event.key === 'Escape') {
        this.$emit('cancel');
      }
    };
    window.addEventListener('keydown', this.onKey);
    this.$nextTick(() => (this.$refs.box || this.$refs.ok)?.focus());
  },

  beforeUnmount() {
    window.removeEventListener('keydown', this.onKey);
  },

  methods: {
    confirm() {
      if (this.input && !this.text.trim()) {
        this.$refs.box?.focus();

        return;
      }
      this.$emit('confirm', this.text.trim());
    },
  },
};
</script>

<template>
  <Teleport to="body">
    <div
      class="dev-dialog"
      role="dialog"
      aria-modal="true"
      @click.self="$emit('cancel')"
    >
      <div class="dev-dialog__panel">
        <h3 class="dev-dialog__title">
          {{ title }}
        </h3>
        <p
          v-if="message"
          class="dev-dialog__message"
        >
          {{ message }}
        </p>
        <input
          v-if="input"
          ref="box"
          v-model="text"
          type="text"
          class="dev-dialog__input"
          :placeholder="placeholder"
          @keydown.enter.prevent="confirm"
        >
        <div class="dev-dialog__actions">
          <button
            type="button"
            class="dev-dialog__btn"
            @click="$emit('cancel')"
          >
            {{ cancelLabel }}
          </button>
          <button
            ref="ok"
            type="button"
            class="dev-dialog__btn dev-dialog__btn--primary"
            :class="{ 'dev-dialog__btn--danger': danger }"
            @click="confirm"
          >
            {{ confirmLabel }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style lang="scss" scoped>
.dev-dialog {
  position:        fixed;
  inset:           0;
  z-index:         3000;
  display:         flex;
  align-items:     center;
  justify-content: center;
  background:      rgba(0, 0, 0, 0.55);
  padding:         24px;

  &__panel {
    width:          min(480px, 94vw);
    display:        flex;
    flex-direction: column;
    gap:            var(--dev-space-3);
    padding:        var(--dev-space-5);
    background:     var(--body-bg);
    color:          var(--body-text);
    border:         1px solid var(--border);
    border-radius:  10px;
    box-shadow:     0 12px 40px rgba(0, 0, 0, 0.4);
  }

  &__title { margin: 0; font-size: 15px; font-weight: 600; }
  &__message { margin: 0; font-size: 13px; color: var(--muted); line-height: 1.5; }

  &__input {
    width:         100%;
    height:        36px;
    padding:       0 10px;
    font-size:     13px;
    font-family:   monospace;
    background:    var(--body-bg);
    color:         var(--body-text);
    border:        1px solid var(--border);
    border-radius: 6px;

    &:focus { outline: none; border-color: var(--dev-accent); }
  }

  &__actions { display: flex; justify-content: flex-end; gap: var(--dev-space-2); margin-top: var(--dev-space-2); }

  &__btn {
    min-height:    0;
    height:        32px;
    padding:       0 14px;
    font-size:     13px;
    border-radius: 6px;
    border:        1px solid var(--border);
    background:    transparent;
    color:         var(--body-text);
    cursor:        pointer;

    &:hover { border-color: var(--dev-accent); color: var(--dev-accent); }

    &--primary {
      background:   var(--dev-accent);
      border-color: var(--dev-accent);
      color:        var(--dev-on-accent, var(--body-bg));

      &:hover { color: var(--dev-on-accent, var(--body-bg)); filter: brightness(1.08); }
    }

    &--danger { background: var(--error); border-color: var(--error); color: #fff; &:hover { color: #fff; } }
  }
}
</style>
