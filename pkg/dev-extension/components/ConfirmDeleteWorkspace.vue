<script>
// The confirmation in front of deleting a workspace.
//
// Its own component because both the list and the detail page delete, and a second copy of a
// modal is how the two would come to say different things about what deleting means. It owns
// the call as well as the markup, so the pages only have to say which workspace and what to do
// afterwards.
import AsyncButton from '@shell/components/AsyncButton';
import { RcButton } from '@components/RcButton';
import DevModal from './DevModal.vue';
import { deleteWorkspace } from '../api';

export default {
  name: 'ConfirmDeleteWorkspace',

  components: {
    AsyncButton, DevModal, RcButton
  },

  props: {
    workspace: {
      type:     Object,
      required: true,
    },
  },

  emits: ['close', 'deleted', 'error'],

  methods: {
    async remove(done) {
      try {
        await deleteWorkspace(this.$store, this.workspace.name);
        // The button is told before anything closes the modal, because closing it unmounts
        // the button and `done` would then be reporting to something no longer there.
        done(true);
        this.$emit('deleted');
      } catch (e) {
        done(false);
        this.$emit('error', e.message || String(e));
      }
    },
  },
};
</script>

<template>
  <DevModal
    :title="`Delete ${ workspace.name }?`"
    @close="$emit('close')"
  >
    <p class="dev-confirm__text">
      This removes the Apps Plus installation <b>{{ workspace.name }}</b>, and with it the
      namespace <b>{{ workspace.namespace }}</b> and everything in it. It cannot be undone.
    </p>
    <template #footer>
      <AsyncButton
        mode="delete"
        class="btn bg-error"
        @click="remove"
      />
      <RcButton
        variant="secondary"
        @click="$emit('close')"
      >
        Cancel
      </RcButton>
    </template>
  </DevModal>
</template>

<style lang="scss" scoped>
  .dev-confirm__text { margin: 0; line-height: 1.5; }
</style>
