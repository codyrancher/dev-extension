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
  computed, nextTick, onMounted, onBeforeUnmount, ref, watch
} from 'vue';
import FocusDeck from '../components/focus/FocusDeck.vue';
import DeckSkeleton from '../components/focus/DeckSkeleton.vue';
import SidePanel from '../components/focus/SidePanel.vue';
import KindChip from '../components/focus/KindChip.vue';
import AppIcon from '../components/focus/AppIcon.vue';
import AppButton from '../components/focus/AppButton.vue';
import WeightsChart from '../components/focus/WeightsChart.vue';
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
import { priorityQueue } from '../priority';
import type { PriorityItem } from '../priority';
import { listAllWorkspaces } from '../api';
import { myWork } from '../github';
import { dependabotData, dependabotReviews, DEFAULT_REPO } from '../reviews';
import { workspaceStatuses, readStatusNow } from '../workspace-status';
import { askTheAgent, panelConversation } from '../focus-agent';
import { reviewNotes } from '../focus-review';
import type { ReviewNote } from '../focus-review';
import { updateComment, deleteComment, discussPrompt } from '../reviews';
import '../design/focus.css';

const loading = ref(true);
const busy = ref(false);
const notice = ref('');
const error = ref('');

const items = ref<PriorityItem[]>([]);
const config = ref<FocusConfig>({ cards: SHIPPED_CARDS, weights: {}, tasks: [] });
const state = ref<FocusState>({ pinned: [], snoozed: {}, done: {} });

const index = ref(0);
const direction = ref<1 | -1>(1);
const deckRef = ref<{ enterFrom(rect: DOMRect): void } | null>(null);

/**
 * The agent's comments for the card on top, when there are any.
 *
 * Read for the top card and nothing else: a pass is a dozen comments and each one carries a
 * hunk, so reading them for a deck of thirty would be thirty pull requests fetched to draw one.
 */
const notes = ref<ReviewNote[]>([]);
const notesFor = ref('');

