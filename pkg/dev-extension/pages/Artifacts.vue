<script>
/**
 * What the work produced, by what it was about.
 *
 * An agent that reproduces an issue leaves a recording, a screenshot, a script and a note behind,
 * and those files are the answer to a question somebody asked - issue 19517, pull request 19152.
 * This page used to be a list of directories instead: one card per *kept set*, which is what a
 * workspace leaves when it is deleted. So the evidence for one issue was split across however
 * many workspaces had worked on it, and a workspace still running showed nothing at all, because
 * nothing had been kept yet. Two agents could be recording an issue right now and this page would
 * say "nothing kept yet".
 *
 * So the card is the subject, and under it is every source of artifacts about that subject: the
 * workspaces still running, then the sets kept from the ones that are gone. Which issue a source
 * is about comes from the tag written beside its files (ARTIFACT_TAG in api.ts) and falls back to
 * the workspace's name - see artifact-subjects.mjs.
 *
 * Nothing here expires. A kept set lingers until somebody presses Delete on this page, which is
 * the only thing in the product that removes one; a live workspace's artifacts go when it does.
 */
import { Banner } from '@components/Banner';
import DevPage from '../components/DevPage.vue';
import { RcButton } from '@components/RcButton';
import ArtifactViewer from '../components/pr/ArtifactViewer.vue';
import WorkspaceArtifacts from '../components/WorkspaceArtifacts.vue';
import DevDialog from '../components/DevDialog.vue';
import ask from '../components/ask';
import { listArtifactSources, removeArtifactSet } from '../api';
import { groupSubjects } from '../artifact-subjects.mjs';
import { issuesByNumber } from '../github';
import { DEFAULT_REPO } from '../reviews';
import { ago, readArtifacts } from '../workspace-rail';

