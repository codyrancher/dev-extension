<script>
import CreateEditView from '@shell/mixins/create-edit-view';
import CruResource from '@shell/components/CruResource';
import NameNsDescription from '@shell/components/form/NameNsDescription';
import LabeledSelect from '@shell/components/form/LabeledSelect';
import { LabeledInput } from '@components/Form/LabeledInput';
import Tabbed from '@shell/components/Tabbed';
import Tab from '@shell/components/Tabbed/Tab';
import { Banner } from '@components/Banner';
import { Checkbox } from '@components/Form/Checkbox';
import {
  APP, APP_INSTANCE, FLEET_CLUSTER, APP_QUERY, DEFAULT_TARGET_NAMESPACE
} from '../config/types';
import { NAMESPACE } from '@shell/config/types';
import {
  renderTemplates, missingValues, appVariables, undeclaredWarnings, isSet, BUILT_IN_VALUES
} from '../render';

/**
 * Creating and editing an AppInstance: pick an app, pick clusters, override values.
 *
 * The clusters offered are Fleet's, not Rancher's management ones, because Fleet is what
 * deploys this and a Bundle target names a Fleet Cluster. On this Rancher that is `local` in
 * the fleet-local workspace; a downstream cluster registered with Fleet appears here too,
 * with no change to this page.
 *
 * Nothing here writes the Bundle. Saving the instance does, in the model - so a YAML edit or
 * an import deploys exactly as this form does.
 */
