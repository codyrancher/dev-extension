<script>
/**
 * What the work produced, after the work is gone.
 *
 * A workspace is disposable; the recordings, screenshots and reports an agent made while it
 * worked are not. Those are hardlinked aside before a tree is deleted (captureWorkspaceArtifacts
 * in api.ts), and this is where the kept sets are read - each one against the issue it came
 * from, so a set is evidence about something rather than a directory of files.
 *
 * Nothing here expires. A set lingers until somebody presses Delete on this page, which is the
 * only thing in the product that removes one.
 */
import { Banner } from '@components/Banner';
import DevPage from '../components/DevPage.vue';
import { RcButton } from '@components/RcButton';
import ArtifactViewer from '../components/pr/ArtifactViewer.vue';
import WorkspaceArtifacts from '../components/WorkspaceArtifacts.vue';
import { listArtifactSets, removeArtifactSet } from '../api';
import { issuesByNumber } from '../github';
import { DEFAULT_REPO } from '../reviews';
import { ago, readArtifacts } from '../workspace-rail';

export default {
  name: 'DevArtifacts',

  components: {
    Banner, RcButton, ArtifactViewer, WorkspaceArtifacts, DevPage
  },

  data() {
    return {
      sets:    [],
      issues:  {},
      loading: true,
      error:   '',
      /** The file being looked at, in the viewer. */
      shot:    null,
      /**
       * The grouped listing per set, as the workspace column reads it.
       *
       * Keyed by set, loaded when the page loads. The same shape WorkspaceArtifacts takes, from
       * the same `readArtifacts` - so a kept set is drawn by the component that already draws a
       * live workspace's artifacts rather than by a second gallery that looks nearly like it.
       */
      listing: {},
    };
  },

  mounted() {
    this.refresh();
  },

  methods: {
    ago,

    /** The issue a set is about, once it has been read. */
    issueFor(set) {
      return set.issue ? this.issues[`${ DEFAULT_REPO }#${ set.issue }`] || null : null;
    },

    /** What the gallery asks to open: the same `{ src, name }` the workspace column emits. */
    look(set, file) {
      this.shot = {
        src: file.url, name: file.label || file.path, caption: `${ set.workspace } · ${ file.path }`, path: file.path,
      };
    },

    async refresh() {
      this.error = '';
      this.loading = true;

      try {
        this.sets = await listArtifactSets();

        // One query for every issue the sets name, not one per set. An issue that cannot be
        // read leaves its set listed with no issue line, which is still a set worth keeping.
        const numbers = [...new Set(this.sets.map((set) => set.issue).filter(Boolean))];
        const found = numbers.length ? await issuesByNumber(DEFAULT_REPO, numbers).catch(() => []) : [];

        this.issues = Object.fromEntries(found.map((issue) => [issue.key, issue]));

        // One listing per set, in parallel. A set whose files cannot be read keeps its row and
        // its issue line - the set still exists, and saying nothing about it would read as empty.
        const listings = await Promise.all(this.sets.map((set) => readArtifacts(`set:${ set.workspace }`)
          .then((got) => [set.workspace, got])
          .catch(() => [set.workspace, { groups: [], total: 0, truncated: false }])));

        this.listing = Object.fromEntries(listings);
      } catch (e) {
        this.error = e.message || String(e);
      } finally {
        this.loading = false;
      }
    },

    async remove(set) {
      // Asked for, because this is the only thing that deletes evidence and it cannot be undone.
      if (!confirm(`Delete the artifacts kept from ${ set.workspace }? This cannot be undone.`)) { // eslint-disable-line no-alert
        return;
      }

      try {
        await removeArtifactSet(set.workspace);
        this.sets = this.sets.filter((one) => one.workspace !== set.workspace);
      } catch (e) {
        this.error = e.message || String(e);
      }
    },
  },
};
</script>

