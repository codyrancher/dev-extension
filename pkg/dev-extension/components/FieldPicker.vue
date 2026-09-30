<script>
import jsyaml from 'js-yaml';
import { LabeledInput } from '@components/Form/LabeledInput';
import { Banner } from '@components/Banner';
import {
  suggestedFields, searchFields, applyToggle, writeAt
} from '../fields';
import { dumpTemplate } from '../import-resource';

/**
 * Mark which fields of a resource somebody can change when they install the app.
 *
 * A Deployment is a hundred lines and three of them matter. Reading YAML to find those three,
 * then hand-typing `${image}` in the right place and remembering to put the old value in the
 * defaults, is the part of building an app that nobody enjoys and everybody gets wrong once.
 *
 * So: a short list of the fields that are usually the answer, each with its current value and a
 * switch. Flick it and the field becomes a parameter with its present value as the default;
 * flick it back and the value returns. A search box reaches everything else.
 *
 * The YAML remains the only copy. Every toggle rewrites it and re-reads it, so a field somebody
 * parameterised by hand shows here as already on, and nothing can drift out of step with what
 * will actually be deployed.
 */
export default {
  name: 'FieldPicker',

  components: { LabeledInput, Banner },

  props: {
    /** The template body. */
    content: {
      type:     String,
      required: true,
    },

    /** The app's values, so a default can be written beside the parameter that needs it. */
    values: {
      type:    Object,
      default: () => ({}),
    },

    /**
     * The words each parameter wears on the install form, keyed like `values`.
     *
     * Written here because this is the moment the words exist: the field's friendly label is on
     * screen when the toggle is flicked, and without recording it the install form is left
     * showing `image` where the definer was shown "Container Image".
     */
    labels: {
      type:    Object,
      default: () => ({}),
    },
  },

  emits: ['update:content', 'update:values', 'update:labels'],

  data() {
    return { query: '' };
  },

  computed: {
    manifest() {
      try {
        return jsyaml.load(this.content) || null;
      } catch {
        return null;
      }
    },

    suggested() {
      return this.manifest ? suggestedFields(this.manifest) : [];
    },

    found() {
      if (!this.manifest || !this.query.trim()) {
        return [];
      }

      const shown = new Set(this.suggested.map((field) => field.path));

      return searchFields(this.manifest, this.query).filter((field) => !shown.has(field.path));
    },
  },

  methods: {
    /**
     * Turn a field into a parameter, or turn it back into a value.
     *
     * On: the current value becomes the default and the field becomes `${name}`. Off: the
     * default is written back into the YAML and the value is dropped, because a default for a
     * parameter nothing refers to is exactly what the stale marker in the values editor
     * complains about.
     */
    toggle(field) {
      const manifest = this.manifest;

      if (!manifest) {
        return;
      }

      const { values, labels } = applyToggle(manifest, field.path, this.values, this.labels);

      this.$emit('update:content', dumpTemplate(manifest));
      this.$emit('update:values', values);
      this.$emit('update:labels', labels);
    },

    /**
     * Rename a parameter.
     *
     * Both halves move together: the placeholder in the YAML and the key in the values. Doing
     * one without the other is a template referring to a value that does not exist, which
     * renders as the literal `${old}` on a cluster.
     */
    rename(field, name) {
      const next = (name || '').trim();

      if (!next || next === field.parameter || !this.manifest) {
        return;
      }

      const manifest = this.manifest;
      const values = { ...this.values };
      const labels = { ...this.labels };

      values[next] = values[field.parameter];
      delete values[field.parameter];

      if (labels[field.parameter] !== undefined) {
        labels[next] = labels[field.parameter];
        delete labels[field.parameter];
      }

      writeAt(manifest, field.path, `\${${ next }}`);

      this.$emit('update:content', dumpTemplate(manifest));
      this.$emit('update:values', values);
      this.$emit('update:labels', labels);
    },

    setDefault(field, value) {
      this.$emit('update:values', { ...this.values, [field.parameter]: value });
    },

    defaultFor(field) {
      return field.parameter ? (this.values[field.parameter] ?? '') : '';
    },
  },
};
</script>

