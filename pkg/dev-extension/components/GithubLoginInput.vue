<script>
/**
 * One GitHub login, typed or picked: an input with suggestions under it.
 *
 * The suggestions are the repository's collaborators first (collaboratorIdentities - who a team is
 * usually made of, filtered as you type) and then, from two characters on, a search of all of
 * GitHub for whoever they do not cover. Picking one is a click or the arrows and Enter; typing a
 * login and leaving is as good, because a teammate does not have to be anybody's collaborator.
 */
import { collaboratorIdentities, searchGithubUsers } from '../github';

const SHOWN = 8;

export default {
  name: 'GithubLoginInput',

  props: {
    value: {
      type:    String,
      default: '',
    },
    /** Logins chosen elsewhere in the same list, left out of the suggestions. */
    exclude: {
      type:    Array,
      default: () => [],
    },
    placeholder: {
      type:    String,
      default: 'GitHub login',
    },
    ariaLabel: {
      type:    String,
      default: 'GitHub login',
    },
  },

  emits: ['update:value'],

  data() {
    return {
      query:     this.value || '',
      open:      false,
      active:    -1,
      pool:      [],
      remote:    [],
      searching: false,
      timer:     null,
      asked:     '',
    };
  },

  computed: {
    suggestions() {
      const q = this.query.trim().replace(/^@/, '').toLowerCase();
      const taken = new Set(this.exclude.map((l) => String(l || '').toLowerCase()).filter((l) => l && l !== q));
      const fits = (i) => !taken.has(i.login.toLowerCase()) && (!q || i.login.toLowerCase().includes(q));
      const local = this.pool.filter(fits)
        .sort((a, b) => Number(!a.login.toLowerCase().startsWith(q)) - Number(!b.login.toLowerCase().startsWith(q)) || a.login.localeCompare(b.login));
      const known = new Set(local.map((i) => i.login.toLowerCase()));
      const more = this.remote.filter((i) => fits(i) && !known.has(i.login.toLowerCase()));

      return [...local, ...more].slice(0, SHOWN);
    },
  },

  watch: {
    value(v) {
      if ((v || '') !== this.query) {
        this.query = v || '';
      }
    },
  },

  mounted() {
    collaboratorIdentities().then((list) => {
      this.pool = list;
    });
    // A row just added is empty, and is where the person is about to type.
    if (!this.value) {
      this.$nextTick(() => this.$refs.input?.focus());
    }
  },

  beforeUnmount() {
    clearTimeout(this.timer);
  },

  methods: {
    onInput(event) {
      this.query = event.target.value;
      this.open = true;
      this.active = -1;
      this.$emit('update:value', this.query.trim().replace(/^@/, ''));
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.search(), 300);
    },

    async search() {
      const q = this.query.trim().replace(/^@/, '');

      // The collaborators cover it, or there is too little to look for.
      if (q.length < 2 || q === this.asked || this.suggestions.length >= SHOWN) {
        return;
      }
      this.asked = q;
      this.searching = true;
      try {
        const found = await searchGithubUsers(q);

        if (this.asked === q) {
          this.remote = found;
        }
      } finally {
        this.searching = false;
      }
    },

    pick(identity) {
      this.query = identity.login;
      this.open = false;
      this.active = -1;
      this.$emit('update:value', identity.login);
    },

    onKey(event) {
      const n = this.suggestions.length;

      if (event.key === 'ArrowDown' && n) {
        event.preventDefault();
        this.open = true;
        this.active = (this.active + 1) % n;
      } else if (event.key === 'ArrowUp' && n) {
        event.preventDefault();
        this.active = this.active <= 0 ? n - 1 : this.active - 1;
      } else if (event.key === 'Enter' && this.open && this.active >= 0 && this.suggestions[this.active]) {
        event.preventDefault();
        this.pick(this.suggestions[this.active]);
      } else if (event.key === 'Escape' && this.open) {
        event.stopPropagation();
        this.open = false;
      }
    },

    focus() {
      this.$refs.input?.focus();
    },
  },
};
</script>

<template>
  <div
    class="gh-login"
    data-testid="github-login-input"
  >
    <input
      ref="input"
      :value="query"
      type="text"
      autocomplete="off"
      spellcheck="false"
      role="combobox"
      :aria-label="ariaLabel"
      :aria-expanded="open && suggestions.length > 0"
      aria-autocomplete="list"
      :placeholder="placeholder"
      @input="onInput"
      @focus="open = true"
      @blur="open = false"
      @keydown="onKey"
    >
    <ul
      v-if="open && (suggestions.length || searching)"
      class="gh-login__menu"
      role="listbox"
    >
      <li
        v-for="(identity, i) in suggestions"
        :key="identity.login"
        class="gh-login__item"
        :class="{ 'gh-login__item--active': i === active }"
        role="option"
        :aria-selected="i === active"
        data-testid="github-login-option"
        @mousedown.prevent="pick(identity)"
        @mouseenter="active = i"
      >
        <img
          v-if="identity.avatar"
          class="gh-login__avatar"
          :src="`${ identity.avatar }${ identity.avatar.includes('?') ? '&' : '?' }s=40`"
          alt=""
          @error="$event.target.style.visibility = 'hidden'"
        >
        <span class="gh-login__name">{{ identity.login }}</span>
        <span
          v-if="identity.from === 'collaborator'"
          class="gh-login__note"
        >collaborator</span>
      </li>
      <li
        v-if="searching"
        class="gh-login__item gh-login__item--note"
      >
        <i class="icon icon-spinner icon-spin" /> Looking on GitHub…
      </li>
    </ul>
  </div>
</template>

<style lang="scss" scoped>
.gh-login {
  position: relative;
  width:    100%;

  input { width: 100%; }

  &__menu {
    position:      absolute;
    top:           calc(100% + 2px);
    left:          0;
    right:         0;
    z-index:       30;
    max-height:    280px;
    margin:        0;
    padding:       4px 0;
    overflow-y:    auto;
    list-style:    none;
    border:        1px solid var(--dropdown-border);
    border-radius: var(--border-radius);
    background:    var(--dropdown-bg);
    box-shadow:    0 6px 18px rgba(0, 0, 0, 0.18);
  }

  &__item {
    display:     flex;
    align-items: center;
    gap:         8px;
    padding:     6px 10px;
    color:       var(--dropdown-text);
    font-size:   13px;
    cursor:      pointer;

    &--active { background: var(--dropdown-hover-bg); }

    &--note {
      color:  var(--muted);
      cursor: default;
    }
  }

  &__avatar {
    flex:          0 0 20px;
    width:         20px;
    height:        20px;
    border-radius: 50%;
  }

  &__name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }

  &__note {
    color:     var(--muted);
    font-size: 11px;
  }
}
</style>
