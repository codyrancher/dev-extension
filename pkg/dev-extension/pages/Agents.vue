<script>
// Automations: what happened, and what runs when it does.
//
// The frame every page here has (DevPage) and the tabs My Work and a workspace have (Rancher's
// Tabbed, which keeps the tab in the address - `#automations`, `#events`, `#sources`). Events is the log dev-api
// keeps - workspace stages moving, and what happens on the GitHub issues and pull requests you are
// part of - with what each did to every automation that listens to it. Automations is the
// definitions (agent-defs.ts): an agent, a script or a review, what sets it off, and its runs.
import Tabbed from '@shell/components/Tabbed';
import Tab from '@shell/components/Tabbed/Tab';
import { RcButton } from '@components/RcButton';
import DevPage from '../components/DevPage.vue';
import EventsTab from '../components/automations/EventsTab.vue';
import AutomationsTab from '../components/automations/AutomationsTab.vue';
import SourcesTab from '../components/automations/SourcesTab.vue';
import {
  DEV_PRODUCT, BLANK_CLUSTER, AGENT_EDIT_ROUTE
} from '../config/constants';

const TABS = ['automations', 'events', 'sources'];

export default {
  name: 'Automations',

  components: {
    Tabbed, Tab, RcButton, DevPage, EventsTab, AutomationsTab, SourcesTab
  },

  data() {
    const asked = String(this.$route?.hash || '').replace(/^#/, '');

    return { tab: TABS.includes(asked) ? asked : 'automations' };
  },

  computed: {
    newTo() {
      return { name: AGENT_EDIT_ROUTE, params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER } };
    },
  },

  methods: {
    onTab(tab) {
      const name = tab?.selectedName || tab;

      if (TABS.includes(name)) {
        this.tab = name;
      }
    },
  },
};
</script>

<template>
  <DevPage
    title="Automations"
    lede="What happened on your work, and what runs when it does."
    class="dev-automations"
  >
    <template #actions>
      <RcButton
        v-if="tab === 'automations'"
        variant="primary"
        size="small"
        data-testid="agents-new"
        @click="$router.push(newTo)"
      >
        New automation
      </RcButton>
    </template>

    <Tabbed
      :default-tab="tab"
      class="dev-automations__tabs"
      @changed="onTab"
    >
      <Tab
        name="automations"
        label="Automations"
        :weight="3"
      >
        <AutomationsTab />
      </Tab>
      <Tab
        name="events"
        label="Events"
        :weight="2"
      >
        <EventsTab />
      </Tab>
      <Tab
        name="sources"
        label="Sources"
        :weight="1"
      >
        <SourcesTab />
      </Tab>
    </Tabbed>
  </DevPage>
</template>

<style lang="scss" scoped>
.dev-automations {
  height:     100%;
  min-height: 0;
}

@media (max-width: 760px) {
  /* The same narrowing My Work gives its tables: the 640px floor mobile.css puts under every
     table is the only reason these would scroll sideways, and their columns already drop. */
  .dev-automations :deep(table.sortable-table) { min-width: 0; }

  .dev-automations :deep(table.sortable-table td) {
    overflow-wrap: anywhere;
    white-space:   normal;
  }

  .dev-automations :deep(.sortable-table-header) { flex-wrap: wrap; }

  /* The second cell is the event's name or the automation's: it says what it is by being it, as
     the first does, so it goes unlabelled beside it rather than under the word EVENT or NAME. */
  .dev-automations :deep(table.sortable-table tbody td:nth-child(2))::before { content: none !important; }

  /* Pickers and toggles share lines on a phone instead of taking one each. */
  .dev-automations :deep(.sortable-table-header .bulk),
  .dev-automations :deep(.sortable-table-header .search) { flex: 1 1 100%; min-width: 0; }

  /* The table's own filter box keeps a desktop width and ran off the card's edge. */
  .dev-automations :deep(.sortable-table-header .search input) { width: 100%; min-width: 0; }
}
</style>
