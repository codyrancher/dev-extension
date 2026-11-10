<script>
// Automations: what happened, and what runs when it does.
//
// The frame every page here has (DevPage) and the tabs My Work and a workspace have (Rancher's
// Tabbed, which keeps the tab in the address - `#events`, `#automations`). Events is the log dev-api
// keeps - workspace stages moving, and what happens on the GitHub issues and pull requests you are
// part of - with what each did to every automation that listens to it. Automations is the
// definitions (agent-defs.ts): an agent, a script or a review, what sets it off, and its runs.
import Tabbed from '@shell/components/Tabbed';
import Tab from '@shell/components/Tabbed/Tab';
import { RcButton } from '@components/RcButton';
import DevPage from '../components/DevPage.vue';
import EventsTab from '../components/automations/EventsTab.vue';
import AutomationsTab from '../components/automations/AutomationsTab.vue';
import { pollNow } from '../automations';
import {
  DEV_PRODUCT, BLANK_CLUSTER, AGENT_EDIT_ROUTE
} from '../config/constants';

const TABS = ['events', 'automations'];

export default {
  name: 'Automations',

  components: {
    Tabbed, Tab, RcButton, DevPage, EventsTab, AutomationsTab
  },

  data() {
    const asked = String(this.$route?.hash || '').replace(/^#/, '');

    return {
      tab:     TABS.includes(asked) ? asked : 'events',
      reading: false,
    };
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

    async readNow() {
      this.reading = true;
      try {
        await pollNow();
      } catch {
        // The log says how the read went, in its GitHub line.
      } finally {
        this.reading = false;
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
        v-if="tab === 'events'"
        variant="tertiary"
        size="small"
        :left-icon="reading ? 'spinner' : 'refresh'"
        :disabled="reading"
        data-testid="automation-poll"
        @click="readNow"
      >
        {{ reading ? 'Reading GitHub' : 'Read GitHub now' }}
      </RcButton>
      <RcButton
        v-else
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
        name="events"
        label="Events"
        :weight="2"
      >
        <EventsTab />
      </Tab>
      <Tab
        name="automations"
        label="Automations"
        :weight="1"
      >
        <AutomationsTab />
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
}
</style>
