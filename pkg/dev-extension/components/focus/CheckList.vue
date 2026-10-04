<script setup lang="ts">
/**
 * The failing checks - and, as a card's surface, what they actually printed.
 *
 * Two places want this and they want it at two sizes: the badge on the facts line opens the names
 * in a popover, and the card whose entire subject is a red build has it as its surface.
 *
 * **The names were all it was.** As a surface this drew `e2e-test (admin, @adminUser,
 * @explorer2)`, `Description`, `validate`, each with an arrow to GitHub - and the name of a
 * failing job is not the information anybody decides anything on. The question a red card raises
 * is "what broke", and the only way to the assertion that answers it was to leave the card for
 * GitHub and come back to a deck that had moved on. So the surface is the failing *output* now:
 * the window around the failure, with the lines that are the failure marked, and the rest of the
 * log a press away.
 *
 * ## What it shows first, and why that
 *
 *   - **One check's output, not six.** Six logs do not fit a 276px body and six log fetches do
 *     not fit the second a card has to draw in. The one shown is the first failure with an
 *     Actions job behind it (see `ciOf`), because a status context like `Description` kept no log
 *     and would have drawn the whole surface off a bot complaining about prose.
 *   - **The other five as chips above it**, labelled with the part of the name that tells them
 *     apart. One press switches the pane, which reads that check's output on the spot.
 *   - **The excerpt, not the log.** `dev-api` finds the first thing that looks like a failure and
 *     returns the window around it with the matching lines called out - so the first thing on the
 *     card is `AssertionError: expected false to be true` and the two frames under it, not the
 *     four hundred lines of `yarn install` that came first. The regex for what a failure looks
 *     like lives next to the log rather than in the browser; see `failureExcerpt`.
 *   - **The lines carry the log's own numbers**, off `report.at`, so `line 1,207` on the card is
 *     line 1,207 in the dialog that opens the whole log. Numbering an excerpt 1..n would have
 *     made every number on the card a number of a slice nobody can find again.
 *
 * In the popover it is still only the names: a 26px badge opens a list of what is failing, and a
 * log excerpt is not a thing to put in a popover.
 */
import { computed, ref, watch } from 'vue';
import SectionHead from './SectionHead.vue';
import AppIcon from './AppIcon.vue';
import CodeView from '../code/CodeView.vue';
import FileModal from '../code/FileModal.vue';
import { fromText } from '../code/rows';
import type { CodeRow } from '../code/rows';
import { ciFailureDetail, ciFailureLog } from '../../reviews';
import { checkReportFrom } from '../../focus-artifacts';
import type { CardCheck, CheckReport } from '../../focus-artifacts';

const props = withDefaults(defineProps<{
  /** The failures with names. Capped at six by `ciOf`; `failing` is how many there really are. */
  checks: CardCheck[];
  failing: number;
  /** Taking the room, as a card's surface, rather than sizing to its content in a popover. */
  surface?: boolean;
  /** The fact the card's 36px lede already said. See `claimed` in FocusCard. */
  claimed?: string;
  /**
   * The failing output that arrived with the card, for one of the checks. See `CheckReport`.
   *
   * Null is not an error: the card may not have asked for `logs`, the read may have failed, or
   * nothing failing may have a log. The pane reads what it needs in that case, which is also what
   * makes this component work on a card whose artifacts were cached before `logs` existed.
   */
  report?: CheckReport | null;
  /** Which pull request, so the other five checks' output can be read when somebody asks. */
  pr?: number;
}>(), {
  surface: false, claimed: '', report: null, pr: 0,
});

/**
 * `of {failing}`, because the names are capped at six and the count is not: a card whose build has
 * nine failures used to open onto six rows headed `6`. And nothing at all where the card's lede
 * has already said the number - which is every red-pr card, whose lede is `6 of 46 checks failing`.
 */
const count = () => {
  if (props.checks.length < props.failing) {
    return `first ${ props.checks.length } of ${ props.failing }`;
  }

  return props.claimed === 'checks' ? '' : String(props.failing);
};

