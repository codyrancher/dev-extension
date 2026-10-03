<script setup lang="ts">
/**
 * Focus: everything waiting on you, one card at a time.
 *
 * The same queue My Work's Priority tab draws as a table (priority.ts), dealt out as a deck:
 * the top of the queue nearly fills the screen, you deal with it, and the next one comes up.
 * Which is a different claim from "here is a list" - a list is read, a deck is worked through -
 * and it is the reason this view exists beside that one rather than instead of it.
 *
 * Four things on the page, and each is a part of that claim:
 *
 *   - the **deck**, which is the queue in order. Turned with the wheel, the arrow keys or a
 *     drag; the card on top is the thing to do now.
 *   - the **pinned rail** down the left, which is what you have taken out of the queue to keep
 *     in view. Pinned things leave the deck: you are already dealing with them.
 *   - the **panels**: everything waiting as a list, the weights that decide the order, and the
 *     cards themselves - all three editable, because what gets your attention and what it looks
 *     like when it does are the two things a queue like this gets wrong first.
 *   - the **agent**, along the bottom, which is the product's own conversation rather than one
 *     of this view's: asking about the card in front of you is the same act as asking anywhere
 *     else, and the answer should be in the same place afterwards.
 *
 * What is configured lives in a ConfigMap (focus.ts, dev-api /focus) so an agent can be asked to
 * change it. What is personal - pins, snoozes, what you have dealt with - lives in your prefs.
 */
import {
  computed, getCurrentInstance, nextTick, onMounted, onBeforeUnmount, ref, watch
} from 'vue';
import FocusDeck from '../components/focus/FocusDeck.vue';
import DeckSkeleton from '../components/focus/DeckSkeleton.vue';
import FocusModal from '../components/focus/FocusModal.vue';
import KindChip from '../components/focus/KindChip.vue';
import AppIcon from '../components/focus/AppIcon.vue';
import AppButton from '../components/focus/AppButton.vue';
import WeightsChart from '../components/focus/WeightsChart.vue';
import MiniCard from '../components/focus/MiniCard.vue';
import CardFlight from '../components/focus/CardFlight.vue';
import FileModal from '../components/code/FileModal.vue';
import FocusDock from '../components/focus/FocusDock.vue';
import type { DockRow } from '../components/focus/dock';
import CardGallery from '../components/focus/CardGallery.vue';
import FocusChatBar from '../components/focus/FocusChatBar.vue';
import StudioTerminal from '../components/StudioTerminal.vue';
import { holdOverlay, releaseOverlay } from '../components/focus/overlay';
import {
  readFocusConfig, saveFocusConfig, readFocusState, saveFocusState, focusDeck, manualItem,
  weightRows, actionPrompt, SHIPPED_CARDS, KINDS
} from '../focus';
import type {
  FocusConfig, FocusState, FocusTask, CardAction, ManualTask, FocusKind, WeightRow
} from '../focus';
import { useStore } from 'vuex';
import { priorityQueue } from '../priority';
import type { PriorityItem } from '../priority';
import { listAllWorkspaces, currentOwner } from '../api';
import type { DevWorkspace } from '../api';
import { listRanchers } from '../ranchers';
import { WORKSPACE_ROUTE } from '../config/constants';
import type { RancherTarget } from '../ranchers';
import {
  myWork, assignToMe, requestReviewers, describePr, createPullRequest, markReadyForReview
} from '../github';
import type { GithubWork } from '../github';
import { workspaceBranch } from '../workspace-tools';
import { dependabotData, dependabotReviews, DEFAULT_REPO } from '../reviews';
import { workspaceStatuses, readStatusNow } from '../workspace-status';
import { askTheAgent, panelConversation } from '../focus-agent';
import { sendToPane } from '../conversations';
import { reviewNotes } from '../focus-review';
import type { ReviewNote } from '../focus-review';
import { readArtifacts, NO_ARTIFACTS, subjectOf } from '../focus-artifacts';
import type { CardArtifacts, CardComment, PoolIssue } from '../focus-artifacts';
import {
  startPrReview, startIssueFix, submitReview, approveAndMerge, mergePr, prDetail, prFile, linesPrompt
} from '../reviews';
import { previewState } from '../previews';
import { updateComment, deleteComment, discussPrompt } from '../reviews';
import '../design/focus.css';
import '../design/focus-chat.css';

/** How long the deck will wait for the top card's detail before drawing it without. See load. */
const FIRST_PAINT_WAIT = 3000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const loading = ref(true);
const busy = ref(false);
const notice = ref('');
const error = ref('');

const items = ref<PriorityItem[]>([]);
const config = ref<FocusConfig>({ cards: SHIPPED_CARDS, weights: {}, tasks: [] });
const state = ref<FocusState>({ pinned: [], snoozed: {}, done: {} });

const index = ref(0);
const direction = ref<1 | -1>(1);
const deckRef = ref<{ topRect(): DOMRect | null } | null>(null);

/** A rectangle, kept rather than held: a DOMRect read now is not a DOMRect read after a render. */
interface Box { top: number; left: number; width: number; height: number }

function boxOf(rect: DOMRect | null | undefined): Box | null {
  return rect && rect.width ? {
    top: rect.top, left: rect.left, width: rect.width, height: rect.height,
  } : null;
}

/**
 * The card in the air between the deck and the rail, if one is. See CardFlight.
 *
 * Both ends hide their own copy while this is set - `flyingPin` for the rail, `dropping` for the
 * deck - so the flying one is the only card on the screen.
 */
const flight = ref<{ task: FocusTask; from: Box; to: Box; mode: 'drop' | 'dock' } | null>(null);
const flyingPin = ref('');
const dropping = ref(false);

/**
 * Set before the state changes, not after: the deck re-renders on the assignment, and if it is
 * still allowed to turn at that moment it animates its own half of a movement the flight is
 * already drawing - the pinned card thrown off the bottom of the screen while its copy flies to
 * the dock.
 */
const quiet = ref(false);

function flightDone() {
  flight.value = null;
  flyingPin.value = '';
  dropping.value = false;
  quiet.value = false;
}

/** Where a pin sits in the rail, once it is there to measure. */
function slotOf(key: string): Box | null {
  const found = document.querySelector(`.focus__pins .pin[data-key="${ CSS.escape(key) }"]`);

  return boxOf(found?.getBoundingClientRect());
}

/**
 * The agent's comments for the card on top, when there are any.
 *
 * Read for the top card and nothing else: a pass is a dozen comments and each one carries a
 * hunk, so reading them for a deck of thirty would be thirty pull requests fetched to draw one.
 */
const notes = ref<ReviewNote[]>([]);
const notesFor = ref('');

const store = useStore();

/**
 * The host's router, off this component's own instance.
 *
 * Not `useRouter()`. An extension is loaded as a UMD bundle with its own copy of vue-router, so
 * the composition helpers look for a router in *that* module's injection context and find
 * nothing - `replace` threw, the catch swallowed it, and the card never reached the URL. It
 * worked on the dev server, where the extension is compiled into the dashboard and there is only
 * one vue-router, which is the worst way for this to fail: right in development, silent in
 * production. `$router` on the instance proxy is the host's, always.
 */
const self = getCurrentInstance();
const router = computed(() => (self?.proxy as unknown as { $router?: Json })?.$router || null);

/**
 * Which card you are on, in the address bar.
 *
 * The deck is a place you come back to - you open a pull request from a card, read it, and come
 * back - and coming back to the top of the queue rather than to the card you left is the deck
 * losing your place. The queue key goes in the URL, so a reload, a new tab, or a link to
 * somebody else lands on the same card.
 *
 * The key, not the index: the queue is re-ranked on every load, and position 4 is a different
 * card tomorrow. `replace` rather than `push`, so turning the deck does not fill the back button
 * with thirty entries.
 */
const CARD_PARAM = 'card';

/** What the address bar says now, read from the window rather than through the router. */
function cardInUrl(): string {
  try {
    return new URLSearchParams(window.location.search).get(CARD_PARAM) || '';
  } catch {
    return '';
  }
}

/**
 * Written with `history.replaceState` rather than through the router.
 *
 * The router is the host's and a `replace` through it is a navigation the dashboard can decline;
 * this is the same URL by the end and cannot be declined, which is what makes it survive. Proven
 * on the installed plugin rather than assumed: a query set this way is still there sixteen
 * seconds and a deck turn later.
 */
