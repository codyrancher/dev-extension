<script>
import { listPodEntries } from '../pod';
import {
  isWalkable, shared, childPath, parentPath, crumbs, humanSize,
} from '../fs-listing.mjs';
import PodFileViewer from './PodFileViewer';

/**
 * The disk, as it actually is.
 *
 * Nothing in here is composed for the page: every row is one entry of one real directory, read
 * with `find -printf` in a pod that has the node's own hostPath mounted, and the places worth
 * starting from are shortcuts to real paths rather than a tree of headings with directories
 * hung underneath them. Walk out of `/workspaces` into `/etc` and it keeps working, because
 * there is no model of "the interesting part" to walk out of.
 *
 * What it is for is the two kinds of sharing this node runs on, neither of which a list of
 * names can show:
 *
 *   - a SYMLINK, drawn with its target - `bin/gh -> /workspaces/.shared/tools/gh-2.76.1` - so
 *     the one install behind seven workspaces is visible as one install, and a link that
 *     resolves to nothing says so instead of looking like a file;
 *   - a HARDLINK, drawn as the number of names a file has. The daily sweep collapses identical
 *     files across workspaces into one inode, and after it runs the only evidence is a link
 *     count. It is shown for regular files alone: every directory has one above 1 and it means
 *     something else entirely there.
 *
 * Which pod: the agent's, by default, because that is the one with `/workspaces` - the node's
 * own disk, every workspace, every checkout and the kept artifacts. Point it at another pod and
 * it shows that pod's filesystem instead, which is a different real filesystem, not a view of
 * the same one. The header says which.
 */
export default {
  name: 'FileExplorer',

  components: { PodFileViewer },

  props: {
    /** The pod whose filesystem this is. Empty means the agent pod, which pod.ts defaults to. */
    pod:       { type: String, default: '' },
    container: { type: String, default: undefined },
    namespace: { type: String, default: undefined },
    /** Where to open. The root, so nothing is hidden behind a chosen starting point. */
    start:     { type: String, default: '/' },
  },

  emits: ['close'],

  data() {
    return {
      path:    this.start,
      entries: [],
      omitted: 0,
      total:   0,
      loading: true,
      error:   '',
      /** The file being looked at, when a row is clicked. */
      open:    '',
      /** Paths visited, so Back is a history rather than a parent walk. */
      history: [],
    };
  },

  computed: {
    target() {
      return {
        pod: this.pod, container: this.container, namespace: this.namespace,
      };
    },

    crumbs() {
      return crumbs(this.path);
    },

    /**
     * The places worth starting from, and every one of them a real path.
     *
     * Not a tree: these are shortcuts into the same filesystem the breadcrumb walks, so what
     * they open is what `cd` would open. A shortcut to somewhere this pod has not got is left
     * out by the listing itself - clicking it shows the error the filesystem gave.
     */
    places() {
      return [
        { label: 'Root', path: '/' },
        { label: 'Workspaces', path: '/workspaces' },
        { label: 'Artifacts', path: '/workspaces/.artifacts' },
        { label: 'Shared store', path: '/workspaces/.shared' },
        { label: 'Agent', path: '/workspace' },
      ];
    },
  },

  watch: {
    path: {
      immediate: true,
      handler() {
        this.read();
      },
    },
  },

  mounted() {
    this.onKey = (event) => {
      if (event.key === 'Escape' && !this.open) {
        this.$emit('close');
      }
    };
    window.addEventListener('keydown', this.onKey);
  },

  beforeUnmount() {
    window.removeEventListener('keydown', this.onKey);
  },

  methods: {
    humanSize,
    isWalkable,
    shared,

    async read() {
      this.loading = true;
      this.error = '';

      const asked = this.path;

      try {
        const listing = await listPodEntries(this.target, asked);

        // The directory may have changed under a slow read: only the answer to the question
        // being asked now is allowed to land.
        if (this.path !== asked) {
          return;
        }
        this.entries = listing.entries;
        this.omitted = listing.omitted;
        this.total = listing.total;
      } catch (e) {
        if (this.path !== asked) {
          return;
        }
        this.entries = [];
        this.omitted = 0;
        this.total = 0;
        this.error = String(e?.message || e);
      } finally {
        if (this.path === asked) {
          this.loading = false;
        }
      }
    },

    go(path) {
      if (path === this.path) {
        this.read();

        return;
      }
      this.history.push(this.path);
      this.path = path;
    },

    back() {
      const to = this.history.pop();

      if (to !== undefined) {
        this.path = to;
      }
    },

    up() {
      this.go(parentPath(this.path));
    },

    /** A directory is walked into; anything else is opened, which is a read of real bytes. */
    click(entry) {
      if (isWalkable(entry)) {
        this.go(childPath(this.path, entry.name));

        return;
      }
      if (entry.broken || entry.loop) {
        return;
      }
      this.open = childPath(this.path, entry.name);
    },

    icon(entry) {
      if (entry.kind === 'link') {
        return entry.broken || entry.loop ? 'icon-warning' : 'icon-external-link';
      }
      if (entry.kind === 'dir') {
        return 'icon-folder';
      }

      return entry.kind === 'file' ? 'icon-file' : 'icon-gear';
    },

    when(ms) {
      if (!ms) {
        return '';
      }
      const date = new Date(ms);

      return Number.isFinite(date.getTime()) ? date.toLocaleString() : '';
    },

    /** What a symlink row says after the arrow. A broken one says so where the size would be. */
    note(entry) {
      if (entry.loop) {
        return 'points at itself';
      }
      if (entry.broken) {
        return 'points at nothing';
      }

      return '';
    },
  },
};
</script>

