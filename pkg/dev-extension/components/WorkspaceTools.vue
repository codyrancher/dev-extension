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
      /** The share kind whose Rancher is being chosen, '' when nothing is being chosen. */
      picking:   '',
      /**
       * Which entry is open for managing, as `share:dashboard` or `tool:storybook`; '' for none.
       *
       * The strip used to carry every action on every row - built, Open, the Rancher it talks
       * to, Rebuild, Point at…, Release, times two shares and two tools - which is seventeen
       * controls on a bar whose whole job is to be glanceable, wrapping onto a second line. The
       * bar says what there IS now; what can be done about one of them is a press away.
       */
      open:      '',
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
          // Where to go, when there is somewhere: the public name first, else the proxied url.
          href:  state?.host ? `https://${ state.host }` : (state?.url || ''),
          // Whether a share EXISTS, which is not the same as whether it is serving yet. The
          // buttons key off this - offering "Share" for one that already exists would try to
          // create a second Installation under a name that is derived and therefore taken.
          up:    !!state?.exists,
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

    /**
     * The bar: one entry per thing, shares and tools alike, each saying what it is and whether
     * it is up. Nothing else - every action is in the entry's own view.
     *
     * One list rather than two loops because they read as one row and should wrap as one: a
     * strip of four with the shares at the front is what a person scans, and two sibling loops
     * with different markup was how the shares came to carry five controls and the tools three.
     */
    entries() {
      return [
        ...this.shareRows.map((row) => ({
          id: `share:${ row.kind }`, kind: row.kind, label: row.label, icon: row.icon, what: row.what, up: row.up, state: row.up ? 'built' : 'not built', share: row,
        })),
        ...this.rows.map((row) => ({
          id: `tool:${ row.kind }`, kind: row.kind, label: row.label, icon: row.icon, what: row.what, up: !!row.tool.running, state: row.state, tool: row,
        })),
      ];
    },

    /** The entry whose view is open, or null. */
    opened() {
      return this.entries.find((entry) => entry.id === this.open) || null;
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
    /**
     * Open one entry's view, and read the Ranchers while it is being read.
     *
     * The list is only needed by a share, and only once the person is deciding something - so
     * it is fetched here rather than with the bar, which is drawn on every workspace page.
     */
    openEntry(entry) {
      this.open = entry.id;
      this.picking = '';
      if (entry.share && !this.ranchers.length) {
        this.readShares().catch(() => {});
      }
    },

    closeEntry() {
      this.open = '';
      this.picking = '';
    },

    /** The lease a tool is attached for, said in the Renew button rather than left to be guessed. */
    leaseMinutes() {
      return DEFAULT_LEASE_MINUTES;
    },

    async chose(url) {
      const kind = this.picking;

      this.picking = '';
      if (!kind || !url) {
        return;
      }
      /*
       * `exists`, not the object.
       *
       * previewState answers with a FULL PreviewState whose `exists` is false when there is no
       * share - name, kind, empty url, `state: 'absent'` - so `this.shares[kind]` is truthy the
       * moment the panel has polled once. Branching on the object meant every press took the
       * retarget path and nothing was ever created: the modal closed, the row stayed "not
       * built", and no share appeared.
       */
      if (this.shares[kind]?.exists) {
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
        // Nothing left to manage: the view goes with what it was about.
        this.closeEntry();
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
    <!--
      One chip per thing: what it is, and whether it is up. Everything that can be DONE to one
      is behind the chip, in its own view - see `open`.
    -->
    <div class="workspace-tools__rows">
      <button
        v-for="entry in entries"
        :key="entry.id"
        type="button"
        class="workspace-tools__chip"
        :class="{ 'workspace-tools__chip--up': entry.up }"
        :title="entry.what"
        @click="openEntry(entry)"
      >
        <i
          class="icon workspace-tools__icon"
          :class="entry.icon"
        />
        <span class="workspace-tools__name">{{ entry.label }}</span>
        <span class="workspace-tools__state">{{ entry.state }}</span>
        <i
          v-if="busy === entry.kind || shareBusy === entry.kind"
          class="icon icon-spinner icon-spin"
        />
      </button>
    </div>

    <!--
      One thing, and what can be done to it. The actions are full buttons here rather than the
      bar's small links: there is room for them, and a Release that takes a public address down
      should not be the same weight as a label.
    -->
    <DevModal
      v-if="opened"
      :title="opened.label"
      @close="closeEntry"
    >
      <!-- Picking the Rancher is a step inside this view, not a second window over it. -->
      <div
        v-if="picking"
        class="workspace-tools__panel"
      >
        <p class="workspace-tools__what">Which Rancher should this build talk to?</p>
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
        <div class="workspace-tools__actions">
          <button
            type="button"
            class="btn role-secondary btn-sm"
            @click="picking = ''"
          >
            Cancel
          </button>
        </div>
      </div>

      <!-- A share: where it is, what it talks to, and the three things that change it. -->
      <div
        v-else-if="opened.share"
        class="workspace-tools__panel"
      >
        <p class="workspace-tools__what">{{ opened.what }}</p>
        <dl class="workspace-tools__facts">
          <dt>State</dt>
          <dd>{{ opened.share.up ? 'Built and serving' : 'Not built' }}</dd>
          <template v-if="opened.share.href">
            <dt>Address</dt>
            <dd>
              <a
                :href="opened.share.href"
                target="_blank"
                rel="noopener noreferrer"
              >{{ opened.share.href }}</a>
            </dd>
          </template>
          <template v-if="opened.share.up">
            <dt>Talks to</dt>
            <dd>{{ opened.share.whereName || opened.share.where || 'nothing yet' }}</dd>
          </template>
        </dl>
        <div class="workspace-tools__actions">
          <template v-if="opened.share.up">
            <a
              v-if="opened.share.href"
              :href="opened.share.href"
              target="_blank"
              rel="noopener noreferrer"
              class="btn role-primary btn-sm"
            >Open</a>
            <button
              type="button"
              class="btn role-secondary btn-sm"
              :disabled="!!shareBusy"
              title="Build it again from the branch as it is now."
              @click="rebuild(opened.kind)"
            >
              {{ shareBusy === opened.kind ? 'Working…' : 'Rebuild' }}
            </button>
            <button
              type="button"
              class="btn role-secondary btn-sm"
              :disabled="!!shareBusy"
              title="Point it at another Rancher. A build is routed for its target, so this rebuilds it."
              @click="picking = opened.kind"
            >
              Point at another Rancher
            </button>
            <button
              type="button"
              class="btn role-secondary btn-sm workspace-tools__danger"
              :disabled="!!shareBusy"
              title="Take the share down."
              @click="unshare(opened.kind)"
            >
              Release
            </button>
          </template>
          <button
            v-else
            type="button"
            class="btn role-primary btn-sm"
            :disabled="!!shareBusy"
            @click="picking = opened.kind"
          >
            {{ shareBusy === opened.kind ? 'Building…' : 'Build and share' }}
          </button>
        </div>
      </div>

      <!-- A leased tool: whether it is attached, and the lease. -->
      <div
        v-else-if="opened.tool"
        class="workspace-tools__panel"
      >
        <p class="workspace-tools__what">{{ opened.what }}</p>
        <dl class="workspace-tools__facts">
          <dt>State</dt>
          <dd>{{ opened.tool.state }}</dd>
          <template v-if="opened.tool.href && opened.tool.tool.ready">
            <dt>Address</dt>
            <dd>
              <a
                :href="opened.tool.href"
                target="_blank"
                rel="noopener noreferrer"
              >{{ opened.tool.href }}</a>
            </dd>
          </template>
        </dl>
        <div class="workspace-tools__actions">
          <a
            v-if="opened.tool.href && opened.tool.tool.ready"
            :href="opened.tool.href"
            target="_blank"
            rel="noopener noreferrer"
            class="btn role-primary btn-sm"
          >Open</a>
          <!--
            The shared browser has nothing to attach or release: it is one Chromium for every
            workspace, and it costs nothing when nobody is driving it.
          -->
          <template v-if="opened.tool.tool.running && !opened.tool.tool.shared">
            <button
              type="button"
              class="btn role-secondary btn-sm"
              :disabled="!!busy"
              :title="`Another ${ leaseMinutes() } minutes, for work that is not finished.`"
              @click="extend(opened.kind)"
            >
              Renew the lease
            </button>
            <button
              type="button"
              class="btn role-secondary btn-sm workspace-tools__danger"
              :disabled="!!busy"
              title="Give it back now. Everything it was holding goes with it."
              @click="release(opened.kind)"
            >
              Release
            </button>
          </template>
          <button
            v-else-if="!opened.tool.tool.running"
            type="button"
            class="btn role-primary btn-sm"
            :disabled="!!busy"
            @click="attach(opened.kind)"
          >
            {{ busy === opened.kind ? 'Attaching…' : 'Attach' }}
          </button>
        </div>
      </div>
    </DevModal>

</div>
</template>

<style lang="scss" scoped>
/*
 * The Rancher chooser, styled at the TOP LEVEL rather than inside `.workspace-tools`.
 *
 * DevModal teleports its content to <body>, so the dialog is not a descendant of this
 * component's root element: a selector nested under `.workspace-tools` compiles to
 * `.workspace-tools .workspace-tools__choice` and matches nothing once the node has moved.
 * Scoping still works - Vue puts the scope attribute on the teleported nodes too - it is only
 * the ancestor that is gone.
 *
 * This was unstyled on first ship, and what that looks like is the name and the address run
 * together into "This Rancherhttps://rancher.ourhome.dev" with a list bullet beside it.
 */
.workspace-tools__choices {
  list-style:     none;
  margin:         0;
  padding:        0;
  display:        flex;
  flex-direction: column;
  gap:            8px;
}

.workspace-tools__choice {
  display:        flex;
  flex-direction: column;
  align-items:    flex-start;
  gap:            2px;
  width:          100%;
  text-align:     left;
  padding:        10px 12px;
  border:         1px solid var(--border);
  border-radius:  var(--r-sm);
  background:     var(--box-bg);
  color:          var(--body-text);
  cursor:         pointer;

  &:hover:not(:disabled) {
    background:   var(--accent-btn-hover);
    border-color: var(--primary);
  }

  &:disabled {
    opacity: 0.6;
    cursor:  default;
  }
}

.workspace-tools__choice-name {
  font-weight: 600;
  font-size:   14px;
}

.workspace-tools__choice-url {
  color:       var(--muted);
  font-size:   12px;
  font-family: monospace;
  word-break:  break-all;
}

.workspace-tools__empty {
  margin:    0;
  color:     var(--muted);
  font-size: 13px;
}

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

  /*
   * One thing, as a chip you can press.
   *
   * It is a button because the whole of it is: the bar says what there is and the press says
   * "tell me about this one". The row it replaces carried its own actions as small links - up
   * to five on a share - so pressing anywhere between them did nothing and a bar of four things
   * was seventeen controls wrapping onto a second line.
   */
  &__chip {
    display:       flex;
    align-items:   center;
    gap:           8px;
    min-height:    0;
    padding:       4px 10px;
    border:        1px solid transparent;
    border-radius: var(--r-sm);
    background:    transparent;
    color:         var(--input-label);
    font-size:     12px;
    text-align:    left;
    cursor:        pointer;

    &:hover,
    &:focus-visible {
      border-color: var(--border);
      background:   var(--box-bg);
      color:        var(--body-text);
    }

    // Up is the state worth reading off the bar at a glance, because it is the one that is
    // costing something - a node's cores, or a public address.
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
      gap:            4px 8px;
    }

    // The same width as the rail's group labels, so the rows line up down the page.
    .workspace-tools__label { flex: 0 0 96px; }

    .workspace-tools__name { min-width: 0; }

    .workspace-tools__state { flex: 0 1 auto; }
  }
}

/*
 * One entry's view. At the TOP LEVEL for the reason the chooser above is - DevModal teleports
 * to <body>, so a selector nested under `.workspace-tools` compiles to
 * `.workspace-tools .workspace-tools__panel` and matches nothing once the node has moved.
 */
.workspace-tools__panel {
  display:        flex;
  flex-direction: column;
  gap:            16px;
  min-width:      min(460px, 80vw);
}

.workspace-tools__what {
  margin:    0;
  color:     var(--muted);
  font-size: 13px;
}

/* What it is, in pairs: the label in the column the rail's own labels use. */
.workspace-tools__facts {
  display:               grid;
  grid-template-columns: auto 1fr;
  gap:                   6px 16px;
  margin:                0;

  dt {
    color:          var(--muted);
    font-size:      11px;
    font-weight:    600;
    letter-spacing: .04em;
    text-transform: uppercase;
  }

  dd {
    margin:     0;
    font-size:  13px;
    word-break: break-all;
  }
}

.workspace-tools__actions {
  display:   flex;
  flex-wrap: wrap;
  gap:       8px;
}

/* Taking a public address down is not the same weight as opening it. */
.workspace-tools__danger {
  color:        var(--error);
  border-color: var(--error);
}
</style>
