<script>
// One artifact, small: what a file in a workspace's artifacts looks like in a list before it is
// opened. Every kind of file gets a picture of itself rather than only the two a browser draws
// unasked - a screenshot is the screenshot and a recording is a frame of it, but a script is its
// first lines in its language's colours, a markdown file is the top of the page it renders to,
// and what cannot be drawn at all (a font, an archive) says what it is and how large.
import { artifactKind, artifactLanguage, artifactBadge, isTextKind, looksBinary, sizeDisplay } from '../../artifact-kind';
import { highlight } from '../../highlight';
import { renderMarkdown } from '../../chat';

/** How much of a text file a thumbnail reads: more than it can show, and no more than that. */
const HEAD_BYTES = 2048;
/**
 * How often a tile that would not load is tried again, a few seconds apart. The in-cluster API
 * restarts for about a minute after every release, and a page opened in that minute would
 * otherwise keep a wall of blank tiles until somebody reloaded it.
 */
const RETRIES = 4;
const RETRY_MS = 4000;

const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export default {
  name: 'ArtifactThumb',

  props: {
    url:  { type: String, required: true },
    name: { type: String, required: true },
    /** What the caller already knows it to be; worked out from the name when it does not say. */
    type: { type: String, default: '' },
    size: { type: Number, default: 0 },
    /** When the file was last written. A text thumbnail is read again when this moves. */
    stamp: { type: String, default: '' },
  },

  data() {
    return {
      /** Whether it has been on screen yet: nothing is fetched for a tile nobody has scrolled to. */
      seen:    false,
      head:    '',
      /** The first bytes said it is not text, whatever its name suggested. */
      binary:  false,
      /** The picture would not load: drawn as a file rather than as a broken image. */
      broken:  false,
      /** How many times it has been asked for again. Part of the address, so the browser really asks. */
      tries:   0,
    };
  },

  computed: {
    kind() {
      return this.binary ? 'binary' : (this.type || artifactKind(this.name));
    },
    isText() {
      return isTextKind(this.kind);
    },
    badge() {
      return artifactBadge(this.name);
    },
    sizeText() {
      return sizeDisplay(this.size);
    },
    src() {
      return this.tries ? `${ this.url }${ this.url.includes('?') ? '&' : '?' }retry=${ this.tries }` : this.url;
    },
    /** A recording's still: the fragment makes the browser paint a frame instead of nothing. */
    frame() {
      return this.src.includes('#') ? this.src : `${ this.src }#t=0.1`;
    },
    page() {
      if (this.kind === 'markdown') {
        return renderMarkdown(this.head);
      }
      const language = artifactLanguage(this.name);

      return language ? highlight(this.head, language) : escape(this.head);
    },
  },

  watch: {
    stamp() {
      if (this.seen && this.isText) {
        this.read();
      }
    },
  },

  mounted() {
    if (typeof IntersectionObserver === 'undefined') {
      this.show();

      return;
    }
    this.observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        this.show();
      }
    }, { rootMargin: '300px' });
    this.observer.observe(this.$el);
  },

  beforeUnmount() {
    this.observer?.disconnect();
    clearTimeout(this.retryTimer);
  },

  methods: {
    /**
     * It did not load. Drawn as a plain tile meanwhile, and asked for again shortly, a few
     * times; `after` is what asking again means for this kind of tile.
     */
    failed(after) {
      this.broken = true;
      if (this.tries >= RETRIES) {
        return;
      }
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => {
        this.tries++;
        this.broken = false;
        after?.();
      }, RETRY_MS * (this.tries + 1));
    },

    show() {
      this.observer?.disconnect();
      this.seen = true;
      if (this.isText) {
        this.read();
      }
    },

    /**
     * The top of a text file. A range is asked for, and the read stops at the same length
     * whether or not it was honoured: an in-cluster API from before it knew about ranges
     * answers with the whole log, and the rest of that is not waited for.
     */
    async read() {
      try {
        const response = await fetch(this.url, {
          credentials: 'same-origin', cache: 'no-store', headers: { Range: `bytes=0-${ HEAD_BYTES - 1 }` }
        });

        if (!response.ok || !response.body) {
          // Gone is gone; anything else is the API being away for a moment.
          if (response.status !== 404) {
            this.failed(() => this.read());
          }

          return;
        }
        this.broken = false;
        const reader = response.body.getReader();
        const bytes = new Uint8Array(HEAD_BYTES);
        let have = 0;

        while (have < HEAD_BYTES) {
          const { done, value } = await reader.read();

          if (done) {
            break;
          }
          const take = value.subarray(0, HEAD_BYTES - have);

          bytes.set(take, have);
          have += take.length;
        }
        reader.cancel().catch(() => { /* already finished */ });
        const got = bytes.subarray(0, have);

        if (looksBinary(got)) {
          this.binary = true;

          return;
        }
        this.head = new TextDecoder('utf-8').decode(got).replace(/\r/g, '');
      } catch {
        // A tile that could not be read stays a tile with a name on it, and is tried again.
        this.failed(() => this.read());
      }
    },

    /**
     * Past the opening frame, which in a recording of a dashboard is the page before it has
     * painted: a quarter of the way in, three seconds at most. See MediaViewer's `still`.
     */
    still(event) {
      const video = event.target;

      if (Number.isFinite(video.duration) && video.duration > 0) {
        video.currentTime = Math.min(3, video.duration / 4);
      }
    },
  },
};
</script>

