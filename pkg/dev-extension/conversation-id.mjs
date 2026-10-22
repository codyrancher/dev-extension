/**
 * What a conversation is called, and what its name says about where it came from.
 *
 * A conversation's id is not a label. It is the name of a directory under /workspace/sessions,
 * the name of a tmux session (`mc-<id>`), the name of the pane record under /workspace/.panes,
 * the stem of `<id>.state.json`, `<id>.events.jsonl`, `<id>.id` and `<id>.by` beside that
 * directory, and a path segment in the Kubernetes exec URL a pane opens. One string, five
 * places, and every one of them is a place somebody has to go looking when a conversation needs
 * tracking down.
 *
 * It used to say only which bucket and which ordinal: `agent-7` for the drawer, `p-<workspace>-3`
 * for a workspace. That is enough to find the directory and nothing else. Which file somebody was
 * looking at when they pressed Discuss, which line, which review - all of it lived in the title,
 * which a person can rename and claude overwrites, or nowhere at all. So a pod full of
 * `p-lte-pr-19630-{1..9}` was nine identical names, and the only way to tell them apart was to
 * open them.
 *
 * Now the id carries it:
 *
 *   agent-7                                               the drawer's + button: no location
 *   p-lte-pr-19630-1                                      a workspace's + button: no location
 *   p-lte-pr-19630_shell-dialog-add-auth-provider-vue-l193-2
 *   agent_pr-19630-review-4
 *
 * THE SHAPE
 *
 *   <base>[_<location>]-<ordinal>
 *   base     = `agent` | `p-<workspace>`
 *   location = [a-z0-9]([a-z0-9-]*[a-z0-9])?, at most LOCATION_MAX characters
 *   ordinal  = digits
 *
 * WHY `_` AND NOT `-`
 *
 * Workspace names contain dashes (`lte-pr-19630`), so `p-foo-bar-2` cannot be told apart from
 * workspace `foo` at location `bar` and workspace `foo-bar` with no location. Workspace names are
 * `[a-z0-9-]` - they are Kubernetes object names - so `_` cannot occur in one, which makes it an
 * unambiguous boundary. It is also safe everywhere the id is spent: tmux rejects `.` and `:` in a
 * session name and takes anything else; `_` is an ordinary filename byte; and it is unreserved in
 * RFC 3986, so it survives a URL untouched.
 *
 * WHY THE LOCATION GOES BEFORE THE ORDINAL
 *
 * Because the ordinal is what four readers already look for at the end of the id - `title_of` in
 * sessions.sh (`${id##*-}`), the sort in agent.ts, the title fallback in conversations.ts - and
 * `new` still allocates by mkdir on a name that ends in it. Putting the location in the middle
 * leaves every one of those reading exactly what it read before.
 *
 * THE CAP
 *
 * The only hard limit is the 255-byte filename, which the directory and the pane record are both
 * subject to. The worst case is a Kubernetes-length workspace name (63) plus `p-` (2) plus `_`
 * plus the location (LOCATION_MAX) plus `-` and three digits of ordinal, plus the longest suffix
 * anything appends (`.events.jsonl`, 13): 2 + 63 + 1 + 48 + 4 + 13 = 131. Half the budget, and
 * no path however deep can push it further, because the location is cut to fit here.
 *
 * BACKWARD COMPATIBILITY IS THE POINT OF THE PARSER
 *
 * `agent-5` and `p-lte-pr-19630-1` are running right now, with tmux sessions and transcripts
 * behind them. They parse as the same thing they always were, with an empty location; nothing
 * here renames or migrates anything. Everything that used to spell the shape as a regex of its
 * own asks this instead, so there is one answer to "is this id this workspace's" rather than
 * four that have to be kept in step. The fifth is sessions.sh, which cannot import JavaScript -
 * it mirrors this in shell, and says so.
 *
 * Plain JavaScript and no imports, so `node --test` loads it directly - see
 * tests/conversation-id.test.mjs.
 */

