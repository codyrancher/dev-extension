<script>
// The optional containers a workspace can run beside itself.
//
// A sidecar is what a workspace already is, one level down: a Deployment in the workspace's own
// namespace, a Service when it serves something, started and stopped by scaling, and reached
// through the same service proxy. So nothing new is invented here. The card is Rancher's Card,
// the badge is the same state badge the tables use, and Launch and Share are the same two
// things the Ports tab does.
//
// They are declared by the template (see templates.ts) and default to stopped, because a
// workspace should be cheap to make: the Deployment is created the first time someone presses
// Start. Groups come from the declarations, so a template with one group renders one group.
import { Card } from '@components/Card';
import { Banner } from '@components/Banner';
import { BadgeState } from '@components/BadgeState';
import { RcButton } from '@components/RcButton';
import AsyncButton from '@shell/components/AsyncButton';
import { colorForState, stateDisplay } from '@shell/plugins/dashboard-store/resource-class';
import LabeledSelect from '@shell/components/form/LabeledSelect';
import { Checkbox } from '@components/Form/Checkbox';
import { LabeledInput } from '@components/Form/LabeledInput';
import {
  listSidecars, startSidecar, stopSidecar, restartSidecar, sidecarProxyUrl, sidecarServiceUrl,
  templateSecretKey, workspaceAuth, setWorkspaceAuth, sidecarNodePort, nodeAddress,
  sidecarParams, setSidecarParams, sidecarLog
} from '../api';
import { templateById } from '../templates';

const REFRESH_MS = 5000;

/**
 * How often an open log window asks again.
 *
 * Faster than the card poll, because a log is what someone opens when they are watching
 * something happen, and slower than a stream, because this is a fetch of the last five hundred
 * lines rather than a follow.
 */
const LOG_REFRESH_MS = 3000;

