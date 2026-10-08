<script>
// The chat view of a pane: the same tmux session as the terminal, drawn as messages.
//
// Claude Code's own UI is a terminal one, and it is the one the agent runs in: the login, the
// permission prompts, the questions it asks, the surveys, all of it happens there and needs no
// OAuth of its own. This view does not replace that; it reads it. The transcript claude writes
// is what the messages come from, the pane's last lines are what the prompts come from, and
// what a person types or clicks here goes into the pane as keystrokes. Switching between this
// and the terminal (PodTerminal's toggle) changes nothing about the session.
//
// Reaching the pane: the same way the terminal does. The pane's argv says where it runs - in
// the pod this component is pointed at, or, when it starts with `kubectl exec`, in another pod
// that pod reaches - and every read and write here is a short exec along the same path.
//
// What is left in this file is the drawer's *skin*. Everything that is not drawn - reading the
// transcript, deriving what the conversation is doing, the send path, the queue, the pending
// messages, the questions, the subagents, the model options - moved to chat-conversation.ts,
// because the Focus deck's bar had to become a chat rather than a button that opens one, and
// there are only two other ways to do that: embed this whole component in a bar, which drags
// the drawer's layout onto it, or write the send path a second time, which drifts. There are
// four places in here that know what "claude has not recorded this message yet" means and two
// copies of them would disagree within a week. So: one conversation, two skins. See
// components/focus/FocusChatBar.vue for the other one.
//
// This component is also three slots now - `transcript`, `message` and `composer` - each
// defaulting to exactly the markup it drew before. A host that wants the same conversation in
// a different shape overrides one of them rather than forking the file.
import { useConversation, escapeText, CUSTOMIZE } from '../chat-conversation';
import { readLook, writeLook } from '../look';
import PodFileViewer from './PodFileViewer.vue';

export default {
  name: 'ChatPane',

  components: { PodFileViewer },

  props: {
    session:   { type: String, default: 'agent-1' },
    /**
     * A name for a different look, or '' for this component's own.
     *
     * The chat is one component in several places - a workspace's conversations, the panel's
     * drawer - and those places do not agree about what a conversation should look like.
     * Rather than fork it, the root carries `mc-chat--skin-<name>` and whoever wants a
     * different one ships a stylesheet for that class: nothing in here knows about any skin,
     * and a page that asks for none is byte-for-byte what it was.
     */
    skin:      { type: String, default: '' },
    mode:      { type: String, default: 'claude' },
    command:   { type: Array, default: null },
    findPod:   { type: Function, default: null },
    namespace: { type: String, required: true },
    container: { type: String, required: true },
    imageDir:  { type: String, default: '/workspace/.images' },
    home:      { type: String, default: '/workspace/.home' },
    label:     { type: String, default: 'the agent' },
  },

  emits: ['state', 'view'],

  /**
   * The conversation, and the two things this file renames on the way out.
   *
   * Spread first and overridden after, because a `setup` binding shadows a method of the same
   * name - Vue resolves setupState before ctx - so adjusting one means replacing the key here
   * rather than declaring a method beside it. `openManager` needs to bring the terminal
   * forward as well, and `pickCommand` is a method of this component that calls the
   * conversation's and then moves the caret, so the conversation's goes out under another name.
   */
  setup(props, { emit }) {
    const conversation = useConversation(() => ({
      session:   props.session,
      mode:      props.mode,
      command:   props.command,
      namespace: props.namespace,
      container: props.container,
      imageDir:  props.imageDir,
      home:      props.home,
      findPod:   props.findPod,
      label:     props.label,
      // The drawer's chat reads from the moment it is on screen, which is what it always did.
      enabled:   true,
    }));

    return {
      ...conversation,
      // `rendered` is what this template has always called the turns.
      rendered:        conversation.turns,
      pickCommandText: conversation.pickCommand,

      /**
       * Open one of claude's own managers, and go to the terminal, because that is where it is.
       *
       * `/permissions`, `/mcp`, `/memory` and the rest are full-screen pickers - keyboard-driven
       * terminal UIs, not prompts with options in them. Opening one from the chat drew nothing,
       * and since Escape is only offered while claude is working there was no way back either:
       * every message typed afterwards went into the picker instead of the conversation. The
       * terminal can drive them perfectly well, and switching to it is what somebody wanted when
       * they pressed the button. The chat is one keypress away again afterwards.
       */
      async openManager(name) {
        await conversation.openManager(name);
        // After the command, so the terminal opens on the manager rather than on the prompt.
        emit('view', 'terminal');
      },
    };
  },

  data() {
    return {
      openTools:      {},
      openThoughts:   {},
      openSummaries:  {},
      /** The path open in the viewer, and an image from the transcript itself, open large. */
      viewerPath:     '',
      viewerData:     '',
      /**
       * The "Mention file" picker: the checkout's files, read once per opening, and the filter.
       * What it inserts is `@path`, which claude resolves at submit the way typing it would.
       */
      files:          {
        open: false, list: [], filter: '', loading: false,
      },
      /**
       * How the log looks, kept per browser. Every one of these is a class on the root and
       * nothing else, so a preference is a line of CSS rather than a branch in the template.
       */
      look:           readLook(),
      notice:         '',
      noticeTimer:    null,
      hydrating:      false,
      atBottom:       true,
      mineIndex:      -1,
      /** Whether the list of subagents is open. */
      showAgents:     false,
      slashIndex:     0,
      slashDismissed: false,
      /** The skill a marked name was clicked on, and what has been read about each. */
      details:        null,
      detailsCache:   {},
      /** Which menu is open. */
      menu:           '',
      focused:        false,
      /** A touch screen, which is the only place the caret keys are worth the room. */
      coarse:         typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches,
    };
  },

  computed: {
    /** The menu is open while a name is still being typed and there is something to offer. */
    slashOpen() {
      return !!this.slashSpot && !this.slashDismissed && this.slashMatches.length > 0;
    },

    /** The Customize section of the command menu: claude's own pickers, by slash command. */
    customize() {
      return CUSTOMIZE;
    },

    fileMatches() {
      const q = this.files.filter.trim().toLowerCase();
      const list = q ? this.files.list.filter((f) => f.toLowerCase().includes(q)) : this.files.list;

      return list.slice(0, 40);
    },

    lookToggles() {
      return [
        { key: 'bubbles', label: 'Your messages in a bubble' },
        { key: 'thoughts', label: 'Thinking open by default' },
        { key: 'toolIo', label: 'Tool input and output open by default' },
        { key: 'times', label: 'Show times' },
      ];
    },
  },

  watch: {
    // A new name being typed starts the menu at the top again, and un-dismisses it: Escape
    // hides the menu for the command being typed, not for the rest of the session.
    //
    // The box is also sized from here rather than from the input handler, so a message put in
    // from somewhere else - a queued prompt, a paste, the box cleared after a send - sizes it
    // too. See autoGrow.
    draft(now, before) {
      this.slashIndex = 0;
      if (!now.startsWith('/') || now.slice(0, 1) !== before.slice(0, 1)) {
        this.slashDismissed = false;
      }
      this.$nextTick(this.autoGrow);
    },

    /**
     * New transcript landed, or a different transcript did.
     *
     * The conversation counts both rather than telling anybody where to scroll - it draws
     * nothing and holds no refs. A log stays at the bottom only while the person is already
     * there, so reading back is not interrupted; a restart - the first load, a different
     * conversation, a subagent tab - goes to the bottom unconditionally, because that is where
     * the conversation is.
     */
    grew() {
      this.$nextTick(() => this.scrollToEnd());
    },

    restarted() {
      this.mineIndex = -1;
      this.atBottom = true;
      this.$nextTick(() => this.scrollToEnd(true));
    },

    /**
     * A message just sent, which is drawn the moment it is sent rather than when the transcript
     * catches up with it. It goes to the bottom wherever the person was reading, without waiting
     * for the poll that `grew` counts - that is half a second behind the message.
     */
    'pending.length'(now, before) {
      if (now > before) {
        this.$nextTick(() => this.scrollToEnd(true));
      }
    },

    /** The working row is one more row at the bottom, and it arrives between polls too. */
    working(now) {
      if (now) {
        this.$nextTick(() => this.scrollToEnd());
      }
    },

    /** Every poll, not only on a change: this is what PodTerminal's status line reads. */
    polledAt() {
      this.$emit('state', this.attached ? 'open' : 'waiting');
    },

    /** Focus it, so Esc closes it without a click first. */
    panel(now) {
      if (now) {
        this.$nextTick(() => document.querySelector('.mc-chat__lightbox--panel')?.focus());
      }
    },
  },

  mounted() {
    // Anything typed into this pane and not yet recorded, from a previous visit - which the
    // box has to be sized for before it is seen.
    this.$nextTick(this.autoGrow);
  },

  updated() {
    this.hydrate();
  },

  beforeUnmount() {
    clearTimeout(this.noticeTimer);
  },

  methods: {
    /* ── The log: where it is scrolled, and what is open in it ───────────────────────────── */

    scrollToEnd(force = false) {
      const el = this.$refs.log;

      if (el && (force || this.atBottom)) {
        el.scrollTop = el.scrollHeight;
        this.atBottom = true;
      }
    },

    onScroll() {
      const el = this.$refs.log;

      this.atBottom = !!el && el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    },

    /** Your own messages, one at a time, in either direction: to find the one you are after. */
    stepMine(direction) {
      const mine = [...(this.$refs.log?.querySelectorAll('.mc-chat__msg--user') || [])];

      if (!mine.length) {
        return;
      }
      const next = this.mineIndex < 0 ? (direction > 0 ? 0 : mine.length - 1) : Math.min(mine.length - 1, Math.max(0, this.mineIndex + direction));

      this.mineIndex = next;
      mine.forEach((el) => el.classList.remove('mc-chat__msg--found'));
      mine[next].classList.add('mc-chat__msg--found');
      mine[next].scrollIntoView({ block: 'center', behavior: 'smooth' });
      this.atBottom = false;
    },

    toggleSummary(key) {
      this.openSummaries = { ...this.openSummaries, [key]: !this.openSummaries[key] };
    },

    toggleTool(id) {
      this.openTools = { ...this.openTools, [id]: !this.toolOpen(id) };
    },

    toolOpen(id) {
      return id in this.openTools ? this.openTools[id] : this.look.toolIo;
    },

    toggleThought(key) {
      this.openThoughts = { ...this.openThoughts, [key]: !this.thoughtOpen(key) };
    },

    thoughtOpen(key) {
      return key in this.openThoughts ? this.openThoughts[key] : this.look.thoughts;
    },

    setLook(key, value) {
      this.look = { ...this.look, [key]: value };
      writeLook(this.look);
    },

    flash(text) {
      this.notice = text;
      clearTimeout(this.noticeTimer);
      this.noticeTimer = setTimeout(() => {
        this.notice = '';
      }, 5000);
    },

    /* ── The box: its size, its caret, and the layer that marks command names ────────────── */

    /**
     * Size the box to what is in it, up to the maximum the stylesheet sets.
     *
     * Height to `auto` first, or scrollHeight only ever reports the height it already has and
     * the box grows and never shrinks. Driven by a watcher on the draft rather than by the
     * input handler, so a message put in from somewhere else - a queued prompt, a paste, the
     * box being cleared after a send - sizes it too.
     */
    autoGrow() {
      const el = this.$refs.box;

      if (!el) {
        return;
      }
      el.style.height = 'auto';
      el.style.height = `${ el.scrollHeight }px`;
    },

    /** The layer follows the box when the box scrolls. */
    syncGhost() {
      const ghost = this.$refs.ghost;
      const box = this.$refs.box;

      if (ghost && box) {
        ghost.scrollTop = box.scrollTop;
      }
    },

    /** Where the cursor is, after anything that could have moved it. */
    syncCaret(event) {
      const box = event?.target || this.$refs.box;

      this.caret = box?.selectionStart ?? this.draft.length;
      this.$nextTick(() => this.syncGhost());
    },

    /**
     * Move the caret in the message box, which a thumb cannot do.
     *
     * `@mousedown.prevent` on the button is what makes it work at all: without it the box loses
     * focus on the press, the selection collapses, and the arrow moves a caret that is no
     * longer anywhere.
     */
    moveCaret(by) {
      const box = this.$refs.box;

      if (!box) {
        return;
      }
      const at = Math.max(0, Math.min(box.value.length, (box.selectionStart ?? 0) + by));

      box.focus();
      box.setSelectionRange(at, at);
    },

    /* ── The command menu ────────────────────────────────────────────────────────────────── */

    /** The `/` button: the command menu, opened the way typing a slash opens it. */
    openCommandMenu() {
      this.menu = '';
      this.slashDismissed = false;
      if (!this.draft.startsWith('/')) {
        this.draft = `/${ this.draft }`;
      }
      this.slashIndex = 0;
      this.$nextTick(() => this.$refs.box?.focus());
      if (!this.mcp.read && !this.mcp.loading) {
        this.readMcp();
      }
    },

    toggleMenu(kind) {
      this.menu = this.menu === kind ? '' : kind;
    },

    moveSlash(direction) {
      const n = this.slashMatches.length;

      this.slashIndex = n ? (this.slashIndex + direction + n) % n : 0;
    },

    /** Put a command in the box in place of the name being typed, ready for its argument. */
    pickCommand(item) {
      const at = this.pickCommandText(item);

      this.slashIndex = 0;
      this.$nextTick(() => {
        const box = this.$refs.box;

        box?.focus();
        box?.setSelectionRange?.(at, at);
      });
    },

    onKeydown(event) {
      // While the typeahead is open it owns the keys that move and choose. Enter picks the
      // highlighted command rather than sending, which is the one place this changes what a
      // key already did - and only while a menu is visibly open under the box.
      if (this.slashOpen) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          this.moveSlash(event.key === 'ArrowDown' ? 1 : -1);

          return;
        }
        if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey && !event.isComposing)) {
          event.preventDefault();
          this.pickCommand(this.slashMatches[this.slashIndex] || this.slashMatches[0]);

          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          this.slashDismissed = true;

          return;
        }
      }

      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        this.send();
      }
    },

    /** A click on a marked name: what does that skill do? */
    async onGhostClick(event) {
      const name = event?.target?.dataset?.name;

      if (!name) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const found = this.commands.find((c) => c.name.toLowerCase() === name.toLowerCase());

      if (!found) {
        return;
      }
      this.details = { ...found, about: this.detailsCache[found.name] ?? '' };
      if (this.detailsCache[found.name] !== undefined || !found.path) {
        return;
      }
      // The first lines of the file: a skill's frontmatter says what it is for, and a command's
      // first paragraph is the same thing by another name.
      const about = await this.readAbout(found);

      this.detailsCache = { ...this.detailsCache, [found.name]: about };
      if (this.details?.name === found.name) {
        this.details = { ...this.details, about };
      }
    },

    /* ── The menus that act ──────────────────────────────────────────────────────────────── */

    /**
     * A menu action that is a slash command: the menu out of the way, then sent as typed.
     *
     * It was called `command`, which is also the name of this component's `command` prop - and
     * props resolve before methods, so `command('/compact')` was `null('/compact')`. Compact,
     * Clear, Account & usage and Status threw on every click for as long as that was true.
     */
    async runCommand(text) {
      this.menu = '';
      await this.sendCommand(text);
    },

    async clearConversation() {
      this.menu = '';
      // eslint-disable-next-line no-alert
      if (!window.confirm('Clear this conversation? claude forgets everything said so far.')) {
        return;
      }
      await this.sendCommand('/clear');
    },

    async setOption(kind, value) {
      this.menu = '';
      await this.applyOption(kind, value);
    },

    /** Files chosen with the Attach button: images shrink as pasted ones do. */
    attachPicked(event) {
      for (const picked of [...(event.target.files || [])]) {
        this.attachImage(picked);
      }
      event.target.value = '';
      this.$nextTick(() => this.$refs.box?.focus());
    },

    /** The checkout's files, for the mention picker. */
    async openFiles() {
      this.menu = '';
      this.files = {
        ...this.files, open: true, loading: true, filter: '',
      };
      this.$nextTick(() => this.$refs.fileFilter?.focus());
      try {
        this.files = { ...this.files, list: await this.readFiles(), loading: false };
      } catch (e) {
        this.files = { ...this.files, loading: false };
        this.error = e.message || String(e);
      }
    },

    pickFile(path) {
      this.mention(path);
      this.files = { ...this.files, open: false };
      this.$nextTick(() => this.$refs.box?.focus());
    },

    /* ── The pictures and the paths in what was said ─────────────────────────────────────── */

    /** An image pasted or dropped: into the pod beside the pane, its path into the draft. */
    onPaste(event) {
      const items = [...(event.clipboardData?.items || [])].filter((i) => i.kind === 'file' && i.type.startsWith('image/'));

      if (!items.length) {
        return;
      }
      event.preventDefault();
      items.forEach((item) => this.attachImage(item.getAsFile()));
    },

    onDrop(event) {
      const dropped = [...(event.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));

      if (!dropped.length) {
        return;
      }
      event.preventDefault();
      dropped.forEach((one) => this.attachImage(one));
    },

    /** Thumbnails for every media placeholder the log has not filled in yet, one after another. */
    async hydrate() {
      if (this.hydrating || !this.$refs.log) {
        return;
      }
      const waiting = [...this.$refs.log.querySelectorAll('.mc-chat__media:not([data-done])')];

      if (!waiting.length) {
        return;
      }
      this.hydrating = true;
      try {
        for (const el of waiting) {
          const path = el.dataset.path;
          const kind = el.dataset.kind;

          el.dataset.done = '1';
          if (kind === 'video') {
            el.innerHTML = '<span class="mc-chat__chip" title="Open the recording">&#9654;</span>';
            continue;
          }
          this.fill(el, path, await this.thumbFor(path));
        }
      } finally {
        this.hydrating = false;
      }
      // Thumbnails change the height; stay at the bottom if that is where the person was.
      this.scrollToEnd();
      if (this.$refs.log?.querySelector('.mc-chat__media:not([data-done])')) {
        this.hydrate();
      }
    },

    fill(el, path, data) {
      if (data === 'missing') {
        el.innerHTML = '<span class="mc-chat__chip mc-chat__chip--missing" title="Not in the workspace">&#10005;</span>';
      } else if (data === 'large') {
        el.innerHTML = '<span class="mc-chat__chip" title="Open the image">&#128444;</span>';
      } else {
        el.innerHTML = `<img class="mc-chat__thumb" src="${ data }" alt="" title="Open ${ escapeText(path) }">`;
      }
    },

    /** A click on a path or a thumbnail: the viewer, or a word about a file that is not there. */
    async onLogClick(event) {
      const hit = event.target.closest('[data-path]');

      if (!hit) {
        return;
      }
      event.preventDefault();
      const path = hit.dataset.path;

      try {
        if (!await this.pathExists(path)) {
          this.flash(`${ path } is not in the workspace (any more).`);

          return;
        }
        this.viewerPath = path;
      } catch (e) {
        this.flash(e.message || String(e));
      }
    },

    /** The panel modal: closed by its button or by Esc. */
    onPanelKey(event) {
      if (event.key === 'Escape') {
        this.panel = null;
      }
    },
  },
};
</script>

