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
  readRancherMaster, installRancherMaster, removeRancherMaster, controlRancherMaster, masterCommitUrl, RANCHER_MASTER_OPENAPI
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
    };
  },

  computed: {
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
          this.ranchers = (await listRanchers(this.$store).catch(() => []))
            .filter((r) => r.kind === 'instance' && r.phase === 'ready' && r.clusterId && r.nodeIp);
          this.pick = this.pick || this.ranchers[0]?.name || '';
        }
      } catch (e) {
        this.masterError = e.message || String(e);
      }
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
          v-else
          class="dev-tools__count"
        >{{ master && master.installed ? (master.status ? (master.status.pin ? `held on ${ master.status.pin }` : (master.status.paused ? 'updates paused' : 'following master')) : 'starting') : 'not installed' }}</span>

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

      <Banner
        v-if="!tool.multitenant"
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
          <div class="dev-tools__master-line">
            <a
              :href="master.url"
              target="_blank"
              rel="noopener noreferrer"
            >{{ master.url }}</a>
            <span class="text-muted">in front of</span>
            <a
              v-if="master.rancherUrl"
              :href="master.rancherUrl"
              target="_blank"
              rel="noopener noreferrer"
            >{{ master.rancher }}</a>
            <span v-else>{{ master.rancher }}</span>
          </div>

          <p
            v-if="!master.status"
            class="text-muted dev-tools__none"
          >{{ master.detail }}</p>

          <template v-else>
            <dl class="dev-tools__master-facts">
              <dt>Serving</dt>
              <dd>
                <template v-if="master.status.current">
                  <a
                    :href="masterCommitUrl(master.status.current)"
                    target="_blank"
                    rel="noopener noreferrer"
                  ><code>{{ master.status.current }}</code></a>
                  <span>{{ ((master.status.builds || []).find((b) => b.sha === master.status.current) || {}).message || '' }}</span>
                </template>
                <span
                  v-else
                  class="text-muted"
                >nothing yet: the first build is being fetched</span>
              </dd>
              <dt>master</dt>
              <dd>
                <a
                  v-if="master.status.head"
                  :href="masterCommitUrl(master.status.head)"
                  target="_blank"
                  rel="noopener noreferrer"
                ><code>{{ master.status.head.slice(0, 7) }}</code></a>
                <span
                  v-if="master.status.head && master.status.current && !master.status.head.startsWith(master.status.current)"
                  class="text-muted"
                >{{ master.status.paused || master.status.pin ? 'newer than what is served' : 'its build lands about 15 minutes after the push' }}</span>
                <span
                  v-else-if="master.status.head"
                  class="text-muted"
                >served</span>
              </dd>
              <dt>Checked</dt>
              <dd class="text-muted">
                {{ master.status.checked ? ago(master.status.checked) : '' }} · {{ (master.status.builds || []).length }} builds kept
              </dd>
            </dl>

            <p
              v-if="master.status.error"
              class="dev-tools__master-error"
            >{{ master.status.error }}</p>

            <div class="dev-tools__master-actions">
              <RcButton
                v-if="!master.status.paused"
                size="small"
                variant="secondary"
                :disabled="!!busy"
                @click="pauseMaster"
              >
                Pause updates
              </RcButton>
              <RcButton
                v-if="master.status.paused || master.status.pin"
                size="small"
                variant="secondary"
                :disabled="!!busy"
                @click="followMaster"
              >
                {{ master.status.pin ? 'Follow master again' : 'Resume updates' }}
              </RcButton>

              <span class="dev-tools__master-back">
                <label for="dev-tools-master-back">Go back to</label>
                <select
                  id="dev-tools-master-back"
                  v-model="back"
                  :disabled="!!busy || (master.status.builds || []).length < 2"
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
            <p class="text-muted dev-tools__none">
              Only builds this tool has fetched can be gone back to: master's build is published at one address and replaced by each push, so the history starts when it was installed.
            </p>
          </template>
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
.dev-tools__tenancy--shared { background: var(--warning-banner-bg); color: var(--warning); }

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

.dev-tools__master { margin-top: 8px; font-size: 12px; }

.dev-tools__master-line { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; }

.dev-tools__master-facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 12px;
  margin: 8px 0 0;

  dt { color: var(--muted); }
  dd { margin: 0; display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; }
}

.dev-tools__master-error { margin: 6px 0 0; color: var(--error); }

.dev-tools__master-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin-top: 10px;

  select { max-width: 100%; }
}

.dev-tools__master-back {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;

  label { margin: 0; color: var(--muted); }
  select { min-width: 0; max-width: 460px; }
}

.dev-tools__master-remove { margin-left: auto; }

.dev-tools__row-actions {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
}
</style>
