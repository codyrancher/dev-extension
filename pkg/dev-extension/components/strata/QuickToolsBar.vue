<script setup lang="ts">
/**
 * The tools for the line and the note, under the text.
 *
 * On a screen: delete line and label line while a line has the caret, clear and uncheck while
 * anything is ticked, and copy and download always. On a phone with the keyboard up it is the
 * line's tools instead (delete, copy, label, outdent, indent), with the keyboard kept up by not
 * letting the buttons take focus; with the keyboard down, the note's.
 */
import { S } from '../../strata/editor/icons';

defineProps<{
  isMobile: boolean;
  keyboardOpen: boolean;
  checkedItems: number;
  clearing: boolean;
  hasCurrentLine: boolean;
}>();

const emit = defineEmits<{
  (e: 'delete-line'): void;
  (e: 'copy-line'): void;
  (e: 'label-line', at: HTMLElement): void;
  (e: 'outdent'): void;
  (e: 'indent'): void;
  (e: 'clear-checked'): void;
  (e: 'uncheck-all'): void;
  (e: 'copy-note'): void;
  (e: 'download-note'): void;
}>();

const deleteLineSvg = S('<line x1=\'3\' y1=\'5\' x2=\'21\' y2=\'5\'/><line x1=\'3\' y1=\'12\' x2=\'13\' y2=\'12\'/><line x1=\'17.25\' y1=\'9.75\' x2=\'21.75\' y2=\'14.25\'/><line x1=\'21.75\' y1=\'9.75\' x2=\'17.25\' y2=\'14.25\'/><line x1=\'3\' y1=\'19\' x2=\'21\' y2=\'19\'/>');
const copySvg = S('<rect x=\'9\' y=\'9\' width=\'13\' height=\'13\' rx=\'2\' ry=\'2\'/><path d=\'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1\'/>');
const downloadSvg = S('<path d=\'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4\'/><polyline points=\'7 10 12 15 17 10\'/><line x1=\'12\' y1=\'15\' x2=\'12\' y2=\'3\'/>');
const labelLineSvg = S('<path d=\'M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z\'/><circle cx=\'7\' cy=\'7\' r=\'1\'/>');
const outdentSvg = S('<polyline points=\'11 17 6 12 11 7\'/><line x1=\'6\' y1=\'12\' x2=\'18\' y2=\'12\'/>');
const indentSvg = S('<polyline points=\'13 17 18 12 13 7\'/><line x1=\'6\' y1=\'12\' x2=\'18\' y2=\'12\'/>');
const clearSvg = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/><line x1="4" y1="20" x2="20" y2="4" stroke-width="2.5"/></svg>';
const uncheckSvg = S('<rect x=\'3\' y=\'3\' width=\'18\' height=\'18\' rx=\'2\' ry=\'2\'/>');
</script>

<template>
  <div
    class="strata-quick"
    data-testid="strata-quick-tools"
  >
    <template v-if="isMobile && keyboardOpen">
      <button
        type="button"
        class="strata-quick__btn strata-quick__btn--danger"
        title="Delete line"
        aria-label="Delete line"
        data-testid="strata-quick-delete-line"
        @pointerdown.prevent
        @mousedown.prevent
        @click="emit('delete-line')"
        v-html="deleteLineSvg"
      />
      <button
        type="button"
        class="strata-quick__btn"
        title="Copy line"
        aria-label="Copy line"
        data-testid="strata-quick-copy-line"
        @pointerdown.prevent
        @mousedown.prevent
        @click="emit('copy-line')"
        v-html="copySvg"
      />
      <button
        type="button"
        class="strata-quick__btn"
        title="Label this line"
        aria-label="Label this line"
        data-testid="strata-quick-label-line"
        @click="emit('label-line', $event.currentTarget as HTMLElement)"
        v-html="labelLineSvg"
      />
      <button
        type="button"
        class="strata-quick__btn"
        title="Outdent"
        aria-label="Outdent"
        data-testid="strata-quick-outdent"
        @pointerdown.prevent
        @mousedown.prevent
        @click="emit('outdent')"
        v-html="outdentSvg"
      />
      <button
        type="button"
        class="strata-quick__btn"
        title="Indent"
        aria-label="Indent"
        data-testid="strata-quick-indent"
        @pointerdown.prevent
        @mousedown.prevent
        @click="emit('indent')"
        v-html="indentSvg"
      />
    </template>
    <template v-else>
      <button
        v-if="hasCurrentLine && !isMobile"
        type="button"
        class="strata-quick__btn strata-quick__btn--danger"
        title="Delete line"
        aria-label="Delete line"
        data-testid="strata-quick-delete-line"
        @mousedown.prevent
        @click="emit('delete-line')"
        v-html="deleteLineSvg"
      />
      <button
        v-if="checkedItems > 0"
        type="button"
        class="strata-quick__btn strata-quick__btn--danger"
        :class="{ 'strata-quick__btn--busy': clearing }"
        :disabled="clearing"
        title="Clear checked items"
        aria-label="Clear checked items"
        data-testid="strata-quick-clear-checked"
        @click="emit('clear-checked')"
        v-html="clearSvg"
      />
      <button
        v-if="checkedItems > 0"
        type="button"
        class="strata-quick__btn"
        title="Uncheck all"
        aria-label="Uncheck all"
        data-testid="strata-quick-uncheck-all"
        @click="emit('uncheck-all')"
        v-html="uncheckSvg"
      />
      <button
        type="button"
        class="strata-quick__btn"
        title="Copy note as Markdown"
        aria-label="Copy note as Markdown"
        data-testid="strata-quick-copy-note"
        @mousedown.prevent
        @click="emit('copy-note')"
        v-html="copySvg"
      />
      <button
        type="button"
        class="strata-quick__btn"
        title="Download note as Markdown"
        aria-label="Download note as Markdown"
        data-testid="strata-quick-download"
        @mousedown.prevent
        @click="emit('download-note')"
        v-html="downloadSvg"
      />
      <button
        v-if="hasCurrentLine || isMobile"
        type="button"
        class="strata-quick__btn"
        title="Label this line"
        aria-label="Label this line"
        data-testid="strata-quick-label-line"
        @mousedown.prevent
        @click="emit('label-line', $event.currentTarget as HTMLElement)"
        v-html="labelLineSvg"
      />
    </template>
  </div>
</template>

<style lang="scss" scoped>
.strata-quick {
  display:         flex;
  flex-shrink:     0;
  align-items:     center;
  justify-content: flex-end;
  gap:             var(--dev-space-3);
  min-height:      calc(var(--dev-control) + var(--dev-space-4) * 2);
  padding:         var(--dev-space-4) 0;
  border-top:      1px solid var(--border);

  &__btn {
    display:         inline-flex;
    flex-shrink:     0;
    align-items:     center;
    justify-content: center;
    width:           var(--dev-control);
    height:          var(--dev-control);
    min-height:      0;
    padding:         0;
    border:          1px solid var(--border);
    border-radius:   var(--r-sm);
    background:      var(--body-bg);
    color:           var(--body-text);
    line-height:     1;
    cursor:          pointer;

    :deep(svg) { width: 14px; height: 14px; }

    &:hover { border-color: var(--dev-accent); }

    &--danger {
      border-color: color-mix(in srgb, var(--error) 60%, transparent);
      color:        var(--error);

      &:hover { border-color: var(--error); background: color-mix(in srgb, var(--error) 12%, transparent); }
    }

    &--busy { opacity: 0.5; }
  }
}
</style>
