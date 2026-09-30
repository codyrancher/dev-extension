<script>
import jsyaml from 'js-yaml';
import { builder } from '../builder/state';
import {
  probeInput, probeCandidates, plainManifest, modelFor
} from '../probe';
import {
  readAt, writeAt, applyToggle, parameterAt, isNever
} from '../fields';
import { substitute } from '../render';
import { dumpTemplate } from '../import-resource';

/**
 * "Allow editing in installation" switches, laid over Rancher's own resource edit form.
 *
 * When the resource being edited is one that is staged in the app builder, every input the
 * probe can prove is bound to a manifest path gets a switch beside it (see probe.ts). Flicking
 * the switch marks that field on the staged template in the drawer - `${param}` goes into the
 * staged YAML with the field's current value as the default - through the same applyToggle the
 * drawer's own Customizable list uses, so the two can never disagree.
 *
 * Nothing here touches the live resource. The probe writes a sentinel through the form and
 * reverts it in the same breath, verified against a snapshot; the switch rewrites only the
 * staged copy. And when the drawer is closed, no app is chosen, or this resource is not staged,
 * this component renders nothing at all - a switch that could not do anything must not exist.
 *
 * Mounted outside the page (see builder/page-marks.ts) because pages come and go under it: it
 * watches the URL and the staging, not any one page's lifecycle.
 */
export default {
  name: 'PageMarks',

  data() {
    return {
      // { id, path, templateName, on, top, left, visible }
      marks: [],
    };
  },

  mounted() {
    // Non-reactive bookkeeping: DOM nodes and models do not belong in Vue's reactivity.
    this.markEls = new Map();
    this.pageKey = '';
    this.probed = false;
    this.probing = false;
    this.lastCount = -1;

    this.timer = setInterval(() => this.tick(), 500);
    this.onMove = () => this.reposition();
    window.addEventListener('resize', this.onMove);
    // Capture, because the form scrolls inside nested containers, not just the window.
    window.addEventListener('scroll', this.onMove, true);

    // Staging changed while sitting on the page: what was probed no longer answers, so start
    // over. Covers staging the open resource (marks appear), and removing its card (they go).
    this.unwatch = this.$watch(
      () => [builder.open, builder.app, builder.templates.map((t) => `${ t.kind }:${ t.source }`).join('|')].join('@'),
      () => this.reset(),
    );
  },

  beforeUnmount() {
    clearInterval(this.timer);
    window.removeEventListener('resize', this.onMove);
    window.removeEventListener('scroll', this.onMove, true);
    this.unwatch?.();
  },

  methods: {
    reset() {
      this.marks = [];
      this.markEls = new Map();
      this.probed = false;
      this.lastCount = -1;
    },

    tick() {
      if (!builder.open || !builder.app || !builder.templates.length) {
        if (this.marks.length || this.probed) {
          this.reset();
        }

        return;
      }

      const key = window.location.pathname + window.location.search;

      if (key !== this.pageKey) {
        this.pageKey = key;
        this.reset();
      }

      if (this.probed) {
        this.reposition();

        return;
      }

      if (this.probing) {
        return;
      }

      const host = document.getElementById('main-content');
      const els = host ? probeCandidates(host) : [];

      // Wait until the form has finished appearing: probing half a form resolves half of it.
      if (!els.length || els.length !== this.lastCount) {
        this.lastCount = els.length;

        return;
      }

      this.probePage(els).catch((e) => {
        console.error('[apps-plus] page marks probe failed', e); // eslint-disable-line no-console
      });
    },

    /** The staged template this page's resource became, if it is staged at all. */
    templateFor(model) {
      if (!model?.id) {
        return null;
      }

      return builder.templates.find((template) => template.kind === (model.kind || '') &&
        template.source === model.id) || null;
    },

    async probePage(els) {
      this.probing = true;
      this.probed = true; // even when nothing matches: settled, until the URL or staging changes

      try {
        const model = els.map(modelFor).find((m) => m);
        const template = this.templateFor(model);

        if (!template) {
          return;
        }

        let raw, display;

        try {
          raw = jsyaml.load(template.content);
          display = jsyaml.load(substitute(template.content, builder.values));
        } catch {
          return;
        }

        const read = () => plainManifest(model);
        const restore = (path, value) => writeAt(model, path, value);
        const marks = [];
        const markEls = new Map();

        for (const el of els) {
          // A field bound to something else entirely (a filter box, another resource's row)
          // must not be probed against this model.
          if (modelFor(el) !== model) {
            continue;
          }

          const probe = await probeInput(el, read, restore);

          if (!this.offerable(probe, raw, display)) {
            continue;
          }

          const id = marks.length;

          markEls.set(id, el);
          marks.push({
            id, path: probe.path, templateName: template.name, on: false, top: 0, left: 0, visible: false,
          });
        }

        this.markEls = markEls;
        this.marks = marks;
        this.refreshStates(raw);
        this.reposition();
      } finally {
        this.probing = false;
      }
    },

    /**
     * Whether a probed input deserves a switch. The path must have resolved unambiguously,
     * must be one a parameter is ever allowed on, must exist in the staged template, and the
     * value on screen must be the template's value - allowing only a trailing unit the form
     * renders beside a number ("500m" shown as 500 in a box labelled mCPUs). A form inventing
     * a value the template does not hold must not be markable against it.
     */
    offerable(probe, raw, display) {
      if (!probe.path || isNever(probe.path)) {
        return false;
      }

      if (readAt(raw, probe.path) === undefined) {
        return false;
      }

      const displayed = String(readAt(display, probe.path) ?? '');

      return displayed === probe.original ||
        (probe.original !== '' &&
          displayed.startsWith(probe.original) &&
          /^[a-zA-Z]{1,3}$/.test(displayed.slice(probe.original.length)));
    },

    /** On/off is read back from the staged YAML - the template stays the single source of truth. */
    refreshStates(raw) {
      this.marks.forEach((mark) => {
        mark.on = !!parameterAt(raw, mark.path);
      });
    },

    /** Keep each switch pinned to its input, and hidden while the input's tab is. */
    reposition() {
      this.marks.forEach((mark) => {
        const el = this.markEls.get(mark.id);
        const rect = el?.isConnected ? el.getBoundingClientRect() : null;
        const visible = !!rect && rect.width > 0 && rect.height > 0;
        const top = visible ? Math.round(rect.top - 9) : 0;
        const left = visible ? Math.round(rect.right - 13) : 0;

        if (mark.visible !== visible || mark.top !== top || mark.left !== left) {
          mark.visible = visible;
          mark.top = top;
          mark.left = left;
        }
      });
    },

    toggle(mark) {
      const template = builder.templates.find((t) => t.name === mark.templateName);

      if (!template) {
        return;
      }

      let manifest;

      try {
        manifest = jsyaml.load(template.content);
      } catch {
        return;
      }

      const { values, labels } = applyToggle(manifest, mark.path, builder.values, builder.labels);

      template.content = dumpTemplate(manifest);
      builder.values = values;
      builder.labels = labels;
      this.refreshStates(manifest);
    },
  },
};
</script>

