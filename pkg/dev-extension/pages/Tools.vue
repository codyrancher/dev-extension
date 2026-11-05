<script>
/**
 * The tools, as a product rather than as four buttons on a workspace.
 *
 * A workspace page answers "what has this work attached". This answers the questions that are
 * about the tools themselves: what they are, whether two pieces of work can share one, how many
 * are running and on whose work, when each lease runs out, and how to talk to one.
 *
 * It reads `allTools()`, which is the same dev-api call the workspace page and the agent's
 * `tools` command use - so what this shows and what an agent sees cannot drift apart.
 *
 * Editing a tool is editing its Apps Plus App, and this links there rather than growing a second
 * editor: the templates are the tool, and two places to change them is the one arrangement
 * guaranteed to disagree.
 */
import { Banner } from '@components/Banner';
import DevPage from '../components/DevPage.vue';
import DevCard from '../components/DevCard.vue';
import { RcButton } from '@components/RcButton';
import { inject } from 'vue';
import {
  TOOLS, TOOL_ORDER, WORKSPACE_TOOL, toolHref
} from '../tools';
import { DEV_SOURCES, restSources } from '../ioc';
import { TOOL_APPS } from '../config/constants';
import { APP, PRODUCT_NAME, BLANK_CLUSTER } from '../config/types';
import { toolDefinitions } from '../lte';
import { ago } from '../workspace-rail';
import { listRanchers } from '../ranchers';
import {
  readRancherMaster, installRancherMaster, removeRancherMaster, moveRancherMaster, controlRancherMaster, masterCommitUrl, RANCHER_MASTER_OPENAPI
} from '../rancher-master';

