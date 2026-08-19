<script>
// A terminal in a pod, ported from pkg/barn/components/PodTerminal.vue.
//
// The harness gives every project a persistent shell; here there is no server to run a pty,
// so the pty comes from Kubernetes: the exec subresource is a real TTY in the pod, reached
// through Rancher's cluster proxy and authenticated by the session cookie the page already
// has (see api.ts, podExecUrl).
//
// Which pod, and what to run in it, are the caller's to say: a workspace's Conversations tab
// and the global terminal are the same TTY on two different pods, and the only difference
// between them is a namespace, a label to find the pod by, and an argv.
//
// The protocol is `base64.channel.k8s.io`, the one the dashboard's own container shell
// speaks: each frame is a channel digit followed by base64. Channel 0 is stdin, 1 stdout,
// 2 stderr, 3 error, and 4 carries a JSON {Width, Height} on resize.
//
// The imports are `@xterm/*` rather than `xterm/*`: this dashboard is shell 3.x, which moved
// to the scoped packages, and the unscoped ones are not installed.
import { allHash } from '@shell/utils/promise';
import { base64Decode, base64Encode } from '@shell/utils/crypto';
import Socket, {
  EVENT_CONNECTED,
  EVENT_CONNECTING,
  EVENT_DISCONNECTED,
  EVENT_MESSAGE,
  EVENT_CONNECT_ERROR,
} from '@shell/utils/socket';
import { RcButton } from '@components/RcButton';
import { findPod, podExecUrl } from '../api';

// Channel prefixes, as above.
const STDIN = '0';
const STDOUT = '1';
const STDERR = '2';
const ERROR = '3';
const RESIZE = '4';

// How often to look for a running pod while there isn't one. A workspace that was just
// created is pulling an image, so this is a wait of seconds rather than an error.
const POD_POLL_MS = 3000;

