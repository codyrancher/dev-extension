<script setup lang="ts">
/**
 * GitHub markdown, rendered. The one component for it.
 *
 * Everything written by a person or an agent in this product is GitHub markdown - a pull request's
 * description, a review comment, an advisory's summary, an agent's report - and it was being
 * drawn four different ways: through `renderMd` here, through `renderMarkdown` there, and in two
 * places as plain text in a `<p>`, which is how a description came to read `### Summary` with the
 * hashes showing. Markdown shown raw is markdown nobody can read; markdown shown raw *by
 * accident* is worse, because it looks like the data is wrong rather than the page.
 *
 * So: rendered by default, everywhere, by this. The raw text belongs in exactly one place - a box
 * you are editing it in - and that is a textarea, not this.
 *
 * The renderer is the pull request page's own (`renderMd`, marked with gfm), so a comment reads
 * the same here as it does there, and authored HTML is escaped rather than run - comment bodies
 * come from arbitrary GitHub users.
 */
import { renderMd } from '../pr/diff';

withDefaults(defineProps<{
  text: string;
  /** Tighter, for a comment in a list rather than a document in a dialog. */
  dense?: boolean;
  /**
   * On a card, where something else is the frame.
   *
   * The headings were `--t-md` (15px) everywhere, and a card's own SectionHead is `--t-sm` (13px)
   * - so on every start-fix card the issue template's own `Setup`, `Describe the bug` and `To
   * Reproduce` were set *larger* than `What the issue asks for` that frames them. The content
   * outranked the frame, and your eye landed on GitHub's boilerplate before it landed on what the
   * card was asking you to do.
   *
   * Inside a card, markdown is card-scaled: the headings drop to the card's own 13px and do their
   * work with weight and colour instead. In TextModal the prose *is* the document and nothing
   * frames it, so 15px is right there and this stays false.
   */
  card?: boolean;
}>(), { dense: false, card: false });

/**
 * A bare attachment URL is a picture, which is what GitHub makes of it.
 *
 * When somebody drags a screenshot into a GitHub comment box, GitHub may write the bare URL rather
 * than `![](...)` - and it renders that URL as the image anyway, so the author never sees a
 * difference. `renderMd` autolinks it instead, which turned the evidence into a link with a
 * 40-character URL for its own link text.
 *
 * Measured on two start-fix cards of the same kind: Issue #14139's attachment is written in
 * `![](...)` form and rendered as a 588x210 image that loads (naturalWidth 962); Issue #18380's is
 * bare, and `.card__read` held `<a href="https://github.com/user-attachments/assets/bb316eed-...">`
 * with the URL as its text - so the one card whose body says "check the screenshot" made you leave
 * the view to see it. `.md-body :deep(img)` has been waiting for this since it was written.
 *
 * Only a URL that stands alone on its line, so nothing already inside a link or an image is
 * touched, and only the three forms GitHub itself embeds.
 *
 * **And it degrades.** An `assets/<id>` URL carries no extension, so it may be a video, and a
 * private attachment wants a github.com session this dashboard does not have - measured on Issue
 * #18380, the embed came back `naturalWidth: 0` in a headless browser with no GitHub login, while
 * Issue #14139's `user-images.githubusercontent.com` one loaded at 962px. So the image is wrapped
 * in a link to itself and carries alt text: where it loads you see the screenshot, and where it
 * does not you get a word you can click instead of forty characters of URL. Both are better than
 * what was there.
 */
const EMBEDS = new RegExp([
  // What the current composer writes: no extension, image or video.
  '^https://github\\.com/user-attachments/assets/[\\w-]+$',
  // What it wrote for years.
  '^https://user-images\\.githubusercontent\\.com/[\\w./%-]+$',
  // And a file upload, which is only a picture when it says so - the live deck has a `.yaml` one.
  '^https://github\\.com/[\\w.-]+/[\\w.-]+/files/\\d+/\\S+\\.(?:png|jpe?g|gif|webp|svg)$',
].join('|'), 'i');

const embedded = (text: string) => String(text ?? '')
  .split('\n')
  .map((line) => {
    const url = line.trim();

    if (!EMBEDS.test(url)) {
      return line;
    }
    const name = decodeURIComponent(url.split('/').pop() || '');
    const alt = /\.\w{2,4}$/.test(name) ? name : 'Attachment on GitHub';

    return `[![${ alt }](${ url })](${ url })`;
  })
  .join('\n');

