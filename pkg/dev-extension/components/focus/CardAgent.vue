<script setup lang="ts">
/**
 * What the agent is asking, with the answer on the card.
 *
 * This is the highest thing in the queue - an agent has stopped and nothing it is doing can go on
 * until it hears back - and until now the card showed the pull request's description, because
 * that is what `body` resolves to. The one thing needed to answer was the one thing missing.
 *
 * Claude's own UI is regular enough to read (see readPane in chat.ts): a numbered list with a
 * marker on the current choice is a question, `(y/n)` is a confirmation. So when it is asking
 * something with choices, the choices are buttons here, and pressing one sends that key to the
 * pane - which is the whole of what answering means. Nothing is interpreted: the labels are its
 * own words and the key sent is the one it listed.
 *
 * When there is no question - which is what a stalled workspace always is - what it last said
 * stands in, and under that the last few lines of its pane. A stop with neither is still worth
 * drawing as a stop, because the alternative is a card that looks empty.
 */
import { computed } from 'vue';
import AppButton from './AppButton.vue';
import SectionHead from './SectionHead.vue';
import { renderMarkdown } from '../../chat';
import type { AgentTurn } from '../../focus-artifacts';

const props = defineProps<{ agent: AgentTurn; busy?: boolean }>();

const emit = defineEmits<{
  (e: 'answer', value: { key: string; label: string }): void;
  (e: 'open'): void;
}>();

const asking = computed(() => Boolean(props.agent.question || props.agent.options.length));

/** What it wants, said plainly, since `options`/`yes-no`/`text` is its vocabulary and not yours. */
const wants = computed(() => ({
  options: 'It is waiting for you to choose',
  'yes-no': 'It is waiting for a yes or a no',
  text: 'It is waiting to be told something',
  login: 'It is waiting for a login',
  code: 'It is waiting for a code',
}[props.agent.wants] || ''));
</script>

<template>
  <section class="ag">
    <SectionHead
      :label="asking ? 'It is asking you' : 'Where it stopped'"
      icon="sparkle"
    >
      <span v-if="agent.status" class="ag__status">{{ agent.status }}</span>
    </SectionHead>

    <!-- The question, in its own words. -->
    <p v-if="agent.question" class="ag__question">{{ agent.question }}</p>

    <!-- Its choices, as the choices. Pressing one sends its key to the pane. -->
    <div v-if="agent.options.length" class="ag__choices">
      <AppButton
        v-for="option in agent.options"
        :key="option.key"
        :variant="option.selected ? 'kind' : 'ghost'"
        size="lg"
        :busy="busy"
        @click="emit('answer', { key: option.key, label: option.label })"
      >{{ option.label }}</AppButton>
    </div>

    <div v-else-if="agent.wants === 'yes-no'" class="ag__choices">
      <AppButton variant="kind" size="lg" :busy="busy" @click="emit('answer', { key: 'y', label: 'yes' })">Yes</AppButton>
      <AppButton variant="ghost" size="lg" :busy="busy" @click="emit('answer', { key: 'n', label: 'no' })">No</AppButton>
    </div>

    <p v-if="wants && !agent.options.length" class="ag__wants">{{ wants }}</p>

    <!-- No question: the last thing it said. -->
    <!-- eslint-disable-next-line vue/no-v-html -- renderMarkdown escapes before it marks up. -->
    <div v-if="agent.said" class="ag__said" v-html="renderMarkdown(agent.said)" />

    <!-- Neither: its last lines, so a stop is never a blank card. -->
    <pre v-else-if="!asking && agent.tail" class="ag__tail">{{ agent.tail }}</pre>

    <!--
      Its pane could not be read at all, which is not the same claim as "it has not said
      anything" - and saying the wrong one of the two is worse than saying neither. The card
      still names the conversation, so the button under it goes somewhere.
    -->
    <p v-else-if="!agent.reachable" class="ag__quiet">
      Its pane could not be read{{ agent.title ? ` - the conversation is ${ agent.title }` : '' }}.
      Open the conversation to see where it got to.
    </p>

    <p v-else-if="!asking && !agent.said" class="ag__quiet">
      Its pane is up but it has not said anything. Open the conversation to see what it is doing.
    </p>
  </section>
</template>

<style scoped>
.ag {
  display: flex;
  flex-direction: column;
  gap: var(--s3);
  min-height: 0;
}

.ag__status { color: var(--text-faint); font-size: var(--t-xs); }

/* Its question, at the size of a question somebody is waiting on an answer to. */
.ag__question {
  margin: 0;
  max-width: 76ch;
  color: var(--text);
  font-size: var(--t-md);
  line-height: 1.5;
  white-space: pre-wrap;
}

.ag__choices {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s2);
}

.ag__wants { margin: 0; color: var(--text-faint); font-size: var(--t-xs); }

.ag__said {
  flex: 1 1 auto;
  min-height: 0;
  max-width: 82ch;
  padding-right: var(--s2);
  color: var(--text-dim);
  font-size: var(--t-sm);
  line-height: 1.6;
  overflow-y: auto;
}

.ag__said :deep(p) { margin: 0 0 var(--s2); }
.ag__said :deep(p:last-child) { margin-bottom: 0; }
.ag__said :deep(code) {
  padding: 1px 5px;
  border-radius: var(--r-sm);
  background: var(--surface-raised);
  font-family: var(--mono);
  font-size: 0.92em;
}

.ag__tail {
  flex: 1 1 auto;
  min-height: 0;
  margin: 0;
  padding: var(--s3);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface-sunk);
  color: var(--text-muted);
  font-family: var(--mono);
  font-size: var(--t-xs);
  line-height: 1.5;
  white-space: pre-wrap;
  overflow: auto;
}

.ag__quiet { margin: 0; max-width: 70ch; color: var(--text-muted); font-size: var(--t-sm); line-height: 1.55; }
</style>
