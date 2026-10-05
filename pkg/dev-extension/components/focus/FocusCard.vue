<script setup lang="ts">
/**
 * One thing waiting on you, as the card that nearly fills the page.
 *
 * The card owns its hue: `--kind` and `--kind-wash` are set here from the card definition's
 * kind, and everything inside - the chip, the primary button, the rule under the header, the
 * glow behind the card - reads them. That is what makes a deck legible while it is still
 * moving: the colour arrives before the words do.
 *
 * The body is composed rather than switched: a card draws the parts its task has, so a new kind
 * of work needs a definition (focus.ts) and not a new component. What a button does is the
 * definition's too - the card only says which one was pressed.
 *
 * What it has is `artifacts` - the things somebody would have gone and looked up before deciding
 * (see focus-artifacts.ts). A band of evidence across the top, and under it the one surface this
 * kind of work is actually about: the agent's review to pass over, the change to read, the
 * comments to answer, or the issue's own words. A card with none of them is still a card; it just
 * says less, which is honest for work that has nothing to show yet.
 */
import { computed, ref, watch } from 'vue';
import type { FocusTask, CardAction, CardSurface } from '../../focus';
import { isAgentic } from '../../focus';
import AppButton from './AppButton.vue';
import KindChip from './KindChip.vue';
import AppIcon from './AppIcon.vue';
import Markdown from './Markdown.vue';
import TextModal from './TextModal.vue';
import ReviewPass from './ReviewPass.vue';
import ChangeSet from './ChangeSet.vue';
import CardComments from './CardComments.vue';
import CardEvidence from './CardEvidence.vue';
import CardPool from './CardPool.vue';
import CardBumps from './CardBumps.vue';
import CardReviewers from './CardReviewers.vue';
import CardCommits from './CardCommits.vue';
import CardAgent from './CardAgent.vue';
import CardFacts from './CardFacts.vue';
import CheckList from './CheckList.vue';
import SectionHead from './SectionHead.vue';
import IssueMarks from './IssueMarks.vue';
import * as cardVue from 'vue';
import { loadedCards } from '../../focus-cards';
import { componentFor, actionsFrom, CARD_COMPONENTS } from './card-api';
import type { CardApi } from './card-api';
import { devApi } from '../../reviews';
import { NO_ARTIFACTS } from '../../focus-artifacts';
import type {
  CardArtifacts, CardComment, PoolIssue, BumpRow
} from '../../focus-artifacts';
import type { ReviewNote } from '../../focus-review';

const props = defineProps<{
  task: FocusTask;
  interactive?: boolean;
  busy?: boolean;
  /** Pinned tasks sit beside the deck rather than in it; the card says so and offers the way back. */
  pinned?: boolean;
  /**
   * The agent's comments, when this card's work is a review waiting for a pass.
   *
   * The card is where the pass happens rather than somewhere the card sends you: a comment
   * carries the lines it is about, so the judgement can be made here. See focus-review.ts; the
   * page loads them for the card on top and nothing else.
   */
  notes?: ReviewNote[];
  /**
   * Everything else this card's work has to show, read for the card on top and nothing else.
   *
   * Empty is the normal state for all but one card at a time, and an empty one draws nothing
   * rather than drawing a frame around nothing. See focus-artifacts.ts for what a card asks for
   * and Focus.vue for the one place that asks.
   */
  artifacts?: CardArtifacts;
  /**
   * Its artifacts are still being read.
   *
   * The card itself is drawn from the queue and needs nothing, so the title and the buttons are
   * there at once; what it is about takes a pull request's worth of calls. Saying so beats an
   * empty body that fills itself a second later, which reads as the card having nothing on it
   * right up until it does.
   */
  reading?: boolean;
}>();

const emit = defineEmits<{
  (e: 'act', action: CardAction): void;
  (e: 'ask'): void;
  (e: 'pin'): void;
  (e: 'resolve', value: { note: ReviewNote; verdict: string; body?: string }): void;
  (e: 'discuss', value: { note: ReviewNote; text: string }): void;
  (e: 'ask-code', value: { path: string; label: string; code: string; text: string }): void;
  (e: 'reply', value: { comment: CardComment }): void;
  (e: 'expand', value: { path: string; mark: [number, number] }): void;
  (e: 'take', issue: PoolIssue): void;
  (e: 'merge-bump', row: BumpRow): void;
  (e: 'about-bump', row: BumpRow): void;
  (e: 'about-issue', issue: PoolIssue): void;
  (e: 'ask-reviewer', who: string): void;
  (e: 'answer', value: { key: string; label: string }): void;
  (e: 'workspace'): void;
  (e: 'make-workspace'): void;
}>();

/**
 * The comment the pass is on, when the card is a pass.
 *
 * It decides what the evidence band shows. A review card's workspace holds everything every
 * comment was built from - eight recordings, of which one belongs to the comment you are reading
 * - so the band was showing the workspace rather than the comment, which is a different claim and
 * the wrong one. Pick a comment and the band is that comment's.
 */
const noteOn = ref<ReviewNote | null>(null);

/**
 * What the card's body says it is drawing. See `api.shell.showing`.
 *
 * Cleared when the card changes, because the next card's body reports on its own first render and
 * until it does the frame would otherwise be deciding from the last card's answer.
 */
const bodyShows = ref('');

watch(() => props.notes, (found) => { noteOn.value = found?.[0] || null; }, { immediate: true });

/**
 * What arrived, before this card has had its say about it.
 *
 * It was split out from `art` because `art` and `surface` had each other as a dependency, and Vue
 * hands back `undefined` for the computed it is already inside: `art.value.agent` threw on the
 * first render of every card, the render aborted to a comment node, and the view was a header
 * saying "1 of 36 waiting" over an empty box. The dispatch has moved to CardSurface and that
 * cycle cannot form here any more, but the split stays - it is what the card api hands a module
 * (see `cardApi.artifacts`), and a body reading a value that depends on the body is the same trap
 * one level out.
 */
const base = computed<CardArtifacts>(() => props.artifacts || NO_ARTIFACTS);

const art = computed<CardArtifacts>(() => {
  /*
   * `noteOn` alone, where this asked `surface === 'pass'` as well.
   *
   * The shell no longer knows which surface a card drew, and it does not need to: `noteOn` is set
   * only through `api.shell.selected`, which only a pass ever calls, so a non-null one already
   * means the body is showing a finding.
   */
  if (!noteOn.value) {
    return base.value;
  }

  return {
    ...base.value,
    media: noteOn.value.media.map((item) => ({
      kind: item.kind, label: item.label, src: item.src, caption: item.caption, at: '',
    })),
  };
});

/** Waiting long enough that somebody is being held up by it. */
const overdue = computed(() => props.task.waitingHours >= 48);

/**
 * How many of the agent's findings you have said yes to, when this card is a pass.
 *
 * ReviewPass holds the verdicts - none of them has been written to GitHub - so this is the only
 * way the footer can know whether `Post the review` would post anything. See `anyKept` in
 * `visible`, and the comment there for what it cost not to know.
 */
const kept = ref(0);

watch(() => props.task.key, () => { kept.value = 0; bodyShows.value = ''; });

/**
 * Whether a workspace could be made for this at all.
 *
 * Only where there is something to make one from: a pull request to review, or an issue to fix.
 * A bump, an advisory or a hand-written task has nothing a checkout could be of, and an offer
 * that cannot be taken is worse than no offer.
 */
const canMakeOne = computed(() => /#\d+/.test(props.task.what)
  && props.task.card.actions.some((action) => action.verb === 'review' || action.verb === 'fix'));

/**
 * The first action is the one the card is built around; the rest are sorted by what they are.
 *
 * Every action used to be an `lg` ghost button in one wrapping row: review-asked drew `Start a
 * review workspace` / `Open the build` / `Open the pull request` / `What changed?` / `Later` as
 * five identical 48px boxes over two rows, 125px of footer against 88px of body, and the card
 * gave no signal which of the five it wanted pressed. They are not five of a kind. One of them
 * is the decision; one is the question you might ask instead; two of them only open a tab
 * somewhere else, which is navigation and belongs on the provenance line with the rest of the
 * facts; and `Later` is the way out, which belongs at the far end away from the thing it is not.
 */
/**
 * Whether the work is in the state this action was written for. See `when` on CardAction.
 *
 * One condition, resolved in four lines, because the alternative shipped: the advisory card
 * offered "Take the patch" on an advisory whose own facts row said there was no patch, and that
 * button's prompt sends an agent off to open a pull request for a version nobody has published.
 */
function visible(action: CardAction): boolean {
  if (!action.when) {
    return true;
  }
  const a = base.value;
  /*
   * `mergeable` is the bumps card's version of the same fault the advisory card had.
   *
   * `Merge the green ones` filters out the majors and then refuses - "The only green one crosses
   * a major. Merge those from their own row" - so on the live pile, whose own lede reads `0 of 9
   * ready to merge` and whose hint reads `1 green, 1 of them major`, the 44px kind-coloured
   * primary behind a two-press confirm could do nothing but error. The card already knew; it is
   * the same `state === 'green' && !major` the lede counts.
   */
  /*
   * `anyKept` is the same fault a third time, and the most expensive of the three.
   *
   * `Post the review` was live on arrival on every review-pass card, and every one of them arrives
   * at `0 of 2 decided · 0 to post`. Pressing it runs `postTheReview` -> `submitReview` -> "Nothing
   * was left to post." -> `done(task)`, which also clears the card off the deck: the card's one
   * decision posted nothing and dismissed the work. Both live cards were in that state.
   *
   * The verdicts are ReviewPass's own state - nothing has been written to GitHub yet - so it says
   * how many it is keeping and this reads that. With nothing kept the primary falls through to
   * "Which ones matter?", which is the right first move at 0 decided.
   */
  const state: Record<NonNullable<CardAction['when']>, boolean> = {
    patched:   Boolean(a.advisory?.patched),
    unpatched: !a.advisory?.patched,
    mergeable: a.bumps.some((row) => row.state === 'green' && !row.major),
    anyKept:   kept.value > 0,
    suggested: Boolean(a.reviewers?.suggested.length),
  };

  return state[action.when];
}