/**
 * GitHub's alert syntax, which `renderMd` does not implement and therefore leaks.
 *
 * An advisory body opens `> [!IMPORTANT]` on its own line, and with gfm alone that renders as a
 * blockquote whose first four characters are the literal markup - visible as `[!IMPORTANT]` at the
 * top of the only surface the advisory card has. Same class of leak as `### Summary` showing its
 * hashes, which is what this component was written to end: markdown shown raw by accident looks
 * like the data is wrong rather than the page.
 *
 * The rendered HTML is post-processed rather than the source pre-processed, because the token is
 * only an alert when it is the first thing *inside a blockquote* - `[!NOTE]` in a sentence is a
 * reference-style link and belongs to the author. The five GitHub names, their three tones, and
 * the token removed so nothing says it twice.
 */
const ALERTS: Record<string, string> = {
  NOTE: 'accent', TIP: 'success', IMPORTANT: 'accent', WARNING: 'warning', CAUTION: 'danger',
};

const alerted = (html: string) => html.replace(
  /(<blockquote>\s*(?:<p>)?\s*)\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(?:<br\s*\/?>)?\s*/gi,
  (whole, head: string, name: string) => {
    const tone = ALERTS[name.toUpperCase()];

    return tone ? `${ head }<span class="u-badge md-alert md-alert--${ tone }">${ name.toLowerCase() }</span> ` : whole;
  },
);

const drawn = (text: string) => alerted(renderMd(embedded(text)));
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- renderMd escapes authored HTML before marking up. -->
  <div class="md-body" :class="{ 'md-body--dense': dense, 'md-body--card': card }" v-html="drawn(text)" />
</template>

<style scoped>
.md-body {
  min-width: 0;
  color: var(--text-dim);
  font-size: var(--t-sm);
  line-height: 1.65;
  overflow-wrap: anywhere;
}

.md-body--dense { line-height: 1.55; }

/* ── Blocks ───────────────────────────────────────────────────────────────────────────────── */
.md-body :deep(h1),
.md-body :deep(h2),
.md-body :deep(h3),
.md-body :deep(h4) {
  margin: var(--s4) 0 var(--s2);
  color: var(--text);
  font-size: var(--t-md);
  font-weight: 650;
  line-height: 1.3;
}

.md-body :deep(h1:first-child),
.md-body :deep(h2:first-child),
.md-body :deep(h3:first-child),
.md-body :deep(h4:first-child) { margin-top: 0; }

.md-body :deep(p) { margin: 0 0 var(--s3); max-width: 78ch; }
.md-body :deep(p:last-child) { margin-bottom: 0; }
.md-body--dense :deep(p) { margin-bottom: var(--s2); }

.md-body :deep(ul),
.md-body :deep(ol) { margin: 0 0 var(--s3); padding-left: var(--s5); max-width: 78ch; }
.md-body :deep(li) { margin: 3px 0; }
.md-body :deep(li > p) { margin-bottom: 2px; }

.md-body :deep(blockquote) {
  margin: 0 0 var(--s3);
  padding-left: var(--s3);
  border-left: 2px solid var(--border-strong);
  color: var(--text-muted);
}

.md-body :deep(hr) { margin: var(--s4) 0; border: 0; border-top: 1px solid var(--border); }

/* ── Inline ───────────────────────────────────────────────────────────────────────────────── */
.md-body :deep(strong) { color: var(--text); font-weight: 650; }
.md-body :deep(a) { color: var(--accent); text-decoration: none; }
.md-body :deep(a:hover) { text-decoration: underline; }

.md-body :deep(code) {
  padding: 1px 5px;
  border-radius: var(--r-sm);
  background: var(--surface-raised);
  color: var(--text);
  font-family: var(--mono);
  font-size: 0.92em;
}

.md-body :deep(pre) {
  margin: 0 0 var(--s3);
  padding: var(--s3);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface-sunk);
  /* The one thing allowed to scroll sideways: a code block has no sensible wrap. */
  overflow-x: auto;
}

.md-body :deep(pre code) { padding: 0; background: none; font-size: var(--t-xs); }

/* A test matrix is the most useful thing in these bodies and the least readable unrendered. */
.md-body :deep(table) {
  display: block;
  width: max-content;
  max-width: 100%;
  margin: 0 0 var(--s3);
  border-collapse: collapse;
  overflow-x: auto;
  font-size: var(--t-xs);
}

.md-body :deep(th),
.md-body :deep(td) { padding: 4px 10px; border: 1px solid var(--border); text-align: left; }
.md-body :deep(th) { background: var(--surface-raised); color: var(--text); font-weight: 650; }

/* A screenshot is evidence, so it is given the room; `display: block` because an image on its own
   line is a block in every reader's head and `vertical-align` baseline leaves a gap under it. */
.md-body :deep(img) {
  display: block;
  max-width: 100%;
  max-height: 60vh;
  border-radius: var(--r-sm);
}

/* An image wrapped in a link to itself - see `embedded` - should not be underlined on hover. */
.md-body :deep(a:has(> img):hover) { text-decoration: none; }
</style>