async function readNotes() {
  const task = current.value;
  const pr = Number(/#(\d+)/.exec(task?.what || '')?.[1] || 0);

  if (!task || !pr || task.rule !== 'review-findings') {
    notes.value = [];
    notesFor.value = '';

    return;
  }
  if (notesFor.value === task.key) {
    return;
  }
  notesFor.value = task.key;
  notes.value = await reviewNotes(pr).catch(() => []);
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

const SECTIONS = [
  { id: 'queue', label: 'Waiting' },
  { id: 'weights', label: 'Order' },
  { id: 'cards', label: 'Cards' },
  { id: 'new', label: 'Yours' },
] as const;

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

    // The same reads My Work's Priority tab makes, in the same order and for the same reasons -
    // see refreshPriority there. The one that matters is the second pass over the workspaces:
    // `workspaceStatuses` hands back what has been read so far and starts a read for the rest,
    // so a cold page would rank a review workspace by what GitHub alone can see and miss that
    // its agent has already left findings waiting.
    const workspaces = await listAllWorkspaces().catch(() => []);
    const names = workspaces.map((workspace) => workspace.name);
    const [work, dependabot, cached, botReviews] = await Promise.all([
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

    items.value = priorityQueue({
      work,
      statuses,
      workspaces: names,
      alerts:     (dependabot?.groups || []).map((group: Record<string, unknown>) => ({ ...group, key: group.slug })),
      botPrs:     (dependabot?.prs || []).map((pr: Record<string, unknown>) => ({ ...pr, key: pr.number, repo: DEFAULT_REPO })),
      botReviews,
      weights:    cfg.weights,
      extra:      (cfg.tasks || []).map(manualItem),
    });
  } catch (e) {
    error.value = (e as Error)?.message || String(e);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

/* ── Turning the deck ─────────────────────────────────────────────────────────────────────── */

watch(current, readNotes, { immediate: true });

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

async function remember(next: FocusState) {
  state.value = next;
  await saveFocusState(next).catch((e) => {
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
 * Putting it back is the half worth the trouble: the card is already on the screen, in the rail,
 * at that size - so it grows from there into the top of the deck rather than appearing in it
 * while the thing you pressed disappears. `from` is where it was when you pressed it, measured
 * before anything moves; the deck plays its own turn from that transform. See FocusDeck.
 */
async function pin(task: FocusTask, from?: DOMRect) {
  const on = state.value.pinned.includes(task.key);

  await remember({
    ...state.value,
    pinned: on ? state.value.pinned.filter((key) => key !== task.key) : [...state.value.pinned, task.key],
  });
  settle();

  if (on) {
    await nextTick();
    const to = deck.value.findIndex((entry) => entry.key === task.key);

    if (to >= 0) {
      if (from) {
        deckRef.value?.enterFrom(from);
      }
      direction.value = to >= index.value ? 1 : -1;
      index.value = to;
    }
  }
  say(on ? `${ task.what } is back in the deck.` : `${ task.what } is pinned.`);
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
    }
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

      <!--
        One control for everything that is not the deck. The four it replaced each opened a
        sheet of their own, which is four things to learn about a page whose claim is that it
        shows you one thing at a time.
      -->
      <button type="button" class="focus__tool" title="The queue, the order, the cards" @click="openSettings('queue')">
        <AppIcon name="settings" :size="14" /> Settings
      </button>
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
          :class="`pin--${ task.card.kind }`"
          :title="`${ task.needs } — click to put it back in the deck`"
          @click="unpin(task, $event)"
        >
          <span class="pin__what">{{ task.what }}</span>
          <span class="pin__title">{{ task.title || task.needs }}</span>
          <span class="pin__needs">{{ task.needs }}</span>
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
          :notes="notes"
          @go="go"
          @jump="jumpTo"
          @act="act"
          @ask="ask"
          @pin="pin"
          @resolve="resolveNote"
          @discuss="discussNote"
        />
      </main>
    </div>

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
        <StudioTerminal
          v-if="conversation"
          :key="conversation"
          :session="conversation"
        />
        <p v-else class="focus__chat-empty">Starting a conversation…</p>
      </template>
    </FocusChatBar>

    <SidePanel :open="settings" title="Focus" @close="closeSettings">
      <nav class="tabs">
        <button
          v-for="tab in SECTIONS"
          :key="tab.id"
          type="button"
          class="tabs__tab"
          :class="{ 'tabs__tab--on': section === tab.id }"
          @click="section = tab.id"
        >{{ tab.label }}</button>
      </nav>

      <!-- ── Everything waiting ───────────────────────────────────────────────────────────── -->
      <template v-if="section === 'queue'">
        <p class="panel__note">
          The deck in order. Picking one deals it to the top; pinned ones are beside the deck
          already.
        </p>
        <ol class="list">
          <li v-for="(task, n) in deck" :key="task.key">
            <button
              type="button"
              class="list__row"
              :class="{ 'list__row--on': n === index }"
              @click="jumpTo(n); closeSettings()"
            >
              <KindChip :kind="task.card.kind" size="sm" />
              <span class="list__title">{{ task.title || task.what }}</span>
              <span class="list__meta">{{ task.score }}</span>
            </button>
          </li>
        </ol>
        <p v-if="!deck.length" class="list__empty">Nothing is waiting on you.</p>

        <template v-if="snoozedCount">
          <h3 class="list__head">Put off</h3>
          <ul class="list">
            <li v-for="(until, key) in state.snoozed" :key="key" class="list__snoozed">
              <span class="list__title">{{ key }}</span>
              <button type="button" class="list__undo" @click="remember({ ...state, snoozed: Object.fromEntries(Object.entries(state.snoozed).filter(([k]) => k !== key)) })">
                bring it back
              </button>
            </li>
          </ul>
        </template>
      </template>

      <!-- ── What decides the order ───────────────────────────────────────────────────────── -->
      <template v-else-if="section === 'weights'">
        <WeightsChart
          :rows="rows"
          :cards="config.cards"
          :top="top"
          @set="({ id, score }) => setWeight(id, score)"
        />
        <div class="panel__actions">
          <AppButton variant="kind" :busy="busy" @click="saveWeights">Save the order</AppButton>
          <AppButton variant="ghost" @click="resetWeights">Back to shipped</AppButton>
        </div>
      </template>

      <!-- ── What a card looks like ───────────────────────────────────────────────────────── -->
      <template v-else-if="section === 'cards'">
        <p class="panel__note">
          One card per kind of waiting work, drawn as the card it makes. Changing one is a
          conversation: the agent is handed the definition and writes it back.
        </p>
        <CardGallery
          :cards="config.cards"
          :counts="counts"
          @edit="editCard"
          @add="newCard"
        />
        <div class="panel__actions">
          <AppButton variant="ghost" @click="resetCards">Back to the cards that shipped</AppButton>
        </div>
      </template>

      <!-- ── Something of your own ────────────────────────────────────────────────────────── -->
      <template v-else>
        <p class="panel__note">
          Anything no system knows about. It goes into the same queue as everything else and is
          ranked with it, which is the point: a queue you keep things out of is a queue you stop
          believing.
        </p>

        <label class="field">
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
          <span class="field__label">How much it matters: {{ draft.score }}</span>
          <input v-model.number="draft.score" class="field__range" type="range" min="0" max="100">
        </label>
        <div class="field">
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

        <div class="panel__actions">
          <AppButton variant="kind" :busy="busy" :disabled="!draft.title.trim()" @click="addTask">Add it</AppButton>
        </div>

        <template v-if="config.tasks?.length">
          <h3 class="list__head">Yours</h3>
          <ul class="list">
            <li v-for="task in config.tasks" :key="task.id" class="list__snoozed">
              <span class="list__title">{{ task.title }}</span>
              <button type="button" class="list__undo" @click="dropTask(task.id)">remove</button>
            </li>
          </ul>
        </template>
      </template>
    </SidePanel>

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
  min-height: 0;
}

.focus__deck { min-height: 0; min-width: 0; }

.focus__pins {
  display: flex;
  flex-direction: column;
  gap: var(--s2);
  width: 212px;
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

.pin {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--s3);
  border: 1px solid color-mix(in srgb, var(--kind-c) 32%, var(--border));
  border-left: 3px solid var(--kind-c);
  border-radius: var(--r-md);
  background: var(--surface-sunk);
  color: var(--text-dim);
  text-align: left;
  cursor: pointer;
  transition: transform var(--fast) var(--ease-spring), border-color var(--fast);
}

.pin:hover { transform: translateX(2px); border-color: var(--kind-c); }
.pin__what { color: var(--kind-c); font-size: 10px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; }
.pin__title { color: var(--text); font-size: var(--t-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pin__needs { color: var(--text-faint); font-size: var(--t-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.pin--review   { --kind-c: var(--kind-review); }
.pin--issue    { --kind-c: var(--kind-issue); }
.pin--agent    { --kind-c: var(--kind-agent); }
.pin--question { --kind-c: var(--kind-question); }
.pin--signal   { --kind-c: var(--kind-signal); }

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

/* The four things that are not the deck, as one strip at the top of the sheet. */
.tabs {
  display: flex;
  gap: 2px;
  margin-bottom: var(--s4);
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: var(--r-pill);
  background: var(--surface-sunk);
}

.tabs__tab {
  flex: 1 1 auto;
  height: 30px;
  padding: 0 var(--s3);
  border: 0;
  border-radius: var(--r-pill);
  background: transparent;
  color: var(--text-muted);
  font-size: var(--t-xs);
  cursor: pointer;
  transition: background var(--fast), color var(--fast);
}

.tabs__tab:hover { color: var(--text); }
.tabs__tab--on { background: var(--accent-wash); color: var(--accent); }

.focus__chat-empty { padding: var(--s4); color: var(--text-muted); font-size: var(--t-sm); }

/* ── The panels ───────────────────────────────────────────────────────────────────────────── */
.panel__note { margin: 0 0 var(--s4); color: var(--text-muted); font-size: var(--t-sm); }

.panel__actions {
  display: flex;
  gap: var(--s2);
  margin-top: var(--s5);
}

.list { display: flex; flex-direction: column; gap: var(--s2); margin: 0; padding: 0; list-style: none; }
.list__head { margin: var(--s6) 0 var(--s3); color: var(--text-muted); font-size: var(--t-xs); letter-spacing: 0.06em; text-transform: uppercase; }

.list__row {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: var(--s3);
  width: 100%;
  padding: var(--s3);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface-sunk);
  text-align: left;
  cursor: pointer;
  transition: border-color var(--fast), background var(--fast), transform var(--fast) var(--ease-spring);
}

.list__row:hover { border-color: var(--border-strong); transform: translateX(2px); }
.list__row--on { border-color: var(--accent); background: var(--accent-wash); }
.list__title { color: var(--text-dim); font-size: var(--t-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.list__meta { color: var(--text-faint); font-size: var(--t-xs); font-variant-numeric: tabular-nums; }
.list__empty { color: var(--text-muted); }

.list__snoozed {
  display: flex;
  align-items: center;
  gap: var(--s3);
  padding: var(--s2) var(--s3);
  border: 1px dashed var(--border);
  border-radius: var(--r-md);
}

.list__undo {
  margin-left: auto;
  border: 0;
  background: none;
  color: var(--accent);
  font-size: var(--t-xs);
  cursor: pointer;
}

/* ── The form ─────────────────────────────────────────────────────────────────────────────── */
.field { display: flex; flex-direction: column; gap: 4px; margin-bottom: var(--s4); }
.field__label { color: var(--text-muted); font-size: var(--t-xs); letter-spacing: 0.04em; text-transform: uppercase; }

.field__input {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--surface-sunk);
  color: var(--text);
  font: inherit;
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
  background: none;
  cursor: pointer;
  opacity: 0.5;
  transition: opacity var(--fast), border-color var(--fast);
}

.field__kind--on { opacity: 1; border-color: var(--border-strong); }

@media (max-width: 900px) {
  .focus__main { grid-template-columns: minmax(0, 1fr); }
  .dev-focus { padding-bottom: 96px; }
  .focus__pins { display: none; }
  .focus__name { display: none; }
}
</style>
