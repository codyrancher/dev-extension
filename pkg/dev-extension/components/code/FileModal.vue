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
 * renderer draws it as drew the hunk - the same places, the same colours, the same width. The
 * change's own additions and deletions keep their colours too (see `patch`): a whole file in one
 * flat colour loses the thing you opened it to put in context.
 *
 * The text is fetched by the caller rather than here: this component has no idea whether a file
 * comes from a pull request at a ref, a workspace checkout, or a pod. `load` is called when it
 * opens and its result is drawn; a failure is said rather than left as an empty frame.
 */
import {
  onMounted, nextTick, ref, watch
} from 'vue';
import CodeView from './CodeView.vue';
import DevModal from '../DevModal.vue';
import { fromText, fromFileWithPatch } from './rows';
import type { CodeRow } from './rows';

const props = defineProps<{
  path: string;
  /**
   * Fetches the file, and the patch that colours it.
   *
   * One call returning both, rather than the text here and the patch through a prop: the patch is
   * usually discovered while fetching the text, and a prop that arrives mid-await is a race over
   * whether this draws the file in colour or in grey. Returning a bare string still works for a
   * caller that has no patch.
   */
  load: () => Promise<string | { text: string; patch?: string }>;
  /** The run to mark and scroll to, by line number, inclusive. */
  mark?: [number, number] | null;
  /**
   * This change's patch for the file, so the whole file keeps its diff colours.
   *
   * Without it the file is drawn as plain text - every line the same - and the lines you opened it
   * to see in context are the ones you can no longer pick out.
   */
  patch?: string;
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
    const got = await props.load();
    const text = typeof got === 'string' ? got : got.text;
    const patch = (typeof got === 'string' ? '' : got.patch) || props.patch || '';

    rows.value = patch ? fromFileWithPatch(text, patch, props.path) : fromText(text, props.path);
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

onMounted(read);

watch(() => [props.path, props.mark?.[0]], read);
</script>

<template>
  <!-- DevModal, the one dialog: the veil, the teleport out of the deck's transform, Escape and
       the phone's full screen are its. -->
  <DevModal
    focus
    size="large"
    :title="path"
    @close="emit('close')"
  >
    <template #title>
      <code class="file__path">{{ path }}</code>
    </template>
    <template
      v-if="at || mark"
      #head
    >
      <span v-if="at" class="file__at">{{ at }}</span>
      <span v-if="mark" class="file__mark">
        {{ mark[0] === mark[1] ? `line ${ mark[0] }` : `lines ${ mark[0] }–${ mark[1] }` }}
      </span>
    </template>

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
  </DevModal>
</template>

<style scoped>
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
.file__mark { flex: 0 0 auto; color: var(--text-faint); font-size: var(--t-xs); font-weight: 400; white-space: nowrap; }
.file__mark { color: var(--accent); }

.file__body {
  flex: 1 1 auto;
  min-height: 0;
  padding: var(--s3);
  overflow: auto;
}

.file__note { margin: 0; padding: var(--s5); color: var(--text-muted); font-size: var(--t-sm); }
.file__note--bad { color: var(--danger); }
</style>