<template>
  <div class="ap-page-marks">
    <button
      v-for="mark in marks"
      v-show="mark.visible"
      :key="mark.path"
      type="button"
      class="ap-page-marks__mark"
      :class="{ 'ap-page-marks__mark--on': mark.on }"
      :style="{ top: mark.top + 'px', left: mark.left + 'px' }"
      :title="t('appsPlus.pageMarks.toggle') + ' — ' + mark.path"
      :aria-label="t('appsPlus.pageMarks.toggle') + ' ' + mark.path"
      :aria-pressed="mark.on"
      @click="toggle(mark)"
    >
      <i
        class="icon"
        :class="mark.on ? 'icon-checkmark' : 'icon-plus'"
      />
    </button>
  </div>
</template>

<style lang="scss" scoped>
// The same visual language as the drawer's Customizable switch: a small square that is a plus
// until it is a checkmark, sitting on the input's top-right corner, over the border.
.ap-page-marks__mark {
  position:      fixed;
  z-index:       100;
  width:         22px;
  height:        22px;
  padding:       0;
  border:        1px solid var(--border);
  border-radius: 4px;
  background:    var(--body-bg);
  color:         var(--muted);
  cursor:        pointer;
  line-height:   1;

  &--on {
    color:        var(--primary);
    border-color: var(--primary);
  }

  &:hover {
    border-color: var(--primary);
  }
}
</style>
