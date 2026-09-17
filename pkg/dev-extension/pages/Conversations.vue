<script>
// Agents: the drawer's own conversations, in one place, as a flat strip of tabs.
//
// A workspace's Conversations tab shows that workspace's; this page is for the free-standing
// runs the agents drawer starts - a review, a fix, a discussion under a comment - the ones that
// belong to no workspace. They all live in the one pod (Extension Studio's agent), which is what
// lets one page hold them: each tab is the Studio's terminal pointed at one drawer conversation.
//
// It is a single Tabbed of every open drawer conversation, most-recent first - the same tab
// strip the stage rail uses for its live agents (WorkspaceRail), rather than a per-workspace
// list. A workspace's stage conversations are reached from that workspace, not here.
import { Banner } from '@components/Banner';
import { RcButton } from '@components/RcButton';
import Tabbed from '@shell/components/Tabbed';
import Tab from '@shell/components/Tabbed/Tab';
import StudioTerminal from '../components/StudioTerminal.vue';
import DevModal from '../components/DevModal.vue';
import ConversationHeader from '../components/ConversationHeader.vue';
import { listAllWorkspaces, globalBrowserUrl } from '../api';
import {
  listConversations, endConversation, renameConversation, paneCommand, waitForStudio, reconnectConversation, reconnectEverything, conversationStates
} from '../conversations';
import { agentStateOf } from '../workspace-status';

const REFRESH_MS = 10000;

/**
 * Which conversation this browser was last reading.
 *
 * Per browser rather than in the route, because the two answer different questions: `?c=` is
 * "open this one", which a link carries and a reload keeps; this is "open the one I was on",
 * which is what arriving at the page with no query at all should do. Without it, every visit
 * landed on whichever conversation happened to sort first - never the one you were in the
 * middle of.
 *
 * localStorage can throw outright in a private window or with site data blocked, so every read
 * and write is guarded and an unavailable one simply means the page behaves as it did before.
 */
const LAST_CONVERSATION_KEY = 'dev.conversations.last';

function readLastConversation() {
  try {
    return localStorage.getItem(LAST_CONVERSATION_KEY) || '';
  } catch {
    return '';
  }
}

function writeLastConversation(id) {
  try {
    if (id) {
      localStorage.setItem(LAST_CONVERSATION_KEY, id);
    } else {
      localStorage.removeItem(LAST_CONVERSATION_KEY);
    }
  } catch {
    // A browser that will not remember is not a page that fails.
  }
}

/**
 * A conversation's id is unique only inside its workspace: the pod each one lives in numbers its
 * own tmux sessions, so a workspace with a conversation `1` and another workspace with a
 * conversation `1` are two different conversations that share an id. Flattened into one list,
 * that id stops identifying a tab - `current` matches both, both panes show, and the strip picks
 * whichever sorts first, which is how switching conversations landed on an unrelated chat.
 *
 * So the whole page tracks conversations by this composite instead: the workspace, which is
 * unique, and the id, which is unique within it. Workspace names are DNS-1123 and cannot contain
 * a slash, so the join is unambiguous and `convId` can take the id back off when a call needs
 * the bare one (the pod only knows its own numbering). The drawer's workspace is the empty
 * string, so its conversations are `/agent-1`, `/agent-2` - the ones this page shows.
 */
function convUid(workspace, id) {
  return `${ workspace }/${ id }`;
}

function convId(workspace, uid) {
  return String(uid).slice(String(workspace).length + 1);
}

