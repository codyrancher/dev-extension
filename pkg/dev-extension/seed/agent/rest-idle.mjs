/**
 * Close conversations that are doing nothing, so an idle one stops holding a claude.
 *
 * A conversation is its transcript, not its process: the session goes, the directory, the id and
 * the transcript stay, and the next attach or send resumes it where it was. What makes that safe is
 * only ever closing one with nothing in progress, so everything here that cannot be read keeps the
 * conversation. Being wrong that way costs a few hundred megabytes for another pass; being wrong
 * the other way kills somebody's work.
 *
 * In progress means: a turn with no end, a tool call with no result (which is also a question
 * waiting for its answer), something started in the background that has not reported back, a
 * wake-up still due, a cron not deleted, or any process under claude that is not an MCP server.
 *
 * `decide` has no disk and no clock of its own, and tests/rest-idle.test.mjs holds each refusal.
 * Run as the pane's user (sessions.sh rest-idle), since a tmux server belongs to a user. Run directly
 * with `--dry-run`, it prints what it would do and closes nothing.
 *
 * A restart still brings a closed conversation back, because boot.sh restores every pane record
 * and changing it would roll the pod. Thirty idle minutes later it is closed again.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const IDLE_MS = 30 * 60_000;
/** How much of a transcript is read: many turns, and a line can be a pasted image. */
const TAIL_BYTES = 1024 * 1024;
/** Something in the background that never reported back has died with a claude before now. */
const BACKGROUND_LIMIT_MS = 24 * 3600_000;
const CRON_LIFETIME_MS = 7 * 24 * 3600_000;
/** Time for a wake-up to fire and be written down, past when it was due. */
const WAKE_MARGIN_MS = 10 * 60_000;
const BACKGROUND_TOOLS = new Set(['Workflow', 'Monitor']);
/** The children every idle claude has. Anything else under it may be somebody's job. */
const QUIET_CHILD = /mcp|\[MainThread\]/i;
/** A bound on a mistake: the next pass takes the next few. */
const CLOSES_PER_PASS = 20;

const SESSIONS = '/workspace/sessions';

/**
 * The last thing that happened in a transcript, or NaN.
 *
 * Not the file's mtime: the CLI rewrites a few lines of its own at the end of an idle conversation's
 * transcript about once an hour, and those carry no timestamp. See `states` in sessions.sh.
 */
export function lastStampMs(tail) {
  const stamps = String(tail || '').match(/"timestamp":"[^"]+"/g);

  return stamps ? Date.parse(stamps[stamps.length - 1].slice(13, -1)) : NaN;
}

function contentOf(entry) {
  const content = entry?.message?.content;

  return Array.isArray(content) ? content : [];
}

function textOf(entry) {
  const content = entry?.message?.content;

  return typeof content === 'string' ? content : contentOf(entry).map((block) => block?.text || '').join('\n');
}

/**
 * What the end of a transcript says is in progress, or '' when nothing is.
 *
 * @param {string} tail The transcript's last bytes. The first line may be cut, and is skipped.
 * @param {number} now The clock.
 * @param {number} wroteMs When the transcript last moved.
 * @returns {string} Why this conversation must stay, or ''.
 */
