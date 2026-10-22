<script>
// What a leased workspace has attached, and the two buttons that change it.
//
// A leased (`lte-`) workspace holds the work and runs nothing: a dev server, a storybook, a
// Rancher and a browser are attached while the work needs them and released when it does not.
// This is that list, and it is a component of its own because both views onto a workspace need
// it - the stage rail, which only exists for a workspace named after an issue or a pull request,
// and the tabbed view, which is what everything else gets.
//
// Every button here is one call to dev-api, which is also what the agent's `tools` command
// calls. So a dev server attached from a conversation appears on this list, and one released
// here is gone for the agent too; there is no second path that can drift.
import {
  workspaceTools, startTool, stopTool, renewTool, toolHref, toolState, TOOLS, TOOLS_SHOWN
} from '../tools';
import { DEFAULT_LEASE_MINUTES } from '../config/constants';
import DevModal from './DevModal';
import {
  previewState, shareWorkspace, rebuildPreview, removePreview, retargetPreview, preferredShareHost,
} from '../previews';
import { listRanchers } from '../ranchers';

export default {
  name: 'WorkspaceTools',

  components: { DevModal },

  props: {
    /** The workspace's name. */
    workspace: {
      type:     String,
      required: true,
    },

    /**
     * Whether this workspace's stage has nothing to serve - a fix waiting on a reviewer, or one
     * already merged. The dev server is released once when it becomes true, because a webpack
     * compiling for somebody who is not coming back is the most expensive idle thing on the
     * node. Never against a person who has just attached one: see `kept` below.
     */
    idleStage: {
      type:    Boolean,
      default: false,
    },

    /** Laid out as one row across the page rather than as a box of rows. */
    inline: {
      type:    Boolean,
      default: false,
    },
  },

  emits: ['notice', 'error'],

  data() {
    return {
      tools:    [],
      busy:     '',
      /** Whether this visit has already released the dev server for a stage that cannot use it. */
      released: false,
      timer:    null,
      /*
       * The two shares, beside the tools rather than on a tab of their own.
       *
       * A share is not a leased tool - it is an Installation that outlives the lease and has a
       * public address - but it answers the same question the tools row answers, "what can
       * this workspace give me", and it was two clicks away on another tab.
       */
      shares:   { dashboard: null, storybook: null },
      /** Which Rancher a share talks to; the starred one unless somebody picks another. */
      ranchers: [],
      shareBusy: '',
      /** The share kind whose Rancher is being chosen, '' when the modal is shut. */
      picking:   '',
    };
  },

  computed: {
    /**
     * Every kind, running or not, in the order they are offered.
     *
     * All four are listed whether or not they are attached, because the list's job is as much to
     * say what *can* be attached as what is: the agent knows the four, and the person looking at
     * the page should not have to.
     */
    /** The two shares, as rows of the same shape the tools use. */
    shareRows() {
      return [
        { kind: 'dashboard', label: 'Rancher share', icon: 'icon-cloud', what: 'Build this branch and serve it on a public address' },
        { kind: 'storybook', label: 'Storybook share', icon: 'icon-folder', what: 'Build this branch\'s Storybook and serve it on a public address' },
      ].map((row) => {
        const state = this.shares[row.kind];

        return {
          ...row,
          state,
          // The public sslip name when there is one, else whatever address it has.
          href:  state?.host ? `https://${ state.host }` : (state?.url || ''),
          up:    !!state?.url || !!state?.host,
          where:     state?.rancherUrl || '',
          whereName: (this.ranchers.find((r) => r.url === state?.rancherUrl) || {}).name || '',
        };
      });
    },

    rows() {
      return TOOLS_SHOWN.map((kind) => {
        const tool = this.tools.find((t) => t.kind === kind) || { kind, workspace: this.workspace, running: false };

        return {
          ...TOOLS[kind], kind, tool, state: toolState(tool), href: toolHref(tool),
        };
      });
    },
  },

  watch: {
    idleStage() {
      this.releaseForStage();
    },
  },

  async fetch() {
    await Promise.all([this.read(), this.readShares()]);
  },

  mounted() {
    // A tool that was just attached is still starting, and its lease is counting down while
    // nobody is pressing anything, so the list refreshes itself.
    this.timer = setInterval(() => {
      this.read().catch(() => {});
      this.readShares().catch(() => {});
    }, 20000);
  },

  beforeUnmount() {
    clearInterval(this.timer);
  },

  methods: {
    /** What each share is, now. A failed read leaves what is on screen alone. */
    async readShares() {
      for (const kind of ['dashboard', 'storybook']) {
        const state = await previewState(this.$store, this.workspace, 'local', kind).catch(() => null);

        if (state) {
          this.shares = { ...this.shares, [kind]: state };
        }
      }
      if (!this.ranchers.length) {
        this.ranchers = (await listRanchers(this.$store).catch(() => []))
          .filter((r) => r.url && (r.kind === 'host' || r.phase === 'ready'));
      }
    },

    /**
     * Build it and serve it.
     *
     * The host is the starred Rancher's node when there is one, and this cluster otherwise -
     * `preferredShareHost` already decides that, and deciding it again here would be a second
     * opinion to keep in step. Which RANCHER the build talks to is a separate choice and is
     * the select beside the row.
     */
    async share(kind, target = '') {
      this.shareBusy = kind;
      try {
        const host = await preferredShareHost(this.$store);

        await shareWorkspace(this.$store, this.workspace, kind, target, 'local', host);
        this.$emit('notice', `The ${ kind } share is building. The link appears here when it is up.`);
        await this.readShares();
      } catch (e) {
        this.$emit('error', e);
      } finally {
        this.shareBusy = '';
      }
    },

    /** Build it again from the branch as it is now. */
    async rebuild(kind) {
      this.shareBusy = kind;
      try {
        /*
         * The cluster the share is actually ON, not `local`.
         *
         * rebuildPreview deletes the share's pods to make it build again, and it looks for
         * them on the cluster it is given. Hardcoding `local` meant that for every share with
         * a public sslip address - which is exactly the ones hosted on a Rancher instance's
         * node - it listed pods on the wrong cluster, found none, deleted nothing, and the
         * panel said "the share is rebuilding" while nothing happened. `shareWorkspace` has
         * always used `state.hostedOn || host.id`; this did not.
         */
        await rebuildPreview(this.workspace, this.shares[kind]?.hostedOn || 'local', kind);
        this.$emit('notice', `The ${ kind } share is rebuilding from the branch as it is now.`);
        await this.readShares();
      } catch (e) {
        this.$emit('error', e);
      } finally {
        this.shareBusy = '';
      }
    },

    /**
     * A Rancher was picked: share it, or point an existing share at it.
     *
     * One handler for both, because from here they are the same act - "serve this branch,
     * talking to that Rancher" - and which code path it takes is just whether a build exists.
     */
    async chose(url) {
      const kind = this.picking;

      this.picking = '';
      if (!kind || !url) {
        return;
      }
      if (this.shares[kind]) {
        await this.retarget(kind, url);
      } else {
        await this.share(kind, url);
      }
    },

    /** Point the built share at another Rancher. A build is routed, so this rebuilds it. */
    async retarget(kind, url) {
      if (!url) {
        return;
      }
      this.shareBusy = kind;
      try {
        await retargetPreview(this.$store, this.workspace, kind, url);
        this.$emit('notice', `The ${ kind } share now talks to ${ url }; it is rebuilding for it.`);
        await this.readShares();
      } catch (e) {
        this.$emit('error', e);
      } finally {
        this.shareBusy = '';
      }
    },

    async unshare(kind) {
      this.shareBusy = kind;
      try {
        await removePreview(this.$store, this.workspace, kind);
        this.shares = { ...this.shares, [kind]: null };
      } catch (e) {
        this.$emit('error', e);
      } finally {
        this.shareBusy = '';
      }
    },

    async read() {
      if (!this.workspace) {
        return;
      }
      this.tools = await workspaceTools(this.workspace).catch(() => []);
      await this.releaseForStage();
    },

    /**
     * Attach one, or renew the lease on one that is already up.
     *
     * The lease is the point of the arrangement: a tool nobody releases goes by itself, so the
     * cost of forgetting is the rest of an hour and a half rather than the rest of the week.
     */
    async attach(kind) {
      this.busy = kind;
      try {
        const tool = await startTool(this.workspace, kind, DEFAULT_LEASE_MINUTES);

        this.replace(tool);
        this.$emit('notice', kind === 'browser'
          ? 'The browser tool is attached: a window and a session of its own on the shared browser.'
          : `The ${ TOOLS[kind].label.toLowerCase() } is starting, and is leased for ${ DEFAULT_LEASE_MINUTES } minutes.`);
        // It takes a moment to have a pod; read it back so the row stops saying "starting" by
        // itself rather than on the next visit.
        setTimeout(() => this.read().catch(() => {}), 4000);
      } catch (e) {
        this.$emit('error', e);
      } finally {
        this.busy = '';
      }
    },

    /** Give it back. Everything it was holding goes with its namespace. */
    async release(kind) {
      this.busy = kind;
      try {
        await stopTool(this.workspace, kind);
        this.replace({ kind, workspace: this.workspace, running: false });
        this.$emit('notice', `The ${ TOOLS[kind].label.toLowerCase() } is released.`);
      } catch (e) {
        this.$emit('error', e);
      } finally {
        this.busy = '';
      }
    },

    /** Another lease's worth, for work that is not finished. */
    async extend(kind) {
      this.busy = kind;
      try {
        this.replace(await renewTool(this.workspace, kind, DEFAULT_LEASE_MINUTES));
      } catch (e) {
        this.$emit('error', e);
      } finally {
        this.busy = '';
      }
    },

    replace(tool) {
      this.tools = [...this.tools.filter((t) => t.kind !== tool.kind), tool];
    },

    /** Release the dev server for a stage that cannot use it, once per visit. */
    async releaseForStage() {
      const server = this.tools.find((tool) => tool.kind === 'dev-server');
      let kept = false;

      try {
        kept = !!sessionStorage.getItem(`dev-extension.dev-server-kept.${ this.workspace }`);
      } catch { /* no storage: the release applies, which is the cheaper default */ }

      if (kept || this.released || !this.idleStage || !server?.running) {
        return;
      }
      this.released = true;
      try {
        await stopTool(this.workspace, 'dev-server');
        this.replace({ kind: 'dev-server', workspace: this.workspace, running: false });
        this.$emit('notice', 'The dev server is released while this waits on a reviewer; attach it again when you need it.');
      } catch (e) {
        console.debug(`[tools] releasing the dev server: ${ e?.message || e }`); // eslint-disable-line no-console
      }
    },
  },
};
</script>

