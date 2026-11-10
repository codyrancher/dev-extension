<script setup lang="ts">
/** On a phone, a picture is chosen from the library or taken now: forcing the camera is Android's default otherwise. */
import DevModal from '../DevModal.vue';
import { S } from '../../strata/editor/icons';

const emit = defineEmits<{ (e: 'close'): void; (e: 'pick', capture?: 'environment'): void }>();

const gallerySvg = S('<rect x=\'3\' y=\'3\' width=\'18\' height=\'18\' rx=\'2\' ry=\'2\'/><circle cx=\'8.5\' cy=\'8.5\' r=\'1.5\'/><polyline points=\'21 15 16 10 5 21\'/>');
const cameraSvg = S('<path d=\'M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z\'/><circle cx=\'12\' cy=\'13\' r=\'4\'/>');
</script>

<template>
  <DevModal
    title="Add a picture"
    @close="emit('close')"
  >
    <div class="strata-pick">
      <button
        type="button"
        class="strata-pick__btn"
        data-testid="strata-pick-library"
        @click="emit('pick')"
      >
        <span v-html="gallerySvg" />
        Choose photo
      </button>
      <button
        type="button"
        class="strata-pick__btn"
        data-testid="strata-pick-camera"
        @click="emit('pick', 'environment')"
      >
        <span v-html="cameraSvg" />
        Take photo
      </button>
    </div>
  </DevModal>
</template>

<style lang="scss" scoped>
.strata-pick {
  display:        flex;
  flex-direction: column;
  gap:            var(--dev-space-2);

  &__btn {
    display:       flex;
    align-items:   center;
    gap:           var(--dev-space-4);
    min-height:    0;
    padding:       12px;
    border:        0;
    border-radius: var(--r-sm);
    background:    none;
    color:         var(--body-text);
    font-size:     14px;
    line-height:   1.3;
    text-align:    left;
    cursor:        pointer;

    &:hover { background: var(--dropdown-hover-bg); }
  }
}
</style>
