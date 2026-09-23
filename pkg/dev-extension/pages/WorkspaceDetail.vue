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
import WorkspacePreview from '../components/WorkspacePreview.vue';
import WorkspacePr from '../components/WorkspacePr.vue';
import WorkspaceShare from '../components/WorkspaceShare.vue';
import WorkspaceReview from '../components/WorkspaceReview.vue';
import WorkspaceRail from '../components/WorkspaceRail.vue';
import { workspaceInstance } from '../apps';
import {
  getWorkspace, listAllWorkspaces, setWorkspaceRunning, workspacePod, workspaceLogTail, workspaceServing, setCluster, workspaceFromInstance, missingCluster
} from '../api';
import {
  rememberWorkspace, rememberTab, lastTab, workspaceView, rememberWorkspaceView
} from '../recent';
import {
  WORKSPACE_TABS, DEFAULT_WORKSPACE_TAB, LABEL_CLUSTER
} from '../config/constants';
import { setViewing } from '../workspace-status';

const REFRESH_MS = 5000;

export default {
  name: 'DevWorkspaceDetail',

  components: {
    Loading, Tabbed, Tab, Banner, RcButton, Row,
    WorkspaceConversations, WorkspaceBrowser, WorkspacePreview, WorkspacePr, WorkspaceShare, WorkspaceReview, WorkspaceRail
  },

  async fetch() {
    await this.refresh();
  },

  data() {
    return {
      /** The namespace is gone but the Installation stands: a re-render in progress, not a deletion. */
      restarting: false,
      /** Its cluster is not registered here any more: there is no pod to wait for. */
      clusterGone: false,
      workspace:    null,
      pod:          '',
      // The last line the container printed, while it is still starting. See refresh.
      logTail:      '',
      error:        '',
      busy:         false,
      refreshTimer: null,
      // Whether this open has already spun a stopped workspace back up. Once: the poll re-reads
      // it as `starting`, and a second start would only race the first. See refresh.
      autoStarted:  false,
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
      /**
       * The rail or the tabs. The rail is the default; the tabs stay a link away, and a jump
       * from the rail into one tab shows the tabs for this visit without changing the default.
       */
      view:         workspaceView(),
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
    /**
     * A preview is a build to look at: it gets a Preview tab and, when its name says which, a PR
     * tab, and nothing that assumes a pod you can work in. A workspace gets the rest.
     */
    tabs() {
      const preview = !!this.workspace?.preview;

      return WORKSPACE_TABS.filter((name) => (
        (name !== 'browser' || (!preview && this.framable)) &&
        (name !== 'pr' || this.prNumber || this.issueNumber) &&
        (name !== 'preview' || preview) &&
        (name !== 'share' || !preview) &&
        (name !== 'review' || !preview) &&
        (name !== 'conversations' || !preview)
      ));
    },

    /** `pr-18600`, or `some-title-pr-18600`: the number the name carries. */
    prNumber() {
      return Number(/(?:^|-)pr-(\d+)(?:-|$)/.exec(this.name || '')?.[1]) || 0;
    },

    issueNumber() {
      return Number(/(?:^|-)issue-(\d+)(?:-|$)/.exec(this.name || '')?.[1]) || 0;
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

      return this.tabs.includes(remembered) ? remembered : (this.tabs.includes(DEFAULT_WORKSPACE_TAB) ? DEFAULT_WORKSPACE_TAB : this.tabs[0]);
    },

    /** True while there is no pod to frame or talk to, which is what the tabs have to say. */
    starting() {
      return !!this.workspace && this.workspace.state !== 'running' && this.workspace.state !== 'stopped';
    },

    stopped() {
      return this.workspace?.state === 'stopped';
    },

    /** The rail is for a workspace named for an issue or a PR; anything else opens on its tabs. */
    railable() {
      return !!this.workspace && !this.workspace.preview && (this.prNumber > 0 || this.issueNumber > 0);
    },

    showRail() {
      return this.railable && this.view === 'rail';
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
    // Held out of the background spin-down while this page is open: the one workspace being
    // watched is the one a stop would be felt on. See setViewing / autoStopIdle.
    setViewing(this.name);
    this.seen[this.tab] = true;
    this.refreshTimer = setInterval(() => this.refresh(), REFRESH_MS);
  },

  beforeUnmount() {
    clearInterval(this.refreshTimer);
    setViewing('');
  },

  methods: {
    /** The explicit switch: remembered, so the next workspace opens the same way. */
    setView(view) {
      this.view = view;
      rememberWorkspaceView(view);
    },

    /** A jump from the rail into one tab: the tabs for now, the rail again next time. */
    openTab(name) {
      this.view = 'tabs';
      this.seen[name] = true;
      this.active = name;
      this.$router.replace({ ...this.$route, hash: `#${ name }` }).catch(() => {});
    },

    /**
     * A tab became the active one. Recorded so its content is mounted from here on, and
     * remembered so the next workspace opens on it.
     */
    onTabChanged({ tab }) {
      this.seen[tab.name] = true;
      this.active = tab.name;
      rememberTab(tab.name);
    },

    /**
     * Point BASE at this workspace's own cluster before anything reads the workspace.
     *
     * getWorkspace reads the namespace out of BASE, but the page does not know the cluster until
     * it has read the workspace - and a workspace hosted on a downstream cluster is not in
     * `local`, so that first read finds nothing, the page never learns where to look, and it sits
     * on the "restarting" banner for ever (the Installation still stands, so it is not read as
     * deleted). The Installation is a management object, the same on every cluster, and it carries
     * the cluster as a label; read it first and set BASE from it. Local workspaces resolve to
     * `local` and are unaffected. See setCluster / LABEL_CLUSTER / getWorkspace.
     */
    async resolveCluster() {
      try {
        const instance = await workspaceInstance(this.$store, this.name);
        const cluster = instance?.metadata?.labels?.[LABEL_CLUSTER];

        if (cluster) {
          setCluster(cluster);
        }
      } catch { /* leave BASE as it is; a local workspace is found there anyway */ }
    },

    async refresh() {
      // Until the workspace is known, BASE may be pointed at the wrong cluster - a downstream
      // workspace is not in `local` - so resolve the cluster from the Installation first, and keep
      // trying each poll until it is known (the first read of the Installation list can miss).
      // Once the workspace is loaded, the setCluster below keeps BASE on its cluster.
      if (!this.workspace?.cluster) {
        await this.resolveCluster();
      }

      const fresh = await getWorkspace(this.name);

      this.clusterGone = false;

      if (!fresh) {
        // No namespace is not the same as no workspace. A workspace being re-rendered onto a
        // changed App has its namespace deleted and made again, and for those seconds - or for
        // one failed request - this page used to declare it deleted, stop polling, and tear
        // down the conversation that was open in it. The conversation runs in the agent pod and
        // was never affected. The Installation is the workspace's identity: while it stands,
        // keep what is on screen and keep looking.
        //
        // And a request that failed is not a request that answered "no". Rancher restarting
        // underneath this page made every lookup fail for a minute, and the page took that
        // for a deletion and stopped asking - so it stayed a "may have been deleted" banner
        // until somebody reloaded it. Absence is only believed when the Installation lookup
        // itself succeeded and found nothing; anything less keeps the page and keeps polling.
        let instance;

        try {
          instance = await workspaceInstance(this.$store, this.name);
        } catch {
          instance = undefined;
        }

        if (instance !== null) {
          if (!this.workspace && instance) {
            // First open of a workspace still coming up - a downstream one whose cluster is
            // provisioning, or whose namespace has not answered yet. The Installation is already
            // here, so show the workspace as starting from it rather than a blank "not answering"
            // page; the next poll fills in the real record once the namespace answers.
            this.workspace = workspaceFromInstance(instance);
            this.restarting = false;
            if (this.workspace.cluster) {
              setCluster(this.workspace.cluster);
            }
          } else {
            // A workspace already on screen missed a lookup - a re-render, a flap. Keep it and say
            // it is catching up rather than tearing it down.
            this.restarting = true;
          }

          return;
        }
        this.workspace = null;
        this.restarting = false;

        return;
      }
      this.restarting = false;
      this.workspace = fresh;
      // A workspace outlives the cluster it was made on. When that cluster is no longer
      // registered here there is no pod to find and never will be, so the page says that
      // rather than "its pod is not answering", which reads as something that will pass.
      this.clusterGone = await missingCluster(fresh.cluster).catch(() => false);

      // Point everything that follows at the cluster this workspace is actually on. It is set
      // here rather than by the router because a page is about one workspace and every request
      // it makes is about that workspace's cluster: see setCluster.
      if (this.workspace?.cluster) {
        setCluster(this.workspace.cluster);
      }

      // Opening a stopped workspace starts it: the spin-down (autoStopIdle) leaves idle ones
      // stopped, and this is the "spin up" half - a workspace is here because someone came to
      // use it. Once per open; the next poll reads it as `starting`.
      if (!this.autoStarted && this.workspace?.state === 'stopped') {
        this.autoStarted = true;
        setWorkspaceRunning(this.name, true, this.workspace.cluster)
          .then(() => this.refresh())
          .catch(() => {});
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
    /** Whether what the workspace serves answers yet, which is when a Browser tab has something to frame. */
    async canFrame() {
      if (!this.workspace || this.stopped) {
        return false;
      }
      // Nothing listening yet is what the Deployment's readiness says (the workspace container
      // has a TCP probe on its port): asking the service proxy instead answered 503 every few
      // seconds, and the browser logs each one as an error. The proxy is only asked once a pod
      // is ready, when it answers.
      if (!(this.workspace.ready > 0)) {
        return false;
      }

      return workspaceServing(this.name, this.workspace.port, this.workspace.scheme).catch(() => false);
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
      v-if="restarting"
      color="info"
      :label="`${ name } is restarting, or this Rancher is - its pod is not answering right now. Conversations carry on; this page catches up in a moment.`"
    />
    <Banner
      v-else
      color="warning"
      :label="`There is no workspace called ${ name }. It may have been deleted.`"
    />
  </div>
  <div
    v-else
    class="dev-workspace"
  >
    <!--
      Its cluster is gone: said plainly, because "the pod is not answering" reads as something
      that will pass, and this will not until the workspace is made somewhere that exists.
    -->
    <Banner
      v-if="clusterGone"
      color="warning"
      :label="`${ name } was made on cluster ${ workspace.cluster }, which is not registered in this Rancher any more. It has no pod and cannot get one; its conversations are in the agent pod and still open. Make it again on a cluster that is here, or delete it.`"
    />
    <Banner
      v-else-if="restarting"
      color="info"
      :label="`${ name } is restarting, or this Rancher is - its pod is not answering right now. Conversations carry on.`"
    />
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

    <!--
      Only the tabbed view needs a row of its own to get out of. The stage view puts its own
      link in its header, beside the title and what the agent is doing, so this row would be a
      second copy of it above the page.
    -->
    <div
      v-if="!stopped && railable && !showRail"
      class="dev-workspace__switch"
    >
      <a
        @click.prevent="setView('rail')"
      >Stage view</a>
    </div>

    <WorkspaceRail
      v-if="!stopped && showRail"
      :workspace="workspace"
      :pr="prNumber"
      :issue="issueNumber"
      @open-tab="openTab"
      @switch-view="setView"
    />

    <Tabbed
      v-else-if="!stopped"
      class="dev-workspace__tabs"
      :default-tab="tab"
      @changed="onTabChanged"
    >
      <!-- The tabs the Tabbed shows are these; the `tabs` computed above mirrors their v-ifs. -->
      <Tab
        v-if="!workspace.preview"
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
        What the agent has changed, before it is a pull request: the branch's diff out of the
        checkout it works in, and comments that go to it as the next prompt.
      -->
      <Tab
        v-if="!workspace.preview"
        name="review"
        label="Review"
        :weight="2.7"
      >
        <WorkspaceReview
          v-if="seen.review"
          :workspace="workspace"
        />
      </Tab>

      <!--
        The pull request this workspace is for, when its name says which: `pr-<n>`, or
        `issue-<n>` for the PR that closes that issue. A workspace named neither has no PR tab,
        for the reason the Browser tab is absent rather than empty.
      -->
      <Tab
        v-if="prNumber || issueNumber"
        name="pr"
        label="PR"
        :weight="2.5"
      >
        <WorkspacePr
          v-if="seen.pr"
          :workspace="workspace"
          :pr="prNumber"
          :issue="issueNumber"
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

      <!--
        Where a workspace's work is shown to someone else: a static build of the dashboard, or
        of its Storybook, on a link. Infrastructure apart from tools - the build talks to
        whichever Rancher it is told to, and the person it is sent to needs only an account
        there. A preview's own page has the Preview tab below instead.
      -->
      <Tab
        v-if="!workspace.preview"
        name="share"
        label="Share"
        :weight="1.5"
      >
        <WorkspaceShare
          v-if="seen.share"
          :workspace="workspace"
          :pr="prNumber"
          :issue="issueNumber"
        />
      </Tab>

      <Tab
        v-if="workspace.preview"
        name="preview"
        label="Preview"
        :weight="1"
      >
        <WorkspacePreview
          v-if="seen.preview"
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

    // The way to the other view. In the flow rather than over it: floated in the corner it sat
    // on top of whatever the page put there - the rail's primary button, most of the time.
    &__switch {
      display:         flex;
      justify-content: flex-end;
      flex:            0 0 auto;
      padding:         8px 24px 0;

      a {
        font-size: 12px;
        cursor:    pointer;
      }
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

      // Above the phone breakpoint, where design/mobile.css does not reach.
      //
      // A mouse does not need a 44px target, so the height is the shell's; what it does need is
      // to be able to tell which tab it is on, and the shell's answer to that is `--active` text
      // over a 2px rule. `--active` is nine values of red away from the link blue the other four
      // tabs are already painted in, which leaves 2px of underline saying the whole of it. So the
      // rest of the row recedes to label grey and the selected one is the only coloured, bold,
      // underlined thing in the strip - the same reading as the phone's filled tab, drawn the way
      // a pointer expects rather than a thumb.
      //
      // Scoped to this page rather than added to the global sheet: this is the only Tabbed in the
      // product, and a rule that need not reach the rest of Rancher should not.
      @media (min-width: 761px) {
        :deep(> .tabs) {
          // Between the tabs, not on each tab's sides, for the reason design/mobile.css gives.
          gap: var(--dev-space-3);

          li.tab {
            padding: 0;

            a { padding: var(--dev-space-4) var(--dev-space-5); }

            &:not(.active) > a { color: var(--input-label); }

            &.active {
              border-bottom-width: 3px;
              border-bottom-color: var(--dev-accent);

              > a {
                color:       var(--dev-accent);
                font-weight: 600;
              }
            }
          }
        }
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
