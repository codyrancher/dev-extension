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
import { showTerminal } from '../terminals';
import { TEMPLATES } from '../templates';
import DevList from './DevList.vue';
import Stack from '../design/Stack.vue';
import Row from '../design/Row.vue';
import {
  DEV_PRODUCT, BLANK_CLUSTER, WORKSPACE_ROUTE, CREATE_ROUTE, WORKSPACES_ROUTE,
  MY_WORK_ROUTE, INSIGHTS_ROUTE, SETTINGS_ROUTE
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
let cached = [];

export default {
  name: 'DevSidebar',

  components: { DevList, Stack, Row },

  data() {
    return {
      workspaces:   cached,
      clusters:     [],
      templates:    TEMPLATES,
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
        { label: 'Terminal', icon: 'icon-terminal', action: 'terminal' },
        {
          label: 'Insights', icon: 'icon-monitoring', route: INSIGHTS_ROUTE
        },
        {
          label: 'Settings', icon: 'icon-gear', route: SETTINGS_ROUTE
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
    sections() {
      const clusters = this.clusters.length ? this.clusters : [{ id: 'local', name: 'local' }];
      const known = new Set(clusters.map((cluster) => cluster.id));
      const strays = [...new Set(this.workspaces.map((workspace) => workspace.cluster))]
        .filter((id) => id && !known.has(id))
        .map((id) => ({
          id, name: id, memoryFree: 0, diskFree: 0
        }));
      const all = [...clusters, ...strays];

      // Template, then cluster, then workspaces. Two levels because they answer two questions
      // that are both worth asking: a template says what a workspace runs, and a cluster says
      // where it is. A cluster with nothing of this template in it is still listed, because the
      // plus on it is how one gets made there.
      return this.templates.map((template) => ({
        ...template,
        clusters: all.map((cluster) => ({
          ...cluster,
          rows: this.rowsFor(this.workspaces.filter((workspace) => (
            workspace.cluster === cluster.id && workspace.template === template.id
          ))),
        })),
      }));
    },

    /**
     * Workspaces whose template is gone, grouped the same way.
     *
     * A template removed from the code must not take its workspaces off the page with it: they
     * are still running and somebody still has to be able to delete them.
     */
    orphans() {
      const known = new Set(this.templates.map((template) => template.id));
      const lost = this.workspaces.filter((workspace) => !known.has(workspace.template));

      if (!lost.length) {
        return [];
      }

      return [...new Set(lost.map((workspace) => workspace.cluster))].map((id) => ({
        id,
        name:       id,
        memoryFree: 0,
        diskFree:   0,
        rows:       this.rowsFor(lost.filter((workspace) => workspace.cluster === id)),
      }));
    },

    /**
     * The most any one cluster has, which is what the bars are drawn against.
     *
     * A bar has to be a proportion of something. Against a cluster's own capacity every cluster
     * would look equally full; against the largest, two clusters side by side compare.
     */
    biggest() {
      return {
        memory: Math.max(...this.sections.map((section) => section.memoryFree || 0), 1),
        disk:   Math.max(...this.sections.map((section) => section.diskFree || 0), 1),
      };
    },

    currentWorkspace() {
      return this.$route.params.workspace || '';
    },
  },

  async fetch() {
    await this.refresh();
  },

  mounted() {
    this.refreshTimer = setInterval(() => this.refresh(), REFRESH_MS);
  },

  beforeUnmount() {
    clearInterval(this.refreshTimer);
  },

  methods: {
    async refresh() {
      try {
        const [workspaces, clusters] = await Promise.all([
          listAllWorkspaces(),
          listClusters().catch(() => this.clusters),
        ]);

        this.workspaces = workspaces;
        this.clusters = clusters;
        cached = workspaces;
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

    /** How full a bar is, as a percentage of the largest cluster's own capacity. */
    bar(free, total) {
      return `${ Math.max(2, Math.min(100, Math.round((free / (total || free || 1)) * 100))) }%`;
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
    createIn(cluster, template) {
      return {
        name:   CREATE_ROUTE,
        params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER },
        query:  { cluster: cluster.id, template },
      };
    },

    /** A workspace as a row: its name, its state, and the page it opens. */
    rowsFor(workspaces) {
      return workspaces.map((workspace) => ({
        key:   workspace.name,
        label: workspace.name,
        state: workspace.state,
        to:    {
          name:   WORKSPACE_ROUTE,
          params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER, workspace: workspace.name },
        },
      }));
    },


    /** The drawer, not a page. See showTerminal. */
    openTerminal() {
      showTerminal(this.$store);
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
        await deleteWorkspace(name);
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
    <div class="dev-sidebar__scroll">
      <!--
        The template, and under it the clusters its workspaces are on. The heading is not a
        DevList: a template has no rows of its own, and a list with nothing in it would draw an
        empty line under every one of them.
      -->
      <div
        v-for="template in sections"
        :key="template.id"
        class="dev-sidebar__template"
      >
        <!--
          The heading is a link to the list of every workspace, which is where one is stopped or
          deleted. The landing route redirects into a workspace, so without this the list is a
          page nothing reaches.
        -->
        <router-link
          class="dev-sidebar__template-head"
          :to="listTo"
        >
          <i
            class="dev-sidebar__template-icon icon"
            :class="template.icon"
          />
          <span class="dev-sidebar__template-label">{{ template.label }}</span>
        </router-link>

        <DevList
          v-for="section in template.clusters"
          :key="section.id"
          class="dev-sidebar__cluster"
          :label="section.name"
          icon="icon-cluster"
        :tone="low(section) ? 'warning' : ''"
        :rows="section.rows"
        :current="currentWorkspace"
        :create-to="createIn(section, template.id)"
        :create-label="`New ${ template.label } workspace on ${ section.name }`"
        deletable
        @delete="remove"
      >
        <!-- What is left on it, as two bars, while the pointer is on the name. -->
        <template #popover>
          <Stack gap="2">
            <Row
              class="dev-sidebar__meter"
              gap="3"
            >
              <span class="dev-sidebar__meter-label">MEM</span>
              <span class="dev-sidebar__meter-track"><span
                class="dev-sidebar__meter-fill"
                :style="{ width: bar(section.memoryFree, biggest.memory) }"
              /></span>
              <span class="dev-sidebar__meter-value">{{ readable(section.memoryFree) }}</span>
            </Row>
            <Row
              class="dev-sidebar__meter"
              gap="3"
            >
              <span class="dev-sidebar__meter-label">DISK</span>
              <span class="dev-sidebar__meter-track"><span
                class="dev-sidebar__meter-fill"
                :style="{ width: bar(section.diskFree, biggest.disk) }"
              /></span>
              <span class="dev-sidebar__meter-value">{{ readable(section.diskFree) }}</span>
            </Row>
          </Stack>
        </template>
        </DevList>
      </div>

      <!-- A workspace whose template has been removed from the code still has to be reachable. -->
      <div
        v-if="orphans.length"
        class="dev-sidebar__template"
      >
        <div class="dev-sidebar__template-head">
          <i class="dev-sidebar__template-icon icon icon-warning" />
          <span class="dev-sidebar__template-label">Unknown template</span>
        </div>
        <DevList
          v-for="section in orphans"
          :key="section.id"
          class="dev-sidebar__cluster"
          :label="section.name"
          icon="icon-cluster"
          :rows="section.rows"
          :current="currentWorkspace"
          deletable
          @delete="remove"
        />
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
        <button
          v-if="global.action"
          v-clean-tooltip="global.label"
          type="button"
          :aria-label="global.label"
          @click="openTerminal"
        >
          <i
            class="icon"
            :class="global.icon"
          />
        </button>
        <router-link
          v-else
          v-clean-tooltip="global.label"
          :to="globalTo(global.route)"
          :aria-label="global.label"
          :class="{ 'dev-sidebar__globals--current': isGlobalActive(global.route) }"
        >
          <i
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
      color:        var(--primary);
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
      background: var(--primary);
    }

    &__meter-value {
      flex:      0 0 auto;
      font-size: 11px;
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
