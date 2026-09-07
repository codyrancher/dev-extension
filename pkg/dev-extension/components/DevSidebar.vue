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
  listRanchers, setDefaultRancher, createRancherInstance, deleteRancherInstance, nextRancherName, rancherAddress, RANCHER_STEPS
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

const CLUSTERS_OPEN_KEY = 'dev.sidebar.clusters.open';

function readClustersOpen() {
  try {
    return localStorage.getItem(CLUSTERS_OPEN_KEY) === 'true';
  } catch {
    return false;
  }
}

/** The node's IP out of `<name>.dev-extension.<ip>.sslip.io`, or ''. */
function nodeIpOf(url) {
  return (url.match(/\.(\d+\.\d+\.\d+\.\d+)\.sslip\.io/) || [])[1] || '';
}

/** "4m", "1h 12m": how long a new Rancher has been on its way. */
function elapsed(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60000));

  return minutes < 60 ? `${ minutes }m` : `${ Math.floor(minutes / 60) }h ${ minutes % 60 }m`;
}


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
      /** The Clusters block is a header until it is opened; the choice is kept per browser. */
      clustersOpen: readClustersOpen(),
      /** The Rancher a delete is being confirmed for, or null. */
      deletingRancher: null,
      /** Rancher id -> true for the moment after its address was copied. */
      copied:          {},
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

      return [...clusters, ...strays].map((cluster) => {
        const issues = cluster.issues || [];

        return {
          ...cluster,
          health:     cluster.health || 'ok',
          issues,
          summary:    issues.join(' · '),
          workspaces: this.workspaces.filter((workspace) => workspace.cluster === cluster.id).length,
        };
      });
    },

    /** The worst of the clusters, for the collapsed header's one dot. Room, not health. */
    clustersHealth() {
      const levels = this.clusterRows.map((c) => c.health);

      return levels.includes('error') ? 'error' : levels.includes('warn') ? 'warn' : 'ok';
    },

    /** What the dot means, cluster by cluster, for its tooltip. */
    clustersSummary() {
      const trouble = this.clusterRows.filter((c) => c.health !== 'ok').map((c) => `${ c.name }: ${ c.summary }`);

      return trouble.length ? trouble.join('\n') : 'Every cluster has room for another workspace';
    },

    currentWorkspace() {
      return this.$route.params.workspace || '';
    },

    /** The Ranchers a workspace can point at, with the starred one marked. See ranchers.ts. */
    rancherRows() {
      const now = Date.now();

      return this.ranchers.map((rancher) => {
        const host = rancher.url.replace(/^https?:\/\//, '');

        return {
          ...rancher,
          host,
          isDefault: rancher.kind === 'host' ? !this.defaultRancher : (!!rancher.url && rancher.url === this.defaultRancher),
          elapsed:   rancher.since ? elapsed(now - Date.parse(rancher.since)) : '',
          // Not the whole address - it is long and the node's IP is the part that says anything;
          // the address itself is a copy away.
          where:     rancher.kind === 'host' ? host : rancher.phase === 'ready' ? `up · ${ nodeIpOf(rancher.url) || host }` : '',
          stepTitle: `${ rancher.step + 1 } of ${ RANCHER_STEPS.length }: ${ RANCHER_STEPS[rancher.step] || '' }`,
        };
      });
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

        // A Rancher pressed Create for a moment ago is a row already (makeRancher); the store's
        // list can lag the save by a poll or two, and the row must not blink out in between.
        for (const row of this.ranchers) {
          if (row.phase === 'created' && !ranchers.some((r) => r.id === row.id) && Date.now() - Date.parse(row.since) < 120000) {
            ranchers.push(row);
          }
        }

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
    toggleClusters() {
      this.clustersOpen = !this.clustersOpen;
      try {
        localStorage.setItem(CLUSTERS_OPEN_KEY, String(this.clustersOpen));
      } catch {
        // A browser that keeps nothing keeps the default, which is closed.
      }
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
      // The row first, then the request: the save takes a moment and the Rancher ten minutes,
      // and somebody who pressed Create should see it moving now, not after the next poll.
      const placeholder = {
        id: `instance:${ name }`, name, url: '', kind: 'instance', phase: 'created', step: 0, detail: 'Creating the cluster', since: new Date().toISOString(),
      };

      if (!this.ranchers.some((r) => r.id === placeholder.id)) {
        this.ranchers = [...this.ranchers, placeholder];
        cache.ranchers = this.ranchers;
      }
      this.$store.dispatch('growl/success', {
        title: `Creating ${ name }`, message: 'One EC2 node, then Rancher on it: about ten minutes. Its progress is under Ranchers.', timeout: 6000,
      }, { root: true });
      try {
        await createRancherInstance(this.$store, name);
        this.error = '';
        await this.refresh();
      } catch (e) {
        this.ranchers = this.ranchers.filter((r) => r.id !== placeholder.id);
        cache.ranchers = this.ranchers;
        this.error = e.message || String(e);
      }
    },

    /** The icon says it happened: a tick for a moment, where the copy icon was. */
    async copyRancher(rancher) {
      try {
        await navigator.clipboard.writeText(rancher.url);
        this.copied = { ...this.copied, [rancher.id]: true };
        setTimeout(() => {
          this.copied = { ...this.copied, [rancher.id]: false };
        }, 1500);
      } catch {
        this.$store.dispatch('growl/info', { title: rancher.url, message: 'Copy it from here.', timeout: 8000 }, { root: true });
      }
    },

    askDeleteRancher(rancher) {
      this.deletingRancher = rancher;
    },

    async deleteRancher() {
      const rancher = this.deletingRancher;

      this.deletingRancher = null;
      if (!rancher) {
        return;
      }
      // The row says so at once; the poll takes over as the instance's deletion timestamp lands.
      this.ranchers = this.ranchers.map((r) => (r.id === rancher.id ? {
        ...r, phase: 'removing', step: 0, url: '', detail: 'Removing, with its cluster and node', since: new Date().toISOString(),
      } : r));
      cache.ranchers = this.ranchers;
      try {
        await deleteRancherInstance(this.$store, rancher.name);
        if (this.defaultRancher && this.defaultRancher === rancher.url) {
          await setDefaultRancher('').catch(() => {});
          this.defaultRancher = '';
          cache.defaultRancher = '';
        }
        this.$store.dispatch('growl/success', { title: `Removing ${ rancher.name }`, message: 'Its cluster and EC2 node are being deleted with it.', timeout: 5000 }, { root: true });
      } catch (e) {
        this.error = e.message || String(e);
        await this.refresh();
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
          :disabled="rancher.kind !== 'host' && rancher.phase !== 'ready'"
          :title="rancher.isDefault ? 'New workspaces are pointed at this Rancher' : rancher.kind !== 'host' && rancher.phase !== 'ready' ? 'Not up yet' : 'Point new workspaces at this Rancher'"
          @click="star(rancher)"
        >{{ rancher.isDefault ? '★' : '☆' }}</button>
        <div class="dev-sidebar__rancher-text">
          <span class="dev-sidebar__rancher-name">{{ rancher.name }}</span>
          <span
            v-if="rancher.kind === 'host' || rancher.phase === 'ready'"
            class="dev-sidebar__rancher-url"
            :title="rancher.url"
          >{{ rancher.where }}</span>
          <template v-else>
            <span
              class="dev-sidebar__rancher-progress"
              :class="{ 'dev-sidebar__rancher-progress--error': rancher.phase === 'error' }"
              :title="rancher.detail"
              data-testid="dev-rancher-progress"
            >
              <i
                v-if="rancher.phase !== 'error'"
                class="icon icon-spinner icon-spin"
              />
              <i
                v-else
                class="icon icon-warning"
              />
              <span class="dev-sidebar__rancher-detail">{{ rancher.detail }}</span>
              <span
                v-if="rancher.elapsed"
                class="dev-sidebar__rancher-elapsed"
              >{{ rancher.elapsed }}</span>
            </span>
            <span
              v-if="rancher.phase !== 'removing'"
              class="dev-sidebar__steps"
              :title="rancher.stepTitle"
            >
              <i
                v-for="n in 4"
                :key="n"
                class="dev-sidebar__step"
                :class="{
                  'dev-sidebar__step--done': n - 1 < rancher.step,
                  'dev-sidebar__step--now': n - 1 === rancher.step && rancher.phase !== 'error',
                  'dev-sidebar__step--error': n - 1 === rancher.step && rancher.phase === 'error',
                }"
              />
            </span>
          </template>
        </div>
        <span class="dev-sidebar__rancher-tools">
          <button
            v-if="rancher.url"
            type="button"
            class="dev-sidebar__tool"
            :class="{ 'dev-sidebar__tool--done': copied[rancher.id] }"
            :title="copied[rancher.id] ? 'Copied' : 'Copy the address'"
            data-testid="dev-rancher-copy"
            @click="copyRancher(rancher)"
          >
            <i
              class="icon"
              :class="copied[rancher.id] ? 'icon-checkmark' : 'icon-copy'"
            />
          </button>
          <a
            v-if="rancher.url && rancher.kind !== 'host'"
            class="dev-sidebar__tool"
            :href="rancher.url"
            target="_blank"
            rel="noopener noreferrer"
            title="Open it"
          >
            <i class="icon icon-external-link" />
          </a>
          <button
            v-if="rancher.kind !== 'host' && rancher.phase !== 'removing'"
            type="button"
            class="dev-sidebar__tool dev-sidebar__tool--danger"
            title="Delete this Rancher, with its cluster and node"
            data-testid="dev-rancher-delete"
            @click="askDeleteRancher(rancher)"
          >
            <i class="icon icon-delete" />
          </button>
        </span>
      </div>
    </div>
    <DevDialog
      v-if="deletingRancher"
      :title="`Delete the Rancher ${ deletingRancher.name }?`"
      :message="`Its cluster and the EC2 node it runs on are deleted with it. Anything on it is gone; workspaces pointed at it lose their Rancher.`"
      confirm-label="Delete"
      :danger="true"
      @confirm="deleteRancher"
      @cancel="deletingRancher = null"
    />
    <DevDialog
      v-if="askingRancher"
      :title="`Create the Rancher ${ proposedRancher }?`"
      :message="rancherHint(proposedRancher)"
      confirm-label="Create"
      @confirm="makeRancher"
      @cancel="askingRancher = false"
    />
    <div
      class="dev-sidebar__clusters"
      :class="{ 'dev-sidebar__clusters--open': clustersOpen }"
    >
      <button
        type="button"
        class="dev-sidebar__template-head dev-sidebar__clusters-head"
        :aria-expanded="clustersOpen ? 'true' : 'false'"
        :title="clustersOpen ? 'Hide the clusters' : 'Show the clusters'"
        data-testid="dev-clusters-toggle"
        @click="toggleClusters"
      >
        <i class="dev-sidebar__template-icon icon icon-cluster" />
        <span class="dev-sidebar__template-label">Clusters</span>
        <i
          class="dev-sidebar__dot dev-sidebar__dot--overall"
          :class="`dev-sidebar__dot--${ clustersHealth }`"
          :title="clustersSummary"
          data-testid="dev-clusters-summary"
        />
        <i
          class="dev-sidebar__chevron icon"
          :class="clustersOpen ? 'icon-chevron-down' : 'icon-chevron-right'"
        />
      </button>
      <div
        v-for="cluster in clusterRows"
        v-show="clustersOpen"
        :key="cluster.id"
        class="dev-sidebar__cluster-row"
        :class="`dev-sidebar__cluster-row--${ cluster.health }`"
      >
        <div class="dev-sidebar__cluster-name">
          <span class="dev-sidebar__cluster-title">
            <i
              class="dev-sidebar__dot"
              :class="`dev-sidebar__dot--${ cluster.health }`"
            />{{ cluster.name }}
          </span>
          <span class="dev-sidebar__cluster-count">{{ cluster.workspaces }}</span>
        </div>
        <div
          v-if="cluster.summary"
          class="dev-sidebar__cluster-issue"
          :class="`dev-sidebar__cluster-issue--${ cluster.health }`"
          :title="cluster.issues.join('\n')"
        >{{ cluster.summary }}</div>
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
          <!-- The label is the icon's tooltip on a laptop, and there are no tooltips on a
               phone: at drawer width these become a labelled list instead. -->
          <span class="dev-sidebar__globals-label">{{ global.label }}</span>
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
      flex:           1 1 auto;
      min-width:      0;
    }

    &__rancher-tools {
      display:     flex;
      align-items: center;
      flex:        0 0 auto;
      gap:         2px;
      opacity:     0;
      transition:  opacity 0.15s;
    }

    &__rancher-row:hover &__rancher-tools,
    &__rancher-row:focus-within &__rancher-tools { opacity: 1; }

    &__tool {
      display:         inline-flex;
      align-items:     center;
      justify-content: center;
      width:           20px;
      height:          20px;
      min-height:      0;
      padding:         0;
      border:          0;
      border-radius:   4px;
      background:      none;
      color:           var(--muted);
      font-size:       12px;
      line-height:     1;
      cursor:          pointer;
      text-decoration: none;

      &:hover { color: var(--link); background: var(--accent-btn); }
      &--danger:hover { color: var(--error); }
      &--done, &--done:hover { color: var(--success); }
    }

    &__rancher-name {
      font-size:      12px;
      font-weight:    600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    &__rancher-progress {
      display:     flex;
      align-items: center;
      gap:         4px;
      min-width:   0;
      font-size:   11px;
      color:       var(--muted);

      .icon { flex: 0 0 auto; font-size: 10px; }
      &--error { color: var(--error); }
    }

    &__rancher-detail {
      min-width:     0;
      overflow:      hidden;
      text-overflow: ellipsis;
      white-space:   nowrap;
    }

    &__rancher-elapsed {
      flex:        0 0 auto;
      font-family: monospace;
      opacity:     0.8;
    }

    &__steps {
      display:    flex;
      gap:        3px;
      margin-top: 3px;
    }

    &__step {
      display:       block;
      width:         14px;
      height:        3px;
      border-radius: 2px;
      background:    var(--border);

      &--done { background: var(--success); }
      &--now { background: var(--primary); animation: dev-step-pulse 1.2s ease-in-out infinite; }
      &--error { background: var(--error); }
    }

    &__rancher-url {
      font-size:     11px;
      color:         var(--muted);
      font-family:   monospace;
      white-space:   nowrap;
      overflow:      hidden;
      text-overflow: ellipsis;
    }

    &__clusters-head {
      width:      100%;
      border:     0;
      background: none;
      color:      inherit;
      cursor:     pointer;
      text-align: left;
      gap:        var(--dev-space-2);

      &:hover { color: var(--body-text); }
    }

    &__chevron {
      flex:      0 0 auto;
      font-size: 12px;
      color:     var(--muted);
    }

    &__dot {
      display:       inline-block;
      width:         7px;
      height:        7px;
      border-radius: 50%;
      margin-right:  6px;
      background:    var(--success);
      vertical-align: 1px;

      &--warn { background: var(--warning); }
      &--error { background: var(--error); }

      // The header's one dot: a little larger, on the right, with the reasons in its title.
      &--overall {
        width:       9px;
        height:      9px;
        margin:      0 var(--dev-space-2) 0 auto;
        box-shadow:  0 0 0 2px color-mix(in srgb, currentColor 0%, var(--nav-bg, var(--body-bg)));
      }
    }

    &__cluster-issue {
      font-size:     11px;
      color:         var(--muted);
      white-space:   nowrap;
      overflow:      hidden;
      text-overflow: ellipsis;
      margin:        1px 0 3px;

      &--warn { color: var(--warning); }
      &--error { color: var(--error); }
    }

    &__cluster-row {
      padding: var(--dev-space-2) var(--dev-space-4);
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

    &__globals-label { display: none; }

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

@keyframes dev-step-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

/* ── Phones: the drawer.
   The links that are icons on a laptop are the product's whole navigation, and at the bottom
   of a drawer, unlabelled, they are neither. They go to the top with their names on. */
@media (max-width: 760px) {
  .dev-sidebar {
    &__globals {
      order:          -1;
      display:        flex;
      flex-direction: column;
      align-items:    stretch;
      gap:            0;
      padding:        var(--dev-space-2) 0;
      border-top:     0;
      border-bottom:  1px solid var(--border);

      a {
        display:         flex;
        align-items:     center;
        justify-content: flex-start;
        gap:             var(--dev-space-4);
        width:           auto;
        height:          40px;
        padding:         0 var(--dev-space-5);
        border-radius:   0;
      }
    }

    &__globals-label {
      display:   block;
      font-size: 13px;
    }

    // A row a thumb can hit, in the lists as well.
    &__row, &__rancher-row, &__cluster-row { padding-top: var(--dev-space-3); padding-bottom: var(--dev-space-3); }

    // The tools on a Rancher row are hover-only on a laptop; there is no hover here.
    &__rancher-tools { opacity: 1; }
  }
}
</style>