export default {
  name:         'CruAppInstance',
  inheritAttrs: false,

  components: {
    CruResource,
    NameNsDescription,
    LabeledSelect,
    LabeledInput,
    Tabbed,
    Tab,
    Banner,
    Checkbox,
  },

  mixins: [CreateEditView],

  async fetch() {
    this.apps = await this.$store.dispatch('management/findAll', { type: APP });
    this.clusters = await this.$store.dispatch('management/findAll', { type: FLEET_CLUSTER });

    // Both only feed the namespace suggestions, and neither is worth failing the form over: a
    // person who cannot list namespaces can still type one, which is what taggable is for.
    //
    // The management store, not the cluster store. This product declares `inStore: 'management'`
    // because it owns no cluster, so nothing has ever put a cluster in scope here and
    // `cluster/findAll` comes back empty - which left the list holding only the namespaces
    // other installations happened to mention.
    this.namespaces = await this.$store.dispatch('management/findAll', { type: NAMESPACE }).catch(() => []);
    this.instances = await this.$store.dispatch('management/findAll', { type: APP_INSTANCE }).catch(() => []);
  },

  data() {
    if (!this.value.spec) {
      this.value.spec = {};
    }

    const spec = this.value.spec;

    // The list's per-app "Create Instance" button arrives here with the app in the query, so
    // the form opens already pointed at the group it was pressed in.
    if (!spec.app && this.$route.query?.[APP_QUERY]) {
      spec.app = this.$route.query[APP_QUERY];
    }

    if (!Array.isArray(spec.targets)) {
      spec.targets = [];
    }

    if (!spec.values) {
      spec.values = {};
    }

    if (!spec.provisionCluster) {
      spec.provisionCluster = { enabled: false };
    }

    return {
      apps:     [],
      clusters: [],
      namespaces: [],
      instances:  [],
    };
  },

  computed: {
    appOptions() {
      return this.apps.map((app) => ({
        label: app.nameDisplay,
        value: app.metadata?.name,
      }));
    },

    clusterOptions() {
      return this.clusters.map((cluster) => ({
        label: cluster.metadata?.name,
        value: cluster.metadata?.name,
      }));
    },

    /**
     * Namespaces to suggest for the target namespace.
     *
     * Two sources, because neither is complete on its own. The local cluster's own namespaces
     * are readable from here and are the right answer whenever `local` is a target. Everything
     * every other installation already deploys into is the rest: it is the only evidence this
     * page has about a downstream cluster, whose namespaces a global product cannot list.
     *
     * Suggestions, not a constraint - the field is taggable. A namespace that does not exist
     * yet is an ordinary thing to type here, since Fleet creates it on the way in.
     */
    namespaceOptions() {
      const found = new Set();

      this.namespaces.forEach((namespace) => found.add(namespace.metadata?.name));
      this.instances.forEach((instance) => {
        if (instance.spec?.namespace) {
          found.add(instance.spec.namespace);
        }
      });
      found.delete(undefined);

      return [...found].sort();
    },

    selectedApp() {
      return this.apps.find((app) => app.metadata?.name === this.value.spec.app) || null;
    },

    provisions: {
      get() {
        return !!this.value.spec.provisionCluster?.enabled;
      },
      set(enabled) {
        this.value.spec.provisionCluster = {
          ...(this.value.spec.provisionCluster || {}),
          enabled,
        };

        // An instance that brings its own cluster deploys to that one and nothing else, so the
        // targets it may have had are cleared rather than left to disagree with the switch.
        if (enabled) {
          this.value.spec.targets = [];
        }
      },
    },

    clusterName: {
      get() {
        return this.value.spec.provisionCluster?.name || '';
      },
      set(name) {
        this.value.spec.provisionCluster = {
          ...(this.value.spec.provisionCluster || {}),
          name,
        };
      },
    },

    /** Two-way over spec.targets, which is a list of objects rather than the list of names
     * a multi-select works in. */
    targetNames: {
      get() {
        return (this.value.spec.targets || []).map((target) => target.clusterName);
      },
      set(names) {
        this.value.spec.targets = (names || []).map((clusterName) => ({ clusterName }));
      },
    },

    placeholderNamespace() {
      return DEFAULT_TARGET_NAMESPACE;
    },

    /** What this instance would deploy, rendered as it will be written into the Bundle. */
    preview() {
      if (!this.selectedApp) {
        return [];
      }

      return renderTemplates(this.selectedApp, this.value);
    },

    /**
     * The instance's values, edited in place.
     *
     * Deliberately a computed over `spec.values` rather than a data copy kept in step by a
     * watcher: the copy is a second source of truth, and KeyValue emitting its own state back
     * would silently overwrite anything written to the copy from elsewhere.
     */
    values: {
      get() {
        return this.value.spec.values || {};
      },
      set(values) {
        this.value.spec.values = { ...values };
      },
    },

    /**
     * Of those, the ones still unanswered here. This is what the form highlights and what
     * blocks saving: an instance saved without them could not be rendered.
     */
    missing() {
      return missingValues(this.selectedApp, this.value);
    },

    /**
     * The keys this installation can actually override, offered as a list.
     *
     * The parameters the app declares - see appVariables. Without it the values editor is two
     * free-text boxes and the only way to learn what goes in the left one is to open the app and
     * read its YAML - and a key that is a letter out is not an error, it is a value that is
     * silently never used.
     *
     * The cluster template's variables are in the list only when this installation provisions a
     * cluster, for the same reason `missing` counts them only then: an installation deploying to
     * clusters that already exist never renders it.
     *
     * The four the pair knows about itself are dropped. They are always satisfied, so overriding
     * `instance` or `namespace` here would be shadowing something with itself.
     */
    valueKeys() {
      if (!this.selectedApp) {
        return [];
      }

      return appVariables(this.selectedApp, this.provisions)
        .filter((name) => !BUILT_IN_VALUES.includes(name))
        .sort();
    },

    /**
     * `${...}` in the app's templates that no declared value answers, shaped for the banner.
     *
     * The installer cannot fix these - declaring a parameter is the definer's move - but the
     * one thing worse than a value that cannot be set is a form saying "no values to set" one
     * tab away from a preview full of `${maxmemory}`. So the form says what will happen: the
     * text deploys exactly as written.
     */
    undeclared() {
      return undeclaredWarnings(this.selectedApp);
    },

    /** What the app answers a value with when this installation says nothing. */
    appDefaults() {
      return this.selectedApp?.spec?.values || {};
    },

    /** The words the app's definer chose for each value, when they chose any. */
    appLabels() {
      return this.selectedApp?.spec?.valueLabels || {};
    },

    /**
     * One row per thing this installation can set.
     *
     * A field each, rather than a key/value grid: the app has already decided which values
     * exist, so asking somebody to pick a key from a dropdown before they can answer it is
     * asking them to do the app's remembering. The default is the placeholder, so a row that is
     * left alone visibly says what it is going to deploy with.
     *
     * Keys already overridden here that the templates no longer mention are kept and marked
     * rather than dropped, so a value that stops being used is something somebody decides about
     * instead of something that disappears.
     */
    valueRows() {
      const names = new Set(this.valueKeys);

      Object.keys(this.values).forEach((name) => names.add(name));

      return [...names].sort().map((name) => ({
        name,
        label:   this.appLabels[name] || '',
        current: this.values[name] ?? '',
        // A declared value with an empty default is a value with no default: the key exists
        // because declaring it is what creates the parameter, not because '' answers it.
        default: isSet(this.appDefaults, name) ? this.appDefaults[name] : undefined,
        stale:   !this.valueKeys.includes(name),
      }));
    },

    validationPassed() {
      return !!this.value.metadata?.name && !!this.value.spec.app && !this.missing.length;
    },

    /** What the instance will actually deploy to, however it was chosen. */
    effectiveTargets() {
      if (this.provisions) {
        return [this.clusterName || this.value.metadata?.name || ''];
      }

      return this.targetNames;
    },
  },

  methods: {
    /**
     * Set one value, or clear it.
     *
     * Blank removes the key rather than storing an empty string, because the instance's values
     * are spread over the app's when rendering - so an empty override does not mean "no
     * override", it means "override it with nothing", and the app's default silently stops
     * applying. Blank has to be the way back to the default, since it is the only thing the
     * field can be emptied to.
     */
    setValue(name, entered) {
      const values = { ...this.values };

      if (entered === '' || entered === undefined || entered === null) {
        delete values[name];
      } else {
        values[name] = entered;
      }

      this.values = values;
    },

    isMissing(name) {
      return this.missing.includes(name);
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
    <!--
      No description. An installation is named after what it is a deployment of and where it
      goes, and both are on this form already; a free-text box under them was one more thing to
      fill in that nothing reads back. The App keeps its description, because that is the thing
      somebody else has to recognise in a list.
    -->
    <!--
      What this installation is, on one row. `extra-columns` names a slot NameNsDescription
      renders as a column of its own, which is how the app select gets to sit beside the name
      rather than on a line by itself - and the two of them are the whole of "which app, called
      what", so they belong together.
    -->
    <NameNsDescription
      class="fill-row"
      :value="value"
      :mode="mode"
      :namespaced="false"
      :description-hidden="true"
      :extra-columns="['app']"
      :register-before-hook="registerBeforeHook"
    >
      <template #app>
        <LabeledSelect
          v-model:value="value.spec.app"
          :mode="mode"
          :options="appOptions"
          :label="t('appsPlus.instance.app')"
          :tooltip="t('appsPlus.instance.appHint')"
          required
        />
      </template>
    </NameNsDescription>

    <!--
      And where it goes. A heading and a rule, because the checkbox below changes what the two
      fields under it even are - without something to sit inside, it reads as a stray option
      between unrelated inputs rather than as the switch for the section it governs.
    -->
    <div class="section">
      <h3 class="section__title">
        {{ t('appsPlus.instance.destination') }}
      </h3>

      <Checkbox
        v-model:value="provisions"
        class="mb-20"
        :mode="mode"
        :label="t('appsPlus.instance.provision')"
        :tooltip="t('appsPlus.instance.provisionHint')"
      />

      <!--
        The left column is what changes: a cluster to make, or clusters that already exist. The
        namespace is the same question either way - which namespace on the far side does this
        deploy into - so it is rendered once and stays put rather than appearing twice.

        Cluster before namespace, because what the namespace field offers depends on it: a
        namespace is a namespace *on a cluster*, and asking for one first is asking somebody to
        remember. `taggable` because the list can only ever be a suggestion - a namespace Fleet
        is about to create does not exist yet, which is always the case for a cluster this is
        about to provision, and only the local cluster's namespaces can be read from a global
        product at all.
      -->
      <div class="row">
        <div class="col span-6">
          <LabeledInput
            v-if="provisions"
            v-model:value="clusterName"
            :mode="mode"
            :label="t('appsPlus.instance.clusterName')"
            :tooltip="t('appsPlus.instance.clusterNameHint')"
            :placeholder="value.metadata.name || t('appsPlus.instance.clusterNamePlaceholder')"
          />
          <LabeledSelect
            v-else
            v-model:value="targetNames"
            :mode="mode"
            :options="clusterOptions"
            :multiple="true"
            :label="t('appsPlus.instance.targets')"
            :tooltip="t('appsPlus.instance.targetsHint')"
          />
        </div>
        <div class="col span-6">
          <LabeledSelect
            v-model:value="value.spec.namespace"
            :mode="mode"
            :options="namespaceOptions"
            :taggable="true"
            :searchable="true"
            :label="t('appsPlus.instance.namespace')"
            :tooltip="t('appsPlus.instance.namespaceHint')"
            :placeholder="placeholderNamespace"
          />
        </div>
      </div>
    </div>

    <Banner
      v-if="missing.length"
      color="warning"
      :label="t('appsPlus.instance.missingValuesSummary', { keys: missing.join(', ') })"
    />

    <Banner
      v-if="provisions"
      color="warning"
      :label="t('appsPlus.instance.provisionWarning')"
    />
    <Banner
      v-else-if="!targetNames.length"
      color="warning"
      :label="t('appsPlus.instance.noTargets')"
    />

    <!-- The gap is the tabs' own, not a banner's: with every warning satisfied the rail was
         riding the section border above it. -->
    <Tabbed
      :side-tabs="true"
      class="instance-tabs"
    >
      <Tab
        name="values"
        :label="t('appsPlus.instance.values')"
        :weight="2"
        :error="!!missing.length"
      >
        <Banner
          v-if="!selectedApp"
          color="warning"
          :label="t('appsPlus.instance.noApp')"
        />
        <template v-else>
          <Banner
            v-for="reference in undeclared"
            :key="reference.file"
            color="warning"
          >
            {{ t('appsPlus.values.undeclared', reference) }}
            <router-link
              v-if="selectedApp.editLocation"
              :to="selectedApp.editLocation"
            >
              {{ t('appsPlus.values.undeclaredDeclareEdit', { app: selectedApp.nameDisplay }) }}
            </router-link>
          </Banner>
          <!-- "No values to set" only when nothing undeclared lurks in the templates: saying
               it beside the warning above would be the form contradicting itself. -->
          <Banner
            v-if="!valueRows.length && !undeclared.length"
            color="info"
            :label="t('appsPlus.instance.noValues')"
          />
          <Banner
            v-else-if="valueRows.length"
            color="info"
            :label="t('appsPlus.instance.valuesHint')"
          />
        </template>

        <!--
          One field per value, in the order the app names them, with the app's default as the
          placeholder. A row nobody touches deploys with what the placeholder says.
        -->
        <div class="values">
          <div
            v-for="row in valueRows"
            :key="row.name"
            class="values__row"
          >
            <LabeledInput
              :value="row.current"
              :mode="mode"
              :label="row.label || row.name"
              :required="row.default === undefined && !row.stale"
              :placeholder="row.default === undefined ? t('appsPlus.instance.valueNoDefault') : String(row.default)"
              @update:value="v => setValue(row.name, v)"
            />
            <!-- The key under the label, so a label never hides which `${...}` a row answers. -->
            <p
              v-if="row.label && row.label !== row.name"
              class="values__note"
            >
              <code>{{ row.name }}</code>
            </p>
            <p
              v-if="row.stale || row.default === undefined"
              class="values__note values__note--warning"
            >
              {{ row.stale ? t('appsPlus.values.unused', { key: row.name }) : t('appsPlus.instance.valueMissing') }}
            </p>
          </div>
        </div>
      </Tab>

      <Tab
        v-if="provisions"
        name="cluster"
        :label="t('appsPlus.instance.clusterPreview')"
        :weight="1"
      >
        <Banner
          color="info"
          :label="t('appsPlus.instance.clusterPreviewHint')"
        />
        <div class="rendered">
          <div class="rendered__name">
            {{ clusterName || value.metadata.name }}
          </div>
          <pre class="rendered__body">{{ value.renderedClusterTemplate }}</pre>
        </div>
      </Tab>

      <Tab
        name="preview"
        :label="t('appsPlus.instance.preview')"
        :weight="0"
      >
        <Banner
          color="info"
          :label="t('appsPlus.instance.previewHint')"
        />
        <Banner
          v-if="!selectedApp"
          color="warning"
          :label="t('appsPlus.instance.noApp')"
        />
        <div
          v-for="file in preview"
          :key="file.name"
          class="rendered"
        >
          <div class="rendered__name">
            {{ file.name }}
          </div>
          <pre class="rendered__body">{{ file.content }}</pre>
        </div>
      </Tab>
    </Tabbed>
  </CruResource>
</template>

<style lang="scss" scoped>
/**
 * Name and App as two real halves.
 *
 * NameNsDescription sizes its columns from `cols = 2 + description + extraColumns`, where the 2
 * is "name and namespace" counted together whether or not `namespaced` is false. This form is
 * not namespaced and has one extra column, so it renders two fields and reserves width for
 * three. The arithmetic is right for every other caller; the override is here.
 *
 * Flex shares, not `width: 50%`: the shell's `.col` carries a gutter margin, so two hard halves
 * total more than the row and the page grows a horizontal scrollbar. Growing into what is left
 * after the gutter cannot overflow.
 */
:deep(.fill-row) > .col {
  flex:  1 1 0;
  width: auto;
}

/**
 * Where the installation goes.
 *
 * A rule and a heading rather than a box: the fields inside are the same fields as above and
 * should look it. What the grouping buys is that the checkbox has something to govern - it
 * swaps the two inputs underneath, and on a flat form that swap looks like the page changing
 * its mind.
 */
.instance-tabs {
  margin-top: 20px;
}

.section {
  margin-top:     8px;
  padding-top:    20px;
  border-top:     1px solid var(--border);

  &__title {
    margin-bottom: 12px;
    font-size:     14px;
  }
}

.values {
  display:               grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap:                   16px;
  margin-top:            10px;

  // Under the field rather than in a tooltip: what the app defaults a value to is the answer to
  // "what happens if I leave this alone", and that is the question every row raises.
  &__note {
    margin:    4px 0 0;
    font-size: 12px;
    color:     var(--muted);
  }

  &__note--warning { color: var(--warning); }
}

.rendered {
  margin-bottom: 16px;

  &__name {
    font-family: monospace;
    font-size: 12px;
    padding: 6px 10px;
    background: var(--nav-bg);
    border: 1px solid var(--border);
    border-bottom: none;
    border-radius: var(--border-radius) var(--border-radius) 0 0;
  }

  &__body {
    margin: 0;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: 0 0 var(--border-radius) var(--border-radius);
    overflow-x: auto;
  }
}
</style>
