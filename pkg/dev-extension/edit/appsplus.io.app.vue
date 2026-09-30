<script>
import CreateEditView from '@shell/mixins/create-edit-view';
import CruResource from '@shell/components/CruResource';
import NameNsDescription from '@shell/components/form/NameNsDescription';
import { LabeledInput } from '@components/Form/LabeledInput';
import ValuesEditor from '../components/ValuesEditor';
import FieldPicker from '../components/FieldPicker';
import ImportResourceModal from '../components/ImportResourceModal';
import YamlEditor from '@shell/components/YamlEditor';
import Tabbed from '@shell/components/Tabbed';
import Tab from '@shell/components/Tabbed/Tab';
import { Banner } from '@components/Banner';
import { RcButton } from '@components/RcButton';
import { DEFAULT_CLUSTER_TEMPLATE } from '../config/cluster-template';
import {
  requiredValues, appVariables, undeclaredWarnings, referencedVariables, DOCUMENTED_VALUES, BUILT_IN_VALUES
} from '../render';

const NEW_TEMPLATE = () => ({ name: 'resource.yaml', content: '' });

/**
 * Creating and editing an App: the chart half of this extension.
 *
 * An app is its templates, and a template is a YAML file rather than a form, so this is
 * mostly an editor and a file list. `spec` is initialised here rather than defaulted in the
 * CRD, because a create form starts from an empty resource and every field below binds
 * straight into it.
 */
