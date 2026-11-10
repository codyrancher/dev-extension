<script setup lang="ts">
/**
 * One run of an automation: how it went, and everything it said.
 *
 * A script's is its output, tailed live while it runs - stdout and stderr together, as the
 * wrapper wrote them - with the script and the event it was given below. An agent's is its
 * conversation, the same chat the drawer shows, with the prompt it opened with; its result is the
 * last thing it said. Watched rather than fetched, so a run that is still going keeps moving.
 */
import { computed, nextTick, onBeforeUnmount, ref, watch as vueWatch } from 'vue';
import { watch } from '../../events';
import { runPath, stopRun, duration, stamp } from '../../automations';
import type { RunAnswer } from '../../automations';
import InlineChat from '../focus/InlineChat.vue';
import { exitNote } from '../../dev-api/automation-rules.mjs';

const props = defineProps<{ runId: string }>();
const emit = defineEmits<{ (e: 'event', id: string): void }>();

const answer = ref<RunAnswer | null>(null);
const error = ref('');
const stopping = ref(false);
const pre = ref<HTMLElement | null>(null);
const show = ref<{ script: boolean; prompt: boolean; event: boolean }>({ script: false, prompt: false, event: false });
let stop: (() => void) | null = null;
/** Whether the output was scrolled to its end, so new lines keep it there and a reader scrolled up is left alone. */
let pinned = true;

function subscribe(id: string) {
  stop?.();
  answer.value = null;
  error.value = '';
  stop = watch(runPath(id), (value) => {
    if (value?.error) {
      error.value = value.error;

      return;
    }
    pinned = !pre.value || pre.value.scrollHeight - pre.value.scrollTop - pre.value.clientHeight < 24;
    answer.value = value;
    nextTick(() => {
      if (pinned && pre.value) {
        pre.value.scrollTop = pre.value.scrollHeight;
      }
    });
  }, { every: 2000 });
}

vueWatch(() => props.runId, (id) => subscribe(id), { immediate: true });
onBeforeUnmount(() => stop?.());

const run = computed(() => answer.value?.run || null);
const live = computed(() => !!run.value && ['starting', 'running', 'waiting'].includes(run.value.state));
const took = computed(() => (run.value ? duration(run.value) : ''));

const verdict = computed(() => {
  const r = run.value;

  if (!r) {
    return '';
  }
  if (r.kind === 'script' && typeof r.exitCode === 'number') {
    return r.exitCode === 0 ? 'exit 0' : `${ exitNote(r.exitCode) } (exit ${ r.exitCode })`;
  }

  return r.note || '';
});

const eventJson = computed(() => {
  try {
    return JSON.stringify(JSON.parse(answer.value?.event || '{}'), null, 2);
  } catch {
    return answer.value?.event || '';
  }
});

async function stopIt() {
  stopping.value = true;
  try {
    await stopRun(props.runId);
  } catch (e: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
    error.value = e?.message || String(e);
  } finally {
    stopping.value = false;
  }
}
</script>