export default {
  name: 'DevTools',

  components: {
    Banner, RcButton, DevPage, DevCard
  },

  /**
   * Where this page's data comes from, asked for rather than imported.
   *
   * `restSources()` as the default is the whole of it: with no provider above it, this page
   * talks to dev-api exactly as it did when it imported the functions. With one, it talks to
   * whatever the host gave it - a fixture, a second Rancher - without a line changing here.
   * See ioc.ts.
   */
  setup() {
    return { sources: inject(DEV_SOURCES, restSources()) };
  },

  data() {
    return {
      running:  [],
      loading:  true,
      error:    '',
      /** Which tool's OpenAPI is open. */
      spec:     '',
      busy:     '',
      /*
       * rancher-master, which is not a row per workspace like the rest: one Installation, read
       * from dev-api, with what a person can do to it - install it on a Rancher, hold it, move it
       * back, let it follow master again. `pick` is the Rancher chosen to install on and `back`
       * the kept build chosen to go back to.
       */
      master:       null,
      masterError:  '',
      ranchers:     [],
      pick:         '',
      back:         '',
      /** Said after a change, until the pod has had its 15 seconds to act on it. */
      masterNote:   '',
      /** Choosing a different Rancher to put it in front of, and which. */
      moving:       false,
      moveTo:       '',
    };
  },

  computed: {
    /**
     * Where it stands, in one phrase and a tone: the header's pill. Held and paused are the two
     * a person did and has to undo, so they are the ones drawn as a warning.
     */
    masterState() {
      const m = this.master;

      if (!m) {
        return { label: '', tone: '' };
      }
      if (!m.installed) {
        return { label: 'Not installed', tone: 'off' };
      }
      if (!m.status) {
        return { label: 'Starting', tone: 'off' };
      }
      if (m.status.pin) {
        return { label: `Held on ${ m.status.pin }`, tone: 'held' };
      }
      if (m.status.paused) {
        return { label: 'Updates paused', tone: 'held' };
      }

      return { label: 'Following master', tone: 'ok' };
    },

    /** The served build's own entry, for its message. */
    masterServing() {
      const st = this.master?.status;

      return (st?.builds || []).find((b) => b.sha === st.current) || null;
    },

    /** Whether master has moved past what is served, which is the one thing worth saying about master. */
    masterBehind() {
      const st = this.master?.status;

      return !!(st?.head && st.current && !st.head.startsWith(st.current));
    },

    /** The Ranchers it could move to: every one it could be installed on, less the one it is on. */
    moveChoices() {
      return this.ranchers.filter((r) => r.name !== this.master?.rancher);
    },

    WORKSPACE_TOOL() {
      return WORKSPACE_TOOL;
    },

    /**
     * Every tool kind, with what is running of it.
     *
     * The list is the kinds rather than the instances, because a tool with nothing running is
     * still a tool - and a page that only showed the running ones would be a page that is empty
     * exactly when somebody is looking for what they could start.
     */
    tools() {
      const defs = Object.fromEntries(toolDefinitions().map((def) => [def.kind, def]));

      return TOOL_ORDER.map((kind) => {
        const meta = TOOLS[kind];
        const instances = this.running.filter((tool) => tool.kind === kind && tool.running);

        return {
          kind,
          label:       meta.label,
          icon:        meta.icon,
          what:        meta.what,
          multitenant: meta.multitenant,
          sharing:     meta.sharing || '',
          app:         TOOL_APPS[kind] || '',
          openapi:     defs[kind]?.openapi || (kind === 'rancher-master' ? RANCHER_MASTER_OPENAPI : ''),
          instances,
        };
      });
    },
  },

  mounted() {
    this.refresh();
  },

  beforeUnmount() {
    clearTimeout(this.masterTimer);
  },

  methods: {
    ago,
    toolHref,

    /**
     * The Apps Plus App behind a tool, where its templates are edited.
     *
     * A link to that page rather than an editor here: the templates *are* the tool, and two
     * places to change them is the one arrangement guaranteed to disagree.
     */
    appHref(app) {
      return `/dashboard/c/${ BLANK_CLUSTER }/${ PRODUCT_NAME }/${ APP }/${ app }`;
    },

    async refresh() {
      this.error = '';
      this.loading = true;
      this.readMaster();

      try {
        this.running = await this.sources.allTools();
      } catch (e) {
        this.error = e.message || String(e);
      } finally {
        this.loading = false;
      }
    },

    masterCommitUrl,

    /** rancher-master's state, and the Ranchers it could go on when it is on none. */
    async readMaster() {
      try {
        this.master = await readRancherMaster();
        this.masterError = '';
        const builds = this.master?.status?.builds || [];

        if (!builds.some((b) => b.sha === this.back)) {
          this.back = (builds.find((b) => b.sha !== this.master.status.current) || builds[0] || {}).sha || '';
        }
        if (!this.master.installed && !this.ranchers.length) {
          await this.readRanchers();
        }
      } catch (e) {
        this.masterError = e.message || String(e);
      }
    },

    /** The sidebar's Ranchers that are up with a public node: what it can be put in front of. */
    async readRanchers() {
      this.ranchers = (await listRanchers(this.$store).catch(() => []))
        .filter((r) => r.kind === 'instance' && r.phase === 'ready' && r.clusterId && r.nodeIp);
      this.pick = this.pick || this.ranchers[0]?.name || '';
    },

    /** Open the backend picker, with the list read fresh: a Rancher made since the page loaded counts. */
    async startMove() {
      this.moving = true;
      await this.readRanchers();
      this.moveTo = this.moveChoices.some((r) => r.name === this.moveTo) ? this.moveTo : (this.moveChoices[0]?.name || '');
    },

    moveMaster() {
      const rancher = this.ranchers.find((r) => r.name === this.moveTo);

      if (!rancher) {
        return;
      }

      return this.masterDo('move', async() => {
        await moveRancherMaster(this.$store, rancher, (step) => {
          this.masterNote = `${ step }\u2026`;
        });
        this.moving = false;
      }, `Moved in front of ${ rancher.name }. Its first build is fetched as the pod starts, which takes a minute or two; the link has changed with it.`);
    },

    async masterDo(what, fn, note = '') {
      this.busy = `master/${ what }`;
      this.masterError = '';
      try {
        await fn();
        this.masterNote = note;
        await this.readMaster();
        if (note) {
          // The pod reads its control every 15 seconds; look again once it has.
          clearTimeout(this.masterTimer);
          this.masterTimer = setTimeout(() => {
            this.masterNote = '';
            this.readMaster();
          }, 17000);
        }
      } catch (e) {
        this.masterError = e.message || String(e);
      } finally {
        this.busy = '';
      }
    },

    installMaster() {
      const rancher = this.ranchers.find((r) => r.name === this.pick);

      return this.masterDo('install', () => installRancherMaster(this.$store, rancher), 'Installing. Its first build is fetched as the pod starts, which takes a minute or two.');
    },

    removeMaster() {
      return this.masterDo('remove', () => removeRancherMaster());
    },

    /** Hold it where it is: no more fetching, and whatever is served stays. */
    pauseMaster() {
      return this.masterDo('pause', () => controlRancherMaster(this.master.cluster, { paused: true, pin: this.master.status?.pin || '' }), 'Pausing: takes effect within 15 seconds.');
    },

    /** Back to following master: the newest kept build, and fetching each new one. */
    followMaster() {
      return this.masterDo('follow', () => controlRancherMaster(this.master.cluster, { paused: false, pin: '' }), 'Following master again: the newest build is served within 15 seconds.');
    },

    /**
     * Serve a kept build. Fetching goes on - a held build is still a reason to have the next one
     * ready - unless updates were already paused, which stays as it was.
     */
    serveBuild() {
      return this.masterDo('back', () => controlRancherMaster(this.master.cluster, { paused: !!this.master.status?.paused, pin: this.back }), `Serving ${ this.back } within 15 seconds.`);
    },

    buildLabel(b) {
      const when = b.date ? ago(b.date) : (b.fetched ? `fetched ${ ago(b.fetched) }` : '');

      return `${ b.sha }${ b.message ? ` — ${ b.message.slice(0, 70) }` : '' }${ when ? ` (${ when })` : '' }`;
    },

    async renew(tool) {
      this.busy = `${ tool.workspace }/${ tool.kind }`;

      try {
        await this.sources.renewTool(tool.workspace, tool.kind);
        await this.refresh();
      } catch (e) {
        this.error = e.message || String(e);
      } finally {
        this.busy = '';
      }
    },

    async stop(tool) {
      this.busy = `${ tool.workspace }/${ tool.kind }`;

      try {
        await this.sources.stopTool(tool.workspace, tool.kind);
        await this.refresh();
      } catch (e) {
        this.error = e.message || String(e);
      } finally {
        this.busy = '';
      }
    },
  },
};
</script>

