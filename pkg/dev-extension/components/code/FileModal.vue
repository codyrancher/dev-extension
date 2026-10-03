<script setup lang="ts">
/**
 * The whole file, opened on the lines you were reading.
 *
 * A hunk is six lines either side of a change, and the question it raises most often is what the
 * rest of it looks like - whether the thing being called is defined above, whether the branch
 * being removed is the only one. Going and finding out meant leaving for GitHub, and coming back
 * to a deck that had moved on.
 *
 * So the run that was on screen stays marked, the file opens scrolled to it, and the same
 * renderer draws it as drew the hunk - so the lines are in the same places, the same colours,
 * the same width. See CodeView.
 *
 * The text is fetched by the caller rather than here: this component has no idea whether a file
 * comes from a pull request at a ref, a workspace checkout, or a pod. `load` is called when it
 * opens and its result is drawn; a failure is said rather than left as an empty frame.
 */
import {
  onBeforeUnmount, onMounted, nextTick, ref, watch
} from 'vue';
import CodeView from './CodeView.vue';
import AppIcon from '../focus/AppIcon.vue';
import { fromText } from './rows';
import type { CodeRow } from './rows';
import { holdOverlay, releaseOverlay } from '../focus/overlay';

const props = defineProps<{
  path: string;
  /** Fetches the file's text. Called once when this opens. */
  load: () => Promise<string>;
  /** The run to mark and scroll to, by line number, inclusive. */
  mark?: [number, number] | null;
  /** A word about where the file is from: a ref, a branch, a pod. */
  at?: string;
}>();

const emit = defineEmits<{ (e: 'close'): void }>();

const rows = ref<CodeRow[]>([]);
const error = ref('');
const busy = ref(true);
const scroller = ref<HTMLElement | null>(null);

async function read() {
  busy.value = true;
  error.value = '';
  try {
    rows.value = fromText(await props.load(), props.path);
  } catch (e) {
    error.value = (e as Error)?.message || String(e);
  } finally {
    busy.value = false;
  }
  await nextTick();
  show();
}

/**
 * Put the marked run a third of the way down rather than at the top.
 *
 * What you want to see is what is around it, and a run pinned to the top edge has its context
 * only below it.
 */
function show() {
  const box = scroller.value;
  const line = props.mark?.[0];

  if (!box || !line) {
    return;
  }
  const row = box.querySelector(`.cv__row--first`) as HTMLElement | null;

  if (row) {
    box.scrollTop = Math.max(0, row.offsetTop - box.clientHeight / 3);
  }
}

function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.stopPropagation();
    emit('close');
  }
}

onMounted(() => {
  holdOverlay();
  window.addEventListener('keydown', onKey, true);
  read();
});

onBeforeUnmount(() => {
  releaseOverlay();
  window.removeEventListener('keydown', onKey, true);
});

watch(() => [props.path, props.mark?.[0]], read);
</script>

<template>
  <!-- Teleported and carrying the view's class: the deck transforms every card it holds, and a
       fixed child of a transform is fixed to the transform. See FocusModal. -->
  <Teleport to="body">
    <div class="dev-focus file-layer">
      <div class="file-veil" @click="emit('close')" />

      <div class="file" role="dialog" :aria-label="path">
        <header class="file__head">
          <code class="file__path">{{ path }}</code>
          <span v-if="at" class="file__at">{{ at }}</span>
          <span v-if="mark" class="file__mark">
            {{ mark[0] === mark[1] ? `line ${ mark[0] }` : `lines ${ mark[0] }–${ mark[1] }` }}
          </span>
          <button type="button" class="file__close" aria-label="Close" @click="emit('close')">
            <AppIcon name="cross" :size="15" />
          </button>
        </header>

        <div ref="scroller" class="file__body">
          <p v-if="busy" class="file__note">Reading {{ path }}…</p>
          <p v-else-if="error" class="file__note file__note--bad">{{ error }}</p>
          <CodeView
            v-else
            :rows="rows"
            :mark-lines="mark || null"
            :label="''"
          />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.file-layer { position: fixed; inset: 0; z-index: 70; }

.file-veil {
  position: fixed;
  inset: 0;
  background: rgba(6, 8, 14, 0.62);
  backdrop-filter: blur(4px);
}

.file {
  position: fixed;
  top: 50%;
  left: 50%;
  display: flex;
  flex-direction: column;
  width: min(1180px, 94vw);
  height: min(860px, 88vh);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-xl);
  background: var(--surface);
  box-shadow: var(--shadow-3);
  overflow: hidden;
  transform: translate(-50%, -50%);
}

.file__head {
  display: flex;
  align-items: center;
  gap: var(--s3);
  flex: 0 0 auto;
  padding: var(--s3) var(--s4);
  border-bottom: 1px solid var(--border);
  background: var(--surface-sunk);
}

.file__path {
  min-width: 0;
  overflow: hidden;
  color: var(--text);
  font-family: var(--mono);
  font-size: var(--t-sm);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file__at,
.file__mark { flex: 0 0 auto; color: var(--text-faint); font-size: var(--t-xs); }
.file__mark { color: var(--accent); }

.file__close {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 30px;
  height: 30px;
  margin-left: auto;
  border: 1px solid var(--border);
  border-radius: var(--r-pill);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}

.file__close:hover { border-color: var(--border-strong); color: var(--text); }

.file__body {
  flex: 1 1 auto;
  min-height: 0;
  padding: var(--s3);
  overflow: auto;
}

.file__note { margin: 0; padding: var(--s5); color: var(--text-muted); font-size: var(--t-sm); }
.file__note--bad { color: var(--danger); }
</style>
