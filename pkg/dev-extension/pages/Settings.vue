<script>
// Settings: the one place a secret is set, generated from what declared it.
//
// Nothing here is written per key. The fields come from the declarations in templates.ts, global
// ones first and then one section per template, so adding a secret is a data change in the same
// way adding a template is. That is also what keeps this page and the sidecar cards agreeing
// about which keys exist.
//
// Three rules the store's shape imposes on this page:
//
//   - a stored value is not in the page until it is asked for. A field shows whether its key is
//     set, and the eye beside it fetches the value and shows it; pressing the eye again both
//     hides it and forgets it. So a page someone left open shows nothing to whoever walks past,
//     and the one thing a token is for - reading it, to paste it somewhere else - does not mean
//     clearing the key and finding it again elsewhere.
//   - saving writes only the fields that were touched, so opening this page and pressing Save
//     cannot blank a key nobody could see.
//   - the eye is a toggle on the box rather than a second copy of the value: once something has
//     been typed it is what the eye shows, because it is what Save will write.
//
// The claude login is on this page too, as an identity rather than a secret: who it is and
// whether it is still valid, never the token.
import Loading from '@shell/components/Loading';
import AsyncButton from '@shell/components/AsyncButton';
import { Banner } from '@components/Banner';
import { RcButton } from '@components/RcButton';
import { LabeledInput } from '@components/Form/LabeledInput';
import BrandImage from '@shell/components/BrandImage';
import {
  setSecretKeys, saveSecrets, secretValue, migrateGithubToken,
  listCloudCredentials, setCloudCredentialPropagate
} from '../api';
import { GLOBAL_SECRETS, SECRET_GROUPS } from '../secrets';
import { listApps } from '../apps';
import { readPrefs, savePrefs } from '../prefs';
import { DEV_PRODUCT, BLANK_CLUSTER, SKILLS_ROUTE } from '../config/constants';