<template>
  <DevPage
    title="Tools"
    lede="What can be attached to a piece of work, and what is attached now."
  >
    <template #actions>
      <RcButton
        variant="link"
        size="small"
        :disabled="loading"
        @click="refresh"
      >
        Refresh
      </RcButton>
    </template>

    <Banner
      v-if="error"
      color="warning"
    >
      {{ error }}
    </Banner>

    <div
      v-if="loading && !running.length"
      class="dev-tools__loading"
    >
      <i class="icon icon-spinner icon-spin" />
      <span>Reading what is running&hellip;</span>
    </div>

    <div
      v-for="tool in tools"
      :key="tool.kind"
      class="dev-tools__tool"
    >
      <header class="dev-tools__head">
        <i
          class="icon"
          :class="tool.icon"
        />
        <strong>{{ tool.label }}</strong>

        <!--
          Whether two pieces of work can hold one. The shared one is the interesting case, so it
          says what sharing it costs rather than only that it is shared.
        -->
        <span
          class="dev-tools__tenancy"
          :class="tool.multitenant ? 'dev-tools__tenancy--per' : 'dev-tools__tenancy--shared'"
          :title="tool.multitenant ? 'One instance per workspace' : tool.sharing"
        >{{ tool.multitenant ? 'per workspace' : 'shared' }}</span>

        <span
          v-if="tool.kind !== 'rancher-master'"
          class="dev-tools__count"
        >
          {{ tool.instances.length }} running
        </span>
        <span
          v-else-if="masterState.label"
          class="dev-tools__state"
          :class="`dev-tools__state--${ masterState.tone }`"
        >{{ masterState.label }}</span>

        <RcButton
          v-if="tool.openapi"
          variant="link"
          size="small"
          @click="spec = spec === tool.kind ? '' : tool.kind"
        >
          {{ spec === tool.kind ? 'Hide the API' : 'How to talk to it' }}
        </RcButton>

        <a
          v-if="tool.app"
          :href="appHref(tool.app)"
          class="dev-tools__app"
          :title="`Edit ${ tool.app } - the templates are the tool`"
        >{{ tool.app }}</a>
      </header>

      <p class="dev-tools__what">{{ tool.what }}</p>

      <!--
        Not for rancher-master: what sharing it costs is only worth a banner while somebody is
        holding it, and its card says so then, beside the button that lets go. The chip carries
        it as a tooltip the rest of the time.
      -->
      <Banner
        v-if="!tool.multitenant && tool.kind !== 'rancher-master'"
        color="info"
      >
        {{ tool.sharing }}
      </Banner>

      <!-- The OpenAPI, as written on the App. See toolMeta in lte.ts. -->
      <pre
        v-if="spec === tool.kind"
        class="dev-tools__spec"
      >{{ tool.openapi }}</pre>

      <!--
        rancher-master: one for everybody, so not a table of workspaces. What it serves, and the
        three things a person does to it - hold it, move it back, let it follow master again.
      -->
      <div
        v-if="tool.kind === 'rancher-master'"
        class="dev-tools__master"
      >
        <Banner
          v-if="masterError"
          color="error"
        >
          {{ masterError }}
        </Banner>

        <template v-if="master && master.installed">
          <!--
            Three facts, a label each: where to open it, what it serves, and what it is in front
            of. master's own head is only news when it is ahead of what is served, so it is a
            clause on Serving rather than a row of its own.
          -->
          <dl class="dev-tools__master-facts">
            <dt>Link</dt>
            <dd>
              <a
                :href="master.url"
                target="_blank"
                rel="noopener noreferrer"
                class="dev-tools__master-url"
              >{{ master.url }}</a>
            </dd>

            <dt>Serving</dt>
            <dd v-if="!master.status">
              <span class="text-muted">{{ master.detail }}</span>
            </dd>
            <dd v-else-if="!master.status.current">
              <span class="text-muted">nothing yet: the first build is being fetched</span>
            </dd>
            <dd v-else>
              <a
                :href="masterCommitUrl(master.status.current)"
                target="_blank"
                rel="noopener noreferrer"
                class="dev-tools__sha"
              >{{ master.status.current }}</a>
              <span class="dev-tools__msg">{{ masterServing ? masterServing.message : '' }}</span>
              <span
                v-if="masterBehind"
                class="text-muted"
              >· master is at
                <a
                  :href="masterCommitUrl(master.status.head)"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="dev-tools__sha"
                >{{ master.status.head.slice(0, 7) }}</a>{{ master.status.paused || master.status.pin ? '' : ', its build lands about 15 minutes after the push' }}</span>
            </dd>

            <dt>Backend</dt>
            <dd v-if="!moving">
              <a
                v-if="master.rancherUrl"
                :href="master.rancherUrl"
                target="_blank"
                rel="noopener noreferrer"
              >{{ master.rancher }}</a>
              <span v-else>{{ master.rancher }}</span>
              <RcButton
                variant="link"
                size="small"
                :disabled="!!busy"
                @click="startMove"
              >
                Change
              </RcButton>
            </dd>
            <dd
              v-else
              class="dev-tools__move"
            >
              <template v-if="moveChoices.length">
                <select
                  v-model="moveTo"
                  aria-label="The Rancher to put master in front of instead"
                  :disabled="!!busy"
                >
                  <option
                    v-for="r in moveChoices"
                    :key="r.name"
                    :value="r.name"
                  >{{ r.name }}</option>
                </select>
                <RcButton
                  size="small"
                  variant="primary"
                  :disabled="!!busy || !moveTo"
                  @click="moveMaster"
                >
                  <i
                    v-if="busy === 'master/move'"
                    class="icon icon-spinner icon-spin"
                  />
                  Move it there
                </RcButton>
              </template>
              <span
                v-else
                class="text-muted"
              >No other Rancher in the sidebar is up with a public node.</span>
              <RcButton
                variant="link"
                size="small"
                :disabled="!!busy"
                @click="moving = false"
              >
                Cancel
              </RcButton>
              <span
                v-if="moveChoices.length"
                class="dev-tools__move-note text-muted"
              >It is reinstalled on that Rancher's cluster, so the link changes, kept builds stay behind and it goes back to following master.</span>
            </dd>
          </dl>

          <p
            v-if="master.status && master.status.error"
            class="dev-tools__master-error"
          >{{ master.status.error }}</p>

          <!--
            The one thing the old banner was for, said when it is true: a hold is everybody's.
          -->
          <p
            v-if="master.status && (master.status.paused || master.status.pin)"
            class="dev-tools__held"
          >
            Held for every workspace. Put it back to following master when you are done.
          </p>

          <div
            v-if="master.status"
            class="dev-tools__master-actions"
          >
            <RcButton
              v-if="master.status.paused || master.status.pin"
              size="small"
              variant="secondary"
              :disabled="!!busy"
              @click="followMaster"
            >
              {{ master.status.pin ? 'Follow master again' : 'Resume updates' }}
            </RcButton>
            <RcButton
              v-if="!master.status.paused"
              size="small"
              variant="secondary"
              :disabled="!!busy"
              @click="pauseMaster"
            >
              Pause updates
            </RcButton>

            <!-- Only once there is something to go back to: one kept build is the one served. -->
            <span
              v-if="(master.status.builds || []).length > 1"
              class="dev-tools__master-back"
            >
              <select
                v-model="back"
                aria-label="An earlier build to serve"
                title="Only builds this tool has fetched: master's build is published at one address and replaced by each push, so the history starts when it was installed."
                :disabled="!!busy"
              >
                <option
                  v-for="b in master.status.builds"
                  :key="b.sha"
                  :value="b.sha"
                >{{ buildLabel(b) }}{{ b.sha === master.status.current ? ' · serving' : '' }}</option>
              </select>
              <RcButton
                size="small"
                variant="secondary"
                :disabled="!!busy || !back || back === master.status.current"
                @click="serveBuild"
              >
                Serve this build
              </RcButton>
            </span>

            <span class="dev-tools__checked text-muted">
              Checked {{ master.status.checked ? ago(master.status.checked) : '' }} · {{ (master.status.builds || []).length }} {{ (master.status.builds || []).length === 1 ? 'build' : 'builds' }} kept
            </span>

            <RcButton
              variant="link"
              size="small"
              class="dev-tools__master-remove"
              :disabled="!!busy"
              @click="removeMaster"
            >
              Remove
            </RcButton>
          </div>
        </template>

        <template v-else-if="master">
          <p class="text-muted dev-tools__none">
            Not installed. It goes in front of a Rancher of the sidebar's, which needs a public node for the link to open from anywhere.
          </p>
          <div
            v-if="ranchers.length"
            class="dev-tools__master-actions"
          >
            <select
              v-model="pick"
              aria-label="The Rancher to put master in front of"
            >
              <option
                v-for="r in ranchers"
                :key="r.name"
                :value="r.name"
              >{{ r.name }}</option>
            </select>
            <RcButton
              size="small"
              :disabled="!!busy || !pick"
              @click="installMaster"
            >
              Install
            </RcButton>
          </div>
          <p
            v-else
            class="text-muted dev-tools__none"
          >No Rancher in the sidebar is up with a public node. Make one there first.</p>
        </template>

        <p
          v-if="masterNote"
          class="text-muted dev-tools__none"
        >{{ masterNote }}</p>
      </div>

      <p
        v-else-if="!tool.instances.length"
        class="text-muted dev-tools__none"
      >Nothing running. One is attached from a workspace, or with <code>tools start {{ tool.kind }}</code> inside one.</p>

      <table
        v-else
        class="dev-tools__table"
      >
        <thead>
          <tr>
            <th>Workspace</th>
            <th>Where</th>
            <th>Lease</th>
            <th>State</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="inst in tool.instances"
            :key="inst.workspace + inst.kind"
          >
            <td>{{ inst.workspace }}</td>
            <td>
              <a
                v-if="toolHref(inst)"
                :href="toolHref(inst)"
                target="_blank"
                rel="noopener noreferrer"
              >open</a>
              <code
                v-if="inst.namespace"
                class="dev-tools__ns"
              >{{ inst.namespace }}</code>
            </td>
            <td :title="inst.expires || ''">
              <span v-if="inst.expires">{{ ago(inst.expires) }}</span>
              <span
                v-else
                class="text-muted"
              >&mdash;</span>
            </td>
            <td>
              <span v-if="inst.removing">removing</span>
              <span v-else-if="inst.ready">ready</span>
              <span v-else>{{ inst.detail || 'starting' }}</span>
            </td>
            <td class="dev-tools__row-actions">
              <!-- The shared tool has no lease of its own and nothing to stop. -->
              <template v-if="!inst.shared">
                <RcButton
                  variant="link"
                  size="small"
                  :disabled="busy === inst.workspace + '/' + inst.kind"
                  @click="renew(inst)"
                >
                  Renew
                </RcButton>
                <RcButton
                  variant="link"
                  size="small"
                  :disabled="busy === inst.workspace + '/' + inst.kind"
                  @click="stop(inst)"
                >
                  Stop
                </RcButton>
              </template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!--
      The workspace, which is what the tools above attach to rather than one of them.
      Listed here because it is now as disposable as they are - an agent can take one and give
      it back - and because somebody reading this page to find out what can be asked for should
      not have to know that one of the answers lives somewhere else.
    -->
    <div class="dev-tools__tool dev-tools__tool--subject">
      <header class="dev-tools__head">
        <i class="icon icon-folder" />
        <strong>{{ WORKSPACE_TOOL.label }}</strong>
        <span
          class="dev-tools__tenancy dev-tools__tenancy--per"
          title="Every workspace is its own; two pieces of work never share one"
        >per workspace</span>
        <span class="dev-tools__count">what the tools attach to</span>
        <RcButton
          variant="link"
          size="small"
          @click="spec = spec === 'workspace' ? '' : 'workspace'"
        >
          {{ spec === 'workspace' ? 'Hide the API' : 'How to talk to it' }}
        </RcButton>
      </header>

      <p class="dev-tools__what">{{ WORKSPACE_TOOL.what }}</p>

      <pre
        v-if="spec === 'workspace'"
        class="dev-tools__spec"
      >{{ WORKSPACE_TOOL.openapi }}</pre>
    </div>
  </DevPage>