function rememberInUrl(key: string) {
  if (loading.value || cardInUrl() === key) {
    return;
  }
  try {
    const url = new URL(window.location.href);

    if (key) {
      url.searchParams.set(CARD_PARAM, key);
    } else {
      url.searchParams.delete(CARD_PARAM);
    }
    window.history.replaceState(window.history.state, '', url);
  } catch {
    // A URL this browser will not parse is not worth failing a render over.
  }
}

/**
 * Everything else the card on top has to show, and which card it belongs to.
 *
 * Read for one card at a time, for the reason the notes are: every artifact is a network call or
 * several, and a deck of thirty would be thirty pull requests fetched to draw one. What is read
 * is the card's own `wants` - see focus-artifacts.ts.
 */
const artifacts = ref<CardArtifacts>(NO_ARTIFACTS);
const artifactsFor = ref('');

/** The advisories and the bot's pull requests the queue was built from; see readArtifacts. */
const alsoFrom = ref<{ alerts: Json[]; botPrs: Json[] }>({ alerts: [], botPrs: [] });

/**
 * The read in flight, handed back to every caller.
 *
 * Two things ask for the top card's comments: the watcher below, when the card on top changes,
 * and the first load, which will not draw anything until they are in. Returning the same promise
 * means the second of those waits on the fetch the first started rather than racing it.
 */
let reading: Promise<void> = Promise.resolve();

