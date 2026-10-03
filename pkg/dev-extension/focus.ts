// Focus: the queue as a deck of cards, one thing at a time.
//
// My Work's Priority tab answers "what should I do next" as a table. This is the same answer as
// a thing to work through: the top of the queue is a card that fills the screen, you deal with
// it, and the next one comes up. The ranking is the same ranking - priority.ts, unchanged - so
// the two views cannot disagree about what matters.
//
// Four things are data rather than code, and all four live in one ConfigMap (dev-api: /focus):
//
//   - **the cards**: what a kind of work looks like when it is in front of you, and what the
//     buttons on it do. A card is matched to the rules of the queue it draws from, so adding a
//     kind of work to the queue and giving it a face are two separate changes.
//   - **the weights**: what each rule in priority.ts is worth. The queue reads them; the panel
//     writes them; nothing is recompiled.
//   - **the tasks**: things somebody wrote down that no system knows about. They enter the
//     queue beside everything else and are ranked with it.
//   - and, per person rather than per product, **the pins and the snoozes** (prefs.ts): what
//     has been pulled out of the deck to sit beside it, and what has been put off until later.
//
// Defaults are in this file, not in the ConfigMap. An empty document means the shipped cards,
// which is what makes the feature work on a cluster nobody has configured - and what makes
// "reset this card" mean something.

import { devApi } from './reviews';
import { readPrefs, savePrefs } from './prefs';
import type { FocusPrefs } from './prefs';
import { RULES, weightOf } from './priority';
import type { PriorityItem, Weights } from './priority';
import type { Artifact } from './focus-artifacts';

/** The five kinds of thing that can want you, each with a hue. See design/focus.css. */
export type FocusKind = 'review' | 'issue' | 'agent' | 'question' | 'signal';

export const KINDS: FocusKind[] = ['review', 'issue', 'agent', 'question', 'signal'];

/**
 * What a button on a card does.
 *
 * The first five are what a person does with anything that is waiting on them: go to it, open it
 * where it lives, ask about it, put it aside, say it is dealt with. Most of what a card needs is
 * one of those with a different prompt, which is why a new kind of card is usually a definition
 * and not new code.
 *
 * The rest are the things that are typical of one kind of work and of nothing else, and each one
 * exists because the alternative was a button that sent you somewhere to do it by hand: picking
 * up a review, starting a fix, opening the build that is already running, posting the review the
 * agent wrote, merging what has been approved.
 *
 * The last two of those leave this cluster - they write to GitHub - so they ask first. See
 * `confirm`, and FocusCard, which draws such a button as two presses rather than one.
 */
export type ActionVerb =
  | 'open' | 'url' | 'ask' | 'snooze' | 'done'
  | 'share' | 'review' | 'fix' | 'post' | 'merge'
  | 'create-pr' | 'describe' | 'ready'
  /* The two actions that are about a list rather than a subject: see the `bumps` card... */
  | 'merge-green'
  /* ...and `ask-reviewers`, which asks everybody the card suggested. See CardReviewers. */
  | 'ask-all';

export interface CardAction {
  label: string;
  verb: ActionVerb;
  /** For `ask`: what is put into the conversation. `{what} {title} {workspace} {why}` resolve. */
  prompt?: string;
  /** For `snooze`: how long. */
  hours?: number;
  /**
   * Ask before doing it.
   *
   * For the two verbs that reach GitHub. A review posted is a review everybody can see, and a
   * merge is not undone by pressing the button again; neither should be one stray click away in
   * a view whose whole motion is clicking through cards quickly.
   */
  confirm?: boolean;
  /** For `share`: which build to open. */
  kind?: 'dashboard' | 'storybook';
  /**
   * Only offer it when the work is in this state.
   *
   * Because an action that cannot be taken is worse than no action: the advisory card offered
   * "Take the patch" on an advisory whose own facts said "no patch yet", and its prompt sent an
   * agent off to run my-dependabot-fix and open a pull request for a patch that does not exist.
   * The fact was already on the card - `AdvisoryFacts.patched`, which `priority.ts` branches the
   * rule's own wording on - so the button can read the same field the sentence above it reads.
   *
   * One name per state rather than an expression language: a condition you can read out loud is
   * the point, and FocusCard resolves them in five lines. See `visible` there.
   *
   * `mergeable` is the bumps card's version of the same fault: `Merge the green ones` filtered the
   * majors out and then refused, so on a pile whose own lede read `0 of 9 ready to merge` the 44px
   * primary behind a two-press confirm could only ever produce an error message.
   *
   * `anyKept` is the third and the worst of the three. `Post the review` was live on arrival on
   * every review-pass card, and every review-pass card arrives at `0 of 2 decided · 0 to post`:
   * pressing it posted nothing ("Nothing was left to post.") and then marked the card done, so the
   * card's one decision dismissed the work. With nothing kept the primary falls through to "Which
   * ones matter?", which is the right first move at nought decided.
   */
  when?: 'patched' | 'unpatched' | 'mergeable' | 'anyKept' | 'suggested';
}

