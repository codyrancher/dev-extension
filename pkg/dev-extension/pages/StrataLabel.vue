<script setup lang="ts">
/** One Strata label. The view is keyed by the id, so moving down the tree to another label starts fresh. */
import { computed } from 'vue';
import { useHostRoute } from '../strata/router';
import LabelView from '../components/strata/LabelView.vue';
import { DEV_PRODUCT, BLANK_CLUSTER, STRATA_ROUTE } from '../config/constants';

const route = useHostRoute();
const labelId = computed(() => String(route.value.params.id || ''));
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
    <LabelView
      :key="labelId"
      :label-id="labelId"
    />
  </div>
</template>

<style lang="scss" scoped>
.strata-detail {
  display:        flex;
  flex-direction: column;
  gap:            var(--dev-space-4);
  max-width:      1000px;
  min-height:     0;
  padding:        var(--dev-inset);
  overflow-y:     auto;
  height:         100%;

  &__back {
    display:     inline-flex;
    align-items: center;
    gap:         var(--dev-space-2);
    align-self:  flex-start;
    font-size:   13px;
  }
}
</style>
