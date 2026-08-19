<script>
// The ports a workspace is listening on, and whether each one is forwarded.
//
// The list is the pod's, not the Service's. Everything the workspace has bound is read out of
// /proc/net/tcp (see workspaceListening), so a server somebody started in a conversation shows up
// here without anyone declaring it, which is the thing this tab exists to do. A port the Service
// carries that nothing is listening on is still shown, because that is a port somebody asked for
// and the honest answer is that nothing has bound it yet.
//
// Forwarding is the one action, and there is no add form: a port exists because something is
// serving on it, not because somebody typed its number. A forwarded port is on the workspace's
// Service with a node port, which is what makes it reachable from outside the cluster, and
// unforwarding takes it off again. The published port is suggested rather than asked for -
// derived from the local one, checked against what the cluster has already given out, and
// overridable in the row for anyone who needs a stable address. Forwarded rows sort to the top,
// because they are the ones with an address.
//
// Share is the other half, and it is not the same thing: a forwarded port is open to anyone who
// can reach the node, and a shared one has an nginx with a username and a password in front of
// it. See share.ts.
import SortableTable from '@shell/components/SortableTable';
import AsyncButton from '@shell/components/AsyncButton';
import { Banner } from '@components/Banner';
import { RcButton } from '@components/RcButton';
import { LabeledInput } from '@components/Form/LabeledInput';
import {
  listWorkspacePorts, addWorkspacePort, removeWorkspacePort, workspaceProxyUrl,
  workspaceService, nodeAddress, workspaceScheme, workspaceListening,
  listWorkspaceShares, setWorkspaceShares, shareNodePorts, usedNodePorts, suggestNodePort,
  NODE_PORT_RANGE
} from '../api';
import { nextListen, generatedPassword } from '../share';
import { templateById } from '../templates';

