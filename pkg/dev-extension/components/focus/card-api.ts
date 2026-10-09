/**
 * What a card held outside the bundle is given, and what it gives back.
 *
 * The shell keeps the parts of a card that are the same on every card - the chip, the title, the
 * lede, the footer, the pin, the workspace tag, the loading state - and a module supplies the two
 * parts that are not: the **body** and the **actions**. That split is not a guess about what
 * might be wanted; it is where the existing cards already differ. Nineteen definitions share one
 * header and one footer and pick between eleven bodies, so the body and the buttons are exactly
 * the axis along which a card is a different card.
 *
 * ## The contract
 *
 *     module.exports = {
 *       id: 'review-pass',               // which card this is; must match the definition's id
 *       wants: ['notes', 'stat'],        // artifacts to load, same names focus-artifacts.ts uses
 *       template: '<div>...</div>',      // compiled here; or `component` for a built one
 *       setup(api) { return { ... } },   // bindings the template can see
 *       actions(api) { return [ ... ] }, // optional; replaces the definition's buttons
 *     };
 *
 * `setup` receives the api and returns what the template reads, exactly as a `setup()` in a
 * single-file component does. Every live value on the api is a **ref**, because `setup` runs once
 * and a plain value read at that moment would never change again - the artifacts in particular
 * arrive a second after the card does.
 *
 * ## Why everything is handed in
 *
 * A module gets `vue` from the api and imports nothing. This is not tidiness: a UMD bundle
 * resolves its externals through `require` or a global, and neither reaches the `vue` this bundle
 * is using. Two copies of Vue in one page is the same fault that makes `useRouter()` silently
 * dead in the installed plugin - a composable's injection does not cross between copies. A card
 * that imported its own Vue would mount into a different reactivity system and never update.
 *
 * It is also what keeps a card small enough to live in a ConfigMap. Externalised, a card is a few
 * kilobytes; with Vue inlined, four of them would not fit in one map's 1MiB.
 */
import * as vue from 'vue';
import type { Ref } from 'vue';
import { compileTemplate, DEFAULT_BODY } from './card-runtime';
import { componentsIn } from './card-modules';
import type { LoadedCard } from '../../focus-cards';

import AppButton from './AppButton.vue';
import AppIcon from './AppIcon.vue';
import KindChip from './KindChip.vue';
import Markdown from './Markdown.vue';
import TextModal from './TextModal.vue';
import SectionHead from './SectionHead.vue';
import StatPill from './StatPill.vue';
import IssueMarks from './IssueMarks.vue';
import CheckList from './CheckList.vue';
import CommentBody from './CommentBody.vue';
import MediaViewer from './MediaViewer.vue';
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
import CardChecks from './CardChecks.vue';
import CardSurface from './CardSurface.vue';
import CodeView from '../code/CodeView.vue';
import FileModal from '../code/FileModal.vue';

/**
 * The surfaces a card can build out of, rather than build again.
 *
 * The eleven bodies the shipped cards pick between are in here, so moving a card out of the
 * bundle is not a rewrite: a card whose body is `<ReviewPass ... />` is a three-line module. The
 * smaller pieces are here for the same reason in the other direction - a card that wants a hunk
 * and a sentence beside it composes `CodeView` and `Markdown` instead of reimplementing either,
 * which is how every surface in this view stays the same shape as every other.
 */
export const CARD_COMPONENTS: Record<string, any> = {
  /*
   * First, because every ported card's body is one `<CardSurface :api="api" />` and it was the
   * one component missing from this map - see `componentsIn`, written after that cost nineteen
   * cards their bodies.
   */
  CardSurface,
  AppButton,
  AppIcon,
  KindChip,
  Markdown,
  TextModal,
  SectionHead,
  StatPill,
  IssueMarks,
  CheckList,
  CommentBody,
  MediaViewer,
  ReviewPass,
  ChangeSet,
  CardComments,
  CardEvidence,
  CardPool,
  CardBumps,
  CardReviewers,
  CardCommits,
  CardAgent,
  CardFacts,
  CardChecks,
  CodeView,
  FileModal,
};

