<script>
// A piece of evidence, opened over the page: the same viewer the agents extension puts over a
// terminal when a path is clicked (PodFileViewer), fed from a URL rather than from a pod. The
// PR tab's attachments are served by the in-cluster API (reviews.ts, artifactUrl), so what is
// cloned here is the part that matters to a person: the modal, the zoom that lets a screenshot's
// small print be read, the recording that plays in place, and a plain word when the file is
// not there any more.
const IMAGE = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'];
const VIDEO = ['mp4', 'webm', 'mov', 'mkv'];
const AUDIO = ['mp3', 'wav', 'ogg', 'm4a', 'flac'];
const TEXT_MAX = 400_000;

export default {
  name: 'ArtifactViewer',

  props: {
    src:     { type: String, required: true },
    name:    { type: String, required: true },
    caption: { type: String, default: '' },
  },

  emits: ['close'],

  data() {
    return {
      loading:   true,
      error:     '',
      objectUrl: '',
      text:      '',
      size:      0,
      scale:     1,
      panX:      0,
      panY:      0,
      dragging:  false,
      dragX:     0,
      dragY:     0,
    };
  },

  computed: {
    extension() {
      return (this.name.split('.').pop() || '').toLowerCase();
    },
    isImage() {
      return IMAGE.includes(this.extension);
    },
    isVideo() {
      return VIDEO.includes(this.extension);
    },
    isAudio() {
      return AUDIO.includes(this.extension);
    },
    isPdf() {
      return this.extension === 'pdf';
    },
    isMedia() {
      return this.isImage || this.isVideo || this.isAudio || this.isPdf;
    },
    sizeDisplay() {
      if (!this.size) {
        return '';
      }
      if (this.size < 1024) {
        return `${ this.size } B`;
      }

      return this.size < 1024 * 1024 ? `${ Math.round(this.size / 1024) } KB` : `${ (this.size / 1024 / 1024).toFixed(1) } MB`;
    },
    stageStyle() {
      return { transform: `translate(${ this.panX }px, ${ this.panY }px) scale(${ this.scale })` };
    },
  },

  mounted() {
    this.onKey = (event) => {
      if (event.key === 'Escape') {
        this.$emit('close');
      }
    };
    window.addEventListener('keydown', this.onKey);
    this.load();
  },

  beforeUnmount() {
    window.removeEventListener('keydown', this.onKey);
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
    }
  },

  methods: {
    async load() {
      this.loading = true;
      this.error = '';
      try {
        const response = await fetch(this.src, { credentials: 'same-origin', cache: 'no-store' });

        if (response.status === 404) {
          throw new Error('This file is not in the workspace (any more).');
        }
        if (!response.ok) {
          throw new Error(`The file could not be read (${ response.status }).`);
        }
        const blob = await response.blob();

        this.size = blob.size;
        if (this.isMedia) {
          this.objectUrl = URL.createObjectURL(blob);
        } else {
          const text = await blob.text();

          this.text = text.length > TEXT_MAX ? `${ text.slice(0, TEXT_MAX) }\n… (${ this.sizeDisplay }, shown in part)` : text;
        }
      } catch (e) {
        this.error = e.message || String(e);
      } finally {
        this.loading = false;
      }
    },

    // The image zooms about the pointer and pans by dragging: a screenshot of a whole dashboard
    // is opened to read one corner of it.
    onWheel(event) {
      if (!this.isImage) {
        return;
      }
      event.preventDefault();
      const next = Math.min(8, Math.max(0.5, this.scale * (event.deltaY < 0 ? 1.15 : 1 / 1.15)));

      this.scale = next;
    },

    onDown(event) {
      if (!this.isImage || this.scale <= 1) {
        return;
      }
      this.dragging = true;
      this.dragX = event.clientX - this.panX;
      this.dragY = event.clientY - this.panY;
    },

    onMove(event) {
      if (!this.dragging) {
        return;
      }
      this.panX = event.clientX - this.dragX;
      this.panY = event.clientY - this.dragY;
    },

    onUp() {
      this.dragging = false;
    },

    resetZoom() {
      this.scale = 1;
      this.panX = 0;
      this.panY = 0;
    },

    onBackdrop(event) {
      if (event.target === event.currentTarget) {
        this.$emit('close');
      }
    },
  },
};
</script>

