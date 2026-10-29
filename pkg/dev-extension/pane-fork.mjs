// Copying one conversation so a second can carry on from where the first has got to.
//
// A conversation is three things, and only the third is difficult. The id and the title are a
// directory in the pod (sessions.sh, `new`). The pane is a tmux session shell.sh creates. The
// history is a transcript the CLI resumes by uuid - `claude --resume <uuid>`, which reads
// `<uuid>.jsonl` out of a directory named for the working directory - and the pane says which
// uuid is its own in `<sessions>/<id>.id`, written by claude-session.sh the first time it runs.
//
// So a fork is: copy the transcript under a NEW uuid, and write that uuid into the new pane's id
// file BEFORE anything starts the pane. The pane then comes up on a conversation that has the
// original's turns behind it and nothing else in common with it.
//
// Copied rather than shared, and that is the whole point. Two panes resuming one uuid are two
// claudes appending to one file, which is exactly what a fork is for avoiding: the person wants
// to steer the copy and keep the original as it was. The copy's lines each carry the uuid in
// their own `sessionId` field, so that is rewritten as the file is copied - the file's name and
// what is written inside it say the same id everywhere else in the CLI's data, and a fork that
// disagreed with itself is a bug waiting for the release that starts reading the field.
//
// agy keeps a directory per conversation instead of a file, so there the copy is `cp -r` of that
// directory and nothing has to be rewritten. One function, because the difference between the
// two CLIs is a path.
//
// Pure JavaScript and no imports, so `node --test` loads it directly - see
// tests/pane-fork.test.mjs.

/**
 * The one `node -e` program in here: copy a transcript, line by line, under a new id.
 *
 * Single-quoted into the shell below, so it must not contain a single quote of its own. A line
 * that is not JSON - a truncated last line, something a future version appends - is carried
 * across untouched rather than dropped: this is somebody's history, and the CLI is the thing
 * entitled to decide a line of it is unreadable.
 */
const REWRITE = [
  'node -e \'',
  'const fs = require("fs");',
  // `node -e` has no script path, so the first argument is argv[1] and not argv[2] - the same
  // offset transcriptPathOf's one-liner relies on.
  'const [, from, to, id] = process.argv;',
  'const lines = fs.readFileSync(from, "utf8").split("\\n").map((line) => {',
  '  if (!line.trim()) { return line; }',
  '  try {',
  '    const row = JSON.parse(line);',
  '    if (!row || typeof row !== "object") { return line; }',
  '    if ("sessionId" in row) { row.sessionId = id; }',
  '    return JSON.stringify(row);',
  '  } catch (e) { return line; }',
  '});',
  'fs.writeFileSync(to, lines.join("\\n"));',
  '\'',
].join(' ');

/**
 * A uuid this is willing to name a transcript after. Nothing else may be interpolated below.
 *
 * The caller makes it (`crypto.randomUUID`), because the browser is where the fork is asked for
 * and a uuid generated in a shell script would be another thing to get right in `sh`. Which
 * makes it caller input, and this is the gate on it.
 */
export const FORK_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The shell for one fork, as lines. Ends by echoing exactly one word: see PANE_FORK_RESULTS.
 *
 * @param {object} o
 * @param {string} o.sessions Where the panes' id files are (`/workspace/sessions`).
 * @param {string} o.source The conversation being forked, by id.
 * @param {string} o.target The new conversation's id, already allocated by the pod.
 * @param {string} o.uuid The transcript the copy will be, which the caller made.
 * @param {string} [o.projectDir] claude's transcript directory for the working directory.
 * @param {string} [o.brain] agy's brain directory, when the conversation is agy's. Either this
 *   or `projectDir`; `brain` wins, because an agy conversation has no `.jsonl` to copy.
 * @returns {string[]}
 */
