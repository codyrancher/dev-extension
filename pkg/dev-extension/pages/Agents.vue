<script>
// The agents: definitions that start conversations by themselves (agent-defs.ts). The
// conversations themselves, live, are the Conversations page.
//
// The shared GitHub browser lives here too. It is one Chromium every agent uses for anything on
// github.com - a person signs it into GitHub once from this panel, and from then on agents upload
// PR media through it (GITHUB_BROWSER_CDP). It is framed the same way a workspace's own browser is,
// through the apiserver's service proxy, and loaded only when opened because the KasmVNC desktop
// is not free to run.
import { RcButton } from '@components/RcButton';
import AgentCards from '../components/AgentCards.vue';
import { globalBrowserUrl } from '../api';

export default {
  name: 'Agents',

  components: { AgentCards, RcButton },

  data() {
    return { browserOpen: false };
  },

  computed: {
    browserUrl() {
      return globalBrowserUrl();
    },
  },
};
</script>

<template>
  <div class="dev-agents-page">
    <section class="dev-agents-page__browser">
      <header class="dev-agents-page__browser-head">
        <div class="dev-agents-page__browser-text">
          <h2 class="dev-agents-page__browser-title">GitHub browser</h2>
          <p class="dev-agents-page__browser-sub">
            One shared browser every agent uses for GitHub. Sign it into github.com once here and
            it stays signed in, so agents can upload pull-request media through it.
          </p>
        </div>
        <div class="dev-agents-page__browser-actions">
          <RcButton
            variant="secondary"
            @click="browserOpen = !browserOpen"
          >
            {{ browserOpen ? 'Hide browser' : 'Open browser' }}
          </RcButton>
          <a
            :href="browserUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="dev-agents-page__browser-link"
          >Open in a new tab</a>
        </div>
      </header>
      <iframe
        v-if="browserOpen"
        :src="browserUrl"
        class="dev-agents-page__browser-frame"
        title="Shared GitHub browser"
      />
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
      margin-bottom: var(--dev-space-5, 20px);
      border:        1px solid var(--border);
      border-radius: var(--border-radius, 4px);
      background:    var(--body-bg);
    }

    &__browser-head {
      display:         flex;
      align-items:     flex-start;
      justify-content: space-between;
      gap:             16px;
      padding:         12px 16px;
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

    &__browser-actions {
      display:     flex;
      align-items: center;
      gap:         12px;
      flex:        0 0 auto;
    }

    &__browser-link {
      font-size: 13px;
      white-space: nowrap;
    }

    // Tall enough to sign in and see the page; the KasmVNC desktop fills it.
    &__browser-frame {
      display: block;
      width:   100%;
      height:  600px;
      border:  0;
      border-top: 1px solid var(--border);
    }
  }
</style>
