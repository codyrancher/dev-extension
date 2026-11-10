/**
 * Which automations an event sets off, and why the others it reached did not run.
 *
 * An automation is the definition agent-defs.ts keeps (`dev-agent-<name>`): an action - an agent
 * conversation or a script - and its triggers. The trigger this file is about is `event`: a source,
 * the event names it listens for, and constraints, one JavaScript expression per line, every one
 * of which has to hold. One per line rather than one long `&&` so that when an event reaches an
 * automation and does not run it, the page can say exactly which constraint stopped it.
 *
 * The constraints are run by whoever passes `check`: dev-api in a `vm` context with a time limit
 * (the definitions are ConfigMaps in dev-system, as trusted as the prompts beside them), and the
 * editor in the browser, to try them against recent events before saving. This file never runs
 * code itself. Pure, for the tests: tests/automation-rules.test.mjs.
 */

/** How many runs one automation may start from one batch of events. */
export const AUTOMATION_BURST = 3;

/** A script's default and longest time to run, in seconds. */
export const SCRIPT_TIMEOUT_S = 600;
export const SCRIPT_TIMEOUT_MAX_S = 3600;

/** Every trigger a definition has: its list, or the one a definition from before 0.3.17 had. */
export function triggersOfDef(def) {
  if (Array.isArray(def?.triggers) && def.triggers.length) {
    return def.triggers;
  }

  return def?.trigger ? [def.trigger] : [{ type: 'manual' }];
}

/**
 * What an automation does: an agent conversation unless it says otherwise. A script runs in the
 * agent pod; a review is what My Work's Review button does with the event's pull request.
 */
export function actionOf(def) {
  return def?.action === 'script' || def?.action === 'review' ? def.action : 'agent';
}

/** The pull request an event is about, or null: what a review automation needs to have one. */
export function pullRequestOf(event) {
  const p = event?.payload || {};

  return p.kind === 'pr' && Number(p.number) > 0 && /^[\w.-]+\/[\w.-]+$/.test(String(p.repo || ''))
    ? { repo: String(p.repo), number: Number(p.number), title: String(p.title || event.title || '') }
    : null;
}

const listOf = (value) => (Array.isArray(value) ? value : String(value || '').split(/[,\s]+/)).map((x) => String(x || '').trim()).filter(Boolean);

/**
 * The two lists a trigger can narrow GitHub events by, before any constraint: which repositories,
 * and whose work (the issue's or pull request's author). Each empty is all of them. Wildcards as
 * in names - `rancher/*` - and case does not matter, since GitHub's does not.
 */
export function listFailure(spec, event) {
  const p = event?.payload || {};
  const repos = listOf(spec?.repos);
  const authors = listOf(spec?.authors).map((a) => a.replace(/^@/, ''));
  const lower = (xs) => xs.map((x) => x.toLowerCase());

  if (repos.length && !nameMatches(lower(repos), String(p.repo || '').toLowerCase())) {
    return { outcome: 'blocked', list: 'repos', reason: `${ p.repo || 'It has no repository, and so' } is not one of its repositories (${ repos.join(', ') }).` };
  }
  if (authors.length && !nameMatches(lower(authors), String(p.author || '').toLowerCase())) {
    return { outcome: 'blocked', list: 'authors', reason: `${ p.author ? `@${ p.author }` : 'It has no author, and so' } is not one of its authors (${ authors.map((a) => `@${ a }`).join(', ') }).` };
  }

  return null;
}

/**
 * Whether an event name is one of the patterns. `*` is any run of characters, so `pr.*` is every
 * pull request event and `*.commented` is a comment on anything. No patterns is every name.
 */
export function nameMatches(patterns, name) {
  const list = (patterns || []).map((p) => String(p || '').trim()).filter(Boolean);

  if (!list.length) {
    return true;
  }

  return list.some((p) => new RegExp(`^${ p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') }$`).test(String(name || '')));
}

/** The constraint lines: blank lines and `//` comments are not constraints. */
export function conditionLines(src) {
  return String(src || '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//'));
}

