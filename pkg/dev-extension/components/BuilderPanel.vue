<script>
import LabeledSelect from '@shell/components/form/LabeledSelect';
import { LabeledInput } from '@components/Form/LabeledInput';
import { Banner } from '@components/Banner';
import { RcButton } from '@components/RcButton';
import YamlEditor from '@shell/components/YamlEditor';
import FieldPicker from './FieldPicker';
import {
  APP, APP_INSTANCE, APP_QUERY, BLANK_CLUSTER, CREATE_ROUTE, DETAIL_ROUTE, PRODUCT_NAME
} from '../config/types';
import {
  builder, groupedTemplates, removeTemplate, clearStaged, danglingReferences, MIN_WIDTH
} from '../builder/state';
import { closeBuilder, resizeBuilder } from '../builder/overlay';

/**
 * Build an app out of resources you are already looking at.
 *
 * The drawer stays open across pages, so the flow is: pick an app (or make one), walk around
 * Rancher, use "Add to Application" wherever you see something that belongs, fix up what got
 * collected, and Save once.
 *
 * Nothing here writes to the cluster until Save. That is the point - a half-built App object left
 * behind by somebody who wandered off is worse than no App at all, and staging is what makes
 * editing the YAML before it exists possible.
 */
export default {
  name: 'BuilderPanel',

  components: {
    LabeledSelect, LabeledInput, Banner, RcButton, YamlEditor, FieldPicker
  },

  data() {
    return {
      builder,
      apps:      [],
      // Distinguishes "no apps exist" from "the list never arrived" - see loadApps.
      appsLoaded: false,
      expanded:  null,
      // Which half of an expanded card is showing: the fields, or the raw YAML.
      // 'fields' | 'yaml'
      view:      'fields',
      creating:  false,
      newName:   '',
      saving:    false,
      error:     '',
      // The app the last Save went into, so the banner can offer somewhere to go next.
      saved:     null,
      drag:      null,
      // A restored selection that no longer exists, kept so the banner can say which one.
      gone:      '',
      // Whether Clear has been pressed once and is waiting to be meant.
      confirmClear: false,
      confirmTimer: null,
      // The card being flashed to answer a re-add, and the timer that stops it.
      flashing:   '',
      flashTimer: null,
    };
  },

  async mounted() {
    await this.loadApps();

    // The selection comes back from localStorage, and the app it names may have been deleted
    // since. Restoring it anyway left the drawer reading "Building X" with Save enabled, and
    // pressing Save answered with a raw apiserver error - for doing nothing wrong. Checked
    // here rather than in restore(), because only the loaded list knows what exists.
    if (this.builder.app && this.appsLoaded && !this.selectedApp) {
      this.gone = this.builder.app;
      this.builder.app = '';
    }
  },

  beforeUnmount() {
    clearTimeout(this.confirmTimer);
    clearTimeout(this.flashTimer);
  },

  watch: {
    // Picking or creating an app is what resolves the "no longer exists" banner.
    'builder.app'(app) {
      if (app) {
        this.gone = '';
      }
    },

    /**
     * The check in mounted() covers a selection restored from storage; this covers the app
     * being deleted while the drawer is open. Watched rather than checked once, because the
     * name does not change when somebody deletes the app - the loaded list behind it does.
     */
    selectedApp(app) {
      if (!app && this.builder.app && this.appsLoaded) {
        this.gone = this.builder.app;
        this.builder.app = '';
      }
    },

    /**
     * A re-add stages nothing, so without this it is a click that visibly does nothing. The
     * state records which card already answers for the resource; this scrolls to it and
     * pulses it.
     */
    'builder.flash'(flash) {
      if (!flash?.name) {
        return;
      }

      this.flashing = flash.name;
      this.$nextTick(() => {
        this.$el.querySelector(`[data-template="${ CSS.escape(flash.name) }"]`)
          ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });

      clearTimeout(this.flashTimer);
      this.flashTimer = setTimeout(() => {
        this.flashing = '';
        this.builder.flash = null;
      }, 1600);
    },
  },

  computed: {
    groups() {
      return groupedTemplates();
    },

    /**
     * References each card makes that nothing staged satisfies, by template name.
     *
     * Computed over all of them at once so the YAML is parsed when something changes rather
     * than on every render of every card.
     */
    danglingByName() {
      const out = {};

      this.builder.templates.forEach((template) => {
        out[template.name] = danglingReferences(template);
      });

      return out;
    },

    appOptions() {
      return this.apps.map((app) => ({ label: app.metadata.name, value: app.metadata.name }));
    },

    /** The app being built, once it exists in the cluster. Null while a new one is being named. */
    selectedApp() {
      return this.apps.find((app) => app.metadata?.name === this.builder.app) || null;
    },

    canSave() {
      // The loaded app, not just a remembered name: Save dispatches a write to it, and a name
      // with nothing behind it turns Save into an apiserver error.
      return !!this.selectedApp && this.builder.templates.length > 0 && !this.saving;
    },

    style() {
      return { width: `${ this.builder.width }px` };
    },
  },

  methods: {
    async loadApps() {
      try {
        this.apps = await this.$store.dispatch('management/findAll', { type: APP });
        this.appsLoaded = true;
      } catch {
        // A load that failed says nothing about what exists, so neither the stale-selection
        // check in mounted() nor the selectedApp watcher may treat it as "no apps".
        this.apps = [];
        this.appsLoaded = false;
      }
    },

    close() {
      closeBuilder();
    },

    toggle(name) {
      this.expanded = this.expanded === name ? null : name;
    },

    dismissNotice(skipped) {
      this.builder.notices = this.builder.notices.filter((notice) => notice.skipped !== skipped);
    },

    remove(name) {
      removeTemplate(name);

      if (this.expanded === name) {
        this.expanded = null;
      }
    },

    // Wrapped rather than bound straight from the import: the template only reaches what is on
    // the instance, and `@click="clearStaged"` silently did nothing.
    //
    // Two presses, because what it throws away can be twenty minutes of walking around
    // Rancher and there is no undo. The first press only changes the button into a question;
    // ignoring it for a few seconds withdraws the question.
    clearAll() {
      if (!this.confirmClear) {
        this.confirmClear = true;
        this.confirmTimer = setTimeout(() => {
          this.confirmClear = false;
        }, 5000);

        return;
      }

      clearTimeout(this.confirmTimer);
      this.confirmClear = false;
      clearStaged();
      this.expanded = null;
      this.saved = null;
    },

    /**
     * Where Save leaves you.
     *
     * Collecting an app and installing it are one job done in two places, and the drawer used to
     * end at "Added 2 files" with no way through to either. These are that way through.
     */
    openApp() {
      this.$router.push({
        name:   DETAIL_ROUTE,
        params: {
          product: PRODUCT_NAME, cluster: BLANK_CLUSTER, resource: APP, id: this.saved.app
        },
      });
    },

    installApp() {
      this.$router.push({
        name:   CREATE_ROUTE,
        params: {
          product: PRODUCT_NAME, cluster: BLANK_CLUSTER, resource: APP_INSTANCE
        },
        query: { [APP_QUERY]: this.saved.app },
      });
    },

    updateContent(name, content) {
      const template = this.builder.templates.find((t) => t.name === name);

      if (template) {
        template.content = content;
      }
    },

    /**
     * Make an empty app to collect into.
     *
     * Created for real rather than staged, because the app is what everything else here is
     * selected against - a name that exists nowhere would leave the drawer pointing at nothing
     * and the Save button unable to say where it was saving to.
     */
    async createApp() {
      const name = (this.newName || '').trim();

      if (!name) {
        return;
      }

      this.saving = true;
      this.error = '';

      try {
        const app = await this.$store.dispatch('management/create', {
          type:     APP,
          metadata: { name },
          spec:     { templates: [], values: {} },
        });

        await app.save();
        await this.loadApps();

        this.builder.app = name;
        this.creating = false;
        this.newName = '';
      } catch (e) {
        this.error = e?.message || `Could not create ${ name }.`;
      } finally {
        this.saving = false;
      }
    },

    /**
     * Write what is staged into the selected app.
     *
     * Templates are appended rather than replacing what the app already has, and a name that
     * collides gets a number - adding to an app twice is the normal way this gets used, and the
     * second batch should not quietly delete the first.
     */
    async save() {
      this.saving = true;
      this.error = '';
      this.saved = null;

      try {
        const app = await this.$store.dispatch('management/find', {
          type: APP, id: this.builder.app, opt: { force: true },
        });

        const existing = app.spec?.templates || [];
        const taken = new Set(existing.map((template) => template.name));
        const added = this.builder.templates.map((template) => {
          let name = template.name;

          for (let i = 2; taken.has(name); i++) {
            name = template.name.replace(/\.yaml$/, `-${ i }.yaml`);
          }

          taken.add(name);

          return { name, content: template.content };
        });

        app.spec = {
          ...app.spec,
          templates:   [...existing, ...added],
          // Under what the app already has: a default somebody set outranks one an import guessed.
          values:      { ...this.builder.values, ...(app.spec?.values || {}) },
          valueLabels: { ...this.builder.labels, ...(app.spec?.valueLabels || {}) },
        };

        await app.save();

        this.saved = { app: this.builder.app, message: this.t('appsPlus.builder.saved', { count: added.length, app: this.builder.app }) };
        clearStaged();
        await this.loadApps();
      } catch (e) {
        this.error = e?.message || 'Could not save.';
      } finally {
        this.saving = false;
      }
    },

    // ---------------------------------------------------------------- resize

    onGrab(event) {
      this.drag = { startX: event.clientX, width: this.builder.width };
      window.addEventListener('mousemove', this.onDrag);
      window.addEventListener('mouseup', this.endGrab);
      event.preventDefault();
    },

    onDrag(event) {
      if (!this.drag) {
        return;
      }

      const width = this.drag.width + (event.clientX - this.drag.startX);

      resizeBuilder(Math.max(MIN_WIDTH, Math.min(width, window.innerWidth - 320)));
    },

    endGrab() {
      this.drag = null;
      window.removeEventListener('mousemove', this.onDrag);
      window.removeEventListener('mouseup', this.endGrab);
    },
  },
};
</script>