/*
 * What has been read, by check id: the report the card arrived with, plus whatever has been asked
 * for since. Kept here rather than fetched on every pick because switching back and forth between
 * two failing suites is the normal way of reading them, and the second look should not cost a
 * second quarter-second.
 */
const reports = ref<Record<number, CheckReport | null>>({});
/*
 * Which of the rows is being read, by *index* rather than by check id.
 *
 * Because a status context has no id - it is 0 on every one of them, see `CardCheck.id` - so
 * keyed on the id, pressing `Description` would have selected whichever status came first and
 * `find(id === 0)` would have matched it on a card where nothing had been pressed at all. -1 is
 * "nothing failing has output to read", which is what falls back to the plain list of names.
 */
const pickedAt = ref(-1);
/** What was at that index, so a redraw of the same card does not move the selection. */
const pickedName = ref('');
/** The id whose output is in flight, so the pane can say so rather than draw empty. */
const reading = ref(0);
const failed = ref('');
/** The whole log, over the card. See FileModal. */
const whole = ref(false);
/*
 * Whether the annotations past the third are showing. Declared up here with the rest of the
 * state because the seeding watch below runs `immediate` - during setup - and resets it: a `const`
 * read before its own line is a ReferenceError, not an undefined.
 */
const notesOpen = ref(false);

async function read(check: CardCheck) {
  // A status context has no id and so nothing to read; `pr` is 0 on a card about something that
  // is not a pull request, which cannot happen for this surface but costs nothing to allow for.
  if (!check.id || !props.pr || reports.value[check.id] !== undefined) {
    return;
  }
  reading.value = check.id;
  failed.value = '';
  try {
    const got = checkReportFrom(await ciFailureDetail(props.pr, check.id));

    reports.value = { ...reports.value, [check.id]: got };
  } catch (e) {
    failed.value = (e as Error)?.message || String(e);
  } finally {
    if (reading.value === check.id) {
      reading.value = 0;
    }
  }
}

function pick(at: number) {
  const check = props.checks[at];

  if (!check) {
    return;
  }
  pickedAt.value = at;
  pickedName.value = check.name;
  whole.value = false;
  notesOpen.value = false;
  // Not carried over from the check that failed to read: it is said in the pane, and the pane is
  // now about something else.
  failed.value = '';
  read(check);
}

/*
 * Seeded from the props, and re-seeded when the card changes under it.
 *
 * `immediate`, because the first look must not need a press: the report the card loaded is put in
 * the cache and its check is the one picked. Where there is no report - the artifact was not
 * asked for, or the read failed - the picked check's own output is read here instead, which is
 * one request and the same one `ciOf` would have made.
 *
 * The name guard keeps a reader's own press: artifacts are replaced wholesale when a card is
 * re-read, and `checks` is a new array every time, so without it a refresh landing behind you
 * would move the pane back to whichever check the card arrived showing.
 */
watch(() => [props.report, props.checks, props.pr] as const, () => {
  if (props.report?.id) {
    reports.value = { ...reports.value, [props.report.id]: props.report };
  }
  if (pickedAt.value >= 0 && props.checks[pickedAt.value]?.name === pickedName.value) {
    return;
  }

  const first = props.checks.findIndex((check) => check.id && check.id === props.report?.id);
  const at = first >= 0 ? first : props.checks.findIndex((check) => check.id);

  pickedAt.value = at;
  pickedName.value = at >= 0 ? props.checks[at].name : '';
  whole.value = false;
  notesOpen.value = false;
  failed.value = '';
  if (props.surface && at >= 0) {
    read(props.checks[at]);
  }
}, { immediate: true });

const picked = computed(() => (pickedAt.value >= 0 ? props.checks[pickedAt.value] || null : null));
const shown = computed<CheckReport | null>(() => (picked.value?.id ? reports.value[picked.value.id] || null : null));

