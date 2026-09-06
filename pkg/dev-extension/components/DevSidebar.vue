<script>
// The product's navigation: templates as sections, workspaces as rows.
//
// It is not Rancher's product nav, because that nav cannot draw these rows: it builds each
// entry's label itself through `escapeHtml` and its entries have no icon field, so a state dot
// is impossible, and it has no per-row slot, so a delete control is impossible. Both are on
// every row of the thing this is a port of.
//
// The rows themselves are DevList, which is also the conversation list inside a workspace. What
// is left here is what is particular to the nav: which sections there are, what a row links to,
// and the strip of everything that is not a workspace along the foot.
import {
  listAllWorkspaces, deleteWorkspace, listClusters, readableBytes
} from '../api';
import { listApps, reconcileUnrendered, ensureDefaultApp } from '../apps';
import { DEFAULT_APP, LEGACY_WORKSPACE_APPS } from '../config/constants';
import { readPrefs, shownApps } from '../prefs';
import {
  listRanchers, setDefaultRancher, createRancherInstance, nextRancherName, rancherAddress
} from '../ranchers';
import { tickAgents } from '../agent-defs';
import DevList from './DevList.vue';
import DevDialog from './DevDialog.vue';
import ClaudeLogo from './ClaudeLogo.vue';
import Stack from '../design/Stack.vue';
import Row from '../design/Row.vue';
import {
  DEV_PRODUCT, BLANK_CLUSTER, WORKSPACE_ROUTE, CREATE_ROUTE, WORKSPACES_ROUTE,
  MY_WORK_ROUTE, INSIGHTS_ROUTE, SETTINGS_ROUTE, AGENTS_ROUTE, CONVERSATIONS_ROUTE
} from '../config/constants';

const REFRESH_MS = 5000;

/**
 * What counts as a cluster running low.
 *
 * A workspace clones rancher/dashboard, installs it and compiles it: that is gigabytes of disk
 * and a compile that has been given four of memory. These are the numbers under which starting
 * one is a thing that fails partway rather than a thing that is slow.
 */
const LOW_MEMORY = 4 * 1024 ** 3;
const LOW_DISK = 20 * 1024 ** 3;

// The sidebar is rebuilt on every navigation, because the router-view above it is keyed on the
// path. Without this the list blinks empty and fills in again on every click, which is the
// difference between a sidebar and a page element that happens to be on the left.
// What the sidebar last knew, kept across its own remounts.
//
// The shell keys its router-view on the path, so every navigation - one workspace to the next -
// unmounts this product's page template and this sidebar with it. Fetching everything again
// on each mount drew an empty column for a second on every click; drawn from here instead, the
// column comes back exactly as it was and the refresh that follows changes what changed.
const cache = {
  workspaces: [],
  clusters:   [],
  apps:       [],
  ranchers:   [],
  defaultRancher: '',
  scroll:     0,
};
// Whether this page load has already asked for the default App; see refresh().
let seeded = false;

