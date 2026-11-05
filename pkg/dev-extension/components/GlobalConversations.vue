<script>
// The terminal drawer's conversations, on a phone.
//
// On a laptop these are AgentPanel: a drawer the chord opens, docked to an edge, with a tab per
// conversation. None of that reaches a phone - there is no chord, no edge worth docking to and
// no room for a tab row over a terminal - so the conversations that are nobody's workspace's
// had no way in at all from one.
//
// This is that way in, and it is the shape the workspace page already gives its conversations
// at phone width (WorkspaceRail, the "Conversations" card): a list of full-width rows, one per
// conversation, each a split button whose press opens it and whose caret renames, forks or ends
// it, and a "New conversation" under them. The list is a dialog of the whole screen, and the
// conversation opened from it is a second one over it, so back - the close button, Escape, or
// the phone's own back gesture - goes back one layer at a time: conversation, list, page.
//
// The conversations are the drawer's own (panelSessions), in the order the drawer last had them,
// so the same three show up in the same order on both.
import { RcButton } from '@components/RcButton';
import DevModal from './DevModal.vue';
import SplitButton from './SplitButton.vue';
import PodTerminal from './PodTerminal';
import { CLI_CHOICES } from '../agent-clis.mjs';
import { readPrefs } from '../prefs';
import {
  agentSessions, panelSessions, startAgentSession, renameAgentSession, endAgentSession, forkAgentSession,
} from '../agent';
import { conversationLabel } from '../conversation-id.mjs';
import { ensureAgentCredential } from '../credential';
import { arrange, readDrawerState } from '../drawer';

/** How often the dots re-read what each conversation is doing; the drawer's own beat. */
const STATES_POLL_MS = 12_000;

/** The marker this component's history entries carry, so a pop can tell they are its own. */
const HISTORY_KEY = 'devConversations';

