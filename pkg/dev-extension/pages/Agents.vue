<script>
// Automations: what happened, and what runs when it does.
//
// Two tabs. Events is the log dev-api keeps - workspace stages moving, and what happens on the
// GitHub issues and pull requests assigned to you - with what each event did to every automation
// that listens to it. Automations is the definitions (agent-defs.ts): an agent or a script, what
// sets it off, and its runs. The tab is the hash, so each can be linked to and a reload stays put.
import AgentCards from '../components/AgentCards.vue';
import EventsTab from '../components/automations/EventsTab.vue';

const TABS = [
  { id: 'events', label: 'Events' },
  { id: 'automations', label: 'Automations' },
];

export default {
  name: 'Automations',

  components: { AgentCards, EventsTab },

  data() {
    return { TABS };
  },

  computed: {
    tab() {
      const wanted = (this.$route.hash || '').replace('#', '');

      return TABS.some((t) => t.id === wanted) ? wanted : 'events';
    },
  },

  methods: {
    show(id) {
      if (id !== this.tab) {
        this.$router.replace({ ...this.$route, hash: `#${ id }` });
      }
    },

    onKey(event) {
      const at = TABS.findIndex((t) => t.id === this.tab);
      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;

      if (step) {
        event.preventDefault();
        this.show(TABS[(at + step + TABS.length) % TABS.length].id);
      }
    },
  },
};
</script>

<template>
  <div class="dev-automations-page">
    <header class="automations__head">
      <h1 class="automations__title">
        Automations
      </h1>
      <div
        class="automations__tabs"
        role="tablist"
        @keydown="onKey"
      >
        <button
          v-for="t in TABS"
          :id="`automations-tab-${ t.id }`"
          :key="t.id"
          type="button"
          role="tab"
          class="automations__tab"
          :class="{ 'automations__tab--on': t.id === tab }"
          :aria-selected="t.id === tab ? 'true' : 'false'"
          :tabindex="t.id === tab ? 0 : -1"
          :data-testid="`automations-tab-${ t.id }`"
          @click="show(t.id)"
        >
          {{ t.label }}
        </button>
      </div>
    </header>

    <div
      class="automations__pane"
      role="tabpanel"
      :aria-labelledby="`automations-tab-${ tab }`"
    >
      <EventsTab v-if="tab === 'events'" />
      <AgentCards v-else />
    </div>
  </div>
</template>

<style lang="scss" scoped>
  .dev-automations-page {
    display:        flex;
    flex-direction: column;
    height:         100%;
    min-height:     0;
  }

  .automations {
    &__head {
      display:     flex;
      align-items: flex-end;
      gap:         var(--dev-space-5);
      padding:     var(--dev-space-4) var(--dev-inset) 0;
      border-bottom: 1px solid var(--border);
      flex:        0 0 auto;
    }

    &__title { margin: 0 0 10px; font-size: 20px; font-weight: 600; }

    &__tabs { display: flex; gap: var(--dev-space-1); }

    &__tab {
      min-height:    0;
      padding:       8px 14px;
      margin-bottom: -1px;
      border:        0;
      border-bottom: 2px solid transparent;
      background:    none;
      color:         var(--muted);
      font-size:     13px;
      font-weight:   600;
      cursor:        pointer;

      &:hover { color: var(--body-text); }
      &:focus-visible { outline: 2px solid var(--dev-accent); outline-offset: -2px; }

      &--on { color: var(--body-text); border-bottom-color: var(--dev-accent); }
    }

    &__pane {
      flex:           1 1 auto;
      min-height:     0;
      overflow:       auto;
      padding-bottom: var(--dev-space-5);
    }
  }

  @media (max-width: 760px) {
    .automations__head { gap: var(--dev-space-3); flex-wrap: wrap; }
  }
</style>
