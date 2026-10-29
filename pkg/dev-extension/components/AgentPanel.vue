<script>
// The panel the global chord opens: several conversations with the agent pod, as tabs.
//
// Inside a tab is PodTerminal, pointed at one conversation in the agent pod.
//
// Two things about the conversations, and they pull in opposite directions on purpose:
//
//   - Which conversations exist, and what they are called, come from the pod. tmux and a
//     directory under /workspace/sessions are where a conversation actually is, so that is what
//     is asked (see agent.ts), which is what makes a second browser tab, a reload and a
//     colleague's session all show the same list with the same names.
//   - Whether this panel is open, where it sits and how big it is come from localStorage. That
//     is one person in front of one browser, and putting it in the pod would mean docking the
//     panel left here docked it left on somebody else's screen. See agent-drawer.ts.
//
// ---------------------------------------------------------------------------
// The conversations are a tab row, not a dropdown.
//
// One tab per conversation, click to switch, drag to rearrange - the whole set visible at a
// glance and in whatever order suits, which is what a person wants when they are moving between
// two or three of them. Each tab carries its own controls rather than one shared set acting on
// "the active one": a rename pencil and a close, both appearing on hover (and on keyboard focus,
// so they are reachable without a mouse) in reserved trailing space so a tab does not change
// width as the pointer crosses it. So closing the third conversation does not mean selecting it
// first.
//
// Written out here rather than imported from Rancher's `@shell/components/Tabbed`: that component
// renders a label as escaped text with no slot, so per-tab controls cannot be added to it, and
// it has no notion of a rename box in place of a label. It is a plain flex row instead - no
// `useHash` (a conversation id in the URL would land in Rancher's history), no side-tab mode,
// no extension tabs. The active tab is marked with a background and an underline; the row scrolls
// sideways when there are more tabs than fit, and the new-conversation button rides at its end.
// Dragging one along the row reorders it, and that order is this browser's - see drawer.ts.
// ---------------------------------------------------------------------------
import { isAdminUser } from '@shell/store/type-map';
// The Studio's design tokens, which SMenu and SIcon are drawn in. Imported here, the way every
// Studio page imports them, because this panel is the one part of the Studio that opens over
// Rancher's own pages - and those pages have never loaded a Studio route, so without this the
// menu renders with `background: var(--studio-surface)` resolving to nothing and floats over the
// terminal as unreadable text. The stylesheet declares custom properties on `body` and nothing
// else, so carrying it on every page changes the look of none of them.
import '../design/studio';
import PodTerminal from './PodTerminal';
import SplitButton from './SplitButton.vue';
import { CLI_CHOICES } from '../agent-clis.mjs';
import Tab from '@shell/components/Tabbed/Tab';
import ConversationTabbed from './tabbed/ConversationTabbed.vue';
import ConversationTab from './tabbed/ConversationTab.vue';
import { readPrefs } from '../prefs';
import SIcon from './ui/SIcon.vue';
import SMenu from './ui/SMenu.vue';
import {
  // `agentSessions` as well as `panelSessions`: `pollStates` has always called it and it has
  // never been imported, so every tick threw `agentSessions is not defined` into a `catch`
  // that returns quietly - "a missed poll is a dot a few seconds stale" - and the strip's
  // dots have only ever moved on a full refresh. The unfiltered list is right for a state
  // lookup by id: the panel's own sessions are a subset, and the rest are never looked up.
  agentSessions, panelSessions, startAgentSession, renameAgentSession, endAgentSession, forkAgentSession,
} from '../agent';
// The label an unnamed tab gets. An id may now carry where it came from, so "everything after
// `agent-`" is no longer the ordinal and would have put the whole id on the tab.
import { conversationLabel } from '../conversation-id.mjs';
import { ensureAgentCredential } from '../credential';
import {
  readDrawerState, writeDrawerState, arrange, PLACEMENTS, DEFAULT_PLACEMENT, MIN_SIZE, VIEWPORT_MARGIN,
} from '../drawer';

/** The mouse button a tab is closed with, as `MouseEvent.button` numbers it. */
const MIDDLE_BUTTON = 1;

/** The id of the one stylesheet this panel reserves the dashboard's room with. */
const RESERVATION_ID = 'mc-agent-reservation';