</template>

<style lang="scss" scoped>
.dev-tools__loading {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 24px 0;
  color: var(--muted);
}

/* The box itself is DevCard's; what is left here is this page's own spacing inside it. */
.dev-tools__tool {
  margin:        0 0 var(--dev-space-4);
  padding:       var(--dev-space-3);
  border:        1px solid var(--border);
  border-radius: var(--r-sm);
  background:    var(--box-bg);
}

.dev-tools__head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.dev-tools__tenancy {
  padding: 0 8px;
  border-radius: var(--r-md);
  font-size: 11px;
}

.dev-tools__tenancy--per    { background: var(--default); color: var(--muted); }
/* A fact about the tool, not a warning: amber is kept for a shared tool somebody is holding
   (rancher-master's state pill), which is the moment sharing costs anybody anything. */
.dev-tools__tenancy--shared { border: 1px solid var(--border); color: var(--muted); }

.dev-tools__count { color: var(--muted); font-size: 12px; }

.dev-tools__app { margin-left: auto; font-family: monospace; font-size: 12px; }

.dev-tools__what { margin: 8px 0 0; color: var(--muted); font-size: 12px; }

.dev-tools__none { margin: 8px 0 0; font-size: 12px; }

.dev-tools__spec {
  margin: 8px 0 0;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: var(--dev-r-ctl);
  background: var(--default);
  font-size: 11px;
  overflow: auto;
  max-height: 260px;
}