<template>
  <div class="fs">
    <div class="fs__bar">
      <button
        type="button"
        class="btn role-tertiary btn-sm"
        :disabled="!history.length"
        title="Back"
        @click="back"
      >
        <i class="icon icon-chevron-left" />
      </button>
      <button
        type="button"
        class="btn role-tertiary btn-sm"
        :disabled="path === '/'"
        title="Up one directory"
        @click="up"
      >
        <i class="icon icon-chevron-up" />
      </button>
      <button
        type="button"
        class="btn role-tertiary btn-sm"
        title="Read this directory again"
        @click="read"
      >
        <i class="icon icon-refresh" />
      </button>

      <nav class="fs__crumbs">
        <template
          v-for="(crumb, i) in crumbs"
          :key="crumb.path"
        >
          <span
            v-if="i"
            class="fs__sep"
          >/</span>
          <button
            type="button"
            class="fs__crumb"
            :class="{ 'fs__crumb--here': crumb.path === path }"
            @click="go(crumb.path)"
          >{{ crumb.name }}</button>
        </template>
      </nav>
    </div>

    <div class="fs__places">
      <button
        v-for="place in places"
        :key="place.path"
        type="button"
        class="fs__place"
        :class="{ 'fs__place--here': place.path === path }"
        :title="place.path"
        @click="go(place.path)"
      >{{ place.label }}</button>
    </div>

    <div class="fs__body">
      <p
        v-if="loading"
        class="fs__note"
      >
        Reading {{ path }}…
      </p>
      <p
        v-else-if="error"
        class="fs__note fs__note--bad"
      >
        {{ error }}
      </p>
      <p
        v-else-if="!entries.length"
        class="fs__note"
      >
        This directory is empty.
      </p>

      <table
        v-else
        class="fs__table"
      >
        <thead>
          <tr>
            <th>Name</th>
            <th class="fs__num">
              Size
            </th>
            <th>Modified</th>
            <th>Inode</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="entry in entries"
            :key="entry.name"
            class="fs__row"
            :class="{ 'fs__row--dim': entry.broken || entry.loop }"
            @click="click(entry)"
          >
            <td class="fs__name">
              <i
                class="icon fs__icon"
                :class="[icon(entry), `fs__icon--${ entry.kind }`]"
              />
              <span class="fs__label">{{ entry.name }}</span>
              <span
                v-if="entry.kind === 'link'"
                class="fs__link"
              >→ {{ entry.target }}</span>
              <span
                v-if="note(entry)"
                class="fs__flag fs__flag--bad"
              >{{ note(entry) }}</span>
              <span
                v-else-if="shared(entry)"
                class="fs__flag"
                :title="`This file has ${ entry.links } names on this disk - the same inode, shared between workspaces. Writing through one writes through all of them.`"
              >{{ entry.links }} names</span>
            </td>
            <td class="fs__num">
              {{ entry.kind === 'dir' ? '' : humanSize(entry.size) }}
            </td>
            <td class="fs__when">
              {{ when(entry.mtime) }}
            </td>
            <td class="fs__ino">
              {{ entry.inode || '' }}
            </td>
          </tr>
        </tbody>
      </table>

      <p
        v-if="omitted"
        class="fs__note"
      >
        Showing {{ entries.length }} of {{ total }} entries; {{ omitted }} not listed.
      </p>
    </div>

    <PodFileViewer
      v-if="open"
      :pod="pod"
      :container="container"
      :namespace="namespace"
      :path="open"
      @close="open = ''"
    />
  </div>
</template>

<style lang="scss" scoped>
.fs {
  display: flex;
  flex-direction: column;
  gap: 8px;
  height: 100%;
  min-height: 0;
}

.fs__bar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.fs__crumbs {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px;
  min-width: 0;
  font-family: monospace;
  font-size: 13px;
}

.fs__sep {
  color: var(--muted);
}

.fs__crumb {
  background: none;
  border: none;
  padding: 1px 3px;
  color: var(--link);
  cursor: pointer;
  border-radius: var(--r-sm);

  &:hover {
    background: var(--accent-btn-hover);
  }

  &--here {
    color: var(--body-text);
    font-weight: 600;
  }
}

.fs__places {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.fs__place {
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--box-bg);
  color: var(--body-text);
  font-size: 12px;
  padding: 2px 8px;
  cursor: pointer;

  &:hover {
    background: var(--accent-btn-hover);
  }

  &--here {
    border-color: var(--primary);
    color: var(--primary);
  }
}

.fs__body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
}

.fs__note {
  margin: 0;
  padding: 10px 12px;
  color: var(--muted);
  font-size: 13px;

  &--bad {
    color: var(--error);
  }
}

.fs__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;

  th {
    position: sticky;
    top: 0;
    z-index: 1;
    text-align: left;
    padding: 6px 10px;
    background: var(--header-bg, var(--box-bg));
    border-bottom: 1px solid var(--border);
    color: var(--muted);
    font-weight: 600;
  }

  td {
    padding: 4px 10px;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }
}

.fs__row {
  cursor: pointer;

  &:hover {
    background: var(--accent-btn-hover);
  }

  &--dim {
    opacity: 0.65;
    cursor: default;
  }
}

.fs__name {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 6px;
  font-family: monospace;
  word-break: break-all;
}

.fs__icon {
  color: var(--muted);

  &--dir {
    color: var(--primary);
  }

  &--link {
    color: var(--warning);
  }
}

.fs__link {
  color: var(--muted);
  font-size: 12px;
}

.fs__flag {
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 0 5px;
  font-size: 11px;
  font-family: var(--font-family);
  color: var(--muted);

  &--bad {
    border-color: var(--error);
    color: var(--error);
  }
}

.fs__num {
  text-align: right;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.fs__when,
.fs__ino {
  white-space: nowrap;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
</style>
