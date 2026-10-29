<script>
// Evidence attached to something waiting to be sent: the screenshot or the recording an agent
// produced while checking its own claim.
//
// The files live in the workspace and are served through the in-cluster API - they are not on
// GitHub or Jira until the thing they belong to is sent, and deliberately so.
//
// Two callers, and the difference between them is one line. A pending review comment's evidence
// is found from the PR number and the path (`artifactUrl`); a Jira proposal's arrives with the
// URL already on it, because the recommendation route resolves it against that bug's workspace.
// So an attachment may carry its own `url`, and `pr` is only needed by the half that does not.
import { artifactUrl, devApiUrl } from '../../reviews';
import ArtifactViewer from './ArtifactViewer.vue';

export default {
  name: 'CommentAttachments',

  components: { ArtifactViewer },

  emits: ['remove'],

  props: {
    /** The pull request, for evidence that is found from one. Not needed when `url` is carried. */
    pr: {
      type:    Number,
      default: 0,
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

    /**
     * What the trailing word on each row says will happen to it.
     *
     * A review comment's evidence is inlined or named when the review is submitted; a Jira
     * proposal's is uploaded to the ticket when Apply is pressed. Same rows, different promise,
     * and a row that made the wrong one would be the worst kind of wrong here.
     */
    hint: {
      type:    String,
      default: '',
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
    /** Where the bytes are: the one the caller resolved, else the PR's artifact route. */
    url(a) {
      if (a.url) {
        return devApiUrl(a.url);
      }

      return a.found && this.pr ? artifactUrl(this.pr, a.path) : '';
    },

    /** Whether there is anything to open. `found` is the PR side's word for it; a url is the other's. */
    there(a) {
      return !!this.url(a);
    },

    /** What this row says happens to it, from the caller, else the review's own wording. */
    says(a) {
      return this.hint || (a.kind === 'file' ? 'inlined on submit' : 'named on submit');
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
        :disabled="!there(a)"
        @click="toggle(a.path)"
      >
        <img
          v-if="a.kind === 'image' && there(a)"
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
        :disabled="!there(a)"
        @click="toggle(a.path)"
      >
        <span class="cattach__name">{{ a.name }}</span>
        <span
          v-if="a.caption"
          class="cattach__caption"
        >{{ a.caption }}</span>
        <span
          v-if="!there(a)"
          class="cattach__missing"
        >not found in the workspace</span>
      </button>
      <span class="cattach__hint">{{ says(a) }}</span>
      <button
        v-if="removable"
        type="button"
        class="cattach__remove"
        :title="`Remove this attachment (the file stays in the workspace)`"
        aria-label="Remove attachment"
        @click.stop="remove(a.path)"
      >
        ×
      </button>
    </div>

    <!-- Opened over the page, in the viewer the agents' terminals use for a clicked path. -->
    <Teleport to="body">
      <ArtifactViewer
        v-if="opened"
        :src="url(opened)"
        :name="opened.name"
        :caption="opened.caption || ''"
        @close="open = null"
      />
    </Teleport>
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
      border-radius: var(--r-sm);
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
      border-radius: var(--dev-r-ctl);
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
        border-radius: var(--r-sm);
        border:        1px solid var(--pr-border);
        background:    var(--pr-bg);
      }

      iframe { width: 100%; height: 240px; }
    }
  }
</style>