<template>
  <div
    class="workspace-tools"
    :class="{ 'workspace-tools--inline': inline }"
  >
    <span class="workspace-tools__label">Tools</span>
    <div class="workspace-tools__rows">
      <!--
        The two shares, in the same list as the tools.
        A share is not a leased tool - it outlives the lease and has a public address of its
        own - but it answers the question this list answers, and it was on another tab.
      -->
      <div
        v-for="row in shareRows"
        :key="`share-${ row.kind }`"
        class="workspace-tools__row"
        :class="{ 'workspace-tools__row--up': row.up }"
        :title="row.what"
      >
        <i
          class="icon workspace-tools__icon"
          :class="row.icon"
        />
        <span class="workspace-tools__name">{{ row.label }}</span>
        <span class="workspace-tools__state">{{ row.up ? 'built' : 'not built' }}</span>
        <a
          v-if="row.href"
          :href="row.href"
          target="_blank"
          rel="noopener noreferrer"
          class="workspace-tools__link"
        >Open</a>
        <!-- Which Rancher it talks to, said rather than chosen here: picking one is a modal. -->
        <span
          v-if="row.up && row.whereName"
          class="workspace-tools__state"
        >→ {{ row.whereName }}</span>
        <button
          v-if="row.up"
          class="workspace-tools__link"
          :disabled="!!shareBusy"
          title="Build it again from the branch as it is now."
          @click="rebuild(row.kind)"
        >
          {{ shareBusy === row.kind ? 'Working…' : 'Rebuild' }}
        </button>
        <button
          v-if="row.up"
          class="workspace-tools__link"
          :disabled="!!shareBusy"
          title="Point it at another Rancher. A build is routed for its target, so this rebuilds it."
          @click="picking = row.kind"
        >
          Point at…
        </button>
        <button
          v-else
          class="workspace-tools__link"
          :disabled="!!shareBusy"
          :title="row.what"
          @click="picking = row.kind"
        >
          {{ shareBusy === row.kind ? 'Building…' : 'Share' }}
        </button>
        <button
          v-if="row.up"
          class="workspace-tools__link"
          :disabled="!!shareBusy"
          title="Take the share down."
          @click="unshare(row.kind)"
        >
          Release
        </button>
      </div>

      <div
        v-for="row in rows"
        :key="row.kind"
        class="workspace-tools__row"
        :class="{ 'workspace-tools__row--up': row.tool.running }"
        :title="row.what"
      >
        <i
          class="icon workspace-tools__icon"
          :class="row.icon"
        />
        <span class="workspace-tools__name">{{ row.label }}</span>
        <span class="workspace-tools__state">{{ row.state }}</span>
        <!--
          The shared browser has nothing to attach or release: it is one Chromium for every
          workspace, and it costs nothing when nobody is driving it. The row is still here,
          because "what can this workspace use" is the question the list answers.
        -->
        <a
          v-if="row.href && row.tool.ready"
          :href="row.href"
          target="_blank"
          rel="noopener noreferrer"
          class="workspace-tools__link"
        >Open</a>
        <button
          v-if="row.tool.running && !row.tool.shared"
          class="workspace-tools__link"
          :disabled="!!busy"
          title="Another lease's worth, for work that is not finished."
          @click="extend(row.kind)"
        >
          Renew
        </button>
        <button
          v-if="row.tool.running && !row.tool.shared"
          class="workspace-tools__link"
          :disabled="!!busy"
          title="Give it back now. Everything it was holding goes with it."
          @click="release(row.kind)"
        >
          Release
        </button>
        <button
          v-else-if="!row.tool.running"
          class="workspace-tools__link"
          :disabled="!!busy"
          :title="row.what"
          @click="attach(row.kind)"
        >
          Attach
        </button>
        <i
          v-if="busy === row.kind"
          class="icon icon-spinner icon-spin"
        />
      </div>
    </div>
  
    <!--
      Choosing the Rancher is a question, so it is asked rather than parked in the row.
      It was a select between the name and the buttons: two of them, on one line, in a strip
      whose whole job is to be glanceable.
    -->
    <DevModal
      v-if="picking"
      :title="`Which Rancher should the ${ picking } share talk to?`"
      @close="picking = ''"
    >
      <p
        v-if="!ranchers.length"
        class="workspace-tools__empty"
      >
        No Rancher is ready to point at. This Rancher is always an option once the page has
        read it; an instance appears here when it is up.
      </p>
      <ul
        v-else
        class="workspace-tools__choices"
      >
        <li
          v-for="r in ranchers"
          :key="r.id"
        >
          <button
            type="button"
            class="workspace-tools__choice"
            :disabled="!!shareBusy"
            @click="chose(r.url)"
          >
            <span class="workspace-tools__choice-name">{{ r.name }}</span>
            <span class="workspace-tools__choice-url">{{ r.url }}</span>
          </button>
        </li>
      </ul>
    </DevModal>