export default {
  name: 'GlobalConversations',

  components: {
    DevModal, PodTerminal, RcButton, SplitButton
  },

  emits: ['close'],

  data() {
    return {
      sessions:   [],
      loading:    true,
      error:      '',
      /** Which CLI the plain press of "New conversation" uses; '' reads as claude. */
      defaultCli: '',
      starting:   false,
      /** The conversation being forked, by id, while its copy is being made. */
      forking:    '',
      /** The conversation being renamed in its row, and the text so far. */
      renaming:   '',
      draft:      '',
      /** The conversation open over the list, by id, or '' for none. */
      chat:       '',
      /** How many of this component's layers have an entry in history: 0, 1 or 2. */
      entries:    0,
      timer:      null,
    };
  },

  computed: {
    CLI_CHOICES: () => CLI_CHOICES,

    /** What a row offers: the same set the drawer's tab and the workspace card carry. */
    ACTIONS: () => [
      { id: 'open', label: 'Open', icon: 'icon-chevron-right', what: 'Open this conversation' },
      { id: 'rename', label: 'Rename', icon: 'icon-edit', what: 'Give this conversation a name' },
      { id: 'fork', label: 'Fork', icon: 'icon-copy', what: 'Carry on from here in a new conversation' },
      { id: 'close', label: 'End', icon: 'icon-close', what: 'End this conversation' },
    ],

    /** Looked up fresh, so a refresh that replaces the list cannot strand the open one. */
    chatSession() {
      return this.sessions.find((s) => s.id === this.chat) || null;
    },
  },

  mounted() {
    readPrefs().then((prefs) => {
      this.defaultCli = prefs.cli || '';
    }).catch(() => {});
    window.addEventListener('popstate', this.onPop);
    this.push();
    this.refresh();
    this.timer = setInterval(() => this.pollStates(), STATES_POLL_MS);
  },

  beforeUnmount() {
    window.removeEventListener('popstate', this.onPop);
    clearInterval(this.timer);
  },

  methods: {
    // -----------------------------------------------------------------------
    // Layers, and the back gesture
    //
    // Each layer - the list, then a conversation over it - puts an entry in history as it
    // opens, so Android's back button and iOS's edge swipe close the top one rather than leaving
    // the page from under both. Every way out goes through history while there is an entry to
    // go back through, and `onPop` does the closing, so there is one path for all of them.
    // -----------------------------------------------------------------------

    push() {
      try {
        // Spread, because vue-router keeps its position in this object and reads it back.
        history.pushState({ ...history.state, [HISTORY_KEY]: this.entries + 1 }, '');
        this.entries += 1;
      } catch {
        // No entry: the layer still opens, and closes by its button and Escape alone.
      }
    },

    onPop() {
      if (this.entries) {
        this.entries -= 1;
      }
      if (this.chat) {
        this.chat = '';

        return;
      }
      this.$emit('close');
    },

    /** Close the top layer: back through its history entry if it has one, directly if not. */
    back() {
      const layers = this.chat ? 2 : 1;

      if (this.entries >= layers) {
        history.back();

        return;
      }
      this.onPop();
    },

    // -----------------------------------------------------------------------
    // The conversations
    // -----------------------------------------------------------------------

    async refresh() {
      this.loading = true;
      this.error = '';
      try {
        // Before the list, for the reason AgentPanel gives: a pane started before the pod has
        // this person's kubeconfig runs as nobody. Not fatal, and said rather than refused.
        await ensureAgentCredential().catch((e) => {
          this.error = `The agent has no Rancher identity: ${ e?.message || e }`;
        });
        this.sessions = arrange(await panelSessions(), readDrawerState().order || []);
      } catch (e) {
        this.error = e?.message || String(e);
      } finally {
        this.loading = false;
      }
    },

    /** The dots only; adding and removing rows is refresh's, so nothing moves under a thumb. */
    async pollStates() {
      if (this.loading) {
        return;
      }
      let fresh;

      try {
        fresh = await agentSessions();
      } catch {
        return;
      }
      const now = new Map(fresh.map((s) => [s.id, s]));

      this.sessions = this.sessions.map((s) => {
        const at = now.get(s.id);

        return at ? { ...s, title: this.renaming === s.id ? s.title : at.title, state: at.state } : { ...s, state: 'none' };
      });
    },

    open(session) {
      this.renaming = '';
      this.chat = session.id;
      this.push();
    },

    act(session, what) {
      if (what === 'rename') {
        this.renaming = session.id;
        this.draft = session.title || '';
        this.$nextTick(() => {
          const box = this.$refs.renameInput;

          (Array.isArray(box) ? box[0] : box)?.focus();
        });

        return;
      }
      if (what === 'fork') {
        this.fork(session);

        return;
      }
      if (what === 'close') {
        this.end(session);

        return;
      }
      this.open(session);
    },

    /** A new conversation, opened at once: on a phone the list is only the way to one. */
    async startNew(cli = '') {
      if (this.starting) {
        return;
      }
      this.starting = true;
      this.error = '';
      try {
        const id = await startAgentSession();
        const session = {
          id, title: conversationLabel(id), state: 'none', cli: cli === 'claude' ? '' : cli
        };

        this.sessions = [...this.sessions, session];
        this.open(session);
      } catch (e) {
        this.error = e?.message || String(e);
      } finally {
        this.starting = false;
      }
    },

    async fork(session) {
      if (this.forking) {
        return;
      }
      this.forking = session.id;
      this.error = '';
      try {
        const id = await forkAgentSession(session);

        await this.refresh();
        const copy = this.sessions.find((s) => s.id === id);

        if (copy) {
          this.open(copy);
        }
      } catch (e) {
        this.error = e?.message || String(e);
      } finally {
        this.forking = '';
      }
    },

    async end(session) {
      this.sessions = this.sessions.filter((s) => s.id !== session.id);
      try {
        await endAgentSession(session.id);
      } catch (e) {
        this.error = e?.message || String(e);
      }
    },

    async saveRename(session) {
      const title = this.draft.trim();

      this.renaming = '';
      if (!title || title === session.title) {
        return;
      }
      session.title = title;
      try {
        await renameAgentSession(session.id, title);
      } catch (e) {
        this.error = e?.message || String(e);
      }
    },
  },
};
</script>

