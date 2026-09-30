<script>
import KeyValue from '@shell/components/form/KeyValue';

/**
 * The values editor, used by both the App's Default Values and an installation's Values.
 *
 * It exists because those two were the same eight props copied twice, and the copies had
 * already started to drift - one had a key dropdown before the other did. Anything that should
 * be true of "editing values" is true in one place now: which keys are offered, what a key that
 * no template mentions looks like, and the fact that the two columns are the same height.
 */
export default {
  name: 'ValuesEditor',

  components: { KeyValue },

  props: {
    /** The values themselves, as a plain map. */
    value: {
      type:    Object,
      default: () => ({}),
    },

    mode: {
      type:     String,
      required: true,
    },

    /**
     * Every key the templates actually refer to, which is both the dropdown's options and the
     * measure of whether a key still means anything.
     */
    keys: {
      type:    Array,
      default: () => [],
    },

    placeholder: {
      type:    String,
      default: '',
    },

    /**
     * The words each value wears on the install form, keyed like `value`.
     *
     * Editable here because the picker's toggle must not be the only way to a friendly label:
     * a parameter declared in this table - or authored by hand - reads as its raw key on every
     * install form forever unless the label can be typed where the key was.
     */
    labels: {
      type:    Object,
      default: () => ({}),
    },
  },

  emits: ['update:value', 'update:labels'],

  computed: {
    /**
     * The keys as options, not as strings.
     *
     * KeyValue's uniqueness filter compares `option.value` against the keys already in use, so
     * a list of plain strings makes it compare `undefined` to every one of them, match nothing,
     * and go on offering a key that another row has already taken. The shape is the fix.
     */
    keyOptions() {
      return this.keys.map((key) => ({ label: key, value: key }));
    },

    /**
     * Values that no template refers to any more.
     *
     * A template is edited far more often than the values beside it, so a `${greeting}` that
     * gets renamed or deleted leaves a value that will never be substituted into anything, and
     * nothing about the row says so. It is not an error and nothing is removed: a value is
     * cheap to keep, the template may be coming back, and deleting somebody's data because a
     * variable is momentarily unreferenced would be worse than the confusion. It is marked, and
     * the person decides.
     *
     * Empty while there are no keys at all, which is the case before an app has been chosen on
     * the installation form - marking every row there would be noise on a form nobody has
     * finished filling in.
     */
    stale() {
      if (!this.keys.length) {
        return {};
      }

      const used = new Set(this.keys);

      return Object.keys(this.value || {}).reduce((acc, key) => {
        if (key && !used.has(key)) {
          acc[key] = this.t('appsPlus.values.unused', { key });
        }

        return acc;
      }, {});
    },
  },

  methods: {
    /**
     * Record one key's label, or clear it.
     *
     * Blank deletes rather than storing '', because every reader falls back to the key when
     * there is no label - an empty string kept would be a row labelled with nothing.
     */
    setLabel(key, entered) {
      const labels = { ...this.labels };
      const text = (entered || '').trim();

      if (text) {
        labels[key] = text;
      } else {
        delete labels[key];
      }

      this.$emit('update:labels', labels);
    },
  },
};
</script>

<template>
  <!--
    Adding a row is how a parameter is declared. The app's set of parameters IS the set of keys
    here (see appVariables in render.ts), so typing a new key is not a mistake to guard against
    any more - it is the only way to introduce a `${...}` for a template written by hand.
    `key-taggable` is what allows the typing; the dropdown still offers what already exists.

    `value-can-be-empty` because declaring a key with no default is the required-value case,
    not a mistake: without it KeyValue drops the key from what it emits until a default is
    typed, and the declaration silently never happens.
  -->
  <KeyValue
    class="values-editor"
    :value="value"
    :mode="mode"
    :read-allowed="false"
    :as-map="true"
    :value-can-be-empty="true"
    :key-options="keyOptions"
    :key-taggable="true"
    :key-option-unique="true"
    :key-errors="stale"
    :key-placeholder="placeholder"
    :extra-columns="['label']"
    @update:value="v => $emit('update:value', v)"
  >
    <template #label:label>
      {{ t('appsPlus.values.label') }}
    </template>
    <!--
      Keyed to the row's current key rather than held in row state, so re-picking a row's key
      simply shows whatever label that key already has.
    -->
    <template #col:label="{ row }">
      <input
        :value="labels[row.key] || ''"
        :disabled="mode === 'view'"
        :placeholder="t('appsPlus.values.labelPlaceholder')"
        @change="e => setLabel(row.key, e.target.value)"
      >
    </template>
    <!--
      KeyValue's own Add disables itself once every option in key-options is a row - which under
      the declared model is always, since the options ARE the rows' keys. Adding a row here is
      how a NEW key is declared, so the button has to work precisely when the stock one gives up.
    -->
    <template #add="{ add }">
      <button
        type="button"
        class="btn role-tertiary add"
        data-testid="values-editor-add"
        @click="add()"
      >
        <i class="mr-5 icon icon-plus" /> {{ t('generic.add') }}
      </button>
    </template>
  </KeyValue>
</template>

<style lang="scss" scoped>
/**
 * One height for both columns.
 *
 * The value is a 40px control. The key becomes a Select the moment it is given options, and the
 * box that is actually drawn there is `.unlabeled-select` - 40px of dropdown wrapped in 3px of
 * its own padding and a 1px border, so 48. Setting the inner toggle to 40 changes nothing,
 * because it was already 40; the padding is what has to go.
 *
 * The toggle then fills what is left inside the border, and the selected text is centred by the
 * flex box rather than by the padding that used to hold it down.
 */
.values-editor :deep(.kv-item.key) {
  .unlabeled-select {
    height: 40px;
    min-height: 40px;
    padding-top: 0;
    padding-bottom: 0;
  }

  .v-select,
  .vs__dropdown-toggle {
    height: 100%;
    min-height: 0;
  }

  .vs__selected-options {
    padding-top: 0;
    align-items: center;
  }
}
</style>
