<script>
// The Share tab: a static build of this workspace's branch, on a link a reviewer can open.
//
// Two kinds of build, one mechanism (previews.ts, and the dashboard-preview App in apps.ts):
// the dashboard itself, served under /dashboard/ with the API proxied to a Rancher of your
// choosing, and its Storybook, a plain static site. Each is its own Installation, named for
// this workspace, listed in the sidebar under "Other apps", with a NodePort of its own. What a
// reviewer needs is the link and, for the dashboard, an account on that Rancher; nothing of
// the workspace's own tools is exposed, which is the point of keeping them apart.
import { Banner } from '@components/Banner';
import AsyncButton from '@shell/components/AsyncButton';
import {
  previewState, removePreview, shareWorkspace, previewBase, retargetPreview, rebuildPreview, LOCAL_HOST
} from '../previews';
import { buildShare, shareStatus, workspaceBranches } from '../workspace-tools';
import { defaultRancher, listRanchers } from '../ranchers';
import { listApps } from '../apps';
import { DEFAULT_APP } from '../config/constants';
import { DEFAULT_REPO } from '../reviews';

const REFRESH_MS = 8000;

const KINDS = [
  { kind: 'dashboard', title: 'Rancher dashboard', needsRancher: true },
  { kind: 'storybook', title: 'Storybook', needsRancher: false },
];