<template>
  <div
    class="mc-chat"
    :data-phase="state.phase"
    :data-hook="hook ? hook.event + (hook.notification ? ':' + hook.notification : '') : ''"
    :data-polled="polledAt"
    :data-entries="entries.length"
    :data-file="file"
    :class="[`mc-chat--${ look.size }`, `mc-chat--${ look.density }`, skin ? `mc-chat--skin-${ skin }` : '', { 'mc-chat--flat': !look.bubbles, 'mc-chat--no-times': !look.times }]"
    @drop="onDrop"
    @dragover.prevent
  >
    <!--
      The subagents this conversation launched, behind one button: the ones still writing
      first, each with the first line of the last thing it said. Picking one shows its whole
      transcript here in place of the main conversation.
    -->
    <div
      v-if="agents.length"
      class="mc-chat__pick"
    >
      <button
        type="button"
        class="mc-chat__pick-btn"
        :class="{ 'mc-chat__pick-btn--open': showAgents }"
        @click="showAgents = !showAgents"
      >
        {{ showAgents ? '▾' : '▸' }} {{ agents.length }} subagent{{ agents.length === 1 ? '' : 's' }}<template v-if="workingAgents"> · {{ workingAgents }} working</template>
      </button>
      <span
        v-if="view !== 'main'"
        class="mc-chat__pick-current"
      >showing: {{ (agents.find((a) => a.id === view) || {}).description || view }}</span>
      <button
        v-if="view !== 'main'"
        type="button"
        class="mc-chat__link"
        @click="show('main')"
      >
        back to main
      </button>
    </div>
    <div
      v-if="agents.length && showAgents"
      class="mc-chat__agents"
    >
      <button
        v-for="a in agentRows"
        :key="a.id"
        type="button"
        class="mc-chat__agent"
        :class="{ 'mc-chat__agent--on': view === a.id, 'mc-chat__agent--working': a.working }"
        @click="show(a.id); showAgents = false"
      >
        <span class="mc-chat__agent-dot" />
        <span class="mc-chat__agent-name">{{ a.description }}</span>
        <span class="mc-chat__agent-last">{{ a.last || (a.working ? 'working' : 'nothing said yet') }}</span>
        <span class="mc-chat__agent-when">{{ a.when }}</span>
      </button>
    </div>
    <!--
      The conversation, as a slot.
      
      What is handed out is what it takes to draw one: the turns with their HTML and their
      tool rows already worked out, whether claude is mid-turn, and what it says it is doing.
      A host overriding this brings its own scroller, which is why `scrollToEnd` and
      `stepMine` both tolerate `$refs.log` not being there.
    -->
    <slot
      name="transcript"
      :turns="rendered"
      :working="working"
      :status="pane.status"
    >
    <div
      ref="log"
      class="mc-chat__log"
      @click="onLogClick"
      @scroll.passive="onScroll"
    >
      <p
        v-if="!messages.length && !error"
        class="mc-chat__empty"
      >
        <template v-if="!attached">Nothing is running in this conversation yet. Say something to start it.</template>
        <template v-else-if="!file">Waiting for the conversation to begin.</template>
        <template v-else>Nothing has been said yet.</template>
      </p>
      <template
        v-for="m in rendered"
        :key="m.key"
      >
        <!--
          One turn, as a slot: who said it, what they said, what it did, and what came back.
          A host that draws turns differently - bubbles in a bar, say - replaces this and
          keeps everything else, including the reconciling that decides whether a message is
          `queued`, `inQueue` or `failed`.
        -->
        <slot
          name="message"
          :turn="m"
          :when="when"
        >
          <div
            class="mc-chat__msg"
            :class="[`mc-chat__msg--${ m.role }`, { 'mc-chat__msg--queued': m.queued }]"
          >
        <div class="mc-chat__meta">
          <span class="mc-chat__who">{{ m.role === 'user' ? 'You' : m.role === 'summary' ? 'Summary' : m.role === 'note' ? 'Claude Code' : 'Claude' }}</span>
          <span class="mc-chat__when">{{ m.failed ? 'not recorded' : m.queued ? 'queued' : when(m.at) }}</span>
          <!--
            Said, rather than shown as an ordinary message, because it is not in the
            conversation yet: claude is mid-turn and has this waiting in its input queue. It
            turns into a normal message the moment the transcript records it.
          -->
          <span
            v-if="m.failed"
            class="mc-chat__queued-note mc-chat__queued-note--failed"
            title="Nothing claude writes down mentions this message - not the transcript, not its input queue, not the submit hook. Usually the paste into the pane did not land."
          >claude has no record of this ·
            <button
              type="button"
              class="mc-chat__link"
              @click="resend(m)"
            >send again</button></span>
          <span
            v-else-if="m.inQueue"
            class="mc-chat__queued-note"
            title="In claude's input queue: it starts on this when the current turn ends"
          >in claude's queue</span>
          <span
            v-else-if="m.queued"
            class="mc-chat__queued-note"
            title="Sent; waiting for claude to record it"
          >sending</span>
          <button
            v-if="m.role === 'summary'"
            type="button"
            class="mc-chat__link"
            @click="toggleSummary(m.key)"
          >
            {{ openSummaries[m.key] ? 'Hide' : 'Show' }}
          </button>
        </div>
        <!-- A compact's summary: the conversation so far, folded. Shown on request. -->
        <div
          v-if="m.role === 'summary' && !openSummaries[m.key]"
          class="mc-chat__body mc-chat__summary-line"
        >
          {{ firstLine(m.text) }}
        </div>
        <div
          v-if="m.thinking"
          class="mc-chat__thought"
        >
          <button
            type="button"
            class="mc-chat__disclose"
            @click="toggleThought(m.key)"
          >
            {{ thoughtOpen(m.key) ? '▾' : '▸' }} Thinking
          </button>
          <pre
            v-if="thoughtOpen(m.key)"
            class="mc-chat__pre"
          >{{ m.thinking }}</pre>
        </div>
        <div
          v-if="(m.role === 'assistant' || m.role === 'note' || (m.role === 'summary' && openSummaries[m.key])) && m.html"
          class="mc-chat__body mc-chat__md"
          v-html="m.html"
        />
        <div
          v-else-if="m.role === 'user'"
          class="mc-chat__body mc-chat__user-text"
          v-html="m.html"
        />
        <ul
          v-if="m.images.length"
          class="mc-chat__images"
        >
          <li
            v-for="(image, i) in m.images"
            :key="`${ i }-${ image.slice(0, 40) }`"
          >
            <img
              v-if="image.startsWith('data:')"
              :src="image"
              class="mc-chat__shot"
              alt="attached image"
              @click="viewerData = image"
            >
            <template v-else>🖼 {{ image }}</template>
          </li>
        </ul>
        <div
          v-for="t in m.toolRows"
          :key="t.id"
          class="mc-chat__tool"
          :class="{ 'mc-chat__tool--error': t.resultIsError, 'mc-chat__tool--pending': t.result === undefined }"
        >
          <button
            type="button"
            class="mc-chat__disclose"
            :aria-expanded="toolOpen(t.id) ? 'true' : 'false'"
            @click="toggleTool(t.id)"
          >
            <span class="mc-chat__tool-name">{{ t.name }}</span>
            <span
              class="mc-chat__tool-summary"
              v-html="t.summaryHtml"
            />
            <span
              v-if="t.result === undefined"
              class="mc-chat__tool-state"
            >…</span>
          </button>
          <div
            v-if="toolOpen(t.id)"
            class="mc-chat__tool-detail"
          >
            <span class="mc-chat__io">IN</span>
            <pre class="mc-chat__pre">{{ JSON.stringify(t.input, null, 2) }}</pre>
            <span
              v-if="t.result !== undefined"
              class="mc-chat__io"
            >OUT</span>
            <pre
              v-if="t.result !== undefined"
              class="mc-chat__pre mc-chat__pre--result"
            >{{ t.result.slice(0, 6000) }}{{ t.result.length > 6000 ? '\n…' : '' }}</pre>
          </div>
          <!-- An image the tool returned is worth seeing without opening the row. -->
          <div
            v-if="t.images && t.images.length"
            class="mc-chat__shots"
          >
            <img
              v-for="(image, i) in t.images"
              :key="i"
              :src="image"
              class="mc-chat__shot"
              alt="image the tool returned"
              @click="viewerData = image"
            >
          </div>
        </div>
          </div>
        </slot>
      </template>
      <!-- Working: said where the next message will appear, moving, so it reads as happening. -->
      <div
        v-if="working"
        class="mc-chat__msg mc-chat__msg--assistant mc-chat__working"
      >
        <span class="mc-chat__dots"><i /><i /><i /></span>
        <span class="mc-chat__shimmer">{{ pane.status || 'Working' }}</span>
        <button
          type="button"
          class="mc-chat__link"
          @click="stop"
        >
          Stop
        </button>
      </div>
    </div>
    </slot>

    <div
      v-if="notice"
      class="mc-chat__notice"
    >
      {{ notice }}
    </div>


    <Teleport to="body">
      <PodFileViewer
        v-if="viewerPath && media"
        :pod="media.pod"
        :path="viewerPath"
        :container="media.container"
        :namespace="media.namespace"
        :home="media.home"
        @close="viewerPath = ''"
      />
      <div
        v-if="panel"
        class="mc-chat__lightbox mc-chat__lightbox--panel"
        role="dialog"
        :aria-label="panel.title"
        tabindex="-1"
        @click.self="panel = null"
        @keydown="onPanelKey"
      >
        <div class="mc-chat__panel">
          <div class="mc-chat__panel-head">
            <span class="mc-chat__panel-title">{{ panel.title }}</span>
            <button
              type="button"
              class="mc-chat__pill"
              title="Close (Esc)"
              @click="panel = null"
            >
              Close
            </button>
          </div>
          <pre class="mc-chat__panel-text">{{ panel.text }}</pre>
        </div>
      </div>
      <div
        v-if="viewerData"
        class="mc-chat__lightbox"
        role="dialog"
        aria-label="Image"
        @click="viewerData = ''"
      >
        <img
          :src="viewerData"
          alt="image"
        >
      </div>
    </Teleport>

    <!-- What the pane is asking, when it is asking something a text box cannot answer. -->
    <div
      v-if="pane.dialog"
      class="mc-chat__dialog"
    >
      <div
        v-if="pane.dialog.header"
        class="mc-chat__dialog-header"
      >{{ pane.dialog.header }}</div>
      <pre
        v-if="pane.dialog.prompt"
        class="mc-chat__dialog-prompt"
      >{{ pane.dialog.prompt }}</pre>
      <div
        v-if="pane.dialog.kind === 'options' || pane.dialog.kind === 'yes-no'"
        class="mc-chat__options"
      >
        <button
          v-for="o in pane.dialog.options"
          :key="o.key"
          type="button"
          class="mc-chat__option"
          :class="{ 'mc-chat__option--selected': o.selected }"
          :title="o.description || ''"
          @click="choose(o)"
        >
          <span class="mc-chat__option-key">{{ o.key }}</span> {{ o.label }}
          <span
            v-if="o.description"
            class="mc-chat__option-desc"
          >{{ o.description }}</span>
        </button>
      </div>
      <div
        v-else
        class="mc-chat__login"
      >
        <a
          v-if="pane.dialog.url"
          :href="pane.dialog.url"
          target="_blank"
          rel="noopener noreferrer"
          class="mc-chat__option"
        >Open the sign-in page</a>
        <div class="mc-chat__code">
          <input
            v-model="code"
            type="text"
            placeholder="Paste the code here"
            @keydown.enter.prevent="submitCode"
          >
          <button
            type="button"
            class="mc-chat__option"
            @click="submitCode"
          >
            Send
          </button>
        </div>
      </div>
    </div>

    <!--
      One row between the conversation and the box: what the pane is doing on the left, the ways
      of getting around it on the right.

      These were two full-width rows stacked, each with its own padding and - because one was
      inset 18px and the other by the gutter - neither lined up with the box under them or the
      conversation above. The two say different kinds of thing but neither fills a row, and the
      space they took between the transcript and the box was most of what made this view feel
      loose at the bottom.
    -->
    <div class="mc-chat__footer">
      <div class="mc-chat__status">
        <span v-if="error" class="mc-chat__error">{{ error }}</span>
        <template v-else-if="pasting">{{ pasting }}</template>
        <template v-else-if="working" />
        <template v-else-if="!attached">Not running</template>
        <template v-else-if="pane.gone">
          Claude is not running in this pane.
          <button
            type="button"
            class="mc-chat__link"
            @click="login"
          >
            /login
          </button>
        </template>
        <template v-else-if="state.phase === 'waiting'">
          {{ pane.status || 'Claude is waiting for you' }}
          <button
            type="button"
            class="mc-chat__link"
            title="Answer it in the terminal"
            @click="$emit('view', 'terminal')"
          >
            open the terminal
          </button>
        </template>
        <template v-else>{{ pane.status || 'Ready' }}<template v-if="state.cost && state.cost.totalCostUSD"> · ${{ state.cost.totalCostUSD.toFixed(2) }} this session</template></template>
      </div>
      <!--
        Getting around: the caret, your messages one by one, and the bottom.

        The caret keys are here rather than on the composer's own row because this is the row of
        things that move you around, and they are two more of those. The terminal's key bar -
        Esc, Tab, Ctrl, home, end, word-delete - is for driving a TUI and is hidden in this view
        (see PodTerminal); what a text box actually wants on a phone is a way to put the caret
        back one character to fix a typo, which is these two and nothing else.

        `@mousedown.prevent` is what makes them work at all: without it the box loses focus on
        the press, the selection collapses, and the arrow moves a caret that is no longer there.
      -->
      <div class="mc-chat__nav">
        <template v-if="coarse">
          <button
            type="button"
            class="mc-chat__navbtn mc-chat__navbtn--caret"
            title="Move the cursor left"
            @mousedown.prevent
            @click="moveCaret(-1)"
          >
            &#8592;
          </button>
          <button
            type="button"
            class="mc-chat__navbtn mc-chat__navbtn--caret"
            title="Move the cursor right"
            @mousedown.prevent
            @click="moveCaret(1)"
          >
            &#8594;
          </button>
        </template>
        <button
          type="button"
          class="mc-chat__navbtn"
          title="Your previous message"
          @click="stepMine(-1)"
        >
          &#8593; mine
        </button>
        <button
          type="button"
          class="mc-chat__navbtn"
          title="Your next message"
          @click="stepMine(1)"
        >
          &#8595; mine
        </button>
        <button
          v-if="!atBottom"
          type="button"
          class="mc-chat__navbtn mc-chat__navbtn--bottom"
          title="Jump to the bottom"
          @click="scrollToEnd(true)"
        >
          &#8681; bottom
        </button>
      </div>
    </div>

    <!--
      The model picker, with Effort as a row inside it rather than as a control of its own -
      "when the current model supports effort levels, the picker also shows an Effort row". It
      is a property of the model, and a second button on the bar for it said otherwise.
    -->
    <div
      v-if="menu === 'actions'"
      class="mc-chat__menu mc-chat__menu--actions"
    >
      <p class="mc-chat__menu-head">
        Context
      </p>
      <button
        type="button"
        class="mc-chat__menu-item"
        @click="$refs.filePick.click(); menu = ''"
      >
        <span class="mc-chat__menu-name">Attach file…</span>
        <span class="mc-chat__menu-note">uploaded to the pod, path put in the message</span>
      </button>
      <button
        type="button"
        class="mc-chat__menu-item"
        @click="openFiles"
      >
        <span class="mc-chat__menu-name">Mention file from this project…</span>
        <span class="mc-chat__menu-note">@path</span>
      </button>
      <button
        type="button"
        class="mc-chat__menu-item"
        @click="runCommand('/compact')"
      >
        <span class="mc-chat__menu-name">Compact conversation</span>
        <span class="mc-chat__menu-note">/compact</span>
      </button>
      <button
        type="button"
        class="mc-chat__menu-item"
        @click="clearConversation"
      >
        <span class="mc-chat__menu-name">Clear conversation</span>
        <span class="mc-chat__menu-note">/clear</span>
      </button>
      <button
        type="button"
        class="mc-chat__menu-item"
        @click="openManager('rewind')"
      >
        <span class="mc-chat__menu-name">Rewind…</span>
        <span class="mc-chat__menu-note">in the terminal</span>
      </button>
      <p class="mc-chat__menu-head">
        Model
      </p>
      <button
        type="button"
        class="mc-chat__menu-item"
        @click="menu = 'model'"
      >
        <span class="mc-chat__menu-name">Switch model…</span>
        <span class="mc-chat__menu-note">{{ options.model || state.model }}<template v-if="options.effort"> · {{ options.effort }}</template></span>
      </button>
      <button
        type="button"
        class="mc-chat__menu-item"
        :disabled="thinking === null || optionBusy === 'thinking'"
        @click="toggleThinking"
      >
        <span class="mc-chat__menu-name">Thinking</span>
        <span class="mc-chat__menu-note">{{ thinking === null ? '…' : thinking ? 'on' : 'off' }}</span>
      </button>
      <p class="mc-chat__menu-head">
        Account
      </p>
      <button
        type="button"
        class="mc-chat__menu-item"
        @click="runCommand('/usage')"
      >
        <span class="mc-chat__menu-name">Account &amp; usage</span>
        <span class="mc-chat__menu-note">/usage<template v-if="state.cost && state.cost.totalCostUSD"> · ${{ state.cost.totalCostUSD.toFixed(2) }} this session</template></span>
      </button>
      <button
        type="button"
        class="mc-chat__menu-item"
        @click="runCommand('/status')"
      >
        <span class="mc-chat__menu-name">Status</span>
        <span class="mc-chat__menu-note">/status</span>
      </button>
      <p class="mc-chat__menu-head">
        Appearance
      </p>
      <div class="mc-chat__look">
        <span class="mc-chat__look-label">Text</span>
        <button
          v-for="v in ['small', 'medium', 'large']"
          :key="v"
          type="button"
          class="mc-chat__effort"
          :class="{ 'mc-chat__effort--on': look.size === v }"
          @click="setLook('size', v)"
        >
          {{ v }}
        </button>
      </div>
      <div class="mc-chat__look">
        <span class="mc-chat__look-label">Files</span>
        <button
          v-for="v in ['rendered', 'raw']"
          :key="v"
          type="button"
          class="mc-chat__effort"
          :class="{ 'mc-chat__effort--on': look.files === v }"
          :title="v === 'rendered' ? 'Markdown rendered, code and diffs highlighted' : 'The bytes as they are'"
          @click="setLook('files', v)"
        >
          {{ v }}
        </button>
      </div>
      <div class="mc-chat__look">
        <span class="mc-chat__look-label">Spacing</span>
        <button
          v-for="v in ['compact', 'comfortable']"
          :key="v"
          type="button"
          class="mc-chat__effort"
          :class="{ 'mc-chat__effort--on': look.density === v }"
          @click="setLook('density', v)"
        >
          {{ v }}
        </button>
      </div>
      <button
        v-for="t in lookToggles"
        :key="t.key"
        type="button"
        class="mc-chat__menu-item"
        @click="setLook(t.key, !look[t.key])"
      >
        <span class="mc-chat__menu-tick">{{ look[t.key] ? '✓' : '' }}</span>
        <span class="mc-chat__menu-name">{{ t.label }}</span>
      </button>
    </div>
    <div
      v-if="files.open"
      class="mc-chat__menu mc-chat__menu--files"
    >
      <p class="mc-chat__menu-head">
        Mention a file<span class="mc-chat__menu-note">{{ files.loading ? 'reading the checkout…' : `${ files.list.length } files` }}</span>
      </p>
      <input
        ref="fileFilter"
        v-model="files.filter"
        type="text"
        class="mc-chat__file-filter"
        placeholder="Filter by path"
        @keydown.escape.prevent="files.open = false"
        @keydown.enter.prevent="fileMatches[0] && pickFile(fileMatches[0])"
      >
      <button
        v-for="f in fileMatches"
        :key="f"
        type="button"
        class="mc-chat__menu-item mc-chat__menu-item--file"
        @click="pickFile(f)"
      >
        <span class="mc-chat__menu-name">{{ f }}</span>
      </button>
      <p
        v-if="!files.loading && !fileMatches.length"
        class="mc-chat__menu-note mc-chat__menu-empty"
      >
        Nothing matches.
      </p>
    </div>
    <div
      v-if="menu === 'model'"
      class="mc-chat__menu"
    >
      <p class="mc-chat__menu-head">
        Model<span
          v-if="options.modelSource"
          class="mc-chat__menu-note"
        >set by {{ options.modelSource }}</span>
      </p>
      <button
        v-for="value in options.models"
        :key="value"
        type="button"
        class="mc-chat__menu-item"
        :class="{ 'mc-chat__menu-item--on': value === options.model }"
        @click="setOption('model', value)"
      >
        <span class="mc-chat__menu-tick">{{ value === options.model ? '✓' : '' }}</span>
        <span class="mc-chat__menu-name">{{ value }}</span>
      </button>

      <template v-if="options.efforts.length">
        <p class="mc-chat__menu-head">
          Effort
        </p>
        <div class="mc-chat__efforts">
          <button
            v-for="value in options.efforts"
            :key="value"
            type="button"
            class="mc-chat__effort"
            :class="{ 'mc-chat__effort--on': value === options.effort }"
            @click="setOption('effort', value)"
          >
            {{ value }}
          </button>
        </div>
      </template>
    </div>

    <!--
      The commands, while one is being typed. Above the box rather than below it, because the
      box is already at the bottom of the panel and a menu under it would be off-screen.

      Customize is the extension's own section of this menu - "MCP servers, slash commands,
      output styles, hooks, memory, permissions and plugins" - so MCP is reached from here
      rather than from a button of its own on the bar.
    -->
    <ul
      v-if="slashOpen"
      class="mc-chat__slash"
    >
      <li v-if="customize.length && slashSpot && !slashSpot.name.slice(1)">
        <p class="mc-chat__menu-head">
          Customize
        </p>
      </li>
      <li
        v-for="c in customize"
        v-show="slashSpot && !slashSpot.name.slice(1)"
        :key="`customize-${ c.command }`"
      >
        <button
          type="button"
          class="mc-chat__slash-item"
          @click="openManager(c.command)"
        >
          <span class="mc-chat__slash-name">/{{ c.command }}</span>
          <span class="mc-chat__slash-help">{{ c.help }}</span>
          <span
            v-if="c.command === 'mcp'"
            class="mc-chat__slash-source"
          >{{ mcp.read ? `${ mcp.servers.filter((x) => x.ok).length }/${ mcp.servers.length }` : '' }}</span>
        </button>
      </li>
      <li
        v-for="(c, i) in slashMatches"
        :key="c.name"
      >
        <button
          type="button"
          class="mc-chat__slash-item"
          :class="{ 'mc-chat__slash-item--on': i === slashIndex }"
          @mouseenter="slashIndex = i"
          @click="pickCommand(c)"
        >
          <span class="mc-chat__slash-name">{{ c.name }}</span>
          <span class="mc-chat__slash-help">{{ c.help }}</span>
          <span class="mc-chat__slash-source">{{ c.source }}</span>
        </button>
      </li>
    </ul>

    <!--
      A pane the chat cannot draw, said out loud with the two ways out of it.

      Without this, a full-screen picker in the pane looked exactly like a chat that had
      stopped working: nothing drawn, no error, and every message typed going somewhere the
      conversation never saw.
    -->
    <div
      v-if="takenOver"
      class="mc-chat__takeover"
    >
      <div class="mc-chat__takeover-head">
        <span>Claude Code is showing something here that the chat cannot draw.</span>
        <button
          type="button"
          class="mc-chat__navbtn"
          title="Send Escape to close it"
          @click="escapePane"
        >
          Escape
        </button>
        <button
          type="button"
          class="mc-chat__navbtn"
          title="Open the terminal, where it can be used"
          @click="$emit('view', 'terminal')"
        >
          Open the terminal
        </button>
      </div>
      <pre class="mc-chat__takeover-tail">{{ paneTail }}</pre>
    </div>

    <!-- What a name in the message is, when one is clicked. -->
    <div
      v-if="details"
      class="mc-chat__details"
    >
      <div class="mc-chat__details-head">
        <code>{{ details.name }}</code>
        <span class="mc-chat__details-kind">{{ details.source === 'skill' ? 'skill' : 'command' }}</span>
        <button
          type="button"
          class="mc-chat__details-close"
          title="Close"
          @click="details = null"
        >×</button>
      </div>
      <p class="mc-chat__details-about">{{ details.about || 'Reading what it does…' }}</p>
      <p
        v-if="details.path"
        class="mc-chat__details-path"
      >{{ details.path }}</p>
    </div>
    <!--
      The composer, as a slot: the one control a host is most likely to want in a shape of
      its own. The Focus deck's bar is a single line along the bottom of the page when it is
      shut, which is not a box with a pill row under it however it is styled.
    -->
    <slot
      name="composer"
      :draft="draft"
      :can-send="canSend"
      :sending="sending"
      :working="working"
      :send="send"
    >
    <!--
      The prompt box: one bordered box with the text area and the controls inside it, which is
      where Claude Code's VS Code extension puts them - "click the model name at the bottom of
      the prompt box", "click the mode indicator at the bottom of the prompt box". They were a
      row of outlined pills above the box, which read as four buttons competing with the thing
      somebody is actually doing. Here they are quiet text until they are wanted.
    -->
    <div
      class="mc-chat__box"
      :class="{ 'mc-chat__box--focus': focused }"
    >
      <!--
        The names in the message, marked where they are.
        
        A textarea cannot colour part of its own text, so the marks are drawn on a layer over
        it: same text, same wrapping, invisible except for the command names, and transparent
        to the pointer everywhere but on one of them - where a click asks what the skill does.
      -->
      <div
        ref="ghost"
        class="mc-chat__ghost"
        aria-hidden="true"
        @click="onGhostClick"
        v-html="draftMarked"
      />
      <textarea
        ref="box"
        v-model="draft"
        class="mc-chat__textarea"
        rows="1"
        :placeholder="working ? 'Queue the next message…' : 'Message Claude — / for commands'"
        :title="'Enter to send, Shift+Enter for a new line, / for commands, paste an image to attach it'"
        @keydown="onKeydown"
        @keyup="syncCaret"
        @click="syncCaret"
        @select="syncCaret"
        @input="syncCaret"
        @paste="onPaste"
        @scroll="syncGhost"
        @focus="focused = true"
        @blur="focused = false"
      />
      <div class="mc-chat__bar">
        <!-- The actions menu: what the desktop chat keeps under its "+", backed by the CLI. -->
        <button
          type="button"
          class="mc-chat__pill mc-chat__pill--icon"
          :class="{ 'mc-chat__pill--on': menu === 'actions' }"
          title="Attach, mention a file, clear, model, usage, appearance"
          @click="toggleMenu('actions')"
        >
          +
        </button>
        <input
          ref="filePick"
          type="file"
          multiple
          class="mc-chat__hidden"
          @change="attachPicked"
        >
        <!-- The model, and the effort level, which the picker carries as a row of its own. -->
        <button
          v-if="options.read"
          type="button"
          class="mc-chat__pill"
          :class="{ 'mc-chat__pill--on': menu === 'model' }"
          :title="options.modelSource ? `Model — set by ${ options.modelSource }` : 'Model'"
          :disabled="optionBusy === 'model' || optionBusy === 'effort'"
          @click="toggleMenu('model')"
        >
          {{ optionBusy === 'model' || optionBusy === 'effort' ? '…' : (options.model || 'model') }}<template v-if="options.effort"> · {{ options.effort }}</template>
          <svg
            class="mc-chat__chev"
            width="8"
            height="8"
            viewBox="0 0 8 8"
            aria-hidden="true"
          ><path
            d="M1 2.5 L4 5.5 L7 2.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
            stroke-linejoin="round"
          /></svg>
        </button>

        <!--
          There is no permissions control here, deliberately.

          Every pane starts claude with `--dangerously-skip-permissions` (see
          seed/claude-session.sh), so the mode is not a thing that changes and a button showing
          it was a button that only ever opened a picker. That picker is a full-screen terminal
          UI: the chat could not draw it and, before the warning below existed, could not leave
          it either - which is how a button that looked like a label ended a conversation.

          If a permission prompt does appear, the warning below says so and the terminal is one
          press away, which is where it can be answered.
        -->

        <span class="mc-chat__bar-gap" />

        <!--
          `/` opens the same menu typing one does, which is what the extension's command menu
          button does, and is where MCP servers and the rest of Customize live.
        -->
        <button
          type="button"
          class="mc-chat__pill mc-chat__pill--icon"
          title="Commands, MCP servers and settings"
          @click="openCommandMenu"
        >
          /
        </button>
        <button
          type="button"
          class="mc-chat__send"
          :disabled="!canSend"
          :title="canSend ? 'Send' : 'Nothing to send'"
          @click="send"
        >
          {{ sending ? '…' : '↑' }}
        </button>
      </div>
    </div>
    </slot>
  </div>