</div>
</template>

<style lang="scss" scoped>
.workspace-tools {
  display:        flex;
  flex-direction: column;
  gap:            8px;
  padding:        10px 12px;
  border:         1px solid var(--border);
  border-radius:  var(--r-sm);
  background:     var(--box-bg);

  &__label {
    font-size:      11px;
    font-weight:    700;
    letter-spacing: .06em;
    text-transform: uppercase;
    color:          var(--input-label);
  }

  &__rows {
    display:        flex;
    flex-direction: column;
    gap:            2px;
    width:          100%;
  }

  &__row {
    display:     flex;
    align-items: center;
    gap:         8px;
    padding:     3px 0;
    font-size:   12px;
    color:       var(--input-label);

    // Attached is the state worth reading off the list at a glance, because it is the one that
    // is costing something.
    &--up {
      color: var(--body-text);

      .workspace-tools__name { font-weight: 600; }
    }
  }

  &__icon {
    font-size:  14px;
    width:      16px;
    text-align: center;
  }

  &__name { min-width: 76px; }

  &__state {
    flex:          1;
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
    opacity:       .8;
  }

  &__link {
    background: none;
    border:     none;
    padding:    0;
    font-size:  12px;
    color:      var(--link);
    cursor:     pointer;

    &:hover { text-decoration: underline; }

    &:disabled {
      opacity: .5;
      cursor:  default;
    }
  }

  // One row across the page: the label, then each tool with its state and its links beside it.
  // It wraps rather than scrolls, so a narrow window gets two lines and not a clipped fourth tool.
  &--inline {
    flex-direction: row;
    align-items:    center;
    gap:            20px;
    padding:        8px 14px;

    .workspace-tools__rows {
      flex-direction: row;
      flex-wrap:      wrap;
      gap:            2px 28px;
    }

    // The same width as the rail's group labels, so the rows line up down the page.
    .workspace-tools__label { flex: 0 0 96px; }

    .workspace-tools__name { min-width: 0; }

    .workspace-tools__state { flex: 0 1 auto; }
  }
}
</style>