<template>
  <!--
    `large`, not `full`: both are the whole screen on a phone, but `full` is the gallery's, with
    no panel and a veil the page shows through, and a list wants a surface of its own.
  -->
  <DevModal
    size="large"
    title="Conversations"
    @close="back"
  >
    <div class="global-convs">
      <p
        v-if="error"
        class="global-convs__error"
      >
        {{ error }}
      </p>
      <p
        v-if="loading && !sessions.length"
        class="global-convs__note"
      >
        <i class="icon icon-spinner icon-spin" /> Reading the agent pod
      </p>
      <p
        v-else-if="!sessions.length"
        class="global-convs__note"
      >
        No conversations yet. Start one below.
      </p>
      <div
        v-for="s in sessions"
        :key="s.id"
        class="global-convs__row"
      >
        <template v-if="renaming === s.id">
          <input
            ref="renameInput"
            v-model="draft"
            class="global-convs__input"
            type="text"
            :aria-label="`Rename ${ s.title || 'conversation' }`"
            @keyup.enter="saveRename(s)"
            @keydown.esc.stop="renaming = ''"
          >
          <RcButton
            variant="secondary"
            class="global-convs__ok"
            @click="saveRename(s)"
          >
            Save
          </RcButton>
        </template>
        <SplitButton
          v-else
          class="global-convs__chat"
          :label="s.title || 'Conversation'"
          :options="ACTIONS"
          :disabled="forking === s.id"
          value="open"
          @pick="(what) => act(s, what)"
        >
          <span
            class="global-convs__dot"
            :class="`global-convs__dot--${ s.state || 'none' }`"
          />
          <span class="global-convs__name">{{ s.title || 'Conversation' }}</span>
          <i
            class="icon global-convs__go"
            :class="forking === s.id ? 'icon-spinner icon-spin' : 'icon-chevron-right'"
          />
        </SplitButton>
      </div>
      <SplitButton
        class="global-convs__new"
        label="New conversation"
        :value="defaultCli"
        :options="CLI_CHOICES"
        :disabled="starting"
        @pick="startNew"
      >
        <i :class="starting ? 'icon icon-spinner icon-spin' : 'icon icon-plus'" />
        New conversation
      </SplitButton>
    </div>
  </DevModal>
  <!--
    The conversation, over the list rather than instead of it, so closing it lands back on the
    list. DevModal stacks it one above the list (see its `layer`), and an image or a file opened
    from inside the conversation goes one above that.
  -->
  <DevModal
    v-if="chatSession"
    size="large"
    :title="chatSession.title || 'Conversation'"
    @close="back"
  >
    <PodTerminal
      :key="chatSession.id"
      class="global-convs__terminal"
      :session="chatSession.id"
      :mode="chatSession.cli || ''"
    />
  </DevModal>
</template>

<style lang="scss" scoped>
.global-convs {
  display:        flex;
  flex-direction: column;
  gap:            8px;
  padding:        12px 16px calc(16px + env(safe-area-inset-bottom, 0px));
  overflow-y:     auto;
  flex:           1 1 auto;
  min-height:     0;
}

.global-convs__note,
.global-convs__error {
  margin:    0 0 4px;
  color:     var(--muted);
  font-size: 13px;
}

.global-convs__error { color: var(--error); }

.global-convs__row {
  display: flex;
  gap:     6px;
  width:   100%;
}

.global-convs__input {
  flex:          1 1 auto;
  min-width:     0;
  min-height:    44px;
  padding:       0 10px;
  border:        1px solid var(--primary);
  border-radius: var(--border-radius, 4px);
  background:    var(--input-bg);
  color:         var(--body-text);
  font:          inherit;
}

.global-convs__ok { flex: 0 0 auto; }

.global-convs__chat,
.global-convs__new { width: 100%; }

// The main half carries the row; the caret is an affordance beside it. As the workspace card.
.global-convs__chat :deep(.split-btn__main) {
  flex:            1 1 auto;
  display:         flex;
  align-items:     center;
  gap:             10px;
  justify-content: flex-start;
  text-align:      left;
  min-height:      44px;
}

.global-convs__chat :deep(.split-btn__more),
.global-convs__new :deep(.split-btn__more) {
  flex:       0 0 48px;
  min-height: 44px;
}

.global-convs__new :deep(.split-btn__main) {
  flex:       1 1 auto;
  min-height: 44px;
}

.global-convs__name {
  flex:          1 1 auto;
  min-width:     0;
  text-align:    left;
  overflow:      hidden;
  text-overflow: ellipsis;
  white-space:   nowrap;
}

.global-convs__go {
  flex:        0 0 auto;
  margin-left: auto;
  opacity:     .7;
}

/* The dot the drawer's tabs and the workspace card use, so "working" means one thing. */
.global-convs__dot {
  flex:          0 0 8px;
  width:         8px;
  height:        8px;
  border-radius: 50%;
  background:    var(--muted);
}

.global-convs__dot--working  { background: var(--status-running, var(--primary)); }
.global-convs__dot--input    { background: var(--status-input, var(--warning)); }
.global-convs__dot--finished { background: var(--status-done, var(--success)); }

/* Everything the dialog's header does not take, so the transcript scrolls inside it. */
.global-convs__terminal {
  flex:       1 1 auto;
  min-height: 0;
}
</style>