/**
 * The one number a card is about, named rather than written out.
 *
 * Every kind in the deck has exactly one - 928 days open, 6 of 46 checks failing, 0 of 8 findings
 * decided, 1 green of 9 bumps, 100 issues nobody has taken, HIGH - and all of them were 18-26px
 * pills lost in a row of equals, while `--t-xl`, `--t-2xl` and `--t-3xl` were declared and used by
 * nothing in the deck. A view whose premise is one thing at a time should have one thing you can
 * read from across the room, so a card says which of its numbers that is and FocusCard sets it at
 * 36px. Named here rather than computed here because the value comes off the artifacts, which this
 * file does not read; see `lede` in FocusCard for the resolution.
 */
export type CardLede =
  | 'waited' | 'checks' | 'findings' | 'comments' | 'files' | 'commits' | 'bumps' | 'pool' | 'severity'
  /* The commits that arrived after your review, for the card about a second look. See `newSince`. */
  | 'fresh';

/**
 * Which of a card's wants is its subject, named rather than ranked.
 *
 * FocusCard had an order over *artifacts* - an agent's question beats a pool beats a pile of bumps
 * beats a pass beats the talk beats the diff - and picked whichever was present. That is the wrong
 * thing to rank the moment two cards ask for the same artifacts and are about different halves of
 * them, and two cards were paying for it:
 *
 *   - `red-pr` asks for `checks`, `stat` and `files`. The ladder had no rung for the checks, so the
 *     card whose entire summary line is "Fix the build - 6 of 46 checks failing" drew a 45-file
 *     diff, and the names of the three red e2e suites were readable in a 26px popover and nowhere
 *     else. That is what you read before pressing "Fix it".
 *   - `start-fix` is an issue's own words, and the screenshot the issue is about is in its
 *     comments - so the moment it asked for them, `talk` would have outranked the words on the
 *     ladder and replaced the card's subject with its evidence.
 *
 * So a card may say, the same way it already says which of its numbers is the lede. `said` is the
 * prose as the surface, which is what an issue is. Where the named one has not arrived the ladder
 * still answers, so this is a preference and never a blank card.
 */
export type CardSurface =
  | 'agent' | 'pool' | 'bumps' | 'facts' | 'pass' | 'who' | 'talk' | 'files' | 'commits'
  | 'checks' | 'said' | '';

/**
 * One card: how a kind of work looks when it is the thing in front of you.
 *
 * `rules` is the join to the queue. A card claims the rules it draws, so the deck is the queue
 * with a face on each item rather than a second list that has to be kept in step. An item whose
 * rule no card claims still appears - see `fallback` - because a queue that silently drops what
 * it cannot draw is a queue you cannot trust.
 */
export interface CardDef {
  id: string;
  label: string;
  kind: FocusKind;
  /**
   * The word on the chip, when the kind's own name is not what this card is.
   *
   * Fifteen kinds of card share five hues, so the chip - the one thing on a card whose job is
   * to say what kind of card it is - said "Issue" on a dependency bump and "Signal" on both a
   * failing build and a security advisory. The hue stays five; the word is the card's.
   */
  chip?: string;
  /** Which of this card's numbers is the headline. See CardLede; nothing is a fine answer. */
  lede?: CardLede;
  /** Which of its wants is the subject. See CardSurface; nothing means the ladder decides. */
  surface?: CardSurface;
  /** Rule ids from priority.ts. */
  rules: string[];
  /** The line under the title. `{why}` by default, which is what the rule said. */
  summary: string;
  /**
   * What to put in front of you, from focus-artifacts.ts.
   *
   * The join to everything a card shows below its title, and a definition rather than code so
   * that changing what a kind of work puts on the table is the same act as changing its buttons
   * - something an agent can be asked to do. Only the card on top is read, so this is also the
   * budget: a card that asks for everything costs a pull request's worth of calls every time it
   * reaches the top of the deck.
   */
  wants?: Artifact[];
  actions: CardAction[];
}

