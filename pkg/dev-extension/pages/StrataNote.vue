<script setup lang="ts">
/** One Strata note. The view is keyed by the id, so another note is a fresh editor. */
import { computed } from 'vue';
import { useHostRoute } from '../strata/router';
import NoteView from '../components/strata/NoteView.vue';
import { DEV_PRODUCT, BLANK_CLUSTER, STRATA_ROUTE } from '../config/constants';

const route = useHostRoute();
const noteId = computed(() => String(route.value.params.id || ''));
const listTo = { name: STRATA_ROUTE, params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER } };
</script>

<template>
  <div class="strata-detail">
    <router-link
      :to="listTo"
      class="strata-detail__back"
      data-testid="strata-back"
    >
      <i class="icon icon-chevron-left" /> Strata
    </router-link>
    <NoteView
      :key="noteId"
      :note-id="noteId"
    />
  </div>
</template>

<style lang="scss" scoped>
.strata-detail {
  display:        flex;
  flex-direction: column;
  gap:            var(--dev-space-4);
  height:         100%;
  min-height:     0;
  max-width:      1000px;
  padding:        var(--dev-inset);

  &__back {
    display:     inline-flex;
    flex-shrink: 0;
    align-items: center;
    gap:         var(--dev-space-2);
    align-self:  flex-start;
    font-size:   13px;
  }
}
</style>