/**
 * How far the pointer travels before pressing a tab is a drag rather than a click.
 *
 * A tab is both the thing you click to switch conversation and the thing you drag to move it,
 * so one of the two has to wait for the pointer to say which it is. A few pixels is under the
 * wobble of a deliberate click and well inside the width of the smallest tab.
 */
const DRAG_THRESHOLD = 4;

/** How fast the tab row scrolls when a drag reaches its edge, in pixels per frame. */
const EDGE_SCROLL = 12;

/** How close to the edge of the row a drag has to be for that to start, in pixels. */
const EDGE_ZONE = 32;

/**
 * How often the tabs re-read what their conversations are doing, for the status dots.
 *
 * The state lives in the pod - a tmux session and a transcript's mtime, neither reachable from
 * the browser - so it is re-asked rather than pushed. Slow enough not to hammer the exec
 * subresource with a panel sitting open, quick enough that a dot flipping to "working" or
 * "waiting" is seen while it still matters. In step with the Dev extension's sidebar tick.
 */
const STATES_POLL_MS = 12_000;

/**
 * The stylesheet holding the reservation, made on first use.
 *
 * One element for the life of the page rather than a rule rewritten into an existing sheet:
 * setting `textContent` on it is a single assignment the browser reparses, so there is no rule
 * index to keep and nothing to clean up but the element itself.
 */
function reservationSheet() {
  const existing = document.getElementById(RESERVATION_ID);

  if (existing) {
    return existing;
  }

  const sheet = document.createElement('style');

  sheet.id = RESERVATION_ID;
  document.head.appendChild(sheet);

  return sheet;
}

/**
 * The placement row, in the order a browser's devtools draws the same choice.
 *
 * Three of its four. A separate window was built and taken out again: a real popup means the
 * terminal, its WebSocket and a Vue app in a second document with no access to the dashboard's
 * store, and the floating panel that stood in for it was a fourth thing to position, drag,
 * clamp and persist for no use anybody had. What remains of it is the fallback in
 * agent-drawer.ts, which turns a stored `window` back into `bottom`.
 */
const PLACEMENT_CHOICES = [
  { id: 'left', icon: 'dockLeft', label: 'Dock left' },
  { id: 'bottom', icon: 'dockBottom', label: 'Dock bottom' },
  { id: 'right', icon: 'dockRight', label: 'Dock right' },
];