export default {
  name: 'WorkspaceSidecars',

  components: {
    Card, Banner, BadgeState, RcButton, AsyncButton, LabeledSelect, Checkbox, LabeledInput
  },

  props: {
    workspace: {
      type:     Object,
      required: true,
    },
  },

  async fetch() {
    await this.refresh();
  },

  data() {
    return {
      states:       {},
      // What the workspace has asked its own Rancher to use, and what the manager made of it.
      auth:         {
        wanted: '', applied: '', message: '', at: ''
      },
      // The mode each auth card is offering, which is the applied one where there is one so that
      // the control opens on what is true rather than on the first entry in the list.
      chosen:       {},
      // The node port the cluster assigned a sidecar that asked for one, by id.
      nodePorts:    {},
      // The node's own address, which is where those ports answer. One fetch, on refresh.
      node:         '',
      error:        '',
      // The sidecar whose Configure dialog is open, and the values being edited in it. The
      // values are a copy: closing without saving has to leave the saved ones alone.
      configuring:  null,
      values:       {},
      saved:        {},
      // The auth provider the open dialog is offering, which is Rancher's card's and no other's.
      provider:     '',
      // The sidecar whose log is open, and what it said when it was asked.
      logging:      null,
      // The log as rows rather than as text: each line carries the time the container wrote it.
      logLines:     [],
      logNote:      '',
      logTimer:     null,
      copied:       '',
      copyTimer:    null,
      refreshTimer: null,
    };
  },

  computed: {
    template() {
      return templateById(this.workspace.template);
    },

    sidecars() {
      return this.template?.sidecars || [];
    },

    /** The declarations, grouped as they were declared. */
    groups() {
      const groups = new Map();

      for (const sidecar of this.sidecars) {
        groups.set(sidecar.group, [...(groups.get(sidecar.group) || []), sidecar]);
      }

      return [...groups.entries()].map(([name, items]) => ({ name, items }));
    },

    /**
     * Every provider any of this workspace's sidecars can back, and no provider at all.
     *
     * Gathered from the declarations rather than listed, which is what makes a new auth sidecar a
     * data change. It is offered on the Rancher card because Rancher is what the choice is about:
     * the closet's dashboard puts the same list in the same place, for the same reason.
     */
    authModes() {
      return [
        { value: '', label: 'Local users only' },
        ...this.sidecars.flatMap((sidecar) => sidecar.auth || []),
      ];
    },

    /** The sidecar that owns this workspace's Rancher, which is the one that applies an auth choice. */
    rancherSidecar() {
      return this.sidecars.find((sidecar) => sidecar.providesApi) || null;
    },
  },

  mounted() {
    this.refreshTimer = setInterval(() => this.refresh(), REFRESH_MS);
  },

  beforeUnmount() {
    clearInterval(this.refreshTimer);
    clearInterval(this.logTimer);
    clearTimeout(this.copyTimer);
  },

  methods: {
    async refresh() {
      try {
        const [states, auth] = await Promise.all([
          listSidecars(this.workspace.name, this.sidecars, this.template),
          workspaceAuth(this.workspace.name),
        ]);

        this.states = states;
        this.auth = auth;
        this.node = await nodeAddress();

        // Only for the sidecars that asked for one, and only while they are running: an assigned
        // node port is the cluster's answer rather than anything declared here.
        for (const sidecar of this.sidecars.filter((candidate) => candidate.nodePort)) {
          this.nodePorts = { ...this.nodePorts, [sidecar.id]: await sidecarNodePort(this.workspace.name, sidecar) };
        }

        for (const sidecar of this.sidecars.filter((candidate) => candidate.auth)) {
          if (!this.chosen[sidecar.id]) {
            const mine = sidecar.auth.find((mode) => mode.value === auth.wanted);

            this.chosen = { ...this.chosen, [sidecar.id]: (mine || sidecar.auth[0]).value };
          }
        }
      } catch (e) {
        this.error = e.message || String(e);
      }
    },

    /**
     * Whether this card can offer to point Rancher at itself.
     *
     * Both sides have to be up, and it is the manager that carries it out, so a request made while
     * either is down would sit unapplied with nothing to say why.
     */
    canApplyAuth(sidecar) {
      return this.stateOf(sidecar) === 'running' && !!this.rancherSidecar &&
        this.stateOf(this.rancherSidecar) === 'running';
    },

    /** The mode of this card's that Rancher is actually using, if any. */
    appliedMode(sidecar) {
      return (sidecar.auth || []).find((mode) => mode.value === this.auth.applied) || null;
    },

    /** Asked for, not yet reported back by the manager. */
    pendingAuth(sidecar) {
      return (sidecar.auth || []).some((mode) => mode.value === this.auth.wanted) &&
        this.auth.applied !== this.auth.wanted;
    },

    async applyAuth(sidecar, done) {
      this.error = '';

      try {
        await setWorkspaceAuth(this.workspace.name, this.chosen[sidecar.id]);
        await this.refresh();
        done(true);
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },

    /** Back to local users only, which is also how the other provider gets disabled. */
    async clearAuth(done) {
      this.error = '';

      try {
        await setWorkspaceAuth(this.workspace.name, '');
        await this.refresh();
        done(true);
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },

    stateOf(sidecar) {
      return this.states[sidecar.id]?.state || 'stopped';
    },

    badgeColor(sidecar) {
      return colorForState(this.stateOf(sidecar)).replace('text-', 'bg-');
    },

    badgeLabel(sidecar) {
      return stateDisplay(this.stateOf(sidecar));
    },

    /** Keys this sidecar declared that are not in the secret store yet. */
    missing(sidecar) {
      return this.states[sidecar.id]?.missing || [];
    },

    /**
     * The declarations behind those keys, so the card can tell the two cases apart: a key the
     * sidecar cannot work without stops it being started, and one it merely prefers does not.
     */
    missingRequired(sidecar) {
      return this.missing(sidecar)
        .filter((key) => (this.template?.secrets || []).find((secret) => secret.key === key)?.required !== false);
    },

    /**
     * Why this sidecar cannot start, or '' when it can.
     *
     * Only the keys it cannot work without. An optional key that is unset used to be reported
     * here too, on the argument that a person should know a value is not in use; what that
     * actually produced was three lines of warning on the Rancher card about cloud credentials
     * nobody had asked it to use. A sidecar works without an optional key by definition, and
     * Settings is where which keys are set is a question worth answering.
     */
    missingLabel(sidecar) {
      const keys = this.missingRequired(sidecar)
        .map((key) => templateSecretKey(this.workspace.template, key));

      if (!keys.length) {
        return '';
      }

      return `Cannot start: ${ keys.join(', ') } ${ keys.length > 1 ? 'are' : 'is' } not set. Set ${ keys.length > 1 ? 'them' : 'it' } in Settings, then start this.`;
    },

    /** What the cluster says about a sidecar that is not running, when it says anything. */
    detail(sidecar) {
      return this.states[sidecar.id]?.detail || '';
    },

    /** The last line it printed, while it is still coming up. */
    log(sidecar) {
      return this.states[sidecar.id]?.log || '';
    },

    /** Where one pod reaches another, which is what a sidecar that serves no UI is for. */
    address(sidecar) {
      return sidecar.port ? sidecarServiceUrl(this.workspace.name, sidecar) : '';
    },

    /**
     * Where to send a browser for this sidecar.
     *
     * A node port when the declaration asks for one, and that is not a preference: Keycloak
     * rewrites itself out of a path prefix, so the service proxy can only ever serve it a 404,
     * which is why it has a node port in the first place. The host is the node's own, for the
     * reason nodeAddress gives: a published port is one that has to work from off the cluster,
     * and this page's own hostname is a name that resolves on Rancher's network and nowhere else.
     */
    url(sidecar) {
      if (!sidecar.port) {
        return '';
      }

      const published = this.nodePorts[sidecar.id];

      if (published && this.node) {
        return `${ sidecar.scheme || 'http' }://${ this.node }:${ published }/`;
      }

      return sidecarProxyUrl(this.workspace.name, sidecar);
    },

    /** How a conversation in this workspace adds an MCP sidecar, once it is running. */
    mcpCommand(sidecar) {
      if (!sidecar.mcpPath || this.stateOf(sidecar) !== 'running') {
        return '';
      }

      return `claude mcp add --transport http ${ sidecar.id } ${ this.address(sidecar) }:${ sidecar.port }${ sidecar.mcpPath }`;
    },

    /**
     * Whether this card has a gear at all.
     *
     * Params, or an auth provider it can back. The closet's own card asks exactly this question,
     * and for the same reason: a gear that opens an empty dialog is worse than no gear.
     */
    hasConfig(sidecar) {
      return !!(sidecar.params || []).length || !!sidecar.providesApi;
    },

    async openConfig(sidecar) {
      this.error = '';

      try {
        const values = await sidecarParams(this.workspace.name, sidecar);

        // Two copies: one being edited and one to compare it against, so Save can say whether
        // there is anything to save rather than restarting a sidecar over an opened dialog.
        this.values = { ...values };
        this.saved = { ...values };
        this.provider = this.auth.wanted || '';
        this.configuring = sidecar;
      } catch (e) {
        this.error = e.message || String(e);
      }
    },

    closeConfig() {
      this.configuring = null;
    },

    /**
     * Save, and apply.
     *
     * Applying is a restart, because a container reads its environment once. A sidecar that is
     * not running is started instead, which is the same write and the same result: what it comes
     * up with is what was just saved.
     */
    async saveConfig(done) {
      this.error = '';

      const sidecar = this.configuring;

      try {
        await setSidecarParams(this.workspace.name, sidecar, this.values);

        // The auth choice is Rancher's card, so it is only ever saved from that dialog, and only
        // when it actually changed: setWorkspaceAuth writes a request the manager then acts on,
        // and rewriting the same request would have it applied again for nothing.
        if (sidecar.providesApi && this.provider !== this.auth.wanted) {
          await setWorkspaceAuth(this.workspace.name, this.provider);
        }

        if (this.stateOf(sidecar) === 'stopped') {
          await startSidecar(this.workspace.name, sidecar, this.template);
        } else {
          await restartSidecar(this.workspace.name, sidecar, this.template);
        }

        this.configuring = null;
        await this.refresh();
        done(true);
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },

    /**
     * Open the log, and keep it open on the current one.
     *
     * There is no Refresh button on either the log or the list, deliberately: both are already
     * polling, and a button beside something that updates itself is a button that only ever
     * confirms what is already on screen. The log's poll stops when the window closes, so a
     * dialog nobody has open costs nothing.
     */
    openLog(sidecar) {
      this.logging = sidecar;
      this.logLines = [];
      this.logNote = '';
      clearInterval(this.logTimer);
      this.logTimer = setInterval(() => this.readLog(sidecar), LOG_REFRESH_MS);

      return this.readLog(sidecar);
    },

    async readLog(sidecar) {
      try {
        const log = await sidecarLog(this.workspace.name, sidecar);

        this.logNote = log ? '' : 'This sidecar has no pod yet, so it has not said anything.';

        // Newest first. A container's log is written oldest-first and read the other way round:
        // what someone opens this for is the last thing it said, and scrolling to the bottom of
        // five hundred lines to find it is the whole of the friction this removes.
        this.logLines = (log ? log.replace(/\n$/, '').split('\n') : [])
          .reverse()
          .map((line, index) => {
            // The apiserver writes `2026-08-14T19:48:15.123456789Z the line`. The date is the
            // same for everything on screen, so only the time is kept; a line with no timestamp
            // in front of it is passed through as it is rather than being carved up.
            const match = /^(\d{4}-\d\d-\d\dT)(\d\d:\d\d:\d\d)\.\d+Z (.*)$/.exec(line);

            return { key: index, at: match ? match[2] : '', text: match ? match[3] : line };
          });
      } catch (e) {
        this.logLines = [];
        this.logNote = e.message || String(e);
      }
    },

    closeLog() {
      clearInterval(this.logTimer);
      this.logTimer = null;
      this.logging = null;
    },

    async start(sidecar, done) {
      this.error = '';

      try {
        await startSidecar(this.workspace.name, sidecar, this.template);
        await this.refresh();
        done(true);
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },

    async stop(sidecar, done) {
      this.error = '';

      try {
        await stopSidecar(this.workspace.name, sidecar.id, this.template);
        await this.refresh();
        done(true);
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },

    /** A rollout, not a stop and a start. See restartSidecar for why that distinction matters. */
    async restart(sidecar, done) {
      this.error = '';

      try {
        await restartSidecar(this.workspace.name, sidecar, this.template);
        await this.refresh();
        done(true);
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },

    async share(sidecar) {
      try {
        await navigator.clipboard.writeText(`${ window.location.origin }${ this.url(sidecar) }`);
        this.copied = sidecar.id;
        clearTimeout(this.copyTimer);
        this.copyTimer = setTimeout(() => {
          this.copied = '';
        }, 4000);
      } catch {
        this.error = 'The browser would not let this page write to the clipboard.';
      }
    },
  },
};
</script>

<template>
  <div class="workspace-sidecars">
    <!--
      No heading and no count. The tab strip already says Sidecars, and every card already carries
      its own state badge, so a line saying how many of them are running was arithmetic over what
      is on screen underneath it.
    -->

    <Banner
      v-if="error"
      color="error"
      :label="error"
    />

    <Banner
      v-if="!sidecars.length"
      color="info"
      label="This workspace's template declares no sidecars."
    />

    <section
      v-for="group in groups"
      :key="group.name"
      class="workspace-sidecars__group"
    >
      <h4>{{ group.name }}</h4>
      <div class="workspace-sidecars__cards">
        <Card
          v-for="sidecar in group.items"
          :key="sidecar.id"
          class="workspace-sidecars__card"
          :show-highlight-border="false"
          :show-actions="false"
        >
          <template #title>
            <div class="workspace-sidecars__title">
              <h5>{{ sidecar.label }}</h5>
              <BadgeState
                :color="badgeColor(sidecar)"
                :label="badgeLabel(sidecar)"
              />
              <!--
                The two icons the closet's card has, in the same corner: what it is doing, and
                what it is set to. Both are quiet, because a card is mostly read rather than
                operated, and both are only there when they have something behind them.
              -->
              <button
                v-if="stateOf(sidecar) !== 'stopped'"
                v-clean-tooltip="'Logs'"
                type="button"
                class="workspace-sidecars__icon"
                :aria-label="`Logs for ${ sidecar.label }`"
                @click="openLog(sidecar)"
              >
                <i class="icon icon-file" />
              </button>
              <button
                v-if="hasConfig(sidecar)"
                v-clean-tooltip="'Configure'"
                type="button"
                class="workspace-sidecars__icon"
                :aria-label="`Configure ${ sidecar.label }`"
                @click="openConfig(sidecar)"
              >
                <i class="icon icon-gear" />
              </button>
            </div>
          </template>

          <template #body>
            <p>{{ sidecar.description }}</p>
            <p class="workspace-sidecars__image">
              {{ sidecar.image }}
            </p>
            <p
              v-if="missingLabel(sidecar)"
              class="workspace-sidecars__missing"
            >
              {{ missingLabel(sidecar) }}
            </p>
            <!--
              The cluster's own sentence, which is the difference between a card that says
              Starting for four minutes and one that says the image cannot be pulled.
            -->
            <p
              v-if="detail(sidecar) && stateOf(sidecar) !== 'running'"
              class="workspace-sidecars__detail"
            >
              {{ detail(sidecar) }}
            </p>

            <!--
              While it is coming up, the last thing it said. A sidecar that installs two helm
              charts is Starting for about ten minutes, and this is the difference between that
              and something being wrong.
            -->
            <p
              v-if="log(sidecar)"
              class="workspace-sidecars__log"
            >
              {{ log(sidecar) }}
            </p>

            <!--
              What the workspace itself talks to, for a sidecar whose whole point is being reached
              from inside the cluster rather than opened in a tab.
            -->
            <p
              v-if="address(sidecar) && sidecar.providesApi"
              class="workspace-sidecars__image"
            >
              {{ address(sidecar) }}
              <span v-if="stateOf(sidecar) === 'running'">is what this workspace's dashboard is pointed at.</span>
              <span v-else>is what this workspace's dashboard will be pointed at while this runs.</span>
            </p>

            <!--
              An MCP server has nothing to open, so what its card offers is the line that adds it
              to a conversation in this workspace. In-cluster address, because the thing that will
              use it is the workspace's own container.
            -->
            <p
              v-if="mcpCommand(sidecar)"
              class="workspace-sidecars__image"
            >
              {{ mcpCommand(sidecar) }}
            </p>

            <!--
              What Rancher is using now, when this card is what it is using. The choosing has
              moved behind the gear, where the rest of a sidecar's configuration is; this is the
              one line about it that is worth having on the card itself.
            -->
            <p
              v-if="sidecar.auth"
              class="workspace-sidecars__detail"
            >
              <template v-if="appliedMode(sidecar)">Rancher auth: {{ appliedMode(sidecar).label }}. {{ auth.message }}</template>
              <template v-else-if="pendingAuth(sidecar)">Rancher auth: asked for, waiting for the Rancher sidecar to apply it.</template>
              <template v-else>Not in use - turn it on with the auth provider setting on the Rancher card.</template>
            </p>

            <div class="workspace-sidecars__links">
              <!--
                Only where the service proxy can actually serve the thing. Rancher and Keycloak
                both rewrite themselves out of a path prefix, and a Launch that opens a page which
                redirects itself to a 404 is worse than no Launch.
              -->
              <RcButton
                v-if="sidecar.port && sidecar.launchable !== false && stateOf(sidecar) === 'running'"
                variant="link"
                size="small"
                left-icon="external-link"
                :href="url(sidecar)"
                target="_blank"
                rel="noopener noreferrer"
              >
                Launch
              </RcButton>
              <RcButton
                v-if="sidecar.port && sidecar.launchable !== false && stateOf(sidecar) === 'running'"
                variant="link"
                size="small"
                left-icon="copy"
                @click="share(sidecar)"
              >
                {{ copied === sidecar.id ? 'Copied' : 'Share' }}
              </RcButton>
            </div>

            <div class="workspace-sidecars__actions">
              <!--
                Disabled rather than allowed to fail. A sidecar started without a key it needs
                comes up, answers nothing and looks healthy, so the card says it cannot work and
                then does not let you do it anyway.
              -->
              <AsyncButton
                v-if="stateOf(sidecar) === 'stopped'"
                mode="apply"
                action-label="Start"
                waiting-label="Starting"
                success-label="Started"
                :disabled="missingRequired(sidecar).length > 0"
                @click="(done) => start(sidecar, done)"
              />
              <template v-else>
                <AsyncButton
                  mode="apply"
                  action-label="Stop"
                  waiting-label="Stopping"
                  success-label="Stopped"
                  @click="(done) => stop(sidecar, done)"
                />
                <AsyncButton
                  mode="apply"
                  action-label="Restart"
                  waiting-label="Restarting"
                  success-label="Restarted"
                  @click="(done) => restart(sidecar, done)"
                />
              </template>
            </div>
          </template>
        </Card>
      </div>
    </section>

    <!--
      Configure: the sidecar's own settings, and for the one that backs an auth provider, which
      provider Rancher should use. One dialog and one button, as the closet has it, because the
      two are applied by the same restart and asking twice would be asking about the same pod.
    -->
    <div
      v-if="configuring"
      class="workspace-sidecars__modal"
      @click.self="closeConfig"
    >
      <div class="workspace-sidecars__dialog">
        <header>
          <h3>Configure {{ configuring.label }}</h3>
          <RcButton
            variant="tertiary"
            size="small"
            left-icon="close"
            aria-label="Close"
            @click="closeConfig"
          />
        </header>

        <div class="workspace-sidecars__fields">
          <div
            v-for="param in (configuring.params || [])"
            :key="param.id"
            class="workspace-sidecars__field"
          >
            <Checkbox
              v-if="param.type === 'boolean'"
              :value="values[param.id] === 'true'"
              :label="param.label"
              @update:value="(on) => values = { ...values, [param.id]: on ? 'true' : '' }"
            />
            <LabeledInput
              v-else
              :value="values[param.id]"
              :label="param.label"
              @update:value="(value) => values = { ...values, [param.id]: value }"
            />
            <p class="workspace-sidecars__help">
              {{ param.description }}
            </p>
          </div>

          <!--
            The auth provider, for the card that can back one. It is stored rather than performed:
            what carries it out is the manager inside the workspace's Rancher. See setWorkspaceAuth.
          -->
          <div
            v-if="configuring.providesApi"
            class="workspace-sidecars__field"
          >
            <LabeledSelect
              :value="provider"
              :options="authModes"
              label="Auth provider"
              option-label="label"
              option-key="value"
              :reduce="(mode) => mode.value"
              :clearable="false"
              @update:value="(value) => provider = value"
            />
            <p class="workspace-sidecars__help">
              Rancher allows one provider at a time, so choosing one turns the others off. The
              sidecar behind the choice is started with it, and this Rancher restarts to pick it up.
            </p>
          </div>
        </div>

        <footer>
          <RcButton
            variant="secondary"
            @click="closeConfig"
          >
            Cancel
          </RcButton>
          <AsyncButton
            mode="apply"
            :action-label="stateOf(configuring) === 'stopped' ? 'Save and start' : 'Save and restart'"
            waiting-label="Applying"
            success-label="Applied"
            @click="saveConfig"
          />
        </footer>
      </div>
    </div>

    <!-- The container's own log, which is the answer to most of what a card cannot say. -->
    <div
      v-if="logging"
      class="workspace-sidecars__modal"
      @click.self="closeLog"
    >
      <div class="workspace-sidecars__dialog workspace-sidecars__dialog--wide">
        <header>
          <h3>{{ logging.label }} log</h3>
          <RcButton
            variant="tertiary"
            size="small"
            left-icon="close"
            aria-label="Close"
            @click="closeLog"
          />
        </header>
        <!-- Newest first, each line with the time the container wrote it. See readLog. -->
        <div class="workspace-sidecars__log-body">
          <p
            v-if="logNote"
            class="workspace-sidecars__log-note"
          >
            {{ logNote }}
          </p>
          <div
            v-for="line in logLines"
            :key="line.key"
            class="workspace-sidecars__log-line"
          >
            <span class="workspace-sidecars__log-at">{{ line.at }}</span>
            <span class="workspace-sidecars__log-text">{{ line.text }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
  .workspace-sidecars {
    overflow-y: auto;
    padding:    var(--dev-space-5);
    // Nothing here is meant to be scrolled sideways: the cards wrap, and the one thing wider
    // than the pane is a dialog that covers it anyway.
    overflow-x: hidden;

    &__group {
      margin-top: var(--dev-space-5);

      &:first-of-type {
        margin-top: 0;
      }

      h4 {
        margin:         0 0 var(--dev-space-3) 0;
        color:          var(--muted);
        font-size:      12px;
        letter-spacing: 0.05em;
        text-transform: uppercase;
      }
    }

    // Two to a row, as the harness has them, and one on a narrow window.
    //
    // auto-fill rather than auto-fit, which is the difference between a group of one and a group
    // of two having cards of the same width: auto-fit collapses the tracks nothing is in, so a
    // group with a single card stretched it across the whole row while its neighbours were half
    // that. auto-fill keeps the empty track, so every card in every group is one column wide.
    &__cards {
      display:               grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap:                   var(--dev-space-4);
      max-width:             1000px;
    }

    &__title {
      display:     flex;
      align-items: center;
      gap:         var(--dev-space-4);

      h5 {
        margin: 0;
      }
    }

    &__image {
      color:       var(--muted);
      font-family: monospace;
      font-size:   12px;
    }

    &__missing {
      color: var(--warning);
    }

    &__detail {
      color:     var(--muted);
      font-size: 12px;
    }

    // One line, whatever it says: a helm install prints lines of any length and the card is a
    // card. What matters is that it is moving and what it is doing, not the whole line.
    &__log {
      overflow:      hidden;
      color:         var(--muted);
      font-family:   monospace;
      font-size:     11px;
      text-overflow: ellipsis;
      white-space:   nowrap;
    }

    &__auth {
      margin-top:  var(--dev-space-4);
      padding-top: var(--dev-space-4);
      border-top:  1px solid var(--border);
    }

    &__auth-row {
      display:     flex;
      align-items: center;
      gap:         var(--dev-space-4);
    }

    &__auth-label {
      color:     var(--muted);
      font-size: 12px;
    }

    // Wide enough for the longest provider name and no wider: the row it sits in is a card's.
    &__auth-select {
      width: 140px;
    }

    &__auth-state {
      margin-top: var(--dev-space-3);
      color:      var(--muted);
      font-size:  12px;
    }

    &__links {
      display: flex;
      gap:     var(--dev-space-4);
    }

    &__actions {
      display:   flex;
      gap:       var(--dev-space-4);
      margin-top: var(--dev-space-4);
    }

    // The card's own corner controls: quiet, and the same box as each other.
    &__icon {
      display:         flex;
      align-items:     center;
      justify-content: center;
      width:           22px;
      height:          22px;
      min-height:      22px;
      padding:         0;
      border:          none;
      border-radius:   var(--border-radius);
      background:      transparent;
      color:           var(--muted);
      cursor:          pointer;

      &:hover {
        background: var(--nav-hover, var(--accent-btn));
        color:      var(--body-text);
      }

      .icon {
        font-size: 14px;
      }
    }

    // The second icon sits at the card's right edge, and the first beside it, so the two are a
    // pair in the corner rather than two things after the badge.
    &__title &__icon:first-of-type {
      margin-left: auto;
    }

    // A dialog of this component's own rather than the shell's modal, which is driven through
    // Vuex and expects a registered component. This is a panel over the tab, and the click on the
    // backdrop closes it, which is the whole of the behaviour.
    &__modal {
      position:        fixed;
      inset:           0;
      z-index:         100;
      display:         flex;
      align-items:     center;
      justify-content: center;
      background:      rgba(0, 0, 0, 0.5);
    }

    &__dialog {
      display:        flex;
      flex-direction: column;
      width:          560px;
      max-width:      90vw;
      max-height:     80vh;
      border:         1px solid var(--border);
      border-radius:  var(--border-radius);
      background:     var(--body-bg);

      &--wide {
        width: 900px;
      }

      header {
        display:       flex;
        align-items:   center;
        gap:           var(--dev-space-4);
        padding:       var(--dev-space-4) var(--dev-space-5);
        border-bottom: 1px solid var(--border);

        h3 {
          flex:   1 1 auto;
          margin: 0;
        }
      }

      footer {
        display:         flex;
        justify-content: flex-end;
        gap:             var(--dev-space-4);
        padding:         var(--dev-space-4) var(--dev-space-5);
        border-top:      1px solid var(--border);
      }
    }

    &__fields {
      overflow-y: auto;
      padding:    var(--dev-space-5);
    }

    &__field {
      margin-bottom: var(--dev-space-5);

      &:last-child {
        margin-bottom: 0;
      }
    }

    // The sentence under a field, which is the declaration's own description.
    &__help {
      max-width: 70ch;
      margin:    var(--dev-space-3) 0 0 0;
      color:     var(--muted);
      font-size: 12px;
    }

    &__log-body {
      overflow:    auto;
      flex:        1 1 auto;
      margin:      0;
      padding:     var(--dev-space-4) var(--dev-space-5);
      background:  var(--body-bg);
      color:       var(--body-text);
      font-family: monospace;
      font-size:   12px;
    }

    // Time and text as two columns, so the times line up down the left and a wrapped line stays
    // under its own text rather than under the clock.
    &__log-line {
      display: flex;
      gap:     var(--dev-space-4);
    }

    &__log-at {
      flex:  0 0 auto;
      color: var(--muted);
    }

    &__log-text {
      flex:        1 1 auto;
      min-width:   0;
      white-space: pre-wrap;
      word-break:  break-all;
    }

    &__log-note {
      margin: 0;
      color:  var(--muted);
    }
  }
</style>
