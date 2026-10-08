<script>
// A piece of evidence, opened over the page: the same viewer the agents extension puts over a
// terminal when a path is clicked (PodFileViewer), fed from a URL rather than from a pod. The
// PR tab's attachments are served by the in-cluster API (reviews.ts, artifactUrl), so what is
// cloned here is the part that matters to a person: the modal, the zoom that lets a screenshot's
// small print be read, the recording that plays in place, and a plain word when the file is
// not there any more.
//
// Every kind of file has a preview, not only the two a browser draws: markdown as the page it
// is, HTML as a page that cannot run anything, source in its language's colours with its lines
// numbered, and a file that is none of those named and sized with a way to take it away. Text
// can also be edited here, when the caller says how it is saved.
import CodeMirror from '@shell/components/CodeMirror';
import { artifactKind, artifactLanguage, editorMode, isTextKind, looksBinary, sizeDisplay } from '../../artifact-kind';
import { highlight } from '../../highlight';
import { renderMarkdown } from '../../chat';

/** How much text is drawn. More than this is shown in part, and is not offered for editing. */
const TEXT_MAX = 400_000;

const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** SHA-256 as hex, or '' where the page is not allowed to hash (a plain-http origin). */
async function sha256(buffer) {
  try {
    const digest = await crypto.subtle.digest('SHA-256', buffer);

    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return '';
  }
}

