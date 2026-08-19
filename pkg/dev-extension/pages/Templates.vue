<script>
// The templates a workspace can be made from.
//
// A read-only page, because a template is code here rather than data in the cluster (see
// templates.ts for why). It exists so the choice on the create form is explainable without
// reading the source, and so the create form's dropdown can stay a dropdown.
import SortableTable from '@shell/components/SortableTable';
import { RcButton } from '@components/RcButton';
import { TEMPLATES } from '../templates';
import { DEV_PRODUCT, BLANK_CLUSTER, CREATE_ROUTE } from '../config/constants';

export default {
  name: 'DevTemplates',

  components: { SortableTable, RcButton },

  data() {
    return {
      rows:    TEMPLATES,
      headers: [
        {
          name: 'label', label: 'Template', value: 'label', sort: ['label']
        },
        {
          name: 'image', label: 'Image', value: 'image', sort: ['image']
        },
        {
          name: 'port', label: 'Port', value: 'port', sort: ['port'], width: 80
        },
        // What the workspace's Conversations tab will actually be. Every template says
        // 'shell' today, and the column exists so that is visible when choosing rather than
        // when opening the tab.
        {
          name:  'conversations',
          label: 'Conversations',
          value: 'conversations',
          sort:  ['conversations'],
          width: 130
        },
        {
          name: 'description', label: 'Description', value: 'description'
        },
        {
          name: 'actions', label: '', align: 'right', width: 120
        },
      ],
    };
  },

  methods: {
    // The create form reads this back out of the query, so picking a template here lands on a
    // form that is already filled in rather than one that has to be filled in again.
    createTo(template) {
      return {
        name:   CREATE_ROUTE,
        params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER },
        query:  { template: template.id },
      };
    },
  },
};
</script>

<template>
  <div class="dev-templates">
    <header>
      <h1>Templates</h1>
      <p class="subheader">
        What a workspace's pod runs. The harness clones a repo and installs; here the same
        decision is which container image a workspace gets.
      </p>
    </header>

    <SortableTable
      :headers="headers"
      :rows="rows"
      key-field="id"
      default-sort-by="label"
      :table-actions="false"
      :row-actions="false"
      :search="false"
      :paging="false"
    >
      <template #cell:conversations="{ row }">
        <span :class="row.conversations === 'claude' ? '' : 'text-muted'">
          {{ row.conversations === 'claude' ? 'Claude' : 'Shell only' }}
        </span>
      </template>

      <template #cell:actions="{ row }">
        <RcButton
          variant="tertiary"
          size="small"
          left-icon="plus"
          :to="createTo(row)"
        >
          Create
        </RcButton>
      </template>
    </SortableTable>
  </div>
</template>

<style lang="scss" scoped>
  .dev-templates {
    header {
      display:       block;
      margin-bottom: var(--dev-space-5);

      h1 {
        margin-bottom: 0;
      }

      .subheader {
        max-width: 80ch;
        margin:    var(--dev-space-2) 0 0 0;
        color:     var(--muted);
      }
    }
  }
</style>
