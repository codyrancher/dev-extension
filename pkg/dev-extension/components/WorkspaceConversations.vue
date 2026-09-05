<script>
// A workspace's conversations, and one shell into the workspace itself.
//
// The conversations run in Extension Studio's agent pod, namespaced by this workspace's name -
// see conversations.ts for why that is where they are and how the Studio's drawer never sees
// them. They are there the moment the workspace exists: the agent pod is always up, so a
// conversation can be opened, and a prompt queued for it, while the workspace's own pod is
// still cloning and compiling.
//
// The shell is the other thing: a bash in the workspace's container, in its checkout, for when
// what is wanted is the tree rather than a conversation about it. It is the one row that does
// wait for the workspace's pod.
import { RcButton } from '@components/RcButton';
import { Banner } from '@components/Banner';
import DevTerminal from './DevTerminal.vue';
import DevList from './DevList.vue';
import {
  LABEL_WORKSPACE, WORKSPACE_CONTAINER, workspaceTerminalCommand
} from '../api';
import {
  listConversations, startConversation, endConversation, renameConversation, paneFor
} from '../conversations';

const ROW_STATE = {
  open: 'running', connecting: 'starting', waiting: 'starting', closed: 'stopped'
};

/** The row key of the workspace's own shell, which is not a conversation. */
const SHELL = 'shell';

export default {
  name: 'WorkspaceConversations',

  components: {
    RcButton, Banner, DevTerminal, DevList
  },

  props: {
    workspace: {
      type:     Object,
      required: true,
    },
    logTail: {
      type:    String,
      default: '',
    },
  },

  async fetch() {
    await this.load();
  },

  data() {
    return {
      conversations: [],
      current:       '',
      states:        {},
      error:         '',
      renaming:      '',
      draft:         '',
    };
  },

  computed: {
    ready() {
      return this.workspace.state === 'running' || this.workspace.state === 'starting';
    },

    failing() {
      return this.workspace.state === 'error';
    },

    progress() {
      return this.workspace.detail || 'Starting';
    },

    podLabels() {
      return { [LABEL_WORKSPACE]: this.workspace.name };
    },

    container() {
      return WORKSPACE_CONTAINER;
    },

    rows() {
      return [
        ...this.conversations.map((conversation) => ({
          key:   conversation.id,
          label: conversation.title,
          state: ROW_STATE[this.states[conversation.id]] || 'stopped',
        })),
        {
          key:   SHELL,
          label: 'Workspace shell',
          state: ROW_STATE[this.states[SHELL]] || (this.ready ? 'stopped' : 'starting'),
        },
      ];
    },

    showingShell() {
      return this.current === SHELL;
    },
  },

  methods: {
    async load() {
      this.error = '';

      try {
        this.conversations = await listConversations(this.workspace.name);
      } catch (e) {
        this.error = e.message || String(e);
        this.conversations = [];
      }

      if (!this.current || !this.rows.some((row) => row.key === this.current)) {
        this.current = this.conversations[0]?.id || SHELL;
      }
    },

    paneFor(conversation) {
      return paneFor(conversation);
    },

    shellCommand() {
      return [...workspaceTerminalCommand('shell').slice(0, 4), 'shell'];
    },

    async newConversation() {
      this.error = '';

      try {
        const conversation = await startConversation(this.workspace.name);

        this.conversations = [...this.conversations, conversation];
        this.current = conversation.id;
      } catch (e) {
        this.error = e.message || String(e);
      }
    },

    async closeConversation(key) {
      if (key === SHELL) {
        return;
      }

      this.error = '';

      try {
        await endConversation(this.workspace.name, key);
      } catch (e) {
        this.error = e.message || String(e);

        return;
      }

      this.conversations = this.conversations.filter((conversation) => conversation.id !== key);

      if (this.current === key) {
        this.current = this.conversations[this.conversations.length - 1]?.id || SHELL;
      }

      const states = { ...this.states };

      delete states[key];
      this.states = states;
    },

    startRename(key) {
      const conversation = this.conversations.find((entry) => entry.id === key);

      if (!conversation) {
        return;
      }

      this.renaming = key;
      this.draft = conversation.title;
    },

    async commitRename() {
      const key = this.renaming;
      const title = this.draft.trim();

      this.renaming = '';

      if (!key || !title) {
        return;
      }

      try {
        await renameConversation(this.workspace.name, key, title);
        this.conversations = this.conversations.map((entry) => (entry.id === key ? { ...entry, title } : entry));
      } catch (e) {
        this.error = e.message || String(e);
      }
    },

    onState(key, state) {
      this.states = { ...this.states, [key]: state };
    },
  },
};
</script>