export default {
  name: 'AgentPanel',

  components: {
    PodTerminal, SIcon, SMenu, SplitButton, Tab, ConversationTabbed, ConversationTab },

  data() {
    const stored = readDrawerState();

    return {
      /** Which CLI the plain press makes, from the preference; '' reads as claude. */
      defaultCli: '',
      open:     false,
      /** [{ id, title, state }], as the pod reports them. `state` drives the tab's status dot. */
      sessions: [],
      active:   '',
      /** The interval re-reading the conversations' states while the panel is open, or null. */
      statesTimer: null,
      // Whether the tab remembered from the last visit has been restored yet. Until it has, it
      // outranks whatever this page load happened to select.
      restoredTab: false,
      // Which of them have ever been on top. A terminal is mounted on first visit and then kept
      // (an inactive panel is hidden with v-show), so coming back to a conversation is instant
      // and its scrollback is intact, while one nobody has opened here holds no socket at all.
      seen:     [],
      loading:  false,
      error:    '',
      /** The conversation being forked, by id, while its copy is being made. */
      forking:  '',
      /** The Rancher user the pod is currently acting as, or '' when it has no identity. */
      identity: '',

      placement: stored.placement,
      geometry:  { ...stored.geometry },
      /** The conversation order this browser last had, by id. See drawer.ts `arrange`. */
      order:     stored.order,
      /** The drag in progress, or null. See onGrab. */
      drag:      null,
    };
  },

  computed: {
    /** The CLIs to offer; a module constant is not visible to a template. */
    CLI_CHOICES: () => CLI_CHOICES,

    /**
     * Whether to show any of this at all.
     *
     * Rancher's own definition, read from what the user's schemas say they may PUT rather than
     * from a global role name we would have to keep in step with Rancher's. See the note in
     * agent-overlay.ts for why the gate is here as well as on the key handler.
     */
    admin() {
      return isAdminUser(this.$store.getters);
    },

    /**
     * Where the panel is, as inline style.
     *
     * Only the dimension that placement makes resizable is set here; the rest is CSS, so a
     * panel docked at the bottom cannot end up carrying a width from a session where it was
     * docked to a side.
     */
    frameStyle() {
      const { height, width } = this.geometry;

      return this.placement === 'bottom' ? { height: `${ height }px` } : { width: `${ width }px` };
    },

    /**
     * The room the dashboard gives up to this panel, as one CSS rule.
     *
     * `.dashboard-root` is the element Rancher sizes to the viewport, on every layout it has,
     * and everything else - the header, the nav, the scrolling main area - divides up what is
     * inside it. Padding it is therefore the whole reservation: the dashboard lays itself out
     * in what is left, keeps its own single scrollbar, and needs to know nothing about this.
     *
     * The obvious alternative was Rancher's own `--wm-height` / `--wm-vl-width` /
     * `--wm-vr-width`, which is how its window manager reserves space for a docked shell. Two
     * things rule it out. Only the default layout has a row for `--wm-height` at all -
     * `home.vue` and `plain.vue` size columns and stop - so a bottom panel would go on
     * overlaying the Home page, which is one of the pages the chord is offered on. And the
     * variables belong to the window manager: writing them would fight whatever it had docked
     * rather than sit beside it.
     */
    reservation() {
      if (!this.open) {
        return '';
      }

      const { height, width } = this.geometry;

      const side = {
        bottom: `padding-bottom: ${ height }px`,
        left:   `padding-left: ${ width }px`,
        right:  `padding-right: ${ width }px`,
      }[this.placement];

      return side ? `.dashboard-root { ${ side }; }` : '';
    },

    /**
     * The panel's own menu.
     *
     * This is where further options go. Anything else this panel grows - a font size, a mode,
     * somewhere to put a transcript - belongs in this list rather than in a second control
     * beside it, which is how a strip ends up with five icons nobody can tell apart.
     */
    menuItems() {
      return [{
        id: 'placement', label: 'Placement', choices: PLACEMENT_CHOICES, value: this.placement,
      }];
    },

  },

  /**
   * Reopen as this browser left it.
   *
   * The panel is only built at all when the chord is pressed or when the overlay has already
   * read that it was open, so this runs once and does not have to guard against being early.
   */
  watch: {
    // A stylesheet rather than an inline style on the element, because `.dashboard-root` is
    // rendered by whichever layout the current route asked for and is replaced when the route
    // moves between them. A rule survives that; a style attribute set on the old element does
    // not, and the panel would silently start overlaying again on the first navigation.
    reservation: {
      handler(now) {
        reservationSheet().textContent = now;
      },
      immediate: true,
    },
  },

  mounted() {
    // Which CLI this person holds conversations with, for the split button's plain press.
    readPrefs().then((prefs) => {
      this.defaultCli = prefs.cli || '';
    }).catch(() => undefined);
    // The viewport this was stored against is not necessarily this one.
    this.clamp();
    window.addEventListener('resize', this.clamp);

    if (readDrawerState().open) {
      this.setOpen(true);
    }

  },

  beforeUnmount() {
    // Rancher keeps rendering after this panel is gone, so anything it was told to reserve has
    // to be given back or the dashboard keeps a strip of empty space for ever.
    document.getElementById(RESERVATION_ID)?.remove();

    this.stopPolling();
    this.endGrab();
    window.removeEventListener('resize', this.clamp);
  },

  methods: {
    // -----------------------------------------------------------------------
    // Open, closed, and where
    // -----------------------------------------------------------------------

    /** What the chord does. It is also the only way to dismiss the panel: there is no X. */
    toggle() {
      this.setOpen(!this.open);
    },

    close() {
      this.setOpen(false);
    },

    setOpen(open) {
      if (!this.admin) {
        return;
      }

      this.open = open;
      this.remember();

      if (open) {
        this.refresh();
        this.startPolling();
      } else {
        this.stopPolling();
      }
    },

    remember() {
      // Never write an empty tab over a remembered one. Opening the panel remembers before it
      // refreshes, and on a fresh page load there is no active tab yet - so the id from the last
      // visit was erased a moment before the code that restores it went looking for it.
      const stored = readDrawerState();

      // The arrangement is the tab row itself, which is what keeps it pruned: a conversation
      // that has ended is not in the row, so it is not written back. Guarded like `active` and
      // for the same reason - the panel remembers before it refreshes, and an empty row at that
      // moment means "not read yet", not "no order".
      this.order = this.sessions.length ? this.sessions.map((session) => session.id) : stored.order;

      writeDrawerState({
        open:      this.open,
        active:    this.active || stored.active,
        placement: this.placement,
        geometry:  this.geometry,
        order:     this.order,
      });
    },

    onMenu(id) {
      if (PLACEMENTS.includes(id)) {
        this.movePanel(id);
      }
    },

    /** The conversations menu, which is the tab row on a phone. */
    /**
     * Take a side, or come off the edges altogether.
     *
     * The geometry is clamped on arrival rather than on the way out, because the viewport a
     * width was stored against is not the one it is being restored into: a panel sized on a
     * large monitor would otherwise open on a laptop covering the page and its own controls.
     */
    movePanel(placement) {
      this.placement = PLACEMENTS.includes(placement) ? placement : DEFAULT_PLACEMENT;
      this.clamp();
      this.remember();
      // xterm measures the box it is in, and the box has just changed size.
      this.$nextTick(() => window.dispatchEvent(new Event('resize')));
    },

    clamp() {
      const maxHeight = Math.max(MIN_SIZE, window.innerHeight - VIEWPORT_MARGIN);
      const maxWidth = Math.max(MIN_SIZE, window.innerWidth - VIEWPORT_MARGIN);
      const fit = (value, max) => Math.min(Math.max(value, MIN_SIZE), max);

      this.geometry = {
        height: fit(this.geometry.height, maxHeight),
        width:  fit(this.geometry.width, maxWidth),
      };
    },

    // -----------------------------------------------------------------------
    // Dragging: one implementation, four edges
    // -----------------------------------------------------------------------

    /**
     * Start a drag of one of the panel's edges.
     *
     * `what` is the edge being pulled. Every placement has exactly one thing that resizes - the
     * height when docked at the bottom, the width when docked to a side - so there is no
     * placement that renders and cannot be resized, which was the thing to avoid.
     *
     * Listeners go on the window rather than the handle: the pointer leaves a four-pixel grip
     * immediately and a drag that stopped tracking there would be a panel that resizes for one
     * pixel and then stops.
     */
    onGrab(what, event) {
      event.preventDefault();

      this.drag = {
        what,
        startX:   event.clientX,
        startY:   event.clientY,
        geometry: { ...this.geometry },
      };

      window.addEventListener('mousemove', this.onDrag);
      window.addEventListener('mouseup', this.endGrab);
    },

    onDrag(event) {
      if (!this.drag) {
        return;
      }

      const { what, startX, startY, geometry } = this.drag;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      const next = { ...geometry };

      // Which way the number moves depends on which edge is being pulled: dragging the top edge
      // of a bottom-docked panel upwards is a negative dy and a taller panel.
      if (what === 'n') {
        next.height = geometry.height - dy;
      }

      if (what === 'w') {
        next.width = geometry.width - dx;
      }

      if (what === 'e') {
        next.width = geometry.width + dx;
      }

      this.geometry = next;
      this.clamp();
    },

    endGrab() {
      if (!this.drag) {
        return;
      }

      this.drag = null;
      window.removeEventListener('mousemove', this.onDrag);
      window.removeEventListener('mouseup', this.endGrab);
      this.remember();
      window.dispatchEvent(new Event('resize'));
    },

    // -----------------------------------------------------------------------
    // The conversations
    // -----------------------------------------------------------------------

    /**
     * Ask the pod what conversations there are, and settle on one to show.
     *
     * The stored tab is a preference rather than state: it may have been ended from another
     * browser since it was written, so it is used only when the pod still reports it, and the
     * first conversation is the fallback rather than a blank pane.
     */
    async refresh() {
      this.loading = true;
      this.error = '';

      try {
        // Before the conversations, because starting a pane is what reads it: the pod writes
        // this person's kubeconfig on the way up, and a pane that got there first would be the
        // one running as nobody. It is not fatal - an agent with no Rancher identity can still
        // hold a conversation, and saying so beats refusing to open the panel - so the failure
        // is reported and the tabs load anyway.
        this.identity = await ensureAgentCredential().catch((e) => {
          this.error = `The agent has no Rancher identity: ${ e?.message || e }`;

          return '';
        });

        this.sessions = arrange(await panelSessions(), this.order);
      } finally {
        this.loading = false;
      }

      if (!this.sessions.length) {
        await this.startNew();

        return;
      }

      // The remembered tab wins until it has been honoured once. Preferring `this.active`
      // first meant an early refresh - one that ran before the session list arrived, so nothing
      // matched and the first tab was chosen - then wrote that choice back over the remembered
      // one, and a reload always came back on the first conversation.
      const stored = readDrawerState().active;
      const order = this.restoredTab ? [this.active, stored] : [stored, this.active];
      const wanted = order.find((id) => id && this.sessions.some((session) => session.id === id));

      if (wanted) {
        this.restoredTab = true;
      }

      this.select(wanted || this.sessions[0].id);
    },

    /**
     * Keep the status dots live while the panel is open.
     *
     * Only the dots, not the tab set: adding and removing tabs is what refresh, startNew and
     * closeSession do, and doing it from a background tick would tear a terminal down under
     * somebody mid-conversation. So this re-reads the states and writes them onto the tabs that
     * are already there, leaving `active`, `seen` and the mounted terminals untouched.
     */
    startPolling() {
      this.stopPolling();
      this.statesTimer = setInterval(() => this.pollStates(), STATES_POLL_MS);
    },

    stopPolling() {
      if (this.statesTimer) {
        clearInterval(this.statesTimer);
        this.statesTimer = null;
      }
    },

    async pollStates() {
      // A refresh is already reading the same thing; let it, rather than racing it.
      if (!this.open || this.loading) {
        return;
      }

      let fresh;

      try {
        fresh = await agentSessions();
      } catch {
        return; // The next tick asks again; a missed poll is a dot a few seconds stale.
      }

      const states = new Map(fresh.map((session) => [session.id, session]));

      this.sessions = this.sessions.map((session) => {
        const now = states.get(session.id);

        // A conversation the pod no longer reports has ended elsewhere; its dot goes quiet until
        // the next full refresh drops the tab.
        return now ? { ...session, title: now.title, state: now.state } : { ...session, state: 'none' };
      });
    },

    /** Show one conversation, mounting its terminal the first time. */
    select(id) {
      if (!id) {
        return;
      }

      this.active = id;

      if (!this.seen.includes(id)) {
        this.seen = [...this.seen, id];
      }

      this.remember();
    },

    /** Start another conversation. The pod picks the name; see startAgentSession for why. */
    /**
     * A new conversation, held with the CLI that was asked for.
     *
     * The id is carried on the tab, so the pane below is opened with it; after that the pane
     * itself remembers - shell.sh writes the CLI into the pane's record and reads it back when
     * nobody says, which is what makes a conversation reopened next week still its own CLI.
     */
    async startNew(cli = '') {
      this.error = '';

      try {
        const id = await startAgentSession();

        this.sessions = [...this.sessions, {
          id, title: conversationLabel(id), state: 'none', cli: cli === 'claude' ? '' : cli,
        }];
        this.select(id);
      } catch (e) {
        this.error = e?.message || String(e);
      }
    },

    /**
     * Fork one conversation from its tab's menu: a second tab with this one's turns behind it.
     *
     * The copy is selected the moment it exists, because that is the point of it - the original
     * keeps its tab untouched, and the one in front of you is the one to take somewhere else.
     * Nothing is sent into it: it comes up at a prompt with the history above it.
     *
     * Re-read from the pod rather than appended to the list by hand, the way `startNew` does:
     * the fork's title is the pod's (`forkTitle`, applied there), and this is a tab whose name
     * is the one thing about it worth reading.
     */
    async forkSession(id) {
      const source = this.byId(id);

      if (!source || this.forking) {
        return;
      }

      this.forking = id;
      this.error = '';

      try {
        const forked = await forkAgentSession(source);

        await this.refresh();
        this.select(forked);
      } catch (e) {
        this.error = e?.message || String(e);
      } finally {
        this.forking = '';
      }
    },

    /**
     * End one conversation: the tab, the tmux session and the transcript.
     *
     * Every route in comes here - the close control on the tab, and a middle click on it -
     * because they are the same act. The chord is not one of them: it hides the panel, which is
     * why the panel has no close control of its own and this one is per tab.
     */
    async closeSession(id) {
      if (!id) {
        return;
      }

      this.sessions = this.sessions.filter((session) => session.id !== id);
      this.seen = this.seen.filter((name) => name !== id);

      if (this.active === id) {
        this.active = this.sessions[0]?.id || '';
        this.remember();
      }

      try {
        await endAgentSession(id);
      } catch (e) {
        this.error = e?.message || String(e);
      }

      if (!this.sessions.length) {
        await this.startNew();
      }
    },



    // -----------------------------------------------------------------------
    // Naming
    // -----------------------------------------------------------------------

    /**
     * A conversation by id, for the tab header to draw.
     *
     * The strip knows a tab by its name, which is the conversation's id; everything the header
     * shows - the title, the dot, the CLI - is on the session.
     */
    byId(id) {
      return this.sessions.find((entry) => entry.id === id) || null;
    },

    /** A tab became the active one. The strip decides which; this records it. */
    onTabChanged({ tab }) {
      if (tab?.name) {
        this.select(tab.name);
      }
    },

    /**
     * A conversation renamed from its tab.
     *
     * Optimistic, then confirmed by a re-read: the name lives in the pod, so this is the one
     * place where what is on screen and what is true can differ, and the re-read is what closes
     * that rather than trusting the write.
     */
    async renameTo(id, title) {
      const session = this.sessions.find((entry) => entry.id === id);
      const wanted = (title || '').trim();

      if (!session || !wanted || wanted === session.title) {
        return;
      }

      session.title = wanted;

      try {
        await renameAgentSession(id, wanted);
        this.sessions = this.withRename(await panelSessions(), id, wanted);
      } catch (e) {
        this.error = e?.message || String(e);
      }
    },

    /**
     * The re-read, with the name we just wrote kept.
     *
     * The rename lands in the pod as a file operation and `agentSessions()` lists that
     * directory, and the two are not ordered: the listing that follows a successful rename can
     * still be the one from before it. Taking that answer literally put the old name back on
     * the tab for a poll or two before the next read agreed - the flicker.
     *
     * `renameAgentSession` having resolved is the stronger fact of the two, so it wins over a
     * listing that disagrees with it. A listing that agrees is unchanged by this, and a rename
     * that actually failed threw before ever reaching here.
     */
    withRename(sessions, id, title) {
      return sessions.map((session) => (session.id === id ? { ...session, title } : session));
    },

    // -----------------------------------------------------------------------
    // Keyboard, as Tabbed does it
    // -----------------------------------------------------------------------

  },
};
</script>

