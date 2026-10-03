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
    chip:    'Agent waiting',
    label:   'An agent is waiting on you',
    kind:    'question',
    lede:    'waited',
    rules:   ['agent-question'],
    summary: '{why}',
    wants:   ['conversation', 'media'],
    actions: [
      { label: 'Open the conversation', verb: 'open' },
      { label: 'Summarise what it asked', verb: 'ask', prompt: 'The agent in {workspace} has stopped and is waiting on an answer. Read the last few turns of its conversation and tell me, in three lines, what it is asking and what the options are.' },
      { label: 'Later', verb: 'snooze', hours: 4 },
    ],
  },
  {
    id:      'review-pass',
    chip:    'Agent review',
    label:   'Findings waiting for your pass',
    kind:    'review',
    lede:    'findings',
    rules:   ['review-findings', 'review-response', 'review-agent'],
    summary: '{why}',
    /*
     * No `checks`. The whole want produced one badge - `7 passed` - on a card whose job is to
     * judge two agent findings, in a strip reading "28 FILES / +3738 ADDED / -317 REMOVED / 7
     * passed". The size of what was reviewed is context for a pass; the CI tally is not what the
     * pass is about, and it cost a check-runs call on every turn of the deck to a review card.
     */
    wants:   ['notes', 'stat', 'media'],
    /*
     * The pass is the surface, said rather than inferred: `notes` is the only thing here the
     * ladder would have picked anyway, and a card that names its subject cannot have it quietly
     * outranked by an artifact somebody adds to `wants` later.
     */
    surface: 'pass',
    actions: [
      /*
       * Gated, because it arrives ungateable. Every one of these cards is `0 of 2 decided · 0 to
       * post` on arrival, and this button posted nothing and then dismissed the card. See
       * `anyKept`.
       */
      { label: 'Post the review', verb: 'post', confirm: true, when: 'anyKept' },
      /*
       * Before `Open the review`, because the first visible action is the primary. With the post
       * gated and a nav next, the 44px kind-coloured button on arrival was `Open the review` - a
       * link dressed as the decision, which is the fault 'open-pr' and 'pick-up-work' were both
       * fixed for. At nought decided the first move is reading them; the link stays, in the quiet
       * slot the footer has for links.
       */
      { label: 'Which ones matter?', verb: 'ask', prompt: 'For {what} in {workspace}: go through the findings the review agent produced and tell me which are worth filing and which are noise, with a line of reasoning each. Do not file anything.' },
      { label: 'Open the review', verb: 'open' },
      { label: 'Later', verb: 'snooze', hours: 8 },
    ],
  },
  {
    id:      'fix-feedback',
    chip:    'Comments to answer',
    label:   'Review comments to answer',
    // A review, not agent work. The chip is the first thing read on a card, and `agent` said this
    // was something an agent was doing - when what it is is a human reviewer waiting on you.
    kind:    'review',
    lede:    'comments',
    rules:   ['fix-feedback'],
    summary: '{why}',
    wants:   ['comments', 'stat', 'checks', 'media'],
    // Answering a review is two jobs and they are not the same act: replying to what was said,
    // and changing the code it was said about. Both are offered because a reviewer's comment is
    // usually one or the other and you can tell which from reading it, which is what this card is
    // for.
    actions: [
      { label: 'Draft the replies', verb: 'ask', prompt: 'For {what} in {workspace}: go through every review comment that has not been answered, and for each one draft a reply. Say which ones need a code change and which are answered by explaining. Do not push anything.' },
      { label: 'Make the changes', verb: 'ask', prompt: 'For {what} in {workspace}: make the changes the review asked for, one commit per comment, and leave the replies for me to send. Stop and ask if a comment is ambiguous rather than guessing.' },
      { label: 'Open the workspace', verb: 'open' },
      { label: 'Open the pull request', verb: 'url' },
      { label: 'Later', verb: 'snooze', hours: 8 },
    ],
  },
  {
    id:      'draft-pr',
    chip:    'Draft',
    label:   'A draft waiting to be read',
    kind:    'agent',
    lede:    'files',
    rules:   ['fix-draft', 'mine-draft-green'],
    summary: '{why}',
    wants:   ['files', 'stat', 'checks', 'media', 'live'],
    actions: [
      { label: 'Mark it ready for review', verb: 'ready', confirm: true },
      { label: 'Open the pull request', verb: 'url' },
      { label: 'Open the build', verb: 'share', kind: 'dashboard' },
      { label: 'Walk me through it', verb: 'ask', prompt: 'For {what} in {workspace}: walk me through what the agent changed, file by file, and tell me what you would want a human to check before this goes up for review.' },
      { label: 'Later', verb: 'snooze', hours: 8 },
    ],
  },
  {
    id:    'my-pr',
    chip:  'Approved',
    label: 'Your own pull request, approved',
    kind:  'signal',
    /*
     * `mine-approved` only.
     *
     * It claimed `mine-red` as well, and `mine-red` is built with `needs: 'Fix the build'` and
     * `why: 'N of M checks failing'` (priority.ts) - so on a red pull request the card's own two
     * lines said the build was broken while the big kind-coloured primary said "Merge it", two
     * presses from a write to GitHub. The label claimed more than the data supported. They are
     * two different jobs with two different first moves, so they are two cards; see 'red-pr'.
     */
    lede:    'checks',
    rules:   ['mine-approved'],
    summary: '{why}',
    /*
     * Who approved it and what is still being said on it, which are the two things a person
     * checks before merging their own work - and the merge was justified by nothing but the
     * summary line 'approved and still open'. Both come off the single `prDetail` call this
     * card already makes (`reviewersOf` reads `detail.meta.approvedBy`, `commentsOf` the same
     * response), so neither costs a request.
     */
    wants:   ['checks', 'stat', 'files', 'reviewers', 'comments'],
    actions: [
      { label: 'Merge it', verb: 'merge', confirm: true },
      { label: 'Open it', verb: 'url' },
      { label: 'Anything left to answer?', verb: 'ask', prompt: 'For {what}: it is approved and still open. Read the review threads and tell me whether anything was asked that has not been answered, and whether you would merge it as it stands.' },
      { label: 'Later', verb: 'snooze', hours: 6 },
    ],
  },
  {
    id:    'red-pr',
    chip:  'Build failing',
    label: 'Your own pull request is red',
    kind:  'signal',
    /*
     * The other half of what 'my-pr' used to be. Same subject, opposite first move: nothing here
     * offers a merge, because the queue's own line about this work is "Fix the build".
     */
    lede:    'checks',
    rules:   ['mine-red'],
    summary: '{why}',
    wants:   ['checks', 'stat', 'files'],
    /*
     * The failures, not the diff. The card's subject is "6 of 46 checks failing" and its 173px
     * surface was "What it changed, first 40 of 45 files" - a diff you cannot work out three red
     * e2e suites from. The names and their own one-line reports are already fetched (`ciOf`), and
     * the ladder had no rung for them, so `files` always won. The diff is one press away on
     * "Open it".
     */
    surface: 'checks',
    /*
     * `Fix it` first, because the card's own summary line is the imperative "Fix the build - 6 of
     * 46 checks failing". FocusCard derives the primary purely from this order, so with the
     * diagnosis first the 44px kind-coloured button was the question and the one thing that
     * changes anything sat in the 32px ghost slot every other card uses for its optional aside.
     * The card said one thing and weighted the other.
     */
    actions: [
      { label: 'Fix it', verb: 'ask', prompt: 'For {what}: work out what the failing checks are complaining about and make the smallest change that fixes them. Run what you touched. Stop and tell me if the failure is not mine.' },
      { label: 'Why is it red?', verb: 'ask', prompt: 'For {what}: read the failing checks and tell me what is actually broken, whether it is mine, and the smallest change that would fix it.' },
      { label: 'Open it', verb: 'url' },
      { label: 'Later', verb: 'snooze', hours: 6 },
    ],
  },
  {
    id:    'review-asked',
    chip:  'Review asked',
    label: 'A review somebody asked you for',
    kind:  'review',
    /*
     * How long it has waited, not how many files it has.
     *
     * The lede is meant to be the one fact nothing else on the card says. `files` was not: the
     * surface's own header reads "What it changed, first 40 of 157 files" 150px below a 36px "157
     * files changed", while the 294 days this one has been waiting was an 11px pill. One number
     * once, and the largest type on the screen gets the one that is only written there.
     */
    lede:    'waited',
    /*
     * No `reviewing-pushed`. It is built with `needs: 'Review the new commits'` and a `newSince`,
     * and it was drawn by this card - which asks for `files` and `stat` and so showed the whole
     * pull request: 157 files, +13,281 lines, "first 40 of 157 files", with nothing marking what
     * arrived after your review. The one thing the card's own line promised was the one thing its
     * surface did not distinguish, so the second review was the first review again. Two different
     * jobs, two cards; see 'review-pushed'.
     */
    rules:   ['reviewing-asked', 'reviewing-open'],
    summary: '{why}',
    /*
     * No `live`. `fromReviewing` sets `workspace: ''` for all three of these rules, `liveOf`
     * answers `[]` for an empty workspace, and `openTheBuild` then has neither a live entry nor a
     * workspace to ask `previewState` about - so "Open the build" always fell through to "Nothing
     * is serving a build for this yet", measured dead on all seven of these cards in the live
     * deck. The want was fetched and discarded for the whole rule family. The card's own primary
     * is what makes the thing that button wanted; until it has been pressed there is nothing to
     * open, and an offer that cannot be taken is worse than no offer.
     */
    wants:   ['files', 'stat', 'checks', 'body'],
    actions: [
      { label: 'Start a review workspace', verb: 'review' },
      { label: 'Open the pull request', verb: 'url' },
      { label: 'What changed?', verb: 'ask', prompt: 'For {what} ({title}): read the diff and tell me in five lines what it changes, what it touches that I should be careful about, and what I should check by hand.' },
      { label: 'Later', verb: 'snooze', hours: 12 },
    ],
  },
  {
    id:    'review-pushed',
    chip:  'Pushed since',
    label: 'A review you have already given, pushed to',
    kind:  'review',
    /*
     * The commits that arrived after your review, which is the whole subject. `commits` would be
     * every commit on the branch - the number the first review already covered.
     */
    lede:    'fresh',
    rules:   ['reviewing-pushed'],
    summary: '{why}',
    /*
     * The commits rather than the diff, and they are the surface by name: `files` sits above
     * `commits` on the ladder, so asking for both would have drawn the whole pull request again,
     * which is the fault this card exists to stop. The diff of any one of them is a press away on
     * GitHub, and the review workspace is what the primary makes.
     */
    wants:   ['commits', 'stat', 'checks'],
    surface: 'commits',
    actions: [
      { label: 'Start a review workspace', verb: 'review' },
      { label: 'What changed since?', verb: 'ask', prompt: 'For {what} ({title}): I have already reviewed this once and {why}. Read only the commits pushed after my review and tell me what they changed, whether they answer what I asked for, and what is still open.' },
      { label: 'Later', verb: 'snooze', hours: 12 },
    ],
  },
  {
    id:      'start-fix',
    chip:    'Issue to fix',
    label:   'An issue to pick up',
    kind:    'issue',
    lede:    'waited',
    rules:   ['issue-started'],
    summary: '{why}',
    /*
     * `comments`, because the issue's evidence is in them.
     *
     * #13888's body is one sentence - "There is clearly a margin error. Check the screenshot." -
     * and the screenshot is in MSpencer87's comment. The card printed "2 comments" in its section
     * head, offered no control that opened them, and "Read it all" opened the same one sentence:
     * the card asking you to commit a workspace to an issue withheld the only evidence it had.
     * They come off the same query as the body, so this costs no extra round trip.
     */
    wants:   ['body', 'comments'],
    /*
     * And the words stay the surface. `talk` sits above the prose on the ladder, so asking for the
     * comments would have replaced the issue with its replies - which is the reason a card gets to
     * name its own subject. The comments are a control on the facts line, where the recordings are.
     */
    surface: 'said',
    actions: [
      { label: 'Start the fix', verb: 'fix' },
      { label: 'Open the issue', verb: 'url' },
      { label: 'Is this well specified?', verb: 'ask', prompt: 'For {what} ({title}): read the issue and tell me whether it says enough to be fixed, what is missing, and where in the codebase it probably lives.' },
      { label: 'Later', verb: 'snooze', hours: 24 },
    ],
  },
  {
    id:      'stalled',
    chip:    'Stopped',
    label:   'Something that stopped',
    kind:    'signal',
    lede:    'waited',
    rules:   ['stalled'],
    summary: '{why}',
    /*
     * No `checks`. A stalled item's subject is a workspace or an issue - `what` is `Issue #N`, so
     * `subjectOf` gives `pr: 0` - which makes `readArtifacts` skip `prDetail` and every artifact
     * derived from it. It was a want that could not resolve on this card's own kind of work, and
     * it is the dead want this view keeps re-growing.
     */
    wants:   ['conversation', 'media'],
    actions: [
      { label: 'What happened?', verb: 'ask', prompt: 'The work in {workspace} stopped. Read the end of its conversation and its last output, and tell me what it was doing, why it stopped, and what would get it going again.' },
      { label: 'Open the workspace', verb: 'open' },
      { label: 'Later', verb: 'snooze', hours: 4 },
    ],
  },
  {
    id:      'advisory',
    chip:    'Advisory',
    label:   'A security advisory',
    kind:    'signal',
    lede:    'severity',
    rules:   ['advisory-critical', 'advisory-high', 'advisory-medium', 'advisory-low'],
    summary: '{why}',
    wants:   ['advisory'],
    /*
     * Two first moves, and which one it is depends on whether a patch exists. Taking the patch was
     * offered unconditionally, including on the advisory whose own summary line reads "low
     * severity in elliptic, no patch yet" - and its prompt sends an agent to run my-dependabot-fix
     * and open a pull request for a version nobody has published. Where there is no patch the
     * decision is what to do instead, which is a different question and now a different button.
     */
    actions: [
      { label: 'Take the patch', verb: 'ask', when: 'patched', prompt: 'Use the my-dependabot-fix skill for {what}: take the patch, run what the change touches, and open the pull request.' },
      { label: 'What are the options?', verb: 'ask', when: 'unpatched', prompt: 'For {what}: there is no patched version yet. Tell me what this repository actually uses from the affected package, whether the vulnerable path is reachable from our code, and what the options are - pin, replace, vendor a fix, or wait.' },
      { label: 'Open the advisory', verb: 'url' },
      { label: 'Later', verb: 'snooze', hours: 48 },
    ],
  },
  {
    id:      'bump',
    chip:    'Bump',
    label:   'A dependency bump',
    kind:    'issue',
    lede:    'checks',
    rules:   ['bot-cleared', 'bot-stopped', 'bot-green', 'bot-red'],
    summary: '{why}',
    /*
     * No `files`. `facts` is tested above `files` in the surface ladder - rightly, from → to →
     * crosses-a-major is what a bump is decided on - so a bump always drew CardFacts and the
     * patches it had fetched were never looked at. That is a pull request's worth of diff
     * payload read and thrown away on every turn of the deck to a bump card.
     */
    wants:   ['bump', 'stat', 'checks'],
    actions: [
      { label: 'Merge it', verb: 'merge', confirm: true },
      { label: 'Open the pull request', verb: 'url' },
      { label: 'Is it safe?', verb: 'ask', prompt: 'For {what}: read the changelog between the two versions and the diff, and tell me whether anything in this repository uses what changed. Say plainly whether you would merge it.' },
      { label: 'Later', verb: 'snooze', hours: 24 },
    ],
  },
  {
    id:    'bumps',
    chip:  'Bumps',
    label: 'The dependency bumps, together',
    kind:  'issue',
    /*
     * One card for every bump nobody has reviewed; see `fromBotPrs`, which collapses them. The
     * bumps that have been reviewed keep their own card, because a verdict is a subject.
     */
    lede:    'bumps',
    rules:   ['bot-pile'],
    summary: '{why}',
    wants:   ['bumps'],
    /*
     * The question first, because on a pile with no merge in it the question is the work.
     *
     * `Merge the green ones` is gated (see `when`) and the first visible action is the primary, so
     * on the live pile - `0 of 9 ready to merge`, one green and that one a major - the card now
     * offers reading the risky ones at 44px instead of a confirm-then-fail. When something is
     * genuinely mergeable the merge is first again and this drops back beside it.
     */
    actions: [
      { label: 'Merge the green ones', verb: 'merge-green', when: 'mergeable', confirm: true },
      { label: 'Is any of them risky?', verb: 'ask', prompt: 'Look at the open Dependabot pull requests on rancher/dashboard. For each one, say whether the jump crosses a major and whether anything in this repository uses what changed, and name the ones you would not merge without reading.' },
      { label: 'Open them on GitHub', verb: 'url' },
      { label: 'Later', verb: 'snooze', hours: 24 },
    ],
  },
  {
    id:      'pick-up-work',
    chip:    'Pick up work',
    label:   'Work nobody has taken',
    kind:    'issue',
    lede:    'pool',
    rules:   ['pick-up'],
    summary: '{why}',
    wants:   ['pool'],
    /*
     * The 44px kind-coloured primary was `Open the search on GitHub` - pure navigation, on a card
     * whose real act is `Take it and start` on one of the rows below it. That is the fault the
     * ask-reviewers card's own comment says it fixed ("answered it with go and do it by hand
     * somewhere else"). The question is the one thing this card can do for you that the list
     * cannot; the search falls into the footer's navigation with the rest of the places to go.
     */
    actions: [
      { label: 'What should I pick up?', verb: 'ask', prompt: 'Look at the open unassigned issues in rancher/dashboard. Tell me which three are worth picking up next and why, given what I have been working on, and which are too vague to start.' },
      { label: 'Open the search on GitHub', verb: 'url' },
      { label: 'Later', verb: 'snooze', hours: 24 },
    ],
  },
  {
    id:      'open-pr',
    chip:    'No pull request',
    label:   'Work with no pull request',
    kind:    'agent',
    lede:    'commits',
    rules:   ['fix-no-pr'],
    summary: '{why}',
    wants:   ['commits', 'files', 'stat', 'media', 'live'],
    actions: [
      /*
       * Not "Open the pull request", which is what four other cards call a `url` nav to a pull
       * request that exists. This one creates one. On dot7 the chip directly above it reads "NO
       * PULL REQUEST" and the 44px kind-coloured primary read "Open the pull request", so the card
       * contradicted itself - and the five words that are a quiet link on draft-pr, bump,
       * fix-feedback and review-asked were an irreversible publish here.
       */
      { label: 'Put it up for review', verb: 'create-pr', confirm: true },
      { label: 'Open the workspace', verb: 'open' },
      { label: 'Is it ready to show?', verb: 'ask', prompt: 'For the branch in {workspace}: read the commits and the diff, and tell me whether this is ready to put up as a pull request - what is unfinished, what is debug left in, and what the description should say.' },
      { label: 'Later', verb: 'snooze', hours: 8 },
    ],
  },
  {
    id:      'ask-reviewers',
    chip:    'No reviewers',
    label:   'Nobody is looking at it',
    kind:    'review',
    /*
     * How long it has been open and unasked. On the live deck that is 928 days, and it was an 18px
     * pill in the card's top-right corner: the entire story of this card, set smaller than its own
     * provenance line.
     */
    lede:    'waited',
    rules:   ['mine-unasked'],
    summary: '{why}',
    /*
     * No `files`. The card's job is finding a reviewer, not reviewing - and `files` is tested above
     * `reviewers` in the surface ladder, so asking for it would replace the candidate rows with a
     * diff of a change you are not reading. The size of it is already on the facts strip.
     */
    wants:   ['reviewers', 'stat', 'checks', 'body'],
    /*
     * The per-person `Ask` is on the candidate rows, one press each, and it is the real act here -
     * see CardReviewers and `requestReviewers` in Focus.vue. What is left for the footer is the
     * question to ask when the card has no candidate to offer, which is the honest first move in
     * that case; "Open it on GitHub" was the primary, so the card whose whole job is to answer
     * "who should review this" answered it with 'go and do it by hand somewhere else'.
     */
    /*
     * The act the card is named for is the 44px button, and the question is the aside.
     *
     * It was the other way round: `Ask` was a 32px ghost on each candidate row while `Who should
     * review this?` - which sends an agent off to think about it - was the primary. On the card
     * whose whole job is to get somebody asked, the biggest control deferred and the smallest one
     * decided. Gated on there being a candidate (see `suggested`), because with none the question
     * genuinely is the first move - which is the state the per-row press cannot cover either.
     */
    actions: [
      { label: 'Ask the ones it found', verb: 'ask-all', when: 'suggested', confirm: true },
      { label: 'Who should review this?', verb: 'ask', prompt: 'For {what}: look at which files it changes and who has worked on them lately, and tell me who to ask for a review and what to say to them.' },
      { label: 'Open it on GitHub', verb: 'url' },
      { label: 'Later', verb: 'snooze', hours: 12 },
    ],
  },
  {
    id:      'describe-pr',
    chip:    'No description',
    label:   'It does not say what it does',
    kind:    'signal',
    lede:    'files',
    rules:   ['mine-thin'],
    summary: '{why}',
    wants:   ['body', 'stat', 'files', 'commits'],
    actions: [
      { label: 'Write the description', verb: 'describe', confirm: true },
      { label: 'Open it on GitHub', verb: 'url' },
      { label: 'Draft it for me first', verb: 'ask', prompt: 'For {what}: read the diff and the commits and draft the pull request description - what it changes, why, and what a reviewer should check. Show it to me, do not post it.' },
      { label: 'Later', verb: 'snooze', hours: 12 },
    ],
  },
  {
    id:      'manual',
    chip:    'Yours',
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
