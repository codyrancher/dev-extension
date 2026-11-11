<script>
/**
 * A script, edited as code: the dashboard's own CodeMirror (Rancher's theme, keymap and font), in
 * shell mode with line numbers.
 *
 * The shell mode is not one the shared CodeMirror loads, so it is defined on the editor's own
 * CodeMirror when the editor is ready (codemirror-shell-mode.mjs says why it cannot simply be
 * imported), and the editor is told its mode again so the first paint already uses it.
 */
import CodeMirror from '@shell/components/CodeMirror';
import { defineShellMode } from '../codemirror-shell-mode.mjs';

export default {
  name: 'ScriptEditor',

  components: { CodeMirror },

  props: {
    value: {
      type:    String,
      default: '',
    },
  },

  emits: ['update:value'],

  computed: {
    options() {
      return {
        mode:           'shell',
        lineNumbers:    true,
        lint:           false,
        foldGutter:     false,
        gutters:        ['CodeMirror-linenumbers'],
        tabSize:        2,
        indentUnit:     2,
        indentWithTabs: false,
        // A script keeps its lines; a long one scrolls rather than folding under itself.
        lineWrapping:   false,
      };
    },
  },

  methods: {
    ready(cm) {
      const CM = (cm && cm.constructor && cm.constructor.defineMode) ? cm.constructor : window.CodeMirror;

      defineShellMode(CM);
      cm?.setOption?.('mode', 'shell');
    },
  },
};
</script>

<template>
  <div
    class="script-editor"
    data-testid="script-editor"
  >
    <CodeMirror
      :value="value || ''"
      :options="options"
      @onInput="$emit('update:value', $event)"
      @onReady="ready"
    />
  </div>
</template>

<style lang="scss" scoped>
.script-editor {
  border:        1px solid var(--input-border);
  border-radius: var(--border-radius);
  overflow:      hidden;

  // Grows with the script from a dozen lines, then scrolls inside itself.
  :deep(.CodeMirror) {
    height:      auto;
    font-size:   13px;
    line-height: 1.5;
  }

  :deep(.CodeMirror-scroll) {
    min-height: 240px;
    max-height: 560px;
  }
}
</style>