/** Whether a trigger listens to an event at all - its source and its names - before any constraint. */
export function triggerSelects(trigger, event) {
  const spec = trigger?.event || {};

  return trigger?.type === 'event' && (!spec.source || spec.source === event.source) && nameMatches(spec.names, event.name);
}

/**
 * What an event does to one automation, or null when none of its triggers listens to it.
 *
 * `check(line)` runs one constraint and returns its value; it may throw. The answer is
 * `{ outcome, reason, condition }` with outcome one of:
 *
 *   - `run`      every constraint of a listening trigger held;
 *   - `blocked`  a repository or author list left it out (`list` says which), or a constraint
 *                was false (`condition` is the line); `reason` says which, either way;
 *   - `error`    a constraint threw - a typo, or a field this event does not have;
 *   - `disabled` the automation is switched off;
 *   - `muted`    the event is from a muted workspace.
 *
 * Several listening triggers are tried in order and the first that passes wins; when none does,
 * the first one's failure is the one reported, since that is the one written first.
 */
/**
 * @param {any} def
 * @param {any} event
 * @param {{ muted?: boolean, check?: (line: string) => unknown }} [opts]
 * @returns {{ automation: string, outcome: string, reason: string, condition?: string, list?: string } | null}
 */
export function evaluateEvent(def, event, { muted = false, check } = {}) {
  const listening = triggersOfDef(def).filter((t) => triggerSelects(t, event));

  if (!listening.length) {
    return null;
  }
  const base = { automation: def.name };

  if (def.enabled === false) {
    return { ...base, outcome: 'disabled', reason: 'The automation is disabled.' };
  }
  if (muted) {
    return { ...base, outcome: 'muted', reason: `Events from ${ event.workspace } are muted.` };
  }

  let first = null;

  for (const trigger of listening) {
    const failed = listFailure(trigger.event, event) || firstFailure(conditionLines(trigger.event?.condition), check);

    if (!failed) {
      return { ...base, outcome: 'run', reason: '' };
    }
    first = first || failed;
  }

  return { ...base, ...first };
}

function firstFailure(lines, check) {
  for (const line of lines) {
    let value;

    try {
      value = check ? check(line) : true;
    } catch (e) {
      return { outcome: 'error', condition: line, reason: `${ line } threw: ${ e?.message || e }` };
    }
    if (!value) {
      return { outcome: 'blocked', condition: line, reason: `${ line } was ${ describe(value) }` };
    }
  }

  return null;
}

function describe(value) {
  if (value === undefined) {
    return 'undefined';
  }
  if (value === '') {
    return 'an empty string';
  }

  return String(value);
}

/** What a constraint can name: the event, its payload, the GitHub login, and short aliases. */
export function conditionScope(event, me = '') {
  const copy = JSON.parse(JSON.stringify(event || {}));
  const payload = copy.payload || {};

  return {
    event: copy, e: copy, payload, p: payload, me: String(me || ''), workspace: copy.workspace || '',
  };
}

/**
 * Fill `{{ path }}` placeholders from `vars`: `{{event.subject}}`, `{{payload.comment.body}}`,
 * and the resource trigger's flat `{{name}}`. An object is written as JSON; a path that names
 * nothing is left as written, so a typo shows in the conversation rather than vanishing.
 */
export function fillTemplate(text, vars) {
  return String(text || '').replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (whole, path) => {
    let at = vars;

    for (const part of path.split('.')) {
      if (at === null || at === undefined || typeof at !== 'object' || !(part in at)) {
        return whole;
      }
      at = at[part];
    }
    if (at === null || at === undefined) {
      return '';
    }

    return typeof at === 'object' ? JSON.stringify(at, null, 2) : String(at);
  });
}

const WEEKDAYS = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6
};

/**
 * The cron fields of a moment, in a time zone. The schedule is written in the time of the person
 * who wrote it, and this runs in a pod on UTC, so the zone is saved with the definition.
 */