export default {
  name: 'DevSettings',

  components: {
    Loading, AsyncButton, Banner, RcButton, LabeledInput, BrandImage
  },

  async fetch() {
    // The one-off `github-token` Secret is folded into the store here, on the page that owns the
    // store, and deleted. It is idempotent and does nothing on a cluster that never had one.
    await migrateGithubToken().catch(() => {});
    await this.refresh();
  },

  data() {
    return {
      keys:     [],
      // Every App, and which of them this person has hidden. See prefs.ts.
      apps:         [],
      hiddenApps:   [],
      hiddenSaved:  [],
      // The managing Rancher's cloud credentials, and which are set to propagate to new
      // provisioned instances. `credsSaved` is the on-disk state, to know what a Save changed.
      credentials:  [],
      credsSaved:   [],
      // The sections whose fields are showing. A card opens on its summary line, because what a
      // person comes here to know first is whether a template is configured at all.
      open:         {},
      // Written here rather than in the template: a moustache cannot contain the braces it is
      // made of, and escaping them in the markup is less readable than one string.
      // Key to the string typed into its field. A key that is not in here was not touched, and
      // is not written on Save. An empty field is never in here: clearing is what Clear is for.
      edits:    {},
      // Key to the stored value, for the keys whose eye has been pressed. Fetched then, not on
      // load, and dropped again when the eye closes.
      revealed: {},
      // Key to whether its box is showing plain text. Separate from `revealed` because a key
      // being typed into has nothing to fetch and still has something to show.
      shown:    {},
      error:    '',
      saved:    false,
    };
  },

  computed: {
    /** Where the Skills page is - a link here now, rather than its own shortcut in the rail. */
    skillsTo() {
      return { name: SKILLS_ROUTE, params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER } };
    },

    /**
     * The sections. One, now that templates are Apps Plus apps and carry their own values.
     *
     * A template with no declared secrets still gets a section, saying so, for the same reason
     * the sidebar shows a template with no workspaces: the set of templates is the map of what
     * this product can do, and a gap in it reads as something being broken.
     */
    sections() {
      const secrets = GLOBAL_SECRETS.map((secret) => this.field(secret, secret.key));

      return [
        {
          id:     'tokens',
          title:  'Tokens',
          help:   'Every token this product uses on your behalf, in one Secret of your own.',
          secrets,
          // A heading per group, in the order secrets.ts declares them, and only for the groups
          // that have a field: a heading over nothing reads as something having failed to load.
          groups: SECRET_GROUPS
            .map((group) => ({ ...group, secrets: secrets.filter((secret) => (secret.group || SECRET_GROUPS[0].id) === group.id) }))
            .filter((group) => group.secrets.length),
        },
      ];
    },
    writes() {
      return { ...this.edits };
    },

  },

  methods: {
    /** How many of a section's keys have a value, which is the card's summary line. */
    configured(section) {
      return section.secrets.filter((secret) => secret.set).length;
    },

    toggle(section) {
      this.open = { ...this.open, [section.id]: !this.open[section.id] };
    },

    /** One declaration, joined to whether the cluster has it. */
    appShown(app) {
      return !this.hiddenApps.includes(app.id);
    },

    setAppShown(app, shown) {
      this.hiddenApps = shown
        ? this.hiddenApps.filter((id) => id !== app.id)
        : [...new Set([...this.hiddenApps, app.id])];
    },

    appsChanged() {
      return [...this.hiddenApps].sort().join(',') !== [...this.hiddenSaved].sort().join(',');
    },

    async saveApps(done) {
      this.error = '';

      try {
        await savePrefs({ hiddenApps: this.hiddenApps });
        this.hiddenSaved = [...this.hiddenApps];
        done(true);
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },

    field(secret, key) {
      return {
        ...secret,
        storeKey: key,
        set:      this.keys.includes(key),
      };
    },

    async refresh() {
      const [keys, apps, prefs, credentials] = await Promise.all([
        setSecretKeys().catch(() => []),
        listApps(this.$store).catch(() => []),
        readPrefs().catch(() => ({ hiddenApps: [] })),
        listCloudCredentials().catch(() => []),
      ]);

      this.keys = keys;
      this.apps = apps.filter((app) => app.workspace);
      this.hiddenApps = [...prefs.hiddenApps];
      this.hiddenSaved = [...prefs.hiddenApps];
      this.credentials = credentials.map((cred) => ({ ...cred }));
      this.credsSaved = credentials.map((cred) => ({ ...cred }));
    },

    /** Toggle whether one credential propagates; the change is written on Save. */
    setCredPropagate(id, on) {
      this.credentials = this.credentials.map((cred) => (cred.id === id ? { ...cred, propagate: on } : cred));
    },

    /** Whether any credential's propagate choice differs from what is stored. */
    credsChanged() {
      const was = Object.fromEntries(this.credsSaved.map((cred) => [cred.id, cred.propagate]));

      return this.credentials.some((cred) => !!was[cred.id] !== !!cred.propagate);
    },

    /** Write only the credentials whose choice changed, so this touches nothing else. */
    async saveCreds(done) {
      this.error = '';
      this.saved = false;

      const was = Object.fromEntries(this.credsSaved.map((cred) => [cred.id, cred.propagate]));
      const changed = this.credentials.filter((cred) => !!was[cred.id] !== !!cred.propagate);

      try {
        for (const cred of changed) {
          await setCloudCredentialPropagate(cred.id, cred.propagate);
        }
        this.credsSaved = this.credentials.map((cred) => ({ ...cred }));
        this.saved = true;
        done(true);
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },

    /**
     * What an empty box shows.
     *
     * A key that is set shows a row of dots, which is what a filled password field looks like
     * everywhere else: the box is empty because the value is not in the page until the eye
     * fetches it, and a sentence saying so read as a field nobody had filled in. What it is and
     * how to replace it are on the line under the field, where the key and its state are.
     */
    placeholder(secret) {
      if (secret.set) {
        return '••••••••••••';
      }

      return secret.generated ? 'Generated when it is first needed' : 'Not set';
    },

    /**
     * What is in the box: what was typed, or the value the eye fetched, or nothing.
     *
     * A key whose eye is shut shows its placeholder rather than a row of dots standing in for a
     * value the page has not got. Typing wins over both, because it is what Save will write.
     */
    fieldValue(secret) {
      return this.edits[secret.storeKey] ?? (this.shown[secret.storeKey] ? this.revealed[secret.storeKey] ?? '' : '');
    },

    /** Whether there is anything to look at: a stored value, or something typed. */
    canReveal(secret) {
      return secret.set || !!this.edits[secret.storeKey];
    },

    /**
     * The eye.
     *
     * Opening it fetches the stored value, unless something has been typed - then the box
     * already holds what matters and there is nothing to fetch. Shutting it forgets the value
     * again, so a page left open on this tab is not a page holding a token.
     */
    async toggleShow(secret) {
      const key = secret.storeKey;

      if (this.shown[key]) {
        this.hide(secret);

        return;
      }

      this.error = '';

      try {
        if (!(key in this.edits)) {
          this.revealed = { ...this.revealed, [key]: await secretValue(key) };
        }
        this.shown = { ...this.shown, [key]: true };
      } catch (e) {
        this.error = e.message || String(e);
      }
    },

    hide(secret) {
      const revealed = { ...this.revealed };
      const shown = { ...this.shown };

      delete revealed[secret.storeKey];
      delete shown[secret.storeKey];
      this.revealed = revealed;
      this.shown = shown;
    },

    /**
     * Something was typed.
     *
     * An empty field is never a change, whatever it was a moment ago. Typing a character into a
     * field whose key is set and deleting it again used to leave an empty edit behind, and an
     * empty value is a deliberate clear, so one stray keystroke and a Save destroyed a token
     * nobody could see. Clearing has a button of its own; the field only ever sets a value.
     */
    edit(secret, value) {
      const edits = { ...this.edits };

      if (value === '') {
        delete edits[secret.storeKey];
      } else {
        edits[secret.storeKey] = value;
      }

      this.edits = edits;
    },

    /** An explicit clear, which is the only thing that writes an empty value. */

    /** Whether anything in one card was typed into, which is what its Save asks. */
    changedIn(section) {
      return section.secrets.some((secret) => secret.storeKey in this.edits);
    },

    /**
     * Save one card's keys, and only that card's.
     *
     * Each card has its own button, inside its own accordion, because that is where the fields
     * are: a single Save at the foot of the page is a button a long way from what it acts on, and
     * one that quietly writes the other cards' edits too. The store is still one Secret, so this
     * is a narrower write rather than a different one.
     */
    async save(section, done) {
      this.error = '';
      this.saved = false;

      const keys = section.secrets.map((secret) => secret.storeKey);
      const writes = Object.fromEntries(Object.entries(this.writes).filter(([key]) => keys.includes(key)));

      try {
        await saveSecrets(writes);

        // Only this card's, so an edit sitting in another card is not lost by saving this one.
        this.edits = Object.fromEntries(Object.entries(this.edits).filter(([key]) => !keys.includes(key)));
        this.revealed = {};
        this.shown = {};
        await this.refresh();
        this.saved = true;
        done(true);
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },
  },
};
</script>

<template>
  <Loading v-if="$fetchState.pending" />
  <div
    v-else
    class="dev-settings"
  >
    <div class="dev-settings__intro">
      <h1>Settings</h1>
      <p class="dev-settings__intro-sub">
        Every token this product uses, in one Kubernetes Secret of your own in the dev-system
        namespace. A stored value is fetched only when you press the eye beside it, and saving
        writes only the fields you changed.
      </p>
    </div>

    <!-- Skills lives here now rather than as a rail shortcut of its own: it is something you set
         up, like the secrets and the apps below it, not somewhere you go often. -->
    <router-link
      :to="skillsTo"
      class="dev-settings__skills"
    >
      <i class="icon icon-file dev-settings__skills-glyph" />
      <span class="dev-settings__skills-text">
        <span class="dev-settings__skills-title">Skills</span>
        <span class="dev-settings__skills-sub">View and edit the skills your agents run.</span>
      </span>
      <i class="icon icon-chevron-right dev-settings__skills-chev" />
    </router-link>

    <Banner
      v-if="error"
      color="error"
      :label="error"
    />
    <Banner
      v-else-if="saved"
      color="success"
      label="Saved."
    />

    <!--
      A card per template, the shape the harness's own settings page has: the template's mark and
      name, one line about what it is, and a summary of how many of its keys are set that opens
      the fields when you press it. A page of forty fields is one nobody reads; a page of three
      cards saying "5 keys configured" is one that answers the usual question without being
      opened at all.
    -->
    <section
      v-for="section in sections"
      :key="section.id"
      class="dev-settings__card"
    >
      <div class="dev-settings__card-head">
        <BrandImage
          v-if="section.logo"
          class="dev-settings__card-icon"
          :file-name="section.logo"
        />
        <i
          v-else
          class="dev-settings__card-icon icon"
          :class="section.icon || 'icon-gear'"
        />
        <div class="dev-settings__card-title">
          <h3>{{ section.title }}</h3>
          <p v-if="section.subtitle">
            {{ section.subtitle }}
          </p>
          <p
            v-if="section.meta"
            class="dev-settings__card-meta"
          >
            {{ section.meta }} &middot; {{ section.secrets.length }} keys
          </p>
        </div>
      </div>

      <button
        type="button"
        class="dev-settings__summary"
        @click="toggle(section)"
      >
        <i
          class="icon"
          :class="open[section.id] ? 'icon-chevron-down' : 'icon-chevron-right'"
        />
        {{ configured(section) }} of {{ section.secrets.length }} keys configured
      </button>

      <template v-if="open[section.id]">
        <p class="dev-settings__card-help">
          {{ section.help }}
        </p>

        <p
          v-if="!section.secrets.length"
          class="dev-settings__none"
        >
          This template declares no secrets.
        </p>

        <!--
          A heading per group, because these are not all the same kind of thing: the tokens that
          reach a service as you, and the ones that get a share a certificate. One Save writes
          them all, so they are headings in this card rather than cards of their own.
        -->
        <section
          v-for="group in section.groups"
          :key="group.id"
          class="dev-settings__group"
        >
          <h4 class="dev-settings__group-title">
            {{ group.title }}
          </h4>
          <p class="dev-settings__group-help">
            {{ group.help }}
          </p>

          <div
            v-for="secret in group.secrets"
            :key="secret.storeKey"
            class="dev-settings__field"
            :class="{ 'dev-settings__field--set': secret.set && !shown[secret.storeKey] }"
          >
            <!--
              Bound through a handler rather than with v-model, so a key is in `edits` only
              because something was typed into it. With v-model an input that emitted once on
              mount would put every key in there as an empty string, and an empty string is a
              deliberate clear.
            -->
            <LabeledInput
              :type="shown[secret.storeKey] ? 'text' : 'password'"
              :value="fieldValue(secret)"
              :label="secret.label"
              :placeholder="placeholder(secret)"
              @update:value="(value) => edit(secret, value)"
            >
              <!--
                The eye, where Rancher's own Password component puts it: in the field's suffix,
                flipping the input between password and text. A button rather than the link that
                used to be here, so it keeps the suffix's width whatever state it is in and the
                fields below it do not shift when one is opened.
              -->
              <template
                v-if="canReveal(secret)"
                #suffix
              >
                <button
                  type="button"
                  class="dev-settings__eye"
                  :title="shown[secret.storeKey] ? 'Hide' : 'Show'"
                  :aria-label="shown[secret.storeKey] ? `Hide ${ secret.label }` : `Show ${ secret.label }`"
                  @click.prevent.stop="toggleShow(secret)"
                >
                  <i
                    class="icon"
                    :class="shown[secret.storeKey] ? 'icon-hide' : 'icon-show'"
                  />
                </button>
              </template>
            </LabeledInput>
            <!--
              The help is a paragraph rather than LabeledInput's `sub-label`, because that slot
              is `position: absolute; top: 100%` with pointer events, so it hangs over whatever
              follows the field - and what follows is the line with the key on it. In flow it
              takes its own height and nothing sits underneath anything.
            -->
            <p class="dev-settings__help">
              {{ secret.help }}
            </p>
            <div class="dev-settings__row">
              <span class="dev-settings__key">{{ secret.storeKey }}</span>
              <span
                class="dev-settings__state"
                :class="{ 'dev-settings__state--set': secret.set }"
              >{{ secret.set ? 'Set' : 'Not set' }}</span>
              <span
                v-if="secret.required && !secret.set"
                class="dev-settings__pending"
              >Required</span>
              <span
                v-if="secret.generated"
                class="dev-settings__state"
              >Generated</span>
            </div>
          </div>
        </section>

        <div class="dev-settings__actions">
          <AsyncButton
            mode="apply"
            action-label="Save keys"
            :disabled="!changedIn(section)"
            @click="(done) => save(section, done)"
          />
        </div>
      </template>
    </section>

    <!--
      Which of the managing Rancher's cloud credentials a newly provisioned Rancher instance gets
      a copy of, so it can create clusters on the same clouds. The credentials are Rancher's own
      (Cluster Management > Cloud Credentials); this only chooses which propagate, and copies the
      chosen ones into each instance at provision time. Changing this does not touch instances
      that already exist.
    -->
    <section class="dev-settings__card">
      <div class="dev-settings__card-head">
        <i class="dev-settings__card-icon icon icon-globe" />
        <div class="dev-settings__card-title">
          <h3>Cloud credentials</h3>
          <p>Which cloud credentials new Rancher instances are given, so they can provision clusters.</p>
          <p class="dev-settings__card-meta">
            {{ credentials.filter((c) => c.propagate).length }} of {{ credentials.length }} propagated &middot; shared
          </p>
        </div>
      </div>
      <p
        v-if="!credentials.length"
        class="dev-settings__help"
      >
        This Rancher has no cloud credentials yet. Add them in Cluster Management &rsaquo; Cloud Credentials, then choose here which new instances receive.
      </p>
      <div
        v-if="credentials.length"
        class="dev-settings__list"
      >
        <label
          v-for="cred in credentials"
          :key="cred.id"
          class="dev-settings__app"
        >
          <input
            type="checkbox"
            :checked="cred.propagate"
            @change="(event) => setCredPropagate(cred.id, event.target.checked)"
          >
          <span class="dev-settings__app-name">{{ cred.name }}</span>
          <span class="dev-settings__app-desc">{{ cred.driver }}</span>
          <span class="dev-settings__card-meta">{{ cred.id }}</span>
        </label>
      </div>
      <div
        v-if="credentials.length"
        class="dev-settings__actions"
      >
        <AsyncButton
          mode="apply"
          action-label="Save credentials"
          :disabled="!credsChanged()"
          @click="saveCreds"
        />
      </div>
    </section>

    <!--
      Which Apps Plus apps to offer as templates. Every App in the cluster is one, and a cluster
      has Apps that are not for making workspaces from; the person says which, and the sidebar
      and the Create page show only those. A new App is shown until it is hidden.
    -->
    <section class="dev-settings__card">
      <div class="dev-settings__card-head">
        <i class="dev-settings__card-icon icon icon-apps" />
        <div class="dev-settings__card-title">
          <h3>Apps</h3>
          <p>Which Apps Plus apps to offer as workspace templates.</p>
          <p class="dev-settings__card-meta">
            {{ apps.length - hiddenApps.length }} of {{ apps.length }} shown &middot; yours alone
          </p>
        </div>
      </div>
      <p
        v-if="!apps.length"
        class="dev-settings__help"
      >
        There are no Apps Plus apps in this Rancher yet.
      </p>
      <div
        v-if="apps.length"
        class="dev-settings__list"
      >
        <label
          v-for="app in apps"
          :key="app.id"
          class="dev-settings__app"
        >
          <input
            type="checkbox"
            :checked="appShown(app)"
            @change="(event) => setAppShown(app, event.target.checked)"
          >
          <span class="dev-settings__app-name">{{ app.label }}</span>
          <span class="dev-settings__app-desc">{{ app.description }}</span>
          <span class="dev-settings__card-meta">{{ app.installations }} workspace{{ app.installations === 1 ? '' : 's' }}</span>
        </label>
      </div>
      <div class="dev-settings__actions">
        <AsyncButton
          mode="apply"
          action-label="Save apps"
          :disabled="!appsChanged()"
          @click="saveApps"
        />
      </div>
    </section>
  </div>
</template>

<style lang="scss" scoped>
  // One column, and everything on the page is that wide.
  //
  // The page used to measure its prose in `ch` and its cards in pixels, so the paragraphs ran
  // past the right edge of the cards under them and nothing on the page shared an edge with
  // anything else. A column the page keeps to is most of what makes a settings page look
  // deliberate: every card, every banner and every line of prose starts and ends in the same
  // two places.
  $col: 760px;

  .dev-settings {
    padding:    var(--dev-inset);
    overflow-y: auto;

    // Declared `block` on purpose: as a bare <header> this was laid out as a row by something
    // further up, which put the page's one line of prose beside the title instead of under it,
    // starting a long way right of the cards it describes.
    &__intro {
      display:       block;
      max-width:     $col;
      margin-bottom: var(--dev-space-5);

      h1 {
        margin-bottom: 0;
      }
    }

    // The page's own line under the title. Inside a card the prose is `__card-help`, which has
    // its own spacing; this one only ever sits under the h1.
    &__intro-sub {
      max-width: $col;
      margin:    var(--dev-space-2) 0 0 0;
      color:     var(--muted);
    }

    .banner {
      max-width: $col;
    }

    // ── A card ────────────────────────────────────────────────────────────────────────────────
    //
    // The harness's shape: a mark, a name, a line about it, and a summary that opens it. A page
    // of forty fields is one nobody reads; a page of three cards saying "5 keys configured"
    // answers the usual question without being opened at all.
    &__card {
      max-width:     $col;
      margin-bottom: var(--dev-space-5);
      padding:       var(--dev-space-5);
      border:        1px solid var(--border);
      border-radius: var(--border-radius);
    }

    &__card-head {
      display:     grid;
      // The glyph's column is the glyph's width, so every card's title starts at the same x.
      grid-template-columns: 28px 1fr;
      gap:         var(--dev-space-4);
      align-items: start;
    }

    &__card-icon {
      // Sized and centred in its column, and given the title's line box so the two share a
      // baseline rather than the glyph floating above a heading that is shorter than it.
      width:       28px;
      height:      28px;
      color:       var(--dev-accent);
      font-size:   24px;
      line-height: 28px;
      text-align:  center;
    }

    &__card-title {
      min-width: 0;

      h3 {
        margin:      0;
        line-height: 28px;
      }

      p {
        margin: var(--dev-space-1) 0 0 0;
        color:  var(--muted);
      }
    }

    &__card-meta {
      font-family: monospace;
      font-size:   12px;
      color:       var(--muted);
    }

    // The line inside an opened card, under the summary. Aligned with the fields below it
    // rather than indented to the title above, because what it describes is the fields.
    &__card-help {
      margin:    var(--dev-space-4) 0 0 0;
      color:     var(--muted);
      font-size: 13px;
    }

    // The summary line, which is a control rather than a heading: pressing it is what shows the
    // fields, and it says what someone came to find out before they press anything.
    &__summary {
      display:       flex;
      align-items:   center;
      gap:           var(--dev-space-3);
      width:         100%;
      min-height:    0;
      margin:        var(--dev-space-4) 0 0 0;
      padding:       var(--dev-space-3) var(--dev-space-4);
      border:        1px solid var(--border);
      border-radius: var(--border-radius);
      background:    transparent;
      color:         var(--body-text);
      font:          inherit;
      text-align:    left;
      cursor:        pointer;

      &:hover {
        background: var(--nav-hover, var(--accent-btn));
      }
    }

    // ── A group of fields inside a card ───────────────────────────────────────────────────────
    &__group {
      margin-top: var(--dev-space-5);

      // The rule sits above the heading rather than below it, so a group is visibly a division
      // of the card and not a label floating over the first field.
      & + & {
        padding-top: var(--dev-space-5);
        border-top:  1px solid var(--border);
      }
    }

    &__group-title {
      margin:         0;
      font-size:      12px;
      font-weight:    600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color:          var(--muted);
    }

    &__group-help {
      margin:    var(--dev-space-2) 0 0 0;
      color:     var(--muted);
      font-size: 12px;
    }

    // A set key's placeholder is a row of dots standing in for its value, so it is drawn in
    // the body colour rather than the muted one a hint would use. An unset one stays a hint.
    &__field--set :deep(input::placeholder) {
      color:   var(--body-text);
      opacity: 1;
    }

    // ── One field ─────────────────────────────────────────────────────────────────────────────
    &__field {
      margin-top: var(--dev-space-4);
    }

    // The key and its state on one line under the field, so the field itself is just a field
    // and everything about it is in one place. Baselines rather than centres: the key is
    // monospace and the words beside it are not, and centring two different fonts on their
    // boxes leaves them visibly off one another.
    &__row {
      display:         flex;
      align-items:     baseline;
      gap:             var(--dev-space-4);
      margin-top:      var(--dev-space-2);
      font-size:       12px;
    }

    &__help {
      max-width: 80ch;
      margin:    var(--dev-space-2) 0 0 0;
      color:     var(--muted);
      font-size: 12px;
    }

    &__key {
      color:       var(--muted);
      font-family: monospace;
    }

    &__state {
      color: var(--muted);

      &--set {
        color: var(--status-done);
      }
    }

    &__pending {
      color: var(--status-input);
    }

    &__none {
      margin: var(--dev-space-4) 0 0 0;
      color:  var(--muted);
    }

    // The eye in a field's suffix. Rancher's suffix slot is a flex cell of the input's own
    // frame, so this is a bare button that fills it and keeps the input's height.
    &__eye {
      display:         flex;
      align-items:     center;
      justify-content: center;
      width:           34px;
      align-self:      stretch;
      padding:         0;
      border:          none;
      background:      transparent;
      color:           var(--muted);
      cursor:          pointer;

      &:hover { color: var(--body-text); }

      &:focus-visible {
        outline:        2px solid var(--outline);
        outline-offset: -2px;
      }

      .icon { font-size: 16px; }
    }

    // ── The two checkbox lists ────────────────────────────────────────────────────────────────
    //
    // One grid for the whole list, with each row `display: contents`, so the four columns are
    // worked out once over every row. A grid per row - which is what this was - lets every row
    // choose its own column widths, and a list whose second column starts in a different place
    // on every line is the thing that reads as broken.
    &__list {
      display:               grid;
      grid-template-columns: max-content max-content 1fr max-content;
      align-items:           center;
      gap:                   var(--dev-space-2) var(--dev-space-4);
      margin-top:            var(--dev-space-4);
    }

    &__app {
      display: contents;
      cursor:  pointer;
    }

    &__app-name { font-weight: 600; }

    &__app-desc {
      min-width:     0;
      color:         var(--muted);
      overflow:      hidden;
      white-space:   nowrap;
      text-overflow: ellipsis;
    }

    // ── The Skills link ───────────────────────────────────────────────────────────────────────
    //
    // A card you press to leave, so it reads as one of the cards but shows it goes somewhere
    // with a chevron and lifts on hover.
    &__skills {
      display:         flex;
      align-items:     center;
      gap:             var(--dev-space-4);
      max-width:       $col;
      margin:          var(--dev-space-5) 0;
      padding:         var(--dev-space-4) var(--dev-space-5);
      border:          1px solid var(--border);
      border-radius:   var(--border-radius);
      color:           var(--body-text);
      text-decoration: none;

      &:hover { background: var(--nav-hover, var(--accent-btn)); }

      &-glyph { font-size: 20px; color: var(--muted); }
      &-text  { display: flex; flex-direction: column; flex: 1 1 auto; min-width: 0; }
      &-title { font-size: 14px; font-weight: 600; }
      &-sub   { font-size: 12px; color: var(--muted); }
      &-chev  { color: var(--muted); }
    }

    &__actions {
      display:    flex;
      margin-top: var(--dev-space-5);
    }
  }
</style>