<template>
  <div
    class="artifact-viewer"
    role="dialog"
    aria-modal="true"
    @click="onBackdrop"
  >
    <div class="artifact-viewer__panel">
      <header class="artifact-viewer__head">
        <span class="artifact-viewer__name">{{ name }}</span>
        <span
          v-if="caption"
          class="artifact-viewer__caption"
        >{{ caption }}</span>
        <span
          v-if="sizeDisplay"
          class="artifact-viewer__size"
        >{{ sizeDisplay }}</span>
        <button
          v-if="isImage && scale !== 1"
          type="button"
          class="artifact-viewer__btn"
          @click="resetZoom"
        >
          Reset zoom
        </button>
        <a
          v-if="!error"
          :href="src"
          target="_blank"
          rel="noopener noreferrer"
          class="artifact-viewer__btn"
        >Open in a tab</a>
        <button
          type="button"
          class="artifact-viewer__btn artifact-viewer__close"
          title="Close (Esc)"
          @click="$emit('close')"
        >
          &times;
        </button>
      </header>
      <div
        class="artifact-viewer__body"
        :class="{ 'artifact-viewer__body--image': isImage, 'artifact-viewer__body--drag': dragging }"
        @wheel="onWheel"
        @mousedown="onDown"
        @mousemove="onMove"
        @mouseup="onUp"
        @mouseleave="onUp"
      >
        <div
          v-if="loading"
          class="artifact-viewer__state"
        >
          <i class="icon icon-spinner icon-spin" /> Loading
        </div>
        <div
          v-else-if="error"
          class="artifact-viewer__state artifact-viewer__state--error"
        >
          {{ error }}
        </div>
        <img
          v-else-if="isImage"
          :src="objectUrl"
          :alt="name"
          class="artifact-viewer__image"
          :style="stageStyle"
          draggable="false"
        >
        <video
          v-else-if="isVideo"
          :src="objectUrl"
          class="artifact-viewer__video"
          controls
          autoplay
        />
        <audio
          v-else-if="isAudio"
          :src="objectUrl"
          controls
        />
        <iframe
          v-else-if="isPdf"
          :src="objectUrl"
          class="artifact-viewer__pdf"
          title="PDF"
        />
        <pre
          v-else
          class="artifact-viewer__text"
        >{{ text }}</pre>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.artifact-viewer {
  position:        fixed;
  inset:           0;
  z-index:         3000;
  background:      rgba(0, 0, 0, 0.62);
  display:         flex;
  align-items:     center;
  justify-content: center;
  padding:         24px;

  &__panel {
    width:          min(1400px, 96vw);
    height:         min(900px, 92vh);
    display:        flex;
    flex-direction: column;
    background:     var(--body-bg);
    color:          var(--body-text);
    border:         1px solid var(--border);
    border-radius:  10px;
    box-shadow:     0 12px 40px rgba(0, 0, 0, 0.45);
    overflow:       hidden;
  }

  &__head {
    display:       flex;
    align-items:   center;
    gap:           10px;
    padding:       8px 12px;
    border-bottom: 1px solid var(--border);
    font-size:     12px;
  }

  &__name { font-family: monospace; font-weight: 600; }
  &__caption { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  &__size { color: var(--muted); margin-left: auto; }

  &__btn {
    min-height:      0;
    height:          26px;
    padding:         0 10px;
    border-radius:   6px;
    border:          1px solid var(--border);
    background:      transparent;
    color:           var(--body-text);
    font-size:       12px;
    line-height:     24px;
    text-decoration: none;
    cursor:          pointer;

    &:hover { border-color: var(--link); color: var(--link); }
  }

  &__close { font-size: 18px; padding: 0 8px; }

  &__body {
    flex:            1 1 auto;
    min-height:      0;
    overflow:        auto;
    display:         flex;
    align-items:     center;
    justify-content: center;
    background:      #111;

    &--image { overflow: hidden; cursor: zoom-in; }
    &--drag { cursor: grabbing; }
  }

  &__image {
    max-width:        100%;
    max-height:       100%;
    transform-origin: center center;
    transition:       transform 0.05s linear;
    user-select:      none;
  }

  &__video { max-width: 100%; max-height: 100%; }
  &__pdf { width: 100%; height: 100%; border: 0; background: #fff; }

  &__text {
    align-self:  stretch;
    width:       100%;
    margin:      0;
    padding:     14px 18px;
    font-size:   12px;
    color:       var(--body-text);
    background:  var(--body-bg);
    white-space: pre-wrap;
    word-break:  break-word;
    overflow:    auto;
  }

  &__state {
    color:     var(--muted);
    font-size: 13px;

    &--error { color: var(--error); }
  }
}
</style>
