<script>
// The confirmation in front of deleting a workspace.
//
// Its own component because both the list and the detail page delete, and a second copy of a
// modal is how the two would come to say different things about what deleting means. It owns
// the call as well as the markup, so the pages only have to say which workspace and what to do
// afterwards.
import AppModal from '@shell/components/AppModal';
import AsyncButton from '@shell/components/AsyncButton';
import { Card } from '@components/Card';
import { RcButton } from '@components/RcButton';
import { deleteWorkspace } from '../api';

export default {
  name: 'ConfirmDeleteWorkspace',

  components: {
    AppModal, AsyncButton, Card, RcButton
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
        await deleteWorkspace(this.workspace.name);
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
  <AppModal
    name="dev-delete-workspace"
    :width="480"
    @close="$emit('close')"
  >
    <Card :show-highlight-border="false">
      <template #title>
        <h4 class="text-default-text">
          Delete {{ workspace.name }}?
        </h4>
      </template>
      <template #body>
        <p>
          This deletes the namespace <b>{{ workspace.namespace }}</b> and everything in it. It
          cannot be undone.
        </p>
      </template>
      <template #actions>
        <div class="dev-confirm__actions">
          <RcButton
            variant="secondary"
            @click="$emit('close')"
          >
            Cancel
          </RcButton>
          <AsyncButton
            mode="delete"
            class="btn bg-error"
            @click="remove"
          />
        </div>
      </template>
    </Card>
  </AppModal>
</template>

<style lang="scss" scoped>
  .dev-confirm__actions {
    display:         flex;
    gap:             var(--dev-space-4);
    justify-content: flex-end;
    width:           100%;
  }
</style>
