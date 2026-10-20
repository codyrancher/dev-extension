<script setup lang="ts">
/**
 * What a button sends, shown and editable, for every button that sets an agent working.
 *
 * Middle-clicking one of those buttons opens this. It was written for the workspace rail and
 * lived inside it; Focus has the same buttons and had no way to see what they send, so it is a
 * component now and the two places differ only in what they hand it.
 *
 * Deliberately knows nothing about *how* a prompt is stored or expanded. The two callers do not
 * agree on either: the rail writes `{{ name }}` and expands against a workspace, the deck writes
 * `{name}` and expands against the card's own item. So the dialect arrives as `token` and
 * `expand`, and saving is the host's - this owns the draft, the preview and the warnings, which
 * is the part that was worth not writing twice.
 */
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';

export interface EditorVar { name: string; value: string; about: string }

const props = withDefaults(defineProps<{
  /** The button's own name, for the title. */
  label: string;
  /** What it sends now: the shipped prompt, or the saved one if this button has been edited. */
  template: string;
  /** What it shipped with, so "edited" is a fact rather than a guess and reset has a target. */
  shipped: string;
  vars: EditorVar[];
  /** How this caller writes a variable - `{{ name }}` in the rail, `{name}` in the deck. */
  token: (name: string) => string;
  /** How this caller fills them in, for the preview. */
  expand: (template: string, vars: EditorVar[]) => string;
  /** The skill the prompt invokes, when it invokes one. */
  skill?: string;
  skillContent?: string;
  skillOverridden?: boolean;
  /** '', 'send', 'save' or 'reset' while one is in flight. */
  busy?: string;
  error?: string;
}>(), {
  skill: '', skillContent: '', skillOverridden: false, busy: '', error: '',
});

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'send', text: string): void;
  (e: 'save', text: string): void;
  (e: 'reset'): void;
  (e: 'save-skill', text: string, commit: boolean): void;
}>();

const draft = ref(props.template);
const skillDraft = ref(props.skillContent);
const boxEl = ref<HTMLTextAreaElement | null>(null);

watch(() => props.template, (next) => { draft.value = next; });
watch(() => props.skillContent, (next) => { skillDraft.value = next; });

const edited = computed(() => draft.value !== props.shipped);
const changed = computed(() => draft.value !== props.template);

/** Which variables this prompt actually uses, so the table says which of them matter. */
const used = computed(() => new Set(props.vars.filter((v) => draft.value.includes(props.token(v.name))).map((v) => v.name)));

/**
 * Tokens written in this dialect that name nothing.
 *
 * The failure this catches is silent and total: `{worksapce}` is not an error anywhere, it is
 * simply never substituted, and the agent is handed the word `{worksapce}` to make sense of.
 * Nothing between writing it and reading the transcript would tell you. The preview below shows
 * it too, but only if you read the preview looking for it; this says it.
 *
 * Built from the dialect rather than from a regex of our own: `token` is the only thing here
 * that knows what one looks like, so the names are the known ones and the shape is whatever is
 * left matching that shape once they are taken out.
 */
const unknown = computed(() => {
  const shape = props.token('\u0000').split('\u0000');

  if (shape.length !== 2 || !shape[0]) {
    return [];
  }
  const pattern = new RegExp(`${ shape[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }\\s*(\\w+)\\s*${ shape[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }`, 'g');
  const known = new Set(props.vars.map((v) => v.name));

  return [...new Set([...draft.value.matchAll(pattern)].map((m) => m[1]).filter((name) => !known.has(name)))];
});

/**
 * The draft cut into what is literal and what is a variable, scanned once.
 *
 * Two things read it. The box shows where a token *is*; the preview shows what it *became*. They
 * were a plain string each, so the one question this dialog exists to answer - which words got
 * replaced - had to be answered by eye, comparing two blocks of text line by line.
 *
 * Built from `token`, which is the only thing here that knows the dialect, so it marks exactly
 * the names the host will substitute and nothing that merely looks like one.
 */
