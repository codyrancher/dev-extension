<script>
// A workspace's artifacts directory, as the directory it is: every top-level directory an agent
// wrote into as a group of thumbnails, and the files that sit loose beside them as one more.
//
// Everything is here, and none of it is paid for until it is looked at. A group arrives with its
// newest few files and a count of the rest; a recording that left six thousand frames in
// `scratch/` is one row and a number, and the rest of it is read a page at a time when somebody
// asks. A thumbnail fetches nothing until it has been scrolled to (ArtifactThumb).
import ArtifactThumb from './pr/ArtifactThumb.vue';
import { artifactsIn, ago } from '../workspace-rail';
import { sizeDisplay } from '../artifact-kind';

/** How many files a group opens with: the directories this stage's work wrote, and the others. */
const LEAD = 12;
const REST = 6;
/** How many more each "show more" brings. */
const PAGE = 48;

export default {
  name: 'WorkspaceArtifacts',

  components: { ArtifactThumb },

  props: {
    workspace: { type: String, required: true },
    /** ArtifactGroup[] (workspace-rail.ts), already in the order they are drawn. */
    groups:    { type: Array, required: true },
    total:     { type: Number, default: 0 },
    /** There were more files than the listing will count. */
    truncated: { type: Boolean, default: false },
    /** The directories this stage is about, which open with more of themselves showing. */
    lead:      { type: Array, default: () => [] },
  },

  emits: ['open'],

  data() {
    return {
      /** Groups folded away, by directory. */
      shut:  {},
      /** Groups opened past what the listing carried: `{ files, count, at }` by directory. */
      more:  {},
      /** The directory being read, and what went wrong reading one. */
      busy:  '',
      error: '',
    };
  },

  watch: {
    /**
     * A group somebody opened up is read again when it changes - a file saved from the viewer,
     * a recording an agent just finished - so the longer list does not go stale beside the
     * short ones the page refreshes by itself.
     */
    groups(groups) {
      for (const g of groups) {
        const had = this.more[g.dir];

        if (had && (had.at !== g.at || had.count !== g.count)) {
          this.read(g, had.files.length, true);
        }
      }
    },

    workspace() {
      this.shut = {};
      this.more = {};
      this.error = '';
    },
  },

  methods: {
    ago,
    sizeDisplay,

    title(group) {
      return group.dir ? `${ group.dir }/` : 'artifacts/';
    },

    files(group) {
      return this.more[group.dir]?.files || group.files.slice(0, this.lead.includes(group.dir) || !group.dir ? LEAD : REST);
    },

    count(group) {
      return this.more[group.dir]?.count ?? group.count;
    },

    rest(group) {
      return Math.max(0, this.count(group) - this.files(group).length);
    },

    toggle(group) {
      this.shut = { ...this.shut, [group.dir]: !this.shut[group.dir] };
    },

    async read(group, limit, quiet = false) {
      if (!quiet) {
        this.busy = group.dir || '/';
        this.error = '';
      }
      try {
        const { files, count } = await artifactsIn(this.workspace, group.dir, limit);

        this.more = { ...this.more, [group.dir]: { files, count, at: group.at } };
      } catch (e) {
        if (!quiet) {
          this.error = e?.message || String(e);
        }
      } finally {
        if (!quiet) {
          this.busy = '';
        }
      }
    },

    showMore(group) {
      return this.read(group, this.files(group).length + PAGE);
    },

    showFewer(group) {
      const more = { ...this.more };

      delete more[group.dir];
      this.more = more;
    },

    open(file) {
      this.$emit('open', {
        src: file.url, name: file.path, caption: this.ago(file.at), path: file.path,
      });
    },
  },
};
</script>

