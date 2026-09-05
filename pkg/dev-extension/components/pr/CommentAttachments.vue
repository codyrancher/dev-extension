<script>
// Evidence attached to a pending review comment: the screenshot or the recording the agent
// produced while checking its own claim.
//
// The files live in the Studio agent's workspace and are served through the in-cluster API
// (see reviews.ts, artifactUrl) - they are NOT on GitHub, and deliberately so. A text file is
// inlined into the comment when the review is submitted; an image or a recording is named
// there, since uploading one needs a github.com session this dashboard does not have.
import { artifactUrl } from '../../reviews';

export default {
  name: 'CommentAttachments',

  emits: ['remove'],

  props: {
    pr: {
      type:     Number,
      required: true,
    },
    attachments: {
      type:    Array,
      default: () => [],
    },
    /** For a comment that has not been submitted: what the agent attached is worth overriding. */
    removable: {
      type:    Boolean,
      default: false,
    },
  },

  data() {
    return { open: null };
  },

  computed: {
    opened() {
      return this.attachments.find((a) => a.path === this.open) || null;
    },
  },

  methods: {
    url(a) {
      return a.found ? artifactUrl(this.pr, a.path) : '';
    },

    toggle(path) {
      this.open = this.open === path ? null : path;
    },

    remove(path) {
      if (this.open === path) {
        this.open = null;
      }
      this.$emit('remove', path);
    },
  },
};
</script>

<template>
  <div
    v-if="attachments.length"
    class="cattach"
  >
    <div
      v-for="a in attachments"
      :key="a.path"
      class="cattach__row"
    >
      <button
        type="button"
        class="cattach__thumb"
        :title="a.path"
        :disabled="!a.found"
        @click="toggle(a.path)"
      >
        <img
          v-if="a.kind === 'image' && a.found"
          :src="url(a)"
          :alt="a.name"
          loading="lazy"
        >
        <span
          v-else
          class="cattach__icon"
        >{{ a.kind === 'video' ? '▶' : '◧' }}</span>
      </button>
      <button
        type="button"
        class="cattach__meta"
        :disabled="!a.found"
        @click="toggle(a.path)"
      >
        <span class="cattach__name">{{ a.name }}</span>
        <span
          v-if="a.caption"
          class="cattach__caption"
        >{{ a.caption }}</span>
        <span
          v-if="!a.found"
          class="cattach__missing"
        >not found in the agent's workspace</span>
      </button>
      <span class="cattach__hint">{{ a.kind === 'file' ? 'inlined on submit' : 'named on submit' }}</span>
      <button
        v-if="removable"
        type="button"
        class="cattach__remove"
        title="Remove this attachment from the comment (the file stays in the workspace)"
        aria-label="Remove attachment"
        @click.stop="remove(a.path)"
      >
        ×
      </button>
    </div>

    <div
      v-if="opened"
      class="cattach__preview"
    >
      <video
        v-if="opened.kind === 'video'"
        :src="url(opened)"
        controls
        preload="metadata"
      />
      <img
        v-else-if="opened.kind === 'image'"
        :src="url(opened)"
        :alt="opened.name"
      >
      <iframe
        v-else
        :src="url(opened)"
        :title="opened.name"
        class="cattach__text"
      />
    </div>
  </div>
</template>

<style lang="scss" scoped>
  .cattach {
    display:        flex;
    flex-direction: column;
    gap:            var(--dev-space-2);
    margin-top:     var(--dev-space-3);

    &__row {
      display:     flex;
      align-items: center;
      gap:         var(--dev-space-3);
      font-size:   12px;
    }

    &__thumb {
      width:         56px;
      height:        34px;
      flex-shrink:   0;
      padding:       0;
      border:        1px solid var(--pr-border);
      border-radius: var(--border-radius);
      background:    var(--pr-bg);
      color:         var(--pr-muted);
      cursor:        pointer;
      overflow:      hidden;

      img { width: 100%; height: 100%; object-fit: cover; display: block; }
      &:hover:not(:disabled) { border-color: var(--pr-accent); }
      &:disabled { cursor: default; opacity: 0.5; }
    }

    &__icon { font-size: 12px; }

    &__meta {
      flex:           1;
      min-width:      0;
      display:        flex;
      flex-direction: column;
      align-items:    flex-start;
      gap:            var(--dev-space-1);
      padding:        0;
      border:         none;
      background:     none;
      font-family:    inherit;
      font-size:      inherit;
      color:          inherit;
      text-align:     left;
      cursor:         pointer;

      &:disabled { cursor: default; }
    }

    &__name {
      color:         var(--pr-text);
      font-family:   monospace;
      overflow:      hidden;
      text-overflow: ellipsis;
      white-space:   nowrap;
      max-width:     100%;
    }

    &__caption { color: var(--pr-muted); }
    &__missing { color: var(--pr-error); }

    &__hint {
      flex-shrink: 0;
      color:       var(--pr-muted);
      font-size:   11px;
    }

    &__remove {
      flex:          none;
      width:         22px;
      height:        22px;
      padding:       0;
      border:        1px solid transparent;
      border-radius: var(--border-radius);
      background:    transparent;
      color:         var(--pr-muted);
      font-size:     13px;
      line-height:   1;
      cursor:        pointer;

      &:hover { border-color: var(--pr-error); color: var(--pr-error); background: var(--pr-bg-2); }
    }

    &__preview {
      video, img, iframe {
        max-width:     100%;
        max-height:    360px;
        border-radius: var(--border-radius);
        border:        1px solid var(--pr-border);
        background:    var(--pr-bg);
      }

      iframe { width: 100%; height: 240px; }
    }
  }
</style>