const segments = computed<{ text: string; name: string; value: string }[]>(() => {
  const shape = props.token('\u0000').split('\u0000');
  const text = draft.value;

  if (shape.length !== 2) {
    return [{ text, name: '', value: '' }];
  }
  const out: { text: string; name: string; value: string }[] = [];
  let at = 0;

  while (at < text.length) {
    // The earliest known token from here, so `{what}` before `{workspace}` whatever order the
    // list is in.
    let best = -1;
    let found: { name: string; value: string } | null = null;

    for (const v of props.vars) {
      const i = text.indexOf(props.token(v.name), at);

      if (i >= 0 && (best < 0 || i < best)) {
        best = i;
        found = { name: v.name, value: v.value };
      }
    }
    if (best < 0 || !found) {
      out.push({ text: text.slice(at), name: '', value: '' });
      break;
    }
    if (best > at) {
      out.push({ text: text.slice(at, best), name: '', value: '' });
    }
    out.push({ text: props.token(found.name), name: found.name, value: found.value });
    at = best + props.token(found.name).length;
  }

  return out;
});

const preview = computed(() => props.expand(draft.value, props.vars));

/* The box and its ghost scroll as one; the ghost is what paints the token's background. */
const ghost = ref<HTMLElement | null>(null);

function syncGhost(): void {
  const box = boxEl.value;

  if (box && ghost.value) {
    ghost.value.scrollTop = box.scrollTop;
    ghost.value.scrollLeft = box.scrollLeft;
  }
}

/** Put a variable where the cursor is, rather than at the end of whatever was typed. */
function insert(name: string) {
  const el = boxEl.value;
  const text = props.token(name);

  if (!el) {
    draft.value += text;

    return;
  }
  const at = el.selectionStart ?? draft.value.length;
  const to = el.selectionEnd ?? at;

  draft.value = draft.value.slice(0, at) + text + draft.value.slice(to);
  requestAnimationFrame(() => {
    el.focus();
    el.setSelectionRange(at + text.length, at + text.length);
  });
}

/*
 * Escape closes and Cmd/Ctrl+Enter sends, because this is a box you type in and both are what
 * a box you type in does. On the window: the modal around this is the host's, and the two
 * callers do not use the same one.
 */
function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    emit('close');
  }
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && draft.value.trim()) {
    emit('send', draft.value);
  }
}

onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <div class="pe">
    <p v-if="error" class="pe__error">{{ error }}</p>

    <section class="pe__section">
      <h4 class="pe__title">
        The prompt
        <span v-if="edited" class="pe__tag">edited here</span>
      </h4>
      <!--
        The box, with a ghost behind it that paints the tokens.
        
        A textarea cannot colour part of its own text, so the usual arrangement: a block with
        the same metrics sits underneath holding the same string, its characters invisible and
        only the token spans given a background; the real textarea lies on top, transparent,
        so what you see and what you edit are the same glyphs in the same places. The two
        scroll together - see `syncGhost` - because a ghost that does not follow is worse than
        no highlight at all.
      -->
      <div class="pe__box-wrap">
        <div ref="ghost" class="pe__ghost" aria-hidden="true"><span
          v-for="(part, n) in segments"
          :key="n"
          :class="{ 'pe__ghost-hit': part.name }"
        >{{ part.text }}</span><span>&#8203;</span></div>
        <textarea
          ref="boxEl"
          v-model="draft"
          class="pe__box"
          spellcheck="false"
          @scroll="syncGhost"
          @input="syncGhost"
        />
      </div>

      <!-- The one mistake this editor can catch: a name that will never be filled in. -->
      <p v-if="unknown.length" class="pe__warn">
        {{ unknown.map((name) => token(name)).join(', ') }}
        {{ unknown.length === 1 ? 'matches no variable' : 'match no variables' }}, so
        {{ unknown.length === 1 ? 'it is' : 'they are' }} sent as written.
      </p>

      <h4 class="pe__title">What goes in</h4>
      <table class="pe__vars">
        <tbody>
          <tr v-for="v in vars" :key="v.name" :class="{ 'pe__row--on': used.has(v.name) }">
            <td>
              <button type="button" class="pe__var" title="Put this where the cursor is" @click="insert(v.name)">
                {{ token(v.name) }}
              </button>
            </td>
            <td class="pe__value">{{ v.value || '—' }}</td>
            <td class="pe__about">{{ v.about }}</td>
          </tr>
        </tbody>
      </table>

      <h4 class="pe__title">As it will be sent</h4>
      <!-- The same marking, on the other side of the substitution: what each token became. -->
      <pre class="pe__preview"><template
        v-for="(part, n) in segments"
        :key="n"
      ><span v-if="part.name" class="pe__hit">{{ part.value || '—' }}</span><template v-else>{{ part.text }}</template></template></pre>

      <div class="pe__buttons">
        <button type="button" class="pe__btn pe__btn--go" :disabled="!!busy || !draft.trim()" @click="emit('send', draft)">
          {{ busy === 'send' ? 'Sending…' : 'Send this now' }}
        </button>
        <button type="button" class="pe__btn" :disabled="!!busy || !changed" @click="emit('save', draft)">
          {{ busy === 'save' ? 'Saving…' : 'Save as what this button sends' }}
        </button>
        <button v-if="template !== shipped" type="button" class="pe__btn pe__btn--quiet" :disabled="!!busy" @click="emit('reset')">
          {{ busy === 'reset' ? 'Resetting…' : 'Back to the shipped prompt' }}
        </button>
      </div>
      <p class="pe__hint">Cmd/Ctrl + Enter sends. Escape closes. Saving holds for every workspace and everyone who opens one.</p>
    </section>

    <section v-if="skill" class="pe__section">
      <h4 class="pe__title">
        {{ skill }}/SKILL.md
        <span v-if="skillOverridden" class="pe__tag">edited here</span>
      </h4>
      <textarea v-model="skillDraft" class="pe__box pe__box--tall" spellcheck="false" />
      <div class="pe__buttons">
        <button type="button" class="pe__btn" :disabled="!!busy || skillDraft === skillContent" @click="emit('save-skill', skillDraft, false)">
          Save to all workspaces
        </button>
        <button type="button" class="pe__btn pe__btn--go" :disabled="!!busy || skillDraft === skillContent" @click="emit('save-skill', skillDraft, true)">
          Save and commit
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
/*
 * One palette, named here and mapped per place.
 *
 * This started out reading the rail's tokens directly with literal fallbacks, which looked
 * right in the rail and wrong everywhere else: inside Focus none of those names exist, so
 * every fallback applied at once and the dialog came out in Rancher blue on greys that belong
 * to neither design - against a card view that is purple on near-black.
 *
 * Fallbacks cannot fix that, because they answer "is this name defined" and the question is
 * "which design system am I in". So the names are mapped off the ancestor that settles it:
 * Focus puts its tokens on `.dev-focus`, and this dialog is teleported inside it.
 */