export default {
  name: 'DevTerminal',

  components: { RcButton },

  // So a caller showing several of these can say which one is connected without reaching into
  // this component's state. The conversation list uses it for the dot on each row.
  emits: ['state'],

  props: {
    // Where to look for the pod, rather than which pod: a pod name changes across a stop and
    // start, and this is expected to survive that by finding the new one.
    namespace: {
      type:     String,
      required: true,
    },

    /** Every one of these has to match for a pod to be the one. */
    labels: {
      type:     Object,
      required: true,
    },

    /**
     * The workspace whose own pod this is, when it is a workspace's.
     *
     * A workspace's sidecars live in its namespace and carry its label, so the labels alone are
     * not enough to say which pod is the workspace: without this a conversation opens in
     * whichever of them the collection happens to list first, and asks for a container called
     * `workspace` that a browser sidecar does not have. See findPod.
     */
    own: {
      type:    String,
      default: '',
    },

    container: {
      type:     String,
      required: true,
    },

    /** argv, run on a TTY. */
    command: {
      type:     Array,
      required: true,
    },
  },

  data() {
    return {
      // 'waiting' (no pod yet) | 'connecting' | 'open' | 'closed'
      state:          'waiting',
      error:          '',
      pod:            '',
      terminal:       null,
      fitAddon:       null,
      canvasAddon:    null,
      socket:         null,
      // Input typed before the socket opened, replayed on connect.
      backlog:        [],
      resizeObserver: null,
      podPollTimer:   null,
      unmounted:      false,
      // Which attempt at attaching speaks for this pane. Everything that starts one takes the
      // next number and carries it through its awaits, so an attempt that has been superseded
      // can tell, and does nothing. See reconnect for what that is protecting against.
      generation:     0,
      // Set while recoverIfPodChanged has not yet worked out why the socket closed.
      deciding:       false,
    };
  },

  computed: {
    statusText() {
      return {
        waiting:    'Waiting for the pod',
        connecting: 'Connecting',
        closed:     'Disconnected',
      }[this.state] || '';
    },

    /**
     * What the overlay says: the reason the connection ended, or failing that the state.
     *
     * The exec's parting words are held back while recoverIfPodChanged is still deciding why
     * the socket closed. On the ordinary Stop path they are the apiserver reporting a SIGKILL
     * as `exit code 137`, which describes nothing the person did not just ask for, and a beat
     * later this pane is waiting for a pod anyway. They are worth showing only in the case
     * that survives that decision: the pod is still there and its shell exited.
     */
    statusMessage() {
      return (this.deciding ? '' : this.error) || this.statusText;
    },
  },

  watch: {
    // Being pointed at a different pod is a different terminal, so the socket onto the old one
    // is dropped rather than left open behind a pane that has moved on.
    namespace() {
      this.reconnect();
    },

    state(state) {
      this.$emit('state', state);
    },
  },

  async mounted() {
    await this.setupTerminal();
    this.connectWhenPodIsUp(this.nextGeneration());
  },

  beforeUnmount() {
    this.unmounted = true;
    clearTimeout(this.podPollTimer);
    this.resizeObserver?.disconnect();
    this.socket?.disconnect();
    // The renderer addon goes first. Disposing the terminal out from under it is what makes
    // xterm throw on the way out of the page, which is the shell's own lesson in
    // components/Window/ContainerShell.vue.
    this.canvasAddon?.dispose();
    this.canvasAddon = null;
    this.terminal?.dispose();
  },

  methods: {
    /** Claim the pane for a new attempt at attaching, which supersedes every earlier one. */
    nextGeneration() {
      this.generation += 1;

      return this.generation;
    },

    /**
     * Whether an attempt still speaks for the pane.
     *
     * Every await below is a place the pane can be restarted underneath the caller: Reconnect
     * clicked, the pod pointed somewhere else, the page gone. Asking this after each one is what
     * keeps a superseded attempt from opening a second socket onto the pod.
     */
    isCurrent(generation) {
      return !this.unmounted && generation === this.generation;
    },

    async setupTerminal() {
      const style = getComputedStyle(document.body);
      const color = (name) => style.getPropertyValue(name).trim() || undefined;

      const xterm = await import(/* webpackChunkName: "xterm" */ '@xterm/xterm');
      const addons = await allHash({
        fit:    import(/* webpackChunkName: "xterm" */ '@xterm/addon-fit'),
        canvas: import(/* webpackChunkName: "xterm" */ '@xterm/addon-canvas'),
      });

      // The two imports above are the only slow thing in here, and a pane can be gone by the
      // time they resolve: the shell keys its router-view on the path, so moving to another of
      // a workspace's tabs unmounts this page while it is still loading xterm. Opening a
      // Terminal on the element that pane no longer has throws inside xterm ("Terminal
      // requires a parent element"), which is a crash rather than a tab change.
      if (this.unmounted || !this.$refs.xterm) {
        return;
      }

      const terminal = new xterm.Terminal({
        allowProposedApi: true,
        cursorBlink:      true,
        fontSize:         13,
        fontFamily:       'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        // Rancher's own terminal colours, so this matches the dashboard's theme and follows
        // it between light and dark.
        theme:            {
          background:          color('--terminal-bg'),
          foreground:          color('--terminal-text'),
          cursor:              color('--terminal-cursor'),
          selectionBackground: color('--terminal-selection'),
        },
      });

      this.fitAddon = new addons.fit.FitAddon();
      terminal.loadAddon(this.fitAddon);

      // open() before the renderer addon, not after: the canvas renderer builds its layers
      // out of services that only exist once the terminal has an element, and loading it
      // first throws inside xterm rather than here. Canvas rather than webgl because webgl
      // contexts are a limited per-page resource, and this dashboard is itself framed inside
      // another one.
      terminal.open(this.$refs.xterm);
      this.canvasAddon = new addons.canvas.CanvasAddon();
      terminal.loadAddon(this.canvasAddon);

      terminal.onData((input) => this.send(STDIN + base64Encode(input)));

      this.terminal = terminal;

      // The page is a detail page whose other half can grow, and the window resizes too, so
      // the size is watched rather than taken once.
      this.resizeObserver = new ResizeObserver(() => this.fit());
      this.resizeObserver.observe(this.$refs.xterm);
      this.fit();
    },

    // Wait for a pod, then connect. A workspace that has just been created or started is
    // pulling and scheduling, so this is a wait rather than an error.
    async connectWhenPodIsUp(generation) {
      // Whatever the last connection died of stops being the news the moment this starts
      // looking for a new pod. Stopping a workspace kills the exec, which arrives on channel
      // 3 as `exit code 137`, and without this that sentence is what the pane says for as
      // long as the workspace stays stopped, instead of saying it is waiting for a pod.
      this.error = '';
      // Nor is there a question left about why the last socket closed: starting again is the
      // answer, whoever was asking.
      this.deciding = false;

      while (this.isCurrent(generation)) {
        const pod = await findPod(this.namespace, this.labels, this.own).catch(() => null);

        if (!this.isCurrent(generation)) {
          return;
        }

        if (pod) {
          this.pod = pod;
          this.connect(pod, generation);

          return;
        }

        this.state = 'waiting';
        await new Promise((resolve) => {
          this.podPollTimer = setTimeout(resolve, POD_POLL_MS);
        });
      }
    },

    connect(pod, generation) {
      const url = podExecUrl(this.namespace, pod, this.container, this.command);
      const socket = new Socket(url, false, 0, 'base64.channel.k8s.io');

      socket.addEventListener(EVENT_CONNECTING, () => {
        this.state = 'connecting';
        this.error = '';
      });

      socket.addEventListener(EVENT_CONNECTED, () => {
        this.state = 'open';
        this.fit();
        this.flush();
        this.terminal?.focus();
      });

      socket.addEventListener(EVENT_CONNECT_ERROR, () => {
        this.state = 'closed';
        this.error = 'Could not open a shell in the pod';
      });

      socket.addEventListener(EVENT_DISCONNECTED, () => {
        // A socket from a superseded attempt has nothing to say about the pane: reconnect
        // takes the next generation before it closes one, so a close this component asked for
        // arrives here already answered.
        if (!this.isCurrent(generation)) {
          return;
        }

        this.state = 'closed';
        this.deciding = true;
        this.recoverIfPodChanged(pod, generation);
      });

      socket.addEventListener(EVENT_MESSAGE, (event) => {
        const data = event.detail.data;
        const channel = data.substr(0, 1);
        const message = base64Decode(data.substr(1));

        // stdout and stderr are both the pane; there is one TTY behind them.
        if (channel === STDOUT || channel === STDERR) {
          this.terminal?.write(message);

          return;
        }

        if (channel === ERROR && message) {
          // Not output: a Status object saying how the exec ended. Printing it would put
          // `{"status":"Success"}` on screen every time a shell exits normally, so only a
          // failure is worth surfacing, and as a status rather than as terminal output.
          try {
            const status = JSON.parse(message);

            if (status.status !== 'Success') {
              this.error = status.message || 'The shell exited with an error';
            }
          } catch {
            this.error = message;
          }
        }
      });

      this.socket = socket;
      socket.connect();
    },

    /**
     * Follow the workspace when a stop and start replaces its pod.
     *
     * Losing the socket is two different events wearing the same clothes: the pod went away,
     * or the shell in it exited. Reconnecting on both would make `exit` an infinite loop of
     * shells nobody asked for, and reconnecting on neither would leave the pane dead after
     * every stop and start. Which one happened is answered by asking whether the pod this was
     * attached to is still there, after a beat, since the API takes a moment to admit a pod
     * is terminating.
     *
     * The answer is only worth having while the attempt that asked the question is still the
     * live one, which is what the generation is checked for on the way out of each await.
     */
    async recoverIfPodChanged(pod, generation) {
      await new Promise((resolve) => {
        this.podPollTimer = setTimeout(resolve, POD_POLL_MS);
      });

      if (!this.isCurrent(generation)) {
        return;
      }

      const current = await findPod(this.namespace, this.labels, this.own).catch(() => null);

      if (!this.isCurrent(generation)) {
        return;
      }

      // Decided either way, so whatever the exec said is either about to be replaced by the
      // wait for a new pod, or is the only explanation this pane has for sitting closed.
      this.deciding = false;

      if (current !== pod) {
        this.reconnect();
      }
    },

    /**
     * Throw away this attachment and start again from wherever the workspace is now.
     *
     * The generation is taken on the first line, before anything is awaited, because the
     * click that gets here can land while recoverIfPodChanged is asleep in the middle of
     * deciding why the last socket closed. Taking it here is what makes that decision moot:
     * it wakes, finds it is no longer the live attempt, and returns. The flag this replaces
     * was cleared as soon as the disconnect resolved, so whether it caught that decision came
     * down to which of two timers fired first, and when it missed the pane ended up with two
     * poll loops, two sockets and two shells in the pod, only one of them taking keystrokes.
     */
    async reconnect() {
      const generation = this.nextGeneration();

      // A disconnect that ends in an error is still a disconnect: the socket has been closed
      // by the time it says so, and a rejection here would leave the pane holding a
      // generation nothing will ever finish, which is the one state Reconnect cannot fix.
      await this.socket?.disconnect().catch(() => {});

      if (!this.isCurrent(generation)) {
        return;
      }

      this.socket = null;
      this.pod = '';
      this.terminal?.reset();
      this.connectWhenPodIsUp(generation);
    },

    send(frame) {
      if (this.state === 'open') {
        this.socket.send(frame);
      } else {
        this.backlog.push(frame);
      }
    },

    flush() {
      const backlog = this.backlog;

      this.backlog = [];
      backlog.forEach((frame) => this.socket.send(frame));
    },

    fit() {
      if (!this.fitAddon || !this.$refs.xterm?.clientWidth) {
        return;
      }

      this.fitAddon.fit();

      if (this.state !== 'open') {
        return;
      }

      const { cols, rows } = this.fitAddon.proposeDimensions() || {};

      // The far side is a TTY with a size of its own; without this frame it keeps the 80x24
      // it was opened with and wraps everything in the wrong place.
      if (cols && rows) {
        this.send(RESIZE + base64Encode(JSON.stringify({ Width: Math.floor(cols), Height: Math.floor(rows) })));
      }
    },
  },
};
</script>

