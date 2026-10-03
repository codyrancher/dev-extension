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
import { holdOverlay, releaseOverlay } from '../components/focus/overlay';
import { runtimeFacts } from '../components/focus/card-runtime';
import { followCards, loadedCards, cardsWatch, cardsSettled } from '../focus-cards';
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
import { listAllWorkspaces, currentOwner, workspaceProxyUrl } from '../api';
import type { DevWorkspace } from '../api';
import { listRanchers, deleteRancherInstance } from '../ranchers';
import { WORKSPACE_ROUTE } from '../config/constants';
import type { RancherTarget } from '../ranchers';
import {
  myWork, assignToMe, requestReviewers, describePr, createPullRequest, markReadyForReview
} from '../github';
import type { GithubWork } from '../github';
import { workspaceBranch, startDevServer, stopDevServer } from '../workspace-tools';
import { dependabotData, dependabotReviews, DEFAULT_REPO } from '../reviews';
import { workspaceStatuses, readStatusNow } from '../workspace-status';
import { conversationFor, panelConversation, queueForLater } from '../focus-agent';
import { sendToPane, paneCommand } from '../conversations';
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

/** A read is in flight for the card on top, so it can say so instead of filling in. */
const readingNow = ref(false);

/** The advisories and the bot's pull requests the queue was built from; see readArtifacts. */
const alsoFrom = ref<{ alerts: Json[]; botPrs: Json[]; botReviews: Json }>({ alerts: [], botPrs: [], botReviews: null });

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

  /*
   * Whether the card on top asked for them, which is the question.
   *
   * It was `task.rule === 'review-findings'` - one of the three rules the review-pass card claims,
   * alongside `review-response` and `review-agent`. On either of the other two `notes` stayed
   * empty, the surface ladder fell through (that card's wants are notes/stat/checks/media: no
   * files, no comments, no reviewers), and what was left was the facts strip under a two-press
   * confirm that posts a review to GitHub you were never shown. The live deck only holds
   * review-findings items, so it never reproduced - it was a latent GitHub write.
   *
   * Not the pull request number alone, which was the first fix and is worse: `reviewNotes` keys off
   * the number, so every card with a `#` in it would read them - and a review-asked card that
   * happened to have stored findings would draw the agent's pass, because `notes` is the top rung
   * of the surface ladder. The card says what it wants (`wants` on CardDef); this asks it.
   */
  if (!task || !pr || !(task.card.wants || []).includes('notes')) {
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
/** What each workspace needs, as the sidebar's own rows read it. See workspace-status.ts. */
const spaceStatus = ref<Record<string, Json>>({});

/**
 * The workspaces, saying what the sidebar's rows say about them.
 *
 * Its state is whether the pod is up, which is not the useful half: what a workspace row is read
 * for is what the work in it needs - "needs you", "working", "stopped" - and that is the status
 * the queue was already built from, so it costs nothing to put it here.
 */
const workspaceRows = computed<DockRow[]>(() => spaces.value
  .filter((ws) => !ws.preview)
  .map((ws) => {
    const status = spaceStatus.value[ws.name];

    return {
      id:    ws.name,
      name:  ws.name,
      state: status?.label || ws.state,
      up:    ws.state === 'running',
      bad:   ws.state === 'failed',
      tone:  status?.tone || 'muted',
      note:  status?.title || '',
      actions: [
        { id: 'server', label: ws.state === 'running' ? 'Stop the dev server' : 'Start the dev server', icon: 'server' },
        { id: 'app', label: 'Open the app', icon: 'expand' },
      ],
    };
  }));

const rancherRows = computed<DockRow[]>(() => ranchers.value.map((target) => ({
  id:    target.url || target.id,
  name:  target.name,
  state: target.phase,
  up:    target.phase === 'ready' || target.phase === 'host',
  bad:   target.phase === 'error',
  tone:  target.phase === 'error' ? 'bad' : target.phase === 'ready' || target.phase === 'host' ? 'good' : 'busy',
  // What it is doing, while it is doing something; once it is up its address is the useful half.
  note:  target.detail || (target.url ? host(target.url) : ''),
  // The three the sidebar's own Rancher rows offer. The host is this dashboard's own Rancher and
  // is not something to delete from a popover in the corner of a deck.
  actions: [
    ...(target.url ? [{ id: 'copy', label: 'Copy the address', icon: 'copy' }] : []),
    ...(target.url && target.kind !== 'host' ? [{ id: 'open', label: 'Open it', icon: 'expand' }] : []),
    ...(target.kind !== 'host' ? [{ id: 'delete', label: 'Delete this Rancher, with its cluster and node', icon: 'trash', danger: true }] : []),
  ],
})));

/** Just the host, for a dock row: a full URL in a 340px card is a line of ellipsis. */
function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * What a dock row's own controls do.
 *
 * The same acts the sidebar's rows offer, so the two places agree: a workspace's dev server and
 * its running app, and a Rancher's address, its page and its removal. Which row it was comes back
 * with the press, so this needs no state of its own.
 */
async function actOnRow(row: DockRow, action: string) {
  busy.value = true;
  try {
    if (action === 'server') {
      const ws = spaces.value.find((entry) => entry.name === row.id);
      const running = ws?.state === 'running';

      await (running ? stopDevServer(row.id) : startDevServer(row.id));
      say(running ? `Stopping the dev server in ${ row.id }.` : `Starting the dev server in ${ row.id }.`);
      spaces.value = await listAllWorkspaces().catch(() => spaces.value);
    } else if (action === 'app') {
      const ws = spaces.value.find((entry) => entry.name === row.id);

      if (ws?.state !== 'running') {
        say('Start the dev server first; then this opens the running build.');
      } else {
        window.open(workspaceProxyUrl(ws.name, ws.port, ws.scheme), '_blank', 'noopener');
      }
    } else if (action === 'copy') {
      await navigator.clipboard.writeText(row.id).catch(() => undefined);
      say('Address copied.');
    } else if (action === 'open') {
      window.open(row.id, '_blank', 'noopener');
    } else if (action === 'delete') {
      const target = ranchers.value.find((entry) => (entry.url || entry.id) === row.id);

      if (!target) {
        return;
      }
      await deleteRancherInstance(store, target.name);
      say(`${ target.name } is being removed.`);
      ranchers.value = await listRanchers(store).catch(() => ranchers.value);
    }
  } catch (e) {
    error.value = (e as Error)?.message || String(e);
  } finally {
    busy.value = false;
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
    readingNow.value = false;
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
  readingNow.value = true;
  readingArtifacts = readArtifacts(task, wants, store, me.value, work.value, alsoFrom.value)
    .catch(() => NO_ARTIFACTS)
    .then((found) => {
      // Turned again while this was in the air; see readNotes for the same guard.
      if (artifactsFor.value === task.key) {
        artifacts.value = found;
        readingNow.value = false;
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

/** The conversation the bar *is*, made the first time somebody opens, types or asks. */
const chatOpen = ref(false);
const conversation = ref('');

/**
 * The bar, so a card can put a question into it.
 *
 * A template ref rather than `provide`/`inject`: a UMD-loaded extension gets its own copy of
 * vue, so an injection that crosses the extension boundary resolves to `undefined` - it works
 * on the dev server and is dead in the installed plugin. Explicit, down one level, cannot break
 * that way.
 */
const bar = ref<InstanceType<typeof FocusChatBar> | null>(null);

/**
 * The workspace that conversation belongs to, when it belongs to one.
 *
 * A workspace's conversation runs in that workspace's own pod, so the pane needs the argv rather
 * than the Studio's default - the shape WorkspaceReview.vue uses. Empty for the panel's own.
 */
const chatWorkspace = ref('');

/**
 * Ask, in the bar, where the person is already looking.
 *
 * This used to end in `openAgentPanel` - the shell's terminal drawer - so every one of the ten
 * asks on these cards threw you out of the deck and covered the card you had asked about. Then
 * it queued the prompt through the agent API and pointed the bar at the conversation, which put
 * the answer in the right place but sent the question behind the chat's back: the bar could not
 * show it as yours, could not say when claude had not recorded it, and could not put it in the
 * log with everything else you had asked.
 *
 * So the card's question goes through the bar's own send - the same path as something typed into
 * it, see chat-conversation.ts. The one thing that cannot go that way is a conversation whose
 * pane will not take a paste yet (a workspace still coming up), and that falls back to the
 * queue, which is read when the conversation finally starts.
 */
async function askHere(task: FocusTask | null, prompt: string): Promise<string> {
  const where = await conversationFor(task).catch(() => ({ id: '', workspace: '' }));

  if (!where.id) {
    say('Nothing here can hold a conversation yet.');

    return '';
  }

  conversation.value = where.id;
  chatWorkspace.value = where.workspace;
  chatOpen.value = true;
  // The bar's conversation is derived from these two props; it has to see them before it sends.
  await nextTick();

  const said = await bar.value?.ask(prompt);

  if (!said) {
    await queueForLater(task, prompt).catch(() => {});
    say('Queued \u2014 it runs when the conversation starts.');
  }

  return where.id;
}

/** Everything the queue has, drawn: pinned ones are marked and then held back from the deck. */
const all = computed<FocusTask[]>(() => focusDeck(items.value, config.value, state.value));
const pinned = computed(() => all.value.filter((task) => task.pinned));
const deck = computed(() => all.value.filter((task) => !task.pinned));
const current = computed(() => deck.value[index.value] || null);

/**
 * What is coming, for the column beside the deck.
 *
 * The column measured 196x524 - 19% of the main region - and held the word PINNED and the sentence
 * "Nothing pinned. Pin a card to keep it here while you work on it", which is about 164x67px of
 * content: 89% of the largest piece of empty space on the screen. Meanwhile the only thing saying
 * what was next was the rail's column of 26 nine-pixel dots, of which the window has room for 13
 * and which says nothing about the other 13 beyond a chevron.
 *
 * So the column is the queue. The next six in words, which is the one thing a deck structurally
 * hides, and the index with each so a row can turn straight to it.
 *
 * No lede number on these rows, tempting as it is: a card's numbers come from `readArtifacts`, and
 * that is read for the card on top and nothing else - a deck of thirty would be thirty pull
 * requests fetched to draw a sidebar. How long it has waited is on every item already.
 */
const behindMe = computed(() => deck.value
  .map((task, n) => ({ task, n }))
  .filter((row) => row.n > index.value));

/*
 * Eight, which is how many fit.
 *
 * It was four, and before that six: four rows of 58px end at y325 in a column measured 196x524, so
 * 257px - 49% of the largest piece of empty space on the screen - was blank, with `pinsScroll
 * [524, 524]` saying nothing was cut off. There simply was no fifth row. Meanwhile the rail beside
 * the deck advertised 26 dots and "9 above / 16 below", so the two things on this screen that say
 * how long the deck is disagreed by twenty-two.
 *
 * Six was dropped because the titles ellipsised at 196px; they are two clamped lines now (see
 * `.up__title`), so the count is a question of height and nothing else.
 *
 * Seven, not eight: eight rows plus the closing row measured `[540, 570]` - 30px of scroll, with
 * `+17 more` half under the edge. The closing row is the part that makes this column rather than
 * the rail the thing that answers "what else is there", so it is the row that must be on screen.
 * Seven is 524 of the 540 the column measures, and nothing scrolls.
 */
const comingUp = computed(() => behindMe.value.slice(0, 7));

/** How many are behind the ones this column names. The row that says so opens the whole queue. */

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
      // The bumps card lists the ones nobody has reviewed, which is what the queue collapsed.
      botReviews,
    };
    spaceStatus.value = statuses as Record<string, Json>;
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

/*
 * What the card loader can prove about this page, where anyone can read it.
 *
 * Put here rather than behind a flag because the three facts it reports are the ones that decide
 * whether a card held in a ConfigMap can be drawn at all, and two of them are properties of
 * Rancher rather than of our code - which is exactly the shape of the `useRouter()` fault, where
 * something worked on the dev server and was silently dead in the installed plugin.
 */
let unfollow: (() => void) | null = null;

onMounted(() => {
  (window as any).__focusRuntime = runtimeFacts();

  /*
   * Follow the cards held outside the bundle.
   *
   * The request goes through the store rather than `fetch`, because `management/request` carries
   * the dashboard's own credentials and error handling; the *watch* cannot, since that dispatch
   * parses a whole JSON body and a watch never ends - so `followCards` streams that one with
   * `fetch`, same-origin against the same proxy path.
   */
  unfollow = followCards((url) => store.dispatch('management/request', { url }));

  // Where a probe can see what the watch is doing. See focus-cards.ts.
  (window as any).__focusCards = {
    cards: loadedCards, watch: cardsWatch, settled: cardsSettled, store,
  };
});

onBeforeUnmount(() => {
  unfollow?.();
  unfollow = null;
});

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
      /*
       * It opens the thing. It used to post a prompt.
       *
       * `open` dispatched to `askHere(task, 'Open … and tell me where it stands')`, so
       * answer-agent's primary button - on the one card that exists because an agent has stopped
       * and is waiting on you - started a second conversation asking where things stand instead of
       * taking you to the conversation. Four other cards carried the same mislabelled button, each
       * beside an `ask` that is also a prompt: two of a card's four controls did the same kind of
       * thing and one of them was dressed as navigation. The prompt behaviour is the card's `ask`;
       * this is `openWorkspace`, which is what the label says and what the header's workspace chip
       * has always called.
       */
      if (task.workspace) {
        openWorkspace(task.workspace);
      } else if (task.url) {
        window.open(task.url, '_blank', 'noopener');
      } else {
        say('There is nowhere to open this: it has no workspace and no link.');
      }
    } else if (action.verb === 'ask') {
      await askHere(task, actionPrompt(action, task));
      say('Asked — the reply arrives in the bar.');
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
    } else if (action.verb === 'merge-green') {
      await mergeTheGreenOnes(task);
    } else if (action.verb === 'ask-all') {
      await askReviewer(task, (artifacts.value?.reviewers?.suggested || []).map((one) => one.who));
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

/**
 * The file at the commit the review is of - not at the branch's tip, which has moved on - and the
 * patch that goes with it, so the whole file keeps this change's colours.
 *
 * The patch used to be taken from `artifacts.files`, which is empty on the card that opens this
 * most: a review pass asks for `notes`, not `files`, because its subject is the agent's comments
 * and each one already carries its own hunk. So the lookup found nothing, the modal fell back to
 * plain text, and the one thing you opened the file to put in context - the changed lines - was
 * the one thing drawn like everything else. Both come off the same `prDetail`, which is already
 * cached from reading the comments.
 */
async function readWholeFile(): Promise<{ text: string; patch: string }> {
  const at = whole.value;

  if (!at) {
    return { text: '', patch: '' };
  }
  const detail = await prDetail(at.pr).catch(() => null);
  const file = (detail?.files || []).find((entry: Json) => entry.path === at.path);
  const text = await prFile(at.pr, at.path, detail?.meta?.headSha || detail?.meta?.headRef || 'HEAD');

  return { text, patch: file?.patch || '' };
}

/* ── The verbs that are typical of one kind of work ───────────────────────────────────────── */

/** What the queue was built from, kept so the pool artifact does not ask GitHub a second time. */
const work = ref<GithubWork | null>(null);

/** Out of draft: the one act at that stage GitHub's own UI was otherwise needed for. */
/*
 * Putting a draft up for review, with the one thing that stops it.
 *
 * The draft card's own evidence row read "1 failing, 35 passed" while its primary offered
 * ready-for-review without qualification - one step milder than the mismatch the my-pr/red-pr
 * split was made to fix, and the same shape. The check state is already on the card, so the
 * button can read it: a red draft is not ready, and saying so beats letting it go up and be
 * bounced. It names the way round, as the merge does, rather than simply refusing.
 */
async function readyForReview(task: FocusTask) {
  const { pr } = subjectOf(task);

  if (!pr) {
    return;
  }

  // `ci.failing`, not the length of the list: the list is at most six failures by name, so a
  // pull request with nine of them used to be told it had six. See CardCi in focus-artifacts.
  const red = artifacts.value.ci?.failing || 0;

  if (red) {
    error.value = `${ task.what } has ${ red } check${ red > 1 ? 's' : '' } failing. Fix the build, or mark it ready on GitHub if you mean to.`;

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
    await askHere(task, `For ${ task.what }: read the diff, the commits and the issue it closes, then rewrite the pull request description on GitHub - what it changes, why, and what a reviewer should check.`);
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

/**
 * Ask for a review, from the card that noticed nobody had been asked.
 *
 * One name from a candidate row, or every name the card found from the footer's primary - which is
 * the act that card is named for and was its smallest control. `requestReviewers` always took a
 * list; this was the only caller and it only ever passed one.
 */
async function askReviewer(task: FocusTask, who: string | string[]) {
  const { pr } = subjectOf(task);
  const whom = (Array.isArray(who) ? who : [who]).filter(Boolean);

  if (!pr || !whom.length) {
    return;
  }
  busy.value = true;
  try {
    const { asked, refused } = await requestReviewers(DEFAULT_REPO, pr, whom);

    if (asked.length) {
      say(`Asked ${ asked.join(', ') } to review ${ task.what }.`);
      artifactsFor.value = '';
      readTheArtifacts();
    } else {
      error.value = `GitHub would not ask ${ whom.join(', ') }: ${ Object.values(refused)[0] || 'refused' }`;
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
async function mergeOne(pr: number): Promise<string> {
  const detail = await prDetail(pr).catch(() => null);
  const mine = String(detail?.meta?.author || '').toLowerCase() === me.value.toLowerCase();

  if (mine) {
    await mergePr(pr);

    return '';
  }

  const { steps } = await approveAndMerge(pr);
  const failed = steps.find((step) => !step.ok);

  return failed ? `${ failed.step }: ${ failed.note || 'failed' }` : '';
}

async function mergeIt(task: FocusTask) {
  const { pr } = subjectOf(task);

  if (!pr) {
    return;
  }

  if (artifacts.value.ci?.failing) {
    error.value = `${ task.what } is red. Merge it on GitHub if you mean to.`;

    return;
  }

  const trouble = await mergeOne(pr);

  if (trouble) {
    error.value = trouble;

    return;
  }
  say(`${ task.what } is merged.`);
  await done(task);
}

/**
 * One bump off the list, from its own row.
 *
 * The row offers the press only where the bot's own list says the build is green - `Merge` on a
 * red bump is the mistake the my-pr/red-pr split was made to stop - and the list is read again
 * afterwards, so a merged bump leaves the card rather than sitting there merged.
 */
async function mergeBump(row: { number: number; package: string; state: string }) {
  if (row.state !== 'green') {
    error.value = `${ row.package } is not green. Merge it on GitHub if you mean to.`;

    return;
  }
  busy.value = true;
  error.value = '';
  try {
    const trouble = await mergeOne(row.number);

    if (trouble) {
      error.value = trouble;

      return;
    }
    say(`${ row.package } is merged.`);
    await load();
  } catch (e) {
    error.value = (e as Error)?.message || String(e);
  } finally {
    busy.value = false;
  }
}

/**
 * Every green bump on the card, one after the other.
 *
 * The whole reason the bumps are one card: nine identical green bumps are one decision made once,
 * not nine turns of the deck. Sequential and stopping at the first refusal, because the
 * interesting outcome of a bulk merge is the one that did not go through - and it says how far it
 * got, which a silent partial failure does not.
 */
async function mergeTheGreenOnes(task: FocusTask) {
  const green = (artifacts.value.bumps || []).filter((row) => row.state === 'green');
  /*
   * Green is not the same as safe.
   *
   * The single bump's own card says it in as many words - "crosses a major: a major version can
   * change or remove what this repository uses, worth reading the changelog before it goes in" -
   * and on the live pile the one green row was `ts-node 8.10.2 → 10.9.2`, which is a major, and
   * was exactly what this merged. A bulk press is for the formalities; a major is the case the
   * other card exists for, so it stays behind its own row's `Merge` where it can be seen first.
   */
  const major = green.filter((row) => row.major);
  const take = green.filter((row) => !row.major);

  if (!take.length) {
    error.value = green.length
      ? `${ green.length === 1 ? 'The only green one crosses' : `All ${ green.length } green ones cross` } a major. Merge those from their own row, after reading the changelog.`
      : 'None of them is green.';

    return;
  }

  let merged = 0;

  for (const row of take) {
    const trouble = await mergeOne(row.number).catch((e: Error) => e?.message || String(e));

    if (trouble) {
      error.value = `${ row.package }: ${ trouble }${ merged ? ` (${ merged } merged first)` : '' }`;
      break;
    }
    merged += 1;
  }

  if (merged) {
    say(`${ merged } bump${ merged > 1 ? 's' : '' } merged.${ major.length ? ` ${ major.length } crossing a major left for you to read.` : '' }`);
  }
  await load();
  if (merged === take.length && !major.length) {
    await done(task);
  }
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
    await askHere(task, pr
      ? linesPrompt(pr, {
        path: value.path, line, startLine: null, side: 'RIGHT', code: value.code,
      }, value.text)
      : `About ${ value.path } ${ value.label }:\n\n\`\`\`\n${ value.code }\n\`\`\`\n\n${ value.text }`);
    say('Asked — the reply arrives in the bar.');
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
    await askHere(task, [
      `On ${ task.what }, ${ comment.author } said this${ comment.path ? ` about ${ comment.path }${ comment.line ? `:${ comment.line }` : '' }` : '' }:`,
      '',
      comment.body,
      '',
      'Draft a reply, and say whether it needs a change to the code. Do not push anything.',
    ].join('\n'));
    say('Asked — the reply arrives in the bar.');
  } catch (e) {
    error.value = (e as Error)?.message || String(e);
  } finally {
    busy.value = false;
  }
}

async function ask(task: FocusTask) {
  busy.value = true;
  try {
    await askHere(task, `About ${ task.what }${ task.title ? ` (${ task.title })` : '' }: ${ task.needs }. What should I know before I start?`);
    say('Asked — the reply arrives in the bar.');
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
    await askHere(task, discussPrompt(
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
    await askHere(null, [
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
    await askHere(null, [
      'I want a new card in the Focus view: a kind of waiting work that should look like something of its own when it reaches the top of my queue.',
      '',
      `The rules the queue has right now, with how many things each is holding: ${ rows.value.map((row) => `${ row.id } (${ row.count })`).join(', ') }.`,
      '',
      'Ask me what the card is for and what its buttons should do, then add it with a PUT to `$CLAUDE_HARNESS_API/focus` carrying the whole `cards` array - read the current one first with `curl -fsS "$CLAUDE_HARNESS_API/focus"`.',
      'A card is `{ id, label, kind, rules, summary, actions: [{ label, verb, prompt?, hours? }] }`; verbs are open, url, ask, snooze, done.',
    ].join('\n'));
    say('Ask away — the bar is open below.');
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
let waking: Promise<void> | null = null;

async function wakeChat(): Promise<void> {
  if (conversation.value) {
    return;
  }
  /*
   * Once, however many times it is asked for.
   *
   * The bar asks on open and again on the first keystroke, and `waitForSession` asks while it
   * waits - so without this guard three callers inside one second each reach
   * `panelConversation`, each finds no session, and each starts one. The panel would grow three
   * conversations from one keypress and the bar would end up reading whichever answered last.
   */
  waking = waking || (async() => {
    conversation.value = await panelConversation().catch(() => '');
    chatWorkspace.value = '';
    waking = null;
  })();

  return waking;
}

async function onChatOpen(open: boolean) {
  chatOpen.value = open;
  if (open) {
    await wakeChat();
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

      <!--
        What is running behind the one card on screen: the workspaces, and the Ranchers they are
        pointed at.

        In the page's own top-right corner rather than fixed to the bottom-left one. Both docks
        were in that corner - at x20 and x84, each 55x34 - and the chat bar was `left: 50%` with a
        980px body, which at this width put its own left edge at x22 and its first 42px button
        straight over the first dock, higher z-index winning. Two fixed layers were competing for
        the same forty pixels. Here they are in the flow, beside the count, where nothing can
        land on them at any width. (The bar is inset by `--pins-w` now and starts at the card's own
        left edge, so it would no longer reach them either.)
      -->
      <div class="focus__docks">
        <FocusDock
          label="Workspaces"
          icon="tasks"
          :rows="workspaceRows"
          :here="current?.workspace || ''"
          empty="No workspaces. A card that needs one offers to make it."
          @open="openWorkspace"
          @act="({ row, action }) => actOnRow(row, action)"
        />

        <FocusDock
          label="Ranchers"
          icon="scales"
          :rows="rancherRows"
          empty="No Rancher instances."
          @open="(url) => url && window.open(url, '_blank', 'noopener')"
          @act="({ row, action }) => actOnRow(row, action)"
        />
      </div>
    </header>

    <div class="focus__main">
      <!--
        The column: what you have pinned, and then what is coming.

        Pinned first - taken out of the queue because you are dealing with them. They keep their
        hue and their title and nothing else: a pinned thing is a reminder, and a reminder that
        needs reading is a card, which is what the deck is for.

        Then the queue itself, because this column was 196x524 - 19% of the main region - holding
        the word PINNED and one sentence of empty-state copy, about 89% of it empty, while the only
        thing saying what was next was a rail of 26 nine-pixel dots. See `comingUp`.

        The lane is always here, empty or not. It used to appear with the first pin, which moved
        the deck sideways - and, because nothing is pinned while the queue is still being read,
        moved it again the moment the page finished loading.
      -->
      <aside class="focus__pins">
        <template v-if="pinned.length">
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
          <hr class="focus__pins-rule">
        </template>

        <!--
          Nothing here about what is next.

          There was a column of the next seven cards, with their kind and their age. The rail of
          dots down the right already carries that - one dot per card in its kind's hue, the
          current one marked, each with its title on the pointer - and the settings sheet lists
          the whole queue. A second list of the same thing in the other margin is a second place
          to keep in step and one more thing between you and the card you are reading.
        -->
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
          :reading="readingNow"
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
          @merge-bump="mergeBump($event)"
          @about-bump="current && askHere(current, `For dependency bump #${ $event.number } (${ $event.package } ${ $event.from } → ${ $event.to }): read the changelog between the two versions and the failing checks, and tell me whether anything here uses what changed and whether you would merge it.`)"
          @about-issue="current && askHere(current, `About issue #${ $event.number } (${ $event.title }): read it and tell me whether it is specified well enough to start, roughly where in the codebase it lives, and how big it looks.`).then(() => say('Asked — the reply arrives in the bar.'))"
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
      The conversation, which is the bar rather than something the bar opens.

      It is handed the two things that say *which* conversation - the id, and the argv when it is
      a workspace's rather than the panel's - and it reads and writes that conversation itself,
      through chat-conversation.ts. No slot and no embedded pane: the bar and the drawer's
      ChatPane are two skins over one conversation, which is the only arrangement in which the
      bar can be typed into and still be the same chat as everywhere else. `wake` is the bar
      asking for a conversation because somebody started typing into it before there was one.
      See components/focus/FocusChatBar.vue.
    -->
    <FocusChatBar
      ref="bar"
      :open="chatOpen"
      :about="current?.title"
      :session="conversation"
      :command="chatWorkspace ? paneCommand(chatWorkspace, conversation) : null"
      @update:open="onChatOpen"
      @wake="wakeChat"
      @settings="openSettings('queue')"
      @queue="openSettings('queue')"
    />

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
              <!-- The card's own word, as on the card: the queue and the deck name a thing alike. -->
              <KindChip :kind="task.card.kind" :word="task.card.chip" size="sm" />
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
  /*
   * Room for the bar, which floats over the deck: its height plus the gap it sits in.
   *
   * It was `clamp(96px, 11vh, 118px)`, which at the measured 1024x678 resolved to 96px for a bar
   * that measures 54px tall at a 16px inset - so 26px of the page was held for nothing, below a
   * card whose own surface was 173px. The bar's height is a number this view knows; it does not
   * need to be guessed at with a viewport unit.
   */
  padding-bottom: calc(var(--bar-h) + var(--s5));
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

/*
 * One spine, not four.
 *
 * Measured: `.focus__top` at x=0, the chat bar at x=22 running 980px wide to x=1002, the deck
 * region at x=196, the card at x=216 and its content at x=250. So the bar was 234px wider than the
 * 746px card it is about and began underneath the pins column, which put the sentence `Ask about
 * "<this card's title>"` centred on the window rather than on the card it names.
 *
 * The column's width is a token now, so the bar can be inset by it and by the deck's own padding
 * and land on the card's left edge. See `.bar` in FocusChatBar, which reads both, and the phone
 * branch at the bottom of this file, which zeroes the first when the column goes away.
 */
.dev-focus {
  --pins-w: 196px;
  --deck-pad-l: clamp(var(--s3), 2vw, var(--s6));
  --deck-pad-r: 62px;
}

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
     deck near that. The bar lines up with the card by subtracting it; see `--pins-w`. */
  width: var(--pins-w);
  padding: var(--s2) var(--s4) var(--s5);
  overflow-y: auto;
}

.focus__pins-empty {
  color: var(--text-faint);
  font-size: var(--t-xs);
  line-height: 1.4;
}

.focus__pins-rule {
  margin: var(--s2) 0;
  border: 0;
  border-top: 1px solid var(--border);
}

/* ── What is coming ───────────────────────────────────────────────────────── */

/*
 * One row per card that is coming, at the height everything pressable in this view is: a hue bar
 * down its left edge, what kind of thing it is, its title on one line, and how long it has sat.
 */

/* Two lines, because one was never a title at 196px: see `comingUp` for what was measured. */

/*
 * The last row: what this column is not showing, in the column's own rhythm.
 *
 * Quieter than a card row because it is not a card - it is the count the rail was being asked to
 * carry in nine-pixel dots - and at `--control-h` because it is pressed.
 */

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

/*
 * The docks, in the page's own header rather than fixed over its bottom-left corner, where the
 * chat bar is. In the flow, so nothing can be drawn on top of them and nothing has to be kept in
 * step with the bar's offsets. See the markup for what the overlap measured.
 */
.focus__docks {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  gap: var(--s2);
}

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
  /* No column, so nothing for the bar to be inset by. See `--pins-w`. */
  .dev-focus { --pins-w: 0px; --deck-pad-l: var(--s3); --deck-pad-r: var(--s3); }
  .focus__main { grid-template-columns: minmax(0, 1fr); }
  .dev-focus { padding-bottom: 96px; }
  .focus__pins { display: none; }
  .focus__name { display: none; }
}
</style>
