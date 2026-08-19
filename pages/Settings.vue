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
//   - a stored value is never rendered back into its field. The field shows whether the key is
//     set and offers to replace or clear it, so a page someone left open cannot leak a token to
//     whoever walks past.
//   - saving writes only the fields that were touched, so opening this page and pressing Save
//     cannot blank a key nobody could see.
//   - a generated secret is different in kind, and this is the deliberate exception to the rule
//     above rather than an oversight in it. The rule exists so that a value someone entrusted to
//     this page cannot be read back out of it; a value the product invented was never anyone's
//     secret, and a password you cannot read is a password you cannot log in with. So: never
//     render back what a person typed, always allow reading what the product generated. Those
//     fields say they are generated rather than pretending someone chose them.
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
  setSecretKeys, saveSecrets, secretValue, migrateGithubToken, templateSecretKey,
  listPrompts, savePrompts as writePrompts
} from '../api';
import { TEMPLATES, GLOBAL_SECRETS } from '../templates';

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
      // The prompts a queued conversation opens on, and the edits made to them. Separate from
      // the secret edits because these are read back after they are saved, and a secret is not.
      prompts:      [],
      promptEdits:  {},
      // The sections whose fields are showing. A card opens on its summary line, because what a
      // person comes here to know first is whether a template is configured at all.
      open:         {},
      // Written here rather than in the template: a moustache cannot contain the braces it is
      // made of, and escaping them in the markup is less readable than one string.
      placeholders: '{{repo}} {{pr}} {{issue}} {{title}} {{url}}',
      // Key to the string typed into its field. A key that is not in here was not touched, and
      // is not written on Save. An empty field is never in here: clearing is what Clear is for.
      edits:    {},
      // Key to the value of a generated secret, once Show has been pressed for it.
      revealed: {},
      error:    '',
      saved:    false,
    };
  },

  computed: {
    /**
     * The sections, in the order the spec asks for them: global first, then one per template.
     *
     * A template with no declared secrets still gets a section, saying so, for the same reason
     * the sidebar shows a template with no workspaces: the set of templates is the map of what
     * this product can do, and a gap in it reads as something being broken.
     */
    sections() {
      return [
        {
          id:      'global',
          title:   'Global',
          help:    'Secrets that belong to the product rather than to any one template.',
          secrets: GLOBAL_SECRETS.map((secret) => this.field(secret, secret.key)),
        },
        ...TEMPLATES.map((template) => ({
          id:      template.id,
          title:   template.label,
          // The card's own identity, so a template reads as the thing it is rather than as a
          // heading over some fields. The harness's settings card does the same: a mark, a name,
          // a line about what it is, and the identifier under it.
          icon:    template.icon,
          logo:    template.logo,
          // A short line rather than the description's first sentence, which is a paragraph in
          // its own right: this is the line under a name on a card, and it has one line of room.
          subtitle: `${ template.label } dev environment`,
          meta:    template.id,
          help:    `Stored under the ${ template.id }. prefix, so two templates can each have a key of the same name.`,
          secrets: (template.secrets || []).map((secret) => this.field(secret, templateSecretKey(template.id, secret.key))),
        })),
      ];
    },

    /** What Save will write: the fields that were typed into, and the keys Clear was pressed on. */
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

    /** What is in a prompt's box: the edit if there is one, and what is stored otherwise. */
    promptText(prompt) {
      return this.promptEdits[prompt.id] ?? prompt.text;
    },

    /** Whether anything has actually been typed, which is what Save is enabled by. */
    promptsChanged() {
      return this.prompts.some((prompt) => this.promptText(prompt) !== prompt.text);
    },

    /**
     * Save the prompts that changed, and nothing else.
     *
     * The same rule the secrets above follow: a field nobody touched is not written, so two
     * people saving different things do not overwrite each other's untouched ones.
     */
    async savePrompts(done) {
      const changed = Object.fromEntries(this.prompts
        .filter((prompt) => this.promptText(prompt) !== prompt.text)
        .map((prompt) => [prompt.id, this.promptText(prompt)]));

      try {
        await writePrompts(changed);
        await this.refresh();
        done(true);
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },

    /** One declaration, joined to whether the cluster has it. */
    field(secret, key) {
      return {
        ...secret,
        storeKey: key,
        set:      this.keys.includes(key),
      };
    },

    async refresh() {
      const [keys, prompts] = await Promise.all([
        setSecretKeys().catch(() => []),
        listPrompts().catch(() => []),
      ]);

      this.prompts = prompts;
      this.promptEdits = {};

      this.keys = keys;
    },

    placeholder(secret) {
      if (secret.set) {
        return 'Set. Type to replace it.';
      }

      return secret.generated ? 'Generated when it is first needed' : 'Not set';
    },

    /**
     * What is in the box: what was typed, or the revealed value, or nothing.
     *
     * A secret that has not been revealed shows its placeholder rather than a row of dots for a
     * value the page does not have. Typing wins over both, because it is what will be saved.
     */
    fieldValue(secret) {
      return this.edits[secret.storeKey] ?? this.revealed[secret.storeKey] ?? '';
    },

    async toggleReveal(secret) {
      if (this.revealed[secret.storeKey]) {
        this.hide(secret);

        return;
      }

      try {
        this.revealed = { ...this.revealed, [secret.storeKey]: await secretValue(secret.storeKey) };
      } catch (e) {
        this.error = e.message || String(e);
      }
    },

    hide(secret) {
      const revealed = { ...this.revealed };

      delete revealed[secret.storeKey];
      this.revealed = revealed;
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
    <header>
      <h1>Settings</h1>
      <p class="subheader">
        Every secret this product uses, in one Kubernetes Secret of your own in the dev-system
        namespace. A value is never shown again after it is saved, and saving writes only the
        fields you changed.
      </p>
    </header>

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
        <p class="subheader">
          {{ section.help }}
        </p>

        <p
          v-if="!section.secrets.length"
          class="dev-settings__none"
        >
          This template declares no secrets.
        </p>

        <div
        v-for="secret in section.secrets"
        :key="secret.storeKey"
        class="dev-settings__field"
      >
        <!--
          Bound through a handler rather than with v-model, so a key is in `edits` only because
          something was typed into it. With v-model an input that emitted once on mount would put
          every key in there as an empty string, and an empty string is a deliberate clear.
        -->
        <!--
          The value lives in the box, revealed or not, which is where Rancher puts a password:
          its own Password component is a LabeledInput whose type flips between password and text
          from a link in the suffix slot, and this is that arrangement with one difference. The
          value of a generated secret is not in the page until Show is pressed, because it is
          fetched then; a typed one is never offered back at all.
        -->
        <LabeledInput
          :type="revealed[secret.storeKey] ? 'text' : 'password'"
          :value="fieldValue(secret)"
          :label="secret.label"
          :placeholder="placeholder(secret)"
          @update:value="(value) => edit(secret, value)"
        >
          <template
            v-if="secret.generated && secret.set"
            #suffix
          >
            <div class="addon">
              <a
                href="#"
                @click.prevent.stop="toggleReveal(secret)"
              >{{ revealed[secret.storeKey] ? 'Hide' : 'Show' }}</a>
            </div>
          </template>
        </LabeledInput>
        <!--
          The help is a paragraph rather than LabeledInput's `sub-label`, because that slot is
          `position: absolute; top: 100%` with pointer events, so it hangs over whatever follows
          the field. Here that is the row of controls, and Clear and Show were unclickable behind
          it. In flow it takes its own height and nothing sits underneath anything.
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
      The prompts a queued conversation opens on. They are per person and they are text, so they
      are edited here rather than declared: see prompts.ts, which holds the defaults and what a
      placeholder in one can stand for.
    -->
    <section class="dev-settings__card">
      <div class="dev-settings__card-head">
        <i class="dev-settings__card-icon icon icon-comment" />
        <div class="dev-settings__card-title">
          <h3>Conversation prompts</h3>
          <p>What a conversation queued from My Work opens on.</p>
          <p class="dev-settings__card-meta">
            {{ prompts.length }} prompts &middot; yours alone
          </p>
        </div>
      </div>

      <div
        v-for="prompt in prompts"
        :key="prompt.id"
        class="dev-settings__field"
      >
        <label class="dev-settings__prompt-label">{{ prompt.label }}</label>
        <p class="dev-settings__help">
          {{ prompt.help }}
        </p>
        <textarea
          class="dev-settings__prompt"
          rows="6"
          spellcheck="false"
          :value="promptText(prompt)"
          @input="(event) => promptEdits = { ...promptEdits, [prompt.id]: event.target.value }"
        />
      </div>

      <p class="dev-settings__help">
        <code>{{ placeholders }}</code> are filled in from the row the action was pressed on.
        Anything else is left as it is written.
      </p>

      <div class="dev-settings__actions">
        <AsyncButton
          mode="apply"
          action-label="Save prompts"
          :disabled="!promptsChanged()"
          @click="savePrompts"
        />
      </div>
    </section>

  </div>
</template>

<style lang="scss" scoped>
  .dev-settings {
    padding:   var(--dev-space-5);
    overflow-y: auto;

    header {
      margin-bottom: var(--dev-space-5);

      h1 {
        margin-bottom: 0;
      }
    }

    .subheader {
      max-width: 90ch;
      margin:    var(--dev-space-2) 0 var(--dev-space-4) 0;
      color:     var(--muted);
    }

    &__section {
      margin-top: var(--dev-space-6);
      max-width:  90ch;
    }

    &__field {
      margin-top: var(--dev-space-5);
    }

    // The key, its state and its controls on one line under the field, so the field itself is
    // just a field and everything about it is in one place.
    &__row {
      display:     flex;
      align-items: center;
      gap:         var(--dev-space-4);
      margin-top:  var(--dev-space-2);
      font-size:   12px;
    }

    &__help {
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
        color: var(--success);
      }
    }


    &__pending {
      color: var(--warning);
    }

    &__none {
      color: var(--muted);
    }

    // The card, which is the harness's: a mark, a name, a line, and a summary that opens it.
    &__card {
      max-width:     720px;
      margin-bottom: var(--dev-space-5);
      padding:       var(--dev-space-5);
      border:        1px solid var(--border);
      border-radius: var(--border-radius);
    }

    &__card-head {
      display:     flex;
      gap:         var(--dev-space-4);
      align-items: flex-start;
    }

    &__card-icon {
      flex:      0 0 32px;
      width:     32px;
      height:    32px;
      color:     var(--primary);
      font-size: 28px;
    }

    &__card-title {
      flex:      1 1 auto;
      min-width: 0;

      h3 {
        margin: 0;
      }

      p {
        margin: var(--dev-space-1) 0 0 0;
        color:  var(--muted);
      }
    }

    &__card-meta {
      font-family: monospace;
      font-size:   12px;
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

    &__prompt-label {
      display:     block;
      margin-top:  var(--dev-space-4);
      font-weight: 600;
    }

    &__prompt {
      display:       block;
      width:         100%;
      padding:       var(--dev-space-3) var(--dev-space-4);
      border:        1px solid var(--border);
      border-radius: var(--border-radius);
      background:    var(--body-bg);
      color:         var(--body-text);
      font-family:   monospace;
      font-size:     12px;
      resize:        vertical;
    }

    &__actions {
      display:    flex;
      margin-top: var(--dev-space-5);
    }
  }
</style>