export default {
  name: 'DevSidebar',

  components: {
    DevList, Stack, Row, ClaudeLogo, DevDialog
  },

  data() {
    return {
      workspaces:   cache.workspaces,
      clusters:     cache.clusters,
      ranchers:     cache.ranchers,
      defaultRancher: cache.defaultRancher,
      askingRancher: false,
      proposedRancher: '',
      apps:         cache.apps,
      error:        '',
      refreshTimer: null,
      /**
       * The entries that are not workspaces, as an icon row at the foot.
       *
       * Icons rather than labelled rows because the column is about workspaces, and these are
       * the things that are not one. `list-flat` for My Work is the honest pick of what the
       * shell has: it is a list, and Rancher's `user` icon already means an account elsewhere
       * in the product, which My Work is not.
       *
       * My Work first, because it is the page somebody opens the product to look at. Terminal is
       * in the row rather than before it, and it is the one entry that is not a page: it opens
       * the drawer in place, which is why it carries an action instead of a route.
       */
      globals: [
        {
          label: 'My Work', icon: 'icon-list-flat', route: MY_WORK_ROUTE
        },
        {
          label: 'Insights', icon: 'icon-monitoring', route: INSIGHTS_ROUTE
        },
        {
          label: 'Conversations', icon: 'icon-comment', route: CONVERSATIONS_ROUTE
        },
        {
          label: 'Settings', icon: 'icon-gear', route: SETTINGS_ROUTE
        },
        {
          label: 'Agents', logo: true, route: AGENTS_ROUTE
        },
      ],
    };
  },

  computed: {
    /**
     * A section per cluster, with the workspaces hosted on it.
     *
     * By cluster rather than by template, because that is the thing a person is choosing between
     * when they have workspaces in two places: a template says what a workspace runs, which the
     * row's own page says too, and a cluster says where it is, which nothing else did.
     *
     * Every cluster gets a section even with nothing in it, so the plus that makes one there is
     * somewhere to press.
     */
    /**
     * One list per Apps Plus app, holding every workspace made from it wherever it runs.
     *
     * Not one list per app per cluster: that drew a "None yet" under every cluster under every
     * app, and the cluster a workspace is on is one fact about it, not a heading. A workspace on
     * a cluster other than the local one says so on its row; the clusters themselves are one
     * section at the bottom, with what is left on each.
     */
    /**
     * One section per workspace app. Only those: a build to share or a browser is
     * infrastructure a workspace uses, reached from the workspace's own tabs, and a column for
     * each was a sidebar that was mostly headings. The workspaces of an app this product used
     * to seed under another name sit under the current one; they are the same kind of thing.
     */
    sections() {
      return this.apps.filter((app) => app.workspace && !LEGACY_WORKSPACE_APPS.includes(app.id)).map((app) => ({
        id:    app.id,
        label: app.label,
        rows:  this.rowsFor(this.workspaces.filter((workspace) => workspace.app === app.id || (app.id === DEFAULT_APP && LEGACY_WORKSPACE_APPS.includes(workspace.app)))),
      }));
    },

    /**
     * Workspaces whose template is gone, grouped the same way.
     *
     * A template removed from the code must not take its workspaces off the page with it: they
     * are still running and somebody still has to be able to delete them.
     */
    /** Workspaces whose app is hidden in Settings, or gone. Listed, since they exist. */
    orphans() {
      // Known apps that are not workspace apps hold builds and browsers, which are not listed
      // here at all; what is listed is a workspace whose app is gone or hidden.
      const known = new Set(this.apps.map((app) => app.id));
      const listed = new Set(this.sections.map((section) => section.id).concat(LEGACY_WORKSPACE_APPS));

      return this.rowsFor(this.workspaces.filter((workspace) => !listed.has(workspace.app) && (!known.has(workspace.app) || this.apps.find((app) => app.id === workspace.app)?.workspace)));
    },

    /**
     * The most any one cluster has, which is what the bars are drawn against.
     *
     * A bar has to be a proportion of something. Against a cluster's own capacity every cluster
     * would look equally full; against the largest, two clusters side by side compare.
     */
    /** What the meters are drawn against: the fullest cluster is the whole bar. */
    /** The clusters, with how many workspaces each holds. */
    clusterRows() {
      const clusters = this.clusters.length ? this.clusters : [{ id: 'local', name: 'local', memoryFree: 0, diskFree: 0 }];
      const known = new Set(clusters.map((cluster) => cluster.id));
      const strays = [...new Set(this.workspaces.map((workspace) => workspace.cluster))]
        .filter((id) => id && !known.has(id))
        .map((id) => ({
          id, name: id, memoryFree: 0, diskFree: 0
        }));

      return [...clusters, ...strays].map((cluster) => ({
        ...cluster,
        workspaces: this.workspaces.filter((workspace) => workspace.cluster === cluster.id).length,
      }));
    },

    currentWorkspace() {
      return this.$route.params.workspace || '';
    },

    /** The Ranchers a workspace can point at, with the starred one marked. See ranchers.ts. */
    rancherRows() {
      return this.ranchers.map((rancher) => ({
        ...rancher,
        host:      rancher.url.replace(/^https?:\/\//, ''),
        isDefault: rancher.kind === 'host' ? !this.defaultRancher : (!!rancher.url && rancher.url === this.defaultRancher),
      }));
    },
  },

  async fetch() {
    await this.refresh();
  },

  mounted() {
    this.refreshTimer = setInterval(() => this.refresh(), REFRESH_MS);
    // Where the column was scrolled to, back where it was.
    if (cache.scroll && this.$refs.scroll) {
      this.$refs.scroll.scrollTop = cache.scroll;
    }
  },

  beforeUnmount() {
    clearInterval(this.refreshTimer);
    cache.scroll = this.$refs.scroll?.scrollTop || 0;
  },

  methods: {
    async refresh() {
      try {
        const [workspaces, clusters, apps, prefs, ranchers] = await Promise.all([
          listAllWorkspaces(),
          listClusters().catch(() => this.clusters),
          listApps(this.$store).catch(() => this.apps),
          readPrefs().catch(() => ({ hiddenApps: [], defaultRancher: '' })),
          listRanchers(this.$store).catch(() => this.ranchers),
        ]);

        this.workspaces = workspaces;
        this.clusters = clusters;
        this.ranchers = ranchers;
        this.defaultRancher = prefs.defaultRancher || '';
        cache.ranchers = ranchers;
        cache.defaultRancher = this.defaultRancher;
        // Every App for the seed check below; the sections show the ones this person kept.
        this.apps = shownApps(apps, prefs);
        cache.workspaces = workspaces;
        cache.clusters = clusters;
        cache.apps = this.apps;

        // A workspace made by the in-cluster API is an Installation nobody has rendered yet.
        // This browser is the one that can; see apps.ts.
        reconcileUnrendered(this.$store).catch(() => {});

        // The agents' clock: what is due starts, what is over is recorded. See agent-defs.ts.
        tickAgents(this.$store).catch(() => {});

        // The App every Rancher gets. From here rather than only from the product's init,
        // because at init Apps Plus's own types are not in the store yet - its bundle loads
        // beside this one - and the sidebar is on every page of this product.
        // Once per page load whether or not one is missing: ensureDefaultApp also brings an App
        // whose definition moved on in this bundle up to date (see apps.ts).
        if (!seeded) {
          seeded = true;
          ensureDefaultApp(this.$store).catch(() => {
            seeded = false;
          });
        }
      } catch { /* the next poll will say if it is more than a blip */ }
    },

    /**
     * Whether a cluster is running out of room, which is what colours its name.
     *
     * The thresholds are what a workspace of this product actually needs rather than a round
     * number: a checkout, an install and a compile of rancher/dashboard want a few gigabytes of
     * each, and a cluster under that will take one and then fail in the middle of yarn.
     */
    low(cluster) {
      return (cluster.memoryFree && cluster.memoryFree < LOW_MEMORY) ||
        (cluster.diskFree && cluster.diskFree < LOW_DISK);
    },

    /**
     * How much of a bar is lit: what is free, as a share of what the cluster has in all.
     *
     * Each cluster against its own total rather than against the largest cluster's: the tracks
     * are one width, the fill is that cluster's own headroom, and a bar moves when the number
     * beside it does.
     */
    bar(free, total) {
      if (!total) {
        return '0%';
      }

      return `${ Math.max(1, Math.min(100, Math.round((free / total) * 100))) }%`;
    },

    /** "43 GiB / 62 GiB", or the free amount alone when the total is not known. */
    amount(free, total) {
      return total ? `${ readableBytes(free) } / ${ readableBytes(total) }` : readableBytes(free);
    },

    /** A Rancher of your own, from the single-node App: named here, confirmed, then provisioned. */
    async newRancher() {
      this.proposedRancher = await nextRancherName(this.$store).catch(() => 'otter');
      this.askingRancher = true;
    },

    async makeRancher() {
      const name = this.proposedRancher;

      this.askingRancher = false;
      try {
        await createRancherInstance(this.$store, name);
        this.error = '';
        await this.refresh();
      } catch (e) {
        this.error = e.message || String(e);
      }
    },

    callbackHint(name) {
      return `${ rancherAddress(name, '<node ip>') }/verify-auth`;
    },

    // A method rather than the import in the template: an imported function is not on the
    // component, and a template that called it threw on every render, taking the sidebar with it.
    rancherHint(name) {
      return `One EC2 node running Rancher with GitHub login, provisioned through this Rancher. Once it is up, add ${ this.callbackHint(name) } to the GitHub app's callbacks.`;
    },

    /** Star one Rancher: new workspaces and shares point at it. This Rancher is the default when none is starred. */
    async star(rancher) {
      if (rancher.kind !== 'host' && !rancher.url) {
        return;
      }
      const url = rancher.kind === 'host' ? '' : rancher.url;

      try {
        await setDefaultRancher(url);
        this.defaultRancher = url;
        cache.defaultRancher = url;
      } catch (e) {
        this.error = e.message || String(e);
      }
    },

    readable(value) {
      return readableBytes(value);
    },

    /** Every workspace, asked for rather than landed on. See the Workspaces page. */
    listTo() {
      return {
        name:   WORKSPACES_ROUTE,
        params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER },
        query:  { all: null },
      };
    },

    /** The create page, with this cluster already chosen. */
    createIn(app) {
      return {
        name:   CREATE_ROUTE,
        params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER },
        query:  { app },
      };
    },

    /** A workspace as a row: its name, its state, and the page it opens. */
    rowsFor(workspaces) {
      return workspaces.map((workspace) => ({
        key:   workspace.name,
        // The cluster on the row only when it is not the local one, which is where most are.
        label: workspace.cluster && workspace.cluster !== 'local' ? `${ workspace.name } · ${ workspace.cluster }` : workspace.name,
        state: workspace.state,
        to:    {
          name:   WORKSPACE_ROUTE,
          params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER, workspace: workspace.name },
        },
      }));
    },

    globalTo(route) {
      return { name: route, params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER } };
    },

    isGlobalActive(route) {
      return this.$route.name === route;
    },

    async remove(name) {
      this.error = '';

      try {
        await deleteWorkspace(this.$store, name);
        await this.refresh();

        // Standing on a workspace that has just been deleted is standing on a page that is
        // about to say it does not exist.
        if (this.currentWorkspace === name) {
          this.$router.push({ name: WORKSPACES_ROUTE, params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER } });
        }
      } catch (e) {
        this.error = e.message || String(e);
      }
    },
  },
};
</script>