/* ── A card held outside the bundle ───────────────────────────────────────────────────────── */

/**
 * The module for this card, when there is one.
 *
 * Keyed on the definition's id, so a ConfigMap named `dev-card-review-pass` takes over the card
 * `review-pass` by existing - no flag on the definition, nothing to keep in step. That is also
 * how a card is moved out of this bundle one at a time and how it is moved back: delete the map.
 */
const bundle = computed(() => loadedCards.value[props.task.card.id]);

/**
 * What the module is given. See card-api.ts.
 *
 * Built once, not computed, because `setup` runs once and holds whatever it is handed; the parts
 * that change are refs inside it. `artifacts` reads `base` and **not** `art` - `art` is downstream
 * of `surface`, and a body that read it would close the loop `art -> surface -> body -> art`,
 * which is the cycle that once resolved to `undefined` and rendered no cards at all.
 */
const cardApi: CardApi = {
  vue:         cardVue,
  task:        computed(() => props.task),
  artifacts:   computed(() => base.value),
  notes:       computed(() => props.notes || []),
  reading:     computed(() => Boolean(props.reading)),
  interactive: computed(() => Boolean(props.interactive)),
  busy:        computed(() => Boolean(props.busy)),
  claimed:     computed(() => claimed.value),
  emit:        (event: string, payload?: any) => (emit as any)(event, payload),
  devApi,
  components:  CARD_COMPONENTS,
  shell:       {
    keeping:  (count: number) => { kept.value = Number(count) || 0; },
    selected: (note: any) => { noteOn.value = note || null; },
    openText: (what: string) => { readOn.value = String(what || '') as typeof readOn.value; },
    showing:  (name: string) => { bodyShows.value = String(name || ''); },
  },
};

/** The body the module draws, or nothing - in which case the built-in surfaces below do. */
const bundleBody = computed(() => {
  const loaded = bundle.value;

  return loaded?.module && !loaded.error ? componentFor(loaded) : null;
});

/** The ones this card is offering at all, in the definition's order - or the module's. */
const shown = computed(() => {
  const own = actionsFrom(bundle.value, cardApi);

  return (own || props.task.card.actions).filter(visible);
});

const primary = computed(() => shown.value[0] || null);
const others = computed(() => shown.value.slice(1));

/**
 * Opens something somewhere else: a link, not a decision.
 *
 * `open` is one of these now. It used to post a prompt into the chat bar - see the `open` verb in
 * Focus.vue - so it was a decision-shaped button that went nowhere; now it is what it says, and
 * what it says is navigation. That also empties the old `more` list, which across all sixteen
 * shipped cards could only ever hold a single `open` and measured as appearing on 2 of 25 live
 * cards with one row in it: a popover, a chevron and a piece of state to hold one link. The
 * popover stays and holds the navigation instead, which is what it is worth having for.
 */
/**
 * Where a nav actually goes, so a card can stop offering its own identifier twice.
 *
 * `.card__ident` is an `<a>` to `task.url` on the head line, and the footer's third control was
 * `Open the pull request` - verb `url`, which `act` resolves to `task.url` and nothing else. Same
 * destination, 350px apart, on review-asked, bump, describe-pr and advisory. Measured on dot9 it
 * cost 203px, which is what pushed `Later` 45px past the card's edge; dropping it takes that row
 * from 983 back to 768. `open` is in here too because with no workspace it falls through to the
 * same link, and `share` opens a build, which is somewhere else.
 */
function target(action: CardAction): string {
  if (action.verb === 'url') {
    return props.task.url;
  }
  if (action.verb === 'open') {
    return props.task.workspace ? `ws:${ props.task.workspace }` : props.task.url;
  }

  return `build:${ action.kind || 'dashboard' }`;
}

const navs = computed(() => others.value
  .filter((action) => action.verb === 'url' || action.verb === 'share' || action.verb === 'open')
  .filter((action) => !(props.task.url && target(action) === props.task.url)));

/**
 * The one quieter question, beside the primary - and nothing where the primary is itself a question.
 *
 * The `v-else` under this used to draw a generic `Ask about this` whenever the definition offered
 * no second question, which on the five cards whose *primary* is an ask put two question buttons
 * side by side - `Who should review this?` + `Ask about this`, `Take the patch` + `Ask about this`
 * - with the chat bar 100px below reading `Ask about "<title>"`, which is the same control a third
 * time. Where the card has already asked, the bar is the general question.
 */
const asked = computed(() => others.value.find((action) => action.verb === 'ask') || null);

const offersAsk = computed(() => Boolean(asked.value) || primary.value?.verb === 'ask');

/*
 * Whether the primary sets an agent working, and so carries the sparkle the ghost beside it has.
 *
 * The ghost has always had it and the primary never did, so a card whose first move was an agent -
 * "Fix it" over "Why is it red?" - marked the smaller of its two agentic buttons and left the
 * larger bare. `describe` is resolved here because only the card knows which way it goes: with no
 * description to write it asks an agent, and with one it writes to GitHub.
 */
const agenticPrimary = computed(() => isAgentic(primary.value, !String(art.value.body || '').trim()));

/** Putting it off: the far end of the row, because it is the opposite of the primary. */
const later = computed(() => others.value.find((action) => action.verb === 'snooze') || null);

/** The places to go, open. */
const navOpen = ref(false);

/*
 * The ladder, the `surface` field and the reasoning behind both are in CardSurface.vue now, with
 * the branches they chose between. What is left here is the frame: the chip, the title, the lede,
 * the evidence band, the prose block and the footer.
 */


/**
 * What it says it is, when the card asked.
 *
 * `body` used to be the bottom rung of the ladder above - a surface of last resort - which meant
 * it never once drew on the three cards that ask for it. describe-pr wants `body` and `files`, so
 * the diff won and the description it is about to overwrite was fetched and discarded; same for
 * the review somebody asked you for, and for the card about who should review it. None of those
 * is a card where the prose is the *alternative* to the change: it is the sentence you read
 * before the change. So it is its own block above the surface, and the ladder no longer has a
 * 'prose' rung to lose.
 */
/*
 * Off `base`, not `art`.
 *
 * `art` reads `surface` (it swaps the media for the selected finding's), and `surface` now reads
 * the card's declared subject - which for an issue is its own words. Reading `art` here would put
 * `prose` in the cycle `base` exists to keep out of this file: `art` -> `surface` -> `prose` ->
 * `art`, which Vue answers with `undefined` and which cost this view a render that drew no cards
 * at all. `art` differs from `base` in exactly one field and it is not this one.
 */
const prose = computed(() => ((props.task.card.wants || []).includes('body') ? base.value.body : ''));

/**
 * Prose on the card, or prose over it.
 *
 * A description has no natural size - three lines on one pull request and two screens on the next
 * - so it was drawn as a block above the surface, capped at nine lines and scrolled. Measured,
 * that block came to 143px inside an 88px body on a review card and pushed the diff 517px off the
 * right-hand edge: the one thing the card existed to show was the one thing off screen, eaten by
 * a paragraph you could read 15% of.
 *
 * So prose never stacks above a surface again. Where there is a surface it is a 30px control on
 * the provenance line that says how much there is and opens it over the card (TextModal); where
 * there is none - an issue to pick up, a task somebody wrote down - the prose IS the surface and
 * fills the body, rendered, through the one markdown component.
 */
/* `said` is the words *as* the surface, which is what a card declares when that is its subject. */
const readsProse = computed(() => Boolean(prose.value) && (bodyShows.value === '' || bodyShows.value === 'said'));
const prosePill = computed(() => Boolean(prose.value) && !readsProse.value);

/** Whether there is a surface at all, for the box that gives one its floor. See `.card__surface`. */
const hasSurface = computed(() => Boolean(props.reading || readsProse.value || bodyShows.value || bundleBody.value));

/** What the prose is, named the way the card would name it. */
const proseLabel = computed(() => (art.value.issue ? 'What the issue asks for' : 'What it does'));

/*
 * `proseSize` lived here: `prose.length / 1000`, printed beside the control that opens the
 * description. While `readArtifacts` capped the body at 2400 characters it was not the size of
 * anything - it printed the identical "2.4k" on every long description in the deck, which is the
 * cap and not a quantity - and the modal it opened cut mid-sentence with nothing saying so. The
 * cap is 40,000 now and the body arrives whole (see `capBody` in focus-artifacts), so the honest
 * thing is a pill that says what it opens. A character count is not a number anybody has an
 * intuition for either way.
 */

/**
 * What was said on it, for the card whose subject is not what was said.
 *
 * The start-fix card asks you to commit a workspace to one issue and showed the issue's body and
 * nothing else - so on #13888, whose body is "There is clearly a margin error. Check the
 * screenshot.", the screenshot was withheld: it is in MSpencer87's comment, the head printed "2
 * comments" and offered no control that opened them, and "Read it all" opened the description
 * again (744px of the same one sentence). `commentsOf` and this want already existed for
 * fix-feedback; the card just never asked.
 *
 * Read over the card, through the one component for reading prose over a card. A comment is
 * markdown and so is a description, so there is nothing a second dialog would do differently -
 * and once Markdown.vue embeds a bare attachment URL, the picture of the bug is in here.
 */