<template>
  <div
    class="run-log"
    data-testid="automation-run-log"
  >
    <p
      v-if="error"
      class="run-log__error"
    >
      {{ error }}
    </p>
    <p
      v-else-if="!run"
      class="text-muted run-log__wait"
    >
      Reading the run…
    </p>
    <template v-else>
      <dl class="run-log__facts">
        <div>
          <dt>State</dt>
          <dd>
            <span
              class="run-log__state"
              :class="`run-log__state--${ run.state }`"
            >{{ run.state }}</span>
            <span
              v-if="verdict"
              class="run-log__verdict"
            >{{ verdict }}</span>
          </dd>
        </div>
        <div>
          <dt>Started</dt>
          <dd>{{ stamp(run.startedAt) }} · {{ took }}{{ live ? ' so far' : '' }}</dd>
        </div>
        <div>
          <dt>By</dt>
          <dd>
            <template v-if="run.event">
              <button
                type="button"
                class="run-log__link"
                :title="run.event.title"
                @click="emit('event', run.event.id)"
              >
                {{ run.event.name }} · {{ run.event.subject }}
              </button>
            </template>
            <template v-else>
              {{ run.trigger }}<template v-if="run.context && run.context.name">
                · {{ run.context.event || 'changed' }} {{ run.context.name }}
              </template>
            </template>
          </dd>
        </div>
        <div v-if="run.kind === 'agent'">
          <dt>Conversation</dt>
          <dd><code>{{ run.conversation || '…' }}</code></dd>
        </div>
      </dl>

      <div
        v-if="run.result"
        class="run-log__result"
      >
        <span class="run-log__label">Result</span>
        <p>{{ run.result }}</p>
      </div>

      <template v-if="run.kind === 'script'">
        <div class="run-log__bar">
          <span class="run-log__label">Output</span>
          <span class="text-muted">{{ answer.size ? `${ Math.round(answer.size / 1024 * 10) / 10 } KB` : 'nothing yet' }}{{ answer.truncated ? ' · the last 256 KB' : '' }}</span>
          <button
            v-if="live"
            type="button"
            class="btn role-secondary btn-sm run-log__stop"
            :disabled="stopping"
            data-testid="automation-run-stop"
            @click="stopIt"
          >
            {{ stopping ? 'Stopping' : 'Stop' }}
          </button>
        </div>
        <pre
          ref="pre"
          class="run-log__output"
          data-testid="automation-run-output"
        >{{ answer.output || (live ? 'Waiting for output…' : 'It printed nothing.') }}</pre>
        <button
          type="button"
          class="run-log__toggle"
          @click="show.script = !show.script"
        >
          {{ show.script ? '▾' : '▸' }} The script it ran
        </button>
        <pre
          v-if="show.script"
          class="run-log__code"
        >{{ answer.script }}</pre>
      </template>

      <template v-else>
        <button
          type="button"
          class="run-log__toggle"
          @click="show.prompt = !show.prompt"
        >
          {{ show.prompt ? '▾' : '▸' }} The prompt it opened with
        </button>
        <pre
          v-if="show.prompt"
          class="run-log__code"
        >{{ answer.prompt }}</pre>
        <div
          v-if="run.conversation"
          class="run-log__chat"
        >
          <InlineChat
            :session="run.conversation"
            :title="run.conversation"
          />
        </div>
        <p
          v-else
          class="text-muted"
        >
          {{ run.state === 'failed' ? 'No conversation was made.' : 'Opening the conversation…' }}
        </p>
      </template>

      <button
        type="button"
        class="run-log__toggle"
        @click="show.event = !show.event"
      >
        {{ show.event ? '▾' : '▸' }} The event it was given
      </button>
      <pre
        v-if="show.event"
        class="run-log__code"
      >{{ eventJson }}</pre>
    </template>
  </div>
</template>

<style lang="scss" scoped>
.run-log {
  display:        flex;
  flex-direction: column;
  gap:            var(--dev-space-3);
  padding:        var(--dev-space-4);
  min-height:     0;
  overflow:       auto;

  &__error { color: var(--error); margin: 0; }
  &__wait { margin: 0; }

  &__facts {
    display:               grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap:                   var(--dev-space-2) var(--dev-space-4);
    margin:                0;
    font-size:             12px;

    dt { color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; }
    dd { margin: 2px 0 0; min-width: 0; overflow-wrap: anywhere; }
  }

  &__state {
    font-weight:    600;
    text-transform: uppercase;
    font-size:      11px;
    letter-spacing: 0.04em;

    &--done { color: var(--success); }
    &--failed { color: var(--error); }
    &--running, &--starting { color: var(--dev-accent); }
    &--waiting { color: var(--warning); }
  }

  &__verdict { margin-left: 6px; color: var(--muted); }

  &__link {
    min-height: 0;
    padding:    0;
    border:     0;
    background: none;
    color:      var(--link);
    font-size:  12px;
    text-align: left;
    cursor:     pointer;

    &:hover { text-decoration: underline; }
  }

  &__result {
    padding:       var(--dev-space-3);
    border-left:   3px solid var(--dev-accent);
    background:    color-mix(in srgb, var(--dev-accent) 6%, transparent);
    border-radius: var(--r-sm);

    p { margin: 4px 0 0; font-size: 13px; white-space: pre-wrap; overflow-wrap: anywhere; }
  }

  &__label { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }

  &__bar { display: flex; align-items: center; gap: var(--dev-space-3); font-size: 12px; }
  &__stop { margin-left: auto; }

  &__output {
    flex:          0 0 auto;
    height:        min(52vh, 460px);
    margin:        0;
    padding:       var(--dev-space-3);
    overflow:      auto;
    font-size:     12px;
    line-height:   1.45;
    white-space:   pre-wrap;
    overflow-wrap: anywhere;
    color:         #d8dee9;
    background:    #14171c;
    border-radius: var(--r-sm);
  }

  &__toggle {
    align-self: flex-start;
    min-height: 0;
    padding:    0;
    border:     0;
    background: none;
    color:      var(--link);
    font-size:  12px;
    cursor:     pointer;
  }

  &__code {
    margin:        0;
    padding:       var(--dev-space-3);
    max-height:    300px;
    overflow:      auto;
    font-size:     12px;
    white-space:   pre-wrap;
    overflow-wrap: anywhere;
    background:    color-mix(in srgb, var(--body-text) 5%, transparent);
    border-radius: var(--r-sm);
  }

  &__chat {
    display:        flex;
    flex-direction: column;
    height:         min(56vh, 520px);
    min-height:     0;
    border:         1px solid var(--border);
    border-radius:  var(--r-sm);
    overflow:       hidden;
  }
}
</style>
