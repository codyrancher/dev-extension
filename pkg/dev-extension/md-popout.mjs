// A way out of a comment, for the parts of one that do not fit in it.
//
// A review comment is a column a few hundred pixels wide and the things people put in them are
// not: a fifteen-row table of "comment" against "what changed", a stack trace, a diff pasted
// into a fence. Those get a horizontal scrollbar at the bottom of the comment and are read a
// third of a screen at a time, scrolling back and forth to keep a row's two halves together -
// which is the one reading posture a table is meant to prevent.
//
// So anything inside a comment that does not fit gets a button in its corner, and the button
// opens it over the page at full width.
//
// WHY THIS IS DOM RATHER THAN A COMPONENT. The bodies are `v-html` - markdown rendered to a
// string and handed to the browser - so there is no component tree inside one to put a button
// in. A directive would mean registering it on each of the dozen components that render a
// comment; this is one call per page instead (see `watchPopouts`), and it re-scans when the
// page changes, so a comment loaded later is covered without anybody remembering to say so.
//
// The overlay is built here too, for the same reason: a module function has no parent to
// teleport a DevModal into. It is the product's own tokens and the same two ways out a modal
// has - the close button, and Escape.

/** What inside a comment is worth opening larger. Everything else wraps. */
const CANDIDATES = '.md-body table, .md-body pre, .comment-body table, .comment-body pre';

/** Marks a node this has already dealt with, so a re-scan is idempotent. */
const DONE = 'data-popout';

/** The one stylesheet, made on first use. */
const SHEET_ID = 'dev-md-popout';

const CSS = `
.md-pop {
  position:   relative;
  overflow-x: auto;
  max-width:  100%;
}
/* Room for the button, so it never sits on the first row's text. */
.md-pop--wide { padding-top: 22px; }
.md-pop__btn {
  position:      absolute;
  top:           0;
  right:         0;
  z-index:       2;
  display:       inline-flex;
  align-items:   center;
  gap:           4px;
  min-height:    0;
  padding:       2px 6px;
  border:        1px solid var(--border, #444);
  border-radius: var(--dev-r-xs, 4px);
  background:    var(--box-bg, #222);
  color:         var(--body-text, #eee);
  font-size:     10px;
  font-weight:   600;
  letter-spacing: .04em;
  text-transform: uppercase;
  cursor:        pointer;
  opacity:       .65;
}
.md-pop__btn:hover,
.md-pop__btn:focus-visible { opacity: 1; border-color: var(--link, #3d98d3); color: var(--link, #3d98d3); }

.md-popover {
  position:        fixed;
  inset:           0;
  z-index:         1000;
  display:         flex;
  flex-direction:  column;
  padding:         24px;
  background:      var(--overlay-bg, rgba(0, 0, 0, .6));
}
.md-popover__frame {
  display:        flex;
  flex-direction: column;
  flex:           1 1 auto;
  min-height:     0;
  border:         1px solid var(--border, #444);
  border-radius:  var(--r-sm, 4px);
  background:     var(--body-bg, #1b1c21);
  box-shadow:     0 0 24px var(--shadow, rgba(0, 0, 0, .45));
}
.md-popover__head {
  display:         flex;
  align-items:     center;
  justify-content: space-between;
  gap:             12px;
  flex:            0 0 auto;
  padding:         10px 14px;
  border-bottom:   1px solid var(--border, #444);
}
.md-popover__title {
  font-size:      11px;
  font-weight:    700;
  letter-spacing: .06em;
  text-transform: uppercase;
  color:          var(--input-label, #999);
}
.md-popover__close {
  min-height:    0;
  padding:       2px 8px;
  border:        1px solid var(--border, #444);
  border-radius: var(--dev-r-xs, 4px);
  background:    transparent;
  color:         var(--body-text, #eee);
  cursor:        pointer;
}
.md-popover__close:hover { color: var(--error, #e05) }
.md-popover__body {
  flex:       1 1 auto;
  min-height: 0;
  overflow:   auto;
  padding:    14px;
}
/* The thing itself, at whatever width it wants now that it has the page. */
.md-popover__body table { border-collapse: collapse; }
.md-popover__body th,
.md-popover__body td {
  border:  1px solid var(--border, #444);
  padding: 4px 10px;
}
.md-popover__body pre {
  margin:      0;
  white-space: pre;
}
`;