/** A task somebody wrote down. It enters the queue like anything else and is ranked with it. */
export interface ManualTask {
  id: string;
  title: string;
  /** What it wants from you, in the words you would use. */
  needs: string;
  why: string;
  /** What it is worth, against the rules in RULES. */
  score: number;
  kind: FocusKind;
  /** Where to look, if anywhere. */
  url: string;
  /** The workspace it belongs to, if any. */
  workspace: string;
  created: string;
}

/** Everything the Focus view is configured with. */
export interface FocusConfig {
  /**
   * The cards, projected from the loaded modules - not read or written by the config document.
   *
   * It kept a `cards.json` key for a while and nothing ever wrote one. Cards are modules now, so
   * the document holds only the two things that are not cards: how the queue is weighted, and the
   * tasks somebody typed in by hand.
   */
  cards: CardDef[];
  weights: Weights;
  tasks: ManualTask[];
}

// ── Where the cards are ─────────────────────────────────────────────────────────────────────
//
// Not here any more. Nineteen `CardDef` literals stood in this file, each paired with one of
// eleven bodies hard-wired into FocusCard - a card was a declaration in one place and markup in
// another, and a card somebody wanted to change was neither. They are modules now, one file each
// in `cards/`, packed into `cards.generated.ts` and evaluated at runtime through the same loader
// that reads a card out of a ConfigMap. See focus-cards.ts.
//
// `CardDef` itself stays, as the shape the deck reads: `cardOf` below projects a loaded module
// into it. That is not a second format - nothing authors a CardDef - it is the deck's own
// interface to a card, and keeping it is what let nineteen cards move without rewriting the deck.


// ── The document ────────────────────────────────────────────────────────────────────────────

export async function readFocusConfig(): Promise<FocusConfig> {
  const got = await devApi('/focus').catch(() => null);

  return {
    // Filled by the caller from the loaded modules; see focus-cards.ts and Focus.vue.
    cards:   [],
    weights: got?.weights && typeof got.weights === 'object' ? got.weights : {},
    tasks:   Array.isArray(got?.tasks) ? got.tasks : [],
  };
}

/** Write one part of it; the other two keep what they were. */
export async function saveFocusConfig(part: Partial<FocusConfig>): Promise<void> {
  await devApi('/focus', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(part),
  });
}

// ── Pins and snoozes, which are one person's ────────────────────────────────────────────────

/** What one person has put aside or pulled out; kept with their other preferences. */
export type FocusState = FocusPrefs;

/** How long "done" hides something that the queue still believes in. See sweepState. */
const DONE_HOURS = 12;

export async function readFocusState(): Promise<FocusState> {
  return (await readPrefs().catch(() => null))?.focus || { pinned: [], snoozed: {}, done: {} };
}

export async function saveFocusState(state: FocusState): Promise<void> {
  await savePrefs({ focus: sweepState(state) });
}

/**
 * What is still worth remembering.
 *
 * A snooze that has come round and a "done" older than half a day are both over, and a state
 * that only ever grew would be a list of every key this person has ever seen.
 */
export function sweepState(state: FocusState): FocusState {
  const now = Date.now();
  const keep = (at: string, hours: number) => {
    const when = Date.parse(at);

    return Number.isFinite(when) && now - when < hours * 3600 * 1000;
  };

  return {
    pinned:  state.pinned,
    snoozed: Object.fromEntries(Object.entries(state.snoozed).filter(([, at]) => Date.parse(at) > now)),
    done:    Object.fromEntries(Object.entries(state.done).filter(([, at]) => keep(at, DONE_HOURS))),
  };
}

// ── The deck ────────────────────────────────────────────────────────────────────────────────

/** One thing waiting on you, with the card that draws it. */
export interface FocusTask extends PriorityItem {
  /** The queue's key, under the name the deck's components use for it. */
  id: string;
  card: CardDef;
  /** The rule's own line, for the card to say why it is here at all. */
  about: string;
  /** How long it has been waiting, in hours; the card marks anything old. */
  waitingHours: number;
  pinned: boolean;
  /** When it comes back, for the ones that are put away. */
  snoozedUntil: string;
}

function fill(template: string, item: PriorityItem): string {
  return String(template || '').replace(/\{(\w+)\}/g, (whole, key) => {
    const value = (item as unknown as Record<string, unknown>)[key];

    return value === undefined || value === null ? whole : String(value);
  });
}