<template>
  <div class="picker">
    <Banner
      v-if="!manifest"
      color="warning"
      :label="t('appsPlus.fields.unparsed')"
    />

    <template v-else>
      <p class="picker__hint">
        {{ t('appsPlus.fields.hint') }}
      </p>

      <div
        v-for="field in suggested"
        :key="field.path"
        class="field"
        :class="{ 'field--on': !!field.parameter }"
      >
        <button
          class="field__switch"
          type="button"
          :aria-pressed="!!field.parameter"
          :aria-label="field.label"
          @click="toggle(field)"
        >
          <i
            class="icon"
            :class="field.parameter ? 'icon-checkmark' : 'icon-plus'"
          />
        </button>

        <div class="field__body">
          <div
            v-if="field.friendly"
            class="field__title"
          >
            {{ field.friendly }}
          </div>
          <div class="field__path">
            {{ field.label }}
          </div>

          <!-- Captions on both boxes: a pair reading only `replicas` and `1` says nothing
               about which is the name and which the value it starts at. -->
          <div
            v-if="field.parameter"
            class="field__params"
          >
            <label class="field__param">
              <span class="field__caption">{{ t('appsPlus.fields.name') }}</span>
              <input
                class="field__name"
                :value="field.parameter"
                @change="e => rename(field, e.target.value)"
              >
            </label>
            <label class="field__param">
              <span class="field__caption">{{ t('appsPlus.fields.default') }}</span>
              <input
                class="field__default"
                :value="defaultFor(field)"
                @change="e => setDefault(field, e.target.value)"
              >
            </label>
          </div>
          <div
            v-else
            class="field__value"
          >
            {{ field.value }}
          </div>
        </div>
      </div>

      <LabeledInput
        v-model:value="query"
        class="picker__search"
        :label="t('appsPlus.fields.search')"
        :placeholder="t('appsPlus.fields.searchPlaceholder')"
      />

      <div
        v-for="field in found"
        :key="field.path"
        class="field"
      >
        <button
          class="field__switch"
          type="button"
          :aria-label="field.label"
          @click="toggle(field)"
        >
          <i class="icon icon-plus" />
        </button>
        <div class="field__body">
          <div
            v-if="field.friendly"
            class="field__title"
          >
            {{ field.friendly }}
          </div>
          <div class="field__path">
            {{ field.label }}
          </div>
          <div class="field__value">
            {{ field.value }}
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style lang="scss" scoped>
.picker {
  padding: 10px 12px;

  &__hint {
    color:         var(--muted);
    font-size:     11px;
    margin-bottom: 8px;
  }

  &__search { margin-top: 12px; }
}

.field {
  display:       flex;
  align-items:   center;
  gap:           8px;
  padding:       5px 6px;
  border-radius: 4px;

  &--on { background: var(--nav-bg); }

  &__switch {
    flex:          0 0 auto;
    width:         22px;
    height:        22px;
    border:        1px solid var(--border);
    border-radius: 4px;
    background:    none;
    color:         var(--muted);
    cursor:        pointer;
    line-height:   1;
  }

  &--on &__switch {
    color:        var(--primary);
    border-color: var(--primary);
  }

  &__body {
    flex:      1;
    min-width: 0;
  }

  &__title {
    font-size:   12px;
    font-weight: 600;
  }

  // Under the words rather than instead of them: the label is for finding the field, the path
  // is for being certain it is the one you meant.
  &__path {
    font-family: monospace;
    font-size:   10px;
    color:       var(--muted);
  }

  &__value {
    color:         var(--muted);
    font-size:     11px;
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
  }

  // Wrapping, because this picker lives in narrow places - the builder drawer, and the app
  // form with that drawer open beside it. Two boxes forced to share 200px shrink until the
  // name reads `maxmen`; stacked, each keeps enough room to read what is typed in it.
  //
  // 120, because a ~200px picker keeps ~128px for a field's body once the switch, gaps and
  // padding are paid: 130 here overflowed by five pixels and grew a scrollbar.
  &__params {
    display:   flex;
    flex-wrap: wrap;
    gap:       6px;
  }

  &__param {
    display:        flex;
    flex-direction: column;
    flex:           1 1 120px;
    min-width:      120px;
    gap:            1px;
  }

  &__caption {
    font-size: 10px;
    color:     var(--muted);
  }

  &__name,
  &__default {
    min-width:     0;
    font-size:     11px;
    padding:       2px 6px;
    border:        1px solid var(--border);
    border-radius: 3px;
    background:    var(--body-bg);
    color:         var(--body-text);
  }

  &__name { font-family: monospace; }
}
</style>
