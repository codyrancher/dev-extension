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
import FocusModal from '../components/focus/FocusModal.vue';
import KindChip from '../components/focus/KindChip.vue';
import AppIcon from '../components/focus/AppIcon.vue';
import AppButton from '../components/focus/AppButton.vue';
import WeightsChart from '../components/focus/WeightsChart.vue';
import MiniCard from '../components/focus/MiniCard.vue';
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
import '../design/focus-chat.css';

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
