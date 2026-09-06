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
import { Banner } from '@components/Banner';
import DevTerminal from './DevTerminal.vue';
import StudioTerminal from './StudioTerminal.vue';
import DevList from './DevList.vue';
import {
  LABEL_WORKSPACE, WORKSPACE_CONTAINER, workspaceTerminalCommand
} from '../api';
import {
  listConversations, startConversation, endConversation, renameConversation, STUDIO_CLUSTER, KUBECTL
} from '../conversations';
import { prepareWorkspace } from '../reviews';
import { ensureDefaultShare } from '../previews';

const ROW_STATE = {
  open: 'running', connecting: 'starting', waiting: 'starting', closed: 'stopped'
};

/** The row key of the workspace's own shell, which is not a conversation. */
const SHELL = 'shell';

export default {
  name: 'WorkspaceConversations',

  components: {
    Banner, DevTerminal, StudioTerminal, DevList
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
      prepared: false,
      conversations: [],
      current:       '',
      states:        {},
      error:         '',
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
        // The shell needs a pod that has the terminal scripts mounted, which a preview's nginx
        // does not; a preview does not show this tab at all, but the row is guarded here too.
        ...(this.workspace.preview ? [] : [{
          key:   SHELL,
          label: 'Workspace shell',
          fixed: true,
          state: ROW_STATE[this.states[SHELL]] || (this.ready ? 'stopped' : 'starting'),
        }]),
      ];
    },

    showingShell() {
      return this.current === SHELL;
    },

    /**
     * Whether the workspace's shell can be reached through the agent pod.
     *
     * Every pane here is the Studio's, on the Studio's agent pod, for one reason: one pod means
     * one exec path and one cookie to authenticate it. The shell into the workspace's own
     * container goes the same way when it can - the agent pod has kubectl and a cluster-admin
     * account on its own cluster, so it execs into the workspace's pod from there. A workspace
     * on another cluster is out of that reach, and its shell opens directly, as it always did.
     */
    shellViaAgent() {
      return (this.workspace.cluster || 'local') === STUDIO_CLUSTER;
    },

    /** The argv the agent pod runs to land in the workspace's container: kubectl, then the workspace's own shell.sh. */
    shellViaAgentCommand() {
      return [
        ...KUBECTL,
        'exec', '-i', '-t', '-n', this.workspace.namespace, `deploy/${ this.workspace.namespace }`, '-c', WORKSPACE_CONTAINER, '--',
        ...this.shellCommand(),
      ];
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

      // The workspace made ready for whatever gets typed into a pane: the harness's skills,
      // gh, the env. Once per page, in the background; a pane opened before it finishes is a
      // claude that starts a moment before its skills are all there.
      if (this.ready && !this.prepared) {
        this.prepared = true;
        prepareWorkspace(this.workspace.name)
          // Shared by default: the checkout built and put on a link, the first time it is ready.
          .then(() => ensureDefaultShare(this.$store, this.workspace.name, this.workspace.cluster || 'local').catch(() => {}))
          .catch((e) => {
            this.prepared = false;
            // A pod that is not up yet is the ordinary case on a new workspace, and the row
            // above already says it is starting; only a real failure is worth a banner.
            if (!/no running pod yet/.test(String(e?.message || e))) {
              this.error = `The workspace could not be prepared for the harness's skills: ${ e?.message || e }`;
              console.error('[dev] preparing the workspace failed', e); // eslint-disable-line no-console
            }
          });
      }
    },

    /** shell.sh's four arguments (session, checkout, home) and then the mode: a shell, not claude. */
    shellCommand() {
      return [...workspaceTerminalCommand('shell'), 'shell'];
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

    /** A row's new name, from the list: the shell row is not a conversation and cannot be renamed. */
    async rename({ key, title }) {
      if (key === SHELL || !title) {
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
        renamable
        @select="current = $event"
        @create="newConversation"
        @delete="closeConversation"
        @rename="rename"
      />
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
      <!--
        Every conversation is the Studio's own pane onto its agent pod, placed here. The Studio
        hands the component over (conversations.ts, studioApi); what this says is which
        conversation, by its id.
      -->
      <StudioTerminal
        v-for="conversation in conversations"
        v-show="conversation.id === current"
        :key="conversation.id"
        class="workspace-conversations__terminal"
        :session="conversation.id"
        :command="conversation.attach.command"
        @state="onState(conversation.id, $event)"
      />
      <StudioTerminal
        v-if="ready && shellViaAgent"
        v-show="showingShell"
        key="shell-via-agent"
        class="workspace-conversations__terminal"
        :command="shellViaAgentCommand"
        @state="onState('shell', $event)"
      />
      <DevTerminal
        v-else-if="ready"
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