/**
 * How much of the id the location may take.
 *
 * 48 is a line of a tab label, not a filesystem limit - see the arithmetic above, which leaves
 * room for four times this. The reason to keep it short is that the id is read by people, in
 * `ls`, in `tmux ls` and on a tab, and a name nobody can read at a glance is the thing this was
 * built to fix.
 */
export const LOCATION_MAX = 48;

/** The drawer's base. A project's is `p-<project>`; see `conversationBase`. */
export const DRAWER_BASE = 'agent';

/** A location, as the id may carry it: lowercase, dashes, no run of them and no edge. */
const LOCATION_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** A workspace or project name: a Kubernetes object name, which is why `_` is free. */
const PROJECT_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

/**
 * One word of a location, from whatever a call site had.
 *
 * `AddAuthProviderDialog.vue` becomes `add-auth-provider-dialog-vue`, because a person reading
 * the id is looking for the file they were in, and `addauthproviderdialogvue` is not it. The two
 * replacements in front do the camel case: the first cuts between a lowercase run and a capital,
 * the second between an acronym and the word after it, so `HTTPServer` is `http-server` rather
 * than `h-t-t-p-server`.
 */
function slugWord(text) {
  return String(text ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Cut to a budget without leaving a dash hanging off the end, which `LOCATION_RE` rejects. */
function fit(slug, budget) {
  return budget > 0 ? slug.slice(0, budget).replace(/-+$/, '') : '';
}

/**
 * A path as a location, keeping the end of it.
 *
 * The end is what identifies the file - `shell/dialog/AddAuthProviderDialog.vue` is the dialog,
 * not the shell - so directories are added from the right while they fit and dropped from the
 * left when they do not. An absolute path loses `/workspaces/<name>/` this way without anything
 * having to know that prefix. A single segment too long for the budget keeps its head, because
 * `add-auth-provider-dial` is still recognisable and `provider-dialog-vue` is a different file
 * as far as a reader is concerned.
 */
function pathSlug(path, budget) {
  const parts = String(path ?? '').split('/').map(slugWord).filter(Boolean);

  if (!parts.length) {
    return '';
  }

  let out = fit(parts[parts.length - 1], budget);

  for (let i = parts.length - 2; i >= 0 && out; i--) {
    const wider = `${ parts[i] }-${ out }`;

    if (wider.length > budget) {
      break;
    }
    out = wider;
  }

  return out;
}

/**
 * Where a conversation was started from, as the id will spell it. '' when there is nowhere.
 *
 * An origin is a string (a label, or a path), or `{ path, line, label }`. '' is a real answer and
 * the common one: the + button on the drawer and on a workspace's strip start a conversation that
 * is about nothing in particular, and inventing `new-conversation` for it would be a location
 * that does not exist. Those ids keep the short form they have always had.
 *
 * Idempotent on its own output, so a caller that has already slugged - or one on the other side
 * of the browser API, which hands over a string - can be re-slugged without drift.
 */
export function locationSlug(origin) {
  if (!origin) {
    return '';
  }

  const at = typeof origin === 'string' ? { label: origin } : origin;
  const line = Number(at.line) > 0 ? `l${ Math.trunc(Number(at.line)) }` : '';
  // The line is the part worth keeping: it is the difference between "this file" and "this
  // line", so it gets its space before the path is measured.
  const budget = LOCATION_MAX - (line ? line.length + 1 : 0);
  const where = at.path ? pathSlug(at.path, budget) : fit(slugWord(at.label), budget);

  if (!where) {
    return line;
  }

  return line ? `${ where }-${ line }` : where;
}

/** The id's first part: the drawer's, or one project's. */
export function conversationBase(project) {
  return project ? `p-${ project }` : DRAWER_BASE;
}

/**
 * An id, from its three parts. The shell's `new` verb builds the same string; see sessions.sh.
 *
 * The location is slugged again here rather than trusted, because the only thing that makes the
 * parse unambiguous is that a location holds no `_` and a project holds neither `_` nor a digit
 * run it could be mistaken for - and a caller that built its own is a caller that can be wrong.
 */
export function buildConversationId(project, location, ordinal) {
  const where = locationSlug(location);
  const n = Math.max(1, Math.trunc(Number(ordinal) || 1));

  return `${ conversationBase(project) }${ where ? `_${ where }` : '' }-${ n }`;
}

/**
 * An id taken apart, or null if it is not one.
 *
 * Null rather than a half-filled answer: an id this does not understand is one whose workspace
 * cannot be trusted either, and guessing would end a conversation in the wrong place when a
 * workspace is deleted.
 *
 * The project is everything between `p-` and the boundary, and which boundary that is settles
 * the old ambiguity: with a `_` the project ends there, and with no `_` it ends at the LAST
 * dash, which is what makes `p-lte-pr-19630-1` workspace `lte-pr-19630` rather than `lte`.
 */
export function parseConversationId(id) {
  const text = String(id ?? '');
  const cut = text.lastIndexOf('-');

  if (cut < 1) {
    return null;
  }

  const ordinal = text.slice(cut + 1);
  const head = text.slice(0, cut);

  if (!/^\d+$/.test(ordinal)) {
    return null;
  }

  const bar = head.indexOf('_');
  const base = bar < 0 ? head : head.slice(0, bar);
  const location = bar < 0 ? '' : head.slice(bar + 1);

  // A `_` with nothing after it is not "no location": it is an id nobody built, and reading it
  // as `p-foo-1` would quietly fold two different directory names into one answer.
  if (bar >= 0 && (!LOCATION_RE.test(location) || location.length > LOCATION_MAX)) {
    return null;
  }

  let project = '';

  if (base !== DRAWER_BASE) {
    if (!base.startsWith('p-')) {
      return null;
    }
    project = base.slice(2);

    if (!PROJECT_RE.test(project)) {
      return null;
    }
  }

  // `-l193` on the end of a location is a line number, and reading it back is what makes an id
  // enough to reopen the thing it is about rather than only to recognise it.
  const line = Number(/(?:^|-)l(\d+)$/.exec(location)?.[1]) || 0;

  return {
    id:   text,
    kind: project ? 'project' : 'drawer',
    base,
    project,
    location,
    line,
    ordinal: Number(ordinal),
  };
}

/** Whether this is a conversation id at all, old form or new. */
export function isConversationId(id) {
  return !!parseConversationId(id);
}

/**
 * Whether this id is that project's.
 *
 * Asked by name rather than by prefix, because a prefix match is wrong in both directions: `p-foo-`
 * also matches project `foo-bar`'s ids, and `p-foo-` does not match `p-foo_...` at all.
 */
export function isProjectConversationId(project, id) {
  return !!project && parseConversationId(id)?.project === project;
}

/** Whether this id is the drawer's - `agent-<n>`, with or without a location. */
export function isDrawerConversationId(id) {
  return parseConversationId(id)?.kind === 'drawer';
}

/** The workspace an id belongs to, or '' for the drawer's and for anything unparseable. */
export function conversationProject(id) {
  return parseConversationId(id)?.project || '';
}

/** The ordinal, for sorting a list into the order the conversations were made. 0 when unknown. */
export function conversationOrdinal(id) {
  return parseConversationId(id)?.ordinal || 0;
}

/** The location an id carries, or '' for one started from nowhere in particular. */
export function conversationLocation(id) {
  return parseConversationId(id)?.location || '';
}

/**
 * The shortest honest label for an id, for a tab on a conversation nobody has named yet.
 *
 * The location when there is one, because that is what the id was given one for; the ordinal
 * otherwise, which is what the tab said before any of this. Never the whole id: a tab is not
 * wide enough for `p-lte-pr-19630_shell-dialog-add-auth-provider-vue-l193-2`.
 */
export function conversationLabel(id) {
  const parsed = parseConversationId(id);

  if (!parsed) {
    return String(id ?? '');
  }

  return parsed.location || String(parsed.ordinal);
}
