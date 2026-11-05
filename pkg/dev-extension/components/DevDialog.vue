<script>
// A small dialog of this product's own: a question, an optional answer box, two buttons.
//
// The browser's prompt() and confirm() ask the same things in the browser's chrome, which
// looks like nothing else on the page and cannot be styled. This is a DevModal - the one
// dialog - with the question in it: Escape, the veil, focus and the phone's full screen are
// that component's. What is here is the question, the box, and Enter.
import DevModal from './DevModal.vue';

export default {
  name: 'DevDialog',

  components: { DevModal },

  props: {
    title:        { type: String, required: true },
    message:      { type: String, default: '' },
    /** Ask for text: the box, its placeholder and its starting value. */
    input:        { type: Boolean, default: false },
    /**
     * Whether the box may be left empty.
     *
     * Off by default, because the first thing a box is usually for is a name, and confirming a
     * rename with nothing in it is a mistake rather than a choice. On, an empty box is an
     * answer: the review's own body is the case - most reviews say nothing above their line
     * comments, and refusing to submit until something is typed turns an optional sentence
     * into a required one. Without this the confirm silently refocused the box and the dialog
     * could not be got past at all.
     */
    optional:     { type: Boolean, default: false },
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
    this.$nextTick(() => (this.$refs.box || this.$refs.ok)?.focus());
  },

  methods: {
    confirm() {
      if (this.input && !this.optional && !this.text.trim()) {
        this.$refs.box?.focus();

        return;
      }
      this.$emit('confirm', this.text.trim());
    },
  },
};
</script>

<template>
  <DevModal
    :title="title"
    @close="$emit('cancel')"
  >
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
    <template #footer>
      <button
        ref="ok"
        type="button"
        class="dev-dialog__btn dev-dialog__btn--primary"
        :class="{ 'dev-dialog__btn--danger': danger }"
        @click="confirm"
      >
        {{ confirmLabel }}
      </button>
      <button
        type="button"
        class="dev-dialog__btn"
        @click="$emit('cancel')"
      >
        {{ cancelLabel }}
      </button>
    </template>
  </DevModal>
</template>

<style lang="scss" scoped>
.dev-dialog {
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
    border-radius: var(--r-sm);

    &:focus { outline: none; border-color: var(--dev-accent); }
  }

  &__btn {
    min-height:    0;
    height:        32px;
    padding:       0 14px;
    font-size:     13px;
    border-radius: var(--r-sm);
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