<template>
  <div
    v-if="builder.open"
    class="builder"
    :style="style"
  >
    <header class="builder__head">
      <span class="builder__title">{{ t('appsPlus.builder.title') }}</span>
      <RcButton
        variant="tertiary"
        :aria-label="t('generic.close')"
        @click="close"
      >
        {{ t('generic.close') }}
      </RcButton>
    </header>

    <div class="builder__app">
      <template v-if="creating">
        <LabeledInput
          v-model:value="newName"
          :label="t('appsPlus.builder.newApp')"
          :placeholder="t('appsPlus.builder.newAppPlaceholder')"
          @keyup.enter="createApp"
        />
        <div class="builder__row">
          <RcButton
            variant="tertiary"
            @click="creating = false"
          >
            {{ t('generic.cancel') }}
          </RcButton>
          <RcButton
            variant="secondary"
            :disabled="!newName.trim() || saving"
            @click="createApp"
          >
            {{ t('appsPlus.builder.create') }}
          </RcButton>
        </div>
      </template>

      <template v-else>
        <!--
          append-to-body off: mounted on <body> the menu hangs at a viewport position and
          stays put while the drawer scrolls under it. Inside the drawer it stacks in the
          drawer's own context and moves with the field it belongs to.
        -->
        <LabeledSelect
          v-model:value="builder.app"
          :options="appOptions"
          :searchable="true"
          :append-to-body="false"
          :label="t('appsPlus.builder.app')"
          :placeholder="t('appsPlus.builder.appPlaceholder')"
        />
        <RcButton
          variant="tertiary"
          class="mt-5"
          @click="creating = true"
        >
          {{ t('appsPlus.builder.newApp') }}
        </RcButton>
      </template>
    </div>

    <Banner
      v-if="gone"
      color="warning"
      :label="t('appsPlus.builder.appGone', { app: gone })"
    />
    <Banner
      v-else-if="!builder.app"
      color="info"
      :label="t('appsPlus.builder.pickFirst')"
    />
    <Banner
      v-if="error"
      color="error"
      :label="error"
    />
    <!-- A bulk add that dropped something must say so: "2 selected" quietly becoming one
         card reads as the add working, and the missing resource is only noticed on install. -->
    <Banner
      v-for="notice in builder.notices"
      :key="notice.skipped"
      color="warning"
      :closable="true"
      :label="t('appsPlus.builder.skipped', notice)"
      @close="dismissNotice(notice.skipped)"
    />
    <Banner
      v-if="saved"
      color="success"
    >
      <div class="builder__saved">
        <span>{{ saved.message }}</span>
        <span class="builder__next">
          <RcButton
            variant="tertiary"
            @click="openApp"
          >
            {{ t('appsPlus.builder.openApp') }}
          </RcButton>
          <RcButton
            variant="tertiary"
            @click="installApp"
          >
            {{ t('appsPlus.action.createInstance') }}
          </RcButton>
        </span>
      </div>
    </Banner>

    <div class="builder__list">
      <p
        v-if="!builder.templates.length"
        class="builder__empty"
      >
        {{ t('appsPlus.builder.empty') }}
      </p>

      <div
        v-for="group in groups"
        :key="group.kind"
        class="group"
      >
        <div class="group__kind">
          {{ group.kind }}
          <span class="group__count">{{ group.templates.length }}</span>
        </div>

        <div
          v-for="template in group.templates"
          :key="template.name"
          class="card"
          :class="{ 'card--open': expanded === template.name, 'card--flash': flashing === template.name }"
          :data-template="template.name"
        >
          <div class="card__row">
            <button
              class="card__head"
              type="button"
              @click="toggle(template.name)"
            >
              <i
                class="icon"
                :class="expanded === template.name ? 'icon-chevron-down' : 'icon-chevron-right'"
              />
              <span class="card__text">
                <span class="card__name">{{ template.name }}</span>
                <span
                  v-if="template.source"
                  class="card__source"
                >{{ template.source }}</span>
              </span>
            </button>

            <RcButton
              variant="tertiary"
              class="card__remove"
              @click="remove(template.name)"
            >
              {{ t('generic.remove') }}
            </RcButton>
          </div>

          <!-- Always visible, not only when expanded: a reference nothing here satisfies is
               the kind of thing that installs cleanly and fails a day later. -->
          <p
            v-for="ref in danglingByName[template.name]"
            :key="`${ template.name }-${ ref.kind }-${ ref.name }`"
            class="card__dangling"
          >
            <i class="icon icon-warning" />
            {{ t('appsPlus.builder.dangling', { kind: ref.kind, name: ref.name }) }}
          </p>

          <template v-if="expanded === template.name">
            <!--
              Fields first, YAML behind a switch. The YAML is the source of truth and always
              reachable, but it is not what somebody opening a card wants to read - they want
              the three lines of it that an installation will change.
            -->
            <div class="card__tabs">
              <button
                v-for="tab in ['fields', 'yaml']"
                :key="tab"
                type="button"
                :class="{ 'card__tab--on': view === tab }"
                class="card__tab"
                @click="view = tab"
              >
                {{ t(tab === 'fields' ? 'appsPlus.fields.tab' : 'appsPlus.fields.yamlTab') }}
              </button>
            </div>

            <FieldPicker
              v-if="view === 'fields'"
              :content="template.content"
              :values="builder.values"
              :labels="builder.labels"
              class="card__fields"
              @update:content="v => updateContent(template.name, v)"
              @update:values="v => builder.values = v"
              @update:labels="v => builder.labels = v"
            />

            <YamlEditor
              v-else
              :key="template.name"
              :value="template.content"
              :hide-preview-buttons="true"
              class="card__yaml"
              @update:value="v => updateContent(template.name, v)"
            />
          </template>
        </div>
      </div>
    </div>

    <footer class="builder__foot">
      <RcButton
        variant="tertiary"
        :disabled="!builder.templates.length"
        :class="{ 'builder__clear-confirm': confirmClear }"
        @click="clearAll"
      >
        {{ confirmClear ? t('appsPlus.builder.clearConfirm', { count: builder.templates.length }) : t('appsPlus.builder.clear') }}
      </RcButton>
      <RcButton
        variant="primary"
        :disabled="!canSave"
        @click="save"
      >
        {{ t('appsPlus.builder.save', { count: builder.templates.length }) }}
      </RcButton>
    </footer>

    <!-- The edge, four pixels wide, with no paint of its own so the border stays the only line. -->
    <div
      class="builder__grip"
      @mousedown="onGrab"
    />
  </div>