const talk = computed(() => (bodyShows.value === 'talk' ? [] : base.value.comments));

const talkText = computed(() => talk.value
  .map((comment) => `**${ comment.author }**${ comment.path ? ` · \`${ comment.path }\`` : '' }\n\n${ comment.body }`)
  .join('\n\n---\n\n'));

/**
 * Open over the card, at the width prose is read at: the description, or what was said about it.
 *
 * One piece of state for both, because there is one dialog and only one of them can be open.
 */
const readOn = ref<'' | 'prose' | 'talk'>('');

watch(() => props.task.key, () => { readOn.value = ''; });

/**
 * The action that has been pressed once and is waiting to be meant.
 *
 * Posting a review and merging leave this cluster, and the whole motion of this view is pressing
 * the big button and moving on - so those two take two presses. Cleared when the card changes,
 * because a half-pressed button that survives the deck turning is a trap.
 */
const confirming = ref('');

watch(() => props.task.key, () => { confirming.value = ''; navOpen.value = false; });

function press(action: CardAction) {
  if (action.confirm && confirming.value !== action.label) {
    confirming.value = action.label;

    return;
  }
  confirming.value = '';
  emit('act', action);
}

const labelOf = (action: CardAction) => (confirming.value === action.label ? `${ action.label } — sure?` : action.label);

/**
 * The commits that arrived after your review, for the one card whose subject is a second look.
 *
 * `newSince` is the review's own timestamp, which `fromReviewing` already computed to decide the
 * rule; a commit without a parseable date is counted as new, because the alternative is quietly
 * dropping work from a list whose entire job is to be complete.
 */
const fresh = computed(() => {
  const at = Date.parse(props.task.newSince || '');

  if (!Number.isFinite(at)) {
    return [];
  }

  return base.value.commits.filter((commit) => !(Date.parse(commit.at) <= at));
});

/** Days, where hours stop being a number anybody reads. */
const waited = computed(() => (props.task.waitingHours >= 48
  ? `${ Math.round(props.task.waitingHours / 24) } days`
  : `${ props.task.waitingHours }h`));

/**
 * The size of the change, as words rather than as three pills.
 *
 * It was `StatPill files / added / removed` in the evidence band and `StatPill priority / waiting
 * / workspace` under the body, and the header said two of those a second time: `waiting 3 days`
 * as a badge and again as a pill, the workspace as a button and again as a pill, and - on a card
 * about a pull request - `priority 118`, which is the ranking's own arithmetic and not a fact
 * about the work. Four restatements of the same four facts is why the header grew to 221px of a
 * 484px card. One 13px line, once.
 */
/*
 * The headline number, which is the one thing on this card you can read from across the room.
 *
 * Every kind in the deck has exactly one and all of them were 18-26px pills in a row of equals:
 * 928 days open, 6 of 46 checks failing, 8 findings waiting on a verdict, 1 green bump of 9, 100
 * issues nobody has taken, HIGH. `--t-xl`, `--t-2xl` and `--t-3xl` were declared and used by
 * nothing in the deck, so the largest type on a screen whose whole premise is one thing at a time
 * was the 19px title. The card says which number it is (`lede` on CardDef); this reads it off
 * whatever came back, and answers null where the artifact is not in yet - a slot that fills in
 * under you is worse than a slot that was never there.
 */
/*
 * `word` is the one lede that is not a quantity.
 *
 * `.card__lede-n` is `--t-2xl` at 650 with `font-variant-numeric: tabular-nums` and
 * `letter-spacing: -0.03em` - a type treatment built for a number - and the advisory card puts
 * "high" in it. Measured on dot21: n = "high", of = "patch available", which at 36px in `--danger`
 * over its own subtitle reads as an unfinished string rather than as a verdict. A severity is a
 * verdict, so it gets the treatment a verdict wants: caps, `--t-xl`, normal tracking and the kind
 * wash behind it. Same slot, same place in the card, legible as what it is.
 */
const lede = computed<{ n: string; of: string; tone: 'kind' | 'good' | 'bad' | 'warn'; word?: boolean } | null>(() => {
  const a = art.value;

  switch (props.task.card.lede) {
  case 'waited':
    return props.task.waitingHours
      ? { n: waited.value, of: 'waiting', tone: overdue.value ? 'bad' : 'kind' }
      : null;

  /*
   * The pull request's counts, not the number of rows the card happened to draw.
   *
   * `a.checks` is at most six named failures - see `ciOf` - so this read `6 of 7 checks
   * failing` at 36px directly over its own summary line `6 of 46 checks failing`, and on the next
   * card `1 of 2` over `1 of 43`. The one number a card is built to be read from across the room
   * contradicted the sentence under it, and a pull request with more than six failures would have
   * said `6 failing` for ever. `a.ci` is what GitHub says; the rows are only the names.
   */
  case 'checks': {
    const ci = a.ci;

    if (!ci) {
      return null;
    }

    return ci.failing
      ? { n: `${ ci.failing } of ${ ci.total }`, of: 'checks failing', tone: 'bad' }
      : { n: String(ci.passed), of: 'checks passed', tone: 'good' };
  }

  case 'findings': {
    const n = props.notes?.length || 0;

    return n ? { n: String(n), of: n === 1 ? 'finding to judge' : 'findings to judge', tone: 'kind' } : null;
  }

  case 'comments':
    return a.comments.length
      ? { n: String(a.comments.length), of: a.comments.length === 1 ? 'comment' : 'comments', tone: 'kind' }
      : null;

  case 'files':
    return a.stat?.files
      ? { n: String(a.stat.files), of: a.stat.files === 1 ? 'file changed' : 'files changed', tone: 'kind' }
      : null;

  case 'commits':
    return a.commits.length
      ? { n: String(a.commits.length), of: a.commits.length === 1 ? 'commit' : 'commits', tone: 'kind' }
      : null;

  /*
   * The commits that arrived after your review, which is the number the card is about.
   *
   * `commits` would be every commit on the branch - which is what the first review covered, and
   * what this card used to lead with as "157 files changed". See `newSince` on PriorityItem.
   */
  case 'fresh': {
    const n = fresh.value.length;

    if (n) {
      return { n: String(n), of: n === 1 ? 'new commit' : 'new commits', tone: 'kind' };
    }

    /*
     * Nothing it can tell is new, so the wait.
     *
     * Measured on PR #19217: the surface draws "Since your review · 12 commits" - so `newSince`
     * arrived and the marking works - and none of the twelve is newer than the review. The cause
     * is upstream of this view: `detail.commits` comes from `GET /pulls/N/commits?per_page=100`
     * with no page parameter, which returns the *first* hundred of a branch with more than that,
     * and `readArtifacts` then keeps the last twelve of those. On a big pull request those twelve
     * are commits 89-100, not the newest twelve. That is a paginated fetch in dev-api and not a
     * number this file can mend.
     *
     * A lede that resolves to nothing leaves the card with no 36px number at all, which is worse
     * than the second-best one - so this falls back the way the rest of this family already leads.
     */
    return props.task.waitingHours
      ? { n: waited.value, of: 'waiting', tone: overdue.value ? 'bad' : 'kind' }
      : null;
  }

  case 'bumps': {
    if (!a.bumps.length) {
      return null;
    }
    const ready = a.bumps.filter((row) => row.state === 'green' && !row.major).length;

    return { n: `${ ready } of ${ a.bumps.length }`, of: 'ready to merge', tone: ready ? 'good' : 'warn' };
  }

  case 'pool':
    return a.pool.length ? { n: String(a.pool.length), of: 'nobody has taken', tone: 'kind' } : null;

  case 'severity':
    return a.advisory?.severity
      ? {
        n:    a.advisory.severity,
        of:   a.advisory.patched ? 'patch available' : 'no patch yet',
        tone: ['critical', 'high'].includes(a.advisory.severity) ? 'bad' : 'warn',
        word: true,
      }
      : null;

  default:
    return null;
  }
});

/**
 * The fact the lede owns, which is the fact nothing else on this card may repeat.
 *
 * One number, once. Measured across the deck: the header's overdue pill said `waiting 929 days`
 * 20px above a lede reading `929 days waiting` on 8 of 26 cards (and IssueMarks said `1039d old`
 * as a third copy); the first StatPill said `13 FILES` 50px from a lede reading `13 files
 * changed` on 10 more; and the advisory's severity badge said `HIGH` 40px from a lede reading
 * `high`. Saying a number twice in one glance is what makes a card read as generated rather than
 * written, and it cost about 90px of strip.
 *
 * Passed down as one name rather than four booleans: the card's definition already says which of
 * its numbers is the headline (`lede` on CardDef), so every part that can draw that same number
 * is handed the name and leaves it out. Null where the lede did not resolve - a card whose
 * headline number has not arrived is a card where the duplicate is the only copy.
 */
const claimed = computed(() => (lede.value ? props.task.card.lede || '' : ''));

/**
 * Whether the facts row has anything on it.
 *
 * The same test CardEvidence makes about the artifacts, plus the card's own two pills. Asked here
 * because `.card__body` is a column with a `--s4` gap: a facts row that renders empty is not
 * invisible, it is sixteen pixels off the surface - which is the shape of mistake this card has
 * been paying for all along.
 */
const hasFacts = computed(() => {
  const a = art.value;

  return Boolean(lede.value
    || prosePill.value
    || talk.value.length
    || (!overdue.value && props.task.waitingHours)
    || a.stat
    || a.ci
    || a.live.length
    || a.media.length
    || a.reviewers?.approved.length);
});

/** How long it has sat, unless that is what the lede says - in which case this is the same string. */
const waitedOnLine = computed(() => (!overdue.value && props.task.waitingHours && claimed.value !== 'waited'
  ? `${ waited.value }`
  : ''));

</script>

<template>
  <article
    class="card"
    :class="[`card--${ task.card.kind }`, { 'card--flat': !interactive }, bundle ? `card--mod-${ bundle.id }` : '']"
  >
    <div class="card__glow" aria-hidden="true" />
    <div class="card__glow card__glow--foot" aria-hidden="true" />
    <div class="card__band" aria-hidden="true" />

    <header class="card__head">
      <!--
        One line: what this is on the left, and the one control the header owns on the right.
        Nothing in the middle claims the space between them - the pin does, which is what keeps
        the right edge of the header the right edge of the card whether or not the badge is
        there. It was the badge claiming it, so a card with nothing overdue drew its pin halfway
        along the line.
      -->
      <div class="card__head-line">
        <!--
          First in the line, which is the card's top-left corner: what it does is to the whole
          card. In the line rather than floated over it, so nothing underneath has to be
          indented past it by a number nobody can derive.
        -->
        <button
          v-if="interactive"
          type="button"
          class="card__pin"
          :class="{ 'card__pin--on': pinned }"
          :title="pinned ? 'Put it back in the deck' : 'Keep it beside the deck'"
          :aria-pressed="pinned ? 'true' : 'false'"
          @click="emit('pin')"
        >
          <AppIcon name="pin" :size="13" />
        </button>
        <KindChip :kind="task.card.kind" :word="task.card.chip" />

        <!--
          Where the work lives, or the offer to give it somewhere.
          
          It was a grey suffix on the line above - ` · lte-pr-19153` - which said which workspace
          but did nothing, and said nothing at all for the cards that have none. Those are the
          ones where it matters: a review somebody asked you for, an issue to pick up, a bump.
          Making the workspace is the first thing you would do and it was the one thing the card
          could not do.
        -->
        <button
          v-if="task.workspace"
          type="button"
          class="card__ws"
          :title="`Open ${ task.workspace }`"
          @click="emit('workspace')"
        >
          <AppIcon name="tasks" :size="11" />
          {{ task.workspace }}
        </button>
        <button
          v-else-if="canMakeOne"
          type="button"
          class="card__ws card__ws--none"
          title="Make a workspace for this and start"
          @click="emit('make-workspace')"
        >
          <AppIcon name="plus" :size="11" />
          No workspace
        </button>
        <!--
          Which thing this is, on the line that says what this is, and a link to it.

          It was a block of its own under the summary - and because `@rancher/shell` styles bare
          `code` and nothing in this view undid it, that block measured 696x31 with a border, a
          sunk background and 5px of padding on 26 of 26 cards: an empty disabled text input
          holding `PR #11`. 39px of a 488px card for seven characters. The reset is in
          design/focus.css now; what is left belongs beside the chip, at the row's own height,
          and pressing the identifier of a thing should open the thing.
        -->
        <component
          :is="task.url ? 'a' : 'span'"
          class="card__ident"
          :href="task.url || undefined"
          :target="task.url ? '_blank' : undefined"
          :rel="task.url ? 'noopener' : undefined"
          :title="task.url ? `Open ${ task.what }` : task.what"
        >{{ task.what }}</component>

        <span v-if="overdue && claimed !== 'waited'" class="card__overdue">
          <AppIcon name="clock" :size="13" />
          waiting {{ waited }}
        </span>
      </div>

      <!--
        One line, reserved, so the body starts at the same y on every card: see `.card__title`.

        It was two, and two lines of 26px is 30px of the card reserved on the 12 of 26 cards whose
        title is one line - 30px spent on a frame rather than on the thing the card is about,
        which on a diff card had 60px of code in it. The whole title is in the tooltip, in the chat
        bar's subject and in every modal the card opens, so nothing is unreachable.
      -->
      <h2 class="card__title" :title="task.title || task.what">{{ task.title || task.what }}</h2>

      <!--
        Why it is in front of you, in one line.

        It was three: `.card__summary` ("Review it"), `.card__by` in a bordered strip ("you were
        asked for a review and have not given one") and `.card__prose` (the rule's own blurb) -
        two of which say the same thing, and on dot9 the strip read "you were asked for a review
        and have not given one" directly under a summary reading "Review it". The imperative and
        its reason are one sentence, so they are written as one.
      -->
      <p class="card__summary">
        {{ task.needs }}<span v-if="task.summary && task.summary !== task.needs" class="card__why"> — {{ task.summary }}</span>
      </p>

    </header>

    <div class="card__body">
      <!--
        One band of numbers: the headline one, and then the things you would have gone and looked
        up - the size of the change, what CI says, what is running on a link, how many recordings
        there are, how long it has sat, and the description if there is one to read.

        Pinned at `flex: 0 0 auto`, which is the whole of finding after finding. It was three rows
        in a column that kept its natural height while every surface under it could shrink, so the
        decoration was at natural height and the point was at 1px: 139px of band against 23px of
        diff on a card whose button says "Mark it ready for review", 129px of band against 28px for
        eight findings on a card that posts a review to GitHub. Measured after: 37px where the lede
        is alone on the row and 71px where the facts wrap under it, against surfaces of 120-127px.

        **One line, and it neither wraps nor scrolls.** It wrapped, and then it scrolled sideways,
        and the scroller was worse: `.card__strip` measured scrollWidth/clientWidth of 740/524 on
        the review-asked card and arrived at `scrollLeft: 216` with no interaction, so the first
        thing on a card's fact line was 60px of a pill reading "OVED" while `+13281 added` sat off
        the card to the left. On the red-pr card the one control the card exists for - the list of
        failures - measured x812 to r1025 against a window of 1024. The numbers are text now and
        the controls are pinned; see CardEvidence, which owns the whole line, including the two
        pills this template used to add to it by hand.
      -->
      <!--
        Reserved while the read is in flight, so the band does not appear under the reader.

        The deck no longer holds its skeleton until the top card's detail arrives, so this strip is
        now usually empty for the first moment of a card's life. An empty 37px band plus its gap
        arriving a second later moved everything below it; holding the space costs nothing, because
        the rest of the card is already fixed - `.card__head` is sized from the task alone and
        `.card__surface` has a 120px floor.
      -->
      <div v-if="hasFacts || reading" class="card__facts">
        <p v-if="lede" class="card__lede" :class="[`card__lede--${ lede.tone }`, { 'card__lede--word': lede.word }]">
          <span class="card__lede-n">{{ lede.n }}</span>
          <span class="card__lede-of">{{ lede.of }}</span>
        </p>

        <CardEvidence
          :artifacts="art"
          :claimed="claimed"
          :waited="waitedOnLine"
          :prose="prosePill ? proseLabel : ''"
          :talk="talk.length"
          @read="readOn = 'prose'"
          @talk="readOn = 'talk'"
        />
      </div>

      <!--
        The one surface this card is about, in a box that has a floor.

        Every child of `.card__body` is `flex-shrink: 1` with no `min-height`, so the surface was
        what gave: measured, `ev` 139px of natural height against `cm` at 1px and `changes` at 23px
        - "On the branch 20 commits" and "What it changed, first 40 of 50 files" as two headings
        16px apart with two scroll chevrons, no commits and no files between them. A wrapper rather
        than a declaration on each surface component, because the floor and the `min-height: 0` a
        scrolling surface needs for its own children are the same property at the same specificity:
        the box is told it may not be smaller than 120px, and what is inside it is free to shrink to
        nothing inside that.
      -->
      <div v-if="hasSurface" class="card__surface">
        <!--
          What it says it is, when that is all this card has: an issue's own words.

          Rendered, not interpolated. It was `<p>{{ prose }}</p>` with `white-space: pre-wrap`, so
          a GitHub pull request template showed the user its own HTML comment - "This template is
          for Devs to give QA details before moving the issue To-Test" - followed by `### Summary`
          with the hashes showing. `Markdown.vue` had been written for this and imported nowhere.
        -->
        <section v-if="readsProse && !reading" class="card__said">
          <SectionHead :label="proseLabel" :icon="art.issue ? 'tasks' : 'pencil'">
            <IssueMarks v-if="art.issue" :issue="art.issue" :claimed="claimed" />
            <!--
              The way to read the rest of it, which this card did not have.

              Where there is a surface the description opens from a pill on the facts strip; where
              the prose *is* the surface there was no control at all, and `.card__read` measured
              93px against a scrollHeight of 145-3,080 - about four lines of a three-thousand-pixel
              issue, read four lines at a time. TextModal is already here for the other case.
            -->
            <button
              v-if="prose"
              type="button"
              class="card__all"
              @click="readOn = 'prose'"
            >Read it all</button>
          </SectionHead>
          <div class="card__read u-fade-y">
            <Markdown :text="prose" />
          </div>
        </section>

        <!-- Being read. See `reading`: a card says so rather than filling in under you. -->
        <div v-if="reading" class="card__reading">
          <AppIcon name="spinner" :size="20" />
          <span>Reading what this needs…</span>
        </div>

        <!--
          A card held outside this bundle draws its own body.

          Keyed on `generation`, which is what turns "the module reloaded" into "the card
          redrew": re-evaluating a module after an edit gives a new component, and a new component
          alone is not enough - Vue keeps the mounted one until something it keys on changes.

          The key is on the component rather than on this `v-else-if`, which matters more than it
          looks. A key the compiler finds on a branch root *replaces* the branch key it would
          have injected, because `injectProp` leaves an existing `key` alone. So this branch was
          keyed `1` by `generation` - a module's first evaluation - and the `v-if="reading"`
          branch above is keyed `1` by its position among its siblings. Same key, same tag, so
          Vue patched the spinner's div into this one instead of replacing it: the class stayed
          `card__reading`, the cached "Reading what this needs..." span was never visited, and
          the module mounted inside the spinner. That is a card that reads forever with its own
          body behind the text, and no `.card__bundle` for the rules below to size. It only
          showed in the built plugin: in dev these comments join the branch, which makes it a
          Fragment, and the Fragment carries the injected key out of harm's way.
        -->
        <!--
          A real element around the module, owned by the shell.

          `class="card__bundle"` used to ride on the component itself, and a class on a component
          falls through to that component's root - which for a card whose body is one
          `<CardSurface />` is whatever that resolved to, and for a surface that draws nothing
          (`said`, or an artifact that has not arrived) is a comment node. Measured: four of the
          deck's twenty-six cards had no `.card__bundle` at all while their modules had loaded
          perfectly. A wrapper the shell writes is there on every render, whatever the card does
          inside it.

          Transparent to layout on purpose - see the flex rule - because the surfaces were direct
          children of `.card__body` before this and they size themselves against their parent.
        -->
        <div v-else-if="bundleBody" class="card__bundle">
          <component
            :is="bundleBody"
            :key="bundle.generation"
            :api="cardApi"
          />
        </div>

        <!--
          A card that would not load says why, where the card would have been.

          The alternative is a card that is silently not there, which while editing one is the
          worse of the two: you change a line, it vanishes, and nothing tells you whether the save
          failed, the watch dropped, or the module threw.
        -->
        <div v-else-if="bundle && bundle.error" class="card__broke">
          <AppIcon name="alert" :size="18" />
          <div class="card__broke-what">
            <p class="card__broke-head">This card would not load.</p>
            <code class="card__broke-why">{{ bundle.error }}</code>
          </div>
        </div>

        <!--
          No surfaces here.

          The ten branches that stood in this place - the pass, the change set, the talk, the
          pool, the bumps, the reviewers, the checks, the facts, the commits - are in
          CardSurface.vue, and a card's module invokes it. That is what makes the body the card's
          own: the shell had the opinion about what a card shows, and a card held in a ConfigMap
          could not use the surface that already existed without redrawing it.
        -->
      </div>
    </div>

    <!--
      One row, and two heights inside it: the decision at 44px in the card's own hue, everything
      else at 32px, and the way out as text at the end of the row. Measured before this: 125px of
      footer with the buttons on two rows at 341 and 401, five equal 48px boxes, against 88px of
      body on the same card - and then, after that was fixed, four heights on one row ([48, 38, 38,
      30]) with the primary itself resolving to 48px on the deck's first eleven cards and 47px on
      the last fifteen.
    -->
    <footer class="card__foot">
      <!--
        `busy || reading`: not pressable on evidence that has not arrived.

        `Post the review` was live over its own spinner - the card offers an irreversible act on
        a list of findings it is still fetching, and `submitReview` can only throw until they are
        there. See `reading`.
      -->
      <AppButton
        v-if="primary"
        variant="kind"
        size="lg"
        :icon="agenticPrimary ? 'sparkle' : undefined"
        icon-after="arrow-right"
        :busy="busy || reading"
        :class="{ 'card__sure': confirming === primary.label }"
        @click="press(primary)"
      >{{ labelOf(primary) }}</AppButton>

      <!-- The question this card offers, or the general one where it offers none. -->
      <AppButton
        v-if="asked"
        variant="ghost"
        size="md"
        icon="sparkle"
        :class="{ 'card__sure': confirming === asked.label }"
        @click="press(asked)"
      >{{ labelOf(asked) }}</AppButton>
      <AppButton
        v-else-if="!offersAsk"
        variant="ghost"
        size="md"
        icon="sparkle"
        @click="emit('ask')"
      >
        Ask about this
      </AppButton>

      <!--
        Everywhere else this work is. One control, so the row can never become two.

        "Elsewhere", not "More". It was `More` over a list of whatever actions the definition had
        left over, which across all sixteen shipped cards could only ever be a single `open` - and
        that `open` was a prompt dressed as navigation. What is behind it now is only ever places:
        the pull request, the review, the workspace, the build. A control that holds one kind of
        thing should say which kind.
      -->
      <!--
        One link is not a menu.

        Measured on the top card, `Elsewhere` opened onto exactly one row - `Open the review` -
        and across the ten live kinds it held one row on eight of them. A chevron, a popover and
        a piece of component state to reach a single link is the same fault this control's own
        comment says it fixed for `More`; where there is one place to go, the button is that
        place and says its name.
      -->
      <AppButton
        v-if="navs.length === 1"
        variant="quiet"
        size="md"
        icon="expand"
        @click="press(navs[0])"
      >{{ navs[0].label }}</AppButton>

      <div v-else-if="navs.length" class="card__overflow">
        <AppButton
          variant="quiet"
          size="md"
          icon="expand"
          icon-after="chevron-down"
          :aria-expanded="navOpen ? 'true' : 'false'"
          @click="navOpen = !navOpen"
        >Elsewhere</AppButton>

        <div v-if="navOpen" class="u-popover card__menu">
          <button
            v-for="action in navs"
            :key="action.label"
            type="button"
            class="card__menu-row"
            @click="navOpen = false; press(action)"
          >
            <AppIcon name="expand" :size="12" />
            {{ action.label }}
          </button>
        </div>
      </div>

      <!-- The way out, at the other end from the thing it is the opposite of. -->
      <button
        v-if="later"
        type="button"
        class="card__later"
        @click="press(later)"
      >{{ labelOf(later) }}</button>
    </footer>

    <!-- The description, or what was said about it, read over the card. See `prose` and `talk`. -->
    <TextModal
      v-if="readOn"
      :title="readOn === 'talk' ? `What was said · ${ talk.length } ${ talk.length === 1 ? 'comment' : 'comments' }` : proseLabel"
      :text="readOn === 'talk' ? talkText : prose"
      :at="task.what"
      @close="readOn = ''"
    />
  </article>
</template>


<style scoped>
/*
 * Three zones with a budget, written down.
 *
 * It was a column flex box and the three zones fought over it, so the ratio was decided by how
 * long the title happened to be: measured head/body/foot across the deck came out 221/23/125,
 * 178/66/125, 156/88/125 and 120/184/65 on a 484px card. The zone carrying the thing you opened
 * the card for got 5% of it while the header took 46%, and the deck visibly breathed as you
 * turned it because the same kind of card gave its surface 23px on one pull request and 88px on
 * the next.
 *
 * So: `auto minmax(0, 1fr) auto`, and the head and the foot are capped rather than merely asked
 * nicely. The head is the sum of its capped parts and nothing else: 32 (the chip row, which now
 * carries the identifier too) + 4 + 60 (two title lines at 26px, reserved on the header rather
 * than inside the title) + 4 + 19 (one 13px line of why) = 119px whatever the title says. The foot
 * is one 44px row plus its rule. The body is the rest, and it is the same share on every kind of
 * card, which is the point.
 *
 * **It was 165, and the 46px went to the surface.** Two things were being paid for twice: a
 * `.card__ident` block under the summary that `@rancher/shell`'s bare `code` rule was drawing as a
 * 696x31 bordered box holding seven characters, and 30px of reserved second line sitting *inside*
 * the title box under a one-line title on 12 of 26 cards. The identifier is a control on the chip
 * row and the reservation is one gap below the summary; the surface went 127px to 173px, which is
 * the room the pass's verdict buttons and the diff pane were starving for.
 *
 * **The budget capped the wrong things.** It capped the head and the foot and left the body a
 * free-for-all, so the starvation moved rather than stopped: inside the body the evidence band
 * kept its natural height while every surface could shrink, and the surface the card exists for
 * went to 23-40px under 105px of thumbnails. The body is a budget too now - a facts row at
 * `flex: 0 0 auto`, one surface with a 120px floor, and nothing else - and the two 42px savings
 * (the provenance row's duplicate numbers, the card's 33px padding) went to the surface rather
 * than to the header.
 */
.card {
  position: relative;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  height: 100%;
  /* The card may be narrower than the widest thing in it; see the deck's grid track. */
  min-width: 0;
  /*
   * A flat `--s4`.
   *
   * It was a `clamp()` that resolved to 33px, so 66px of the card's 478px height was its own
   * margin while its subject had 195px; then a flat `--s5`, 48px of the two. At the measured
   * 1024x678 the card is 488px and the surface - the only part of it that is the work - was 173px
   * of that, with 60px of code in it on a diff card. 16px of frame is still a frame; the other
   * 16px is a line of code. The screen's whole job is to show you one thing.
   */
  padding: var(--s4);
  border: 1px solid var(--border);
  /* The hue closes the card at both ends, so a card reads as one object rather than as a
     coloured header with a page under it. */
  border-top: 1px solid color-mix(in srgb, var(--kind) 34%, var(--border));
  border-bottom: 1px solid color-mix(in srgb, var(--kind) 34%, var(--border));
  border-radius: var(--r-xl);
  background:
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--kind) 7%, var(--surface)) 0%,
      var(--surface) 22%,
      var(--surface) 78%,
      color-mix(in srgb, var(--kind) 7%, var(--surface)) 100%
    );
  box-shadow: var(--shadow-card);
  overflow: hidden;
}