<template>
  <!--
    The admin check again, and not only on the key handler. A non-admin who reached this some
    other way gets nothing rendered rather than a terminal that would open into a cluster-admin
    ServiceAccount. See agent-overlay.ts for what this gate is and is not.
  -->
  <div
    v-if="open && admin"
    class="mc-agent"
    :class="[`mc-agent--${ placement }`, { 'mc-agent--dragging': !!drag }]"
    :style="frameStyle"
  >
    <!-- The one edge that resizes, per placement. -->
    <div
      v-if="placement === 'bottom'"
      class="mc-agent__grip mc-agent__grip--n"
      @mousedown="onGrab('n', $event)"
    />
    <div
      v-else-if="placement === 'left'"
      class="mc-agent__grip mc-agent__grip--e"
      @mousedown="onGrab('e', $event)"
    />
    <div
      v-else
      class="mc-agent__grip mc-agent__grip--w"
      @mousedown="onGrab('w', $event)"
    />

    <!--
      The conversations, as the product's one conversation strip.

      This panel used to draw its own: a flex row of tabs, with the status dot, the CLI mark,
      the rename and the close written out here because the shell's Tabbed renders a label as
      escaped text with no slot to put any of that in. The workspace page then hit the same wall
      and solved it the other way, by forking Tabbed and adding the slot - so the product had two
      conversation strips that looked and behaved differently depending on which half of it you
      were in.

      There is one now, and this is it: ConversationTabbed with ConversationTab in its
      `tab-header` slot, exactly as the workspace page mounts it. What differs between the two is
      the CONTEXT, which is all that should: this one is pointed at the agent pod (see agent.ts),
      the page's at that workspace's project.

      Dragging a tab along the row went with the old strip, and so did alt+left / alt+right: the
      strip owns its row's keys now, and a reorder that only half the product has is the thing
      this change is undoing. The order a browser already had is still honoured - `arrange` still
      sorts the sessions and the weights below carry that into the strip - it just cannot be
      changed by hand any more. If it should be, it goes in ConversationTabbed, once, for both.
    -->
    <ConversationTabbed
      class="mc-agent__tabbed"
      flat
      :default-tab="active"
      @changed="onTabChanged"
    >
      <template #tab-header="{ tab }">
        <ConversationTab
          v-if="byId(tab.name)"
          :conversation="byId(tab.name)"
          :agent="byId(tab.name).state || 'none'"
          :cli="byId(tab.name).cli || ''"
          :active="tab.active"
          :busy="forking === tab.name"
          :actions="['fork']"
          @rename="renameTo(tab.name, $event)"
          @fork="forkSession(tab.name)"
          @close="closeSession(tab.name)"
        />
      </template>
      <template #tab-row-extras>
        <!--
          New conversation, at the end of the tabs where a new one would appear. A split button:
          the press makes one with the CLI you usually use, and the caret is where the others
          are - the choice belongs here because a pane runs its CLI for life, so it is made when
          the conversation is, not afterwards in Settings.
        -->
        <li class="mc-agent__new">
          <SplitButton
            class="mc-agent__new-split"
            label="New conversation"
            :value="defaultCli"
            :options="CLI_CHOICES"
            @pick="startNew"
          >
            <SIcon
              name="plus"
              :size="14"
            />
          </SplitButton>
        </li>
        <!--
          Pushed to the right edge by `margin-left: auto`: however many conversations are open,
          the options button is where it was.
        -->
        <li class="mc-agent__end">
          <span
            v-if="loading"
            class="mc-agent__note"
          >Reading the pod</span>
          <span
            v-else-if="error"
            class="mc-agent__note mc-agent__note--error"
          >{{ error }}</span>

          <SMenu
            :items="menuItems"
            icon="more"
            :icon-size="12"
            aria-label="Agent panel options"
            @select="onMenu"
          />
        </li>
      </template>
      <!--
        Mounted on first visit and then kept: the strip hides an inactive panel with v-show
        rather than unmounting it, so coming back to a conversation is instant and its
        scrollback is intact, while one nobody has opened in this browser holds no exec socket
        at all.
      -->
      <Tab
        v-for="(session, i) in sessions"
        :key="session.id"
        :name="session.id"
        :label="session.title || 'Conversation'"
        :weight="sessions.length - i"
      >
        <PodTerminal
          v-if="seen.includes(session.id)"
          :session="session.id"
          :mode="session.cli || ''"
        />
      </Tab>
    </ConversationTabbed>
  </div>
