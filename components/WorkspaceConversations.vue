<script>
// A workspace's conversations: a list down the left, the open one filling the rest.
//
// The harness gives a project many conversations rather than one terminal, and this is that. A
// conversation is claude in the workspace's own pod, numbered by the same function the drawer's
// terminals are numbered with, so the two cannot come to disagree about what the numbers mean.
//
// It is claude in every workspace and there is no other kind. It used to be a bare shell with a
// paragraph above it explaining that it was one; what was missing was never the install, which is
// seconds, but the two things around it, and both are now the workspace's own: the scripts are
// mounted at /seed (see ensureWorkspaceTerminal) and the template hands the tree to an ordinary
// user and installs the CLI on boot.
//
// Every conversation that has been opened stays mounted, hidden rather than destroyed, so
// switching between them keeps both alive. Closing one is what the row's delete does, and it is
// only the browser's end: the pane is a tmux session in the pod, so a conversation outlives the
// page and reopening the tab lands back in it.
import { RcButton } from '@components/RcButton';
import { Banner } from '@components/Banner';
import DevTerminal from './DevTerminal.vue';
import DevList from './DevList.vue';
import { nextNumber } from '../terminals';
import {
  LABEL_WORKSPACE, WORKSPACE_CONTAINER, workspaceTerminalCommand, deleteWorkspaceConversation,
  listWorkspaceConversations
} from '../api';

/**
 * A pane's own connection state, as one of Rancher's, so the row's dot is the same dot a
 * workspace's row has. DevList knows about states, not about sockets.
 */
const ROW_STATE = {
  open: 'running', connecting: 'starting', waiting: 'starting', closed: 'stopped'
};

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

    // The last line the container printed, while it is still coming up. The page fetches it,
    // because it is the only honest answer to "what is it doing" during a five minute boot.
    logTail: {
      type:    String,
      default: '',
    },

  },

  data() {
    return {
      // The numbers that have been opened, in order, and which one is showing. Seeded from the
      // pod on the way up, since a conversation is a tmux session that was probably already
      // there before this page was. See adopt.
      conversations: [1],
      current:       1,
      // number -> the pane's own connection state, for the dot on its row.
      states:        {},
    };
  },

  async fetch() {
    await this.adopt();
  },

  computed: {
    /**
     * Whether there is anything to talk to yet.
     *
     * Conversations is the first tab and the default, so it is the tab that has to explain a
     * workspace which is not ready: cloning, installing, compiling, crash-looping, or stopped.
     * Showing a terminal that will never connect would be the same page saying nothing.
     */
    ready() {
      return this.workspace.state === 'running' || this.workspace.state === 'starting';
    },


    failing() {
      return this.workspace.state === 'error';
    },

    /** What the pod itself says it is doing, with the log line under it when there is one. */
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
      return this.conversations.map((number) => ({
        key:   number,
        label: `chat-${ number }`,
        // The pane's own socket, as a state, so the dot means what it means everywhere else.
        state: ROW_STATE[this.states[number]] || 'stopped',
      }));
    },
  },

  methods: {
    /**
     * Take on whatever conversations the workspace already has.
     *
     * Once, on the way up, rather than on a poll: after this the page is the thing creating and
     * deleting them, and a poll would be asking the pod to confirm what this component just did.
     */
    async adopt() {
      const existing = await listWorkspaceConversations(this.workspace.name).catch(() => []);

      if (!existing.length) {
        return;
      }

      this.conversations = existing;
      this.current = existing[0];
    },

    /** The next number, from the same function the drawer's terminals are numbered with. */
    newConversation() {
      const number = nextNumber(this.conversations);

      this.conversations = [...this.conversations, number];
      this.current = number;
    },

/**
     * Delete a conversation, in the pod as well as here.
     *
     * Unmounting the pane only closes a socket. The conversation is a tmux session in the
     * workspace, so it would carry on without it, and since numbers are reused a later
     * conversation with the same number would reattach to it — a delete that turns out to have
     * been a hide. See deleteWorkspaceConversation.
     *
     * The last one is not deletable: an empty column with no pane beside it is a tab with
     * nothing in it, and New conversation would be the only thing on the page.
     */
    closeConversation(number) {
      if (this.conversations.length < 2) {
        return;
      }

      const remaining = this.conversations.filter((entry) => entry !== number);

      this.conversations = remaining;

      if (this.current === number) {
        this.current = remaining[remaining.length - 1];
      }

      const states = { ...this.states };

      delete states[number];
      this.states = states;

      // After the pane is gone, so the socket it holds is not the thing being killed underneath
      // it, and unawaited: the column has already moved on and there is nothing to report.
      deleteWorkspaceConversation(this.workspace.name, number);
    },

    /** What one conversation runs, which is its own tmux session in the workspace's pod. */
    commandFor(number) {
      return workspaceTerminalCommand(number);
    },

    onState(number, state) {
      this.states = { ...this.states, [number]: state };
    },
  },
};
</script>

