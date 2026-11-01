// Which model a conversation is on, and how to say so.
//
// Every chat surface draws the one answer `modelInfo` gives, so they cannot disagree. The rule it
// holds to: a conversation's own transcript says what ran (the fold in chat-state.mjs), and
// settings only say what a new session would start with. settings.json is shared by every pane in
// a pod and aliases like `opus[1m]` name no version, so reading it as "what is running" is how a
// chat on claude-opus-5-5 came to read `opus[1m]`. Settings are the last resort here, and marked
// as unconfirmed when they are used.
//
// Plain JavaScript and no imports, so `node --test` loads it directly: tests/chat-model.test.mjs.

const ONE_M = /\[1m\]$/i;

/**
 * An id without claude's `[1m]` context suffix. Which window a session has is not something this
 * reports, see baseModel in chat-state.mjs. Only claude's own ids and aliases carry the suffix;
 * anything else is somebody else's name and is kept whole.
 */
function baseOf(id) {
  const raw = String(id || '').trim();
  const base = raw.replace(ONE_M, '');

  return /^claude-/i.test(base) || /^[a-z]+$/.test(base) ? base : raw;
}

/**
 * The model's name and version: claude-opus-5-5 is "Opus 5.5", claude-haiku-4-5-20251001 is
 * "Haiku 4.5".
 *
 * An alias stays an alias, because `opus` names no version and inventing one is the mistake this
 * exists to stop. An id this does not recognise is shown exactly as it came.
 */
export function modelName(id) {
  const base = baseOf(id);

  if (base === '<synthetic>') {
    return '';
  }
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(base);

  if (!match) {
    return base;
  }

  return `${ match[1][0].toUpperCase() }${ match[1].slice(1) } ${ match[2] }${ match[3] ? `.${ match[3] }` : '' }`;
}

/**
 * Which menu entry an id belongs under: opus for `claude-opus-5-5[1m]` and for `opus[1m]`.
 * '' when the id does not say, which ticks nothing rather than the wrong thing.
 */
export function modelFamily(id) {
  const base = baseOf(id);
  const match = /^claude-([a-z]+)-\d/.exec(base) || /^claude-\d+(?:-\d+)?-([a-z]+)/.exec(base);

  if (match) {
    return match[1];
  }

  return /^[a-z]+$/.test(base) ? base : '';
}

/**
 * The per-model efforts out of settings.json's `modelSettings`, as `{ <id>: <level> }`.
 *
 * Takes the JSON text readOptions printed, so a blank or broken line is simply no answer.
 *
 * @returns {Record<string, string>}
 */
export function modelEffortsFrom(text) {
  try {
    /** @type {Record<string, string>} */
    const out = {};

    for (const [id, value] of Object.entries(JSON.parse(text) || {})) {
      if (typeof value?.effortLevel === 'string' && value.effortLevel) {
        out[id] = value.effortLevel;
      }
    }

    return out;
  } catch {
    return {};
  }
}

/**
 * The effort settings would give this model: its own entry, then the general one.
 *
 * modelSettings is keyed by full id without `[1m]`, so an alias finds nothing there and gets the
 * general level, which is all that can honestly be said about it.
 */
export function configuredEffort(options, id) {
  return (options?.modelEfforts || {})[baseOf(id)] || (options?.effort || '').trim();
}

const COMMAND_MARK = { model: 'modelMark', effort: 'effortMark' };

/** Remember a choice just sent, with where the transcript stood, so `settlePicked` can retire it. */
export function pickedChoice(kind, value, state) {
  return {
    value,
    command:  state?.[COMMAND_MARK[kind]] || '',
    answered: state?.answeredMark || '',
    prompt:   state?.promptMark || '',
  };
}

/**
 * Retire a choice the transcript has caught up with.
 *
 * Between the menu being used and claude writing anything, the transcript still names the old
 * value, and a poll runs every 1.5 seconds; hence a choice held apart from what is read. It ends
 * at its own command's answer, when the fold is the better source, or at a reply to a prompt newer
 * than the choice, which is the truth even if the command never answered. Replies to the prompt
 * already running do not end it, including that prompt's first: they are still the old model.
 *
 * Returns the same object when nothing changed, so a poll is not a reactive write.
 */
export function settlePicked(picked, state) {
  const answered = state?.answeredMark || '';
  const stale = (kind, one) => !!one && ((state?.[COMMAND_MARK[kind]] || '') !== one.command ||
    (answered !== one.answered && answered !== one.prompt));
  const model = stale('model', picked?.model);
  const effort = stale('effort', picked?.effort);

  if (!model && !effort) {
    return picked;
  }

  return { model: model ? null : picked.model, effort: effort ? null : picked.effort };
}