<template>
  <div class="dev-terminal">
    <div
      ref="xterm"
      class="dev-terminal__xterm"
    />
    <div
      v-if="state !== 'open'"
      class="dev-terminal__status"
    >
      <span>{{ statusMessage }}</span>
      <RcButton
        v-if="state === 'closed'"
        variant="link"
        size="small"
        @click="reconnect"
      >
        Reconnect
      </RcButton>
    </div>
  </div>
</template>

<style lang="scss">
// Not scoped. The shell prepends xterm's own stylesheet to every scss block it compiles (see
// its vue.config.js), and scoping this one would rewrite those rules to match only elements
// the template rendered - which is none of xterm's, since it builds its DOM at runtime.
.dev-terminal {
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  height: 100%;
  padding: 6px 0 0 8px;
  border: 1px solid var(--border);
  border-radius: var(--border-radius);
  background: var(--terminal-bg, var(--body-bg));

  &__xterm {
    flex: 1 1 auto;
    min-height: 0;
    // A stacking context of its own, so xterm's render layers stay inside it. They carry
    // z-indexes up to 11, and without this they are peers of the status overlay below and
    // the cursor layer ends up on top of the Reconnect button, swallowing the click. The
    // pane then has no way back short of a page reload.
    position: relative;
    z-index: 0;
  }

  &__status {
    // Above the box that contains xterm, which is all it has to beat now.
    z-index: 1;
    position: absolute;
    right: 10px;
    bottom: 8px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 10px;
    border: 1px solid var(--border);
    border-radius: var(--border-radius);
    background: var(--body-bg);
    color: var(--muted);
    font-size: 12px;
  }
}
</style>
