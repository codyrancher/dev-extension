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
  | 'share' | 'review' | 'fix' | 'post' | 'merge';

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
}

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
  cards: CardDef[];
  weights: Weights;
  tasks: ManualTask[];
}

// ── What ships ──────────────────────────────────────────────────────────────────────────────
//
// One card per family of rules, which in practice is one per stage of the two workflows plus
// the things that have no workspace. The prompts are written as if to somebody who has just
// been handed the work, because that is what they are.

export const SHIPPED_CARDS: CardDef[] = [
  {
    id:      'answer-agent',
    label:   'An agent is waiting on you',
    kind:    'question',
    rules:   ['agent-question'],
    summary: '{why}',
    wants:   ['body', 'media'],
    actions: [
      { label: 'Open the conversation', verb: 'open' },
      { label: 'Summarise what it asked', verb: 'ask', prompt: 'The agent in {workspace} has stopped and is waiting on an answer. Read the last few turns of its conversation and tell me, in three lines, what it is asking and what the options are.' },
      { label: 'Later', verb: 'snooze', hours: 4 },
    ],
  },
  {
    id:      'review-pass',
    label:   'Findings waiting for your pass',
    kind:    'review',
    rules:   ['review-findings', 'review-response', 'review-agent'],
    summary: '{why}',
    wants:   ['notes', 'stat', 'checks', 'media'],
    actions: [
      { label: 'Post the review', verb: 'post', confirm: true },
      { label: 'Open the review', verb: 'open' },
      { label: 'Which ones matter?', verb: 'ask', prompt: 'For {what} in {workspace}: go through the findings the review agent produced and tell me which are worth filing and which are noise, with a line of reasoning each. Do not file anything.' },
      { label: 'Later', verb: 'snooze', hours: 8 },
    ],
  },
  {
    id:      'fix-feedback',
    label:   'Review comments to answer',
    // A review, not agent work. The chip is the first thing read on a card, and `agent` said this
    // was something an agent was doing - when what it is is a human reviewer waiting on you.
    kind:    'review',
    rules:   ['fix-feedback'],
    summary: '{why}',
    wants:   ['comments', 'stat', 'checks', 'media'],
    actions: [
      { label: 'Answer the comments', verb: 'ask', prompt: 'For {what} in {workspace}: go through every review comment that has not been answered, and for each one draft a reply and say whether it needs a code change. Do not push anything.' },
      { label: 'Open the workspace', verb: 'open' },
      { label: 'Open the pull request', verb: 'url' },
      { label: 'Later', verb: 'snooze', hours: 8 },
    ],
  },
  {
    id:      'draft-pr',
    label:   'A draft waiting to be read',
    kind:    'agent',
    rules:   ['fix-draft', 'fix-no-pr', 'mine-draft-green'],
    summary: '{why}',
    wants:   ['files', 'stat', 'checks', 'media', 'live'],
    actions: [
      { label: 'Open the pull request', verb: 'url' },
      { label: 'Open the build', verb: 'share', kind: 'dashboard' },
      { label: 'Walk me through it', verb: 'ask', prompt: 'For {what} in {workspace}: walk me through what the agent changed, file by file, and tell me what you would want a human to check before this goes up for review.' },
      { label: 'Later', verb: 'snooze', hours: 8 },
    ],
  },
  {
    id:      'my-pr',
    label:   'Your own pull request',
    kind:    'signal',
    rules:   ['mine-approved', 'mine-red'],
    summary: '{why}',
    wants:   ['checks', 'stat', 'files'],
    actions: [
      { label: 'Merge it', verb: 'merge', confirm: true },
      { label: 'Open it', verb: 'url' },
      { label: 'Why is it red?', verb: 'ask', prompt: 'For {what}: read the failing checks and tell me what is actually broken, whether it is mine, and the smallest change that would fix it.' },
      { label: 'Later', verb: 'snooze', hours: 6 },
    ],
  },
  {
    id:      'review-asked',
    label:   'A review somebody asked you for',
    kind:    'review',
    rules:   ['reviewing-asked', 'reviewing-pushed', 'reviewing-open'],
    summary: '{why}',
    wants:   ['files', 'stat', 'checks', 'live', 'body'],
    actions: [
      { label: 'Start a review workspace', verb: 'review' },
      { label: 'Open the build', verb: 'share', kind: 'dashboard' },
      { label: 'Open the pull request', verb: 'url' },
      { label: 'What changed?', verb: 'ask', prompt: 'For {what} ({title}): read the diff and tell me in five lines what it changes, what it touches that I should be careful about, and what I should check by hand.' },
      { label: 'Later', verb: 'snooze', hours: 12 },
    ],
  },
  {
    id:      'start-fix',
    label:   'An issue to pick up',
    kind:    'issue',
    rules:   ['issue-started'],
    summary: '{why}',
    wants:   ['body'],
    actions: [
      { label: 'Start the fix', verb: 'fix' },
      { label: 'Open the issue', verb: 'url' },
      { label: 'Is this well specified?', verb: 'ask', prompt: 'For {what} ({title}): read the issue and tell me whether it says enough to be fixed, what is missing, and where in the codebase it probably lives.' },
      { label: 'Later', verb: 'snooze', hours: 24 },
    ],
  },
  {
    id:      'stalled',
    label:   'Something that stopped',
    kind:    'signal',
    rules:   ['stalled'],
    summary: '{why}',
    wants:   ['body', 'media', 'checks'],
    actions: [
      { label: 'What happened?', verb: 'ask', prompt: 'The work in {workspace} stopped. Read the end of its conversation and its last output, and tell me what it was doing, why it stopped, and what would get it going again.' },
      { label: 'Open the workspace', verb: 'open' },
      { label: 'Later', verb: 'snooze', hours: 4 },
    ],
  },
  {
    id:      'advisory',
    label:   'A security advisory',
    kind:    'signal',
    rules:   ['advisory-critical', 'advisory-high', 'advisory-medium', 'advisory-low'],
    summary: '{why}',
    wants:   ['body'],
    actions: [
      { label: 'Open the advisory', verb: 'url' },
      { label: 'Take the patch', verb: 'ask', prompt: 'Use the my-dependabot-fix skill for {what}: take the patch, run what the change touches, and open the pull request.' },
      { label: 'Later', verb: 'snooze', hours: 48 },
    ],
  },
  {
    id:      'bump',
    label:   'A dependency bump',
    kind:    'issue',
    rules:   ['bot-cleared', 'bot-stopped', 'bot-green', 'bot-red'],
    summary: '{why}',
    wants:   ['stat', 'checks', 'files'],
    actions: [
      { label: 'Merge it', verb: 'merge', confirm: true },
      { label: 'Open the pull request', verb: 'url' },
      { label: 'Is it safe?', verb: 'ask', prompt: 'For {what}: read the changelog between the two versions and the diff, and tell me whether anything in this repository uses what changed. Say plainly whether you would merge it.' },
      { label: 'Later', verb: 'snooze', hours: 24 },
    ],
  },
  {
    id:      'manual',
    label:   'Something you wrote down',
    kind:    'issue',
    rules:   ['manual'],
    summary: '{why}',
    wants:   [],
    actions: [
      { label: 'Done', verb: 'done' },
      { label: 'Think it through with me', verb: 'ask', prompt: 'I have this on my list: "{title}" — {why}. Ask me whatever you need to, then tell me the first concrete step.' },
      { label: 'Later', verb: 'snooze', hours: 24 },
    ],
  },
];

/** What draws an item no card has claimed. Never configured away; see CardDef. */
export const FALLBACK_CARD: CardDef = {
  id:      'fallback',
  label:   'Anything with no card of its own',
  kind:    'signal',
  rules:   [],
  summary: '{why}',
  actions: [
    { label: 'Open it', verb: 'url' },
    { label: 'What is this?', verb: 'ask', prompt: 'Tell me what {what} is and what it is waiting on from me.' },
    { label: 'Later', verb: 'snooze', hours: 12 },
  ],
};

// ── The document ────────────────────────────────────────────────────────────────────────────

export async function readFocusConfig(): Promise<FocusConfig> {
  const got = await devApi('/focus').catch(() => null);

  return {
    cards:   Array.isArray(got?.cards) && got.cards.length ? got.cards : SHIPPED_CARDS,
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
export function cardFor(cards: CardDef[], rule: string): CardDef {
  return cards.find((card) => (card.rules || []).includes(rule)) || FALLBACK_CARD;
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
