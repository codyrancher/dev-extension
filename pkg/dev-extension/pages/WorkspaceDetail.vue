<script>
// One workspace, opened: the same running thing seen three ways, and nothing above them.
//
// There is no masthead. The workspace's name and state are on the sidebar row you opened it
// from, which is on screen from every page rather than only this one, so repeating them here
// would cost the panes a strip of height to say something already said. What is left of the
// page's chrome is the tab strip, with Start and Stop at its right-hand end, because those are
// the two things worth doing from any tab. Delete is on the sidebar row and on the Workspaces
// list, both of which ask first, which is enough places for it.
//
// The tab is the hash, `#conversations`, and not a path segment the way the harness's
// `/:projectId/conversations` is. That is a deliberate divergence, and it is not a matter of
// taste:
//
//   - the shell renders its router-view with `:key="$route.path"` (components/templates/
//     blank.vue), so a tab in the path is a different component instance, and every tab click
//     destroys and rebuilds this page;
//   - the apiserver does not reap an exec'd process when its WebSocket closes, so each of those
//     rebuilds leaves the previous tab's shell running in the workspace's pod. A tab bar that
//     accumulates processes in the thing it is a view of is not a tab bar.
//
// The hash keeps the property the layout actually needs, which is that a tab is addressable and
// therefore shareable, and it is what Rancher's own detail pages use.
import Loading from '@shell/components/Loading';
import Tabbed from '@shell/components/Tabbed';
import Tab from '@shell/components/Tabbed/Tab';
import { Banner } from '@components/Banner';
import Row from '../design/Row.vue';
import { RcButton } from '@components/RcButton';
import WorkspaceConversations from '../components/WorkspaceConversations.vue';
import WorkspaceBrowser from '../components/WorkspaceBrowser.vue';
import WorkspacePorts from '../components/WorkspacePorts.vue';
import WorkspaceSidecars from '../components/WorkspaceSidecars.vue';
import {
  getWorkspace, listAllWorkspaces, setWorkspaceRunning, workspacePod, workspaceLogTail,
  sidecarReady, workspaceServing, setCluster
} from '../api';
import { templateById, templateBrowser } from '../templates';
import { rememberWorkspace, rememberTab, lastTab } from '../recent';
import {
  DEV_PRODUCT, BLANK_CLUSTER, WORKSPACES_ROUTE, WORKSPACE_TABS, DEFAULT_WORKSPACE_TAB
} from '../config/constants';

const REFRESH_MS = 5000;