export default {
  name: 'WorkspacePorts',

  components: {
    SortableTable, AsyncButton, Banner, RcButton, LabeledInput
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
      // What the Service carries, what the pod is listening on, and what has been shared.
      ports:      [],
      listening:  [],
      shares:     [],
      // The workspace's Service as it is, which is where the node port comes from.
      service:    null,
      // The node's own address, which is what a forwarded port is reachable at. Resolved on
      // refresh rather than per row: it is one fetch and every row wants the same answer.
      node:       '',
      // The node ports the cluster has already given out, so a suggestion is one that will be
      // accepted rather than one the apiserver rejects a moment later.
      used:       [],
      // Local port -> what is in that row's published-port box. Only holds what somebody typed;
      // a row nobody has touched shows its suggestion.
      chosen:     {},
      // The node ports the cluster gave the share proxy, by the listener they belong to.
      sharePorts: {},
      // The port whose link was last copied, so the button can say it worked. There is no
      // other feedback for a clipboard write.
      copied:     0,
      // Local port -> what was last asked for on that row, which is the only thing the success
      // label can be built from. See forwardLabels.
      acting:     {},
      copyTimer:  null,
      error:      '',
      headers:    [
        // Not sortable, and that is the point: the order is forwarded first, which is the
        // component's and not a column's. A sortable header here would offer to undo the one
        // thing the order is for, and SortableTable sorts by the first sortable column when it
        // is given one, which is how the forwarded row ended up underneath.
        {
          name: 'port', label: 'Port', value: 'port', width: 130
        },
        {
          name: 'answering', label: 'Answering', value: 'port', width: 110
        },
        // The published port: the assigned one when it is forwarded, and an editable suggestion
        // when it is not. One column, because it is one fact in two states.
        {
          name: 'public', label: 'Public port', value: 'port', width: 150
        },
        { name: 'url', label: 'Address', value: 'port' },
        {
          name: 'actions', label: '', align: 'right', width: 300
        },
      ],
    };
  },

  computed: {
    /**
     * Every port worth a row, forwarded ones first.
     *
     * The two sources overlap and neither contains the other, so this is their union. Inside each
     * half the order is the port number, which is the only order a list of ports has.
     */
    rows() {
      const all = new Map();

      for (const entry of this.listening) {
        all.set(entry.port, {
          port: entry.port, loopback: entry.loopback, listening: true, nodePort: 0
        });
      }

      for (const entry of this.ports) {
        all.set(entry.port, {
          ...(all.get(entry.port) || { port: entry.port, loopback: false, listening: false }),
          nodePort: entry.nodePort || 0,
        });
      }

      return [...all.values()].sort((a, b) => (
        Number(!!b.nodePort) - Number(!!a.nodePort) || a.port - b.port
      ));
    },
  },

  beforeUnmount() {
    clearTimeout(this.copyTimer);
  },

  methods: {
    async refresh() {
      const [declared, service, node, listening, shares, sharePorts, used] = await Promise.all([
        listWorkspacePorts(this.workspace.name),
        workspaceService(this.workspace.name).catch(() => null),
        nodeAddress(),
        workspaceListening(this.workspace.name).catch(() => []),
        listWorkspaceShares(this.workspace.name).catch(() => []),
        shareNodePorts(this.workspace.name).catch(() => ({})),
        usedNodePorts().catch(() => []),
      ]);

      this.ports = declared;
      this.service = service;
      this.node = node;
      this.listening = listening;
      this.shares = shares;
      this.sharePorts = sharePorts;
      this.used = used;
    },

    /**
     * What one port speaks. The template's own port speaks whatever the template's server does;
     * anything else is http until there is a reason to ask which.
     */
    scheme(port) {
      const template = templateById(this.workspace.template);

      return port === template?.port ? workspaceScheme(template) : 'http';
    },

    forwarded(row) {
      return !!row.nodePort;
    },

    /**
     * What the forward button says, in its three states.
     *
     * The first two come from where the row is now, so the button always offers the next thing.
     * The third cannot: by the time a success label is drawn the row has been refreshed and the
     * state has flipped, so binding it to the same expression made a successful Forward announce
     * itself as "Unforwarded". It comes from what was asked for instead.
     */
    forwardLabels(row) {
      const asked = this.acting[row.port];

      return {
        action:  this.forwarded(row) ? 'Unforward' : 'Forward',
        waiting: this.forwarded(row) ? 'Unforwarding' : 'Forwarding',
        success: asked === 'unforward' ? 'Unforwarded' : 'Forwarded',
      };
    },

    /** What is in a row's published-port box: what was typed, or the suggestion. */
    publicPort(row) {
      return this.chosen[row.port] ?? String(suggestNodePort(row.port, this.used) || '');
    },

    /** Why that box's contents cannot be used, or '' when they can. */
    publicError(row) {
      const port = Number(this.publicPort(row));

      if (!port) {
        return 'A published port is needed.';
      }

      if (port < NODE_PORT_RANGE.first || port > NODE_PORT_RANGE.last) {
        return `Between ${ NODE_PORT_RANGE.first } and ${ NODE_PORT_RANGE.last }.`;
      }

      return this.used.includes(port) ? 'Already in use.' : '';
    },

    /**
     * Publish a port on the node, which is what makes it reachable from outside the cluster.
     *
     * The published port is what the row's box says. Nothing beyond that is checked here: two
     * people forwarding at once is what the apiserver's own conflict is for, and it says so
     * better than a guess made a moment earlier would.
     */
    async forward(row, done) {
      this.error = '';
      this.acting = { ...this.acting, [row.port]: 'forward' };

      try {
        await addWorkspacePort(this.workspace.name, row.port, Number(this.publicPort(row)) || undefined);
        await this.refresh();
        done(true);
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },

    /**
     * Take it off the Service again.
     *
     * A share on that port goes with it: what a share proxies to is a port on this Service, so
     * leaving the share behind would leave a link that answers 502 to whoever was sent it.
     */
    async unforward(row, done) {
      this.error = '';
      this.acting = { ...this.acting, [row.port]: 'unforward' };

      try {
        if (this.shareOf(row.port)) {
          await setWorkspaceShares(this.workspace.name, this.shares.filter((entry) => entry.port !== row.port));
        }

        await removeWorkspacePort(this.workspace.name, row.port);
        await this.refresh();
        done(true);
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },

    /**
     * Where this row answers.
     *
     * A forwarded port is the node's address, because that is what forwarding it was for and it
     * is the address somebody would be given. Anything else is the service proxy, on Rancher's
     * origin and behind a Rancher session, which is only an address at all for a port the Service
     * carries; a detected port that has not been forwarded has none, and the row says so.
     */
    url(row) {
      if (row.nodePort) {
        return this.node ? `${ this.scheme(row.port) }://${ this.node }:${ row.nodePort }/` : '';
      }

      if (!this.ports.some((entry) => entry.port === row.port)) {
        return '';
      }

      return workspaceProxyUrl(this.workspace.name, row.port, this.scheme(row.port));
    },

    /** The address as somebody else would have to type it, which is what goes on the clipboard. */
    absoluteUrl(row) {
      const url = this.url(row);

      return url.startsWith('http') ? url : `${ window.location.origin }${ url }`;
    },

    async copy(text, port) {
      this.error = '';

      try {
        await navigator.clipboard.writeText(text);
        this.copied = port;
        clearTimeout(this.copyTimer);
        this.copyTimer = setTimeout(() => {
          this.copied = 0;
        }, 4000);
      } catch {
        // Writing to the clipboard needs a secure context and a user gesture, and this has
        // both, but a browser can still refuse. Saying so beats a button that did nothing.
        this.error = 'The browser would not let this page write to the clipboard. The address is in the table, and can be copied by hand.';
      }
    },

    /** The share on a port, if it has one. */
    shareOf(port) {
      return this.shares.find((entry) => entry.port === port) || null;
    },

    /** Where a share answers: the node again, but the proxy's port rather than the workspace's. */
    shareUrl(port) {
      const share = this.shareOf(port);
      const published = share && this.sharePorts[share.listen];

      return published && this.node ? `http://${ this.node }:${ published }/` : '';
    },

    /**
     * Share a port, or stop sharing it.
     *
     * The credentials are made here and never asked for. A share is a link you hand to somebody
     * for an afternoon, so a password nobody chose is both safer and one fewer thing to decide;
     * the username is the port so that two shares are told apart in a password manager.
     *
     * Sharing ends with the address, the username and the password on the clipboard, which is
     * the only thing anybody was going to do with them. They were shown in a panel under the
     * table before, which is a thing to read and then copy by hand.
     */
    async setShared(port, shared, done) {
      this.error = '';

      try {
        const others = this.shares.filter((entry) => entry.port !== port);
        const share = {
          port,
          listen:   nextListen(others),
          scheme:   this.scheme(port),
          username: `port-${ port }`,
          password: generatedPassword(),
        };

        await setWorkspaceShares(this.workspace.name, shared ? [...others, share] : others);
        await this.refresh();

        if (shared) {
          await this.copy(await this.shareText(share), port);
        }

        done(true);
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },

    /**
     * The three lines that are the share, waiting for the address if it is not there yet.
     *
     * The node port is assigned by the cluster when the Service is written, and the write and the
     * assignment are not the same instant: copying a moment too early puts a link with no port in
     * it on somebody's clipboard, which they then paste to a colleague.
     */
    async shareText(share) {
      for (let attempt = 0; attempt < 10 && !this.shareUrl(share.port); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        this.sharePorts = await shareNodePorts(this.workspace.name).catch(() => this.sharePorts);
      }

      return [
        this.shareUrl(share.port) || 'the cluster has not published it yet',
        `username: ${ share.username }`,
        `password: ${ share.password }`,
      ].join('\n');
    },
  },
};
</script>

<template>
  <div class="workspace-ports">
    <Banner
      v-if="error"
      color="error"
      :label="error"
    />

    <!--
      No sorting from the table: the order is forwarded first, which is this component's and not
      a column's. A sortable header here would offer to undo the one thing the order is for.
    -->
    <SortableTable
      :headers="headers"
      :rows="rows"
      key-field="port"
      :table-actions="false"
      :row-actions="false"
      :search="false"
      :paging="false"
    >
      <template #cell:port="{ row }">
        <span class="workspace-ports__port">:{{ row.port }}</span>
        <span
          v-if="row.loopback"
          v-clean-tooltip="'Bound to 127.0.0.1 only. A Service routes to the pod\'s address, which this refuses, so forwarding it would not help.'"
          class="workspace-ports__loopback"
        >loopback</span>
      </template>

      <!--
        What the pod itself says, which is the whole of the question. This used to ask the service
        proxy whether the port answered, and the proxy can only reach a port the Service carries -
        so a port that was plainly listening but not forwarded was reported as answering nothing.
        /proc/net/tcp already knows, and it costs no request.
      -->
      <template #cell:answering="{ row }">
        <span :class="row.listening ? 'text-success' : 'text-muted'">
          {{ row.listening ? 'Yes' : 'Nothing yet' }}
        </span>
      </template>

      <!--
        Forwarded: the port it was given, which is not editable because changing it would move an
        address somebody may already have. Not forwarded: a suggestion, in a box, because the
        whole point of suggesting is that it can be overridden.
      -->
      <template #cell:public="{ row }">
        <span
          v-if="forwarded(row)"
          class="workspace-ports__port"
        >:{{ row.nodePort }}</span>
        <LabeledInput
          v-else
          class="workspace-ports__public"
          type="number"
          :value="publicPort(row)"
          :status="publicError(row) ? 'error' : null"
          @update:value="(value) => chosen = { ...chosen, [row.port]: value }"
        />
      </template>

      <template #cell:url="{ row }">
        <span class="workspace-ports__url">{{ url(row) || '&mdash;' }}</span>
        <span
          v-if="shareUrl(row.port)"
          class="workspace-ports__url workspace-ports__url--share"
        >{{ shareUrl(row.port) }}</span>
      </template>

      <template #cell:actions="{ row }">
        <div class="workspace-ports__actions">
          <RcButton
            v-if="url(row)"
            variant="tertiary"
            size="small"
            left-icon="external-link"
            :href="url(row)"
            target="_blank"
            rel="noopener noreferrer"
          >
            Open
          </RcButton>
          <RcButton
            v-if="url(row)"
            variant="tertiary"
            size="small"
            left-icon="copy"
            @click="copy(absoluteUrl(row), row.port)"
          >
            {{ copied === row.port ? 'Copied' : 'Copy' }}
          </RcButton>
          <!-- Only for a forwarded port: a share proxies to the Service, so there has to be one. -->
          <AsyncButton
            v-if="forwarded(row)"
            mode="apply"
            :action-label="shareOf(row.port) ? 'Unshare' : 'Share'"
            :waiting-label="shareOf(row.port) ? 'Unsharing' : 'Sharing'"
            :success-label="shareOf(row.port) ? 'Unshared' : 'Shared'"
            size="sm"
            @click="(done) => setShared(row.port, !shareOf(row.port), done)"
          />
          <AsyncButton
            mode="apply"
            :action-label="forwardLabels(row).action"
            :waiting-label="forwardLabels(row).waiting"
            :success-label="forwardLabels(row).success"
            size="sm"
            :disabled="!forwarded(row) && !!publicError(row)"
            @click="(done) => forwarded(row) ? unforward(row, done) : forward(row, done)"
          />
        </div>
      </template>

      <template #no-rows>
        <tr>
          <td :colspan="headers.length">
            <span class="text-muted">This workspace is not listening on anything yet.</span>
          </td>
        </tr>
      </template>
    </SortableTable>

  </div>
</template>

<style lang="scss" scoped>
  .workspace-ports {
    // The tab pane has no padding of its own: WorkspaceDetail takes it off so that the two tabs
    // whose content is one rectangle, the terminal and the browser frame, can fill it. A table is
    // not one of those, so it puts its own back, the same 20px the Sidecars tab uses.
    overflow-y: auto;
    padding:    var(--dev-space-5);

    &__port {
      font-family: monospace;
    }

    &__loopback {
      margin-left: var(--dev-space-3);
      color:       var(--warning);
      font-size:   11px;
    }

    // Narrow: it holds five digits and sits in a table row, so the shell's full-width input would
    // push the columns beside it off the page.
    &__public {
      width: 110px;
    }

    // The address is long and the table is inside a tab pane, so it is truncated rather than
    // allowed to push the page sideways. The whole of it is one click away on Copy, and on
    // Open, which are the two things anyone wants it for.
    &__url {
      display:       block;
      max-width:     320px;
      overflow:      hidden;
      color:         var(--muted);
      font-family:   monospace;
      font-size:     12px;
      white-space:   nowrap;
      text-overflow: ellipsis;
    }

    &__url--share {
      color: var(--success);
    }

    &__actions {
      display:         flex;
      align-items:     center;
      gap:             var(--dev-space-3);
      justify-content: flex-end;
    }

  }
</style>
