<script setup lang="ts">
/**
 * One note in the list: when it changed, its title, the first five things in it, its labels.
 *
 * The preview is the note's own HTML cut to its first five blocks with something in them, code
 * highlighted, pictures pointed at dev-api, and faded at the bottom when it runs past five lines.
 */
import { computed } from 'vue';
import type { Directive } from 'vue';
import { common, createLowlight } from 'lowlight';
import { toHtml } from 'hast-util-to-html';
import LabelChip from './LabelChip.vue';
import { useLabelsStore } from '../../strata/stores';
import { IMAGE_PATH, imageSrc } from '../../strata/api';
import type { Note } from '../../strata/api';
import { relativeStamp } from '../../strata/dates';

const lowlight = createLowlight(common);

const props = defineProps<{ note: Note }>();
const emit = defineEmits<{ (e: 'open'): void; (e: 'label-click', labelId: string): void }>();

const labelsStore = useLabelsStore();

const vOverflow: Directive<HTMLElement> = {
  mounted(el) {
    el.classList.toggle('strata-card__preview--cut', el.scrollHeight > el.clientHeight + 1);
  },
  updated(el) {
    el.classList.toggle('strata-card__preview--cut', el.scrollHeight > el.clientHeight + 1);
  },
};

const preview = computed(() => {
  const html = props.note.content;

  if (!html) {
    return '';
  }
  const div = document.createElement('div');

  div.innerHTML = html;
  let kept = 0;

  for (const child of Array.from(div.children)) {
    const hasContent = child.textContent?.trim() || child.querySelector('img');

    if (!hasContent || kept >= 5) {
      child.remove();
    } else {
      kept++;
    }
  }
  div.querySelectorAll(`img[src^="${ IMAGE_PATH }"]`).forEach((img) => {
    img.setAttribute('src', imageSrc(img.getAttribute('src') || ''));
  });
  div.querySelectorAll('pre code').forEach((code) => {
    try {
      const result = lowlight.highlightAuto(code.textContent || '');

      code.innerHTML = toHtml(result as never);
      code.classList.add('hljs');
    } catch { /* left plain */ }
  });
  // Boxes in a preview are pictures of boxes: the card is the thing that is clicked.
  div.querySelectorAll('input').forEach((input) => input.setAttribute('disabled', ''));

  return div.innerHTML;
});

const labels = computed(() => props.note.label_ids.map((id) => labelsStore.getLabelById(id)).filter(Boolean));
</script>

<template>
  <article
    class="strata-card"
    role="link"
    tabindex="0"
    :aria-label="note.title || 'Untitled note'"
    data-testid="strata-note-card"
    @click="emit('open')"
    @keydown.enter="emit('open')"
  >
    <header class="strata-card__head">
      <h3
        v-if="note.title"
        class="strata-card__title"
      >
        {{ note.title }}
      </h3>
      <span
        class="strata-card__date"
        :title="note.updated_at + ' UTC'"
      >{{ relativeStamp(note.updated_at) }}</span>
    </header>
    <div
      v-if="note.content"
      v-overflow
      class="strata-card__preview strata-rich strata-rich--preview"
      v-html="preview"
    />
    <div
      v-if="labels.length"
      class="strata-card__labels"
    >
      <LabelChip
        v-for="label in labels"
        :key="label!.id"
        :name="label!.name"
        :color="label!.color"
        @click="emit('label-click', label!.id)"
      />
    </div>
  </article>
</template>

<style lang="scss" scoped>
.strata-card {
  display:        flex;
  flex-direction: column;
  gap:            var(--dev-space-3);
  min-width:      0;
  padding:        var(--dev-space-4) var(--dev-space-5);
  border:         1px solid var(--border);
  border-radius:  var(--r-sm);
  background:     var(--box-bg);
  cursor:         pointer;
  transition:     border-color 0.15s ease, box-shadow 0.15s ease;

  &:hover:not(:has(.strata-chip:hover)), &:focus-visible {
    border-color: var(--dev-accent);
    box-shadow:   0 0 0 1px var(--dev-accent);
    outline:      none;
  }

  &__head {
    display:     flex;
    align-items: baseline;
    gap:         var(--dev-space-4);
  }

  &__title {
    flex:          1;
    min-width:     0;
    margin:        0;
    overflow:      hidden;
    font-size:     15px;
    font-weight:   600;
    line-height:   1.3;
    text-overflow: ellipsis;
    white-space:   nowrap;
  }

  &__date {
    flex-shrink: 0;
    margin-left: auto;
    color:       var(--muted);
    font-size:   12px;
    white-space: nowrap;
  }

  &__preview {
    position:       relative;
    max-height:     calc(1.45em * 5);
    overflow:       hidden;
    color:          color-mix(in srgb, var(--body-text) 80%, var(--muted));
    pointer-events: none;

    &--cut::after {
      content:    '';
      position:   absolute;
      left:       0;
      right:      0;
      bottom:     0;
      height:     1.45em;
      background: linear-gradient(transparent, var(--box-bg));
    }
  }

  &__labels {
    display:   flex;
    flex-wrap: wrap;
    gap:       var(--dev-space-3);
  }
}
</style>
