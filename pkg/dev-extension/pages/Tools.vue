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

export default {
  name: 'DevTools',

  components: { Banner, RcButton },

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
          openapi:     defs[kind]?.openapi || '',
          instances,
        };
      });
    },
  },

  mounted() {
    this.refresh();
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

      try {
        this.running = await this.sources.allTools();
      } catch (e) {
        this.error = e.message || String(e);
      } finally {
        this.loading = false;
      }
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
  <div class="dev-tools">
    <h1>
      Tools
      <span class="dev-tools__lede">What can be attached to a piece of work, and what is attached now.</span>
      <RcButton
        variant="link"
        size="small"
        :disabled="loading"
        @click="refresh"
      >
        Refresh
      </RcButton>
    </h1>

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

        <span class="dev-tools__count">
          {{ tool.instances.length }} running
        </span>

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

      <p
        v-if="!tool.instances.length"
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
  </div>
</template>

<style lang="scss" scoped>
.dev-tools {
  padding: 0 0 24px;

  h1 {
    display: flex;
    align-items: baseline;
    gap: 12px;
    flex-wrap: wrap;
  }
}

.dev-tools__lede { color: var(--muted); font-size: 14px; font-weight: normal; }

.dev-tools__loading {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 24px 0;
  color: var(--muted);
}

.dev-tools__tool {
  margin: 0 0 16px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--box-bg);
}

.dev-tools__head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.dev-tools__tenancy {
  padding: 0 8px;
  border-radius: 10px;
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
  border-radius: 4px;
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

.dev-tools__row-actions {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
}
</style>
