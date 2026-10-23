<script>
// The agents: definitions that start conversations by themselves (agent-defs.ts). The
// conversations themselves, live, are in the workspace they belong to and in the drawer; the
// page that listed them all is gone, and the shared GitHub browser it also opened is in
// Settings now.
import AgentCards from '../components/AgentCards.vue';

export default {
  name: 'Agents',

  components: { AgentCards },
};
</script>

<template>
  <div class="dev-agents-page">
    <AgentCards />
  </div>
</template>

<style lang="scss" scoped>
  .dev-agents-page {
    height:         100%;
    min-height:     0;
    overflow:       auto;
    padding-bottom: var(--dev-space-5);
  }
</style>