export default {
  name: 'DevAgents',

  components: {
    Banner, RcButton, Tabbed, Tab, StudioTerminal, DevModal, ConversationHeader
  },

  async fetch() {
    await this.refresh();

    // Two ways to arrive with a conversation in mind, in the order they should win.
    //
    // `?c=` is explicit - a link from an agent run, or a reload of a page that was on one - so
    // it beats the memory. The memory is what makes opening this page from the nav come back to
    // what you were reading rather than to whatever sorts first.
    //
    // Both are checked against the drawer conversations that actually exist: one that has ended,
    // or a workspace's stage conversation that is not shown here, is not one to reopen.
    const wanted = [this.$route.query.c, readLastConversation()]
      .map((id) => String(id || ''))
      .find((id) => id && this.flatConversations.some((c) => c.uid === id));

    if (wanted) {
      this.select(wanted);
    }
  },

  data() {
    return {
      groups:  [],
      current: '',
      restarting: false,
      restartNote: '',
      states:  {},
      // What each conversation's agent is doing, by its bare (pod-local) id, from the same poll
      // the sidebar and the rail use. `states` above is the pane's socket state; this is claude's.
      agents:  {},
      agentsTimer: null,
      /** The selected conversation blown up to fill the window (DevModal), when asked for. */
      popped:  false,
      seen:    {},
      error:   '',
      timer:   null,
    };
  },

  computed: {
    all() {
      return this.groups.flatMap((group) => group.conversations.map((c) => ({
        ...c, workspace: group.workspace, uid: convUid(group.workspace, c.id),
      })));
    },

    /**
     * The tabs: the drawer's own conversations only, most-recent first.
     *
     * `!c.workspace` is the whole filter - a drawer run carries the empty workspace, a
     * workspace's stage conversation carries its name (see `refresh`), so this keeps the
     * free-standing runs and drops every workspace's. There is no timestamp on a drawer
     * session, so recency is read off its id: the drawer numbers them `agent-1`, `agent-2`, …
     * in the order they were opened, so the larger the trailing number the newer it is.
     */
    flatConversations() {
      const seq = (c) => Number(String(c.id).match(/(\d+)$/)?.[1] || 0);

      return this.all
        .filter((c) => !c.workspace)
        .sort((a, b) => seq(b) - seq(a));
    },

    selected() {
      return this.flatConversations.find((c) => c.uid === this.current) || null;
    },
  },

  watch: {
    // Written on every change rather than only on a pick: `fetch` and the refresh below can
    // both change which conversation is current, and a URL that is right only when a person
    // clicked is a URL nobody can trust.
    current(id) {
      this.rememberInRoute(id);
      writeLastConversation(id);
      this.repaintCurrent();
    },
  },

  mounted() {
    this.timer = setInterval(() => this.refresh(), REFRESH_MS);
    // The agents' states, on their own fifteen-second beat, so the header over the pane says
    // what each conversation's claude is doing.
    this.refreshAgents();
    this.agentsTimer = setInterval(() => this.refreshAgents(), 15000);
  },

  beforeUnmount() {
    clearInterval(this.timer);
    clearInterval(this.agentsTimer);
  },

  methods: {
    /**
     * Open the one shared GitHub browser in a new tab. It is where a person signs into github.com
     * once; every agent then uploads PR media through it (see GITHUB_BROWSER_CDP, browser-control).
     */
    openBrowser() {
      window.open(globalBrowserUrl(), '_blank', 'noopener');
    },

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
        // and this is where a run's output is read. It is the group with the empty workspace,
        // which is the one this page keeps (see `flatConversations`).
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

        if (this.current && !this.flatConversations.some((c) => c.uid === this.current)) {
          this.current = '';
        }
      } catch (e) {
        this.error = e.message || String(e);
      }
    },

    /** Every conversation's agent state, by its bare id - the header reads this by `c.id`. */
    async refreshAgents() {
      const states = await conversationStates().catch(() => null);

      if (!states) {
        return;
      }
      const next = {};

      for (const c of states) {
        next[c.id] = agentStateOf(c);
      }
      this.agents = next;
    },

    select(uid) {
      this.current = uid;
      this.seen = { ...this.seen, [uid]: true };
    },

    /** Tabbed says which tab is on show; that is the conversation we track and remember. */
    onTab({ tab }) {
      this.select(tab.name);
    },

    /**
     * Make the pane that just became current actually redraw.
     *
     * Every pane that has been opened stays mounted behind Tabbed's `v-show` so its terminal
     * socket survives a switch. But a terminal that has been `display: none` can lose the canvas
     * it had drawn, and when it reappears at the same size the terminal only re-fits - which does
     * nothing when the size has not changed - so it sits blank, still showing the frame from
     * before. The terminal itself recovers on window focus and on `visibilitychange`, which is
     * exactly why switching browser tabs and back "fixed" a stale pane. Do that recovery here
     * the moment a conversation is selected, for the one pane that is now visible.
     *
     * `__mcTerm` is the terminal instance the agents extension hangs on its own element for
     * this kind of outside nudge; `settleFits` is its "the view is back, redraw" call. All of
     * it is guarded, so a pane that is not one of those terminals simply does nothing.
     */
    repaintCurrent() {
      this.$nextTick(() => {
        const panes = Array.from(this.$el?.querySelectorAll('.studio-terminal__pane') || []);
        const visible = panes.find((el) => el.offsetParent !== null);

        visible?.__mcTerm?.settleFits?.();
      });
    },

    /** The bare, pod-local id behind a tab's composite key, for the calls that reach the pod. */
    idFor(group, uid) {
      return convId(group.workspace, uid);
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

    onState(uid, state) {
      this.states = { ...this.states, [uid]: state };
    },

    /**
     * This conversation, or every one where it lives, put back onto the login the pod has now.
     * Manual on purpose: nothing restarts a pane by itself any more - see reconnectConversation.
     */
    async restart(all = false) {
      const conversation = this.selected;

      if (!conversation) {
        return;
      }
      this.restarting = true;
      this.restartNote = '';
      try {
        if (all) {
          await reconnectEverything(conversation.workspace || '');
          this.restartNote = conversation.workspace ? `Restarted every conversation in ${ conversation.workspace }.` : 'Restarted every conversation in the drawer.';
        } else {
          await reconnectConversation(conversation.attach);
          this.restartNote = `Restarted ${ conversation.title }.`;
        }
        this.error = '';
      } catch (e) {
        this.error = e.message || String(e);
      } finally {
        this.restarting = false;
        setTimeout(() => {
          this.restartNote = '';
        }, 6000);
      }
    },

    async end(group, uid) {
      const id = this.idFor(group, uid);

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
      const id = this.idFor(group, key);

      try {
        if (group.workspace) {
          await renameConversation(group.workspace, id, title);
        } else {
          await (await waitForStudio()).agent.rename(id, title);
        }
        await this.refresh();
      } catch (e) {
        this.error = e.message || String(e);
      }
    },

    /** The group a conversation belongs to, for the header's rename and close. */
    groupOf(conversation) {
      return conversation ? this.groups.find((group) => group.workspace === conversation.workspace) : null;
    },
  },
};
</script>