export default {
  name:         'CruApp',
  inheritAttrs: false,

  components: {
    CruResource,
    NameNsDescription,
    LabeledInput,
    ValuesEditor,
    FieldPicker,
    ImportResourceModal,
    YamlEditor,
    Tabbed,
    Tab,
    Banner,
    RcButton,
  },

  mixins: [CreateEditView],

  data() {
    if (!this.value.spec) {
      this.value.spec = {};
    }

    const spec = this.value.spec;

    if (!Array.isArray(spec.templates)) {
      spec.templates = [];
    }

    if (!spec.values) {
      spec.values = {};
    }

    // clusterTemplateKey remounts the YAML editor; see useDefaultClusterTemplate.
    // bodyView is which half of the template editor shows: the field picker or the raw YAML.
    return {
      selected: 0, clusterTemplateKey: 0, importing: false, bodyView: 'fields',
    };
  },

  computed: {
    /** The variables every template gets for free. See DOCUMENTED_VALUES for what is left out. */
    documentedValues() {
      return DOCUMENTED_VALUES;
    },

    /**
     * The keys the values editor offers: the parameters this app declares (see appVariables),
     * plus every `${...}` its templates mention that nothing declared.
     *
     * The second half is a suggestion, not a scrape into `substitute`: a hand-written
     * `${maxmemory}` shows up in the dropdown so declaring it is one click, while a script's
     * `${TOKEN}` appearing as an option someone ignores costs nothing. The cluster template is
     * included, because the app owns that too and defaulting something like `instanceType`
     * there is an ordinary thing to want. The built-ins are dropped - they are always
     * satisfied, so a default for `app` or `namespace` would shadow the real one.
     */
    valueKeys() {
      const found = new Set(appVariables(this.value, true));

      this.templates.forEach((template) => {
        referencedVariables(template?.content || '').forEach((name) => found.add(name));
      });

      return [...found]
        .filter((name) => !BUILT_IN_VALUES.includes(name))
        .sort();
    },

    /** See the note in edit/appsplus.io.appinstance.vue: one source of truth, not a copy. */
    values: {
      get() {
        return this.value.spec.values || {};
      },
      set(values) {
        this.value.spec.values = { ...values };
      },
    },

    templates() {
      return this.value.spec.templates;
    },

    /** What an import has to avoid reusing. See ImportResourceModal's takenValues. */
    valueNames() {
      return Object.keys(this.values || {});
    },

    current() {
      return this.templates[this.selected] || null;
    },

    /**
     * Variables the templates use that this app has no default for. Every instance has to
     * supply each of these, and adding one is what puts existing instances into a warning
     * state - so it is worth seeing while editing, not after saving.
     *
     * Both installation modes, because they owe different things: only a provisioning install
     * renders the cluster template, and only for one do the cluster defaults answer. Either
     * kind of installation being asked for a value is worth warning the definer about.
     */
    required() {
      return [...new Set([...requiredValues(this.value), ...requiredValues(this.value, true)])];
    },

    /**
     * Templates using `${...}` this app does not declare, shaped for the banner.
     *
     * Live, so declaring one (or toggling it off in the picker) clears its warning while the
     * form is still open. What it does not do is block saving: the `${...}` may be the file's
     * own syntax, and deploying it as written is a legitimate thing to mean.
     */
    undeclared() {
      return undeclaredWarnings(this.value);
    },

    validationPassed() {
      return !!this.value.metadata?.name;
    },
  },

  methods: {
    addTemplate() {
      this.templates.push(NEW_TEMPLATE());
      this.selected = this.templates.length - 1;
      // A brand-new template is empty, and the picker has no fields to offer until some YAML
      // exists - so a create starts in the editor rather than at a warning.
      this.bodyView = 'yaml';
    },

    /**
     * Take what the import produced and make it the template being edited.
     *
     * The values it suggests are merged under what is already there rather than over it: an app
     * that has already answered `replicas` said so deliberately, and an import is not a reason
     * to overwrite it. A file name that is already taken gets a number, because two templates
     * with one name is a save that silently keeps one of them.
     */
    addImported(imported) {
      const taken = new Set(this.templates.map((template) => template.name));
      let name = imported.name;

      for (let i = 2; taken.has(name); i++) {
        name = imported.name.replace(/\.yaml$/, `-${ i }.yaml`);
      }

      this.templates.push({ name, content: imported.content });
      this.selected = this.templates.length - 1;

      this.values = { ...imported.values, ...this.values };
      this.value.spec.valueLabels = { ...imported.labels, ...(this.value.spec.valueLabels || {}) };
    },

    removeTemplate(index) {
      this.templates.splice(index, 1);
      this.selected = Math.max(0, Math.min(this.selected, this.templates.length - 1));
    },

    updateContent(content) {
      if (this.current) {
        this.current.content = content;
      }
    },

    /**
     * Put the default template in the editor.
     *
     * The bump is what makes it appear. YamlEditor wraps CodeMirror, which takes its content
     * when it is created and does not watch the prop afterwards - so assigning the value alone
     * updated the model and left the box empty, and the button read as doing nothing at all.
     * Changing the key remounts the editor around the new content.
     */
    useDefaultClusterTemplate() {
      this.value.spec.clusterTemplate = DEFAULT_CLUSTER_TEMPLATE;
      this.clusterTemplateKey++;
    },
  },
};
</script>