export function forkScript({
  sessions, source, target, uuid, projectDir = '', brain = '',
}) {
  const srcId = `"${ sessions }/${ source }.id"`;
  const srcState = `"${ sessions }/${ source }.state.json"`;
  const dstId = `"${ sessions }/${ target }.id"`;
  // `$src` is the original's uuid, read below. Interpolated into the paths rather than into a
  // command, and read out of a file this pod wrote, so it is the one value here that no regex
  // has passed - which is why it never leaves a quoted path.
  const from = brain ? `"${ brain }/$src"` : `"${ projectDir }/$src.jsonl"`;
  const to = brain ? `"${ brain }/${ uuid }"` : `"${ projectDir }/${ uuid }.jsonl"`;

  const copy = brain ? [
    `[ -d ${ from } ] || done_ NOTRANSCRIPT`,
    `cp -r ${ from } ${ to } 2>/dev/null || done_ NOCOPY`,
  ] : [
    `[ -f ${ from } ] || done_ NOTRANSCRIPT`,
    `${ REWRITE } ${ from } ${ to } ${ uuid } 2>/dev/null || done_ NOCOPY`,
    // The subagents' own transcripts, which claude keeps in a directory named for the session
    // beside it. Best effort: a conversation that never ran a subagent has no such directory,
    // and a fork is worth having without them.
    `[ -d "${ projectDir }/$src" ] && cp -r "${ projectDir }/$src" "${ projectDir }/${ uuid }" 2>/dev/null || true`,
  ];

  return [
    'done_() { echo "$1"; exit 0; }',
    /*
     * Which transcript the original is, from the pane's own record and then from the hook's.
     *
     * The same two places, in the same order, as transcriptPathOf and the chat view: the `.id`
     * file is what the pane itself wrote, and the state file is what claude's hook wrote, which
     * covers the window between claude's first turn and the pane noticing. Neither means the
     * conversation has never run - it means it has not run YET, which is a fork with nothing to
     * copy and is reported rather than guessed at.
     */
    `src=$(cat ${ srcId } 2>/dev/null | tr -d '\\n')`,
    `[ -n "$src" ] || src=$(node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).sessionId||""))}catch(e){}' ${ srcState } 2>/dev/null)`,
    '[ -n "$src" ] || done_ NOID',
    ...copy,
    /*
     * The copy claimed, before the pane that will resume it exists.
     *
     * Order matters here and nowhere else in this script: claude-session.sh starts a watcher
     * that adopts whatever transcript appears when the id file is EMPTY, so a pane started
     * before this line would open a conversation of its own and record that instead - and the
     * copy would sit there unread with the fork pointing at the wrong history.
     */
    `printf '%s' ${ uuid } > ${ dstId } || done_ NOCOPY`,
    // The exec runs as root in the pod and everything in the pane is the node user; a
    // root-owned transcript is one claude cannot append to. shell.sh repairs the home on every
    // pane start, which does not cover the sessions directory, so both are done here.
    `[ "$(id -u)" = 0 ] && chown node:node ${ dstId } ${ to } 2>/dev/null; true`,
    `[ "$(id -u)" = 0 ] && [ -d ${ to } ] && chown -R node:node ${ to } 2>/dev/null; true`,
    'done_ FORKED',
  ];
}

/** Every word the script can end with, and what each one means. */
export const PANE_FORK_RESULTS = ['FORKED', 'NOID', 'NOTRANSCRIPT', 'NOCOPY'];

/**
 * What a fork is called.
 *
 * A fork of a fork says so once rather than twice: `Fork of Fork of Fork of review-2` is a name
 * nobody can read, and which copy is which is answered by where the tab is and what was said in
 * it, not by how many times the word appears. Cut to a tab's width, because that is where it is
 * read.
 */
export function forkTitle(title) {
  const name = String(title ?? '').trim();
  // Every prefix, not one: a title that somehow carries two is still one conversation, and
  // `/^fork of /` on its own left `Fork of ` reading as `Fork of Fork of`.
  const base = name.replace(/^(fork of\s*)+/i, '').trim() || 'conversation';

  return `Fork of ${ base }`.slice(0, 60);
}