export interface CardApi {
  /** The Vue drawing the page around this card. See the note at the top of this file. */
  vue: typeof vue;

  /** The work this card is about: the queue item, its title, its card definition. */
  task: Ref<any>;
  /** Everything the card asked for in `wants`, as it arrives. */
  artifacts: Ref<any>;
  /** The agent's comments, when this card's work is a review waiting for a pass. */
  notes: Ref<any[]>;
  /** Still being read. The shell draws the header either way; a body should say so. */
  reading: Ref<boolean>;
  /**
   * The review could not be read, rather than holding nothing.
   *
   * Both arrive as an empty `notes`, and they want opposite words on the card: one says try
   * again in a moment, the other says there is nothing here to pass.
   */
  notesFailed: Ref<boolean>;
  /** The pending review's own body: what the agent said about the change as a whole. */
  reviewBody: Ref<string>;
  /** False in the deck behind the top card: do not let a body be clicked through. */
  interactive: Ref<boolean>;
  /** An action is in flight. A surface uses it to stop offering a second press. */
  busy: Ref<boolean>;
  /**
   * The number the card's own lede already shows, so a surface does not say it twice.
   *
   * Shell knowledge, which is why it is handed over rather than worked out: the lede is drawn
   * above the body and a surface cannot see it.
   */
  claimed: Ref<string>;

  /**
   * Everything the card can set off, straight through to the shell.
   *
   * The seventeen events the shell already handles - `act`, `resolve`, `discuss`, `expand`,
   * `take`, `reply`, `answer`, `workspace` and the rest - reach it unchanged, so a module gets
   * the same reach the built-in surfaces have and no more. A name the shell does not handle is
   * not an error here; it simply does nothing, which is the same as it is anywhere in Vue.
   */
  emit: (event: string, payload?: any) => void;

  /** The dev-api, for a card that needs something nobody thought to put in `wants`. */
  devApi: (path: string, options?: any) => Promise<any>;

  /** The surfaces and controls in CARD_COMPONENTS, for a body built by hand. */
  components: Record<string, any>;

  /**
   * The three pieces of the shell's own state a body is allowed to move.
   *
   * Not an escape hatch - these are every case where a built-in surface sets something on the
   * card rather than emitting past it, found by reading the template for handlers that assign
   * instead of emit. There are three, and each one is a real part of the contract: without
   * `keeping`, a card could not gate its own primary button; without `selected`, the evidence
   * strip above the body would not follow what the body is showing; without `openText`, a long
   * body would have no way to hand its prose to the dialog the shell already owns.
   */
  shell: {
    /** How many findings this card is keeping. Gates the `anyKept` action; see `visible`. */
    keeping: (count: number) => void;
    /** Which note the evidence strip follows. The one field `art` adds to `base`. */
    selected: (note: any) => void;
    /** Open the long prose over the card: `'prose'`, `'talk'`, or `''` to close it. */
    openText: (what: string) => void;
    /**
     * What the body is drawing, so the frame does not say it twice.
     *
     * The shell used to know, because it did the dispatching. Three things around the body need
     * it: whether to draw the issue's own words above it, whether the evidence band should carry
     * the comments, and whether there is a body at all. Rather than have the shell guess from a
     * declared field - which a card need not declare, and which says nothing about what a bespoke
     * body chose - the body says. `CardSurface` reports its pick; a hand-written card can too.
     */
    showing: (surface: string) => void;
  };
}

/**
 * Turn a loaded module into something mountable.
 *
 * Memoised on the card's `generation`, so re-evaluating a module after an edit produces a new
 * component - which is the point, a new component is what Vue will remount - while a re-render
 * for any other reason reuses the one already built. Without this a card would be rebuilt on
 * every tick of its artifacts arriving.
 */