<template>
  <div class="workspace-conversations">
    <!--
      The same column the sidebar's workspaces are, and for the same reasons: a conversation has
      a state worth a dot, is created from the heading, and can be closed from its own row.
    -->
    <!--
      No heading text. The tab above this says Conversations, and a column that repeats its own
      tab's name is a line of chrome saying nothing. The row itself stays, because it is where
      the control that makes another one lives.
    -->
    <DevList
      class="workspace-conversations__list"
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

    <div class="workspace-conversations__pane">
      <Banner
        v-if="failing"
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
        v-else-if="!ready"
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
        v-for="row in (ready ? rows : [])"
        v-show="row.key === current"
        :key="row.key"
        class="workspace-conversations__terminal"
        :namespace="workspace.namespace"
        :labels="podLabels"
        :own="workspace.name"
        :container="container"
        :command="commandFor(row.key)"
        @state="onState(row.key, $event)"
      />
    </div>
  </div>
</template>

<style lang="scss" scoped>
  .workspace-conversations {
    display:    flex;
    flex:       1 1 auto;
    min-height: 0;
    // No gap: the column's own right border is the divider between the two, and a gap as well
    // put a strip of page between that line and the pane's, which reads as two edges rather
    // than one. The pane's padding is what keeps the terminal off it.

    // The column is DevList's, so everything about a row is its stylesheet's. What is left here
    // is the column's place on the tab: a fixed rail down the left, scrolling on its own when
    // there are more conversations than fit.
    &__list {
      // Wide enough for the heading and its create control side by side, which 180px was not:
      // the word CONVERSATIONS ran under the plus.
      flex:         0 0 210px;
      overflow-y:   auto;
      border-right: 1px solid var(--border);
    }

    &__pane {
      display:        flex;
      flex-direction: column;
      flex:           1 1 auto;
      min-width:      0;
    }

    &__note {
      max-width:     80ch;
      margin-bottom: var(--dev-space-4);
      color:         var(--muted);
    }


    // The container's own last line. Monospace because it is output, and truncated to one line
    // because this is a status, not a log viewer: the terminal is the log viewer.
    &__log {
      overflow:      hidden;
      margin:        var(--dev-space-3) 0 0 0;
      font-family:   monospace;
      font-size:     12px;
      white-space:   nowrap;
      text-overflow: ellipsis;
    }

    // Flush: the column's right border and the tab strip's bottom border are already the two
    // edges this pane has, so the terminal's own frame and any padding around it would be a
    // second edge a few pixels inside the first. It is the whole of the pane here, the way the
    // Browser tab's frame is the whole of that one.
    // The class lands on DevTerminal's own root element, which is where its frame is drawn, so
    // this overrides it rather than reaching into it.
    &__terminal {
      flex:          1 1 auto;
      min-height:    320px;
      border:        0;
      border-radius: 0;
    }
  }
</style>