<template>
  <div class="workspace-artifacts">
    <p
      v-if="truncated"
      class="workspace-artifacts__note"
    >
      There are more files here than are counted; the directories below show the newest of what was.
    </p>
    <p
      v-if="error"
      class="workspace-artifacts__note workspace-artifacts__note--error"
      role="alert"
    >
      {{ error }}
    </p>
    <section
      v-for="group in groups"
      :key="group.dir"
      class="workspace-artifacts__group"
    >
      <h5 class="workspace-artifacts__head">
        <button
          type="button"
          class="workspace-artifacts__fold"
          :aria-expanded="!shut[group.dir]"
          :title="shut[group.dir] ? 'Show this directory' : 'Fold this directory away'"
          @click="toggle(group)"
        >
          <i
            class="icon"
            :class="shut[group.dir] ? 'icon-chevron-right' : 'icon-chevron-down'"
            aria-hidden="true"
          /><i
            class="icon icon-folder"
            aria-hidden="true"
          /><code>{{ title(group) }}</code>
        </button>
        <span class="workspace-artifacts__meta">{{ count(group) }} file{{ count(group) === 1 ? '' : 's' }}<template v-if="group.size"> · {{ sizeDisplay(group.size) }}</template> · {{ ago(group.at) }}</span>
      </h5>
      <template v-if="!shut[group.dir]">
        <ul class="workspace-artifacts__grid">
          <li
            v-for="file in files(group)"
            :key="file.path"
            class="workspace-artifacts__item"
          >
            <!--
              Thumbnails, not the files themselves. A report with eight screenshots in it is a
              page of screenshots you scroll past to read the report; at this size the set is
              legible at a glance and any one of them opens in the viewer, which is where a
              screenshot is read, a recording played and a script edited.
            -->
            <button
              type="button"
              class="workspace-artifacts__thumb"
              :title="`${ file.path }${ file.size ? ` · ${ sizeDisplay(file.size) }` : '' } · open`"
              @click="open(file)"
            >
              <ArtifactThumb
                :url="file.url"
                :name="file.path"
                :type="file.type"
                :size="file.size"
                :stamp="file.at"
              />
            </button>
            <span
              class="workspace-artifacts__name"
              :title="file.label"
            >{{ file.label }}</span>
            <span class="workspace-artifacts__when">{{ ago(file.at) }}</span>
          </li>
        </ul>
        <div
          v-if="rest(group) || more[group.dir]"
          class="workspace-artifacts__pages"
        >
          <button
            v-if="rest(group)"
            type="button"
            class="workspace-artifacts__page"
            :disabled="busy === (group.dir || '/')"
            @click="showMore(group)"
          >
            {{ busy === (group.dir || '/') ? 'Reading…' : rest(group) > 48 ? `Show 48 more of ${ rest(group) }` : `Show the other ${ rest(group) }` }}
          </button>
          <button
            v-if="more[group.dir]"
            type="button"
            class="workspace-artifacts__page"
            @click="showFewer(group)"
          >
            Show fewer
          </button>
        </div>
      </template>
    </section>
  </div>
</template>

<style lang="scss" scoped>
.workspace-artifacts {
  display:        flex;
  flex-direction: column;
  gap:            14px;

  &__note {
    margin:    0;
    color:     var(--muted);
    font-size: 12px;

    &--error { color: var(--error); }
  }

  &__head {
    display:     flex;
    align-items: baseline;
    flex-wrap:   wrap;
    gap:         4px 10px;
    margin:      0 0 8px;
    font-size:   13px;
    font-weight: 400;
  }

  &__fold {
    display:     inline-flex;
    align-items: center;
    gap:         6px;
    min-height:  0;
    padding:     0;
    border:      0;
    background:  transparent;
    color:       inherit;
    font:        inherit;
    line-height: 1.4;
    cursor:      pointer;

    .icon {
      font-size: 10px;
      color:     var(--muted);
    }

    .icon-folder { font-size: 13px; }

    code {
      padding:     0;
      border:      0;
      background:  transparent;
      color:       inherit;
      font-size:   12px;
      font-weight: 600;
    }

    &:hover .icon { color: var(--link); }
  }

  &__meta {
    color:     var(--muted);
    font-size: 12px;
  }

  /* As many across as fit, each a fixed shape, so a set of screenshots is rows rather than a column. */
  &__grid {
    display:               grid;
    grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
    gap:                   12px 10px;
    margin:                0;
    padding:               0;
    list-style:            none;
  }

  &__item {
    display:        flex;
    flex-direction: column;
    min-width:      0;
    font-size:      12px;
    line-height:    1.35;
  }

  &__thumb {
    display:       block;
    width:         100%;
    aspect-ratio:  148 / 96;
    min-height:    0;
    margin:        0 0 4px;
    padding:       0;
    border:        1px solid var(--border);
    border-radius: var(--border-radius);
    background:    var(--box-bg);
    overflow:      hidden;
    cursor:        zoom-in;

    &:hover { border-color: var(--link); }
    &:focus-visible { outline: 2px solid var(--link); outline-offset: 1px; }
  }

  /*
   * A name is one unbroken token - `0004-checks-after-the-fix.png` - so it breaks wherever it
   * has to, and gets a second line before it is cut: the end of a name is the half that says
   * which shot it is.
   */
  &__name {
    display:            -webkit-box;
    overflow:           hidden;
    overflow-wrap:      anywhere;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
  }

  &__when { color: var(--muted); }

  &__pages {
    display:    flex;
    gap:        8px;
    margin-top: 8px;
  }

  &__page {
    min-height:    0;
    height:        26px;
    padding:       0 10px;
    border:        1px solid var(--border);
    border-radius: 6px;
    background:    transparent;
    color:         var(--body-text);
    font-size:     12px;
    line-height:   24px;
    cursor:        pointer;

    &:hover:not(:disabled) { border-color: var(--link); color: var(--link); }
    &:disabled { opacity: .6; cursor: default; }
  }
}
</style>