</template>

<style lang="scss" scoped>
.mc-agent {
  position: fixed;
  // Above Rancher's header and its side nav, which sit in the low hundreds, and below the
  // dashboard's own modals, which is where a dialog somebody opened deliberately belongs.
  z-index: 900;
  display: flex;
  flex-direction: column;
  background: var(--terminal-bg, var(--body-bg));
  box-shadow: 0 0 18px var(--shadow, rgba(0, 0, 0, 0.25));

  // While an edge is being dragged the pointer moves faster than the layout, and a pointer that
  // lands on the terminal mid-drag would otherwise start selecting text in it.
  &--dragging {
    user-select: none;
    cursor: grabbing;
  }

  &--bottom {
    left: 0;
    right: 0;
    bottom: 0;
    border-top: 1px solid var(--border);
  }

  &--left {
    left: 0;
    top: 0;
    bottom: 0;
    border-right: 1px solid var(--border);
  }

  &--right {
    right: 0;
    top: 0;
    bottom: 0;
    border-left: 1px solid var(--border);
  }

  // The grips. Four pixels of hit area sitting over the edge, with no paint of their own so the
  // panel's own border stays the only line there is.
  &__grip {
    position: absolute;
    z-index: 2;

    &--n {
      top: -2px;
      left: 0;
      right: 0;
      height: 5px;
      cursor: ns-resize;
    }

    &--e {
      top: 0;
      bottom: 0;
      right: -2px;
      width: 5px;
      cursor: ew-resize;
    }

    &--w {
      top: 0;
      bottom: 0;
      left: -2px;
      width: 5px;
      cursor: ew-resize;
    }

  }




  // Outside the scroller, so it keeps its place at the right edge no matter how long the row is.
  /*
   * The strip fills the panel, and the terminal inside it fills the strip.
   *
   * Four elements stand between this box and the terminal - the strip's root, the fork's
   * `.tab-container`, the Tab's `[role=tabpanel]`, and the pane - and a flex box only hands its
   * height down through children that are themselves flex and allowed to shrink below their
   * content. `v-show` hides an inactive panel with an inline `display: none`, which beats these
   * rules, so making every panel a flex column does not unhide the ones behind it.
   */
  &__tabbed {
    display:        flex;
    flex-direction: column;
    flex:           1 1 auto;
    min-height:     0;
    // The fork sets `min-width: fit-content` on its own root, which makes the strip as wide as
    // the widest line in any pane. Both of these, for the reason WorkspaceRail's copy gives.
    min-width:      0;
    max-width:      100%;

    :deep(.tab-container) {
      display:        flex;
      flex-direction: column;
      flex:           1 1 auto;
      min-height:     0;
      min-width:      0;
      max-width:      100%;
      overflow:       hidden;
      padding:        0;
    }

    :deep([role='tabpanel']) {
      display:        flex;
      flex-direction: column;
      flex:           1 1 auto;
      min-height:     0;
      min-width:      0;
      max-width:      100%;
      overflow:       hidden;
    }
  }

  /*
   * The notes and the options button, at the right end of the tab row.
   *
   * It is an `li` in the strip's own row now rather than a box beside it, so `margin-left: auto`
   * is what pins it: however many conversations are open, it is where it was.
   */
  &__end {
    display: flex;
    align-items: center;
    flex: 0 0 auto;
    margin-left: auto;
    list-style: none;
    padding: 0 var(--studio-space-4, 4px);

    // The menu's trigger is one more control on this bar, so it is the same control: same box,
    // same glyph size, same corner, same centre line. SMenu's own trigger is sized for a
    // toolbar, and its icon size is a prop; the box is reached through :deep because it belongs
    // to that component.
    :deep(.s-menu__trigger) {
      width: 20px;
      height: 20px;
      padding: 0;
      justify-content: center;
      border-radius: var(--dev-r-xs);
    }
  }










  @keyframes mc-agent-dot-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
  }

  // New conversation, at the end of the tab row where a new tab would appear. The same bare-icon
  // treatment as the options button at the other end of the bar.
  /* The split button's own box: layout only. Its halves carry the look - see `main-class`. */
  /*
   * The two halves read as one control in this row.
   *
   * They were a 28px square and a bordered caret with a gap between them, which looked like two
   * unrelated glyphs rather than a button with a menu. Here: no borders (nothing else in the
   * tab row has one), the same height, and the caret narrow and quiet beside the press.
   */
  &__new-split {
    flex:       0 0 auto;
    align-self: center;
    margin-left: var(--dev-space-1);

    :deep(.split-btn__main),
    :deep(.split-btn__more) {
      height:        24px;
      min-height:    0;
      border:        none;
      background:    none;
      border-radius: var(--dev-r-xs);
      color:         var(--body-text);
      opacity:       .7;

      &:hover:not(:disabled) {
        opacity:    1;
        background: var(--default-hover-bg, var(--body-bg));
      }
    }

    :deep(.split-btn__main) { width: 22px; }

    :deep(.split-btn__more) {
      width:     14px;
      padding:   0;
      font-size: 9px;
    }
  }

  /* The + rides at the end of the conversations, as one more item in the strip's row. */
  &__new {
    display:     flex;
    align-items: center;
    list-style:  none;
  }


  &__note {
    padding: 0 var(--studio-space-8, 8px);
    max-width: 240px;
    color: var(--muted);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;

    &--error {
      color: var(--error);
    }
  }

  .tab-container {
    flex: 1 1 auto;
    min-height: 0;
    position: relative;

    // Rancher pads this by 20px and `--flat` takes it away. A terminal wants the whole box.
    &--flat {
      padding: 0;
    }

    > section {
      height: 100%;
    }
  }
}
</style>
