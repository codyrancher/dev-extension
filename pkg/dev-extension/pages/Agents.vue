<script>
// The agents: definitions that start conversations by themselves (agent-defs.ts). The
// conversations themselves, live, are the Conversations page.
//
// The shared GitHub browser lives here too. It is one Chromium every agent uses for anything on
// github.com - a person signs it into GitHub once, and from then on agents upload PR media through
// it (GITHUB_BROWSER_CDP). It opens in a new tab rather than an embedded frame: the KasmVNC
// desktop is heavy to run inside the dashboard, and a real tab is where signing into GitHub
// actually works.
import { RcButton } from '@components/RcButton';
import AgentCards from '../components/AgentCards.vue';
import { globalBrowserUrl } from '../api';

export default {
  name: 'Agents',

  components: { AgentCards, RcButton },

  computed: {
    browserUrl() {
      return globalBrowserUrl();
    },
  },

  methods: {
    openBrowser() {
      window.open(this.browserUrl, '_blank', 'noopener');
    },
  },
};
</script>

<template>
  <div class="dev-agents-page">
    <section class="dev-agents-page__browser">
      <div class="dev-agents-page__browser-text">
        <h2 class="dev-agents-page__browser-title">GitHub browser</h2>
        <p class="dev-agents-page__browser-sub">
          One shared browser every agent uses for GitHub. Sign it into github.com once and it stays
          signed in, so agents can upload pull-request media through it.
        </p>
      </div>
      <RcButton
        variant="secondary"
        @click="openBrowser"
      >
        Open GitHub browser
      </RcButton>
    </section>

    <AgentCards />
  </div>
</template>

<style lang="scss" scoped>
  .dev-agents-page {
    height:         100%;
    min-height:     0;
    overflow:       auto;
    padding-bottom: var(--dev-space-5);

    &__browser {
      display:         flex;
      align-items:     flex-start;
      justify-content: space-between;
      gap:             16px;
      margin-bottom:   var(--dev-space-5, 20px);
      padding:         12px 16px;
      border:          1px solid var(--border);
      border-radius:   var(--border-radius, 4px);
      background:      var(--body-bg);
    }

    &__browser-text {
      min-width: 0;
    }

    &__browser-title {
      margin: 0;
    }

    &__browser-sub {
      margin:    4px 0 0;
      max-width: 60ch;
      color:     var(--muted);
      font-size: 13px;
    }
  }
</style>