const built = new Map<string, { generation: number; component: any }>();

export function componentFor(loaded: LoadedCard): any {
  const had = built.get(loaded.id);

  if (had && had.generation === loaded.generation) {
    return had.component;
  }
  const module = loaded.module;
  const template = String(module?.template || DEFAULT_BODY);
  const component = module?.component ? module.component : {
    name:       `card-${ loaded.id }`,
    /*
     * The named map, plus whatever this template asks for by name, plus the card's own. The
     * middle one is what stops a component added to the view later from being invisible to cards
     * until somebody remembers this file.
     */
    components: { ...CARD_COMPONENTS, ...componentsIn(template), ...(module?.components || {}) },
    /*
     * The template, compiled here rather than in the module.
     *
     * A module *could* ship a render function and skip this, and a bundler-produced card will.
     * But a card somebody edits in a text box is a card written as a template, and the compiler
     * is in this bundle - see card-runtime.ts, where the two corrections needed to make it
     * actually draw are written down.
     */
    render: compileTemplate(template, loaded.id),
    /*
     * The api arrives as a prop, and `setup` reads it from there.
     *
     * It used to be captured here, closed over by the memoised component - and the memo is keyed
     * on the card, while the *deck* mounts several FocusCard instances at once (the card on top
     * and the stack behind it). So the first instance to build a card's component won, and every
     * later mount re-used a component whose `setup` was still holding the first instance's props.
     * Measured: all twenty-six bodies empty, because the api they were reading belonged to a card
     * that had no artifacts. A prop is per-mount, which is what this always needed to be, and it
     * leaves the memo a pure function of the module.
     */
    props: { api: { type: Object, required: true } },
    /*
     * `{ api }` when the module has no `setup`, so the default body above can name it. Every card
     * used to write that line itself; the ones that still declare a `setup` get theirs instead.
     */
    setup:  (props: any) => (typeof module?.setup === 'function' ? module.setup(props.api) : { api: props.api }),
  };

  built.set(loaded.id, { generation: loaded.generation, component });

  return component;
}

/** What a module says its buttons are, or nothing - in which case the definition's stand. */
/**
 * The label a verb carries when a card does not give it one.
 *
 * `label: 'Later'` was byte-identical on the snooze of all nineteen cards, which makes it the one
 * thing about those buttons no card was deciding. The hours still are - they run from four to
 * forty-eight - so a card's snooze now says the part that is its own and nothing else.
 *
 * Only the label defaults, never the action: a button that appears from nowhere would be a card
 * you cannot fully read, which is the opposite of the point.
 */
const VERB_LABEL: Record<string, string> = { snooze: 'Later' };

/** Each action as the card wrote it, plus the label its verb implies if it did not give one. */
function labelled(actions: any[]): any[] {
  return actions.map((a) => (a && !a.label && VERB_LABEL[a.verb] ? { ...a, label: VERB_LABEL[a.verb] } : a));
}

export function actionsFrom(loaded: LoadedCard | undefined, api: CardApi): any[] | null {
  const make = loaded?.module?.actions;

  /*
   * An array or a function of the api.
   *
   * The nineteen ported cards kept the arrays their definitions had, because a fixed list of
   * buttons is what nearly every card wants and a function would be ceremony around a constant.
   * A card whose buttons depend on what it loaded returns a function instead.
   */
  if (Array.isArray(make)) {
    return labelled(make);
  }
  if (typeof make !== 'function') {
    return null;
  }
  try {
    const got = make(api);

    return Array.isArray(got) ? labelled(got) : null;
  } catch {
    /*
     * A card whose buttons throw keeps the definition's.
     *
     * The body can afford to fail loudly - it is the thing being edited, and the shell says why.
     * The footer cannot: a card with no buttons is a card you cannot act on, which turns a typo
     * in a template into work you cannot get at from the deck at all.
     */
    return null;
  }
}