export function cronFields(at, tz = 'UTC') {
  let parts;

  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz || 'UTC', hour12: false, minute: 'numeric', hour: 'numeric', day: 'numeric', month: 'numeric', weekday: 'short',
    }).formatToParts(at);
  } catch {
    return cronFields(at, 'UTC');
  }
  const get = (type) => parts.find((p) => p.type === type)?.value || '';

  return {
    minute:  Number(get('minute')),
    hour:    Number(get('hour')) % 24,
    day:     Number(get('day')),
    month:   Number(get('month')),
    weekday: WEEKDAYS[get('weekday')] ?? 0,
  };
}

function fieldMatches(field, value, low) {
  return String(field).split(',').some((part) => {
    const [range, stepText] = part.trim().split('/');
    const step = stepText ? Number(stepText) : 1;
    let lo = low;
    let hi = 99;

    if (range !== '*') {
      if (range.includes('-')) {
        [lo, hi] = range.split('-').map(Number);
      } else {
        lo = Number(range);
        hi = stepText ? 99 : lo;
      }
    }

    return Number.isFinite(lo) && value >= lo && value <= hi && (value - lo) % (step || 1) === 0;
  });
}

/** Whether five cron fields name this moment's minute, in the given zone. */
export function cronDueAt(expr, at, tz = 'UTC') {
  const f = String(expr || '').trim().split(/\s+/);

  if (f.length !== 5) {
    return false;
  }
  const t = cronFields(at, tz);

  return fieldMatches(f[0], t.minute, 0) && fieldMatches(f[1], t.hour, 0) && fieldMatches(f[2], t.day, 1) &&
    fieldMatches(f[3], t.month, 1) && fieldMatches(f[4], t.weekday, 0);
}

/** A value as one shell word, quoted so that nothing in it is read by the shell. */
export function shellQuote(value) {
  return `'${ String(value ?? '').replace(/'/g, '\'\\\'\'') }'`;
}

/** The environment a script is given, as lines a shell can source. Names are checked; values quoted. */
export function envFile(vars) {
  return `${ Object.entries(vars)
    .filter(([k]) => /^[A-Z_][A-Z0-9_]*$/.test(k))
    .map(([k, v]) => `export ${ k }=${ shellQuote(v) }`)
    .join('\n') }\n`;
}

/**
 * The wrapper a script runs in, written beside it in the run's directory and started detached in
 * the agent pod as the pane user. It records when it started and its exit status; dev-api watches
 * for the status, so the run outlives the exec that started it and a dev-api restart.
 *
 * A script that starts with `#!` runs as itself; anything else is bash (or sh, where there is no
 * bash). stdin is the event, as JSON. `timeout` ends it; 124 is the status that says so.
 */
export function scriptWrapper(dir, timeoutS) {
  const t = Math.max(5, Math.min(SCRIPT_TIMEOUT_MAX_S, Math.round(Number(timeoutS) || SCRIPT_TIMEOUT_S)));

  return [
    '#!/bin/sh',
    `D=${ shellQuote(dir) }`,
    'export HOME=/workspace/.home',
    'export PATH=/workspace/.home/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH',
    'cd /workspace/conversations 2>/dev/null || cd /workspace 2>/dev/null || cd /',
    '. "$D/env"',
    'date -u +%Y-%m-%dT%H:%M:%SZ > "$D/started"',
    'W=""; command -v timeout >/dev/null 2>&1 && W="timeout -k 10 ' + t + '"',
    'if [ "$(head -c 2 "$D/script")" = "#!" ]; then',
    '  chmod +x "$D/script"; $W "$D/script" < "$D/event.json" > "$D/output.log" 2>&1',
    'else',
    '  SH=$(command -v bash || echo /bin/sh); $W "$SH" "$D/script" < "$D/event.json" > "$D/output.log" 2>&1',
    'fi',
    'echo $? > "$D/exit.tmp" && mv "$D/exit.tmp" "$D/exit"',
    '',
  ].join('\n');
}

/** What an exit status says, for the run's line. */
export function exitNote(code) {
  if (code === 0) {
    return '';
  }
  if (code === 124 || code === 137) {
    return 'timed out';
  }

  return `exited ${ code }`;
}
