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
      /**
       * Whether the list of conversations is showing.
       *
       * It was a column that was always there, so the pane - a terminal, or a chat - never had
       * the page, and on a phone the list and its workspace headings pushed the conversation
       * off the bottom entirely. A conversation is a thing you read; the list is a thing you
       * use once to choose which one. That is a menu, not furniture. Closed by default, and
       * closed again by picking something.
       */
      listOpen: false,
    };
  },

  computed: {
    all() {
      return this.groups.flatMap((group) => group.conversations.map((c) => ({ ...c, workspace: group.workspace })));
    },

    selected() {
      return this.all.find((c) => c.id === this.current) || null;
    },

    /** How many there are, for the button that opens the list. */
    total() {
      return this.all.length;
    },
  },

  watch: {
    // Written on every change rather than only on a pick: `fetch` and the refresh below can
    // both change which conversation is current, and a URL that is right only when a person
    // clicked is a URL nobody can trust.
    current(id) {
      this.rememberInRoute(id);
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

    /**
     * Choosing from the list, which is the only thing the list is for, so it closes.
     *
     * Separate from `select` because `fetch` also selects - the `?c=` a link from an agent run
     * arrives with - and that must not leave the list hanging open over the conversation it
     * was asked to show.
     */
    pick(id) {
      this.select(id);
      this.listOpen = false;
    },

    /**
     * Keep `?c=` on the URL in step with what is open.
     *
     * `fetch` already reads it - that is how a link from an agent run opens on its own
     * conversation - so the only half that was missing was writing it. Without that, reloading
     * the page, or coming back to a tab that had been left open, landed on the picker with
     * nothing selected and no way to tell which one you had been reading.
     *
     * `replace` rather than `push`: choosing a conversation is not a navigation somebody
     * should have to press Back through five times to leave the page.
     */
    rememberInRoute(id) {
      const current = this.$route.query.c || '';

      if ((id || '') === current) {
        return;
      }

      const query = { ...this.$route.query };

      if (id) {
        query.c = id;
      } else {
        delete query.c;
      }

      this.$router.replace({ query }).catch(() => {});
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
      <!--
        The title bar is the control: pressing it opens the list over the whole page and
        pressing it again gives the whole page back to the conversation. One thing on screen at
        a time, which is what both of them want - a list is for scanning and a conversation is
        for reading, and neither is improved by having half the height.
      -->
      <header
        class="dev-live__head"
        role="button"
        tabindex="0"
        :aria-expanded="String(listOpen)"
        @click="listOpen = !listOpen"
        @keydown.enter.prevent="listOpen = !listOpen"
        @keydown.space.prevent="listOpen = !listOpen"
      >
        <ClaudeLogo class="dev-live__logo" />
        <!--
          "Conversations" on a phone and "Live conversations" above it. Two words wrapped onto
          two lines at 390px, and "Live" is the half that is doing the least work: the page is
          about conversations, and that they are the live ones is what the subtitle said.
        -->
        <h2 class="dev-live__title">
          <span class="dev-live__title-live">Live </span>conversations
        </h2>
        <!--
          The list, behind one button, beside the title rather than after the subtitle: it is
          the control on this page and a sentence was pushing it to the far edge. What it says
          is which conversation is open, because that is the question somebody arriving here
          has; the list answers a different one - which others there are - asked once.
        -->
        <span class="dev-agents__toggle-title">{{ listOpen ? 'Pick one' : (selected ? selected.title : 'Pick one') }}</span>
        <span
          v-if="total"
          class="dev-agents__toggle-count"
        >{{ total }}</span>
        <i
          class="dev-agents__toggle-chevron"
          :class="listOpen ? 'icon icon-chevron-up' : 'icon icon-chevron-down'"
        />
      </header>
      <div class="dev-agents">
        <div
          v-show="listOpen"
          class="dev-agents__list"
        >
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
              @select="pick"
              @delete="end(group, $event)"
              @rename="rename(group, $event)"
            />
          </template>
        </div>
        <!--
          `v-show`, never `v-if`: each of these is a live exec socket onto a pod, and unmounting
          the pane to show the list would drop every one of them and start again on the way
          back.
        -->
        <div
          v-show="!listOpen"
          class="dev-agents__pane"
        >
          <Banner
            v-if="error"
            color="error"
            :label="error"
          />
          <p
            v-if="!selected"
            class="dev-agents__hint text-muted"
          >
            Open the picker above to choose one: the drawer's run in the agents pod, a workspace's in its own; this pane reaches either through the agents extension's terminal, chat view included.
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
  /*
   * The page is the viewport; the conversation is the only thing that scrolls.
   *
   * `min-width: 0` on every flex child in the chain, and `overflow: hidden` on the boxes that
   * are not meant to scroll. Without them a pane whose content is wider than the column - a
   * terminal sized in columns, a long unbroken path in a message - makes its container wider
   * than the page, and the whole document scrolls sideways as well as down. A flex child's
   * default is to refuse to shrink below its content, which is exactly what that is.
   */
  .dev-conversations {
    display:        flex;
    flex-direction: column;
    height:         100%;
    min-height:     0;
    min-width:      0;
    overflow:       hidden;
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
    min-width:      0;
    overflow:       hidden;

    /*
     * The title bar, which is the accordion.
     *
     * `center`, not `baseline`: a 16px mark, a 14px heading, an 11px count and a 12px chevron
     * on one baseline is four things at four different heights, which is what it looked like.
     * Centred, they are a row.
     */
    &__head {
      display:       flex;
      align-items:   center;
      gap:           var(--dev-space-3);
      min-height:    40px;
      padding:       var(--dev-space-2) var(--dev-space-4);
      border-bottom: 1px solid var(--border);
      cursor:        pointer;
      user-select:   none;

      &:hover { background: var(--tabbed-container-bg); }
      &:focus-visible { outline: 1px solid var(--link); outline-offset: -2px; }
    }

    &__logo { flex: 0 0 auto; color: var(--dev-accent); font-size: 16px; }
    &__title { flex: 0 0 auto; margin: 0; font-size: 14px; font-weight: 600; white-space: nowrap; }
    &__sub { flex: 1 1 auto; min-width: 0; font-size: 12px; }
  }

  .dev-agents {
    display:    flex;
    flex:       1 1 auto;
    min-height: 0;
    min-width:  0;
    overflow:   hidden;

    /*
     * The conversation's name: everything between the heading and the count.
     *
     * `flex: 1 1 auto` is what puts the count and the chevron at the right-hand edge. Without
     * it they sat immediately after the name, which left the bar looking like a label with
     * punctuation after it rather than a control spanning the row.
     */
    &__toggle-title {
      flex:          1 1 auto;
      min-width:     0;
      overflow:      hidden;
      text-overflow: ellipsis;
      white-space:   nowrap;
      color:         var(--muted);
      font-size:     13px;
    }

    // The right-hand end of the bar, always, however short the name is.
    &__toggle-chevron {
      flex:        0 0 auto;
      margin-left: var(--dev-space-2);
      color:       var(--muted);
      font-size:   12px;
    }

    &__toggle-count {
      // A count, not a badge: it was rendering as a wide oval taller than the text beside it.
      min-width:     16px;
      padding:       0 var(--dev-space-2);
      border-radius: 8px;
      background:    var(--tabbed-container-bg);
      color:         var(--muted);
      font-size:     11px;
      line-height:   16px;
      text-align:    center;
    }

    /*
     * Open, the list is the page - not a panel floating over it.
     *
     * It was `position: absolute` with a capped width and height, which is a dropdown: a
     * 300px column of names against an empty screen, still scrolling at sixteen conversations
     * while most of the page sat unused behind it. The title bar is an accordion, so the two
     * halves take turns having the whole body, and this one gets it when it is open.
     */
    &__list {
      flex:           1 1 auto;
      min-height:     0;
      display:        flex;
      flex-direction: column;
      overflow-y:     auto;
      padding:        var(--dev-space-3) 0;

      /*
       * Each group's DevList is given no label, because the workspace name is already rendered
       * above it - but an empty label still draws a heading row, and at a row's height each.
       * With five workspaces open that is five blank rows in a menu, which is most of the
       * reason it needed scrolling at all.
       */
      :deep(.dev-list__head) { display: none; }
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
      min-height:     0;
      overflow:       hidden;
    }

    &__terminal { flex: 1 1 auto; min-height: 0; }
  }

/* ── Phones: the list is a short scroller above the pane, not a column beside it. ── */
@media (max-width: 760px) {
  .dev-conversations { padding: 0; }

  // Edge to edge: 20px of margin either side of a 390px screen is a tenth of the conversation
  // spent on a border.
  .dev-live { margin: 0; border-left: 0; border-right: 0; border-radius: 0; }

  .dev-live__head {
    gap:        var(--dev-space-3);
    /*
     * The same inset as the bar above it and the conversation below it.
     *
     * It was 6px between a 10px top bar and a 10px chat log, so the one element between them
     * was the one that did not line up - and it is the widest thing on the page, so the step
     * showed on both edges at once.
     */
    padding:    var(--dev-space-3) var(--dev-space-4);
    // One row: this is a control now, and one that reflows to two lines when the name is long
    // is a control that moves under your thumb as you reach for it.
    flex-wrap:  nowrap;
    min-height: 44px;
  }

  // "Live conversations" wrapped to two lines beside the logo. The page is about
  // conversations; that they are the live ones is what the subtitle was for, and the subtitle
  // is the first thing to go when the screen is 390px and the conversation is the point of it.
  .dev-live__title-live { display: none; }
  .dev-live__sub { display: none; }

  .dev-agents {
    // Whichever half is showing gets the screen, which on a phone is the whole point.
    &__pane, &__list { min-height: 0; }
  }
}
</style>
