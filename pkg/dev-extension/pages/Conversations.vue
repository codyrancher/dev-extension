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

const ROW_STATE = {
  open: 'running', connecting: 'starting', waiting: 'starting', closed: 'stopped'
};

/**
 * A conversation's id is unique only inside its workspace: the pod each one lives in numbers its
 * own tmux sessions, so a workspace with a conversation `1` and another workspace with a
 * conversation `1` are two different conversations that share an id. Flattened into one list,
 * that id stops identifying a row - `current` matches both, both panes show, and the list picks
 * whichever sorts first, which is how switching conversations landed on an unrelated chat.
 *
 * So the whole page tracks conversations by this composite instead: the workspace, which is
 * unique, and the id, which is unique within it. Workspace names are DNS-1123 and cannot contain
 * a slash, so the join is unambiguous and `convId` can take the id back off when a call needs
 * the bare one (the pod only knows its own numbering). The drawer's workspace is the empty
 * string, so its conversations are `/1`, `/2` - still distinct from any real workspace's.
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
    Banner, DevList, StudioTerminal, ClaudeLogo
  },

  async fetch() {
    await this.refresh();

    // Two ways to arrive with a conversation in mind, in the order they should win.
    //
    // `?c=` is explicit - a link from an agent run, or a reload of a page that was on one - so
    // it beats the memory. The memory is what makes opening this page from the nav come back to
    // what you were reading rather than to whatever sorts first.
    //
    // Both are checked against the conversations that actually exist: one that has ended is not
    // one to reopen, and the list is already loaded by the time this runs.
    const wanted = [this.$route.query.c, readLastConversation()]
      .map((id) => String(id || ''))
      .find((id) => id && this.all.some((c) => c.uid === id));

    if (wanted) {
      this.select(wanted);
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
       *
       * This accordion is the phone layout only. On a wide screen the list is a column that
       * is always there beside the pane (see the styles), so `listOpen` and the header toggle
       * do nothing there - `isMobile` is what gates all of it.
       */
      listOpen: false,

      /**
       * Whether we are at the phone width where the list is an accordion rather than a column.
       *
       * Read from the same `760px` breakpoint the styles use, so the two never disagree, and
       * kept in step with a matchMedia listener rather than a resize handler that fires on
       * every pixel. It is what turns the header from a plain title bar (wide) into the button
       * that opens the list (narrow).
       */
      isMobile: false,
    };
  },

  computed: {
    all() {
      return this.groups.flatMap((group) => group.conversations.map((c) => ({
        ...c, workspace: group.workspace, uid: convUid(group.workspace, c.id),
      })));
    },

    selected() {
      return this.all.find((c) => c.uid === this.current) || null;
    },

    /** How many there are, for the button that opens the list. */
    total() {
      return this.all.length;
    },

    /**
     * What the header says between the heading and the count.
     *
     * On a phone the header is the control: "Pick one" while the list is open, the open
     * conversation's name while it is closed. On a wide screen the list is always beside the
     * pane, so there is nothing to pick from the header - it just names what is showing.
     */
    headerLabel() {
      if (this.isMobile) {
        return this.listOpen ? 'Pick one' : (this.selected ? this.selected.title : 'Pick one');
      }

      return this.selected ? this.selected.title : '';
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

    // The phone/desktop split, read from the one breakpoint the styles use. matchMedia rather
    // than a resize listener: it fires only when the answer actually changes.
    this.mediaQuery = window.matchMedia('(max-width: 760px)');
    this.isMobile = this.mediaQuery.matches;
    this.onMediaChange = (e) => {
      this.isMobile = e.matches;
    };
    this.mediaQuery.addEventListener('change', this.onMediaChange);
  },

  beforeUnmount() {
    clearInterval(this.timer);
    this.mediaQuery?.removeEventListener('change', this.onMediaChange);
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

        if (this.current && !this.all.some((c) => c.uid === this.current)) {
          this.current = '';
        }
      } catch (e) {
        this.error = e.message || String(e);
      }
    },

    rows(group) {
      // Keyed by the composite uid, because `current` is one - a row highlights, and selecting
      // it opens, the conversation the uid names rather than any other workspace's same-numbered
      // one. The state map is keyed the same way (see `onState`).
      return group.conversations.map((c) => {
        const uid = convUid(group.workspace, c.id);

        return {
          key:   uid,
          label: c.title,
          state: ROW_STATE[this.states[uid]] || 'stopped',
        };
      });
    },

    select(uid) {
      this.current = uid;
      this.seen = { ...this.seen, [uid]: true };
    },

    /** The header is a button only on a phone; on a wide screen the list is already showing. */
    toggleList() {
      if (this.isMobile) {
        this.listOpen = !this.listOpen;
      }
    },

    /**
     * Make the pane that just became current actually redraw.
     *
     * Every pane stays mounted behind `v-show` so its terminal socket survives a switch (see
     * the `v-for` below). But a terminal that has been `display: none` can lose the canvas it
     * had drawn, and when it reappears at the same size the terminal only re-fits - which does
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

    /** The bare, pod-local id behind a row's composite key, for the calls that reach the pod. */
    idFor(group, uid) {
      return convId(group.workspace, uid);
    },

    /**
     * Choosing from the list, which is the only thing the list is for, so it closes.
     *
     * Separate from `select` because `fetch` also selects - the `?c=` a link from an agent run
     * arrives with - and that must not leave the list hanging open over the conversation it
     * was asked to show.
     */
    pick(uid) {
      this.select(uid);
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

    onState(uid, state) {
      this.states = { ...this.states, [uid]: state };
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
  },
};
</script>

