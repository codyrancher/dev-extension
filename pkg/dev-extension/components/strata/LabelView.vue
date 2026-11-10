<script setup lang="ts">
/**
 * One label: Strata's LabelDetailView. Its name (saved on Enter or leaving the box), its colour,
 * the label it sits under, and everything filed under it. Mounted once per label, keyed by id.
 *
 * Deleting asks first, which Strata did not: it takes the label off every note and every line,
 * and there is no undo for that.
 */
import { ref, onMounted, computed, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useLabelsStore, loadStrata, strataProblem } from '../../strata/stores';
import LabelSearchInput from './LabelSearchInput.vue';
import ColorPicker from './ColorPicker.vue';
import ColorDot from './ColorDot.vue';
import PageHeader from './PageHeader.vue';
import LabelContentsTree from './LabelContentsTree.vue';
import DevDialog from '../DevDialog.vue';
import { DEV_PRODUCT, BLANK_CLUSTER, STRATA_ROUTE } from '../../config/constants';

const props = defineProps<{ labelId: string }>();
const router = useRouter();
const labelsStore = useLabelsStore();

const editName = ref('');
const loaded = ref(false);
const confirmDelete = ref(false);
const nameEl = ref<HTMLInputElement | null>(null);

const label = computed(() => labelsStore.getLabelById(props.labelId));
const parentLabelIds = computed(() => (label.value?.parent_id ? [label.value.parent_id] : []));

onMounted(async() => {
  await loadStrata(true);
  editName.value = label.value?.name || '';
  loaded.value = true;
});

// A rename from elsewhere shows here, unless this box is being typed in.
watch(() => label.value?.name, (name) => {
  if (name !== undefined && document.activeElement !== nameEl.value) {
    editName.value = name;
  }
});

async function saveName() {
  const name = editName.value.trim();

  if (!name) {
    editName.value = label.value?.name || '';

    return;
  }
  if (name !== label.value?.name) {
    await labelsStore.updateLabel(props.labelId, { name });
  }
}

async function setColor(color: string) {
  await labelsStore.updateLabel(props.labelId, { color });
}

async function toggleParentLabel(labelId: string) {
  if (labelId === props.labelId) {
    strataProblem.value = 'A label cannot sit under itself.';

    return;
  }
  await labelsStore.updateLabel(props.labelId, { parent_id: label.value?.parent_id === labelId ? null : labelId });
}

async function deleteLabel() {
  confirmDelete.value = false;
  router.push({ name: STRATA_ROUTE, params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER } });
  await labelsStore.deleteLabel(props.labelId);
}
</script>

<template>
  <p
    v-if="!loaded"
    class="text-muted"
  >
    Opening the label…
  </p>
  <p
    v-else-if="!label"
    class="text-muted"
    data-testid="strata-label-missing"
  >
    There is no such label. It may have been deleted.
  </p>
  <div
    v-else
    class="strata-label"
    data-testid="strata-label"
    :style="{ '--label': label.color }"
  >
    <PageHeader
      :pinned="!!label.pinned"
      delete-title="Delete label"
      @toggle-pin="labelsStore.togglePin(labelId)"
      @delete="confirmDelete = true"
    >
      <template #leading>
        <ColorDot
          :color="label.color"
          size="lg"
        />
      </template>
      <input
        ref="nameEl"
        v-model="editName"
        type="text"
        class="strata-label__name"
        aria-label="Label name"
        data-testid="strata-label-name"
        @blur="saveName"
        @keydown.enter="($event.target as HTMLInputElement).blur()"
      >
    </PageHeader>

    <p
      v-if="strataProblem"
      class="strata-label__problem"
      role="alert"
    >
      {{ strataProblem }}
    </p>

    <section class="strata-label__section">
      <h4>Colour</h4>
      <ColorPicker
        :model-value="label.color"
        @update:model-value="setColor"
      />
    </section>

    <section class="strata-label__section">
      <h4>Label this label</h4>
      <LabelSearchInput
        :selected-ids="parentLabelIds"
        placeholder="Add parent label..."
        @toggle="toggleParentLabel"
      />
    </section>

    <section class="strata-label__section">
      <h4>Contents</h4>
      <LabelContentsTree :label-id="labelId" />
    </section>

    <DevDialog
      v-if="confirmDelete"
      :title="`Delete ${ label.name }?`"
      message="It comes off every note and every line it is on. This cannot be undone."
      confirm-label="Delete"
      danger
      @confirm="deleteLabel"
      @cancel="confirmDelete = false"
    />
  </div>
</template>

<style lang="scss" scoped>
.strata-label {
  display:        flex;
  flex-direction: column;
  gap:            var(--dev-space-5);

  &__name {
    flex:          1;
    min-width:     0;
    height:        auto;
    padding:       2px 0;
    border:        0;
    border-bottom: 1px solid transparent;
    border-radius: 0;
    background:    none;
    box-shadow:    none;
    color:         color-mix(in srgb, var(--label) 70%, var(--body-text));
    font-size:     20px;
    font-weight:   600;
    line-height:   1.3;

    &:focus { border-bottom-color: var(--dev-accent); outline: none; }
  }

  &__problem {
    margin:        0;
    padding:       var(--dev-space-3) var(--dev-space-4);
    border-radius: var(--r-sm);
    background:    var(--error-banner-bg);
    color:         var(--error);
    font-size:     13px;
  }

  &__section h4 {
    margin:         0 0 var(--dev-space-4);
    color:          var(--muted);
    font-size:      11px;
    font-weight:    600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
}
</style>