/* The hue, once, at the top of the component that owns it. */
.card--review   { --kind: var(--kind-review);   --kind-deep: var(--kind-review-deep);   --kind-wash: var(--kind-review-wash); }
.card--issue    { --kind: var(--kind-issue);    --kind-deep: var(--kind-issue-deep);    --kind-wash: var(--kind-issue-wash); }
.card--agent    { --kind: var(--kind-agent);    --kind-deep: var(--kind-agent-deep);    --kind-wash: var(--kind-agent-wash); }
.card--question { --kind: var(--kind-question); --kind-deep: var(--kind-question-deep); --kind-wash: var(--kind-question-wash); }
.card--signal   { --kind: var(--kind-signal);   --kind-deep: var(--kind-signal-deep);   --kind-wash: var(--kind-signal-wash); }

.card__glow {
  position: absolute;
  inset: -40% 20% auto;
  height: 60%;
  background: radial-gradient(60% 60% at 50% 0%, color-mix(in srgb, var(--kind) 26%, transparent), transparent 70%);
  filter: blur(18px);
  pointer-events: none;
}

/* The same light at the other end, quieter, so the card is lit from both edges rather than
   hung from the top one. */
/*
 * Kept inside the card rather than hung below it. Hanging it out cost nothing to look at - the
 * card clips - but on a phone the card is the scroller, and an invisible glow below the footer
 * is two hundred and eighty pixels of dead scroll at the end of every card.
 */