export default {
  name: 'DevWorkspaceDetail',

  components: {
    Loading, Tabbed, Tab, Banner, RcButton, Row,
    WorkspaceConversations, WorkspaceBrowser, WorkspacePorts, WorkspaceSidecars
  },

  async fetch() {
    await this.refresh();
  },

  data() {
    return {
      workspace:    null,
      pod:          '',
      // The last line the container printed, while it is still starting. See refresh.
      logTail:      '',
      error:        '',
      busy:         false,
      refreshTimer: null,
      // Which tabs have been opened. Tab content is mounted on first activation and left
      // mounted afterwards: Tabbed hides an inactive tab with v-show rather than unmounting it,
      // so a terminal survives a trip to another tab, but a tab nobody opened should not have
      // opened a shell in the pod or framed the workspace's server to begin with.
      seen:         {},
      // Whether there is anything to frame, which is whether the Browser tab exists at all. See
      // refresh: it is a question about the browser sidecar, not about the workspace.
      framable:     false,
      /** The tab Tabbed is actually showing, which is what an unusable hash is corrected to. */
      active:       DEFAULT_WORKSPACE_TAB,
      listTo:       { name: WORKSPACES_ROUTE, params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER } },
    };
  },

  computed: {
    name() {
      return this.$route.params.workspace;
    },

    /**
     * The tabs this workspace actually has, which is not always all of them: Browser is there
     * only while there is something in it. Everything that reads a tab name out of the address
     * validates against this rather than the full list.
     */
    tabs() {
      return WORKSPACE_TABS.filter((name) => name !== 'browser' || this.framable);
    },

    /**
     * The tab the address names, or the default when it names none or names one that is not
     * there. Read here as well as by Tabbed, because it decides which tab's content is mounted
     * on the way up, before Tabbed has said anything.
     */
    tab() {
      const tab = this.$route.hash.replace('#', '');

      if (this.tabs.includes(tab)) {
        return tab;
      }

      // No tab in the address, or one this workspace does not have: the one you were last on,
      // which is what makes switching between two workspaces keep the same view of both. See
      // recent.ts. The default is only reached on a browser that remembers nothing.
      const remembered = lastTab();

      return this.tabs.includes(remembered) ? remembered : DEFAULT_WORKSPACE_TAB;
    },

    /** True while there is no pod to frame or talk to, which is what the tabs have to say. */
    starting() {
      return !!this.workspace && this.workspace.state !== 'running' && this.workspace.state !== 'stopped';
    },

    stopped() {
      return this.workspace?.state === 'stopped';
    },

  },

  watch: {
    /**
     * Keep the address describing the tab that is actually showing.
     *
     * Tabbed's `select()` returns without doing anything when the hash names a tab it does not
     * have, so editing `#sidecars` to `#overview` in the address bar leaves Sidecars on screen
     * with `#overview` in the URL, and copying that address shares the wrong tab. A cold load is
     * already right, because Tabbed replaces the hash itself when it falls back to the default;
     * this is the same correction for the case where the document does not reload.
     */
    '$route.hash'(hash) {
      const wanted = hash.replace('#', '');

      if (wanted && !this.tabs.includes(wanted)) {
        this.$router.replace({ ...this.$route, hash: `#${ this.active }` });
      }
    },
  },

  mounted() {
    rememberWorkspace(this.name);
    this.seen[this.tab] = true;
    this.refreshTimer = setInterval(() => this.refresh(), REFRESH_MS);
  },

  beforeUnmount() {
    clearInterval(this.refreshTimer);
  },

  methods: {
    /**
     * A tab became the active one. Recorded so its content is mounted from here on, and
     * remembered so the next workspace opens on it.
     */
    onTabChanged({ tab }) {
      this.seen[tab.name] = true;
      this.active = tab.name;
      rememberTab(tab.name);
    },

    async refresh() {
      this.workspace = await getWorkspace(this.name);

      // Point everything that follows at the cluster this workspace is actually on. It is set
      // here rather than by the router because a page is about one workspace and every request
      // it makes is about that workspace's cluster: see setCluster.
      if (this.workspace?.cluster) {
        setCluster(this.workspace.cluster);
      }

      if (!this.workspace) {
        // Nothing left to poll for. The page is now a banner saying the workspace is gone, and
        // asking again every five seconds would only repeat the 404 that proved it.
        clearInterval(this.refreshTimer);

        return;
      }

      // The sidebar is the workspace list, and this page is where someone watching one would
      // notice a change, so its poll keeps that list fresh too.
      listAllWorkspaces().catch(() => {});

      // Only ask for the pod when there could be one: a stopped workspace has none.
      this.pod = this.workspace.replicas > 0 ? await workspacePod(this.name) || '' : '';
      // The log's last line, only while the workspace is still coming up. It is the difference
      // between "Starting up" and knowing it is four minutes into an install, and once the
      // workspace is running it is the terminal's job rather than this page's.
      this.logTail = this.starting && this.pod ? await workspaceLogTail(this.name, this.pod) : '';

      this.framable = await this.canFrame();
    },

    /**
     * Whether the Browser tab has anything in it, which is what decides the tab is there.
     *
     * Two different questions, because the two kinds of template frame two different things. A
     * template with a browser sidecar is asking about the sidecar and not about the workspace:
     * the browser is worth looking at whatever the workspace is doing, since a workspace that is
     * still compiling is a page in it that says so.
     */
    async canFrame() {
      const template = templateById(this.workspace?.template);

      if (!template || this.stopped) {
        return false;
      }

      const browser = templateBrowser(template);

      if (browser) {
        return sidecarReady(this.name, browser).catch(() => false);
      }

      return workspaceServing(this.name, template.port, template.scheme).catch(() => false);
    },

    async run(action, done) {
      this.error = '';
      this.busy = true;

      try {
        await action();
        await this.refresh();
        done(true);
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      } finally {
        this.busy = false;
      }
    },

    /**
     * The one way to start a workspace from this page.
     *
     * Start and Stop used to sit on the tab strip, on the argument that they were reachable
     * from every tab and cost no height; what they actually did was put a button beside four
     * tab labels that is not a tab. The list is where a workspace is started and stopped, and
     * the banner that replaces the tabs while it is stopped offers it here.
     */
    startFromTab() {
      return this.run(() => setWorkspaceRunning(this.name, true), () => {});
    },
  },
};
</script>