export default {
  name: 'WorkspaceShare',

  components: { Banner, AsyncButton },

  props: {
    workspace: { type: Object, required: true },
    pr:        { type: Number, default: 0 },
    issue:     { type: Number, default: 0 },
  },

  async fetch() {
    await this.resolve();
    await this.refresh();
  },

  data() {
    return {
      KINDS,
      repo:      DEFAULT_REPO,
      number:    0,
      ref:       '',
      sha:       '',
      /** Every local branch of the checkout, with its head; the current one first. */
      branches:  [],
      /** Per kind: the branch picked to build, when not the one the checkout is on. */
      picked:    {},
      states:    {},
      builds:    {},
      rancher:   window.location.origin,
      /** The Ranchers the sidebar lists, for the picker; only those with an address. */
      ranchers:  [],
      /** Per kind: a picker on "Another Rancher", with the address typed so far. */
      other:     {},
      custom:    '',
      /** Where builds are hosted: the starred Rancher's cluster when that is a public one, else here. Not asked; decided. */
      hostOn:    'local',
      /** The link copied a moment ago, for its button to say so. */
      copiedUrl: '',
      error:     '',
      notice:    '',
      timer:     null,
    };
  },

  mounted() {
    this.timer = setInterval(() => this.refresh(), REFRESH_MS);
  },

  beforeUnmount() {
    clearInterval(this.timer);
  },

  methods: {
    /** Which repository, and what the checkout is on: its branch and head, read from the workspace. */
    async resolve() {
      const apps = await listApps(this.$store).catch(() => []);
      const own = apps.find((app) => app.id === this.workspace.app && app.repo);
      const fallback = apps.find((app) => app.id === DEFAULT_APP && app.repo) || apps.find((app) => !!app.repo);

      this.repo = (own || fallback)?.repo || DEFAULT_REPO;
      this.number = this.pr || 0;
      // The starred Rancher (the sidebar's Ranchers list), else the one this page is on.
      this.rancher = (await defaultRancher().catch(() => '')) || window.location.origin;
      this.ranchers = (await listRanchers(this.$store).catch(() => [])).filter((r) => r.url);
      // Hosted where the starred Rancher is, when that is one of the sidebar's: a link on the
      // open internet is what a share is for, and that is where one can be.
      const starred = this.ranchers.find((r) => r.kind === 'instance' && r.url === this.rancher && r.clusterId);

      this.hostOn = starred?.clusterId || 'local';
      await this.readBranch();
    },

    async readBranch() {
      const { branch, sha, branches } = await workspaceBranches(this.workspace.name).catch(() => ({ branch: '', sha: '', branches: [] }));

      this.ref = branch;
      this.sha = sha;
      this.branches = branches;
    },

    // ── Branches ──

    /** The branch a kind builds: the one picked, else the one it was built from, else the checkout's. */
    branchFor(kind) {
      return this.picked[kind] || this.buildOf(kind)?.branch || this.stateOf(kind)?.ref || this.ref;
    },

    /** The picker's rows: the checkout's branches, plus the built one when it is gone. */
    branchOptions(kind) {
      const rows = this.branches.map((b) => b.name);
      const built = this.branchFor(kind);

      if (built && !rows.includes(built)) {
        rows.unshift(built);
      }

      return rows;
    },

    headOf(name) {
      return (this.branches.find((b) => b.name === name) || {}).sha || '';
    },

    /** A served build behind its branch: the head moved since it was built. */
    stale(kind) {
      const build = this.buildOf(kind);

      if (!build || build.state !== 'ok' || !build.sha) {
        return null;
      }
      const head = this.headOf(build.branch);

      return head && head !== build.sha ? { built: build.sha, head } : null;
    },

    /** A branch picked: remembered for the next build, and built now when something is served. */
    async pickBranch(kind, name) {
      this.picked = { ...this.picked, [kind]: name };
      if (this.stateOf(kind)?.exists) {
        await this.rebuild(kind, () => {});
      }
    },

    async refresh() {
      try {
        const states = {};

        for (const { kind } of KINDS) {
          states[kind] = await previewState(this.$store, this.workspace.name, this.workspace.cluster, kind);
        }
        this.states = states;
        this.builds = await shareStatus(this.workspace.name).catch(() => ({}));
        await this.readBranch();
      } catch (e) {
        this.error = e.message || String(e);
      }
    },

    buildOf(kind) {
      return this.builds[kind] || null;
    },

    when(iso) {
      if (!iso) {
        return '';
      }
      const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));

      return seconds < 60 ? `${ seconds }s ago` : seconds < 3600 ? `${ Math.round(seconds / 60) }m ago` : `${ Math.round(seconds / 3600) }h ago`;
    },

    stateOf(kind) {
      return this.states[kind] || null;
    },

    tone(state) {
      return state === 'serving' ? 'serving' : ['failed', 'stopped'].includes(state) ? 'failed' : 'building';
    },

    async deploy(kind, done) {
      this.error = '';

      try {
        await shareWorkspace(this.$store, this.workspace.name, kind, this.rancher.trim().replace(/\/$/, '') || window.location.origin, this.workspace.cluster, this.hostFor(this.hostOn), this.branchFor(kind));
        this.notice = `Building ${ this.branchFor(kind) || 'the checkout' }; the link appears here when it is served.`;
        await this.refresh();
        done(true);
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },

    /** Build again, from the checkout as it is now. The link keeps serving the last build until this one is done. */
    async rebuild(kind, done) {
      try {
        const state = this.stateOf(kind);
        const remote = !!state?.host;
        const result = await buildShare(this.workspace.name, kind, remote ? (kind === 'storybook' ? '/' : '/dashboard/') : previewBase(this.workspace.name, this.workspace.cluster, kind), this.branchFor(kind));

        if (remote && result !== 'already-building') {
          // The preview fetches the build when its pod starts; see it through once the build is done.
          this.refetchWhenBuilt(kind, state.hostedOn);
        }

        this.notice = result === 'already-building' ? 'A build is already running; wait for it.' : `Building ${ this.branchFor(kind) || 'the checkout' }.`;
        await this.refresh();
        done(true);
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },

    /** After a rebuild for a public name: restart the preview's pod once the workspace's build is done, so it fetches the new one. */
    refetchWhenBuilt(kind, hostedOn) {
      const started = Date.now();
      const tick = async() => {
        const build = (await shareStatus(this.workspace.name).catch(() => ({})))[kind];

        if (build && build.state === 'ok') {
          await rebuildPreview(this.workspace.name, hostedOn, kind).catch(() => {});
          this.notice = 'Rebuilt; the public link picks it up in a moment.';
        } else if (build && build.state !== 'failed' && Date.now() - started < 30 * 60000) {
          setTimeout(tick, 15000);
        }
      };

      setTimeout(tick, 15000);
    },

    async remove(kind, done) {
      try {
        await removePreview(this.$store, this.workspace.name, kind);
        await this.refresh();
        done(true);
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },

    // ── Where a build is hosted ──

    /** This cluster, and every Rancher of the sidebar's that is up: those have a public name to serve on. */
    hostOptions() {
      return [
        { id: 'local', label: 'This cluster · link needs a login here' },
        ...this.ranchers.filter((r) => r.kind === 'instance' && r.phase === 'ready' && r.clusterId).map((r) => ({ id: r.clusterId, label: `${ r.name } · public link` })),
      ];
    },

    hostFor(id) {
      const rancher = this.ranchers.find((r) => r.clusterId === id);

      return rancher ? { id, fleet: rancher.name, ip: rancher.nodeIp || '' } : LOCAL_HOST;
    },

    hostLabel(id) {
      return (this.hostOptions().find((h) => h.id === id) || {}).label || (id === 'local' || !id ? 'This cluster' : id);
    },

    // ── Which Rancher a dashboard build talks to ──

    /** The address a kind talks to now: the served one's, else what the next build will use. */
    currentRancher(kind) {
      const state = this.stateOf(kind);

      return (state?.exists ? state.rancherUrl : this.rancher) || '';
    },

    /** The picker's rows: the listed Ranchers, plus the current address when it is none of them. */
    rancherOptions(kind) {
      const current = this.currentRancher(kind);
      const rows = this.ranchers.map((r) => ({ url: r.url, label: `${ r.name } · ${ this.host(r.url) }` }));

      if (current && !rows.some((r) => r.url === current)) {
        rows.unshift({ url: current, label: this.host(current) });
      }

      return rows;
    },

    host(url) {
      try {
        return new URL(url).host;
      } catch {
        return url;
      }
    },

    /** A pick: the served build is pointed there now; an unshared one remembers it for the build. */
    async pick(kind, value) {
      if (value === '__other') {
        this.custom = this.currentRancher(kind);
        this.other = { ...this.other, [kind]: true };

        return;
      }
      this.other = { ...this.other, [kind]: false };
      await this.retarget(kind, value);
    },

    async useCustom(kind) {
      const url = this.custom.trim().replace(/\/$/, '');

      if (!/^https?:\/\//.test(url)) {
        this.error = 'A Rancher is an https:// address.';

        return;
      }
      this.other = { ...this.other, [kind]: false };
      await this.retarget(kind, url);
    },

    async retarget(kind, url) {
      this.error = '';
      if (!this.stateOf(kind)?.exists) {
        this.rancher = url;

        return;
      }
      try {
        await retargetPreview(this.$store, this.workspace.name, kind, url);
        this.notice = `Now talking to ${ this.host(url) }; the link is back in a moment while nginx restarts.`;
        await this.refresh();
      } catch (e) {
        this.error = e.message || String(e);
      }
    },

    /**
     * What the GitHub app has to know about a public link: the dashboard sends GitHub back to
     * `<origin>/verify-auth`, and GitHub only goes to a callback it was given. Ten fit; each
     * public share is one of them, the local admin password needs none.
     */
    callbackFor(state) {
      return `https://${ state.host }/verify-auth`;
    },

    /** The button says it happened: "Copied" for a moment, where "Copy link" was. */
    async copy(url) {
      try {
        await navigator.clipboard.writeText(url);
        this.copiedUrl = url;
        setTimeout(() => {
          if (this.copiedUrl === url) {
            this.copiedUrl = '';
          }
        }, 1500);
      } catch {
        this.notice = url;
      }
    },
  },
};
</script>

<template>
  <div class="workspace-share">
    <Banner
      v-if="error"
      color="error"
      :label="error"
    />
    <Banner
      v-if="notice"
      color="info"
      :closable="true"
      :label="notice"
      @close="notice = ''"
    />

    <div class="workspace-share__grid">
      <section
        v-for="k in KINDS"
        :key="k.kind"
        class="workspace-share__card"
        :data-testid="`share-${ k.kind }`"
      >
        <header class="workspace-share__head">
          <h3>{{ k.title }}</h3>
          <span
            v-if="stateOf(k.kind) && stateOf(k.kind).exists"
            class="workspace-share__state"
            :class="`workspace-share__state--${ tone(stateOf(k.kind).state) }`"
          >{{ stateOf(k.kind).state }}</span>
        </header>

        <dl class="workspace-share__facts">
          <dt>Branch</dt>
          <dd>
            <div class="workspace-share__pick">
              <select
                :value="branchFor(k.kind)"
                class="workspace-share__select"
                aria-label="Branch to build"
                :data-testid="`share-branch-${ k.kind }`"
                @change="pickBranch(k.kind, $event.target.value)"
              >
                <option
                  v-for="name in branchOptions(k.kind)"
                  :key="name"
                  :value="name"
                >
                  {{ name }}{{ name === ref ? ' (checked out)' : '' }}
                </option>
              </select>
              <span
                v-if="branchFor(k.kind) !== ref"
                class="text-muted workspace-share__hint"
              >built from a worktree; the checkout stays as it is</span>
            </div>
          </dd>

          <template v-if="buildOf(k.kind) && buildOf(k.kind).state !== 'none'">
            <dt>Build</dt>
            <dd
              class="workspace-share__build"
              :class="`workspace-share__build--${ buildOf(k.kind).state }`"
            >
              <i
                v-if="buildOf(k.kind).state === 'building'"
                class="icon icon-spinner icon-spin"
              />
              <template v-if="buildOf(k.kind).state === 'building'">Building</template>
              <template v-else-if="buildOf(k.kind).state === 'ok'">Built</template>
              <template v-else-if="buildOf(k.kind).state === 'stopped'">Stopped before it finished - the workspace restarted, or the build was killed</template>
              <template v-else>Failed</template>
              <template v-if="buildOf(k.kind).sha"> at <code>{{ buildOf(k.kind).sha }}</code></template>
              <span class="text-muted"> · {{ when(buildOf(k.kind).at) }}</span>
              <span
                v-if="stale(k.kind)"
                class="workspace-share__stale"
                :title="`Built at ${ stale(k.kind).built }; ${ buildOf(k.kind).branch } is now at ${ stale(k.kind).head }`"
                :data-testid="`share-stale-${ k.kind }`"
              >stale · branch is at <code>{{ stale(k.kind).head }}</code></span>
            </dd>
          </template>

          <template v-if="stateOf(k.kind) && stateOf(k.kind).exists">
            <dt>Link</dt>
            <dd>
              <p
                v-if="stateOf(k.kind).state !== 'serving'"
                class="text-muted workspace-share__detail"
              >
                {{ stateOf(k.kind).detail }}
              </p>
              <p
                v-if="stateOf(k.kind).url && stateOf(k.kind).state === 'serving'"
                class="workspace-share__linkrow"
              >
                <a
                  :href="stateOf(k.kind).url"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="workspace-share__link"
                >{{ stateOf(k.kind).url }}</a>
                <button
                  type="button"
                  class="btn role-tertiary btn-sm"
                  :class="{ 'workspace-share__copied': copiedUrl === stateOf(k.kind).url }"
                  @click="copy(stateOf(k.kind).url)"
                >
                  <i :class="copiedUrl === stateOf(k.kind).url ? 'icon icon-checkmark' : 'icon icon-copy'" />
                  {{ copiedUrl === stateOf(k.kind).url ? 'Copied' : 'Copy link' }}
                </button>
                <span class="text-muted workspace-share__hint">{{ stateOf(k.kind).host ? 'public' : 'needs a login here' }}</span>
              </p>
              <p
                v-if="stateOf(k.kind).host && k.needsRancher"
                class="workspace-share__linkrow workspace-share__callback"
                data-testid="share-callback"
              >
                <span class="text-muted">GitHub login needs this in the GitHub app's callbacks:</span>
                <code>{{ callbackFor(stateOf(k.kind)) }}</code>
                <button
                  type="button"
                  class="btn role-tertiary btn-sm"
                  :class="{ 'workspace-share__copied': copiedUrl === callbackFor(stateOf(k.kind)) }"
                  @click="copy(callbackFor(stateOf(k.kind)))"
                >
                  <i :class="copiedUrl === callbackFor(stateOf(k.kind)) ? 'icon icon-checkmark' : 'icon icon-copy'" />
                  {{ copiedUrl === callbackFor(stateOf(k.kind)) ? 'Copied' : 'Copy' }}
                </button>
              </p>
              <p
                v-if="stateOf(k.kind).direct && stateOf(k.kind).state === 'serving'"
                class="workspace-share__linkrow workspace-share__linkrow--direct"
              >
                <span class="text-muted">Direct, no login:</span>
                <a
                  :href="stateOf(k.kind).direct"
                  target="_blank"
                  rel="noopener noreferrer"
                >{{ stateOf(k.kind).direct }}</a>
                <button
                  type="button"
                  class="btn role-tertiary btn-sm"
                  :class="{ 'workspace-share__copied': copiedUrl === stateOf(k.kind).direct }"
                  @click="copy(stateOf(k.kind).direct)"
                >
                  <i :class="copiedUrl === stateOf(k.kind).direct ? 'icon icon-checkmark' : 'icon icon-copy'" />
                  {{ copiedUrl === stateOf(k.kind).direct ? 'Copied' : 'Copy link' }}
                </button>
              </p>
            </dd>
          </template>

          <template v-if="k.needsRancher">
            <dt>Talks to</dt>
            <dd>
              <div class="workspace-share__pick">
                <select
                  :value="other[k.kind] ? '__other' : currentRancher(k.kind)"
                  class="workspace-share__select"
                  aria-label="Rancher the build talks to"
                  @change="pick(k.kind, $event.target.value)"
                >
                  <option
                    v-for="r in rancherOptions(k.kind)"
                    :key="r.url"
                    :value="r.url"
                  >
                    {{ r.label }}
                  </option>
                  <option value="__other">
                    Another Rancher…
                  </option>
                </select>
                <template v-if="other[k.kind]">
                  <input
                    v-model="custom"
                    class="workspace-share__rancher"
                    type="text"
                    placeholder="https://rancher.example.com"
                    aria-label="Address of the Rancher"
                    @keydown.enter.prevent="useCustom(k.kind)"
                  >
                  <button
                    type="button"
                    class="btn role-secondary btn-sm"
                    @click="useCustom(k.kind)"
                  >
                    Use
                  </button>
                </template>
              </div>
            </dd>
          </template>
        </dl>

        <pre
          v-if="buildOf(k.kind) && ['failed', 'stopped'].includes(buildOf(k.kind).state) && buildOf(k.kind).log"
          class="workspace-share__log"
        >{{ buildOf(k.kind).log }}</pre>

        <div class="workspace-share__actions">
          <template v-if="stateOf(k.kind) && stateOf(k.kind).exists">
            <AsyncButton
              mode="apply"
              :action-label="stale(k.kind) ? 'Rebuild (stale)' : 'Rebuild'"
              waiting-label="Starting"
              success-label="Building"
              size="sm"
              @click="(done) => rebuild(k.kind, done)"
            />
            <AsyncButton
              mode="delete"
              action-label="Remove"
              waiting-label="Removing"
              success-label="Removed"
              size="sm"
              @click="(done) => remove(k.kind, done)"
            />
          </template>
          <AsyncButton
            v-else
            mode="apply"
            :action-label="`Build and share ${ k.kind === 'storybook' ? 'Storybook' : 'the dashboard' }`"
            waiting-label="Deploying"
            success-label="Deploying"
            size="sm"
            :disabled="k.needsRancher && !rancher.trim()"
            @click="(done) => deploy(k.kind, done)"
          />
        </div>
      </section>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.workspace-share__build {
  font-size: 12px;
  margin:    0 0 var(--dev-space-2);

  &--failed { color: var(--error); }
  &--ok { color: var(--success); }
}

.workspace-share__log {
  max-height: 160px;
  overflow:   auto;
  font-size:  11px;
  margin:     0 0 var(--dev-space-2);
  padding:    var(--dev-space-2);
  background: var(--body-bg);
  border:     1px solid var(--border);
  white-space: pre-wrap;
}

  .workspace-share {
    padding:    var(--dev-space-5);
    overflow-y: auto;

    &__intro { margin: 0 0 var(--dev-space-4) 0; }

    &__grid {
      display:               grid;
      grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
      gap:                   var(--dev-space-5);
      align-items:           start;
    }

    &__card {
      border:        1px solid var(--border);
      border-radius: var(--border-radius);
      padding:       var(--dev-space-4);
    }

    &__head {
      display:         flex;
      align-items:     center;
      justify-content: space-between;
      gap:             var(--dev-space-3);
      margin-bottom:   var(--dev-space-3);

      h3 { margin: 0; }
    }

    &__blurb { margin: 0 0 var(--dev-space-4) 0; }

    &__state {
      padding:        1px 8px;
      border-radius:  12px;
      font-size:      11px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      background:     var(--warning-banner-bg);
      color:          var(--warning);

      &--serving { background: var(--success-banner-bg); color: var(--success); }
      &--failed  { background: var(--error-banner-bg);   color: var(--error); }
    }

    &__linkrow {
      display:     flex;
      align-items: center;
      gap:         var(--dev-space-3);
      flex-wrap:   wrap;
    }

    &__link { font-size: 15px; font-weight: 600; word-break: break-all; }
    &__linkrow--direct { font-size: 12px; a { word-break: break-all; } }

    &__facts {
      display:               grid;
      grid-template-columns: max-content 1fr;
      gap:                   var(--dev-space-2) var(--dev-space-4);
      margin:                var(--dev-space-3) 0;

      dt { color: var(--muted); }
      dd { margin: 0; }
    }

    &__row {
      display:       flex;
      align-items:   center;
      flex-wrap:     wrap;
      gap:           var(--dev-space-3);
      margin-bottom: var(--dev-space-3);
    }
    &__rancher { flex: 1 1 200px; min-width: 0; }

    &__stale {
      margin-left:   var(--dev-space-2);
      padding:       1px 8px;
      border-radius: 9px;
      font-size:     12px;
      color:         var(--warning);
      border:        1px solid var(--warning);
    }

    &__hint { font-size: 12px; }
    &__copied { color: var(--success) !important; }
    &__callback { font-size: 12px; code { font-size: 11px; } }
    &__detail { margin: 0; }

    &__pick {
      display:     flex;
      align-items: center;
      flex-wrap:   wrap;
      gap:         8px;
    }

    &__select {
      max-width:  100%;
      min-height: 0;
      height:     30px;
      padding:    0 28px 0 10px;
      font-size:  13px;
    }

    &__actions {
      display:   flex;
      flex-wrap: wrap;
      gap:       var(--dev-space-3);
    }
  }
</style>