.card__glow--foot {
  inset: auto 20% 0;
  height: 46%;
  background: radial-gradient(60% 70% at 50% 116%, color-mix(in srgb, var(--kind) 30%, transparent), transparent 70%);
}

/*
 * The face this card wears while it is behind another one.
 *
 * Only a card's top edge is ever seen from inside the stack, so from there the edge is the
 * whole card and it is painted in the kind's colour, strong enough to be read at fifteen
 * pixels. It is a layer rather than a different background because the deck fades it off as a
 * card comes forward: without that, the top of an arriving card changed shade in one step,
 * which is the one part of a turn you cannot help but notice.
 *
 * Drawn before the header, which is positioned - so it sits over the card's background and
 * under its words.
 */
.card__band {
  position: absolute;
  inset: 0 0 auto;
  height: 58px;
  background:
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--kind) 62%, var(--surface)) 0,
      color-mix(in srgb, var(--kind) 22%, var(--surface)) 14px,
      transparent 58px
    );
  box-shadow:
    inset 0 2px 0 var(--kind),
    0 -10px 30px -16px color-mix(in srgb, var(--kind) 55%, transparent);
  opacity: 0;
  pointer-events: none;
}

/*
 * The row of actions, separated from what it acts on.
 *
 * `.card__head,` and `.card__body,` sat at the head of this selector list, so all three zones
 * shared the footer's declarations and the head's and the body's own rules only overrode part of
 * them. What that cost, measured: the body computed `display:flex; flex-direction:column;
 * flex-wrap:wrap; align-items:center; border-top:1px; padding-top:16px`, so a 23-131px column
 * that wraps threw every child after the first into a second column to the right - a review
 * card's diff drew at x=1479 on a card whose right edge is 962, and `overflow:hidden` clipped it
 * away entirely. The header computed `display:flex` and laid the h2 out *beside* the p. And the
 * body grew a hairline and 16px of padding nobody wrote on purpose.
 *
 * One rule, one zone, and `focus.css`'s `.dev-focus header{display:block}` can do its job again.
 */
