<script>
import ResourceTabs from '@shell/components/form/ResourceTabs';
import Tab from '@shell/components/Tabbed/Tab';
import { Banner } from '@components/Banner';
import { RcButton } from '@components/RcButton';
import { APP_INSTANCE } from '../config/types';
import { undeclaredWarnings } from '../render';

/** An app's templates, and the instances currently running them. */
export default {
  name: 'DetailApp',

  components: {
    ResourceTabs, Tab, Banner, RcButton
  },

  props: {
    value: {
      type:     Object,
      required: true,
    },
  },

  async fetch() {
    await this.$store.dispatch('management/findAll', { type: APP_INSTANCE });
  },

  computed: {
    templates() {
      return this.value.templates || [];
    },

    instances() {
      return this.value.instances || [];
    },

    /**
     * What an installation of this app gets to set, with the app's answer to each. This is the
     * question anybody deciding whether to install it is asking, and until it was here the only
     * way to answer it was to read the templates for `${...}`.
     */
    valueRows() {
      const values = this.value.spec?.values || {};
      const labels = this.value.spec?.valueLabels || {};

      return Object.keys(values).sort().map((name) => ({
        name,
        label:   labels[name] || '',
        default: values[name],
      }));
    },

    /**
     * Templates using `${...}` this app never declared, shaped for the banner.
     *
     * The other half of the declared model: without it, an app authored by hand shows "declares
     * no values" here while its rendered YAML says `${maxmemory}` - the same app describing
     * itself two different ways one tab apart.
     */
    undeclared() {
      return undeclaredWarnings(this.value);
    },
  },
};
</script>

<template>
  <div>
    <rc-button
      variant="secondary"
      class="mb-20"
      :to="value.createInstanceLocation"
    >
      {{ t('appsPlus.action.createInstance') }}
    </rc-button>

    <ResourceTabs :value="value">
      <Tab
        name="templates"
        :label="t('appsPlus.app.templates')"
        :weight="10"
      >
        <div
          v-for="file in templates"
          :key="file.name"
          class="rendered"
        >
          <div class="rendered__name">
            {{ file.name }}
          </div>
          <pre class="rendered__body">{{ file.content }}</pre>
        </div>
        <Banner
          v-if="!templates.length"
          color="warning"
          :label="t('appsPlus.app.noTemplates')"
        />
      </Tab>

      <Tab
        name="values"
        :label="t('appsPlus.app.values')"
        :weight="9.5"
        :error="!!undeclared.length"
      >
        <Banner
          v-for="reference in undeclared"
          :key="reference.file"
          color="warning"
        >
          {{ t('appsPlus.values.undeclared', reference) }}
          <router-link :to="value.editLocation">
            {{ t('appsPlus.values.undeclaredDeclareEdit', { app: value.nameDisplay }) }}
          </router-link>
        </Banner>
        <table
          v-if="valueRows.length"
          class="values-table"
        >
          <thead>
            <tr>
              <th>{{ t('appsPlus.values.key') }}</th>
              <th>{{ t('appsPlus.values.default') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in valueRows"
              :key="row.name"
            >
              <td>
                <div
                  v-if="row.label"
                  class="values-table__label"
                >
                  {{ row.label }}
                </div>
                <code>{{ row.name }}</code>
              </td>
              <td>
                <span v-if="String(row.default ?? '').trim() !== ''">{{ row.default }}</span>
                <span
                  v-else
                  class="text-muted"
                >{{ t('appsPlus.instance.valueNoDefault') }}</span>
              </td>
            </tr>
          </tbody>
        </table>
        <!-- Only when the templates truly answer for themselves: with an undeclared `${...}`
             on the books, "declares no values" would be this page contradicting its own
             warning. -->
        <Banner
          v-else-if="!undeclared.length"
          color="info"
          :label="t('appsPlus.values.none')"
        />
      </Tab>

      <Tab
        name="instances"
        :label="t('appsPlus.headers.instances')"
        :weight="9"
      >
        <ul class="instance-list">
          <li
            v-for="instance in instances"
            :key="instance.id"
          >
            <router-link :to="instance.detailLocation">
              {{ instance.nameDisplay }}
            </router-link>
            <span class="text-muted ml-10">{{ instance.targetDisplay }}</span>
          </li>
        </ul>
        <Banner
          v-if="!instances.length"
          color="info"
          :label="t('appsPlus.list.noInstances')"
        />
      </Tab>
    </ResourceTabs>
  </div>
</template>

<style lang="scss" scoped>
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

.instance-list {
  list-style: none;
  margin: 0;
  padding: 0;

  li {
    padding: 6px 0;
    border-bottom: 1px solid var(--border);
  }
}

.values-table {
  border-collapse: collapse;
  min-width: 50%;

  th {
    text-align: left;
    font-weight: 600;
    font-size: 12px;
    color: var(--muted);
    padding: 6px 24px 6px 0;
    border-bottom: 1px solid var(--border);
  }

  td {
    padding: 8px 24px 8px 0;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }

  &__label {
    font-weight: 600;
  }
}
</style>