function readNotes(): Promise<void> {
  const task = current.value;
  const pr = Number(/#(\d+)/.exec(task?.what || '')?.[1] || 0);

  if (!task || !pr || task.rule !== 'review-findings') {
    notes.value = [];
    notesFor.value = '';
    reading = Promise.resolve();

    return reading;
  }

  if (notesFor.value === task.key) {
    return reading;
  }

  notesFor.value = task.key;
  reading = reviewNotes(pr)
    .catch(() => [] as ReviewNote[])
    .then((found) => {
      // Turned again while this was in the air. A pull request with a lot of comments can take
      // long enough that two cards are in flight at once, and the slower one landing last would
      // put its comments on whatever card is now on top.
      if (notesFor.value === task.key) {
        notes.value = found;
      }
    });

  return reading;
}

/** Who you are, for telling your own comments from everybody else's. */
const me = ref('');

/*
 * ── What else is running ──────────────────────────────────────────────────────────────────────
 *
 * The deck shows one card. These two corners are what is behind it: the workspaces, and the
 * Ranchers they are pointed at. Read once with everything else and not polled - a dock that
 * re-read the cluster every few seconds to draw two dots would cost more than the deck does.
 */
const spaces = ref<DevWorkspace[]>([]);
const ranchers = ref<RancherTarget[]>([]);

const workspaceRows = computed<DockRow[]>(() => spaces.value
  .filter((ws) => !ws.preview)
  .map((ws) => ({
    id:    ws.name,
    name:  ws.name,
    state: ws.state,
    up:    ws.state === 'running',
    bad:   ws.state === 'failed',
    note:  ws.title && ws.title !== ws.name ? '' : '',
  })));

const rancherRows = computed<DockRow[]>(() => ranchers.value.map((target) => ({
  id:    target.url || target.id,
  name:  target.name,
  state: target.phase,
  up:    target.phase === 'ready' || target.phase === 'host',
  bad:   target.phase === 'error',
  // What it is doing, while it is doing something; once it is up its address is the useful half.
  note:  target.detail || (target.url ? host(target.url) : ''),
})));

/** Just the host, for a dock row: a full URL in a 340px card is a line of ellipsis. */
function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Open a workspace in the product's own page for it. */
function openWorkspace(name: string) {
  // The host's router when there is one; its own URL when there is not.
  const go = router.value;

  if (go) {
    go.push({ name: WORKSPACE_ROUTE, params: { cluster: '_', workspace: name } }).catch(() => undefined);
  } else {
    window.location.href = `${ window.location.pathname.replace(/\/focus$/, '') }/workspaces/${ encodeURIComponent(name) }`;
  }
}

let readingArtifacts: Promise<void> = Promise.resolve();

function readTheArtifacts(): Promise<void> {
  const task = current.value;
  const wants = task?.card.wants || [];

  if (!task || !wants.length) {
    artifacts.value = NO_ARTIFACTS;
    artifactsFor.value = '';
    readingArtifacts = Promise.resolve();

    return readingArtifacts;
  }

  if (artifactsFor.value === task.key) {
    return readingArtifacts;
  }

  artifactsFor.value = task.key;
  // Cleared first: the card is about to draw, and last card's evidence under this card's title
  // is worse than a card with nothing under it for a second.
  artifacts.value = NO_ARTIFACTS;
  readingArtifacts = readArtifacts(task, wants, store, me.value, work.value, alsoFrom.value)
    .catch(() => NO_ARTIFACTS)
    .then((found) => {
      // Turned again while this was in the air; see readNotes for the same guard.
      if (artifactsFor.value === task.key) {
        artifacts.value = found;
      }
    });

  return readingArtifacts;
}

/**
 * One sheet, four sections.
 *
 * It was four buttons in the header opening four sheets, which is four things to learn about a
 * page whose whole claim is that it shows you one thing at a time. Everything that is not the
 * deck is behind the one control the bar already had.
 */
const settings = ref(false);
const section = ref<'queue' | 'weights' | 'cards' | 'new'>('queue');

/** The four, with what each one is for: the dialog draws the rail and the heading from this. */
const sections = computed(() => [
  {
    id: 'queue', label: 'Waiting', count: deck.value.length, about: 'Everything in the deck, in the order it will be dealt. Picking one brings it to the top.',
  },
  {
    id: 'weights', label: 'Order', count: rows.value.filter((row) => row.count).length, about: 'What decides that order: every rule that can put something in the queue, and what it is worth.',
  },
  {
    id: 'cards', label: 'Cards', count: config.value.cards.length, about: 'What a kind of waiting work looks like when it reaches the top, and what its buttons do.',
  },
  {
    id: 'new', label: 'Yours', count: (config.value.tasks || []).length, about: 'Anything no system knows about. It is ranked with everything else, which is the point.',
  },
]);

/** The conversation the bar shows, made the first time somebody opens or asks. */
const chatOpen = ref(false);
const conversation = ref('');
const sending = ref(false);

/** Everything the queue has, drawn: pinned ones are marked and then held back from the deck. */
const all = computed<FocusTask[]>(() => focusDeck(items.value, config.value, state.value));
const pinned = computed(() => all.value.filter((task) => task.pinned));
const deck = computed(() => all.value.filter((task) => !task.pinned));
const current = computed(() => deck.value[index.value] || null);

const rows = computed<WeightRow[]>(() => weightRows(items.value, config.value.weights));
const snoozedCount = computed(() => Object.keys(state.value.snoozed).length);

/** Rule id to how many things it is holding, which is what makes a card definition legible. */
const counts = computed<Record<string, number>>(() => {
  const out: Record<string, number> = {};

  for (const row of rows.value) {
    out[row.id] = row.count;
  }

  return out;
});

/** The first few of the deck, for the weights panel to show what the ranking is doing. */
const top = computed(() => deck.value.slice(0, 5).map((task) => ({
  what: task.what, title: task.title, needs: task.needs, score: task.score, kind: task.card.kind,
})));

/* ── Loading ──────────────────────────────────────────────────────────────────────────────── */

async function load() {
  error.value = '';
  try {
    const [cfg, st] = await Promise.all([readFocusConfig(), readFocusState()]);

    config.value = cfg;
    state.value = st;
    me.value = await currentOwner().catch(() => '');

    // The same reads My Work's Priority tab makes, in the same order and for the same reasons -
    // see refreshPriority there. The one that matters is the second pass over the workspaces:
    // `workspaceStatuses` hands back what has been read so far and starts a read for the rest,
    // so a cold page would rank a review workspace by what GitHub alone can see and miss that
    // its agent has already left findings waiting.
    const workspaces = await listAllWorkspaces().catch(() => []);

    spaces.value = workspaces;
    // The Ranchers are the one read here that nothing else needs, so it is allowed to be slow and
    // allowed to fail: a corner with no dots in it is not a reason for the deck not to draw.
    listRanchers(store).then((found) => {
      ranchers.value = found;
    }).catch(() => undefined);
    const names = workspaces.map((workspace) => workspace.name);
    const [found, dependabot, cached, botReviews] = await Promise.all([
      myWork().catch(() => null),
      dependabotData(DEFAULT_REPO).catch(() => null),
      workspaceStatuses(workspaces).catch(() => ({})),
      dependabotReviews().catch(() => ({})),
    ]);
    const statuses = { ...cached };
    const unread = Object.entries(statuses).filter(([, status]) => !status.readAt).map(([name]) => name);

    await Promise.all(unread.map(async(name) => {
      statuses[name] = await readStatusNow(name).catch(() => statuses[name]);
    }));

    work.value = found;
    alsoFrom.value = {
      alerts: (dependabot?.groups || []) as Json[],
      botPrs: ((dependabot?.prs || []) as Json[]).map((pr: Json) => ({ ...pr, number: pr.number })),
    };
    items.value = priorityQueue({
      work: found,
      statuses,
      workspaces: names,
      alerts:     (dependabot?.groups || []).map((group: Record<string, unknown>) => ({ ...group, key: group.slug })),
      botPrs:     (dependabot?.prs || []).map((pr: Record<string, unknown>) => ({ ...pr, key: pr.number, repo: DEFAULT_REPO })),
      botReviews,
      weights:    cfg.weights,
      extra:      (cfg.tasks || []).map(manualItem),
    });

    // The card asked for, before anything is read for it: the artifacts and the comments below
    // are read for whatever `current` is, and resolving this afterwards would fetch card zero's
    // and then jump - which is both slower and the flicker this gate exists to stop.
    const asked = cardInUrl();
    const at = asked ? deck.value.findIndex((task) => task.key === asked) : -1;

    if (at >= 0) {
      index.value = at;
    }

    // Nothing is drawn until the top card is the card it is going to stay as.
    //
    // The first card is usually a review pass, and a review pass is a different card once its
    // comments are in - a column of findings with the code around each one, rather than a title
    // and a line. Flipping `loading` here would draw the plain one, hold it for as long as that
    // fetch takes, and then replace it under somebody who had started reading. Cards change
    // because you turned the deck, not because the page is still catching up.
    //
    // Capped, because this is a pull request being read over the network and the deck is the
    // page. Waiting is better than flickering; waiting forever is not, and a card that fills in
    // three seconds late is a card nobody had started reading yet.
    await Promise.race([
      Promise.all([readNotes(), readTheArtifacts()]),
      new Promise((done) => setTimeout(done, FIRST_PAINT_WAIT)),
    ]);
  } catch (e) {
    error.value = (e as Error)?.message || String(e);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

/* ── Turning the deck ─────────────────────────────────────────────────────────────────────── */

watch(current, () => {
  readNotes();
  readTheArtifacts();
  rememberInUrl(current.value?.key || '');
}, { immediate: true });

// The first card is settled by the time loading ends, and `rememberInUrl` holds its tongue until
// then - so this is what puts the opening card in the URL when nothing asked for one.
watch(loading, (busyNow) => {
  if (!busyNow) {
    rememberInUrl(current.value?.key || '');
  }
});

function go(step: 1 | -1) {
  if (!deck.value.length) {
    return;
  }
  direction.value = step;
  index.value = (index.value + step + deck.value.length) % deck.value.length;
}

function jumpTo(target: number) {
  if (target === index.value || target < 0 || target >= deck.value.length) {
    return;
  }
  direction.value = target > index.value ? 1 : -1;
  index.value = target;
}

/** Keep the index on something after the deck has shrunk under it. */
function settle() {
  if (index.value >= deck.value.length) {
    index.value = Math.max(0, deck.value.length - 1);
  }
}

/* ── What a card's buttons do ─────────────────────────────────────────────────────────────── */

/**
 * Take the change now; write it down in the background.
 *
 * The assignment is synchronous, so the deck and the rail have already re-rendered by the time
 * this returns a promise - which is what lets an animation start on the frame after the click
 * rather than after a round trip to the API server.
 */
function remember(next: FocusState): Promise<void> {
  state.value = next;

  return saveFocusState(next).catch((e) => {
    error.value = (e as Error)?.message || String(e);
  });
}

function say(message: string) {
  notice.value = message;
  setTimeout(() => {
    if (notice.value === message) {
      notice.value = '';
    }
  }, 3200);
}

/**
 * Pin, or put it back.
 *
 * One movement with two directions, and in both of them the card travels: it is the same card
 * before and after, in a different place, and the only honest way to draw that is to move it.
 * Neither direction is a turn of the deck - nothing is being dealt - so neither is drawn by the
 * deck's transition. See CardFlight for what replaced it and why.
 */
function pin(task: FocusTask, from?: DOMRect) {
  const on = state.value.pinned.includes(task.key);

  say(on ? `${ task.what } is back in the deck.` : `${ task.what } is pinned.`);

  return on ? putBack(task, from) : putAway(task);
}

/**
 * Off the deck and into the rail: it shrinks along the way into the miniature it becomes.
 *
 * Measured before anything moves, because the card is about to stop being the card on top. The
 * rail's own copy is held back until it lands, so the dock does not fill before the card
 * arrives in it.
 */
async function putAway(task: FocusTask) {
  const from = boxOf(deckRef.value?.topRect());

  quiet.value = true;
  flyingPin.value = task.key;
  void remember({ ...state.value, pinned: [...state.value.pinned, task.key] });
  settle();
  await nextTick();

  const to = slotOf(task.key);

  if (from && to) {
    flight.value = {
      task, from, to, mode: 'dock',
    };
  } else {
    flyingPin.value = '';
    quiet.value = false;
  }
}

/**
 * Out of the rail and back onto the deck: it grows from the dock and is laid on top.
 *
 * `from` is the pin's own rectangle, measured in the click before any of this runs. The deck is
 * put on the card first, silently - `dropping` suppresses its turn and hides the card it would
 * have drawn - so that what lands is the only one there was.
 */
async function putBack(task: FocusTask, from?: DOMRect) {
  const start = boxOf(from);

  quiet.value = true;
  void remember({ ...state.value, pinned: state.value.pinned.filter((key) => key !== task.key) });
  settle();
  await nextTick();

  const at = deck.value.findIndex((entry) => entry.key === task.key);

  if (at < 0) {
    quiet.value = false;

    return;
  }

  dropping.value = true;
  index.value = at;
  await nextTick();

  const to = boxOf(deckRef.value?.topRect());

  if (start && to) {
    flight.value = {
      task, from: start, to, mode: 'drop',
    };
  } else {
    dropping.value = false;
    quiet.value = false;
  }
}

/** From the rail: the same act, with where it was on the way in. */
function unpin(task: FocusTask, event: MouseEvent) {
  const rect = (event.currentTarget as HTMLElement)?.getBoundingClientRect();

  return pin(task, rect);
}

async function snooze(task: FocusTask, hours: number) {
  const until = new Date(Date.now() + hours * 3600 * 1000);

  await remember({ ...state.value, snoozed: { ...state.value.snoozed, [task.key]: until.toISOString() } });
  settle();
  say(`${ task.what } comes back ${ hours >= 24 ? `in ${ Math.round(hours / 24) } day${ hours >= 48 ? 's' : '' }` : `in ${ hours } hours` }.`);
}

async function done(task: FocusTask) {
  await remember({ ...state.value, done: { ...state.value.done, [task.key]: new Date().toISOString() } });
  settle();
  say(`${ task.what } is off the deck.`);
}

async function act({ task, action }: { task: FocusTask; action: CardAction }) {
  busy.value = true;
  error.value = '';
  try {
    if (action.verb === 'snooze') {
      await snooze(task, action.hours || 8);
    } else if (action.verb === 'done') {
      await done(task);
    } else if (action.verb === 'url' && task.url) {
      window.open(task.url, '_blank', 'noopener');
    } else if (action.verb === 'open') {
      await askTheAgent(task, `Open ${ task.what }${ task.workspace ? ` in ${ task.workspace }` : '' } and tell me where it stands.`);
      say('Asked in the conversation.');
    } else if (action.verb === 'ask') {
      await askTheAgent(task, actionPrompt(action, task));
      say('Asked in the conversation.');
    } else if (action.verb === 'share') {
      await openTheBuild(task, action.kind || 'dashboard');
    } else if (action.verb === 'review') {
      await pickUpTheReview(task);
    } else if (action.verb === 'fix') {
      await pickUpTheIssue(task);
    } else if (action.verb === 'post') {
      await postTheReview(task);
    } else if (action.verb === 'merge') {
      await mergeIt(task);
    } else if (action.verb === 'ready') {
      await readyForReview(task);
    } else if (action.verb === 'create-pr') {
      await openThePr(task);
    } else if (action.verb === 'describe') {
      await describeIt(task);
    }
  } catch (e) {
    error.value = (e as Error)?.message || String(e);
  } finally {
    busy.value = false;
  }
}

/**
 * The file somebody asked to see all of, and where in it they were.
 *
 * Every code view on a card offers this - a hunk, a comment's lines, a file in the change - and
 * all three hand over the same two things: which file, and which lines were on screen. Reading it
 * is the page's job rather than theirs, because only the page knows that these lines came from a
 * pull request and which commit to read them at.
 */
const whole = ref<{ path: string; mark: [number, number]; pr: number } | null>(null);

function openWholeFile(task: FocusTask, value: { path: string; mark: [number, number] }) {
  const { pr } = subjectOf(task);

  if (!pr || !value.path) {
    say('There is no file behind this one to open.');

    return;
  }
  whole.value = { path: value.path, mark: value.mark, pr };
}

/** The file at the commit the review is of - not at the branch's tip, which has moved on. */
async function readWholeFile(): Promise<string> {
  const at = whole.value;

  if (!at) {
    return '';
  }
  const detail = await prDetail(at.pr).catch(() => null);

  return prFile(at.pr, at.path, detail?.meta?.headSha || detail?.meta?.headRef || 'HEAD');
}

/* ── The verbs that are typical of one kind of work ───────────────────────────────────────── */

/** What the queue was built from, kept so the pool artifact does not ask GitHub a second time. */
const work = ref<GithubWork | null>(null);

/** Out of draft: the one act at that stage GitHub's own UI was otherwise needed for. */
async function readyForReview(task: FocusTask) {
  const { pr } = subjectOf(task);

  if (!pr) {
    return;
  }
  await markReadyForReview(DEFAULT_REPO, pr);
  say(`${ task.what } is ready for review.`);
  await done(task);
}

/**
 * Open the pull request for a branch that has the work on it.
 *
 * The branch and the base come from the workspace, and the title from the issue it is for, so
 * this is one press rather than a form. The description is deliberately left for the agent to
 * draft - see the `describe-pr` card - because a pull request opened with an empty body is the
 * state that card exists to catch, and writing it here from the commit messages would be worse
 * than either.
 */
async function openThePr(task: FocusTask) {
  const { workspace } = subjectOf(task);
  // `workspaceBranch` answers with the branch and its sha; only the name is wanted here.
  const branch = workspace ? (await workspaceBranch(workspace).catch(() => null))?.branch || '' : '';

  if (!branch) {
    error.value = 'Could not work out which branch to open it from.';

    return;
  }
  const made = await createPullRequest(DEFAULT_REPO, {
    head:  branch,
    base:  'master',
    title: task.title || `Work from ${ workspace }`,
    draft: true,
  });

  say(`Opened PR #${ made.number } as a draft.`);
  window.open(made.url, '_blank', 'noopener');
  await done(task);
}

/**
 * Say what it does.
 *
 * The agent drafts it into the conversation first - that is the `ask` action on the same card -
 * and this is the one that writes. It refuses rather than inventing: a description written from
 * the diff by this page, with no reading of the issue behind it, is the thin description it is
 * supposed to be replacing.
 */
async function describeIt(task: FocusTask) {
  const { pr } = subjectOf(task);
  const drafted = artifacts.value.body.trim();

  if (!pr) {
    return;
  }
  if (!drafted) {
    await askTheAgent(task, `For ${ task.what }: read the diff, the commits and the issue it closes, then rewrite the pull request description on GitHub - what it changes, why, and what a reviewer should check.`);
    say('Asked the agent to write it, since there was nothing to post.');

    return;
  }
  await describePr(DEFAULT_REPO, pr, { body: drafted });
  say(`${ task.what } now says what it does.`);
}

/** Take an issue out of the pool: assign it, then start the fix the way the Create page would. */
async function takeIssue(task: FocusTask, issue: PoolIssue) {
  busy.value = true;
  try {
    await assignToMe(issue.repo || DEFAULT_REPO, issue.number, me.value);
    const started = await startIssueFix(store, { number: issue.number, title: issue.title });

    say(`#${ issue.number } is yours; the fix is starting in ${ started.workspace }.`);
    await load();
  } catch (e) {
    error.value = (e as Error)?.message || String(e);
  } finally {
    busy.value = false;
  }
}

/** Ask one person for a review, from the card that noticed nobody had been asked. */
async function askReviewer(task: FocusTask, who: string) {
  const { pr } = subjectOf(task);

  if (!pr || !who) {
    return;
  }
  busy.value = true;
  try {
    const { asked, refused } = await requestReviewers(DEFAULT_REPO, pr, [who]);

    if (asked.length) {
      say(`Asked ${ asked.join(', ') } to review ${ task.what }.`);
      artifactsFor.value = '';
      readTheArtifacts();
    } else {
      error.value = `GitHub would not ask ${ who }: ${ Object.values(refused)[0] || 'refused' }`;
    }
  } finally {
    busy.value = false;
  }
}


/**
 * Open what is already running.
 *
 * The card knows there is one because the evidence band drew it, so this is the same link - the
 * point of the button is that it is under your thumb rather than two tabs away.
 */
async function openTheBuild(task: FocusTask, kind: 'dashboard' | 'storybook') {
  // The one asked for, else whatever is up: an agent that shared a whole Rancher rather than a
  // static build put up the more useful thing, and a button that refused it on a technicality
  // would be refusing the answer to the question it was pressed to ask.
  const live = artifacts.value.live.find((entry) => entry.kind === kind)
    || artifacts.value.live.find((entry) => entry.url);
  const url = live?.url || (task.workspace
    ? (await previewState(store, task.workspace, 'local', kind).catch(() => null))?.url
    : '');

  if (url) {
    window.open(url, '_blank', 'noopener');

    return;
  }
  say(`Nothing is serving ${ kind === 'storybook' ? 'Storybook' : 'a build' } for this yet.`);
}

/** Pick up a review: the workspace, the checkout and the agent, as the Create page would. */
async function pickUpTheReview(task: FocusTask) {
  const { pr } = subjectOf(task);

  if (!pr) {
    say('Nothing here to review.');

    return;
  }
  const started = await startPrReview(store, { number: pr, title: task.title });

  say(`Review started in ${ started.workspace }.`);
}

/** The same for an issue: a fix workspace, on a branch, with the issue in front of it. */
async function pickUpTheIssue(task: FocusTask) {
  const { issue } = subjectOf(task);

  if (!issue) {
    say('Nothing here to fix.');

    return;
  }
  const started = await startIssueFix(store, { number: issue, title: task.title });

  say(`Fix started in ${ started.workspace }.`);
}

/**
 * Post what the agent wrote, as a review on GitHub.
 *
 * Only the comments that survived the pass: ReviewPass has already dropped the ones you threw
 * out, so what goes up is what is left. The card asked before getting here - see `confirm`.
 */
async function postTheReview(task: FocusTask) {
  const { pr } = subjectOf(task);

  if (!pr) {
    return;
  }
  const { posted, url } = await submitReview(pr);

  say(posted ? `Posted ${ posted } comment${ posted === 1 ? '' : 's' } on ${ task.what }.` : 'Nothing was left to post.');
  if (url) {
    window.open(url, '_blank', 'noopener');
  }
  await done(task);
}

/**
 * Merge it.
 *
 * Two things this has to get right that the button cannot say.
 *
 * Whose it is. `approveAndMerge` approves first, which is what a dependabot bump wants and what
 * GitHub refuses on your own pull request - "can not approve your own" - so a merge of your own
 * would have thrown before it ever merged. So: yours is merged, somebody else's is approved and
 * merged.
 *
 * Whether it is green. A red pull request is one of the two things that puts a card of your own
 * in this deck at all, so the button is right there under a card that says it is failing. This
 * does not merge it; GitHub will, for anyone who means it, and saying so is better than either
 * doing it quietly or hiding the button.
 */
async function mergeIt(task: FocusTask) {
  const { pr } = subjectOf(task);

  if (!pr) {
    return;
  }

  if (artifacts.value.checks.some((check) => check.state === 'failed')) {
    error.value = `${ task.what } is red. Merge it on GitHub if you mean to.`;

    return;
  }

  const detail = await prDetail(pr).catch(() => null);
  const mine = String(detail?.meta?.author || '').toLowerCase() === me.value.toLowerCase();

  if (mine) {
    await mergePr(pr);
  } else {
    const { steps } = await approveAndMerge(pr);
    const failed = steps.find((step) => !step.ok);

    if (failed) {
      error.value = `${ failed.step }: ${ failed.note || 'failed' }`;

      return;
    }
  }
  say(`${ task.what } is merged.`);
  await done(task);
}

/**
 * A question about a run of code in the change, sent where every other question goes.
 *
 * `linesPrompt` is the same wording the pull request page uses, so the agent is answering the
 * question it already knows how to answer rather than a second phrasing of it.
 */
async function askAboutCode(task: FocusTask, value: { path: string; label: string; code: string; text: string }) {
  const { pr } = subjectOf(task);
  const line = Number(/(\d+)/.exec(value.label)?.[1] || 0);

  busy.value = true;
  try {
    await askTheAgent(task, pr
      ? linesPrompt(pr, {
        path: value.path, line, startLine: null, side: 'RIGHT', code: value.code,
      }, value.text)
      : `About ${ value.path } ${ value.label }:\n\n\`\`\`\n${ value.code }\n\`\`\`\n\n${ value.text }`);
    say('Asked in the conversation.');
  } catch (e) {
    error.value = (e as Error)?.message || String(e);
  } finally {
    busy.value = false;
  }
}

/**
 * Make the workspace this card has none of.
 *
 * Which kind depends on what the card is: a pull request gets a review workspace, an issue gets a
 * fix. The card already declares which through its own actions - that is what `review` and `fix`
 * mean - so this reads the answer off the definition rather than guessing from the task.
 */
async function makeWorkspaceFor(task: FocusTask) {
  const verbs = task.card.actions.map((action) => action.verb);

  if (verbs.includes('review')) {
    await pickUpTheReview(task);
  } else if (verbs.includes('fix')) {
    await pickUpTheIssue(task);
  } else {
    say('There is nothing here to make a workspace from.');
  }
}

/**
 * Answer the agent, with the key it listed.
 *
 * The whole of what answering a claude dialog means: the pane is a terminal, and its numbered
 * list wants the number. Nothing is interpreted here - the key sent is the one the pane printed
 * beside the label that was pressed - because guessing at a dialog this view cannot see the rest
 * of is how you answer the wrong question.
 */
async function answerTheAgent(task: FocusTask, value: { key: string; label: string }) {
  const turn = artifacts.value.agent;

  if (!turn?.conversation) {
    error.value = 'That conversation is no longer there to answer.';

    return;
  }
  busy.value = true;
  try {
    await sendToPane(turn.conversation, value.key);
    say(`Answered "${ value.label }".`);
    // It is going to do something now, so what was on the card is already out of date.
    artifactsFor.value = '';
    setTimeout(() => readTheArtifacts(), 1500);
  } catch (e) {
    error.value = (e as Error)?.message || String(e);
  } finally {
    busy.value = false;
  }
}

/** Answer one of the comments waiting on this change, with the comment in front of the agent. */
async function replyTo(task: FocusTask, value: { comment: CardComment }) {
  const { comment } = value;

  busy.value = true;
  try {
    await askTheAgent(task, [
      `On ${ task.what }, ${ comment.author } said this${ comment.path ? ` about ${ comment.path }${ comment.line ? `:${ comment.line }` : '' }` : '' }:`,
      '',
      comment.body,
      '',
      'Draft a reply, and say whether it needs a change to the code. Do not push anything.',
    ].join('\n'));
    say('Asked in the conversation.');
  } catch (e) {
    error.value = (e as Error)?.message || String(e);
  } finally {
    busy.value = false;
  }
}

async function ask(task: FocusTask) {
  busy.value = true;
  try {
    await askTheAgent(task, `About ${ task.what }${ task.title ? ` (${ task.title })` : '' }: ${ task.needs }. What should I know before I start?`);
    say('Asked in the conversation.');
  } catch (e) {
    error.value = (e as Error)?.message || String(e);
  } finally {
    busy.value = false;
  }
}

/* ── The pass over the agent's comments ───────────────────────────────────────────────────── */

/**
 * What you decided about one of the agent's comments, written back to the comment.
 *
 * Keeping one approves it - which is what makes it go out when the review is submitted -
 * rewording it writes the new text, and dropping it deletes it. The card is where the
 * judgement happens; this is where it lands.
 */
async function resolveNote({ note, verdict, body }: { note: ReviewNote; verdict: string; body?: string }) {
  try {
    if (verdict === 'dropped') {
      await deleteComment(note.pr, note.commentId);
      notes.value = notes.value.filter((entry) => entry.id !== note.id);
    } else if (verdict === 'edited' && body) {
      await updateComment(note.pr, note.commentId, { body, status: 'approved' });
    } else if (verdict === 'good') {
      await updateComment(note.pr, note.commentId, { status: 'approved' });
    }
  } catch (e) {
    error.value = (e as Error)?.message || String(e);
  }
}

/** Arguing with the agent about one of its own comments, in the conversation. */
async function discussNote({ note, text }: { note: ReviewNote; text: string }) {
  const task = current.value;

  try {
    await askTheAgent(task, discussPrompt(
      { id: note.commentId, path: note.path, line: note.line, body: note.body } as never,
      note.pr,
      text,
    ));
  } catch (e) {
    error.value = (e as Error)?.message || String(e);
  }
}

/* ── The weights ──────────────────────────────────────────────────────────────────────────── */

const widest = computed(() => Math.max(100, ...rows.value.map((row) => row.score)));

async function setWeight(id: string, value: number) {
  const weights = { ...config.value.weights, [id]: value };

  config.value = { ...config.value, weights };
  // Re-ranked here rather than on the next load, so the bar you are dragging moves the queue
  // beside it. The save is what makes it last.
  items.value = items.value
    .map((item) => (item.rule === id ? { ...item, score: value } : item))
    .sort((a, b) => b.score - a.score || a.what.localeCompare(b.what));
}

async function saveWeights() {
  busy.value = true;
  try {
    await saveFocusConfig({ weights: config.value.weights });
    say('The weights are saved.');
  } catch (e) {
    error.value = (e as Error)?.message || String(e);
  } finally {
    busy.value = false;
  }
}

async function resetWeights() {
  config.value = { ...config.value, weights: {} };
  await saveFocusConfig({ weights: {} }).catch(() => {});
  await load();
  say('Back to the weights that shipped.');
}

/* ── Tasks somebody wrote down ────────────────────────────────────────────────────────────── */

const draft = ref<ManualTask>({
  id: '', title: '', needs: '', why: '', score: 60, kind: 'issue', url: '', workspace: '', created: '',
});

function blankDraft() {
  draft.value = {
    id: '', title: '', needs: '', why: '', score: 60, kind: 'issue', url: '', workspace: '', created: '',
  };
}

async function addTask() {
  if (!draft.value.title.trim()) {
    return;
  }
  busy.value = true;
  try {
    const task: ManualTask = {
      ...draft.value,
      id:      `t${ Date.now().toString(36) }`,
      title:   draft.value.title.trim(),
      needs:   draft.value.needs.trim() || 'Deal with it',
      why:     draft.value.why.trim() || 'you added it',
      created: new Date().toISOString(),
    };
    const tasks = [...(config.value.tasks || []), task];

    await saveFocusConfig({ tasks });
    config.value = { ...config.value, tasks };
    items.value = [...items.value, manualItem(task)].sort((a, b) => b.score - a.score);
    blankDraft();
    panel.value = '';
    say('Added to the queue.');
  } catch (e) {
    error.value = (e as Error)?.message || String(e);
  } finally {
    busy.value = false;
  }
}

async function dropTask(id: string) {
  const tasks = (config.value.tasks || []).filter((task) => task.id !== id);

  await saveFocusConfig({ tasks }).catch(() => {});
  config.value = { ...config.value, tasks };
  items.value = items.value.filter((item) => item.key !== `manual:${ id }`);
  settle();
}

/* ── The cards themselves, which the agent edits ──────────────────────────────────────────── */

/**
 * Hand a card's definition to the agent, with what it is and how to save it.
 *
 * Editing JSON in a textarea is a thing nobody does twice; describing the change is. The prompt
 * carries the definition as it stands, the shape it has to keep and the one call that writes it,
 * so the answer is the edit rather than a suggestion of one.
 */
async function editCard(id: string) {
  const card = config.value.cards.find((entry) => entry.id === id);

  if (!card) {
    return;
  }
  busy.value = true;
  try {
    await askTheAgent(null, [
      `This is the Focus card "${ card.id }" as it stands:`,
      '',
      '```json',
      JSON.stringify(card, null, 2),
      '```',
      '',
      'A card is what one kind of waiting work looks like when it is in front of me. `rules` are',
      `the priority-queue rules it draws (the ones in use right now: ${ rows.value.filter((row) => row.count).map((row) => row.id).join(', ') || 'none at the moment' }).`,
      '`kind` is one of review, issue, agent, question, signal and only decides the colour.',
      '`summary` and each action\'s `prompt` may use {what} {title} {needs} {why} {workspace}.',
      'Each action\'s `verb` is open, url, ask, snooze or done.',
      '',
      'Ask me what I want changed, then write the whole set back with:',
      '',
      '```bash',
      `curl -fsS -X PUT "$CLAUDE_HARNESS_API/focus" -H 'content-type: application/json' -d '{"cards": [ ...every card, with this one changed... ]}'`,
      '```',
      '',
      'The current set is readable at `curl -fsS "$CLAUDE_HARNESS_API/focus"`. Send every card back, not just this one.',
    ].join('\n'));
    say('The card is in the conversation.');
  } catch (e) {
    error.value = (e as Error)?.message || String(e);
  } finally {
    busy.value = false;
  }
}

async function newCard() {
  busy.value = true;
  try {
    await askTheAgent(null, [
      'I want a new card in the Focus view: a kind of waiting work that should look like something of its own when it reaches the top of my queue.',
      '',
      `The rules the queue has right now, with how many things each is holding: ${ rows.value.map((row) => `${ row.id } (${ row.count })`).join(', ') }.`,
      '',
      'Ask me what the card is for and what its buttons should do, then add it with a PUT to `$CLAUDE_HARNESS_API/focus` carrying the whole `cards` array - read the current one first with `curl -fsS "$CLAUDE_HARNESS_API/focus"`.',
      'A card is `{ id, label, kind, rules, summary, actions: [{ label, verb, prompt?, hours? }] }`; verbs are open, url, ask, snooze, done.',
    ].join('\n'));
    say('Ask away in the conversation.');
  } catch (e) {
    error.value = (e as Error)?.message || String(e);
  } finally {
    busy.value = false;
  }
}

async function resetCards() {
  await saveFocusConfig({ cards: SHIPPED_CARDS }).catch(() => {});
  config.value = { ...config.value, cards: SHIPPED_CARDS };
  say('Back to the cards that shipped.');
}

/* ── The sheet holds the deck's keys while it is open ─────────────────────────────────────── */

function openSettings(which: typeof section.value = 'queue') {
  section.value = which;
  if (!settings.value) {
    settings.value = true;
    holdOverlay();
  }
}

function closeSettings() {
  if (settings.value) {
    settings.value = false;
    releaseOverlay();
  }
}

/* ── The conversation along the bottom ────────────────────────────────────────────────────── */

/**
 * Made on the way in, not on load: arriving at this page should not start a conversation, and
 * the first thing anybody does with the bar is open it or type in it.
 */
async function wakeChat() {
  if (!conversation.value) {
    conversation.value = await panelConversation().catch(() => '');
  }
}

async function onChatOpen(open: boolean) {
  chatOpen.value = open;
  if (open) {
    await wakeChat();
  }
}

async function sendToChat(text: string) {
  sending.value = true;
  try {
    await wakeChat();
    await askTheAgent(null, text);
  } catch (e) {
    error.value = (e as Error)?.message || String(e);
  } finally {
    sending.value = false;
  }
}

onBeforeUnmount(closeSettings);
</script>

<template>
  <div class="dev-focus">
    <header class="focus__top">
      <div class="focus__brand">
        <span class="focus__mark"><AppIcon name="sparkle" :size="16" /></span>
        <span class="focus__name">Focus</span>
      </div>

      <p class="focus__count">
        <template v-if="loading">Gathering what needs you…</template>
        <template v-else-if="deck.length">
          <strong>{{ index + 1 }}</strong> of {{ deck.length }} waiting
          <span v-if="snoozedCount" class="focus__aside">· {{ snoozedCount }} put off</span>
        </template>
        <template v-else>Nothing in the deck</template>
      </p>

    </header>

    <div class="focus__main">
      <!--
        Pinned, down the side: taken out of the queue because you are dealing with them. They
        keep their hue and their title and nothing else - a pinned thing is a reminder, and a
        reminder that needs reading is a card, which is what the deck is for.

        The lane is always here, empty or not. It used to appear with the first pin, which moved
        the deck sideways - and, because nothing is pinned while the queue is still being read,
        moved it again the moment the page finished loading.
      -->
      <aside class="focus__pins">
        <h2 class="focus__pins-head">Pinned</h2>
        <button
          v-for="task in pinned"
          :key="task.key"
          type="button"
          class="pin"
          :class="{ 'pin--flying': task.key === flyingPin }"
          :data-key="task.key"
          :title="`${ task.needs } — click to put it back in the deck`"
          @click="unpin(task, $event)"
        >
          <MiniCard :task="task" blur />
        </button>
        <p v-if="!pinned.length" class="focus__pins-empty">
          Nothing pinned. Pin a card to keep it here while you work on it.
        </p>
      </aside>

      <main class="focus__deck">
        <DeckSkeleton v-if="loading" />
        <FocusDeck
          v-else
          ref="deckRef"
          :cards="deck"
          :index="index"
          :direction="direction"
          :busy="busy"
          :quiet="quiet"
          :landing="dropping"
          :notes="notes"
          :artifacts="artifacts"
          @go="go"
          @jump="jumpTo"
          @act="act"
          @ask="ask"
          @pin="pin"
          @resolve="resolveNote"
          @discuss="discussNote"
          @ask-code="current && askAboutCode(current, $event)"
          @reply="current && replyTo(current, $event)"
          @expand="current && openWholeFile(current, $event)"
          @take="current && takeIssue(current, $event)"
          @about-issue="current && askTheAgent(current, `About issue #${ $event.number } (${ $event.title }): read it and tell me whether it is specified well enough to start, roughly where in the codebase it lives, and how big it looks.`).then(() => say('Asked in the conversation.'))"
          @ask-reviewer="current && askReviewer(current, $event)"
          @answer="current && answerTheAgent(current, $event)"
          @workspace="current?.workspace && openWorkspace(current.workspace)"
          @make-workspace="current && makeWorkspaceFor(current)"
        />
      </main>
    </div>

    <!--
      The card between the two places, while it is between them. Keyed on the flight so every one
      of them is a new component with its own animation - the old version reused one mechanism and
      depended on it being reset afterwards, which is why it played once and then stopped.
    -->
    <CardFlight
      v-if="flight"
      :key="`${ flight.task.key }:${ flight.mode }`"
      :task="flight.task"
      :from="flight.from"
      :to="flight.to"
      :mode="flight.mode"
      @done="flightDone"
    />

    <!--
      The two corners: what is running behind the one card on screen. Workspaces on the left,
      because that is where the card's own workspace is named; the Ranchers they are pointed at
      on the right.
    -->
    <FocusDock
      label="Workspaces"
      icon="tasks"
      side="left"
      :rows="workspaceRows"
      :here="current?.workspace || ''"
      empty="No workspaces. A card that needs one offers to make it."
      @open="openWorkspace"
    />

    <FocusDock
      label="Ranchers"
      icon="scales"
      side="right"
      :rows="rancherRows"
      empty="No Rancher instances."
      @open="(url) => url && window.open(url, '_blank', 'noopener')"
    />

    <!-- The whole of a file somebody was reading six lines of. See components/code/FileModal. -->
    <FileModal
      v-if="whole"
      :key="`${ whole.path }:${ whole.mark[0] }`"
      :path="whole.path"
      :mark="whole.mark"
      :at="`PR #${ whole.pr }`"
      :load="readWholeFile"
      @close="whole = null"
    />

    <p v-if="error" class="focus__error">{{ error }}</p>
    <Transition name="notice">
      <p v-if="notice" class="focus__notice">{{ notice }}</p>
    </Transition>

    <!--
      The conversation. The bar is the prototype's; what is inside it when it opens is this
      product's own conversation pane, so what you ask here is where everything else you have
      asked is. See components/focus/FocusChatBar.vue.
    -->
    <FocusChatBar
      :open="chatOpen"
      :about="current?.title"
      :live="!!conversation"
      :busy="sending"
      @update:open="onChatOpen"
      @send="sendToChat"
      @settings="openSettings('queue')"
      @queue="openSettings('queue')"
    >
      <template #history>
        <!--
          The product's own conversation, wearing the prototype's clothes: `skin` is a class on
          the chat's root and nothing more, so this is the same chat as everywhere else, reading
          the same transcript, and the chat everywhere else is untouched. See design/focus-chat.css.
        -->
        <StudioTerminal
          v-if="conversation"
          :key="conversation"
          :session="conversation"
          skin="loop"
        />
        <p v-else class="focus__chat-empty">Starting a conversation…</p>
      </template>
    </FocusChatBar>

    <FocusModal
      :open="settings"
      title="Focus"
      :sections="sections"
      :current="section"
      @close="closeSettings"
      @select="(id) => section = (id as typeof section)"
    >
      <!-- ── Everything waiting ─────────────────────────────────────────────────────────────── -->
      <template v-if="section === 'queue'">
        <ol class="queue">
          <li
            v-for="(task, n) in deck"
            :key="task.key"
            class="queue__item"
            :class="[`queue__item--${ task.card.kind }`, { 'queue__item--on': n === index }]"
          >
            <button
              type="button"
              class="queue__row"
              @click="jumpTo(n); closeSettings()"
            >
              <span class="queue__rank">{{ n + 1 }}</span>
              <KindChip :kind="task.card.kind" size="sm" />
              <span class="queue__text">
                <span class="queue__title">{{ task.title || task.what }}</span>
                <span class="queue__needs">{{ task.needs }}</span>
              </span>
              <span class="queue__score">{{ task.score }}</span>
            </button>
          </li>
        </ol>
        <p v-if="!deck.length" class="focus__empty-note">Nothing is waiting on you.</p>

        <template v-if="snoozedCount">
          <h4 class="focus__subhead">Put off</h4>
          <ul class="queue queue--quiet">
            <li v-for="(until, key) in state.snoozed" :key="key" class="queue__item">
              <div class="queue__row queue__row--static">
                <span class="queue__text">
                  <span class="queue__title">{{ key }}</span>
                  <span class="queue__needs">back {{ new Date(until).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }}</span>
                </span>
                <AppButton
                  size="sm"
                  variant="ghost"
                  @click="remember({ ...state, snoozed: Object.fromEntries(Object.entries(state.snoozed).filter(([k]) => k !== key)) })"
                >Bring it back</AppButton>
              </div>
            </li>
          </ul>
        </template>
      </template>

      <!-- ── What decides the order ─────────────────────────────────────────────────────────── -->
      <WeightsChart
        v-else-if="section === 'weights'"
        :rows="rows"
        :cards="config.cards"
        :top="top"
        @set="({ id, score }) => setWeight(id, score)"
      />

      <!-- ── What a card looks like ─────────────────────────────────────────────────────────── -->
      <CardGallery
        v-else-if="section === 'cards'"
        :cards="config.cards"
        :counts="counts"
        @edit="editCard"
        @add="newCard"
      />

      <!-- ── Something of your own ──────────────────────────────────────────────────────────── -->
      <template v-else>
        <div class="form">
          <label class="field field--wide">
            <span class="field__label">What it is</span>
            <input v-model="draft.title" class="field__input" type="text" placeholder="Write the release notes">
          </label>
          <label class="field">
            <span class="field__label">What it wants from you</span>
            <input v-model="draft.needs" class="field__input" type="text" placeholder="Draft them and send them round">
          </label>
          <label class="field">
            <span class="field__label">Why it matters</span>
            <input v-model="draft.why" class="field__input" type="text" placeholder="the release is on Thursday">
          </label>
          <label class="field">
            <span class="field__label">Where to look (optional)</span>
            <input v-model="draft.url" class="field__input" type="text" placeholder="https://…">
          </label>
          <label class="field">
            <span class="field__label">How much it matters — {{ draft.score }}</span>
            <input v-model.number="draft.score" class="field__range" type="range" min="0" max="100">
          </label>
          <div class="field field--wide">
            <span class="field__label">What it looks like</span>
            <div class="field__kinds">
              <button
                v-for="kind in KINDS"
                :key="kind"
                type="button"
                class="field__kind"
                :class="{ 'field__kind--on': draft.kind === kind }"
                @click="draft.kind = kind as FocusKind"
              >
                <KindChip :kind="kind" size="sm" />
              </button>
            </div>
          </div>
        </div>

        <template v-if="config.tasks?.length">
          <h4 class="focus__subhead">Already yours</h4>
          <ul class="queue queue--quiet">
            <li v-for="task in config.tasks" :key="task.id" class="queue__item" :class="`queue__item--${ task.kind }`">
              <div class="queue__row queue__row--static">
                <KindChip :kind="task.kind" size="sm" />
                <span class="queue__text">
                  <span class="queue__title">{{ task.title }}</span>
                  <span class="queue__needs">{{ task.needs }}</span>
                </span>
                <span class="queue__score">{{ task.score }}</span>
                <AppButton size="sm" variant="ghost" @click="dropTask(task.id)">Remove</AppButton>
              </div>
            </li>
          </ul>
        </template>
      </template>

      <!-- Whatever the open section can be acted on with, on one footer rather than four. -->
      <template #actions>
        <template v-if="section === 'weights'">
          <AppButton variant="kind" :busy="busy" @click="saveWeights">Save the order</AppButton>
          <AppButton variant="ghost" @click="resetWeights">Back to shipped</AppButton>
        </template>
        <template v-else-if="section === 'cards'">
          <AppButton variant="kind" icon="sparkle" :busy="busy" @click="newCard">Make a new card</AppButton>
          <AppButton variant="ghost" @click="resetCards">Back to the cards that shipped</AppButton>
        </template>
        <template v-else-if="section === 'new'">
          <AppButton variant="kind" :busy="busy" :disabled="!draft.title.trim()" @click="addTask">Add it to the queue</AppButton>
        </template>
        <template v-else>
          <span class="focus__foot-note">{{ deck.length }} waiting · {{ pinned.length }} pinned · {{ snoozedCount }} put off</span>
        </template>
      </template>
    </FocusModal>

  </div>
</template>

<style scoped>
/*
 * The page is the prototype's: a ground with two soft lights on it, a row across the top, and
 * the deck taking everything that is left. What it does not have is the prototype's chat bar -
 * the product has one conversation and it is already on every page, so asking about a card goes
 * there (focus-agent.ts) rather than into a second one that would forget.
 */
.dev-focus {
  display: grid;
  grid-template-rows: auto 1fr;
  height: 100%;
  min-height: 0;
  /*
   * Nothing here scrolls the page. A card on its way out travels past the bottom edge, and a
   * container that grows to fit it hands the window a scrollbar for the length of the
   * animation - which shifts everything sideways as it appears and again as it goes. The
   * prototype made the document itself `overflow: hidden`; in here the page is a pane of a
   * dashboard, so it is this element and the shell's main area (see DevShell, dev-root--bare).
   */
  overflow: hidden;
  /* Room for the bar, which floats over the deck: its height, the gap it sits in, and a hair
     so a card's last row of actions is never under it. */
  padding-bottom: clamp(96px, 11vh, 118px);
  background:
    radial-gradient(1200px 680px at 12% -8%, rgba(91, 140, 255, 0.10), transparent 62%),
    radial-gradient(900px 560px at 92% 4%, rgba(184, 166, 255, 0.07), transparent 58%),
    var(--ground);
  color: var(--text);
  font-family: var(--font);
  font-size: var(--t-md);
  line-height: 1.5;
}

.focus__top {
  display: flex;
  align-items: center;
  gap: var(--s4);
  padding: var(--s3) clamp(var(--s4), 3vw, var(--s6));
}

.focus__brand { display: flex; align-items: center; gap: var(--s2); }

.focus__mark {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: var(--r-sm);
  background: var(--accent-wash);
  color: var(--accent);
}

.focus__name { font-weight: 650; letter-spacing: -0.02em; }
.focus__count { margin: 0 auto 0 var(--s4); color: var(--text-muted); font-size: var(--t-sm); }
.focus__count strong { color: var(--text); font-variant-numeric: tabular-nums; }
.focus__aside { color: var(--text-faint); }

.focus__tools { display: flex; align-items: center; gap: var(--s2); }

.focus__tool {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  /* The smallest control in this view is 30px; see AppButton's own sizes. */
  height: 30px;
  min-height: 0;
  padding: 0 var(--s4);
  border: 1px solid var(--border);
  border-radius: var(--r-pill);
  background: transparent;
  color: var(--text-muted);
  font-size: var(--t-xs);
  cursor: pointer;
  transition: color var(--fast), border-color var(--fast);
}

.focus__tool:hover { color: var(--text); border-color: var(--border-strong); }
.focus__tool--on { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, transparent); }

/* The deck, with whatever has been pinned beside it. */
.focus__main {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  /*
   * One row, the height of this element, for the reason the deck's own grid has one: an implicit
   * `auto` row is sized to its tallest item, so a tall card grew the row past the bounded height
   * it was supposed to sit in. Every box between the view and the card's scrolling body has to be
   * pinned, or the card is not a fixed object - this one, the deck's, and the card's own column.
   */
  grid-template-rows: minmax(0, 1fr);
  min-height: 0;
}

.focus__deck { min-height: 0; min-width: 0; }

.focus__pins {
  display: flex;
  flex-direction: column;
  gap: var(--s2);
  /* Wide enough that a parked card's own words are readable at this scale, narrow enough that
     the deck still has the room: the prototype's card is 90% of its window, and this keeps the
     deck near that. */
  width: 196px;
  padding: var(--s2) var(--s4) var(--s5);
  overflow-y: auto;
}

.focus__pins-empty {
  color: var(--text-faint);
  font-size: var(--t-xs);
  line-height: 1.4;
}

.focus__pins-head {
  color: var(--text-muted);
  font-size: var(--t-xs);
  font-weight: 650;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

/*
 * A pinned card is the card, parked: the real component scaled into the lane and blurred, with
 * what it is and what it wants drawn over the top. See MiniCard - the blur is the point, not a
 * decoration: a miniature that had to stay true would mean re-reading the pull request to
 * redraw something this small.
 */
.pin {
  display: block;
  padding: 0;
  border: 0;
  background: none;
  cursor: pointer;
  transition: transform var(--fast) var(--ease-spring);
}

/* Its place is held, but the card is still in the air on its way here. See CardFlight. */
.pin--flying { visibility: hidden; }

.pin:hover { transform: translateX(2px) scale(1.015); }

/* ── What the page says to you ────────────────────────────────────────────────────────────── */
.focus__notice,
.focus__error {
  position: fixed;
  left: 50%;
  bottom: var(--s5);
  z-index: 45;
  margin: 0;
  padding: var(--s2) var(--s4);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-pill);
  background: var(--surface-raised);
  color: var(--text-dim);
  font-size: var(--t-sm);
  transform: translateX(-50%);
  box-shadow: var(--shadow-2);
}

.focus__error { border-color: var(--danger); color: var(--danger); }

.notice-enter-active { transition: opacity var(--base) var(--ease-out), transform var(--base) var(--ease-spring); }
.notice-leave-active { transition: opacity var(--fast) linear, transform var(--fast) var(--ease-in-out); }
.notice-enter-from,
.notice-leave-to { opacity: 0; transform: translate(-50%, 10px); }

/* ── What is in the dialog ────────────────────────────────────────────────────────────────── */

.focus__chat-empty { padding: var(--s4); color: var(--text-muted); font-size: var(--t-sm); }
.focus__empty-note { color: var(--text-muted); font-size: var(--t-sm); }
.focus__foot-note { color: var(--text-faint); font-size: var(--t-xs); }

.focus__subhead {
  margin: var(--s6) 0 var(--s3);
  color: var(--text-muted);
  font-size: var(--t-xs);
  font-weight: 650;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

/*
 * The queue, in the deck's own colours.
 *
 * A row is the card it stands for, so it carries that card's hue on its edge and its chip in
 * the hue's own colour - which is what makes thirty rows readable as four kinds of work rather
 * than as thirty titles. Two columns where there is room: a queue is a list to scan, and a
 * single column of thirty in a dialog this wide is a lot of white space beside a lot of
 * scrolling.
 */
.queue {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: var(--s2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.queue--quiet { grid-template-columns: minmax(0, 1fr); }

.queue__item { --kind-c: var(--kind-signal); }
.queue__item--review   { --kind-c: var(--kind-review); }
.queue__item--issue    { --kind-c: var(--kind-issue); }
.queue__item--agent    { --kind-c: var(--kind-agent); }
.queue__item--question { --kind-c: var(--kind-question); }
.queue__item--signal   { --kind-c: var(--kind-signal); }

.queue__row {
  display: flex;
  align-items: center;
  gap: var(--s3);
  width: 100%;
  min-height: 52px;
  padding: var(--s2) var(--s3);
  overflow: hidden;
  border: 1px solid var(--border);
  border-left: 3px solid color-mix(in srgb, var(--kind-c) 70%, transparent);
  border-radius: var(--r-md);
  background: var(--surface-sunk);
  text-align: left;
  transition: border-color var(--fast), background var(--fast), transform var(--fast) var(--ease-spring);
}

.queue__row:hover { border-color: var(--kind-c); transform: translateX(2px); }
.queue__row--static { cursor: default; }
.queue__row--static:hover { transform: none; border-color: var(--border); border-left-color: color-mix(in srgb, var(--kind-c) 70%, transparent); }
.queue__item--on .queue__row { background: color-mix(in srgb, var(--kind-c) 10%, var(--surface-sunk)); border-color: var(--kind-c); }

.queue__rank {
  flex: 0 0 auto;
  width: 20px;
  color: var(--text-faint);
  font-size: var(--t-xs);
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.queue__text { display: flex; flex-direction: column; flex: 1 1 auto; min-width: 0; }
.queue__title { color: var(--text); font-size: var(--t-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.queue__needs { color: var(--text-faint); font-size: var(--t-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.queue__score {
  flex: 0 0 auto;
  color: var(--kind-c);
  font-size: var(--t-sm);
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}

/* ── The form ─────────────────────────────────────────────────────────────────────────────── */
.form {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: var(--s4);
}

.field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.field--wide { grid-column: 1 / -1; }
.field__label { color: var(--text-muted); font-size: var(--t-xs); letter-spacing: 0.04em; text-transform: uppercase; }

.field__input {
  width: 100%;
  height: 34px;
  padding: 0 var(--s3);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--surface-sunk);
  color: var(--text);
  font-size: var(--t-sm);
}

.field__input:focus { outline: none; border-color: var(--accent); }
.field__kinds { display: flex; flex-wrap: wrap; gap: var(--s2); }

.field__kind {
  display: inline-flex;
  align-items: center;
  height: 32px;
  padding: 0 var(--s2);
  border: 1px solid transparent;
  border-radius: var(--r-pill);
  opacity: 0.5;
  transition: opacity var(--fast), border-color var(--fast);
}

.field__kind--on { opacity: 1; border-color: var(--border-strong); }

/* How much a task of your own is worth: the one plain slider left. */
.field__range {
  width: 100%;
  height: 30px;
  appearance: none;
  background: none;
  cursor: ew-resize;
}

.field__range::-webkit-slider-runnable-track { height: 6px; border-radius: var(--r-pill); background: var(--surface-raised); }
.field__range::-moz-range-track { height: 6px; border-radius: var(--r-pill); background: var(--surface-raised); }

.field__range::-webkit-slider-thumb {
  appearance: none;
  width: 14px;
  height: 14px;
  margin-top: -4px;
  border: 2px solid var(--ground);
  border-radius: var(--r-pill);
  background: var(--accent);
}

.field__range::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border: 2px solid var(--ground);
  border-radius: var(--r-pill);
  background: var(--accent);
}

@media (max-width: 900px) {
  .focus__main { grid-template-columns: minmax(0, 1fr); }
  .dev-focus { padding-bottom: 96px; }
  .focus__pins { display: none; }
  .focus__name { display: none; }
}
</style>