.card__foot {
  display: flex;
  align-items: center;
  gap: var(--s3);
  /* Never two rows: the navigation goes behind one control instead. See `navs`. */
  flex-wrap: nowrap;
  min-width: 0;
  margin-top: var(--s4);
  padding-top: var(--s4);
  border-top: 1px solid color-mix(in srgb, var(--kind) 16%, var(--border));
}

/*
 * The buttons give; the way out does not.
 *
 * Every `.btn` in here was `flex: 0 1 auto` by default *and* `white-space: nowrap`, so nothing on
 * the row could shrink and the overflow was paid by whatever was last. `Later` is last. Measured
 * across the deck: card content ends at 938 on every card, and `.card__later`'s right edge came
 * out 955, 975 and 983 - up to 21px of it painted outside the card's 962px border and removed by
 * `overflow: hidden`, which three screenshots show as the word "Late". It happens whenever the
 * footer has four children: 242 + 187 + 195 + 58, three 12px gaps and a 16px margin is 734 in 688.
 *
 * So the two middle controls are the ones that give - their labels ellipsise, see `.btn__label` -
 * and `Later` keeps its width, because a control that is clipped is a control that is not there
 * and this is the only one that means "not now". The 203px duplicate nav is gone as well (see
 * `navs`), which on dot9 alone took the row from 983 to 768.
 */
.card__foot > :deep(.btn) { flex: 0 1 auto; min-width: 0; }

/* The decision keeps its label: it is the one thing the card wants read. */
.card__foot > :deep(.btn--lg) { flex: 0 0 auto; }

/*
 * Never squeezed.
 *
 * The card is a column flex box, so every child of it shrinks by default - and a header with no
 * `overflow` does not clip when it is shrunk, it draws its children outside itself. Once the body
 * grew tall enough to push (which is what putting the evidence and a diff on a card did), the
 * summary and the byline were painted straight over the top of the body. The header is as tall as
 * its text and the body is what gives: that is what `min-height: 0` and `overflow: auto` down
 * there are for.
 */
/*
 * A block, said out loud.
 *
 * `focus.css` already says `.dev-focus header { display: block }` for exactly this reason - the
 * shell's own `header { display: flex }` leaks in here - and the dangling selector above beat it
 * on specificity. Declared here as well so neither can take it back: without it the h2 and the p
 * are flex items on one line, and measured they were - title at offsetLeft 0 and summary at 415
 * on the same offsetTop, on 13 of the deck's 36 cards, with the rest escaping only because the
 * title happened to wrap first.
 */
/*
 * The reservation moved out of the title and onto the header.
 *
 * `.card__title` reserved two lines so that every card's body started at the same y. On the 12
 * cards whose title is one line that put 30px of slack *inside* the title box, directly under the
 * words, 4px above the summary - so it read as a hole rather than as spacing, plainly visible
 * under "Switch cluster import to use to RcSections" and "9 dependency bumps". And on the one
 * card whose title wants three lines it clamped the third away while the box was already tall
 * enough for it.
 *
 * Same total, one gap, and the gap falls below the summary where a gap reads as rhythm.
 *
 * **89px, which is one title line and not two.** It was 119 = 32 (the chip row) + 4 + 60 (two
 * title lines at 26px) + 4 + 19 (the summary), reserved so that there is no step between a
 * one-line card and a two-line one. There still is not; the reservation is just one line shorter.
 * 12 of the deck's 26 titles are one line, and on those the second reserved line was 30px of the
 * card held empty for a line that never came - on a diff card whose code pane was 99px. The whole
 * title is in the `title` attribute, in the chat bar's subject and in every modal the card opens,
 * so the clamp costs a glance and not the words. The header was 165px before the identifier moved
 * onto the chip row; 76px of it has gone to the surface, which is the only part of this card that
 * is the work.
 */
.card__head {
  position: relative;
  display: block;
  min-width: 0;
  min-height: 89px;
}

/*
 * One line, and everything on it the same height.
 *
 * It had four things on it at three different heights - a chip, a monospace string, a pill and
 * a button - which reads as four things that happen to be near each other rather than as a
 * line. They all take the row's height now and sit on its centre; what differs between them is
 * weight and colour, which is what was supposed to be doing the work.
 */
/*
 * `--control-h`, not a fourth number. The row centred a 24px chip beside a 24px workspace tag
 * beside a 30px nav; everything that stands on it is one height now, and that height is the one
 * everything you press in this view is. See `--control-h` in design/focus.css.
 */
.card__head-line {
  --head-h: var(--control-h);
  display: flex;
  align-items: center;
  gap: var(--s2);
  /* One line that truncates, rather than a line that wraps: the title under it is the thing
     allowed to take two lines, and a header that grows pushes it down by a row. */
  flex-wrap: nowrap;
  min-width: 0;
  overflow: hidden;
}

/* The boxes on the line are one size; the text on it is text, as it is in the prototype. */
.card__head-line > .chip,
.card__head-line > .card__pin,
.card__head-line > .card__overdue { height: var(--head-h); }

/* The chip is the prototype's; only its box is told to match the row. */
.card__head-line :deep(.chip) {
  display: inline-flex;
  align-items: center;
  height: var(--head-h);
  padding-top: 0;
  padding-bottom: 0;
}

/*
 * The pin: a control the size the rest of them are (`--control-h`, 32px), in the
 * card's top-left corner. It shows its glyph alone until the pointer is on the card, and then
 * says what it does - a corner icon with no word is a thing people press to find out.
 */
/*
 * The pin is drawn at the chip's size, because it is on the chip's row: a 24px disc of ink with
 * a hit area six pixels bigger all round. Visual size and target size are different numbers and
 * this is the one place in the view where they have to be - a control sized to be hit would be
 * the largest thing on a line of 24px boxes.
 */
.card__pin {
  position: relative;
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: var(--head-h);
  height: var(--head-h);
  border: 1px solid var(--border);
  border-radius: var(--r-pill);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: color var(--fast), border-color var(--fast), background var(--fast);
}