<template>
  <span
    class="artifact-thumb artifact-code"
    :class="`artifact-thumb--${ kind }`"
  >
    <img
      v-if="kind === 'image' && !broken"
      :src="src"
      :alt="name"
      loading="lazy"
      @error="failed()"
    >
    <video
      v-else-if="kind === 'video' && seen && !broken"
      :src="frame"
      preload="metadata"
      muted
      playsinline
      @loadedmetadata="still"
      @error="failed()"
    />
    <span
      v-else-if="isText && head"
      class="artifact-thumb__page"
    >
      <span
        v-if="kind === 'markdown'"
        class="artifact-thumb__md"
        v-html="page"
      />
      <code
        v-else
        class="artifact-thumb__code hljs"
        v-html="page"
      />
    </span>
    <span
      v-else-if="kind === 'audio'"
      class="artifact-thumb__glyph"
    >
      <span
        class="artifact-thumb__wave"
        aria-hidden="true"
      ><i
        v-for="n in 13"
        :key="n"
        :style="{ height: `${ 20 + ((n * 37) % 61) }%` }"
      /></span>
    </span>
    <span
      v-else
      class="artifact-thumb__glyph"
    >
      <i
        class="icon icon-file artifact-thumb__icon"
        aria-hidden="true"
      />
      <span
        v-if="sizeText"
        class="artifact-thumb__size"
      >{{ sizeText }}</span>
    </span>
    <span
      v-if="kind === 'video'"
      class="artifact-thumb__badge artifact-thumb__badge--play"
      aria-hidden="true"
    >▶</span>
    <span
      v-else-if="kind !== 'image' || broken"
      class="artifact-thumb__badge"
    >{{ badge }}</span>
  </span>
</template>

<style lang="scss" src="../hljs-theme.scss"></style>

<style lang="scss" scoped>
/*
 * Spans throughout, and `display` set on each: this is drawn inside the button that opens the
 * file, and a button holds phrasing content only.
 */
.artifact-thumb {
  position:   relative;
  display:    block;
  width:      100%;
  height:     100%;
  overflow:   hidden;
  background: var(--box-bg);
  color:      var(--body-text);
  text-align: left;

  img,
  video {
    display:    block;
    width:      100%;
    height:     100%;
    object-fit: cover;
    background: #000;
  }

  /*
   * A page, at half size: laid out at twice the tile and scaled down, so the type keeps its
   * proportions and a line of source is still a line rather than a ragged wrap of six words.
   */
  &__page {
    position:         absolute;
    inset:            0 auto auto 0;
    display:          block;
    width:            200%;
    height:           200%;
    padding:          10px 12px;
    overflow:         hidden;
    transform:        scale(.5);
    transform-origin: 0 0;
    background:       var(--body-bg);
    pointer-events:   none;
  }

  &__code {
    display:     block;
    padding:     0;
    border:      0;
    background:  transparent;
    font-family: var(--font-family-mono, monospace);
    font-size:   11px;
    line-height: 1.45;
    white-space: pre;
  }

  &__md {
    display:     block;
    font-size:   12px;
    line-height: 1.4;

    :deep(h1), :deep(h2), :deep(h3), :deep(h4) { margin: 0 0 6px; font-size: 17px; line-height: 1.2; font-weight: 600; }
    :deep(h2) { font-size: 15px; }
    :deep(h3), :deep(h4) { font-size: 13px; }
    :deep(p) { margin: 0 0 6px; }
    :deep(ul), :deep(ol) { margin: 0 0 6px; padding-left: 18px; }
    :deep(pre) { margin: 0 0 6px; padding: 4px 6px; background: var(--box-bg); border-radius: 3px; overflow: hidden; }
    :deep(code) { font-size: 11px; }
    :deep(table) { border-collapse: collapse; margin: 0 0 6px; }
    :deep(th), :deep(td) { border: 1px solid var(--border); padding: 1px 5px; }
    :deep(img) { display: none; }
  }

  &__glyph {
    display:         flex;
    flex-direction:  column;
    align-items:     center;
    justify-content: center;
    gap:             4px;
    width:           100%;
    height:          100%;
    color:           var(--muted);
  }

  &__icon { font-size: 30px; }
  &__size { font-size: 11px; }

  &__wave {
    display:     flex;
    align-items: center;
    gap:         3px;
    height:      46%;

    i {
      display:       block;
      width:         3px;
      border-radius: 2px;
      background:    var(--link);
      opacity:       .75;
    }
  }

  &__badge {
    position:       absolute;
    inset:          auto 4px 4px auto;
    padding:        0 5px;
    border-radius:  3px;
    background:     rgba(0, 0, 0, .6);
    color:          #fff;
    font-family:    var(--font-family-mono, monospace);
    font-size:      10px;
    line-height:    16px;
    letter-spacing: .03em;
  }
}
</style>
