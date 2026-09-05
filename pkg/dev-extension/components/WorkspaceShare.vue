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
  previewState, deployPreview, removePreview, rebuildPreview
} from '../previews';
import { linkedPullRequest } from '../github';
import { listApps } from '../apps';
import { DEFAULT_APP } from '../config/constants';
import { DEFAULT_REPO } from '../reviews';

const REFRESH_MS = 8000;

const KINDS = [
  {
    kind:        'dashboard',
    title:       'Rancher dashboard',
    blurb:       'The dashboard built at this branch, served under /dashboard/ with its API proxied to a Rancher you name. A reviewer opens the link and logs in to that Rancher.',
    needsRancher: true,
  },
  {
    kind:        'storybook',
    title:       'Storybook',
    blurb:       'The dashboard\'s Storybook built at this branch: every component, on its own, with nothing to log in to.',
    needsRancher: false,
  },
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
      states:    {},
      rancher:   window.location.origin,
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
    /** Which repository, and which ref: the PR's head when the workspace is for one, the default branch otherwise. */
    async resolve() {
      const apps = await listApps(this.$store).catch(() => []);
      const own = apps.find((app) => app.id === this.workspace.app && app.repo);
      const fallback = apps.find((app) => app.id === DEFAULT_APP && app.repo) || apps.find((app) => !!app.repo);

      this.repo = (own || fallback)?.repo || DEFAULT_REPO;
      this.number = this.pr || (this.issue ? await linkedPullRequest(this.repo, this.issue).catch(() => 0) : 0);
      this.ref = this.number ? `pull/${ this.number }/head` : 'master';
    },

    async refresh() {
      try {
        const states = {};

        for (const { kind } of KINDS) {
          states[kind] = await previewState(this.$store, this.workspace.name, this.workspace.cluster, kind);
        }
        this.states = states;
      } catch (e) {
        this.error = e.message || String(e);
      }
    },

    stateOf(kind) {
      return this.states[kind] || null;
    },

    tone(state) {
      return state === 'serving' ? 'serving' : state === 'failed' ? 'failed' : 'building';
    },

    async deploy(kind, done) {
      this.error = '';

      try {
        await deployPreview(this.$store, this.workspace.name, {
          repo: this.repo, ref: this.ref, kind, rancherUrl: this.rancher.trim().replace(/\/$/, '') || window.location.origin,
        }, this.workspace.cluster);
        this.notice = `${ kind === 'storybook' ? 'Storybook' : 'Dashboard' } build started. The first one takes several minutes; the link appears here when nginx is serving.`;
        await this.refresh();
        done(true);
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },

    async rebuild(kind, done) {
      try {
        await rebuildPreview(this.workspace.name, this.workspace.cluster, kind);
        this.notice = `Rebuilding at ${ this.ref }'s current head.`;
        await this.refresh();
        done(true);
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
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

    async copy(url) {
      try {
        await navigator.clipboard.writeText(url);
        this.notice = 'Link copied.';
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

    <p class="workspace-share__intro text-muted">
      Builds of <code>{{ repo }}</code> at <code>{{ ref }}</code>, each on a link of its own. The workspace's tools stay where they are; only the built site is shared.
    </p>

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
        <p class="text-muted workspace-share__blurb">
          {{ k.blurb }}
        </p>

        <template v-if="stateOf(k.kind) && stateOf(k.kind).exists">
          <p class="text-muted">
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
              @click="copy(stateOf(k.kind).url)"
            >
              Copy link
            </button>
          </p>
          <dl class="workspace-share__facts">
            <dt>Built at</dt>
            <dd><code>{{ stateOf(k.kind).ref }}</code></dd>
            <template v-if="k.needsRancher">
              <dt>Talks to</dt>
              <dd>{{ stateOf(k.kind).rancherUrl }}</dd>
            </template>
          </dl>
          <div class="workspace-share__actions">
            <AsyncButton
              mode="apply"
              action-label="Rebuild at current head"
              waiting-label="Restarting"
              success-label="Rebuilding"
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
          </div>
        </template>

        <template v-else>
          <div
            v-if="k.needsRancher"
            class="workspace-share__row"
          >
            <input
              v-model="rancher"
              class="workspace-share__rancher"
              type="text"
              placeholder="https://rancher.example.com"
              aria-label="Rancher the build talks to"
            >
          </div>
          <div class="workspace-share__actions">
            <AsyncButton
              mode="apply"
              :action-label="`Build and share ${ k.kind === 'storybook' ? 'Storybook' : 'the dashboard' }`"
              waiting-label="Deploying"
              success-label="Deploying"
              size="sm"
              :disabled="k.needsRancher && !rancher.trim()"
              @click="(done) => deploy(k.kind, done)"
            />
          </div>
        </template>
      </section>
    </div>
  </div>
</template>

<style lang="scss" scoped>
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

    &__facts {
      display:               grid;
      grid-template-columns: max-content 1fr;
      gap:                   var(--dev-space-2) var(--dev-space-4);
      margin:                var(--dev-space-3) 0;

      dt { color: var(--muted); }
      dd { margin: 0; }
    }

    &__row { margin-bottom: var(--dev-space-3); }
    &__rancher { width: 100%; }

    &__actions {
      display:   flex;
      flex-wrap: wrap;
      gap:       var(--dev-space-3);
    }
  }
</style>