<template>
  <nav class="dev-sidebar">
    <div
      ref="scroll"
      class="dev-sidebar__scroll"
    >
      <!--
        One list per app; the + on its heading makes a new workspace of that app. The heading
        links to the list of every workspace, which is where one is stopped or deleted.
      -->
      <DevList
        v-for="section in sections"
        :key="section.id"
        class="dev-sidebar__app"
        :label="section.label"
        icon="icon-apps"
        :rows="section.rows"
        :current="currentWorkspace"
        :create-to="createIn(section.id)"
        :create-label="`New ${ section.label } workspace`"
        deletable
        @delete="remove"
      />
      <DevList
        v-if="orphans.length"
        class="dev-sidebar__app"
        label="Other apps"
        icon="icon-apps"
        :rows="orphans"
        :current="currentWorkspace"
        deletable
        @delete="remove"
      />

    </div>
  <!--
    The clusters, once, with what is actually free on each right now: the question when making
    a workspace. Pinned under the lists rather than scrolling with them, so it is where it was
    the last time you looked however many workspaces there are.
  -->
    <!--
      The Ranchers a workspace can be pointed at, and which one new ones are pointed at: the
      starred one. This Rancher, then every Rancher this cluster runs (the rancher-ha App).
    -->
    <div
      class="dev-sidebar__ranchers"
      data-testid="dev-ranchers"
    >
      <div class="dev-sidebar__template-head">
        <i class="dev-sidebar__template-icon icon icon-globe" />
        <span class="dev-sidebar__template-label">Ranchers</span>
        <button
          type="button"
          class="dev-sidebar__add"
          title="A new Rancher: one EC2 node, GitHub login, an sslip address"
          data-testid="dev-new-rancher"
          @click="newRancher"
        >
          +
        </button>
      </div>
      <div
        v-for="rancher in rancherRows"
        :key="rancher.id"
        class="dev-sidebar__rancher-row"
        :class="{ 'dev-sidebar__rancher-row--default': rancher.isDefault }"
      >
        <button
          type="button"
          class="dev-sidebar__star"
          :class="{ 'dev-sidebar__star--on': rancher.isDefault }"
          :disabled="rancher.kind !== 'host' && !rancher.url"
          :title="rancher.isDefault ? 'New workspaces are pointed at this Rancher' : 'Point new workspaces at this Rancher'"
          @click="star(rancher)"
        >{{ rancher.isDefault ? '★' : '☆' }}</button>
        <div class="dev-sidebar__rancher-text">
          <span class="dev-sidebar__rancher-name">{{ rancher.name }}</span>
          <span
            class="dev-sidebar__rancher-url"
            :title="rancher.url || rancher.note"
          >{{ rancher.host || rancher.note }}</span>
        </div>
      </div>
    </div>
    <DevDialog
      v-if="askingRancher"
      :title="`Create the Rancher ${ proposedRancher }?`"
      :message="rancherHint(proposedRancher)"
      confirm-label="Create"
      @confirm="makeRancher"
      @cancel="askingRancher = false"
    />
    <div class="dev-sidebar__clusters">
      <div class="dev-sidebar__template-head">
        <i class="dev-sidebar__template-icon icon icon-cluster" />
        <span class="dev-sidebar__template-label">Clusters</span>
      </div>
      <div
        v-for="cluster in clusterRows"
        :key="cluster.id"
        class="dev-sidebar__cluster-row"
        :class="{ 'dev-sidebar__cluster-row--low': low(cluster) }"
      >
        <div class="dev-sidebar__cluster-name">
          <span>{{ cluster.name }}</span>
          <span class="dev-sidebar__cluster-count">{{ cluster.workspaces }}</span>
        </div>
        <Stack gap="1">
          <Row
            class="dev-sidebar__meter"
            gap="3"
          >
            <span class="dev-sidebar__meter-label">MEM</span>
            <span class="dev-sidebar__meter-track"><span
              class="dev-sidebar__meter-fill"
              :style="{ width: bar(cluster.memoryFree, cluster.memoryTotal) }"
            /></span>
            <span class="dev-sidebar__meter-value">{{ amount(cluster.memoryFree, cluster.memoryTotal) }}</span>
          </Row>
          <Row
            class="dev-sidebar__meter"
            gap="3"
          >
            <span class="dev-sidebar__meter-label">DISK</span>
            <span class="dev-sidebar__meter-track"><span
              class="dev-sidebar__meter-fill"
              :style="{ width: bar(cluster.diskFree, cluster.diskTotal) }"
            /></span>
            <span class="dev-sidebar__meter-value">{{ amount(cluster.diskFree, cluster.diskTotal) }}</span>
          </Row>
        </Stack>
      </div>
    </div>
    <div
      v-if="error"
      class="dev-sidebar__error"
    >
      {{ error }}
    </div>

    <!-- The things that are not workspaces, out of the way of the things that are. -->
    <div class="dev-sidebar__globals">
      <template
        v-for="global in globals"
        :key="global.label"
      >
        <router-link
          v-clean-tooltip="global.label"
          :to="globalTo(global.route)"
          :aria-label="global.label"
          :class="{ 'dev-sidebar__globals--current': isGlobalActive(global.route) }"
        >
          <ClaudeLogo
            v-if="global.logo"
            class="icon"
          />
          <i
            v-else
            class="icon"
            :class="global.icon"
          />
        </router-link>
      </template>
    </div>
  </nav>