/** The check's own headline, which is often the whole answer: "3 of 48 specs failed". */
const said = computed(() => shown.value?.title || picked.value?.detail || '');

/*
 * GitHub's own idea of where it broke. Three above the code, because they are two lines each and
 * the pane under them is the point of the card - a type-check with eight annotations would push
 * the code off the bottom of the body before anybody had scrolled.
 */
const notes = computed(() => {
  const all = shown.value?.annotations || [];

  return notesOpen.value ? all : all.slice(0, 3);
});
const notesHidden = computed(() => Math.max(0, (shown.value?.annotations || []).length - notes.value.length));

/**
 * The excerpt as rows, numbered where it sits in the log and marked where it failed.
 *
 * `fromText` with no path on purpose: a CI log is not a source file, and asking `highlightLines`
 * to guess a language from `e2e-test (admin, @adminUser)` would colour a stack trace as whatever
 * it decided that was. `marked` per row rather than `markLines` because the hits are not one run
 * - an assertion and the three frames under it, then the suite's own summary forty lines later.
 */
const rows = computed<CodeRow[]>(() => {
  const got = shown.value;

  if (!got?.text) {
    return [];
  }
  const hit = new Set(got.hits);

  return fromText(got.text, '', got.at || 1)
    .map((row, i) => (hit.has(i + 1) ? { ...row, marked: true } : row));
});

/** How much of the log this is, said on the pane's own bar rather than guessed at. */
const where = computed(() => {
  const got = shown.value;

  if (!got || !rows.value.length) {
    return '';
  }
  if (!got.lines || got.lines <= rows.value.length) {
    return `${ rows.value.length } lines`;
  }

  return got.matched
    ? `${ rows.value.length } of ${ got.lines.toLocaleString() } lines, around the failure`
    : `the last ${ rows.value.length } of ${ got.lines.toLocaleString() } lines`;
});

/**
 * Where the whole log opens: on the failure the card was already showing.
 *
 * `at` places the window in the log and `hits` place the failure in the window, so the sum is the
 * failure's line in the log. It holds because both calls keep the same amount of the same
 * finished job's log - see `LOG_TAIL_BYTES` - and when it does not hold, because the dev-api is a
 * version behind and sent no `at`, the mark is simply absent and the dialog opens at the top.
 */
const mark = computed<[number, number] | null>(() => {
  const got = shown.value;

  if (!got?.hits.length || !got.at) {
    return null;
  }

  return [got.at + got.hits[0] - 1, got.at + got.hits[got.hits.length - 1] - 1];
});

async function readWholeLog(): Promise<string> {
  const got = shown.value;

  if (!got || !props.pr) {
    return '';
  }
  const data = await ciFailureLog(props.pr, got.id);

  return String(data?.text || '');
}

/**
 * What goes on a chip.
 *
 * The six failures on a red pull request here are three or four `e2e-test (...)` jobs whose names
 * differ only inside the parentheses - `(admin, @adminUser, @explorer2)` against `(admin,
 * @adminUser, @navigation)` - so six chips each holding the first 24 characters of a name are six
 * chips reading `e2e-test (admin, @adminUs`, and no way to tell which one you are reading. The
 * parenthesised part is the whole of what distinguishes them; the full name is in the head above
 * and on the chip's own title.
 */
function shortName(name: string): string {
  const open = name.indexOf('(');
  const inner = open > 0 ? name.slice(open + 1).replace(/\)\s*$/, '').trim() : '';

  return inner || name;
}

/** The surface only draws output where there is a check that can have any. */
const asOutput = computed(() => props.surface && Boolean(picked.value));
</script>