<template>
  <CruResource
    ref="cru"
    :done-route="doneRoute"
    :mode="mode"
    :resource="value"
    :subtypes="[]"
    :validation-passed="validationPassed"
    :errors="errors"
    @error="e => errors = e"
    @finish="save"
    @cancel="done"
  >
    <NameNsDescription
      class="fill-row"
      :value="value"
      :mode="mode"
      :namespaced="false"
      :register-before-hook="registerBeforeHook"
    />

    <Tabbed :side-tabs="true">
      <Tab
        name="templates"
        :label="t('appsPlus.app.templates')"
        :weight="2"
      >
        <div class="template-editor">
          <div class="file-list">
            <ul>
              <li
                v-for="(template, i) in templates"
                :key="i"
                :class="{ active: i === selected }"
                @click="selected = i"
              >
                <span class="file-name">{{ template.name || '(unnamed)' }}</span>
                <i
                  v-if="!isView"
                  class="icon icon-x"
                  @click.stop="removeTemplate(i)"
                />
              </li>
            </ul>
            <!--
              Both tertiary. These are two ways of doing the same ordinary thing - putting a
              file in the list - and neither is the action of the page: that is Save, at the
              bottom, and it is the only thing here that should be wearing the accent colour.
            -->
            <div
              v-if="!isView"
              class="file-list__buttons"
            >
              <rc-button
                variant="tertiary"
                @click="addTemplate"
              >
                {{ t('appsPlus.app.addTemplate') }}
              </rc-button>
              <rc-button
                variant="tertiary"
                @click="importing = true"
              >
                {{ t('appsPlus.app.importTemplate') }}
              </rc-button>
            </div>
          </div>

          <div class="file-body">
            <template v-if="current">
              <LabeledInput
                v-model:value="current.name"
                :mode="mode"
                class="mb-10"
                :label="t('appsPlus.app.fileName')"
              />

              <!--
                The same two views a card in the builder drawer has, for the same reason:
                marking a field customizable on an app that already exists should not mean
                finding the line in the YAML and typing `${...}` by hand.
              -->
              <div
                v-if="!isView"
                class="body-tabs"
              >
                <button
                  v-for="tab in ['fields', 'yaml']"
                  :key="tab"
                  type="button"
                  :class="{ 'body-tabs__tab--on': bodyView === tab }"
                  class="body-tabs__tab"
                  @click="bodyView = tab"
                >
                  {{ t(tab === 'fields' ? 'appsPlus.fields.tab' : 'appsPlus.fields.yamlTab') }}
                </button>
              </div>

              <FieldPicker
                v-if="!isView && bodyView === 'fields'"
                :content="current.content"
                :values="values"
                :labels="value.spec.valueLabels || {}"
                class="picker-body"
                @update:content="updateContent"
                @update:values="v => values = v"
                @update:labels="v => value.spec.valueLabels = v"
              />
              <YamlEditor
                v-else
                :key="selected"
                :value="current.content"
                :mode="mode"
                :hide-preview-buttons="true"
                class="yaml"
                @update:value="updateContent"
              />
            </template>
            <Banner
              v-else
              color="warning"
              :label="t('appsPlus.app.noTemplates')"
            />
          </div>
        </div>

        <!-- Only on create: this page is the long way to an app, and somebody arriving here
             cold deserves to hear about the short one before they start typing YAML. -->
        <p
          v-if="isCreate"
          class="collect-hint text-muted"
        >
          {{ t('appsPlus.app.collectHint') }}
        </p>

        <!--
          Under the editor rather than above it: it is a reference somebody looks down at while
          typing, not something to read before starting.
        -->
        <div class="provided">
          <div class="provided__title">
            {{ t('appsPlus.app.provided') }}
          </div>
          <ul class="provided__list">
            <li
              v-for="value in documentedValues"
              :key="value.name"
            >
              <code>${{ '{' }}{{ value.name }}{{ '}' }}</code>
              <span class="provided__what">{{ value.what }}</span>
            </li>
          </ul>
        </div>
      </Tab>

      <Tab
        name="cluster"
        :label="t('appsPlus.app.clusterTemplate')"
        :weight="1"
      >
        <Banner
          color="info"
          :label="t('appsPlus.app.clusterTemplateHint')"
        />
        <YamlEditor
          :key="`cluster-template-${ clusterTemplateKey }`"
          :value="value.spec.clusterTemplate || ''"
          :mode="mode"
          :hide-preview-buttons="true"
          class="yaml"
          @update:value="v => value.spec.clusterTemplate = v"
        />
        <rc-button
          v-if="!isView && !value.spec.clusterTemplate"
          variant="secondary"
          class="mt-10"
          @click="useDefaultClusterTemplate"
        >
          {{ t('appsPlus.app.useDefaultCluster') }}
        </rc-button>
      </Tab>

      <Tab
        name="values"
        :label="t('appsPlus.app.values')"
        :weight="0"
        :error="!!undeclared.length"
      >
        <Banner
          v-for="reference in undeclared"
          :key="reference.file"
          color="warning"
          :label="t('appsPlus.values.undeclared', reference) + ' ' + t('appsPlus.values.undeclaredDeclareBelow')"
        />
        <Banner
          v-if="required.length"
          color="warning"
          :label="t('appsPlus.app.requiredValues', { keys: required.join(', ') })"
        />
        <!--
          Where parameters are declared. A key here is what makes `${key}` in a template mean
          something - the picker adds one per toggle, and this table is where a hand-written
          `${...}` gets declared and defaulted.
        -->
        <ValuesEditor
          v-model:value="values"
          :mode="mode"
          :keys="valueKeys"
          :labels="value.spec.valueLabels || {}"
          :placeholder="t('appsPlus.app.valueKeyPlaceholder')"
          @update:labels="v => value.spec.valueLabels = v"
        />
      </Tab>
    </Tabbed>

    <ImportResourceModal
      v-if="importing"
      :taken-values="valueNames"
      @close="importing = false"
      @imported="addImported"
    />
  </CruResource>
