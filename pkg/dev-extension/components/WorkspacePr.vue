<script>
// The pull request a workspace is for.
//
// A workspace named `pr-<n>` is about that PR; one named `issue-<n>` is about the PR that
// closes the issue, once there is one. This tab is what the harness's PR tab was: the PR's
// state, its checks and its reviews at a glance, with the review itself left to a conversation
// - the agent reads the diff better than a pane of it here would.
import { Banner } from '@components/Banner';
import { RcButton } from '@components/RcButton';
import { pullRequest, linkedPullRequest } from '../github';
import { listApps } from '../apps';
import { DEFAULT_APP } from '../config/constants';

export default {
  name: 'WorkspacePr',

  components: { Banner, RcButton },

  props: {
    workspace: {
      type:     Object,
      required: true,
    },
    /** The PR number the workspace's name carries, or 0. */
    pr: {
      type:    Number,
      default: 0,
    },
    /** The issue number it carries instead, or 0. */
    issue: {
      type:    Number,
      default: 0,
    },
  },

  async fetch() {
    await this.load();
  },

  data() {
    return {
      detail:  null,
      error:   '',
      loading: false,
    };
  },

  computed: {
    checks() {
      return this.detail?.checks || null;
    },
  },

  methods: {
    async load() {
      this.loading = true;
      this.error = '';

      try {
        const repo = await this.repository();
        const number = this.pr || (this.issue ? await linkedPullRequest(repo, this.issue) : 0);

        this.detail = number ? await pullRequest(repo, number) : null;
      } catch (e) {
        this.error = e.message || String(e);
      } finally {
        this.loading = false;
      }
    },

    /** The repository this workspace is about: its app's `repo` value, or the default app's. */
    async repository() {
      const apps = await listApps(this.$store).catch(() => []);
      const own = apps.find((app) => app.id === this.workspace.app && app.repo);
      const fallback = apps.find((app) => app.id === DEFAULT_APP && app.repo) || apps.find((app) => !!app.repo);

      return (own || fallback)?.repo || 'rancher/dashboard';
    },

    tone(state) {
      return { OPEN: 'success', MERGED: 'info', CLOSED: 'error', DRAFT: 'warning' }[state] || 'info';
    },
  },
};
</script>

<template>
  <div class="workspace-pr">
    <Banner
      v-if="error"
      color="error"
      :label="error"
    />
    <Banner
      v-else-if="!loading && !detail && issue"
      color="info"
      :label="`No pull request closes #${ issue } yet. One will show up here when it does.`"
    />
    <div
      v-else-if="detail"
      class="workspace-pr__card"
    >
      <header class="workspace-pr__head">
        <span
          class="workspace-pr__state"
          :class="`workspace-pr__state--${ tone(detail.state) }`"
        >{{ detail.state }}</span>
        <a
          :href="detail.url"
          target="_blank"
          rel="noopener noreferrer"
          class="workspace-pr__title"
        >#{{ detail.number }} {{ detail.title }}</a>
      </header>
      <dl class="workspace-pr__facts">
        <dt>Repository</dt>
        <dd>{{ detail.repo }}</dd>
        <dt>Branch</dt>
        <dd><code>{{ detail.headRef }}</code> into <code>{{ detail.baseRef }}</code></dd>
        <dt>Changes</dt>
        <dd>{{ detail.changedFiles }} files, +{{ detail.additions }} / -{{ detail.deletions }}</dd>
        <dt>Reviews</dt>
        <dd>
          <span v-if="detail.reviewDecision">{{ detail.reviewDecision.toLowerCase().replace(/_/g, ' ') }}</span>
          <span v-else class="text-muted">none yet</span>
          <span v-if="detail.approvedBy.length"> - approved by {{ detail.approvedBy.join(', ') }}</span>
        </dd>
        <dt>Checks</dt>
        <dd>
          <span v-if="!checks" class="text-muted">none configured</span>
          <span v-else-if="checks.failing" class="workspace-pr__bad">{{ checks.failing }} failing</span>
          <span v-else-if="checks.pending" class="workspace-pr__pending">{{ checks.pending }} running</span>
          <span v-else class="workspace-pr__good">all {{ checks.total }} passing</span>
        </dd>
        <dt>Updated</dt>
        <dd>{{ new Date(detail.updatedAt).toLocaleString() }}</dd>
      </dl>
      <p
        v-if="detail.body"
        class="workspace-pr__body"
      >
        {{ detail.body }}
      </p>
      <div class="workspace-pr__actions">
        <RcButton
          variant="secondary"
          size="small"
          :href="detail.url"
          target="_blank"
        >
          Open on GitHub
        </RcButton>
        <RcButton
          variant="tertiary"
          size="small"
          @click="load"
        >
          Refresh
        </RcButton>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
  .workspace-pr {
    padding:    var(--dev-space-5);
    overflow-y: auto;

    &__card {
      max-width: 90ch;
    }

    &__head {
      display:       flex;
      align-items:   center;
      gap:           var(--dev-space-3);
      margin-bottom: var(--dev-space-4);
    }

    &__state {
      padding:        2px 8px;
      border-radius:  12px;
      font-size:      11px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      background:     var(--info-banner-bg);
      color:          var(--info);

      &--success { background: var(--success-banner-bg); color: var(--success); }
      &--error   { background: var(--error-banner-bg);   color: var(--error); }
      &--warning { background: var(--warning-banner-bg); color: var(--warning); }
    }

    &__title {
      font-size:   16px;
      font-weight: 600;
    }

    &__facts {
      display:               grid;
      grid-template-columns: max-content 1fr;
      gap:                   var(--dev-space-2) var(--dev-space-4);
      margin:                0 0 var(--dev-space-4) 0;

      dt { color: var(--muted); }
      dd { margin: 0; }
    }

    &__body {
      white-space: pre-wrap;
      color:       var(--body-text);
      margin:      0 0 var(--dev-space-4) 0;
    }

    &__actions {
      display: flex;
      gap:     var(--dev-space-3);
    }

    &__good    { color: var(--success); }
    &__bad     { color: var(--error); }
    &__pending { color: var(--warning); }
  }
</style>