</template>

<style lang="scss" scoped>
.mc-chat {
  /*
   * The one inset every element that lines up with the prompt box is measured from.
   *
   * It was written out at each of them - the log, the menus, the action row, the box - and
   * they drifted: the action row sat a gutter further in than the box it belongs to. One
   * value, and they cannot.
   */
  --mc-chat-gutter: 18px;

  position:       relative;
  display:        flex;
  flex-direction: column;
  height:         100%;
  min-height:     0;
  min-width:      0;
  background:     var(--terminal-bg, var(--body-bg));
  color:          var(--body-text);
  /*
   * A real prose font, not the terminal's.
   *
   * The chat is drawn where the terminal is, so with no family of its own it inherited the
   * harness-terminal monospace - which has no em-dash glyph, so every "—" in an agent's reply
   * came out as "_". Prose belongs in a proportional font anyway; code and the option pills
   * still ask for monospace explicitly where they need it.
   */
  font-family:    -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size:      13px;
  line-height:    1.5;

  &__log {
    flex:       1 1 auto;
    overflow:   auto;
    // The top inset clears the view toggle that floats over this corner (PodTerminal's
    // __tools): on a touch screen there is no hover to hide it, so without this the first
    // line of the conversation is read through a pair of buttons.
    padding:    32px var(--mc-chat-gutter) 8px;
    min-height: 0;
  }

  &__empty { color: var(--muted); }

  &__msg {
    position:      relative;
    // A turn is separated from the next by more than the lines inside it are from each other,
    // which is what makes a conversation readable as turns rather than as one column of boxes.
    // It was 10px between messages and 10px of padding inside them, so the gap between two
    // people talking measured the same as the gap between a heading and its own text.
    margin:        0 0 14px;
    padding:       10px 14px 10px 16px;
    border-radius: 10px;
    max-width:     100%;
    border:        1px solid transparent;

    &--user {
      background:   color-mix(in srgb, var(--link) 12%, transparent);
      border-color: color-mix(in srgb, var(--link) 22%, transparent);
      margin-left:  36px;
    }

    &--assistant {
      background:   color-mix(in srgb, var(--body-text) 4%, transparent);
      border-color: color-mix(in srgb, var(--body-text) 9%, transparent);
    }

    // Sent, but not in the transcript yet. A dashed edge rather than a faded message: it has
    // to be legible - it is what the person just wrote - while still not claiming to be part
    // of the conversation.
    &--queued {
      border-style: dashed;
      border-color: color-mix(in srgb, var(--link) 45%, transparent);
      background:   color-mix(in srgb, var(--link) 6%, transparent);
    }
  }

  &__queued-note {
    color:          var(--muted);
    font-size:      10px;
    letter-spacing: 0.04em;
    text-transform: uppercase;

    &--failed { color: var(--error, #d9534f); text-transform: none; letter-spacing: 0; }
  }

  &__msg--note {
    opacity: 0.8;

    .mc-chat__body { font-family: monospace; font-size: 11px; white-space: pre-wrap; color: var(--muted); }
  }

  &__shots {
    display:   flex;
    flex-wrap: wrap;
    gap:       6px;
    margin:    6px 0 2px;
  }

  &__shot {
    max-width:     240px;
    max-height:    160px;
    border:        1px solid var(--border);
    border-radius: 4px;
    cursor:        zoom-in;
    object-fit:    contain;
    background:    var(--body-bg);
  }

  &__lightbox--panel { cursor: default; }

  &__panel {
    background:    var(--body-bg);
    color:         var(--body-text);
    border:        1px solid var(--border);
    border-radius: 8px;
    width:         min(92vw, 760px);
    max-height:    88vh;
    display:       flex;
    flex-direction: column;
    box-shadow:    0 12px 40px rgba(0, 0, 0, 0.35);
  }

  &__panel-head {
    display:         flex;
    align-items:     center;
    justify-content: space-between;
    padding:         10px 14px;
    border-bottom:   1px solid var(--border);
  }

  &__panel-title { font-family: monospace; font-weight: 600; }

  &__panel-text {
    margin:      0;
    padding:     12px 14px;
    overflow:    auto;
    font-size:   12px;
    line-height: 1.45;
    white-space: pre;
  }

  &__lightbox {
    position:        fixed;
    inset:           0;
    z-index:         1000;
    background:      rgba(0, 0, 0, 0.8);
    display:         flex;
    align-items:     center;
    justify-content: center;
    cursor:          zoom-out;

    img { max-width: 96vw; max-height: 96vh; object-fit: contain; }
  }

  &__dialog-header {
    font-weight: 600;
    margin:      0 0 4px;
  }

  &__hidden { display: none; }

  &__menu--actions, &__menu--files {
    max-height: min(60vh, 520px);
    overflow-y: auto;

    .mc-chat__menu-item { justify-content: flex-start; gap: 8px; }
    .mc-chat__menu-note { margin-left: auto; padding-left: 12px; white-space: nowrap; }
  }

  &__menu-item--file .mc-chat__menu-name { font-family: monospace; font-size: 11px; }

  &__file-filter {
    width:         100%;
    box-sizing:    border-box;
    margin:        2px 0 6px;
    padding:       5px 8px;
    border:        1px solid var(--border);
    border-radius: 6px;
    background:    var(--body-bg);
    color:         var(--body-text);
    font-size:     12px;
  }

  &__menu-empty { padding: 6px 8px; }

  &__look {
    display:     flex;
    align-items: center;
    gap:         4px;
    padding:     2px 8px 6px;
  }

  &__look-label {
    color:     var(--muted);
    font-size: 11px;
    min-width: 56px;
  }

  &__io {
    display:        inline-block;
    margin:         4px 0 2px;
    color:          var(--muted);
    font-size:      9px;
    letter-spacing: 0.08em;
    font-family:    monospace;
  }

  /* Appearance: each preference is one class on the root. */
  &--small { font-size: 11px; .mc-chat__body { font-size: 11px; } }
  &--large { font-size: 14px; .mc-chat__body { font-size: 14px; } }
  &--compact { .mc-chat__msg { margin: 4px 0; } .mc-chat__meta { margin-bottom: 1px; } }
  &--flat { .mc-chat__msg--user .mc-chat__body { background: transparent; border: 0; padding-left: 0; } }
  &--no-times { .mc-chat__when { display: none; } }

  &__option-desc {
    display:   block;
    color:     var(--muted);
    font-size: 11px;
    margin:    2px 0 0 18px;
  }

  &__meta {
    display:     flex;
    flex-wrap:   wrap;
    gap:         8px;
    align-items: baseline;
    margin:      0 0 6px;
  }

  &__who {
    font-weight:    600;
    font-size:      11px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color:          var(--muted);
  }
  &__msg--user &__who { color: var(--link); }
  &__when { color: var(--muted); font-size: 11px; }

  &__user-text { word-break: break-word; }

  &__md {
    word-break: break-word;

    :deep(p) { margin: 0 0 8px; }
    :deep(p:last-child) { margin-bottom: 0; }
    :deep(pre) {
      background:    var(--body-bg);
      border:        1px solid var(--border);
      border-radius: 6px;
      padding:       8px 10px;
      overflow:      auto;
      font-size:     12px;
      margin:        6px 0;
    }
    :deep(code) { font-family: monospace; font-size: 12px; }
    :deep(p code), :deep(li code) { background: color-mix(in srgb, var(--body-text) 8%, transparent); padding: 0 4px; border-radius: 3px; }
    :deep(ul), :deep(ol) { margin: 4px 0 8px; padding-left: 22px; }
    :deep(h3), :deep(h4), :deep(h5), :deep(h6) { margin: 8px 0 4px; font-size: 13px; }
    :deep(blockquote) { border-left: 3px solid var(--border); margin: 6px 0; padding-left: 10px; color: var(--muted); }
    :deep(a) { color: var(--link); }

    // A table scrolls sideways in its own box: the chat is narrow and often docked, and a wide
    // table must not widen the panel.
    :deep(.mc-chat__table-wrap) {
      max-width:   100%;
      overflow-x:  auto;
      margin:      6px 0;
    }
    :deep(table) {
      border-collapse: collapse;
      font-size:       12px;
    }
    :deep(th), :deep(td) {
      border:      1px solid var(--border);
      padding:     4px 8px;
      text-align:  left;
      white-space: nowrap;
    }
    :deep(th) {
      background:   color-mix(in srgb, var(--body-text) 6%, transparent);
      font-weight:  600;
    }
  }

  // A path, wherever it is said: the thing a click opens.
  :deep(.mc-chat__path) {
    color:           var(--link);
    text-decoration: none;
    font-family:     monospace;
    font-size:       12px;
    word-break:      break-all;
    cursor:          pointer;
  }

  :deep(.mc-chat__path:hover) { text-decoration: underline; }

  :deep(.mc-chat__media) {
    display:        inline-flex;
    align-items:    center;
    vertical-align: middle;
    margin:         0 4px 0 0;
    cursor:         pointer;
  }

  // The thumbnail is one line tall, so it sits in the sentence rather than breaking it.
  :deep(.mc-chat__thumb) {
    height:         1.4em;
    width:          auto;
    max-width:      6em;
    object-fit:     cover;
    border-radius:  3px;
    border:         1px solid var(--border);
    vertical-align: middle;
    background:     var(--body-bg);
    transition:     transform 0.12s ease;
  }

  :deep(.mc-chat__thumb:hover) { transform: scale(1.6); position: relative; z-index: 2; }

  :deep(.mc-chat__chip) {
    display:         inline-flex;
    align-items:     center;
    justify-content: center;
    height:          1.4em;
    min-width:       1.6em;
    padding:         0 4px;
    border-radius:   3px;
    border:          1px solid var(--border);
    background:      var(--body-bg);
    font-size:       10px;
    color:           var(--link);
  }

  :deep(.mc-chat__chip--missing) { color: var(--muted); text-decoration: line-through; }

  // A paste, folded the way the input box folded it when it was pasted. Closed, it is one
  // line saying how much there is; open, it is the paste, scrolling in its own box rather
  // than pushing the rest of the conversation off the screen.
  :deep(.mc-chat__paste) {
    margin: 4px 0;
  }

  :deep(.mc-chat__paste > summary) {
    cursor:        pointer;
    display:       inline-flex;
    align-items:   center;
    gap:           4px;
    padding:       1px 8px;
    border:        1px solid var(--border);
    border-radius: 10px;
    background:    var(--body-bg);
    color:         var(--muted);
    font-size:     11px;
    user-select:   none;
  }

  :deep(.mc-chat__paste > summary:hover) { color: var(--link); border-color: color-mix(in srgb, var(--link) 40%, var(--border)); }
  :deep(.mc-chat__paste[open] > summary) { margin-bottom: 2px; }

  :deep(.mc-chat__paste > pre) {
    margin:        0;
    padding:       6px 8px;
    font-size:     11px;
    background:    var(--body-bg);
    border:        1px solid var(--border);
    border-radius: 4px;
    white-space:   pre-wrap;
    word-break:    break-word;
    max-height:    320px;
    overflow:      auto;
  }

  &__images {
    list-style:  none;
    padding:     0;
    margin:      6px 0 0;
    font-family: monospace;
    font-size:   12px;
    color:       var(--muted);
  }

  // Tool calls: one line each, an accordion. The badge is the tool, the rest is what it did.
  &__tool {
    margin:       2px 0 0;
    font-size:    12px;
    line-height:  1.35;

    &--error .mc-chat__tool-name { background: color-mix(in srgb, var(--error) 22%, transparent); color: var(--error); }
    &--pending .mc-chat__tool-name { background: color-mix(in srgb, var(--link) 18%, transparent); color: var(--link); }
  }

  &__disclose {
    background:  none;
    border:      0;
    padding:     1px 0;
    min-height:  0;
    color:       var(--muted);
    cursor:      pointer;
    text-align:  left;
    font-size:   12px;
    display:     flex;
    gap:         6px;
    align-items: baseline;
    max-width:   100%;
    width:       100%;

    &::before {
      content:   '▸';
      flex:      0 0 auto;
      font-size: 9px;
      color:     var(--muted);
    }

    &:hover { color: var(--body-text); }
  }

  &__tool-detail + &__disclose::before, &__disclose[aria-expanded='true']::before { content: '▾'; }

  &__tool-name {
    flex:          0 0 auto;
    font-weight:   600;
    font-size:     10px;
    line-height:   16px;
    padding:       0 5px;
    border-radius: 3px;
    background:    color-mix(in srgb, var(--body-text) 8%, transparent);
    color:         var(--body-text);
    text-transform: uppercase;
    letter-spacing: 0.02em;
  }
  &__tool-summary {
    color:         var(--muted);
    font-family:   monospace;
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
    min-width:     0;
  }
  &__tool-state { color: var(--link); }

  &__pre {
    margin:        4px 0 0;
    padding:       6px 8px;
    font-size:     11px;
    background:    var(--body-bg);
    border:        1px solid var(--border);
    border-radius: 4px;
    white-space:   pre-wrap;
    word-break:    break-word;
    max-height:    320px;
    overflow:      auto;

    &--result { border-color: color-mix(in srgb, var(--link) 40%, var(--border)); }
  }

  &__thought { margin: 0 0 6px; color: var(--muted); }

  // Working: three dots that breathe, and a status that shimmers, like a reply being typed.
  &__working {
    display:     flex;
    align-items: center;
    gap:         10px;
    color:       var(--muted);
  }

  &__dots {
    display: inline-flex;
    gap:     4px;

    i {
      width:         7px;
      height:        7px;
      border-radius: 50%;
      background:    var(--link);
      opacity:       0.35;
      animation:     mc-chat-bounce 1.2s infinite ease-in-out;

      &:nth-child(2) { animation-delay: 0.15s; }
      &:nth-child(3) { animation-delay: 0.3s; }
    }
  }

  &__shimmer {
    background:              linear-gradient(90deg, var(--muted) 0%, var(--body-text) 45%, var(--muted) 90%);
    background-size:         200% 100%;
    -webkit-background-clip: text;
    background-clip:         text;
    color:                   transparent;
    animation:               mc-chat-shimmer 2.2s linear infinite;
  }

  &__notice {
    position:      absolute;
    left:          18px;
    right:         18px;
    bottom:        118px;
    z-index:       4;
    padding:       8px 12px;
    border-radius: 8px;
    background:    color-mix(in srgb, var(--warning) 18%, var(--body-bg));
    border:        1px solid color-mix(in srgb, var(--warning) 50%, transparent);
    font-size:     12px;
    box-shadow:    0 4px 14px rgba(0, 0, 0, 0.25);
  }

  &__dialog {
    flex:          0 0 auto;
    margin:        0 18px 8px;
    padding:       10px 12px;
    border:        1px solid var(--link);
    border-radius: 10px;
    background:    color-mix(in srgb, var(--link) 8%, transparent);
  }

  &__dialog-prompt {
    margin:      0 0 8px;
    white-space: pre-wrap;
    font-family: inherit;
    font-size:   12px;
  }

  &__options {
    display:   flex;
    flex-wrap: wrap;
    gap:       6px;
  }

  &__option {
    border:          1px solid var(--border);
    background:      var(--body-bg);
    color:           var(--body-text);
    border-radius:   6px;
    padding:         4px 10px;
    min-height:      0;
    font-size:       12px;
    cursor:          pointer;
    text-decoration: none;

    &:hover { border-color: var(--link); color: var(--link); }
    &--selected { border-color: var(--link); }
  }

  &__option-key {
    display:     inline-block;
    min-width:   14px;
    color:       var(--muted);
    font-family: monospace;
  }

  &__login { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  &__code { display: flex; gap: 6px; }
  &__code input { height: 28px; font-size: 12px; padding: 0 8px; }

  // Nothing in it is no line at all. It was holding a row's height open between the action
  // row and the box whether or not it had anything to say, which is most of the gap that was
  // there.
  &__status:empty { display: none; padding: 0; }

  // One row under the conversation: the status on the left, the ways of getting around on the
  // right, both inset to the gutter so they line up with the box below and the log above.
  &__footer {
    flex:            0 0 auto;
    display:         flex;
    align-items:     center;
    gap:             8px;
    padding:         0 var(--mc-chat-gutter) 6px;
    min-height:      26px;
  }

  &__status {
    flex:        1 1 auto;
    min-width:   0;
    padding:     0;
    font-size:   11px;
    color:       var(--muted);
    display:     flex;
    gap:         8px;
    align-items: center;
  }

  &__error { color: var(--error); }

  &__link {
    background: none;
    border:     0;
    padding:    0;
    min-height: 0;
    color:      var(--link);
    cursor:     pointer;
    font-size:  11px;
  }

  // ── The prompt box ──
  // One bordered box with the text area and the controls inside it. The border used to be on
  // the textarea, with the send button beside it and four outlined pills on a row above; that
  // is four competing rectangles around the one thing somebody is doing. The box owns the
  // border, everything inside it is borderless, and the controls are quiet text until hovered.
  &__box {
    flex:          0 0 auto;
    display:       flex;
    flex-direction: column;
    position:      relative;
    margin:        0 var(--mc-chat-gutter) 12px;
    border:        1px solid var(--border);
    border-radius: 8px;
    background:    var(--body-bg);
    transition:    border-color 0.12s ease;

    &--focus { border-color: var(--link); }
  }

  /*
   * The box and the layer over it have to agree about every pixel of type, or the marks drift
   * off the words they belong to: same font, same size, same line height, same padding, same
   * wrapping. Only the marks paint; everything else on the layer is invisible.
   */
  &__textarea,
  &__ghost {
    padding:     9px 11px 4px;
    font-size:   13px;
    font-family: inherit;
    line-height: 1.45;
    white-space: pre-wrap;
    overflow-wrap: break-word;
  }

  // One line to start with, and as many as three once there is something to show.
  //
  // It was three lines whatever was in it, which is two lines of empty box between the
  // conversation and what you are typing for as long as you are typing one line - and this view
  // is mostly read, so those lines cost you history. The height is set from the content in
  // script (autoGrow); the maximum is here, because it is a layout decision, and past it the
  // box scrolls rather than taking the page.
  //
  // `flex: 0 0 auto` so the height that script sets is the height it gets: with `1 1 auto` the
  // box's own flex stretched it back out.
  &__textarea {
    flex:       0 0 auto;
    resize:     none;
    overflow-y: auto;
    min-height: calc(1.45em + 13px);
    max-height: calc(4.35em + 13px);
    border:     0;
    background: transparent;
    color:      var(--body-text);
    position:   relative;
    z-index:    0;

    &:focus { outline: none; }
    &::placeholder { color: var(--muted); }
  }

  &__ghost {
    position:      absolute;
    inset:         0;
    overflow:      hidden;
    color:         transparent;
    pointer-events: none;
    z-index:       1;
  }

  /*
   * One command name, where it sits in the message. Clickable; the rest of the layer is not.
   *
   * `:deep`, because the marks are written into the layer as HTML and a scoped stylesheet
   * stamps its attribute on elements the template creates - not on these. Without it the rule
   * matched nothing: no tint, and `pointer-events: auto` never reached the mark, so a click
   * went through to the textarea underneath and nothing opened.
   */
  :deep(.mc-chat__cmd) {
    padding:        1px 0;
    border-radius:  3px;
    background:     color-mix(in srgb, var(--success) 22%, transparent);
    box-shadow:     0 1px 0 color-mix(in srgb, var(--success) 55%, transparent);
    color:          transparent;
    cursor:         pointer;
    pointer-events: auto;

    &:hover { background: color-mix(in srgb, var(--success) 38%, transparent); }
  }

  /* What a clicked name is: its kind, what it does, and where it lives. */
  &__details {
    margin:        0 var(--mc-chat-gutter) 6px;
    padding:       8px 10px;
    border:        1px solid var(--border);
    border-radius: 8px;
    background:    var(--box-bg);
  }

  &__details-head {
    display:     flex;
    align-items: center;
    gap:         8px;
  }

  &__details-kind {
    color:          var(--muted);
    font-size:      11px;
    text-transform: uppercase;
    letter-spacing: .05em;
  }

  &__details-close {
    margin-left: auto;
    min-height:  0;
    padding:     0 4px;
    border:      0;
    background:  transparent;
    color:       var(--muted);
    font-size:   16px;
    line-height: 1;
    cursor:      pointer;

    &:hover { color: var(--body-text); }
  }

  &__details-about {
    margin:    6px 0 0;
    font-size: 12px;
  }

  &__details-path {
    margin:    4px 0 0;
    color:     var(--muted);
    font-size: 11px;
    word-break: break-all;
  }

  // The row along the bottom of the box: model, permissions, then the command menu and send.
  &__bar {
    display:     flex;
    align-items: center;
    gap:         2px;
    padding:     3px 5px 5px;
  }

  &__bar-gap { flex: 1 1 auto; }

  // Quiet text, not a chip. It reads as a label until it is wanted, which is what keeps four
  // controls from competing with the message being written.
  &__pill {
    display:       flex;
    align-items:   center;
    gap:           4px;
    max-width:     40%;
    padding:       3px 7px;
    border:        0;
    border-radius: 6px;
    background:    transparent;
    color:         var(--muted);
    font-size:     11px;
    font-family:   inherit;
    white-space:   nowrap;
    overflow:      hidden;
    text-overflow: ellipsis;
    cursor:        pointer;

    &:hover:not(:disabled), &--on {
      background: color-mix(in srgb, var(--body-text) 8%, transparent);
      color:      var(--body-text);
    }

    &:disabled { opacity: 0.5; cursor: default; }

    // The command menu. A bare "/" is punctuation until it has an edge, and it belongs beside
    // send rather than adrift between the gap and it. Its geometry is shared with send above.
    &--icon {
      margin-right: 5px;
      border-color: var(--border);
      font-family:  var(--mc-terminal-font, monospace);
      font-size:    13px;

      &:hover { border-color: var(--link); }
    }
  }

  &__chev { flex: 0 0 auto; opacity: 0.8; }

  // The pair at the right of the bar. One variable, one radius, one border width.
  &__pill--icon,
  &__send {
    flex:            0 0 auto;
    display:         flex;
    align-items:     center;
    justify-content: center;
    width:           var(--mc-chat-btn, 30px);
    height:          var(--mc-chat-btn, 30px);
    min-height:      0;
    padding:         0;
    border-width:    1px;
    border-style:    solid;
    border-radius:   6px;
    line-height:     1;
  }

  /*
   * Rancher's stylesheet sizes every `button` on the page, and these are on its page.
   *
   * That is why the model rows and the effort pills came out two and three times their
   * intended height: the shell sets a min-height and a line-height for a form control, this
   * component's buttons are list rows and 11px chips, and nothing here was saying otherwise.
   * Setting the padding and the font size is not enough - the properties that were winning are
   * the ones this never mentioned. So they are named, once, for every button in the pane.
   */
  button {
    min-height:  0;
    margin:      0;
    line-height: 1.35;
    box-shadow:  none;
  }

  // ── The command menu ──
  // A list rather than a floating popup: the panel is narrow and often docked, and an
  // absolutely-positioned menu in here escapes the drawer on a phone. Same metrics as the
  // picker below, because they are the same kind of list opened from the same box.
  &__slash {
    flex:          0 0 auto;
    // Sits on the box: same gutter, no daylight, square where the two meet.
    margin:        0 var(--mc-chat-gutter) -1px;
    padding:       3px;
    list-style:    none;
    max-height:    40vh;
    overflow:      auto;
    border:        1px solid var(--border);
    border-bottom: 0;
    border-radius: 8px 8px 0 0;
    background:    var(--body-bg);

    li { list-style: none; }
  }

  &__slash-item {
    display:       flex;
    gap:           6px;
    align-items:   baseline;
    width:         100%;
    padding:       4px 8px;
    border:        0;
    border-radius: 6px;
    background:    transparent;
    color:         var(--body-text);
    font-size:     12px;
    font-family:   inherit;
    text-align:    left;
    cursor:        pointer;

    &:hover, &--on { background: color-mix(in srgb, var(--link) 14%, transparent); }
  }

  &__slash-name {
    flex:        0 0 auto;
    font-family: var(--mc-terminal-font, monospace);
    font-weight: 600;
  }

  &__slash-help {
    flex:          1 1 auto;
    min-width:     0;
    color:         var(--muted);
    font-size:     11px;
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
  }

  &__slash-source {
    flex:           0 0 auto;
    color:          var(--muted);
    font-size:      10px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  // Square, at the row's own height: an arrow is a glyph, not a word, and giving it a word's
  // padding is what made it an oval.
  &__navbtn--caret {
    width:      var(--mc-chat-nav, 26px);
    padding:    0;
    font-size:  13px;
  }

  &__takeover {
    flex:          0 0 auto;
    margin:        0 18px 6px;
    padding:       8px 10px;
    border:        1px solid var(--warning);
    border-radius: 8px;
    background:    color-mix(in srgb, var(--warning) 10%, transparent);
    font-size:     12px;
  }

  &__takeover-head {
    display:     flex;
    flex-wrap:   wrap;
    gap:         6px;
    align-items: center;
  }

  &__takeover-head > span { flex: 1 1 auto; min-width: 0; }

  &__takeover-tail {
    margin:      6px 0 0;
    max-height:  84px;
    overflow:    auto;
    color:       var(--muted);
    font-family: var(--mc-terminal-font, monospace);
    font-size:   11px;
    white-space: pre-wrap;
  }


  // Whichever menu is open, the box below it loses its top corners so the two read as one.
  &__slash + &__box,
  &__slash-hint + &__box {
    margin-top:              0;
    border-top-left-radius:  0;
    border-top-right-radius: 0;
  }

  // ── The pickers ──
  &__menu {
    flex:          0 0 auto;
    // Zero bottom margin and the box's own top margin removed below: the picker is opened
    // from the box and belongs to it, and 6px of daylight between them read as two panels.
    margin:        0 var(--mc-chat-gutter) -1px;
    padding:       3px;
    border:        1px solid var(--border);
    border-bottom: 0;
    border-radius: 8px 8px 0 0;
    background:    var(--body-bg);
    max-height:    46vh;
    overflow:      auto;
  }

  // The box loses its top corners while a menu is sitting on it.
  &__menu + &__box {
    margin-top:                 0;
    border-top-left-radius:     0;
    border-top-right-radius:    0;
  }

  &__menu-head {
    display:        flex;
    align-items:    baseline;
    gap:            6px;
    margin:         5px 0 1px;
    padding:        0 8px;
    color:          var(--muted);
    font-size:      10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  &__menu-note { text-transform: none; letter-spacing: 0; font-size: 10px; }

  &__menu-item {
    display:       flex;
    align-items:   baseline;
    gap:           6px;
    width:         100%;
    padding:       4px 8px;
    border:        0;
    border-radius: 6px;
    background:    transparent;
    color:         var(--body-text);
    font-size:     12px;
    font-family:   inherit;
    text-align:    left;
    cursor:        pointer;

    &:hover { background: color-mix(in srgb, var(--link) 14%, transparent); }
    &--on { color: var(--link); }
  }

  &__menu-tick {
    flex:      0 0 12px;
    color:     var(--link);
    font-size: 11px;
  }

  &__menu-name { flex: 0 0 auto; }

  &__menu-help {
    flex:          1 1 auto;
    min-width:     0;
    color:         var(--muted);
    font-size:     11px;
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
  }

  // Effort is a row of its own inside the model picker, because it is a property of the model
  // rather than a second thing to choose - which is how claude's own picker has it.
  &__efforts {
    display:   flex;
    flex-wrap: wrap;
    gap:       4px;
    padding:   2px 8px 6px;
  }

  &__effort {
    padding:       2px 9px;
    line-height:   1.5;
    border:        1px solid var(--border);
    border-radius: 999px;
    background:    transparent;
    color:         var(--muted);
    font-size:     11px;
    font-family:   inherit;
    cursor:        pointer;

    &:hover { border-color: var(--link); color: var(--body-text); }

    &--on {
      border-color: var(--link);
      background:   color-mix(in srgb, var(--link) 16%, transparent);
      color:        var(--body-text);
    }
  }

  &__send {
    // A transparent border rather than none, so the two are the same box: a filled button
    // beside an outlined one is a pixel narrower and shorter otherwise, and side by side that
    // is the difference you can see without being able to name it.
    border-color: transparent;
    background:   var(--link);
    color:        var(--link-text, #fff);
    font-size:    15px;
    cursor:       pointer;

    // Legible rather than ghostly: it is the control somebody is looking for.
    &:disabled {
      background: color-mix(in srgb, var(--link) 30%, transparent);
      color:      color-mix(in srgb, var(--link-text, #fff) 70%, transparent);
      cursor:     default;
    }
  }

  &__mcp {
    display:     flex;
    gap:         8px;
    align-items: baseline;
    padding:     5px 8px;
    font-size:   12px;
  }

  &__mcp-dot {
    flex:          0 0 auto;
    width:         7px;
    height:        7px;
    border-radius: 50%;
    align-self:    center;
    background:    var(--muted);

    &--ok  { background: var(--success); }
    &--bad { background: var(--error); }
  }

  &__mcp-name {
    flex:          1 1 auto;
    min-width:     0;
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
  }


}

.mc-chat {
  &__pick {
    flex:          0 0 auto;
    display:       flex;
    align-items:   center;
    gap:           8px;
    padding:       6px 18px;
    border-bottom: 1px solid var(--border);
    font-size:     11px;
    color:         var(--muted);
  }

  &__pick-btn {
    min-height:    0;
    height:        24px;
    padding:       0 10px;
    font-size:     11px;
    border-radius: 12px;
    border:        1px solid var(--border);
    background:    transparent;
    color:         var(--body-text);
    cursor:        pointer;

    &:hover, &--open { border-color: var(--link); color: var(--link); }
  }

  &__pick-current { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }

  &__agents {
    flex:           0 0 auto;
    max-height:     40%;
    overflow:       auto;
    border-bottom:  1px solid var(--border);
    padding:        4px 10px;
    display:        flex;
    flex-direction: column;
    gap:            2px;
  }

  &__agent {
    display:       grid;
    grid-template-columns: 10px minmax(120px, 220px) 1fr auto;
    gap:           8px;
    align-items:   center;
    min-height:    0;
    padding:       4px 8px;
    border:        1px solid transparent;
    border-radius: 6px;
    background:    transparent;
    color:         var(--body-text);
    text-align:    left;
    font-size:     12px;
    cursor:        pointer;

    &:hover { background: color-mix(in srgb, var(--body-text) 5%, transparent); }
    &--on { border-color: var(--link); }
  }

  &__agent-dot {
    width:         8px;
    height:        8px;
    border-radius: 50%;
    background:    var(--muted);
    opacity:       0.5;
  }
  &__agent--working &__agent-dot { background: var(--primary); opacity: 1; animation: mc-chat-pulse 1.4s infinite ease-in-out; }

  &__agent-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  &__agent-last { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  &__agent-when { color: var(--muted); font-size: 11px; }

  /*
   * The row that floats over the bottom of the log.
   *
   * It spans the pane rather than hugging the right edge, so the caret keys sit on the left -
   * under the thumb that is about to reach into the message box below them - and the ones that
   * move the log stay on the right where they were. Bunched together on the right they read as
   * one group of four, which they are not: two act on the box and two act on the log.
   */
  /*
   * A row of its own, between the log and the prompt box.
   *
   * It used to float over the log at a fixed offset from the bottom, which meant it sat on
   * whatever line of the conversation happened to be there - a message with buttons through
   * it, and text under a control that could not be read or clicked. Being absolute also meant
   * that offset was a guess about the height of everything below it, and every change to the
   * composer made the guess wrong again.
   *
   * In the column it takes the room it needs and nothing is underneath it.
   */
  &__nav {
    flex:            0 0 auto;
    display:         flex;
    justify-content: flex-end;
    align-items:     center;
    // Enough to read as two pairs rather than four buttons, and the same step the prompt box's
    // own controls use.
    gap:             5px;
    // No padding of its own: it is the right-hand half of __footer, which owns the inset and
    // the gap to the box. It had both, which is how it ended up on a different column from the
    // status line it was sitting above.
    padding:         0;
  }

  // Everything after the caret keys goes to the right; they stay at the left.
  &__navbtn--caret + :not(&__navbtn--caret) { margin-left: auto; }

  /*
   * The controls that float over the log.
   *
   * They were 24px pills with a 12px radius - fully round ends - which made the two arrows
   * into wide ovals beside two word-shaped ones, four different silhouettes in a row of four.
   * Now they are one height, one radius and one padding, the arrows are square at that height,
   * and the two groups are separated by the gap between them rather than by being different
   * shapes.
   *
   * 26px matches the prompt box's own buttons below, so a glance down the right-hand edge sees
   * one size rather than three.
   */
  &__navbtn {
    display:         inline-flex;
    align-items:     center;
    justify-content: center;
    min-height:      0;
    height:          var(--mc-chat-nav, 26px);
    padding:         0 10px;
    font-size:       11px;
    line-height:     1;
    border-radius:   6px;
    border:          1px solid var(--border);
    background:      var(--body-bg);
    color:           var(--muted);
    cursor:          pointer;
    opacity:         0.85;

    &:hover { opacity: 1; color: var(--link); border-color: var(--link); }
    &--bottom { color: var(--link); opacity: 1; }
  }

  &__msg--summary {
    background:   color-mix(in srgb, var(--warning) 8%, transparent);
    border-color: color-mix(in srgb, var(--warning) 30%, transparent);
  }

  &__summary-line {
    color:         var(--muted);
    white-space:   nowrap;
    overflow:      hidden;
    text-overflow: ellipsis;
  }

  &__msg--found { box-shadow: 0 0 0 2px var(--link); }
}

/* ── Phones ──
   760px, the breakpoint the rest of this extension already uses (PodTerminal's font switch,
   and the Dev extension's whole mobile sheet).

   What is wrong at this width is not the layout, which is a column and stays one. It is that
   every horizontal measurement in here was chosen for a docked panel on a desktop: 18px of
   padding either side of the log plus 16px inside each message plus a 36px indent on your own
   messages spends 88px of a 390px screen on nothing, and the text that is left wraps every
   four or five words. So the gutters come in, the indent becomes a hint rather than a margin,
   and the vertical rhythm is kept - the room saved goes to the words. ── */
@media (max-width: 760px) {
  .mc-chat {
    &__log { padding: 30px var(--mc-chat-gutter) 6px; }

    &__msg {
      margin:        0 0 12px;
      padding:       9px 11px 9px 12px;
      border-radius: 8px;
    }

    /* Enough to tell the two apart at a glance, which is all the indent was ever doing; the
       colour and the "You" label do the rest. */
    &__msg--user { margin-left: 14px; }

    /* Three items on one line - who, when, and whether it is queued - do not fit beside a
       timestamp at this width, and __meta already wraps. This keeps the wrap tidy. */
    &__meta { gap: 6px; }

    /* The menus and the box share the page's gutter, which is 10px here rather than 18. */
    --mc-chat-gutter: 10px;

    &__slash-help { display: none; }
    &__slash-hint { padding: 4px 10px 0; }

    &__box { margin: 0 var(--mc-chat-gutter) 10px; }

    /* The controls stay on one row: two names, then the command menu and send. The model name
       is the one that can be long, so it is the one that gets the room and the ellipsis. */
    &__bar { padding: 2px 4px 4px; }
    &__pill { max-width: 34%; }

    /* Thumb-sized. 26px is right beside a 13px control on a desktop and too small to hit on
       glass, and these two are the controls somebody uses on every message. */
    // Thumb-sized, and all of them from the same two variables so they cannot drift apart.
    --mc-chat-btn: 36px;
    --mc-chat-nav: 32px;

    &__send { font-size: 17px; }
    &__pill--icon { font-size: 15px; }
    &__navbtn { padding: 0 12px; }

    &__textarea { min-height: calc(1.45em + 10px); padding: 8px 10px 2px; }

    &__footer { padding: 0 var(--mc-chat-gutter) 4px; }

    /* The subagent list: name, last words and time on one row is three columns in 370px. */
    &__agents { padding: 0 10px; }

    &__agent {
      flex-wrap: wrap;
      gap:       4px 8px;
    }

    &__agent-last {
      flex-basis: 100%;
      order:      3;
    }

    &__pick { padding: 6px 10px; }

    /* A wide tool result or a code block scrolls in its own box rather than widening the
       message, which on a phone widens the page. */
    &__pre,
    &__md pre {
      max-width: 100%;
      overflow-x: auto;
    }
  }
}

@keyframes mc-chat-pulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(0.6); opacity: 0.5; }
}

@keyframes mc-chat-bounce {
  0%, 80%, 100% { transform: translateY(0); opacity: 0.35; }
  40% { transform: translateY(-4px); opacity: 1; }
}

@keyframes mc-chat-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
</style>

<style lang="scss" src="./hljs-theme.scss"></style>