/** The card that claims this item's rule, or the one that claims nothing. */
/**
 * A loaded module, as the deck reads it.
 *
 * Every field the deck and the shell use, taken off the module with a default for anything a card
 * left out - because a card is written by hand now, in a text box, and a missing `summary` should
 * draw the rule's own line rather than throw. `actions` may be an array or a function of the api:
 * the nineteen ported cards kept their arrays, and a card that wants to decide its buttons from
 * what it loaded returns a function. See `actionsFrom` in card-api.ts, which calls it.
 */
export function cardOf(id: string, module: any): CardDef {
  return {
    id,
    label:   String(module?.label || id),
    kind:    (module?.kind || 'signal') as FocusKind,
    chip:    module?.chip,
    lede:    module?.lede,
    surface: module?.surface,
    rules:   Array.isArray(module?.rules) ? module.rules : [],
    summary: String(module?.summary || '{why}'),
    wants:   Array.isArray(module?.wants) ? module.wants : [],
    actions: Array.isArray(module?.actions) ? module.actions : [],
  };
}

/**
 * Which card draws this rule, and the one that draws whatever nothing claims.
 *
 * `fallback` is found by id rather than by being the last entry, because the cards arrive as an
 * unordered map now. A deck with no `fallback` card at all would silently drop work, so this
 * builds a bare one rather than returning undefined.
 */
export function cardFor(cards: CardDef[], rule: string): CardDef {
  return cards.find((card) => (card.rules || []).includes(rule))
    || cards.find((card) => card.id === 'fallback')
    || {
      id: 'fallback', label: 'Anything with no card of its own', kind: 'signal', rules: [], summary: '{why}', actions: [],
    };
}

/** A manual task as the queue sees it. */
export function manualItem(task: ManualTask): PriorityItem {
  return {
    key:       `manual:${ task.id }`,
    what:      'Yours',
    title:     task.title,
    needs:     task.needs,
    why:       task.why,
    workspace: task.workspace || '',
    url:       task.url || '',
    rule:      'manual',
    score:     Number.isFinite(task.score) ? task.score : weightOf('manual'),
    since:     task.created || '',
  };
}

/**
 * The deck: the queue, drawn.
 *
 * Snoozed and done are dropped rather than greyed - the point of this view is that what is in
 * front of you is what you are doing - and pinned ones are kept, marked, for the rail beside
 * the deck to show. Everything else is the queue in the queue's own order.
 */
export function focusDeck(items: PriorityItem[], config: FocusConfig, state: FocusState): FocusTask[] {
  const now = Date.now();

  return items
    .filter((item) => !state.done[item.key])
    .filter((item) => {
      const until = state.snoozed[item.key];

      return !until || Date.parse(until) <= now;
    })
    .map((item) => {
      const card = cardFor(config.cards, item.rule);
      const since = Date.parse(item.since || '');

      return {
        ...item,
        id: item.key,
        card,
        about:        RULES[item.rule]?.about || '',
        summary:      fill(card.summary || '{why}', item),
        waitingHours: Number.isFinite(since) ? Math.max(0, Math.round((now - since) / 3600000)) : 0,
        pinned:       state.pinned.includes(item.key),
        snoozedUntil: '',
      } as FocusTask & { summary: string };
    });
}

/** What a button says, with the item's own words in it. */
export function actionPrompt(action: CardAction, task: FocusTask): string {
  return fill(action.prompt || '', task);
}

// ── The weights, as something to look at ────────────────────────────────────────────────────

/** One rule, what it is worth, and what it is holding right now. */
export interface WeightRow {
  id: string;
  label: string;
  about: string;
  /** What it ships as. */
  shipped: number;
  /** What it is worth now. */
  score: number;
  /** How many things in the queue this rule put there. */
  count: number;
}

export function weightRows(items: PriorityItem[], weights: Weights): WeightRow[] {
  const counts = new Map<string, number>();

  for (const item of items) {
    counts.set(item.rule, (counts.get(item.rule) || 0) + 1);
  }

  return Object.entries(RULES)
    .map(([id, rule]) => ({
      id,
      label:   rule.label,
      about:   rule.about,
      shipped: rule.score,
      score:   Number.isFinite(weights[id]) ? Number(weights[id]) : rule.score,
      count:   counts.get(id) || 0,
    }))
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
}
