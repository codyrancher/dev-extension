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
import DevModal from '../DevModal.vue';
import Markdown from './Markdown.vue';

const props = withDefaults(defineProps<{
  title: string;
  /** The prose to draw. Optional, because a caller may put its own thing in the slot instead. */
  text?: string;
  at?: string;
  /**
   * Size to the content rather than to the reading height.
   *
   * The fixed height below is right for prose - a dialog that changes size with the length of
   * what is in it is a dialog that jumps - and wrong for a form, which has an end. The prompt
   * editor came out 760px tall around 500px of content, most of it empty.
   */
  fit?: boolean;
}>(), { text: '', at: '', fit: false });

const emit = defineEmits<{ (e: 'close'): void }>();

</script>

<template>
  <DevModal
    focus
    size="medium"
    :title="title"
    @close="emit('close')"
  >
    <template
      v-if="at"
      #head
    >
      <span class="said__at">{{ at }}</span>
    </template>
    <!--
      Prose by default, through the one component that draws prose, and whatever the caller
      gives instead: the prompt editor puts a form here.
    -->
    <div
      class="said"
      :class="{ 'said--fit': fit }"
    >
      <slot>
        <Markdown :text="props.text" />
      </slot>
    </div>
  </DevModal>
</template>

<style scoped>
.said__at { color: var(--text-faint); font-size: var(--t-xs); font-weight: 400; white-space: nowrap; }

/*
 * Prose is read at a fixed height, so a dialog does not change size with what is in it; a form
 * has an end, and takes its height from that.
 */
.said { min-height: min(560px, 70vh); }
.said--fit { min-height: 0; }

@media (max-width: 760px) {
  .said { min-height: 0; }
}
</style>