function sheet() {
  if (document.getElementById(SHEET_ID)) {
    return;
  }
  const el = document.createElement('style');

  el.id = SHEET_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

/**
 * Whether this is wider than the room it has.
 *
 * Measured against the comment's own width rather than the node's parent: by the time this
 * runs the node may already be in a scroller of its own, where the parent is as wide as the
 * content and nothing ever looks too big.
 */
function overflows(node, within) {
  const room = within?.clientWidth || node.parentElement?.clientWidth || 0;

  return room > 0 && node.scrollWidth > room + 4;
}

/** The thing, over the page. */
function openOver(html, label) {
  sheet();

  const over = document.createElement('div');

  over.className = 'md-popover';
  over.innerHTML = `
    <div class="md-popover__frame" role="dialog" aria-modal="true" aria-label="${ label }">
      <div class="md-popover__head">
        <span class="md-popover__title">${ label }</span>
        <button type="button" class="md-popover__close">Close</button>
      </div>
      <div class="md-popover__body"></div>
    </div>`;
  // The content as a node rather than through innerHTML on the frame: it is already rendered
  // markdown that was sanitised on the way in, and re-parsing the whole frame around it would
  // be a second place for that to be got wrong.
  over.querySelector('.md-popover__body').innerHTML = html;

  const shut = () => {
    document.removeEventListener('keydown', onKey);
    over.remove();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      shut();
    }
  };

  over.querySelector('.md-popover__close').addEventListener('click', shut);
  // A press on the backdrop, not on the frame.
  over.addEventListener('mousedown', (event) => {
    if (event.target === over) {
      shut();
    }
  });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(over);
  over.querySelector('.md-popover__close').focus();
}

/** One pass: give everything that does not fit a way out, and take it back from what now does. */
export function scanPopouts(root) {
  if (!root?.querySelectorAll) {
    return;
  }
  sheet();

  for (const node of root.querySelectorAll(CANDIDATES)) {
    const body = node.closest('.md-body, .comment-body');
    const already = node.parentElement?.classList?.contains('md-pop');

    if (!overflows(node, body)) {
      continue;
    }
    if (already) {
      node.parentElement.classList.add('md-pop--wide');
      continue;
    }

    const wrap = document.createElement('div');

    wrap.className = 'md-pop md-pop--wide';
    wrap.setAttribute(DONE, node.tagName.toLowerCase());
    node.parentElement.insertBefore(wrap, node);
    wrap.appendChild(node);

    const button = document.createElement('button');

    button.type = 'button';
    button.className = 'md-pop__btn';
    button.title = 'Open this over the page';
    button.textContent = '⤢ Open';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openOver(node.outerHTML, node.tagName === 'TABLE' ? 'Table' : 'Block');
    });
    wrap.appendChild(button);
  }
}

/**
 * Keep a page's comments covered, including the ones that arrive later.
 *
 * Called once from a page's `mounted` with its own element. Scanning costs a `querySelectorAll`
 * and a width read per candidate, so it is held to one pass per frame however many mutations
 * land in it - a comment list redrawing row by row would otherwise scan once per row.
 *
 * Returns the stop, for `beforeUnmount`.
 */
export function watchPopouts(root) {
  if (!root || typeof MutationObserver === 'undefined') {
    return () => {};
  }
  let queued = false;
  const pass = () => {
    queued = false;
    try {
      scanPopouts(root);
    } catch { /* a scan that throws must not take the page with it */ }
  };
  const soon = () => {
    if (!queued) {
      queued = true;
      requestAnimationFrame(pass);
    }
  };

  const watcher = new MutationObserver(soon);

  watcher.observe(root, { childList: true, subtree: true });
  soon();

  return () => watcher.disconnect();
}