export default {
  name: 'ArtifactViewer',

  components: { CodeMirror },

  props: {
    src:     { type: String, required: true },
    name:    { type: String, required: true },
    caption: { type: String, default: '' },
    /**
     * How an edit is written back: `(text, was) => Promise`, where `was` is the SHA-256 of the
     * bytes that were opened ('' to write whatever is there now). Without it the file is read
     * only - an attachment on GitHub has nowhere to be saved to. A rejection whose `code` is
     * `changed` means the file is no longer what was opened, and the person is asked.
     */
    save:    { type: Function, default: null },
  },

  emits: ['close', 'saved'],

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
      /** The first bytes said it is not text, whatever its name suggested. */
      binary:    false,
      /** What it was served as, for a name that does not say: an image on GitHub is often called `image`. */
      served:    '',
      /** Only part of the text is here, or it is not UTF-8: showing it is fine, saving it would not be. */
      partial:   false,
      /** The hash of the bytes as they were opened, or as they were last saved. */
      sha:       '',
      /** Markdown and HTML as what they render to, or as what was written. */
      mode:      'rendered',
      editing:   false,
      draft:     '',
      saving:    false,
      saveError: '',
      /** The file changed under the editor: the save waits for the person to say which wins. */
      conflict:  false,
      savedAt:   0,
    };
  },

  computed: {
    kind() {
      const named = artifactKind(this.name);

      if (isTextKind(named) && this.served) {
        return this.served;
      }

      return this.binary ? 'binary' : named;
    },
    isImage() {
      return this.kind === 'image';
    },
    isVideo() {
      return this.kind === 'video';
    },
    isAudio() {
      return this.kind === 'audio';
    },
    isPdf() {
      return this.kind === 'pdf';
    },
    isMedia() {
      return this.isImage || this.isVideo || this.isAudio || this.isPdf;
    },
    isText() {
      return isTextKind(this.kind);
    },
    /** Markdown and HTML are two things to look at - the page and its source. Nothing else is. */
    renderable() {
      return this.kind === 'markdown' || this.kind === 'html';
    },
    showPage() {
      return this.renderable && this.mode === 'rendered';
    },
    markdown() {
      return renderMarkdown(this.text);
    },
    code() {
      const language = artifactLanguage(this.name);

      return language ? highlight(this.text, language) : escape(this.text);
    },
    lineNumbers() {
      const lines = this.text.split('\n').length - (this.text.endsWith('\n') ? 1 : 0);

      return Array.from({ length: Math.max(1, lines) }, (_, i) => i + 1).join('\n');
    },
    canEdit() {
      return !!this.save && this.isText && !this.partial && !this.loading && !this.error;
    },
    dirty() {
      return this.editing && this.draft !== this.text;
    },
    editorOptions() {
      const save = () => this.commit();

      return {
        mode:        editorMode(this.name),
        lint:        false,
        extraKeys:   { 'Ctrl-S': save, 'Cmd-S': save },
        // Prose wraps; source keeps its lines, and scrolls.
        lineWrapping: this.kind === 'markdown' || this.kind === 'text',
      };
    },
    baseName() {
      return this.name.split('/').pop() || this.name;
    },
    sizeDisplay() {
      return sizeDisplay(this.size);
    },
    stageStyle() {
      return { transform: `translate(${ this.panX }px, ${ this.panY }px) scale(${ this.scale })` };
    },
  },

  mounted() {
    this.onKey = (event) => {
      if (event.key === 'Escape') {
        this.close();
      }
    };
    // Leaving the page with an edit unsaved is asked about, the way closing this is.
    this.onLeave = (event) => {
      if (this.dirty) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('beforeunload', this.onLeave);
    this.load();
  },

  beforeUnmount() {
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('beforeunload', this.onLeave);
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
        this.served = ['image', 'video', 'audio'].find((kind) => blob.type.startsWith(`${ kind }/`)) || (blob.type === 'application/pdf' ? 'pdf' : '');
        if (this.isMedia) {
          if (this.objectUrl) {
            URL.revokeObjectURL(this.objectUrl);
          }
          this.objectUrl = URL.createObjectURL(blob);

          return;
        }
        const buffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(buffer);

        this.binary = looksBinary(bytes);
        if (this.binary) {
          return;
        }
        let text;

        this.partial = false;
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
          // Not UTF-8. Readable with the odd character replaced; written back it would not be the same file.
          text = new TextDecoder('utf-8').decode(bytes);
          this.partial = true;
        }
        if (text.length > TEXT_MAX) {
          text = `${ text.slice(0, TEXT_MAX) }\n… (${ this.sizeDisplay }, shown in part)`;
          this.partial = true;
        }
        this.text = text;
        this.sha = this.partial ? '' : await sha256(buffer);
      } catch (e) {
        this.error = e.message || String(e);
      } finally {
        this.loading = false;
      }
    },

    edit() {
      this.draft = this.text;
      this.saveError = '';
      this.conflict = false;
      this.savedAt = 0;
      this.editing = true;
    },

    /** Out of the editor, back to the preview. Asked about first when there is something to lose. */
    stopEditing() {
      if (this.dirty && !window.confirm(`Discard your changes to ${ this.baseName }?`)) { // eslint-disable-line no-alert
        return;
      }
      this.editing = false;
      this.conflict = false;
      this.saveError = '';
    },

    /** Save the draft. `force` writes over whatever is there, after the person has said to. */
    async commit(force = false) {
      if (!this.editing || this.saving || (!this.dirty && !force)) {
        return;
      }
      const text = this.draft;

      this.saving = true;
      this.saveError = '';
      try {
        await this.save(text, force ? '' : this.sha);
        const bytes = new TextEncoder().encode(text);

        this.text = text;
        this.size = bytes.length;
        this.sha = await sha256(bytes.buffer);
        this.conflict = false;
        this.savedAt = Date.now();
        this.$emit('saved');
      } catch (e) {
        if (e?.code === 'changed') {
          this.conflict = true;
        } else {
          this.saveError = e?.message || String(e);
        }
      } finally {
        this.saving = false;
      }
    },

    /** The file changed underneath: take the workspace's version and drop the edit. */
    async reload() {
      this.editing = false;
      this.conflict = false;
      await this.load();
    },

    close() {
      if (this.dirty && !window.confirm(`Discard your changes to ${ this.baseName }?`)) { // eslint-disable-line no-alert
        return;
      }
      this.$emit('close');
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
        this.close();
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
    :aria-label="name"
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
        <template v-if="editing">
          <span
            v-if="saving"
            class="artifact-viewer__note"
          >Saving…</span>
          <span
            v-else-if="savedAt && !dirty"
            class="artifact-viewer__note artifact-viewer__note--ok"
          >Saved</span>
          <button
            type="button"
            class="artifact-viewer__btn artifact-viewer__btn--primary"
            :disabled="!dirty || saving"
            title="Save (Ctrl+S)"
            @click="commit()"
          >
            Save
          </button>
          <button
            type="button"
            class="artifact-viewer__btn"
            :disabled="saving"
            @click="stopEditing"
          >
            {{ dirty ? 'Discard' : 'Done' }}
          </button>
        </template>
        <template v-else>
          <span
            v-if="renderable && !loading && !error"
            class="artifact-viewer__modes"
            role="group"
            aria-label="How to show the file"
          >
            <button
              v-for="m in ['rendered', 'source']"
              :key="m"
              type="button"
              class="artifact-viewer__btn"
              :class="{ 'artifact-viewer__btn--on': mode === m }"
              :aria-pressed="mode === m"
              @click="mode = m"
            >
              {{ m === 'rendered' ? 'Rendered' : 'Source' }}
            </button>
          </span>
          <button
            v-if="isImage && scale !== 1"
            type="button"
            class="artifact-viewer__btn"
            @click="resetZoom"
          >
            Reset zoom
          </button>
          <button
            v-if="canEdit"
            type="button"
            class="artifact-viewer__btn"
            @click="edit"
          >
            <i
              class="icon icon-edit"
              aria-hidden="true"
            /> Edit
          </button>
          <a
            v-if="!error"
            :href="src"
            target="_blank"
            rel="noopener noreferrer"
            class="artifact-viewer__btn"
          >Open in a tab</a>
        </template>
        <button
          type="button"
          class="artifact-viewer__btn artifact-viewer__close"
          title="Close (Esc)"
          aria-label="Close"
          @click="close"
        >
          &times;
        </button>
      </header>
      <div
        v-if="editing && (conflict || saveError)"
        class="artifact-viewer__bar"
        role="alert"
      >
        <template v-if="conflict">
          <span>This file changed in the workspace after you opened it. Saving would replace what is there now.</span>
          <button
            type="button"
            class="artifact-viewer__btn"
            :disabled="saving"
            @click="commit(true)"
          >
            Save over it
          </button>
          <button
            type="button"
            class="artifact-viewer__btn"
            :disabled="saving"
            @click="reload"
          >
            Drop my changes and reload
          </button>
        </template>
        <span v-else>{{ saveError }}</span>
      </div>
      <div
        class="artifact-viewer__body artifact-code"
        :class="{
          'artifact-viewer__body--image': isImage,
          'artifact-viewer__body--drag': dragging,
          'artifact-viewer__body--text': !loading && !error && !isMedia,
        }"
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
        <div
          v-else-if="binary"
          class="artifact-viewer__state artifact-viewer__nopreview"
        >
          <i
            class="icon icon-file"
            aria-hidden="true"
          />
          <span>{{ baseName }} is not something that can be shown here{{ sizeDisplay ? ` (${ sizeDisplay })` : '' }}.</span>
          <a
            :href="src"
            :download="baseName"
            class="artifact-viewer__btn"
          >Download</a>
        </div>
        <div
          v-else-if="editing"
          class="artifact-viewer__editor"
        >
          <CodeMirror
            :value="draft"
            :options="editorOptions"
            @onInput="draft = $event"
            @onReady="$event.focus()"
          />
        </div>
        <div
          v-else-if="showPage && kind === 'markdown'"
          class="artifact-viewer__md"
          v-html="markdown"
        />
        <!--
          An agent's HTML, drawn but not run: the empty `sandbox` gives the frame an origin of
          its own with no scripts, no forms and no way to navigate this page.
        -->
        <iframe
          v-else-if="showPage"
          :srcdoc="text"
          sandbox=""
          class="artifact-viewer__html"
          :title="name"
        />
        <div
          v-else
          class="artifact-viewer__source"
        >
          <pre
            class="artifact-viewer__gutter"
            aria-hidden="true"
          >{{ lineNumbers }}</pre>
          <pre class="artifact-viewer__text"><code
            class="hljs"
            v-html="code"
          /></pre>
        </div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" src="../hljs-theme.scss"></style>

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

  /* Text of any kind fills the panel from its top-left, on the page's own background. */
  &__body--text {
    align-items:     stretch;
    justify-content: flex-start;
    background:      var(--body-bg);
  }

  /* Source: the gutter and the code scroll together, so a number stays beside its line. */
  &__source {
    display:     flex;
    align-items: flex-start;
    flex:        1 1 auto;
    min-width:   0;
    overflow:    auto;
    font-family: var(--font-family-mono, monospace);
    font-size:   12px;
    line-height: 1.5;
  }

  &__gutter,
  &__text {
    margin:      0;
    padding:     14px 0;
    border:      0;
    background:  transparent;
    font:        inherit;
    white-space: pre;
  }

  &__gutter {
    position:    sticky;
    left:        0;
    flex:        0 0 auto;
    padding:     14px 10px 14px 14px;
    border-right: 1px solid var(--border);
    background:  var(--body-bg);
    color:       var(--muted);
    text-align:  right;
    user-select: none;
  }

  &__text {
    flex:    1 0 auto;
    padding: 14px 18px;
    color:   var(--body-text);

    code {
      padding:    0;
      border:     0;
      background: transparent;
      font:       inherit;
    }
  }

  &__md {
    flex:        1 1 auto;
    min-width:   0;
    padding:     18px 28px 28px;
    overflow:    auto;
    font-size:   14px;
    line-height: 1.55;

    :deep(*) { max-width: 900px; }
    :deep(h1), :deep(h2), :deep(h3), :deep(h4), :deep(h5), :deep(h6) { margin: 18px 0 8px; line-height: 1.25; font-weight: 600; }
    :deep(h1) { font-size: 22px; } :deep(h2) { font-size: 19px; } :deep(h3) { font-size: 16px; } :deep(h4), :deep(h5), :deep(h6) { font-size: 14px; }
    :deep(h1:first-child), :deep(h2:first-child), :deep(h3:first-child) { margin-top: 0; }
    :deep(p) { margin: 0 0 10px; }
    :deep(ul), :deep(ol) { margin: 0 0 10px; padding-left: 22px; }
    :deep(li) { margin: 2px 0; }
    :deep(code) { font-size: 12px; background: var(--box-bg); padding: 1px 4px; border-radius: 3px; }
    :deep(pre) { background: var(--box-bg); border: 1px solid var(--border); border-radius: var(--border-radius); padding: 8px 10px; overflow-x: auto; }
    :deep(pre code) { display: block; background: transparent; padding: 0; border: 0; }
    :deep(table) { border-collapse: collapse; margin: 0 0 10px; }
    :deep(th), :deep(td) { border: 1px solid var(--border); padding: 4px 8px; }
    :deep(blockquote) { margin: 0 0 10px; padding-left: 10px; border-left: 3px solid var(--border); color: var(--muted); }
    :deep(hr) { border: 0; border-top: 1px solid var(--border); margin: 12px 0; }
  }

  &__html { flex: 1 1 auto; width: 100%; border: 0; background: #fff; }

  /*
   * The dashboard's own editor, made to fill the panel: it is built to sit in a form at the
   * height of its content, with a margin under it for a hint this has no room for.
   */
  &__editor {
    flex:      1 1 auto;
    min-width: 0;
    min-height: 0;

    :deep(.code-mirror) { height: 100%; margin: 0; }
    :deep(.code-mirror > div) { height: 100%; }
    :deep(.codemirror-container) { height: 100%; }
    :deep(.code-mirror .codemirror-container .CodeMirror) { height: 100%; font-size: 12px; }
    :deep(.escape-text) { display: none; }
  }

  &__modes {
    display: inline-flex;

    .artifact-viewer__btn { border-radius: 0; margin-left: -1px; }
    .artifact-viewer__btn:first-child { border-radius: 6px 0 0 6px; margin-left: 0; }
    .artifact-viewer__btn:last-child { border-radius: 0 6px 6px 0; }
  }

  &__btn--on { border-color: var(--link); color: var(--link); background: var(--box-bg); position: relative; }

  &__btn--primary {
    border-color: var(--primary);
    background:   var(--primary);
    color:        var(--primary-text);

    &:hover:not(:disabled) { border-color: var(--primary-hover-bg, var(--primary)); background: var(--primary-hover-bg, var(--primary)); color: var(--primary-text); }
  }

  &__btn:disabled { opacity: .5; cursor: default; }
  &__btn .icon { margin-right: 4px; font-size: 12px; }

  &__note {
    color: var(--muted);

    &--ok { color: var(--success); }
  }

  /* What went wrong with a save, between the head and the editor, with what can be done about it. */
  &__bar {
    display:       flex;
    align-items:   center;
    flex-wrap:     wrap;
    gap:           10px;
    padding:       8px 12px;
    border-bottom: 1px solid var(--border);
    background:    var(--box-bg);
    color:         var(--error);
    font-size:     12px;

    span { flex: 1 1 320px; }
  }

  &__nopreview {
    display:        flex;
    flex-direction: column;
    align-items:    center;
    gap:            12px;
    margin:         auto;

    > .icon { font-size: 40px; }
  }

  &__state {
    color:     var(--muted);
    font-size: 13px;

    &--error { color: var(--error); }
  }
}
</style>
