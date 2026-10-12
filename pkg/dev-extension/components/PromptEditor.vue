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
const box = ref<HTMLTextAreaElement | null>(null);

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

const preview = computed(() => props.expand(draft.value, props.vars));

/** Put a variable where the cursor is, rather than at the end of whatever was typed. */
function insert(name: string) {
  const el = box.value;
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
      <textarea
        ref="box"
        v-model="draft"
        class="pe__box"
        spellcheck="false"
      />

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
      <pre class="pe__preview">{{ preview }}</pre>

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
  --pe-warn: var(--warning, #d29922);
  --pe-error: var(--error, #f85149);
  --pe-radius: 4px;
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

.pe__tag {
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--pe-accent);
  color: var(--ink-on-kind, #fff);
  font-size: 10px;
  font-weight: 500;
}

.pe__box {
  width: 100%;
  min-height: 120px;
  padding: 8px;
  border: 1px solid var(--pe-line);
  border-radius: var(--pe-radius);
  background: var(--pe-sunk);
  color: var(--pe-text);
  font-family: var(--pe-mono);
  font-size: 12px;
  line-height: 1.5;
  resize: vertical;
}

.pe__box--tall { min-height: 220px; }

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
.pe__btn--go { border-color: var(--pe-accent); background: var(--pe-accent); color: var(--ink-on-kind, #fff); }
.pe__btn--quiet { color: var(--pe-muted); }
.pe__hint { margin: 0; color: var(--pe-muted); font-size: 11px; }
</style>
