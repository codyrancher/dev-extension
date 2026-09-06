<script>
// Agents: every conversation this person's workspaces are holding, in one place.
//
// A workspace's Conversations tab shows that workspace's; My Work starts them; this is where
// they are all listed together - a review in one workspace, a fix in another, a discussion
// under a comment - with the Studio's pane onto whichever is selected. The same pod behind all
// of them (Extension Studio's agent), which is what makes one page of them possible: the list
// is the pod's, by workspace, and a pane is the Studio's terminal pointed at one id.
import { Banner } from '@components/Banner';
import DevList from '../components/DevList.vue';
import StudioTerminal from '../components/StudioTerminal.vue';
import ClaudeLogo from '../components/ClaudeLogo.vue';
import { listAllWorkspaces } from '../api';
import {
  listConversations, endConversation, renameConversation, paneCommand, waitForStudio
} from '../conversations';
import { DEV_PRODUCT, BLANK_CLUSTER, WORKSPACE_ROUTE } from '../config/constants';

const REFRESH_MS = 10000;

const ROW_STATE = {
  open: 'running', connecting: 'starting', waiting: 'starting', closed: 'stopped'
};

export default {
  name: 'DevAgents',

  components: {
    Banner, DevList, StudioTerminal, ClaudeLogo
  },

  async fetch() {
    await this.refresh();
    // Sent here to look at one conversation (an agent's run, say): pick it.
    const asked = this.$route.query.c;

    if (asked && this.all.some((c) => c.id === asked)) {
      this.select(asked);
    }
  },

  data() {
    return {
      groups:  [],
      current: '',
      states:  {},
      seen:    {},
      error:   '',
      timer:   null,
    };
  },

  computed: {
    all() {
      return this.groups.flatMap((group) => group.conversations.map((c) => ({ ...c, workspace: group.workspace })));
    },

    selected() {
      return this.all.find((c) => c.id === this.current) || null;
    },
  },

  mounted() {
    this.timer = setInterval(() => this.refresh(), REFRESH_MS);
  },

  beforeUnmount() {
    clearInterval(this.timer);
  },

  methods: {
    /** The argv of one conversation's pane: claude in its workspace's pod, reached through the agent pod. */
    paneFor(c) {
      return c.workspace ? paneCommand(c.workspace, c.id) : c.attach.command;
    },

    async refresh() {
      try {
        const workspaces = (await listAllWorkspaces()).filter((workspace) => !workspace.preview);
        const groups = await Promise.all(workspaces.map(async(workspace) => ({
          workspace:     workspace.name,
          conversations: await listConversations(workspace.name).catch(() => []),
        })));

        // The agents drawer's own conversations first: agent runs are those (agent-defs.ts),
        // and this is where a run's output is read.
        const api = await waitForStudio().catch(() => null);

        if (api) {
          const [sessions, pod] = await Promise.all([api.agent.sessions().catch(() => []), api.agent.pod().catch(() => null)]);

          groups.unshift({
            workspace:     '',
            conversations: sessions.map((session) => ({
              id: session.id, title: session.title, attach: {
                namespace: api.agent.namespace, pod: pod || '', container: api.agent.container, command: api.agent.command(session.id), workspace: '', id: session.id,
              },
            })),
          });
        }

        this.groups = groups.filter((group) => group.conversations.length);
        this.error = '';

        if (this.current && !this.all.some((c) => c.id === this.current)) {
          this.current = '';
        }
      } catch (e) {
        this.error = e.message || String(e);
      }
    },

    rows(group) {
      return group.conversations.map((c) => ({
        key:   c.id,
        label: c.title,
        state: ROW_STATE[this.states[c.id]] || 'stopped',
      }));
    },

    select(id) {
      this.current = id;
      this.seen = { ...this.seen, [id]: true };
    },

    workspaceTo(name) {
      return {
        name: WORKSPACE_ROUTE, params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER, workspace: name }, hash: '#conversations',
      };
    },

    onState(id, state) {
      this.states = { ...this.states, [id]: state };
    },

    async end(group, id) {
      try {
        if (group.workspace) {
          await endConversation(group.workspace, id);
        } else {
          await (await waitForStudio()).agent.end(id);
        }
        await this.refresh();
      } catch (e) {
        this.error = e.message || String(e);
      }
    },

    async rename(group, { key, title }) {
      try {
        if (group.workspace) {
          await renameConversation(group.workspace, key, title);
        } else {
          await (await waitForStudio()).agent.rename(key, title);
        }
        await this.refresh();
      } catch (e) {
        this.error = e.message || String(e);
      }
    },
  },
};
</script>

