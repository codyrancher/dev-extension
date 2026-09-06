<script>
// The agents: definitions that start conversations by themselves (agent-defs.ts). The
// conversations themselves, live, are the Conversations page.
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