.dev-tools__table {
  width: 100%;
  margin-top: 10px;
  border-collapse: collapse;
  font-size: 12px;

  th, td {
    text-align: left;
    padding: 4px 8px;
    border-bottom: 1px solid var(--border);
  }

  th { color: var(--muted); font-weight: normal; }
}

.dev-tools__ns { margin-left: 8px; color: var(--muted); }

.dev-tools__master { margin-top: 12px; font-size: 13px; }

/* Where it stands, as a pill: green while it follows master, amber while somebody holds it. */
.dev-tools__state {
  display:       inline-flex;
  align-items:   center;
  gap:           6px;
  padding:       0 8px;
  border-radius: var(--r-md);
  font-size:     11px;
  line-height:   18px;
  background:    var(--default);
  color:         var(--muted);

  &::before {
    content:       '';
    width:         6px;
    height:        6px;
    border-radius: 50%;
    background:    currentColor;
  }
}

.dev-tools__state--ok   { background: var(--success-banner-bg); color: var(--success); }
.dev-tools__state--held { background: var(--warning-banner-bg); color: var(--warning); }

.dev-tools__master-facts {
  display:               grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap:                   8px 16px;
  margin:                0;
  padding:               10px 12px;
  border:                1px solid var(--border);
  border-radius:         var(--dev-r-ctl);

  dt {
    color:          var(--muted);
    font-size:      11px;
    line-height:    20px;
    text-transform: uppercase;
    letter-spacing: .04em;
  }

  dd {
    display:     flex;
    flex-wrap:   wrap;
    gap:         4px 8px;
    align-items: center;
    min-width:   0;
    margin:      0;
    line-height: 20px;
  }
}

.dev-tools__master-url { overflow-wrap: anywhere; }

.dev-tools__sha {
  font-family: monospace;
  font-size:   12px;
}

.dev-tools__msg { min-width: 0; }

.dev-tools__move {
  select { min-width: 0; max-width: 240px; }
}

.dev-tools__move-note { flex-basis: 100%; font-size: 12px; }

.dev-tools__master-error { margin: 8px 0 0; color: var(--error); }

.dev-tools__held {
  margin:        8px 0 0;
  padding:       6px 10px;
  border-left:   3px solid var(--warning);
  border-radius: var(--dev-r-ctl);
  background:    var(--warning-banner-bg);
  color:         var(--body-text);
}

.dev-tools__master-actions {
  display:     flex;
  flex-wrap:   wrap;
  gap:         8px;
  align-items: center;
  margin-top:  10px;

  select { max-width: 100%; }
}

.dev-tools__master-back {
  display:     inline-flex;
  flex-wrap:   wrap;
  gap:         6px;
  align-items: center;
  min-width:   0;

  select { min-width: 0; max-width: 360px; }
}

.dev-tools__checked { font-size: 12px; }

.dev-tools__master-remove { margin-left: auto; }

.dev-tools__row-actions {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
}
</style>