<template>
  <div class="dev-conversations">
    <!-- Every conversation in every workspace, live, with a pane onto the one picked. -->
    <section class="dev-live">
      <header class="dev-live__head">
        <ClaudeLogo class="dev-live__logo" />
        <h2 class="dev-live__title">
          Live conversations
        </h2>
        <span class="dev-live__sub text-muted">the agents drawer's and every workspace's, as they are now</span>
      </header>
      <div class="dev-agents">
        <div class="dev-agents__list">
          <p
            v-if="!groups.length"
            class="dev-agents__empty text-muted"
          >
            No conversations are open. Start one from a workspace's Conversations tab, from My Work, or from an agent above.
          </p>
          <template
            v-for="group in groups"
            :key="group.workspace || '@drawer'"
          >
            <router-link
              v-if="group.workspace"
              class="dev-agents__workspace"
              :to="workspaceTo(group.workspace)"
            >
              {{ group.workspace }}
            </router-link>
            <span
              v-else
              class="dev-agents__workspace dev-agents__workspace--drawer"
              title="The agents drawer's own conversations, the strip at the bottom of every page; agent runs are these"
            >agents</span>
            <DevList
              label=""
              :rows="rows(group)"
              :current="current"
              deletable
              renamable
              empty=""
              class="dev-agents__group"
              @select="select"
              @delete="end(group, $event)"
              @rename="rename(group, $event)"
            />
          </template>
        </div>
        <div class="dev-agents__pane">
          <Banner
            v-if="error"
            color="error"
            :label="error"
          />
          <p
            v-if="!selected"
            class="dev-agents__hint text-muted"
          >
            Pick a conversation on the left: the drawer's run in the agents pod, a workspace's in its own; this pane reaches either through the agents extension's terminal, chat view included.
          </p>
          <template
            v-for="c in all"
            :key="c.id"
          >
            <StudioTerminal
              v-if="seen[c.id]"
              v-show="c.id === current"
              :session="c.id"
              :command="paneFor(c)"
              class="dev-agents__terminal"
              @state="onState(c.id, $event)"
            />
          </template>
        </div>
      </div>
    </section>
  </div>
</template>

<style lang="scss" scoped>
  .dev-conversations {
    display:        flex;
    flex-direction: column;
    height:         100%;
    min-height:     0;
    padding:        var(--dev-space-4) 0 var(--dev-space-4);
  }

  .dev-live {
    display:        flex;
    flex-direction: column;
    margin:         0 var(--dev-space-5);
    border:         1px solid var(--border);
    border-radius:  var(--border-radius);
    background:     var(--body-bg);
    flex:           1 1 auto;
    min-height:     0;

    &__head {
      display:       flex;
      align-items:   baseline;
      gap:           var(--dev-space-3);
      padding:       var(--dev-space-3) var(--dev-space-4);
      border-bottom: 1px solid var(--border);
    }

    &__logo { color: var(--dev-accent); font-size: 16px; align-self: center; }
    &__title { margin: 0; font-size: 14px; font-weight: 600; }
    &__sub { font-size: 12px; }
  }

  .dev-agents {
    display:    flex;
    flex:       1 1 auto;
    min-height: 0;

    &__list {
      display:        flex;
      flex-direction: column;
      flex:           0 0 var(--dev-side-col);
      overflow-y:     auto;
      border-right:   1px solid var(--border);
    }

    &__empty, &__hint { padding: var(--dev-space-4); margin: 0; font-size: 13px; }

    &__workspace {
      display:     block;
      padding:     var(--dev-space-3) var(--dev-space-4) 0;
      font-family: monospace;
      font-size:   12px;
      color:       var(--muted);
    }

    &__group { flex: 0 0 auto; }

    &__pane {
      display:        flex;
      flex-direction: column;
      flex:           1 1 auto;
      min-width:      0;
    }

    &__terminal { flex: 1 1 auto; min-height: 0; }
  }
</style>