/*
 * The hit area, taller than the ink rather than wider: the row clips horizontally - it has to, or
 * a long workspace name pushes the line out - so a target that reached sideways was six pixels of
 * nothing being clipped. At 32px the ink is the target; this is what is left of the days when it
 * was 24, and it costs nothing to keep a thumb's worth of slack above and below.
 */
.card__pin::after {
  content: '';
  position: absolute;
  inset: -5px 0;
}

.card__pin:hover { color: var(--text); border-color: var(--border-strong); }

.card__pin--on {
  border-color: color-mix(in srgb, var(--kind) 55%, transparent);
  background: var(--kind-wash);
  color: var(--kind);
}



.card__overdue {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  margin-left: auto;
  gap: 5px;
  padding: 0 var(--s3);
  border-radius: var(--r-pill);
  background: var(--warning-wash);
  color: var(--warning);
  font-size: var(--t-xs);
  font-weight: 600;
}

/*
 * Two lines, always two lines, at one size on every card.
 *
 * The size was `clamp(--t-xl, 3.1vw, --t-3xl)` - up to 48px - with a second size for cards
 * carrying a surface, so a long title took four lines and a third of the card before anything else
 * got a say. It was then pinned at `--t-lg`, 19px, which is the size this product sets a table
 * row's heading at: the subject of a screen whose whole premise is one thing at a time, set at the
 * size of a list item, and the largest type anywhere in the deck.
 *
 * `--t-xl`, with the line *reserved* on the header rather than merely capped here. 10 of 26 titles
 * wrapped at 19px, and because the card is a fixed height each of those paid for the second line
 * out of its own body - so the same kind of card gave its surface 22px less than its neighbour for
 * no reason but how long somebody's pull request title happened to be. A reservation costs the
 * short titles a gap and buys every card the same body.
 *
 * **One line, not two.** Two lines reserved is 30px held empty on the 12 cards whose title is one,
 * and a 26px title is the second-largest thing on the card after the lede - it is not where the
 * reading happens. The full text is in the tooltip and in the three other places the card writes
 * it, and the 30px is eight lines of a diff.
 */
.card__title {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 1;
  /* No `min-height` here any more; the header carries the reservation. See `.card__head`. */
  margin-top: var(--s1);
  font-size: var(--t-xl);
  line-height: 1.15;
  letter-spacing: -0.02em;
  overflow: hidden;
}