.pe {
  --pe-text: var(--body-text, #d8dee9);
  --pe-muted: var(--muted-text, #8a9099);
  --pe-faint: var(--muted-text, #8a9099);
  --pe-line: var(--border, #3d4450);
  --pe-sunk: var(--input-bg, #1b1c21);
  --pe-accent: var(--primary, #3d98d3);
  /* The rail fills its primary. See the Focus block for why this is a token and not a colour. */
  --pe-go-bg: var(--primary, #3d98d3);
  --pe-go-ink: #fff;
  --pe-wash: color-mix(in srgb, var(--primary, #3d98d3) 16%, transparent);
  --pe-warn: var(--warning, #d29922);
  --pe-error: var(--error, #f85149);
  /* A control outside the deck; inside it, the surface step below. See design/tokens.css. */
  --pe-radius: var(--dev-r-ctl);
  --pe-mono: var(--mono, monospace);

  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

/* The deck's own palette, where this dialog is drawn over a card rather than beside a rail. */
:global(.dev-focus) .pe {
  --pe-text: var(--text);
  --pe-muted: var(--text-muted);
  --pe-faint: var(--text-faint);
  --pe-line: var(--border);
  --pe-sunk: var(--ground-deep);
  --pe-accent: var(--accent);
  /*
   * Not a solid fill of it.
   *
   * `--accent` is #5b8cff, and the deck spends it on a ring, a link, an underline - never on a
   * 120px block of colour. Filled, one button was the brightest thing on a dark card by a
   * wide margin, which is the "blinding" part; the hue was never the problem. So in here the
   * primary is the wash with accent ink, which is how every other control in this view marks
   * itself as the one that is on.
   */
  --pe-go-bg: var(--accent-wash);
  --pe-go-ink: var(--accent);
  --pe-wash: var(--accent-wash);
  --pe-warn: var(--warning);
  --pe-error: var(--danger);
  --pe-radius: var(--r-sm);
  --pe-mono: var(--mono);
}
.pe__section { display: flex; flex-direction: column; gap: 8px; min-width: 0; }

.pe__title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  color: var(--pe-text);
  font-size: 13px;
  font-weight: 600;
}

/* The same restraint as the button: a wash with accent ink, not a block of accent. */
.pe__tag {
  padding: 1px 6px;
  border: 1px solid var(--pe-accent);
  border-radius: var(--r-pill);
  background: var(--pe-wash);
  color: var(--pe-accent);
  font-size: 10px;
  font-weight: 500;
}

/*
 * The box and its ghost, stacked.
 *
 * Every metric that decides where a glyph lands is declared once, on this wrapper, and
 * inherited by both children: font, size, line height, and the wrapping rules. The two drift
 * apart the moment one of them is set on only one, and a drifting highlight is worse than
 * none - it marks the wrong words.
 */
.pe__box-wrap {
  position: relative;
  min-height: 120px;
  font-family: var(--pe-mono);
  font-size: 12px;
  line-height: 1.5;
}

.pe__ghost,
.pe__box {
  /* One box, one set of metrics. `border` counts: it moves the text inside by its width. */
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  min-height: 120px;
  margin: 0;
  padding: 8px;
  border: 1px solid transparent;
  font: inherit;
  white-space: pre-wrap;
  overflow-wrap: break-word;
}

/* Behind, painting only the tokens: its own characters are never seen. */
.pe__ghost {
  position: absolute;
  inset: 0;
  overflow: hidden;
  border-radius: var(--dev-r-ctl);
  color: transparent;
  pointer-events: none;
}

.pe__ghost-hit {
  border-radius: var(--dev-r-xs);
  background: var(--pe-wash);
  box-shadow: 0 0 0 1px var(--pe-accent) inset;
}

.pe__box {
  position: relative;
  /* Transparent, so the ghost's marks show through under the real glyphs. */
  background: transparent;
  border-color: var(--pe-line);
  border-radius: var(--pe-radius);
  color: var(--pe-text);
  resize: vertical;
}

/* The ground is on the wrapper, so it sits under both. */
.pe__box-wrap { background: var(--pe-sunk); border-radius: var(--pe-radius); }

/* The skill's box is a plain one: no tokens in it, so no ghost and its own ground. */
.pe__box--tall {
  min-height: 220px;
  border: 1px solid var(--pe-line);
  background: var(--pe-sunk);
}

.pe__error,
.pe__warn {
  margin: 0;
  padding: 6px 8px;
  border-radius: var(--pe-radius);
  font-size: 12px;
}

.pe__error { background: color-mix(in srgb, var(--pe-error) 14%, transparent); color: var(--pe-error); }
.pe__warn { background: color-mix(in srgb, var(--pe-warn) 14%, transparent); color: var(--pe-warn); }

.pe__vars { width: 100%; border-collapse: collapse; font-size: 12px; }
.pe__vars td { padding: 3px 8px 3px 0; vertical-align: top; }

/* The ones this prompt actually uses, so the table reads as a checklist rather than a glossary. */
.pe__row--on .pe__var { border-color: var(--pe-accent); color: var(--pe-accent); }

.pe__var {
  padding: 1px 6px;
  border: 1px solid var(--pe-line);
  border-radius: var(--pe-radius);
  background: none;
  color: var(--pe-muted);
  font-family: var(--pe-mono);
  font-size: 11px;
  white-space: nowrap;
  cursor: pointer;
}

.pe__var:hover { border-color: var(--pe-accent); color: var(--pe-accent); }
.pe__value { color: var(--pe-text); word-break: break-word; }
.pe__about { color: var(--pe-muted); }

.pe__preview {
  max-height: 180px;
  margin: 0;
  padding: 8px;
  overflow: auto;
  border: 1px solid var(--pe-line);
  border-radius: var(--pe-radius);
  background: var(--pe-sunk);
  color: var(--pe-text);
  font-family: var(--pe-mono);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}

/* What a token became, marked the way the token itself is. */
.pe__hit {
  border-radius: var(--dev-r-xs);
  padding: 0 2px;
  background: var(--pe-wash);
  box-shadow: 0 0 0 1px var(--pe-accent) inset;
  color: var(--pe-text);
}

.pe__buttons { display: flex; flex-wrap: wrap; gap: 8px; }

.pe__btn {
  padding: 6px 12px;
  border: 1px solid var(--pe-line);
  border-radius: var(--pe-radius);
  background: none;
  color: var(--pe-text);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.pe__btn:hover:not(:disabled) { border-color: var(--pe-accent); }
.pe__btn:disabled { opacity: 0.45; cursor: default; }
.pe__btn--go { border-color: var(--pe-accent); background: var(--pe-go-bg); color: var(--pe-go-ink); }
.pe__btn--quiet { color: var(--pe-muted); }
.pe__hint { margin: 0; color: var(--pe-muted); font-size: 11px; }
</style>