<template>
  <div class="workspace-conversations">
    <!--
      The same column the sidebar's workspaces are, and for the same reasons: a conversation has
      a state worth a dot, is created from the heading, and can be closed from its own row. No
      heading text - the tab above says Conversations.
    -->
    <div class="workspace-conversations__list">
      <DevList
        label=""
        icon="icon-comment"
        :rows="rows"
        :current="current"
        create-label="New conversation"
        empty="No conversations"
        deletable
        @select="current = $event"
        @create="newConversation"
        @delete="closeConversation"
      />
      <div
        v-if="current && !showingShell"
        class="workspace-conversations__rename"
      >
        <input
          v-if="renaming === current"
          v-model="draft"
          class="workspace-conversations__rename-input"
          type="text"
          aria-label="Conversation name"
          @keydown.enter.prevent="commitRename"
          @keydown.esc.prevent="renaming = ''"
          @blur="commitRename"
        >
        <RcButton
          v-else
          variant="tertiary"
          size="small"
          left-icon="edit"
          @click="startRename(current)"
        >
          Rename
        </RcButton>
      </div>
    </div>
    <div class="workspace-conversations__pane">
      <Banner
        v-if="error"
        color="error"
        :label="error"
      />
      <!-- The shell is the one pane that waits for the workspace's own pod. -->
      <Banner
        v-if="showingShell && failing"
        color="error"
      >
        <p>This workspace is not staying up: {{ progress }}.</p>
        <p
          v-if="logTail"
          class="workspace-conversations__log"
        >
          {{ logTail }}
        </p>
      </Banner>
      <Banner
        v-else-if="showingShell && !ready"
        color="info"
      >
        <p>{{ progress }}. A workspace that clones a repository and installs it takes a few minutes on its first start.</p>
        <p
          v-if="logTail"
          class="workspace-conversations__log"
        >
          {{ logTail }}
        </p>
      </Banner>
      <DevTerminal
        v-for="conversation in conversations"
        v-show="conversation.id === current"
        :key="conversation.id"
        class="workspace-conversations__terminal"
        v-bind="paneFor(conversation)"
        @state="onState(conversation.id, $event)"
      />
      <DevTerminal
        v-if="ready"
        v-show="showingShell"
        key="shell"
        class="workspace-conversations__terminal"
        :namespace="workspace.namespace"
        :labels="podLabels"
        :own="workspace.name"
        :container="container"
        :command="shellCommand()"
        :cluster="workspace.cluster"
        @state="onState('shell', $event)"
      />
    </div>
  </div>
</template>

<style lang="scss" scoped>
  .workspace-conversations {
    display:    flex;
    flex:       1 1 auto;
    min-height: 0;

    &__list {
      display:        flex;
      flex-direction: column;
      flex:           0 0 220px;
      overflow-y:     auto;
      border-right:   1px solid var(--border);
    }

    &__rename {
      padding: var(--dev-space-2) var(--dev-space-3);
    }

    &__rename-input {
      width: 100%;
    }

    &__pane {
      display:        flex;
      flex-direction: column;
      flex:           1 1 auto;
      min-width:      0;
    }

    &__log {
      overflow:      hidden;
      margin:        var(--dev-space-3) 0 0 0;
      font-family:   monospace;
      font-size:     12px;
      white-space:   nowrap;
      text-overflow: ellipsis;
    }

    &__terminal {
      flex:       1 1 auto;
      min-height: 0;
    }
  }
</style>