export default {
  name: 'DevArtifacts',

  components: {
    Banner, RcButton, ArtifactViewer, WorkspaceArtifacts, DevPage, DevDialog
  },

  mixins: [ask],

  data() {
    return {
      sources: [],
      issues:  {},
      loading: true,
      error:   '',
      /** The file being looked at, in the viewer. */
      shot:    null,
      /**
       * The grouped listing per source, as the workspace column reads it.
       *
       * Keyed the way the media API addresses it - a live workspace by its name, a kept set by
       * `set:<name>` - so one key serves both the listing and the file URLs. The same shape
       * WorkspaceArtifacts takes, from the same `readArtifacts`, so artifacts are drawn here by
       * the component that already draws them inside a workspace rather than by a second gallery
       * that looks nearly like it.
       */
      listing: {},
    };
  },

  computed: {
    /** The sources gathered by what they are evidence about, newest subject first. */
    subjects() {
      return groupSubjects(this.sources);
    },
  },

  mounted() {
    this.refresh();
  },

  methods: {
    ago,

    /** How the media API addresses this source's files. */
    keyOf(source) {
      return source.live ? source.workspace : `set:${ source.workspace }`;
    },

    /** The issue a subject is about, once it has been read. */
    issueFor(subject) {
      return subject.issue ? this.issues[`${ DEFAULT_REPO }#${ subject.issue }`] || null : null;
    },

    /** What the gallery asks to open: the same `{ src, name }` the workspace column emits. */
    look(source, file) {
      this.shot = {
        src: file.url, name: file.label || file.path, caption: `${ source.workspace } · ${ file.path }`, path: file.path,
      };
    },

    async refresh() {
      this.error = '';
      this.loading = true;

      try {
        this.sources = await listArtifactSources();

        // One query for every issue the subjects name, not one per card. An issue that cannot be
        // read leaves its card with the number and no title, which is still evidence about it.
        const numbers = [...new Set(this.subjects.map(({ issue }) => issue).filter(Boolean))];
        const found = numbers.length ? await issuesByNumber(DEFAULT_REPO, numbers).catch(() => []) : [];

        this.issues = Object.fromEntries(found.map((issue) => [issue.key, issue]));

        // One listing per source, in parallel. A source whose files cannot be read keeps its row
        // - it still exists, and saying nothing about it would read as empty.
        const listings = await Promise.all(this.sources.map((source) => readArtifacts(this.keyOf(source))
          .then((got) => [this.keyOf(source), got])
          .catch(() => [this.keyOf(source), { groups: [], total: 0, truncated: false }])));

        this.listing = Object.fromEntries(listings);
      } catch (e) {
        this.error = e.message || String(e);
      } finally {
        this.loading = false;
      }
    },

    async remove(source) {
      // Asked for, because this is the only thing that deletes evidence and it cannot be undone.
      if (!await this.askQuestion({
        title:        `Delete the artifacts kept from ${ source.workspace }?`,
        message:      'The recordings, screenshots and notes kept from that workspace go for good.',
        confirmLabel: 'Delete',
        danger:       true,
      })) {
        return;
      }

      try {
        await removeArtifactSet(source.workspace);
        this.sources = this.sources.filter((one) => one.live || one.workspace !== source.workspace);
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
    lede="What the work produced, by what it was about - from the workspaces still running and the sets kept after they were deleted."
  >
    <template #actions>
      <RcButton
        variant="secondary"
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
      v-if="loading"
      class="dev-artifacts__loading"
    >
      <i class="icon icon-spinner icon-spin" />
      <span>Reading what the work has produced&hellip;</span>
    </div>

    <Banner
      v-else-if="!subjects.length"
      color="info"
    >
      Nothing yet. Artifacts appear here as soon as an agent writes any, and the set kept from a
      deleted workspace stays until it is deleted here.
    </Banner>

    <div
      v-for="subject in subjects"
      v-else
      :key="subject.key"
      class="dev-artifacts__subject"
    >
      <header class="dev-artifacts__head">
        <div class="dev-artifacts__what">
          <!-- What this is evidence about, and whether that is still open. -->
          <a
            v-if="issueFor(subject)"
            :href="issueFor(subject).url"
            target="_blank"
            rel="noopener noreferrer"
            class="dev-artifacts__issue"
          >#{{ subject.issue }} {{ issueFor(subject).title }}</a>
          <span
            v-else-if="subject.kind === 'issue'"
            class="dev-artifacts__issue text-muted"
          >#{{ subject.issue }}</span>
          <span
            v-else-if="subject.kind === 'pr'"
            class="dev-artifacts__issue text-muted"
          >PR #{{ subject.pr }}</span>
          <!-- Neither: the workspace is the subject, so it is named rather than filed under "other". -->
          <code
            v-else
            class="dev-artifacts__ws"
          >{{ subject.sources[0].workspace }}</code>

          <span
            v-if="issueFor(subject)"
            class="dev-artifacts__state"
            :class="`dev-artifacts__state--${ (issueFor(subject).state || '').toLowerCase() }`"
          >{{ (issueFor(subject).state || '').toLowerCase() || 'unknown' }}</span>
        </div>

        <div class="dev-artifacts__meta">
          <span v-if="subject.at">{{ ago(new Date(subject.at).toISOString()) }}</span>
          <span>{{ subject.files }} file{{ subject.files === 1 ? '' : 's' }}</span>
        </div>
      </header>

      <!--
        One block per source. A workspace still running is said to be, because its artifacts are
        still arriving and it can be opened; a kept set is all there will ever be of that
        workspace, and is the only thing here that can be deleted.
      -->
      <section
        v-for="source in subject.sources"
        :key="keyOf(source)"
        class="dev-artifacts__source"
      >
        <div class="dev-artifacts__from">
          <span
            class="dev-artifacts__tag"
            :class="source.live ? 'dev-artifacts__tag--live' : 'dev-artifacts__tag--kept'"
          >{{ source.live ? 'live' : 'kept' }}</span>
          <code class="dev-artifacts__ws">{{ source.workspace }}</code>
          <span
            v-if="source.at"
            class="dev-artifacts__when"
          >{{ source.live ? 'last wrote' : 'kept' }} {{ ago(new Date(source.at).toISOString()) }}</span>
          <RcButton
            v-if="!source.live"
            variant="secondary"
            size="small"
            @click="remove(source)"
          >
            Delete
          </RcButton>
        </div>

        <!--
          The same gallery the workspace column draws, from the same listing: grouped by
          directory, with the counts, sizes and ages it already shows.
        -->
        <WorkspaceArtifacts
          v-if="listing[keyOf(source)] && listing[keyOf(source)].groups.length"
          :workspace="keyOf(source)"
          :groups="listing[keyOf(source)].groups"
          :total="listing[keyOf(source)].total"
          :truncated="listing[keyOf(source)].truncated"
          @open="look(source, $event)"
        />
        <p
          v-else
          class="text-muted dev-artifacts__none"
        >
          Nothing here could be read. The files are there; the API may be restarting.
        </p>
      </section>
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
    <DevDialog
      v-if="asking"
      v-bind="asking.question"
      @confirm="asking.answer(true, $event)"
      @cancel="asking.answer(false)"
    />
  </DevPage>
</template>

<style lang="scss" scoped>
.dev-artifacts__loading {
  display:     flex;
  align-items: center;
  gap:         var(--dev-space-3);
  padding:     var(--dev-space-5) 0;
  color:       var(--muted);
}

.dev-artifacts__subject {
  margin:        0 0 var(--dev-space-4);
  padding:       var(--dev-space-4);
  border:        1px solid var(--border);
  border-radius: var(--r-sm);
  background:    var(--box-bg);
}

.dev-artifacts__head {
  display:         flex;
  align-items:     center;
  justify-content: space-between;
  gap:             var(--dev-space-4);
  flex-wrap:       wrap;
}

.dev-artifacts__what {
  display:     flex;
  align-items: center;
  gap:         var(--dev-space-3);
  flex-wrap:   wrap;
  min-width:   0;
}

.dev-artifacts__ws { font-size: 12px; }

.dev-artifacts__issue {
  overflow:      hidden;
  text-overflow: ellipsis;
  white-space:   nowrap;
  max-width:     48ch;
}

.dev-artifacts__state {
  padding:       0 var(--dev-space-3);
  border-radius: var(--r-md);
  font-size:     11px;
  background:    var(--default);
  color:         var(--muted);
}

.dev-artifacts__state--open   { background: var(--success-banner-bg); color: var(--success); }
.dev-artifacts__state--closed { background: var(--default); color: var(--muted); }

.dev-artifacts__meta {
  display:     flex;
  align-items: center;
  gap:         var(--dev-space-4);
  color:       var(--muted);
  font-size:   12px;
}

/* A subject with one source needs no rule above it; several read as a stack without one. */
.dev-artifacts__source + .dev-artifacts__source {
  margin-top:  var(--dev-space-4);
  padding-top: var(--dev-space-4);
  border-top:  1px solid var(--border);
}

.dev-artifacts__from {
  display:     flex;
  align-items: center;
  gap:         var(--dev-space-3);
  margin:      var(--dev-space-3) 0 var(--dev-space-2);
  flex-wrap:   wrap;
}

/* Which kind of source this is, said in the one place a person is deciding whether to trust that
   it is complete: work still arriving, or work that is over. */
.dev-artifacts__tag {
  padding:        0 var(--dev-space-2);
  border-radius: var(--dev-r-xs);
  font-size:      10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.dev-artifacts__tag--live { background: var(--success-banner-bg); color: var(--success); }
.dev-artifacts__tag--kept { background: var(--default); color: var(--muted); }

.dev-artifacts__when { color: var(--muted); font-size: 12px; }

.dev-artifacts__none { font-size: 12px; }
</style>