</template>

<style lang="scss" scoped>
.builder {
  position:       fixed;
  top:            0;
  left:           0;
  bottom:         0;
  // Above the page it borrows its width from, below every overlay the shell floats: modals
  // (53), dropdowns (55) and tooltips (57) all outrank it, so a confirm dialog is never
  // clipped behind the drawer's edge. The page itself cannot overlap either way - the
  // drawer's width is padding taken out of .dashboard-root, not paint over it.
  z-index:        50;
  display:        flex;
  flex-direction: column;
  background:     var(--body-bg);
  border-right:   1px solid var(--border);
  box-shadow:     0 0 18px var(--shadow, rgba(0, 0, 0, 0.25));

  &__head {
    display:         flex;
    align-items:     center;
    justify-content: space-between;
    padding:         12px 14px;
    border-bottom:   1px solid var(--border);
  }

  &__title { font-weight: 600; }

  &__app {
    padding:       12px 14px;
    border-bottom: 1px solid var(--border);
  }

  &__row {
    display:         flex;
    justify-content: flex-end;
    gap:             8px;
    margin-top:      8px;
  }

  &__list {
    flex:       1;
    overflow-y: auto;
    padding:    12px 14px;
  }

  &__saved {
    display:        flex;
    flex-direction: column;
    gap:            6px;
  }

  &__next {
    display: flex;
    gap:     8px;
  }

  &__empty {
    color:      var(--muted);
    font-size:  12px;
    text-align: center;
    margin-top: 24px;
  }

  &__foot {
    display:         flex;
    justify-content: space-between;
    gap:             8px;
    padding:         12px 14px;
    border-top:      1px solid var(--border);
  }

  // The question form of the Clear button. Colored like the loss it is about to cause, so the
  // second press is made knowingly. Doubled specificity because RcButton's own variant color
  // outranks a single class.
  &__foot &__clear-confirm.rc-button {
    color: var(--error);
  }

  &__grip {
    position: absolute;
    top:      0;
    bottom:   0;
    right:    -2px;
    width:    5px;
    cursor:   ew-resize;
    z-index:  2;
  }
}