</template>

<style lang="scss" scoped>
/**
 * Name and Description across the whole row.
 *
 * NameNsDescription sizes its columns from `cols = 2 + (description ? 1 : 0)`, where the 2 is
 * "name and namespace" counted together - and it counts them whether or not `namespaced` is
 * false. This form is not namespaced, so it renders two fields and reserves width for three,
 * leaving a third of the row empty. Overriding the span here rather than asking the shell for
 * another prop: the arithmetic is right for every other caller.
 *
 * Flex shares, not `width: 50%`: the shell's `.col` carries a gutter margin, so two hard halves
 * total more than the row and the page grows a horizontal scrollbar. Growing into what is left
 * after the gutter cannot overflow.
 */
:deep(.fill-row) > .col {
  flex:  1 1 0;
  width: auto;
}

.body-tabs {
  display:       flex;
  gap:           2px;
  margin-bottom: 8px;
  border-bottom: 1px solid var(--border);

  &__tab {
    background:    none;
    border:        none;
    border-bottom: 2px solid transparent;
    color:         var(--muted);
    cursor:        pointer;
    font-size:     12px;
    padding:       6px 10px;

    &--on {
      color:        var(--body-text);
      border-color: var(--primary);
    }
  }
}

.picker-body {
  border:     1px solid var(--border);
  max-height: 480px;
  overflow:   auto;
}

.collect-hint {
  margin-top: 16px;
  margin-bottom: 0;
  font-size: 12px;
}

.provided {
  margin-top: 16px;
  font-size: 12px;
  color: var(--muted);

  &__title {
    font-weight: 600;
    margin-bottom: 4px;
  }

  &__list {
    list-style: none;
    margin: 0;
    padding: 0;

    li {
      display: flex;
      align-items: baseline;
      gap: 8px;
      padding: 1px 0;
    }

    code {
      flex: 0 0 auto;
    }
  }

  &__what {
    color: var(--muted);
  }
}

.template-editor {
  display: flex;
  gap: 16px;

  .file-list {
  &__buttons {
    display: flex;
    gap:     8px;
  }

    // A preferred width, not a claim: with the builder drawer open this whole form may have
    // ~700px, and a list that refuses to shrink passes the entire squeeze on to the field
    // picker beside it. The names ellipsize; the picker's inputs cannot.
    flex:      0 1 220px;
    min-width: 0;

    ul {
      list-style: none;
      margin: 0 0 10px 0;
      padding: 0;
    }

    li {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 8px;
      border: 1px solid var(--border);
      border-radius: var(--border-radius);
      margin-bottom: 4px;
      cursor: pointer;
      font-family: monospace;
      font-size: 12px;

      &.active {
        border-color: var(--primary);
        color: var(--primary);
      }

      .file-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    }
  }

  .file-body {
    flex: 1;
    min-width: 0;

    .yaml {
      min-height: 320px;
    }
  }
}
</style>