<template>
  <div class="dev-conversations">
    <!-- Every conversation in every workspace, live, with a pane onto the one picked. -->
    <section class="dev-live">
      <!--
        The header exists on a phone only. There, the list and the pane cannot both fit, so
        the bar is the control - pressing it opens the list over the whole page and pressing it
        again gives the page back to the conversation. One thing on screen at a time, which is
        what both want on a phone: a list is for scanning and a conversation is for reading, and
        neither is improved by having half the height. On a wide screen the list is always the
        column on the left beside the pane, so there is nothing to toggle and no title bar to
        spend the height on - the two columns take the whole page, edge to edge.
      -->
      <header
        v-if="isMobile"
        class="dev-live__head"
        role="button"
        :tabindex="0"
        :aria-expanded="String(listOpen)"
        @click="toggleList"
        @keydown.enter.prevent="toggleList"
        @keydown.space.prevent="toggleList"
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
        <span class="dev-agents__toggle-title">{{ headerLabel }}</span>
        <span
          v-if="total"
          class="dev-agents__toggle-count"
        >{{ total }}</span>
        <i
          v-if="isMobile"
          class="dev-agents__toggle-chevron"
          :class="listOpen ? 'icon icon-chevron-up' : 'icon icon-chevron-down'"
        />
      </header>
      <div
        class="dev-agents"
        :class="{ 'dev-agents--list-open': listOpen }"
      >
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
            {{ isMobile ? 'Open the picker above to choose one' : 'Choose a conversation from the list' }}: the drawer's run in the agents pod, a workspace's in its own; this pane reaches either through the agents extension's terminal, chat view included.
          </p>
          <template
            v-for="c in all"
            :key="c.uid"
          >
            <StudioTerminal
              v-if="seen[c.uid]"
              v-show="c.uid === current"
              :session="c.uid"
              :command="paneFor(c)"
              class="dev-agents__terminal"
              @state="onState(c.uid, $event)"
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
    // No outer padding: on a wide screen the two columns take the whole page, and on a phone
    // the media query below already goes edge to edge. The page is the conversation; the space
    // belongs to it, not to a frame around it.
    padding:        0;
  }

  .dev-live {
    display:        flex;
    flex-direction: column;
    // Edge to edge, no frame: no margin, border or radius boxing the conversation in. The
    // list/pane split carries its own divider (the list's border-right), which is the only
    // line this layout needs.
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
     * On a wide screen the list is a column that is always there, on the left of the pane -
     * the layout a desktop app would give it, where choosing one is a click on a list you can
     * already see rather than a click to reveal the list first. On a phone there is no room
     * for two columns, so the title bar becomes an accordion and this turns into the half that
     * takes the whole screen when it is open (see the `760px` media query at the end).
     *
     * It was once `position: absolute` with a capped width and height - a dropdown, a 300px
     * column of names against an empty screen while most of the page sat unused behind it.
     */
    &__list {
      flex:           0 0 260px;
      min-height:     0;
      display:        flex;
      flex-direction: column;
      overflow-y:     auto;
      padding:        var(--dev-space-3) 0;
      border-right:   1px solid var(--border);

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
    /*
     * Phone: the list is no longer a column beside the pane, it is the accordion the header
     * opens. Closed, the pane has the screen; open, the list does. Whichever is showing gets
     * all of it, which on a phone is the whole point.
     */
    &__list {
      display:      none;
      flex:         1 1 auto;
      border-right: 0;
    }

    &__pane, &__list { min-height: 0; }
  }

  .dev-agents--list-open {
    .dev-agents__list { display: flex; }
    .dev-agents__pane { display: none; }
  }
}
</style>