/* One line: what it wants and why, truncated rather than allowed to become a paragraph. */
.card__summary {
  margin-top: var(--s1);
  color: var(--text-dim);
  font-size: var(--t-sm);
  line-height: 1.45;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card__why { color: var(--text-muted); }

/*
 * Which thing this is: a quiet mono control on the head-line, at the row's own height.
 *
 * It was a block under the summary, and the shell's bare `code` rule - which nothing in this view
 * undid until now - drew it as a 696x31 bordered, sunk, 5px-padded box holding seven characters,
 * reading as an empty disabled text input on every card in the deck. On the line it costs its own
 * width and nothing else, and it is the one place a card names the thing it is about, so it is
 * also the link to it.
 */
.card__ident {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  height: var(--head-h, var(--control-h));
  max-width: 50%;
  min-width: 0;
  padding: 0 var(--s2);
  border-radius: var(--r-sm);
  color: var(--text-muted);
  font-family: var(--mono);
  font-size: var(--t-sm);
  overflow: hidden;
  text-decoration: none;
  text-overflow: ellipsis;
  white-space: nowrap;
}

a.card__ident { cursor: pointer; }
a.card__ident:hover { background: var(--surface-raised); color: var(--text); text-decoration: none; }

/*
 * The band of numbers: the headline one, and the strip of facts beside it.
 *
 * One row, pinned. It was a column of three that kept its natural height inside a body whose every
 * other child could shrink - so a card's 8-thumbnail filmstrip was at 105px while the 13 files you
 * were being asked to mark ready for review were at 40px. The strip is what is left of that band,
 * and the lede is the one number on the card worth reading from across the room; they are on one
 * line because they are both the same thing, which is the arithmetic of the work.
 */
/*
 * One 37px row, and it is 37px on every card.
 *
 * It wrapped, and so it measured 37px on 14 cards, 71px on 9 and 105px on dot8 - which put the
 * surface's top edge at y341, y375 or y409 depending on which card you had turned to, a jump of
 * up to 68px as you move through the deck. The title reserves its lines precisely so the body
 * starts at a constant y, and this undid it on 12 of 26.
 *
 * So it is a height rather than a hope, and the strip scrolls sideways instead of stacking. What
 * is on it is a row of facts; the fifth fact on a long one is worth a drag, not 34px of every
 * other card in the deck.
 */
.card__facts {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  flex-wrap: nowrap;
  gap: var(--s4);
  height: 37px;
  min-width: 0;
  /*
   * And it keeps what is in it. Measured `h: 37 / scrollHeight: 43` on every card walked - the
   * lede's own box is 36px, so there is nothing to clip, but a band declared one height and
   * reporting another is the thing this rule exists to stop being true.
   */
  overflow: hidden;
}

.card__lede {
  display: flex;
  align-items: baseline;
  flex: 0 0 auto;
  gap: var(--s2);
  min-width: 0;
}

.card__lede-n {
  color: var(--kind);
  font-size: var(--t-2xl);
  font-weight: 650;
  letter-spacing: -0.03em;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/*
 * Beside it on the baseline, quiet: the number is what carries, and the noun says what of.
 *
 * `line-height: 1`, like the number's. Without it this 13px span inherited a 1.45 line, and because
 * the two are baseline-aligned its extra descent hung below the 36px number - so `.card__lede`
 * laid out at 42px inside a band declared 37px and poked 2.5px out of it at both ends. Measured:
 * `.card__facts` h 37 / scrollHeight 42 on all nine cards walked. Both boxes are 36 now.
 */
.card__lede-of {
  color: var(--text-muted);
  font-size: var(--t-sm);
  line-height: 1;
  white-space: nowrap;
}

.card__lede--good .card__lede-n { color: var(--success); }
.card__lede--warn .card__lede-n { color: var(--warning); }
.card__lede--bad .card__lede-n { color: var(--danger); }

/*
 * A verdict, where the slot is built for a quantity.
 *
 * The advisory card's lede is `high`. In the number treatment - 36px, 650, tabular figures,
 * -0.03em - a lowercase word reads as an unfinished string, which is what all three advisory cards
 * looked like. Caps at `--t-xl` over the tone's own wash is the treatment a severity wants: still
 * the largest thing on the card, still in `--danger`, and legible as a judgement rather than as a
 * truncated label.
 */
.card__lede--word .card__lede-n {
  padding: 0 var(--s3);
  border-radius: var(--r-sm);
  background: color-mix(in srgb, currentcolor 13%, transparent);
  font-size: var(--t-xl);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

/*
 * `.card__strip` lived here, and so did the two pills the card added to it by hand.
 *
 * It was `display: contents` on CardEvidence's root so that the description control and the wait
 * pill could sit on the same row as the artifacts' - which is also what made the row's snap target
 * a 0px-wide wrapper and the row arrive pre-scrolled. Then it was `overflow: auto hidden` with the
 * scrollbar hidden and a fade for a signal, which measured 740px of content in a 524px box on 4 of
 * the 11 cards walked and put the red-pr card's one control at x1025 on a 1024px window.
 *
 * The line has one owner now and it is CardEvidence: the card hands it `waited` and `prose` as
 * props, the numbers are coloured text with `.` between them, the two or three pressable things
 * keep a border, and anything past them is one `+n` chip. Nothing here is left to say.
 */


/*
 * The surface. Every declaration here is load-bearing and every one of them was being supplied
 * by the footer's rule instead.
 *
 * `flex-wrap: nowrap` and `align-items: stretch` are written out rather than left to the
 * defaults because the defaults are what the merged rule overrode, and the cost was not subtle:
 * wrapping put the diff in a second column 517px off the card, and `align-items: center` sized
 * every surface to its content and centred it, so no two cards shared a left margin - measured,
 * `.card__said` started at x=271, 575, 676, 685, 693, 773, 788 and 839 across one walk of the
 * deck while the title stayed at 250. `overflow: hidden auto` because the only thing that was
 * reachable by scrolling sideways was content that should never have been out there: scrollWidth
 * measured 1897 against a 668px box. Code scrolls inside CodeView, where the lines are.
 */
.card__body {
  display: flex;
  flex-direction: column;
  flex-wrap: nowrap;
  align-items: stretch;
  gap: var(--s4);
  min-width: 0;
  min-height: 0;
  margin-top: var(--s4);
  padding-right: var(--s2);
  /*
   * `hidden`, not `auto`.
   *
   * It scrolled on 14 of 26 cards - clientHeight 180 against scrollHeight 191-243 - and it was
   * the one scroller in the view not wearing `u-fade-y`, so it cut on a hard horizontal edge
   * through the middle of a glyph: a bisected reviewer row, a file row sliced through its letters,
   * half a row of `github/gh-aw-actions/setup`. The utility cannot go here - `.u-fade-y`'s own
   * comment says why: a mask makes a compositing context and this box holds CardChecks' popover,
   * which is meant to float out of it.
   *
   * So the body stops scrolling instead. Everything in it is bounded: the facts band is 37px
   * exactly and the surface is one box with a floor that scrolls inside itself, which is where the
   * scrolling belonged. A body that cannot scroll also cannot hide the surface by scrolling it.
   */
  overflow: hidden;
}

/*
 * The surface, and the floor under it.
 *
 * Two declarations, and between them they are most of what was wrong with this card. Every child
 * of the body shrinks by default and none of them had a minimum, so the band kept its natural
 * height and the subject took what was left: measured, `pass` at 28px on a card headed "Go through
 * the agent's findings" with "0 of 8 decided" on it, `cm` at 1px against a natural 10px on a card
 * about 20 commits, `changes` at 23px for 13 files under a button that marks the work ready for
 * review. 120px is three rows and a header - the least that is worth drawing a surface for - and
 * below that the card would rather scroll than pretend.
 */
.card__surface {
  display: flex;
  flex-direction: column;
  /*
   * `0%`, not `auto`.
   *
   * With an `auto` basis a flex item starts at its *content* size and is only then shrunk, so a
   * surface holding a 16,000px diff asks for 16,000px and depends on every ancestor in the chain
   * saying no. Measured on the installed plugin: `cv__rows` ended 16,257px below the bottom of the
   * card, and the tree and the code painted over the facts strip. With a `0%` basis the item is
   * sized by the room the card has and the diff scrolls inside it, which is what `.file` and
   * `.hunk` were always written to do.
   */
  flex: 1 1 0%;
  min-width: 0;
  min-height: 120px;
}

/* What it says it is, named and then quoted: the surface of the cards that have no other. */
.card__said {
  display: flex;
  flex-direction: column;
  gap: var(--s2);
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
}

/* Opens the whole of it over the card; see the pill on the facts strip, which is the same act. */
.card__all {
  flex: 0 0 auto;
  height: var(--control-h);
  padding: 0 var(--s3);
  border: 1px solid var(--border);
  border-radius: var(--r-pill);
  background: none;
  color: var(--text-muted);
  font: inherit;
  font-size: var(--t-xs);
  cursor: pointer;
  white-space: nowrap;
}

.card__all:hover { border-color: var(--kind); color: var(--text); }

/* An issue's own words: as much as fits, scrolled, rather than a paragraph cut off mid-sentence. */
.card__read {
  flex: 1 1 auto;
  min-height: 0;
  /* The fade's own room; see `.u-fade-y` in design/focus.css. An issue's own words used to stop
     mid-word at the clip edge, which reads as a rendering fault rather than as more below. */
  padding: 0 var(--s2) var(--s5) 0;
  overflow-y: auto;
}

/* Pressed once: it is about to do something outside this cluster, and says so. */
.card__sure {
  border-color: var(--danger) !important;
  color: var(--danger) !important;
}

/*
 * Where the surface will be, while it is being read.
 *
 * It takes the room the surface will take, so the card does not resize when the content arrives -
 * which is the other half of why content appearing was jarring: it both appeared and moved
 * everything under it.
 */
/*
 * Centred on both axes, because it had only one.
 *
 * It measured 688x180 with its 20px spinner and 160px of text pinned to the left edge and
 * floating in the vertical middle, which reads as a card that failed rather than one that is
 * loading. `align-items` without `justify-content` is half a centring.
 */
/*
 * Sized by the card and clipped, though all it holds is a spinner and six words.
 *
 * Not defensive about its own content - it is defensive about content that should never be here
 * at all. A branch-key collision mounted a card's whole body into this box (see the module
 * wrapper above), and because this is a centred *row*, the body's height was a cross size that
 * centring leaves at content size: a 16,000px diff, painting half of itself above the card and
 * half below, through a box with no `overflow`. The structural fault is fixed where it was made,
 * and the rules that would have contained it anyway belong here too, because this is the second
 * time a box in this view has been asked to hold something its author never pictured.
 */
.card__reading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--s3);
  /* `0%`, not `auto`: sized by the room the card has, never by whatever lands inside it. */
  flex: 1 1 0%;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
  color: var(--text-faint);
  font-size: var(--t-sm);
}

/* Where the work lives. A control, so it reads as somewhere you can go rather than a label. */
.card__ws {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  /*
   * Shrinkable, and the first thing on the line to give. The identifier beside it is what this
   * card is about and is pinned; a workspace name is derivable from it, so a long one loses its
   * tail rather than pushing `PR #19153` into `PR #1…` - which is the exact cut this line was
   * reorganised to stop.
   */
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  /* The header line's own height, which is `--control-h`: everything on that line is the same
     height on purpose, and this one is pressed. It was 24px on 22 of the deck's 26 cards. */
  height: var(--head-h, var(--control-h));
  padding: 0 var(--s3);
  border: 1px solid var(--border);
  border-radius: var(--r-pill);
  background: transparent;
  /* 2.39:1 at 11px, and it is pressed. See `.card__later` for the same number. */
  color: var(--text-muted);
  font-family: var(--mono);
  font-size: var(--t-xs);
  cursor: pointer;
  white-space: nowrap;
  transition: color var(--fast), border-color var(--fast);
}

.card__ws:hover { border-color: var(--kind); color: var(--text); }

/* Nothing to open: an offer to make one, in the card's own colour so it reads as the next step. */
.card__ws--none {
  border-style: dashed;
  border-color: color-mix(in srgb, var(--kind) 40%, transparent);
  color: var(--kind);
  font-family: var(--font);
}

.card__ws--none:hover { background: color-mix(in srgb, var(--kind) 12%, transparent); }

/*
 * The way out: text, at the far end of the row.
 *
 * `Later` was a 48px ghost button identical to the other four, which is a card asking you to
 * choose between doing the work and not doing it in the same breath and the same weight.
 */
/*
 * The way out, at the end of the row rather than at the end of the card.
 *
 * `Later` was a 48px ghost button identical to the other four, which is a card asking you to choose
 * between doing the work and not doing it in the same breath and the same weight. It was then
 * `margin-left: auto`, which put it at the card's right edge - so the gap before it measured 72px
 * on one card and 336px on the next, from nothing but how long the other labels were. The row ends
 * where the buttons end; the separation is a gap, and a gap is the same on every card.
 */
.card__later {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  height: var(--control-h);
  margin-left: var(--s4);
  padding: 0 var(--s3);
  /*
   * `--text-muted` with a hairline, not `--text-faint` on the ground.
   *
   * Measured against the card's own background it computed to rgb(77, 85, 114) - 2.39:1 for 13px
   * text, against a 4.5:1 requirement - so the one way out of a card was effectively not there in
   * any screenshot. The footer ran four contrast levels across one 61px row. It is still the
   * quietest thing on that row; it is now a thing you can see.
   */
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: none;
  color: var(--text-muted);
  font: inherit;
  font-size: var(--t-sm);
  cursor: pointer;
}

.card__later:hover { border-color: var(--border-strong); background: var(--surface-raised); color: var(--text); }

/* The overflow, which is what keeps the row one row. `.u-popover` is the surface; this places it. */
.card__overflow { position: relative; flex: 0 0 auto; }

.card__menu {
  bottom: calc(100% + var(--s2));
  left: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.card__menu-row {
  display: flex;
  align-items: center;
  gap: var(--s2);
  min-height: var(--control-h);
  padding: 0 var(--s3);
  border: 0;
  border-radius: var(--r-sm);
  background: none;
  color: var(--text-dim);
  font: inherit;
  font-size: var(--t-sm);
  text-align: left;
  cursor: pointer;
  white-space: nowrap;
}

.card__menu-row:hover { background: var(--surface-raised); color: var(--text); }

/* ── A card held outside the bundle ───────────────────────────────────────── */

/*
 * The module's body gets what a surface got: the remaining height, and permission to scroll inside
 * itself rather than push the footer down. Every built-in surface is bounded this way and a card
 * from a ConfigMap is not a different kind of card.
 *
 * A flex column that takes the leftover, because the surfaces were direct children of
 * `.card__body` until this wrapper existed and they size themselves against their parent. Without
 * the column a surface's own flex rule has nothing to resolve against and it collapses to its
 * content - which is the fault that has produced "overlapping elements" four times in this view.
 */
.card__bundle {
  display: flex;
  flex-direction: column;
  /* `0%` for the same reason as `.card__surface` above: the body is sized by the card, not by
     the diff inside it. */
  flex: 1 1 0%;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}

/*
 * The floor under whatever the module drew.
 *
 * A flex item's automatic minimum is its content, so a surface holding a 16,000px diff refuses to
 * shrink and leaves its rows painting over the footer however bounded this wrapper is - the box
 * clips, but the `minmax(0, 1fr)` row inside it has no definite height to resolve against, so
 * nothing ever starts scrolling. Zeroing the minimum is what lets a tall surface come down to the
 * room it has and hand a real height to the scrollers inside it.
 *
 * Only the minimums: the basis is left alone on purpose. Sizing these from the container instead
 * would stretch the short surfaces - `facts`, `said` - to the full height of the card.
 */
.card__bundle > * {
  min-height: 0;
  min-width: 0;
}

.card__broke {
  display: flex;
  align-items: flex-start;
  gap: var(--s3);
  min-height: 0;
  padding: var(--s4);
  border: 1px solid var(--danger);
  border-radius: var(--r-md);
  background: var(--danger-wash);
  color: var(--danger);
  overflow: hidden auto;
}

.card__broke-what { min-width: 0; }

.card__broke-head {
  margin: 0 0 var(--s2);
  color: var(--text);
  font-size: var(--t-sm);
  font-weight: 650;
}

.card__broke-why {
  display: block;
  color: var(--text-dim);
  font-family: var(--mono);
  font-size: var(--t-xs);
  line-height: 1.5;
  /* A compiler's message is one long line with no space to break at. */
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
</style>