<template>
  <section class="cl" :class="{ 'cl--surface': surface }">
    <SectionHead
      :label="asOutput ? 'Why it is failing' : 'Failing checks'"
      icon="cross"
      :count="count()"
    >
      <!-- The full name of the check being read, which the chip below has room only for the end
           of. Clipped from the start: `e2e-test (` is the same on every one of them. -->
      <code v-if="asOutput && picked" class="cl__who" :title="picked.name">{{ picked.name }}</code>

      <a
        v-if="asOutput && picked?.url"
        class="cl__run"
        :href="picked.url"
        target="_blank"
        rel="noopener"
        :title="`Open ${ picked.name } on GitHub`"
      >
        Open the run
        <AppIcon name="arrow-right" :size="12" />
      </a>
    </SectionHead>

    <template v-if="asOutput">
      <!--
        Which of them you are reading. Omitted for a single failure, because a picker between one
        thing is 32px of the body spent saying nothing.
      -->
      <nav v-if="checks.length > 1" class="cl__pick u-fade-x" aria-label="The failing checks">
        <button
          v-for="(check, n) in checks"
          :key="check.name"
          type="button"
          class="cl__chip"
          :class="{ 'cl__chip--on': n === pickedAt, 'cl__chip--quiet': !check.id }"
          :title="check.id ? check.name : `${ check.name } — a status rather than a job, with no output to read here`"
          :aria-pressed="n === pickedAt ? 'true' : 'false'"
          @click="pick(n)"
        >
          <span class="cl__chip-text">{{ shortName(check.name) }}</span>
        </button>
      </nav>

      <!--
        The output. One scroller, with everything in it pinned: a flex child in a bounded column
        shrinks below its content by default, and the annotation block drawing over the code is
        the one bug every surface in this view has had.
      -->
      <div class="cl__out u-fade-y">
        <p v-if="said" class="cl__said">{{ said }}</p>

        <div v-if="notes.length" class="cl__notes">
          <p v-for="(note, n) in notes" :key="n" class="cl__note">
            <code v-if="note.path" class="cl__at">{{ note.path }}{{ note.line ? `:${ note.line }` : '' }}</code>
            <span class="cl__msg">{{ note.message }}</span>
          </p>

          <button v-if="notesHidden" type="button" class="cl__more" @click="notesOpen = true">
            <AppIcon name="chevron-down" :size="12" />
            and {{ notesHidden }} more
          </button>
        </div>

        <!--
          The lines themselves, through the one component that draws lines. `expandable` puts the
          way out at the end of the excerpt, which is where every other hunk in this view puts it.
        -->
        <CodeView
          v-if="rows.length"
          :rows="rows"
          :label="where"
          :expandable="Boolean(shown && shown.lines > rows.length)"
          expand-label="See the whole log"
          @expand="whole = true"
        />

        <p v-else-if="reading" class="cl__note cl__note--quiet">Reading what it printed…</p>
        <p v-else-if="failed" class="cl__note cl__note--bad">{{ failed }}</p>
        <!-- No job, so no log: a status context's `summary` is the whole of what it said. -->
        <p v-else-if="shown?.summary" class="cl__sum">{{ shown.summary }}</p>
        <p v-else-if="!picked?.id" class="cl__note cl__note--quiet">
          This one is a status rather than a job, so there is nothing it printed. Open the run to see it.
        </p>
        <p v-else class="cl__note cl__note--quiet">This check kept no log. Open the run to see what it did.</p>
      </div>
    </template>

    <!-- Or the names: the popover, and the surface on a build whose failures have no output. -->
    <div v-else class="cl__list" :class="{ 'u-fade-y': surface }">
      <component
        :is="check.url ? 'a' : 'div'"
        v-for="check in checks"
        :key="check.name"
        class="cl__row"
        :href="check.url || undefined"
        :target="check.url ? '_blank' : undefined"
        :rel="check.url ? 'noopener' : undefined"
      >
        <span class="cl__name">{{ check.name }}</span>
        <AppIcon v-if="check.url" name="arrow-right" :size="12" class="cl__go" />
        <span v-if="check.detail" class="cl__why">{{ check.detail }}</span>
      </component>
    </div>

    <!-- All of it, over the card, opened on the line the excerpt was marked at. -->
    <FileModal
      v-if="whole && picked"
      :path="picked.name"
      :at="shown?.jobId ? `job ${ shown.jobId }` : 'the job log'"
      :mark="mark"
      :load="readWholeLog"
      @close="whole = false"
    />
  </section>