.group {
  margin-bottom: 16px;

  &__kind {
    display:        flex;
    align-items:    center;
    gap:            6px;
    font-size:      11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color:          var(--muted);
    margin-bottom:  6px;
  }

  &__count {
    background:    var(--nav-bg);
    border-radius: 8px;
    padding:       0 6px;
  }
}

.card {
  border:        1px solid var(--border);
  border-radius: 4px;
  margin-bottom: 6px;
  position:      relative;

  &--open { background: var(--nav-bg); }

  // The answer to a re-add: the card the resource already has, pulsed instead of duplicated.
  &--flash {
    animation: card-flash 0.8s ease-in-out 2;
  }

  // The name and where it came from stack, so a long source truncates instead of pushing the
  // Remove button out of the card.
  &__row {
    display:     flex;
    align-items: center;
    gap:         4px;
    padding:     4px 6px 4px 8px;
  }

  &__head {
    display:     flex;
    align-items: center;
    gap:         8px;
    flex:        1;
    min-width:   0;
    padding:     4px 0;
    background:  none;
    border:      none;
    color:       inherit;
    cursor:      pointer;
    text-align:  left;
  }

  &__text {
    display:        flex;
    flex-direction: column;
    min-width:      0;
  }

  &__name {
    font-family: monospace;
    font-size:   12px;
  }

  &__source {
    color:         var(--muted);
    font-size:     11px;
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
  }

  &__remove { flex-shrink: 0; }

  &__dangling {
    margin:    0;
    padding:   2px 8px 4px 30px;
    font-size: 11px;
    color:     var(--warning);
  }

  /**
   * Capped, and scrolling inside itself.
   *
   * YamlEditor grows to its content, and a Deployment is a hundred lines - so one expanded card
   * pushed the group below it, the Save button and every other card off the bottom of a drawer
   * that is the height of the window. A card should stay a card.
   */
  &__yaml {
    height:      320px;
    max-height:  40vh;
    overflow:    auto;
    border-top:  1px solid var(--border);
  }

  &__fields {
    max-height: 44vh;
    overflow:   auto;
    border-top: 1px solid var(--border);
  }

  &__tabs {
    display:    flex;
    gap:        2px;
    padding:    0 6px;
    border-top: 1px solid var(--border);
  }

  &__tab {
    background:    none;
    border:        none;
    border-bottom: 2px solid transparent;
    color:         var(--muted);
    cursor:        pointer;
    font-size:     11px;
    padding:       6px 8px;

    &--on {
      color:         var(--body-text);
      border-color:  var(--primary);
    }
  }
}

@keyframes card-flash {
  50% {
    background:   var(--info-banner-bg, var(--info));
    border-color: var(--primary);
  }
}
</style>