export function inProgress(tail, now, wroteMs) {
  const open = new Set();
  const background = new Map();
  let notices = '';
  let wake = null;
  let last = '';

  for (const line of String(tail || '').split('\n')) {
    let entry;

    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    // By line and not by entry type: one that lands mid-turn is an attachment, not a user message.
    if (line.includes('<task-notification>')) {
      notices += line;
    }
    if (entry.type === 'assistant' && !entry.isSidechain) {
      for (const block of contentOf(entry)) {
        if (block?.type === 'tool_use') {
          open.add(block.id);
          if (block.input?.run_in_background === true || BACKGROUND_TOOLS.has(block.name)) {
            background.set(block.id, block.name);
          }
          if (block.name === 'ScheduleWakeup') {
            wake = block.input?.stop === true ? null : {
              at:    Date.parse(entry.timestamp) || 0,
              delay: Number(block.input?.delaySeconds) || 0,
            };
          }
        }
      }
      last = entry.message?.stop_reason === 'end_turn' ? 'ended' : 'assistant';
    } else if (entry.type === 'user' && !entry.isSidechain) {
      const results = contentOf(entry).filter((block) => block?.type === 'tool_result');
      const text = textOf(entry);

      results.forEach((block) => open.delete(block.tool_use_id));
      if (/^\[Request interrupted by user/.test(text.trim())) {
        last = 'ended';
      } else if (!entry.isMeta && !results.length) {
        last = 'prompt';
      } else if (results.length) {
        last = 'result';
      }
    } else if (entry.type === 'system' && ['turn_duration', 'stop_hook_summary'].includes(entry.subtype)) {
      last = 'ended';
    }
  }

  if (open.size) {
    return 'a tool call has no result yet';
  }
  if (last !== 'ended') {
    return last ? 'the turn has not ended' : 'the transcript shows no finished turn';
  }
  if (wake && now < wake.at + (wake.delay * 1000) + WAKE_MARGIN_MS) {
    return 'a wake-up is still due';
  }
  if (now - wroteMs < BACKGROUND_LIMIT_MS) {
    for (const [id, name] of background) {
      if (!notices.includes(id)) {
        return `${ name } in the background has not reported back`;
      }
    }
  }

  return '';
}

/**
 * Whether one conversation may close.
 *
 * @param {object} c What was read about it.
 * @param {string} c.command What the pane was started with.
 * @param {number} c.windows Its tmux windows.
 * @param {number} c.claudes The claude processes directly under the pane.
 * @param {string[]} c.children Every process under claude, as its arguments.
 * @param {string} c.conversation The id this pane resumes by, from `<id>.id`.
 * @param {boolean} c.queued Whether a prompt is waiting for it.
 * @param {string|null} c.tail The end of its transcript, or null when it could not be read.
 * @param {number} c.crons CronCreate calls in the transcript beyond its CronDelete calls.
 * @param {number[]} c.activity Every time something touched it, in ms; a NaN means unknown.
 * @param {number} now The clock.
 * @returns {string} Why it must stay, or '' when it may close.
 */
export function decide(c, now) {
  if (!/claude-session\.sh/.test(c.command || '') || c.windows !== 1 || c.claudes !== 1) {
    return 'not one claude in its own pane';
  }
  if (!c.conversation) {
    return 'nothing to resume it by';
  }
  if (c.queued) {
    return 'a prompt is waiting';
  }
  if (c.tail === null || c.tail === undefined) {
    return 'its transcript could not be read';
  }
  if (!c.activity?.length || c.activity.some((at) => !Number.isFinite(at))) {
    return 'its last activity could not be read';
  }
  const latest = Math.max(...c.activity);

  if (now - latest < IDLE_MS) {
    return 'active in the last 30 minutes';
  }
  const loud = (c.children || []).find((args) => !QUIET_CHILD.test(args));

  if (loud !== undefined) {
    return 'something is running under claude';
  }
  if (c.crons > 0 && now - latest < CRON_LIFETIME_MS) {
    return 'a cron has not been deleted';
  }

  return inProgress(c.tail, now, latest);
}

function tmux(...args) {
  return execFileSync('tmux', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function mtimeOf(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return NaN;
  }
}

function tailOf(file) {
  let fd;

  try {
    fd = fs.openSync(file, 'r');
    const { size } = fs.fstatSync(fd);
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);

    fs.readSync(fd, buffer, 0, length, size - length);

    return buffer.toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

function countOf(text, name) {
  return text.split(`"name":"${ name }"`).length - 1;
}

/** Whole, unlike the tail: a cron set long ago still fires. Only asked of what is otherwise idle. */
function cronsIn(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');

    return countOf(text, 'CronCreate') - countOf(text, 'CronDelete');
  } catch {
    return 1;
  }
}

function processes() {
  return execFileSync('ps', ['-eo', 'pid=,ppid=,comm=,args='], { encoding: 'utf8', maxBuffer: 1e8 }).split('\n').map((line) => {
    const row = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);

    return row && {
      pid: Number(row[1]), parent: Number(row[2]), comm: row[3], args: row[4]
    };
  }).filter(Boolean);
}

function underneath(all, pid) {
  const found = [];
  const stack = [pid];

  while (stack.length) {
    const at = stack.pop();

    for (const child of all.filter((p) => p.parent === at)) {
      found.push(child);
      stack.push(child.pid);
    }
  }

  return found;
}

/** Everything `decide` needs, from the pod. */
function readConversation(id, row, clients, all) {
  const pane = Number(row.pane);
  const claudes = all.filter((p) => p.parent === pane && p.comm === 'claude');
  const conversation = (() => {
    try {
      return fs.readFileSync(path.join(SESSIONS, `${ id }.id`), 'utf8').trim();
    } catch {
      return '';
    }
  })();
  let transcript = '';
  let hookMs = NaN;

  try {
    const state = JSON.parse(fs.readFileSync(path.join(SESSIONS, `${ id }.state.json`), 'utf8'));

    hookMs = Date.parse(state.at);
    transcript = path.basename(state.transcript || '') === `${ conversation }.jsonl` ? state.transcript : '';
  } catch { /* no transcript to read keeps it, below */ }

  const tail = transcript ? tailOf(transcript) : null;
  const subagents = (() => {
    try {
      const dir = `${ transcript.replace(/\.jsonl$/, '') }/subagents`;

      return fs.readdirSync(dir).map((file) => mtimeOf(path.join(dir, file)));
    } catch {
      return [];
    }
  })();

  return {
    command:  row.command,
    windows:  Number(row.windows),
    claudes:  claudes.length,
    children: claudes.flatMap((claude) => underneath(all, claude.pid)).map((p) => p.args),
    conversation,
    queued:   fs.existsSync(path.join(path.dirname(SESSIONS), '.queue', id)),
    tail,
    crons:    transcript ? cronsIn(transcript) : 1,
    activity: [Number(row.activity) * 1000, lastStampMs(tail), hookMs, ...subagents, ...(clients.get(`mc-${ id }`) || [])],
  };
}

function main(dryRun) {
  const now = Date.now();
  const all = processes();
  const clients = new Map();

  for (const line of tmux('list-clients', '-F', '#{session_name}|#{client_activity}').split('\n')) {
    const [session, at] = line.split('|');

    if (session) {
      clients.set(session, [...(clients.get(session) || []), Number(at) * 1000]);
    }
  }
  // Not tabs: tmux writes a control character in a format's output as an underscore.
  const format = '#{session_name}|#{pane_pid}|#{session_windows}|#{session_activity}|#{pane_start_command}';
  let closed = 0;

  for (const line of tmux('list-panes', '-a', '-F', format).split('\n')) {
    const [session, pane, windows, activity, ...command] = line.split('|');
    const id = /^mc-([A-Za-z0-9_-]+)$/.exec(session || '')?.[1];

    if (!id) {
      continue;
    }
    const why = decide(readConversation(id, {
      pane, windows, activity, command: command.join('|')
    }, clients, all), now);

    if (why) {
      console.log(`KEEP ${ id }: ${ why }`);
    } else if (closed >= CLOSES_PER_PASS) {
      console.log(`LATER ${ id }`);
    } else {
      closed += 1;
      console.log(`${ dryRun ? 'WOULD-REST' : 'RESTED' } ${ id }`);
      if (!dryRun) {
        // First, so the hook knows this exit is not news and the listing never calls it finished.
        fs.writeFileSync(path.join(SESSIONS, `${ id }.resting`), `${ new Date(now).toISOString() }\n`);
        tmux('kill-session', '-t', session);
      }
    }
  }
  console.log('@@END');
}

// By real path: /seed is a ConfigMap, so this file is a symlink, and import.meta.url is what it
// points at while argv is the link. Compared plainly they never match and this does nothing, silently.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main(process.argv.includes('--dry-run'));
}