<template>
  <DevPage
    title="Artifacts"
    lede="What the work produced, kept after the workspace was deleted."
  >

    <Banner
      v-if="error"
      color="warning"
    >
      {{ error }}
    </Banner>

    <div
      v-if="loading"
      class="dev-artifacts__loading"
    >
      <i class="icon icon-spinner icon-spin" />
      <span>Reading what has been kept&hellip;</span>
    </div>

    <Banner
      v-else-if="!sets.length"
      color="info"
    >
      Nothing kept yet. A set is written when a workspace with artifacts is deleted, and stays
      until it is deleted here.
    </Banner>

    <div
      v-for="set in sets"
      v-else
      :key="set.workspace"
      class="dev-artifacts__set"
    >
      <header class="dev-artifacts__head">
        <div class="dev-artifacts__what">
          <code class="dev-artifacts__ws">{{ set.workspace }}</code>

          <!-- What it is evidence about, and whether that is still open. -->
          <a
            v-if="issueFor(set)"
            :href="issueFor(set).url"
            target="_blank"
            rel="noopener noreferrer"
            class="dev-artifacts__issue"
          >#{{ set.issue }} {{ issueFor(set).title }}</a>
          <span
            v-else-if="set.issue"
            class="dev-artifacts__issue text-muted"
          >#{{ set.issue }}</span>
          <span
            v-else-if="set.pr"
            class="dev-artifacts__issue text-muted"
          >PR #{{ set.pr }}</span>

          <span
            v-if="issueFor(set)"
            class="dev-artifacts__state"
            :class="`dev-artifacts__state--${ (issueFor(set).state || '').toLowerCase() }`"
          >{{ (issueFor(set).state || '').toLowerCase() || 'unknown' }}</span>
        </div>

        <div class="dev-artifacts__meta">
          <span
            v-if="set.capturedAt"
            :title="set.capturedAt"
          >kept {{ ago(set.capturedAt) }}</span>
          <span>{{ set.files.length }} file{{ set.files.length === 1 ? '' : 's' }}</span>
          <RcButton
            variant="link"
            size="small"
            @click="toggle(set)"
          >
            {{ open[set.workspace] ? 'Hide files' : 'All files' }}
          </RcButton>
          <RcButton
            variant="secondary"
            size="small"
            @click="remove(set)"
          >
            Delete
          </RcButton>
        </div>
      </header>

      <!--
        The same gallery the workspace column draws, from the same listing.
        Grouped by directory, with the counts, sizes and ages it already shows - rather than a
        second gallery that looks nearly like it and drifts from it.
      -->
      <WorkspaceArtifacts
        v-if="listing[set.workspace] && listing[set.workspace].groups.length"
        :workspace="`set:${ set.workspace }`"
        :groups="listing[set.workspace].groups"
        :total="listing[set.workspace].total"
        :truncated="listing[set.workspace].truncated"
        @open="look(set, $event)"
      />
      <p
        v-else
        class="text-muted dev-artifacts__none"
      >Nothing in this set could be read. The files are kept; the API may be restarting.</p>
    </div>

    <Teleport to="body">
      <ArtifactViewer
        v-if="shot"
        :key="shot.src"
        :src="shot.src"
        :name="shot.name"
        :caption="shot.caption"
        @close="shot = null"
      />
    </Teleport>
  </DevPage>
</template>

<style lang="scss" scoped>
.dev-artifacts__loading {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 24px 0;
  color: var(--muted);
}

.dev-artifacts__set {
  margin: 0 0 16px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--box-bg);
}

.dev-artifacts__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.dev-artifacts__what {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}

.dev-artifacts__ws { font-size: 12px; }

.dev-artifacts__issue {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 48ch;
}

.dev-artifacts__state {
  padding: 0 8px;
  border-radius: 10px;
  font-size: 11px;
  background: var(--default);
  color: var(--muted);
}

.dev-artifacts__state--open   { background: var(--success-banner-bg); color: var(--success); }
.dev-artifacts__state--closed { background: var(--default); color: var(--muted); }

.dev-artifacts__meta {
  display: flex;
  align-items: center;
  gap: 12px;
  color: var(--muted);
  font-size: 12px;
}



.dev-artifacts__none { font-size: 12px; }


</style>