</template>

<style lang="scss" scoped>
  // Rancher's own step, the same one DevList's metrics come from.
  $rail: 16px;
  // The scale, not a number of this file's own: this was 8px and the list beside it was 8px
  // for the same reason, which is what a scale is for.
  $gap: var(--dev-space-3);

  .dev-sidebar {
    display:        flex;
    flex-direction: column;
    height:         100%;
    min-height:     0;
    overflow:       hidden;
    border-right:   1px solid var(--nav-border, var(--border));
    background:     var(--nav-bg, var(--body-bg));

    &__scroll {
      flex:       1 1 auto;
      overflow-y: auto;
      // Nothing here is meant to be scrolled sideways: a name too long for the column is
      // truncated, and a popover is sized to fit it.
      overflow-x: hidden;
    }

    // The template, above the clusters its workspaces are on. Same metrics as a DevList heading,
    // because it is the same kind of line one level up.
    &__template-head {
      display:         flex;
      align-items:     center;
      height:          33px;
      padding:         0 $gap 0 $rail;
      border-top:      1px solid var(--nav-border, var(--border));
      text-decoration: none;

      &:hover {
        background:      var(--nav-hover, var(--accent-btn));
        text-decoration: none;
      }
    }

    &__template-icon {
      flex:         0 0 $rail;
      width:        $rail;
      margin-right: $gap;
      color:        var(--dev-accent);
      font-size:    14px;
    }

    &__template-label {
      overflow:        hidden;
      color:           var(--body-text);
      font-size:       12px;
      font-weight:     600;
      letter-spacing:  0.05em;
      text-transform:  uppercase;
      text-overflow:   ellipsis;
      white-space:     nowrap;
    }

    // The clusters under it, indented by one rail so the nesting is visible without a line.
    &__cluster {
      padding-left: $rail;
    }

    // The two bars in a cluster's popover: a label, a track, and the number, on one line each.

    &__clusters {
      flex:        0 0 auto;
      border-top:  1px solid var(--border);
      padding-top: var(--dev-space-2);
      background:  var(--nav-bg, var(--body-bg));
    }

    &__ranchers {
      flex:        0 0 auto;
      border-top:  1px solid var(--border);
      padding-top: var(--dev-space-2);
      background:  var(--nav-bg, var(--body-bg));
    }

    &__add {
      margin-left:     auto;
      min-height:      0;
      width:           20px;
      height:          20px;
      padding:         0;
      display:         inline-flex;
      align-items:     center;
      justify-content: center;
      line-height:     1;
      border-radius:   4px;
      border:          1px solid var(--border);
      background:      transparent;
      color:           var(--muted);
      font-size:       15px;
      font-weight:     400;
      cursor:          pointer;

      &:hover { color: var(--dev-accent); border-color: var(--dev-accent); }
    }

    &__rancher-row {
      display:     flex;
      align-items: center;
      gap:         var(--dev-space-2);
      padding:     var(--dev-space-1) var(--dev-space-4);
      min-width:   0;

      &--default .dev-sidebar__rancher-name { color: var(--dev-accent); }
    }

    &__star {
      flex:        0 0 auto;
      background:  none;
      border:      0;
      padding:     0;
      min-height:  0;
      line-height: 1;
      font-size:   15px;
      color:       var(--muted);
      cursor:      pointer;

      &:hover:not(:disabled) { color: var(--dev-accent); }
      &:disabled { cursor: default; opacity: 0.5; }
      &--on { color: var(--dev-accent); }
    }

    &__rancher-text {
      display:        flex;
      flex-direction: column;
      min-width:      0;
    }

    &__rancher-name {
      font-size:      12px;
      font-weight:    600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    &__rancher-url {
      font-size:     11px;
      color:         var(--muted);
      font-family:   monospace;
      white-space:   nowrap;
      overflow:      hidden;
      text-overflow: ellipsis;
    }

    &__cluster-row {
      padding: var(--dev-space-2) var(--dev-space-4);

      &--low .dev-sidebar__cluster-name { color: var(--warning); }
    }

    &__cluster-name {
      display:         flex;
      justify-content: space-between;
      font-size:       12px;
      font-weight:     600;
      text-transform:  uppercase;
      letter-spacing:  0.04em;
      margin-bottom:   var(--dev-space-1);
    }

    &__cluster-count {
      color:       var(--muted);
      font-weight: 400;
    }

    &__meter-label {
      flex:        0 0 34px;
      color:       var(--muted);
      font-family: monospace;
      font-size:   11px;
    }

    &__meter-track {
      flex:          1 1 auto;
      overflow:      hidden;
      height:        6px;
      border-radius: 3px;
      background:    var(--border);
    }

    &__meter-fill {
      display:    block;
      height:     100%;
      background: var(--dev-accent);
      transition: width 0.6s ease;
    }

    &__meter-value {
      flex:        0 0 auto;
      min-width:   88px;
      text-align:  right;
      font-size:   11px;
      font-variant-numeric: tabular-nums;
    }

    &__error {
      padding:   $gap $rail;
      color:     var(--error);
      font-size: 12px;
    }

    &__globals {
      display:         flex;
      align-items:     center;
      justify-content: center;
      gap:             $gap;
      padding:         $gap;
      border-top:      1px solid var(--nav-border, var(--border));

      // One box for all four, so they read as a set: same size, same radius, same hover, and
      // the button reset so it cannot inherit a different weight from the user agent. The
      // min-height is part of that reset: a shell rule gives every BUTTON a 40px minimum, which
      // beats a height and left the Terminal button 28x40 in a row of 28x28 links.
      a,
      button {
        display:         flex;
        align-items:     center;
        justify-content: center;
        width:           28px;
        height:          28px;
        min-height:      28px;
        margin:          0;
        padding:         0;
        border:          none;
        border-radius:   var(--border-radius);
        background:      transparent;
        color:           var(--body-text);
        font:            inherit;
        line-height:     1;
        appearance:      none;
        cursor:          pointer;
        // These are icons, and the shell underlines every anchor on hover. An underline under a
        // glyph is a line under a picture.
        text-decoration: none;

        &:hover,
        &:focus {
          text-decoration: none;
        }

        .icon {
          font-size: 16px;
        }

        &:hover {
          background: var(--nav-hover, var(--accent-btn));
        }
      }

      &--current {
        background:  var(--nav-hover, var(--accent-btn));
        font-weight: 600;
      }
    }
  }
</style>