<template>
  <Loading v-if="$fetchState.pending" />
  <div
    v-else-if="!workspace"
    class="dev-workspace dev-workspace--message"
  >
    <Banner
      color="warning"
      :label="`There is no workspace called ${ name }. It may have been deleted.`"
    />
    <RcButton
      variant="secondary"
      :to="listTo"
    >
      Back to workspaces
    </RcButton>
  </div>
  <div
    v-else
    class="dev-workspace"
  >
    <Banner
      v-if="error"
      color="error"
      :label="error"
    />

    <!--
      A stopped workspace is a banner and nothing else.

      The tabs used to stay, with this same banner inside the Conversations one. Every one of
      them was empty in a different way: no conversations to talk to, no ports being listened
      on, no sidecars running, and a browser that is not there. Four tabs whose only content is
      four ways of saying the workspace is stopped is worse than one sentence and the button
      that fixes it.
    -->
    <Banner
      v-if="stopped"
      color="info"
    >
      <Row gap="4">
        <span>This workspace is stopped, so there is nothing to talk to.</span>
        <RcButton
          variant="secondary"
          size="small"
          :disabled="busy"
          @click="startFromTab"
        >
          Start it
        </RcButton>
      </Row>
    </Banner>

    <Tabbed
      v-else
      class="dev-workspace__tabs"
      :default-tab="tab"
      @changed="onTabChanged"
    >
      <Tab
        name="conversations"
        label="Conversations"
        :weight="3"
      >
        <WorkspaceConversations
          v-if="seen.conversations"
          :workspace="workspace"
          :log-tail="logTail"
        />
      </Tab>

      <!--
        Only while there is a browser to frame. Absent rather than dim, because a Browser tab
        with nothing in it could only explain itself by talking about a sidecar that is started
        on the Sidecars tab, and a tab whose content is a pointer to another tab is not content.
      -->
      <Tab
        v-if="framable"
        name="browser"
        label="Browser"
        :weight="2"
      >
        <WorkspaceBrowser
          v-if="seen.browser"
          :workspace="workspace"
        />
      </Tab>

      <Tab
        name="ports"
        label="Ports"
        :weight="1"
      >
        <WorkspacePorts
          v-if="seen.ports"
          :workspace="workspace"
        />
      </Tab>

      <Tab
        name="sidecars"
        label="Sidecars"
        :weight="0"
      >
        <WorkspaceSidecars
          v-if="seen.sidecars"
          :workspace="workspace"
        />
      </Tab>
    </Tabbed>
  </div>
</template>

<style lang="scss" scoped>
  .dev-workspace {
    display:        flex;
    flex-direction: column;
    // The page is the whole area now that nothing sits above the tabs, and the panes inside it
    // are a terminal and an iframe, both of which size themselves from their container.
    height:         100%;
    min-height:     0;

    &--message {
      padding: var(--dev-space-5);
    }

    // The sentence and the button on one line, since the button is what the sentence is about.
    &__tabs {
      display:        flex;
      flex-direction: column;
      flex:           1 1 auto;
      min-height:     0;
      // Tabbed's own class sets `min-width: fit-content`, so without the max the strip grows to
      // whatever the widest pane wants and takes the page with it.
      max-width:      100%;
      // And the flex minimum, which max-width alone does not beat: a flex child's minimum is its
      // content, so the strip stayed wider than the page and put a horizontal scrollbar under
      // every tab. Both are needed, which is why the max on its own looked like it worked.
      min-width:      0;

      // The tab strip is the top edge of the page, so it keeps the shell's border between it
      // and the content but not the outer frame it would have inside a card.
      :deep(> .tabs) {
        border-top:  0;
        border-left: 0;
        border-right: 0;
      }

      // The content is everything below the strip. No padding of its own: a terminal and an
      // iframe are the two things on it, and both want the whole area.
      :deep(> .tab-container) {
        display:        flex;
        flex-direction: column;
        flex:           1 1 auto;
        min-height:     0;
        padding:        0;
        border:         0;

        > section {
          display:        flex;
          flex-direction: column;
          flex:           1 1 auto;
          min-height:     0;
          // And min-width, for the same reason and the one that is easier to forget: a flex
          // child's minimum is its content by default, so a pane refuses to be narrower than
          // what is in it and the page grows a horizontal scrollbar instead of the pane
          // wrapping. It is what put one under the Sidecars tab.
          min-width:      0;
        }
      }
    }

  }
</style>
