// What claude is doing, written down by claude itself.
//
// The chat view used to read a conversation's state off the terminal: regexes over the last
// forty lines of a TUI, looking for "esc to interrupt" and a bare prompt. That is guesswork
// about a picture, and it guessed wrong in both directions - "working" hours after claude had
// stopped, because a spinner line was still in the scrollback, and "ready" while it was mid-tool.
//
// Claude Code has hooks for exactly these moments, and this is the one script behind all of
// them. It is registered (claude-defaults.mjs) for:
//
//   SessionStart      claude is up, on this transcript
//   UserPromptSubmit  a turn began, and what it began with
//   Stop              the turn is over
//   Notification      claude is waiting: an idle prompt, a permission prompt, a question
//   SessionEnd        claude exited, and why
//
// Each firing rewrites one small file, `<sessions>/<pane>.state.json`, with the latest event,
// and appends a line to `<pane>.events.jsonl` so a sequence can be read back when something
// looks wrong. The pane is MC_SESSION, which shell.sh puts in claude's environment; the hook
// payload itself only knows the transcript's uuid.
//
// Nothing here is authoritative on its own. The chat crosses it with the transcript (which
// carries the turn boundaries too) and with whether the claude process is alive - a hook can
// only record what claude lived to tell it.
import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.HOME || '/app/.home';
const SESSION = process.env.MC_SESSION || '';
const DIR = path.join(path.dirname(HOME), 'sessions');

let payload = {};

try {
  payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
} catch {
  // A hook with nothing readable on stdin still records that it fired.
}

if (!SESSION) {
  process.exit(0);
}

const event = {
  event:      payload.hook_event_name || process.argv[2] || 'unknown',
  at:         new Date().toISOString(),
  sessionId:  payload.session_id || '',
  transcript: payload.transcript_path || '',
  cwd:        payload.cwd || '',
  pid:        process.ppid,
};

// The parts of each payload the chat reads. Kept short on purpose: the transcript has the
// content, this has the moment.
if (payload.prompt !== undefined) {
  event.prompt = String(payload.prompt).slice(0, 2000);
}
if (payload.notification_type) {
  event.notification = payload.notification_type;
  event.message = String(payload.message || '').slice(0, 500);
}
if (payload.reason) {
  event.reason = payload.reason;
}
if (payload.stop_hook_active !== undefined) {
  event.stopHookActive = !!payload.stop_hook_active;
}

try {
  fs.mkdirSync(DIR, { recursive: true });
  const state = path.join(DIR, `${ SESSION }.state.json`);

  // Which transcript this pane is on, from the one place that knows for certain. The pane's
  // loop (claude-session.sh) learns it by watching for a new transcript file, which misses
  // when two appear or none does, and a pane without the file resumes by `--continue`'s guess.
  // Every SessionStart - a start, a resume, a /clear - names the current one.
  if (event.event === 'SessionStart' && event.sessionId) {
    try {
      fs.writeFileSync(path.join(DIR, `${ SESSION }.id`), `${ event.sessionId }\n`);
    } catch { /* the loop's own watcher is the fallback */ }
  }
  const tmp = `${ state }.${ process.pid }`;

  // Rename, so a reader never sees half a file.
  fs.writeFileSync(tmp, `${ JSON.stringify(event) }\n`);
  fs.renameSync(tmp, state);

  const log = path.join(DIR, `${ SESSION }.events.jsonl`);

  fs.appendFileSync(log, `${ JSON.stringify(event) }\n`);
  // Bounded: the last thousand lines are more than a debugging session needs.
  try {
    const stat = fs.statSync(log);

    if (stat.size > 512 * 1024) {
      const lines = fs.readFileSync(log, 'utf8').split('\n');

      fs.writeFileSync(log, `${ lines.slice(-500).join('\n') }\n`);
    }
  } catch { /* the trim is best-effort */ }
} catch {
  // A hook must never fail the turn it is observing.
}

/**
 * Tell the watcher to look now, on the three events that settle a turn.
 *
 * The state file above is the record; this is the doorbell. dev-api watches these conversations on
 * a thirty-second timer (server.mjs, the conversation listing), which is fine for a dot on a tab
 * and too slow for the one thing this is really for: a card the person put aside until its agent
 * stopped, which should come back when it stopped and not up to half a minute later.
 *
 * It carries no state. The listing re-reads everything itself, and it must - the two facts that
 * decide a conversation's state are tmux liveness and the transcript's mtime, and a hook can see
 * neither. So this says "look", never "here is what happened", and there is nothing to trust.
 *
 * Addressed by service DNS rather than by an environment variable, because `CLAUDE_HARNESS_API` is
 * set for a workspace's tool commands and is empty in this pod - and adding it to the agent
 * Deployment would reach no cluster that already has one, since that body is only ever created,
 * never patched.
 *
 * Bounded and swallowed, because of the rule above: one second, no retry, every failure ignored. A
 * dev-api that is rolling - which happens on every release - must not add a second to somebody's
 * turn, and the thirty-second sweep is what makes losing this harmless.
 */
const NOTIFY = new Set(['Stop', 'Notification', 'SessionEnd']);

if (NOTIFY.has(event.event)) {
  const api = process.env.CLAUDE_HARNESS_API || 'http://dev-api.dev-system.svc.cluster.local:8080';

  try {
    await fetch(`${ api }/conversations/refresh`, { method: 'POST', signal: AbortSignal.timeout(1000) });
  } catch { /* the sweep will find it */ }
}

process.exit(0);