</template>

<style scoped>
.cl {
  display: flex;
  flex-direction: column;
  gap: var(--s2);
  min-width: 0;
  min-height: 0;
}

/* As a surface it takes the room it is given; see the budget on `.card__body`. */
.cl--surface { flex: 1 1 auto; }

/* ── The head ────────────────────────────────────────────────────────────── */

/*
 * The name of the check being read, clipped from its end.
 *
 * `direction: rtl` is what ChangeSet does to a path and it must not be done here: a check name
 * ends `@explorer2)`, and a neutral character at the end of an RTL paragraph takes the
 * paragraph's direction - so the closing parenthesis is laid out at the *left* end of the line
 * and the name reads `)e2e-test (admin, @adminUser, @explorer2`. A path has no such character,
 * which is why `.cv__label--path` in CodeView gates the same trick on there being a slash.
 *
 * Nothing is lost by clipping the ordinary way: the end of the name is the chip's label below
 * (see `shortName`), so between them the whole of it is on the card either way.
 */
.cl__who {
  min-width: 0;
  overflow: hidden;
  color: var(--text);
  font-family: var(--mono);
  font-size: var(--t-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/*
 * The way out to GitHub, which the rows used to carry one each.
 *
 * In the pane the rows pick which output to read, so the link has to be somewhere else and the
 * head is where it belongs: one link, to the run of whatever is being read, rather than six.
 * 30px because it is pressed, which makes the head 30px on this surface - see `min-height` in
 * SectionHead, which is a floor for exactly this.
 */
.cl__run {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  gap: var(--s1);
  min-height: 30px;
  padding: 0 var(--s2);
  border-radius: var(--r-pill);
  color: var(--text-muted);
  font-size: var(--t-xs);
  text-decoration: none;
  cursor: pointer;
}

.cl__run:hover { background: var(--surface-raised); color: var(--text); }

/* ── Which one you are reading ───────────────────────────────────────────── */

/*
 * A strip, not a column.
 *
 * ChangeSet's note on its own file tree is the argument against this shape and it is an argument
 * about 157 files, not six checks: a sideways strip of 157 chips shows three of them. The reason
 * it is right here is the other side of that measurement - a 180px name column would leave the
 * code pane 540px, and a stack frame is 80 to 120 characters, so every line of every trace would
 * wrap. Six chips cost 32px once; wrapped traces cost half the pane's lines forever.
 *
 * The `--s5` of right padding is the debt `u-fade-x` owes; see design/focus.css. The scrollbar is
 * hidden because an 8px track under a 30px row is a quarter of the row, and the fade already says
 * there is more.
 */
.cl__pick {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  gap: var(--s2);
  height: var(--control-h);
  padding: 0 var(--s5) 0 0;
  min-width: 0;
  overflow: auto hidden;
  touch-action: pan-x;
  scrollbar-width: none;
}

.cl__pick::-webkit-scrollbar { height: 0; }

.cl__chip {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  max-width: 260px;
  min-height: 30px;
  padding: 0 var(--s3);
  border: 1px solid var(--border);
  border-radius: var(--r-pill);
  background: none;
  color: var(--text-muted);
  font: inherit;
  font-family: var(--mono);
  font-size: var(--t-xs);
  cursor: pointer;
  transition: background var(--fast), color var(--fast), border-color var(--fast);
}

/*
 * The text is a child, not the button's own text node: `text-overflow` does nothing to the bare
 * text of a flex container, which is how a chip ends up 400px wide and pushes the strip out.
 */
.cl__chip-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cl__chip:hover { border-color: var(--border-strong); color: var(--text); }

.cl__chip--on {
  border-color: color-mix(in srgb, var(--danger) 45%, transparent);
  background: color-mix(in srgb, var(--danger) 12%, transparent);
  color: var(--danger);
}

/* A status rather than a job: pressable, and all it can say is that it has nothing to show. */
.cl__chip--quiet { color: var(--text-faint); }

/* ── What it printed ─────────────────────────────────────────────────────── */

.cl__out {
  display: flex;
  flex-direction: column;
  gap: var(--s2);
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  /* The fade's own room; see `.u-fade-y` in design/focus.css. */
  padding: 0 var(--s2) var(--s5) 0;
  overflow: hidden auto;
  touch-action: pan-y;
  /*
   * Inside the failure pane the hue is the failure's.
   *
   * CodeView marks a row with `var(--kind, var(--accent))`, and `--kind` on a red-pr card is
   * `--kind-signal` - a pale blue - so the assertion that broke the build would have been marked
   * in the same colour the card uses for everything else. Set here rather than in CodeView
   * because a marked row in a diff means "the lines you asked about", which is not a failure.
   */
  --kind: var(--danger);
}

/* Never squeezed, for the reason the rows below give. */
.cl__out > * { flex: 0 0 auto; }

.cl__said {
  color: var(--text);
  font-size: var(--t-sm);
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.cl__notes { display: flex; flex-direction: column; gap: var(--s1); }

.cl__note {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--s2);
  color: var(--text-dim);
  font-size: var(--t-xs);
  line-height: 1.45;
}

/* Where it broke, in the colour of the thing that broke. */
.cl__at { flex: 0 0 auto; color: var(--danger); font-family: var(--mono); font-size: var(--t-xs); }
.cl__msg { min-width: 0; overflow-wrap: anywhere; }
.cl__note--quiet { color: var(--text-muted); font-size: var(--t-sm); }
.cl__note--bad { color: var(--danger); font-size: var(--t-sm); }

.cl__more {
  display: inline-flex;
  align-items: center;
  align-self: flex-start;
  gap: var(--s1);
  min-height: 30px;
  padding: 0 var(--s2);
  border: 0;
  border-radius: var(--r-sm);
  background: none;
  color: var(--text-muted);
  font: inherit;
  font-size: var(--t-xs);
  cursor: pointer;
}

.cl__more:hover { background: var(--surface-raised); color: var(--text); }

/*
 * A check with no log, which is what a status context is: its own body, fixed-width because half
 * of what lands here is a runner's output rather than prose and a reflowed table is unreadable.
 */
.cl__sum {
  color: var(--text-dim);
  font-family: var(--mono);
  font-size: var(--t-xs);
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* ── The names, for the popover ──────────────────────────────────────────── */

.cl__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 0;
  min-width: 0;
}

/* Scrolled rather than squeezed, and faded at the cut: six rows of two lines do not fit 276px. */
.cl--surface .cl__list {
  flex: 1 1 auto;
  /* The fade's own room; see `.u-fade-y` in design/focus.css. */
  padding: 0 var(--s2) var(--s5) 0;
  overflow: hidden auto;
}

/*
 * Never squeezed - the one bug this view has had in five costumes. A flex item in a bounded
 * column shrinks below its content by default, so a two-line row draws over the row beneath it.
 */
.cl__row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: baseline;
  flex: 0 0 auto;
  gap: 2px var(--s2);
  min-height: 30px;
  padding: var(--s2);
  border-radius: var(--r-sm);
  color: var(--text-dim);
  text-decoration: none;
}

a.cl__row { cursor: pointer; }
a.cl__row:hover { background: var(--surface-raised); color: var(--text); }

.cl__name {
  font-family: var(--mono);
  font-size: var(--t-xs);
  overflow-wrap: anywhere;
}

/* What it reported, which is the half that says whether it is yours. */
.cl__why {
  grid-column: 1 / -1;
  color: var(--text-faint);
  font-size: var(--t-xs);
  line-height: 1.45;
}

.cl__go { flex: 0 0 auto; color: var(--text-faint); }
</style>