/**
 * The one answer every surface draws.
 *
 * Model: a choice just made, what claude said it set, what the transcript says ran, then settings.
 * Effort: the same order, then what settings give the model, then the last reply's level carried
 * over. No value is no effort shown. A pending model does not simply inherit the running effort:
 * that belongs to the model it is replacing, and settings can give the new one its own.
 *
 * Only a live process and a reply are "running". `~` marks anything less, in the text as well as
 * the title. `label` is for where a menu explains the mark; `spelled` says it in words, for where
 * nothing can, since a title does not exist on a phone.
 *
 * @param {{ state?: object, options?: object, picked?: object|null }} input
 */
export function modelInfo({ state = {}, options = {}, picked = null } = {}) {
  const running = state.model || '';
  const replied = state.modelFrom === 'reply';
  // No process: the transcript says what last ran, and a restart need not come back on it.
  const stopped = state.phase === 'absent' || state.phase === 'gone';
  const configured = (options.model || '').trim();
  const setBy = options.modelSource ? `set by ${ options.modelSource }` : 'configured';
  let id = '';
  let source = '';

  if (picked?.model?.value || state.pendingModel) {
    id = picked?.model?.value || state.pendingModel;
    source = 'pending';
  } else if (running) {
    id = running;
    source = stopped ? 'last' : 'running';
  } else if (configured) {
    id = configured;
    source = 'configured';
  }

  const isOnRunning = source !== 'pending' || baseOf(id) === baseOf(running);
  // Replies in this file have carried a level and this one did not: it is a model that takes none,
  // not a CLI too old to say, so settings have nothing to add.
  const takesNone = source !== 'pending' && replied && !state.effort && !!state.effortSeen;
  let effort = '';
  let effortSource = '';

  if (picked?.effort?.value || state.pendingEffort) {
    effort = picked?.effort?.value || state.pendingEffort;
    effortSource = 'pending';
  } else if (state.effort && isOnRunning) {
    effort = state.effort;
    effortSource = stopped ? 'last' : 'running';
  } else if (!takesNone && configuredEffort(options, id)) {
    effort = configuredEffort(options, id);
    effortSource = 'configured';
  } else if (state.effort) {
    effort = state.effort;
    effortSource = 'carried';
  }

  // Claude's own name for it where the fold has one for this very id, for the shapes parsing
  // cannot read; it is only ever about the model the fold reports, not one that is pending.
  const name = (source !== 'pending' && source !== 'configured' && state.modelName) || modelName(id);
  const mark = (value, confirmed) => (value && !confirmed ? `~${ value }` : value);
  const modelText = mark(name, source === 'running');
  const effortText = mark(effort, effortSource === 'running');
  const label = [modelText, effortText].filter(Boolean).join(' · ');

  const status = {
    running:    replied ? `Running ${ id }.` : `On ${ id }, no reply read yet.`,
    last:       `${ replied ? 'Last ran' : 'Last started on' } ${ id }. Nothing is running now.`,
    pending:    [
      `${ id } from the next reply.`,
      running && (replied ? `Last reply used ${ running }.` : `On ${ running } until then.`),
    ].filter(Boolean).join(' '),
    configured: `${ id }, ${ setBy }. Not confirmed by the transcript read so far.`,
  }[source] || '';
  const notes = [];

  if (state.fallbackFrom && running) {
    notes.push(`Fell back from ${ state.fallbackFrom }.`);
  }
  // Settings describe the next session, and saying so is what stops them reading as this one's.
  if (configured && source !== 'configured' && configured !== id) {
    notes.push(`New sessions start on ${ configured }, ${ setBy }.`);
  }
  const effortNote = {
    running:    'as recorded on the last reply',
    last:       'as recorded on the last reply',
    pending:    'from the next reply',
    configured: 'from settings, not confirmed',
    carried:    'carried over from the last reply, not confirmed',
  }[effortSource] || '';
  const effortLine = effort ? `Effort ${ effort }, ${ effortNote }.` : 'Effort not recorded.';
  const title = id ? [status, effortLine, ...notes].join(' ') : '';

  const words = {
    pending: 'from the next reply', configured: 'from settings', last: 'last run', carried: 'carried over',
  };
  const why = (source !== 'running' && words[source]) || (effortSource !== 'running' && words[effortSource] && `effort ${ words[effortSource] }`);
  const spelled = id ? `${ [name, effort].filter(Boolean).join(' · ') }${ why ? ` (${ why })` : '' }` : '';

  return {
    known:   !!id,
    id,
    running,
    family:  modelFamily(id),
    effort,
    source,
    effortSource,
    modelText,
    effortText,
    label,
    spelled,
    // Starts with what is on the button, so the control can be found by what it says.
    spoken:  id ? `Model: ${ spelled }. ${ title }` : '',
    status,
    effortNote,
    notes,
    title,
  };
}