<template>
  <div class="dev-conversations">
    <!-- Every drawer conversation, live, as one flat strip of tabs. -->
    <section class="dev-live">
      <Banner
        v-if="error"
        color="error"
        :label="error"
      />
      <!--
        The page's own controls, above the strip: the shared GitHub browser (one Chromium every
        agent uses for github.com - a person signs it in once here, then agents upload PR media
        through it), and, for the conversation on show, the two restart buttons.

        Restarting is a person's decision rather than a timer's: claude is stopped and started
        again on the same conversation, which is how a pane picks up a login refreshed while it
        was running.
      -->
      <div class="dev-agents__toolbar">
        <RcButton
          variant="secondary"
          size="small"
          @click="openBrowser"
        >
          Open GitHub browser
        </RcButton>
        <span
          v-if="restartNote"
          class="dev-agents__note text-muted"
        >{{ restartNote }}</span>
        <template v-if="selected">
          <button
            type="button"
            class="btn role-tertiary btn-sm"
            :disabled="restarting"
            title="Stop claude in this conversation and start it again on the same conversation"
            data-testid="dev-restart-one"
            @click="restart(false)"
          >
            <i class="icon icon-refresh" /> Restart
          </button>
          <button
            type="button"
            class="btn role-tertiary btn-sm"
            :disabled="restarting"
            title="Restart every conversation in the drawer"
            data-testid="dev-restart-all"
            @click="restart(true)"
          >
            Restart all here
          </button>
        </template>
      </div>
      <p
        v-if="!flatConversations.length"
        class="dev-agents__empty text-muted"
      >
        No conversations are open. Start one from a workspace's Conversations tab, from My Work, or from an agent above.
      </p>
      <!--
        One Tabbed of every drawer conversation - the product's own tab strip, the same one the
        stage rail draws its live agents with. It hides an inactive tab with v-show rather than
        unmounting it, so a terminal, once opened, keeps its socket while another tab is on show;
        `seen` is what stops one being drawn for a tab nobody has looked at yet, and the popped
        guard hands the session to the modal while it is up so the two do not fight over it.

        `use-hash` is off: the page keeps its place with `?c=` (see `rememberInRoute`), and a
        second writer of the route - the tab strip's own `#uid` - would only get in its way.
      -->
      <Tabbed
        v-else
        class="dev-agents__tabs"
        :default-tab="current"
        :use-hash="false"
        flat
        @changed="onTab"
      >
        <Tab
          v-for="(c, i) in flatConversations"
          :key="c.uid"
          :name="c.uid"
          :label="c.title || 'Conversation'"
          :tooltip="c.workspace || 'Agents drawer'"
          :weight="flatConversations.length - i"
        >
          <!--
            The conversation's own controls over its pane: its name (renamed in place), what its
            agent is doing, a way to open it larger and a way to close it - the same bar the
            stage's Conversations tab shows.
          -->
          <ConversationHeader
            :conversation="c"
            :agent="agents[c.id] || 'none'"
            @rename="rename(groupOf(c), { key: c.uid, title: $event })"
            @popout="popped = true; current = c.uid"
            @close="end(groupOf(c), c.uid)"
          />
          <StudioTerminal
            v-if="seen[c.uid] && !(popped && c.uid === current)"
            :session="c.uid"
            :command="paneFor(c)"
            class="dev-agents__terminal"
            @state="onState(c.uid, $event)"
          />
        </Tab>
      </Tabbed>
      <!-- The larger view of the selected conversation, over the page. -->
      <DevModal
        v-if="popped && selected"
        :title="selected.title || 'conversation'"
        @close="popped = false"
      >
        <div class="dev-agents__popped">
          <StudioTerminal
            :key="`pop-${ selected.uid }`"
            :session="selected.uid"
            :command="paneFor(selected)"
            class="dev-agents__terminal"
            @state="onState(selected.uid, $event)"
          />
        </div>
      </DevModal>
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
    padding:        0;
  }

  .dev-live {
    display:        flex;
    flex-direction: column;
    background:     var(--body-bg);
    flex:           1 1 auto;
    min-height:     0;
    min-width:      0;
    overflow:       hidden;
  }

  .dev-agents {
    // The row above the strip: the GitHub browser on the left, the restart controls pushed to
    // the right, the restart note between them.
    &__toolbar {
      display:       flex;
      align-items:   center;
      gap:           var(--dev-space-2);
      padding:       var(--dev-space-2) var(--dev-space-3);
      border-bottom: 1px solid var(--border);

      // Everything after the browser button is a restart control; the note takes the slack so
      // they sit at the right-hand edge.
      .dev-agents__note { margin-left: auto; }
      .btn:first-of-type { margin-left: auto; }
      .dev-agents__note + .btn { margin-left: 0; }
    }

    &__note { font-size: 12px; }

    &__empty { padding: var(--dev-space-4); margin: 0; font-size: 13px; }

    &__terminal { flex: 1 1 auto; min-height: 0; }

    // The blown-up conversation inside DevModal fills the panel it is given.
    &__popped {
      display:        flex;
      flex-direction: column;
      height:         calc(100vh - 140px);
    }

    /*
     * The flat tab strip fills the page under the toolbar. Tabbed wraps its panes in
     * `.tab-container`, and each pane is a `[role="tabpanel"]` section it shows with `v-show`;
     * both have to become height-filling flex columns for the terminal inside the active one to
     * get the space, which they are not by default (the shell sizes them for forms).
     */
    &__tabs {
      display:        flex;
      flex-direction: column;
      flex:           1 1 auto;
      min-height:     0;
      min-width:      0;

      :deep(.tab-container) {
        display:        flex;
        flex-direction: column;
        flex:           1 1 auto;
        min-height:     0;
        min-width:      0;
        padding:        0;
      }

      // v-show sets `display: none` on an inactive pane, which wins over this; the active one
      // becomes the flex column that gives its header and terminal their heights.
      :deep(.tab-container > [role="tabpanel"]) {
        display:        flex;
        flex-direction: column;
        flex:           1 1 auto;
        min-height:     0;
        min-width:      0;
      }
    }
  }

/* ── Phones: the strip scrolls sideways rather than becoming a column. Nothing else to do:
      Tabbed's horizontal tablist already scrolls, and the pane below it takes the rest. ── */
@media (max-width: 760px) {
  .dev-conversations { padding: 0; }

  .dev-live { margin: 0; border-left: 0; border-right: 0; border-radius: 0; }
}
</style>
