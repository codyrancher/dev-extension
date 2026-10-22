<script>
// The reviewers of a pull request, as GitHub draws them: the list, a gear that opens a picker,
// and a filter with the repository's collaborators under it.
//
// What this replaces was one text input with a `<datalist>`. A datalist is the browser's
// typeahead, not a menu: it shows no state, so a login already asked looked exactly like one
// never asked; it cannot be browsed, so "who can I ask" had no answer until you had typed a
// letter that happened to match; and it only ever added, so taking a request back meant going to
// GitHub. The thing being copied here is GitHub's own panel, because this column exists so that
// a pull request can be run without opening GitHub, and a reviewer is the commonest reason to.
//
// Presentational apart from the two writes it owns (request and remove). It reports what it did
// through `changed` rather than re-reading the pull request itself: the page that owns the detail
// decides when to read GitHub again.
import { requestReviewers, removeReviewers, reviewerPool } from '../../github';

/** GitHub's own ceiling on one pull request, and what its panel says. */
const MAX = 15;

export default {
  name: 'Reviewers',

  props: {
    repo: {
      type:     String,
      required: true,
    },

    pr: {
      type:     Number,
      required: true,
    },

    /** Requested and not yet reviewed - the ones a request can be taken back from. */
    asked: {
      type:    Array,
      default: () => [],
    },

    /** Has reviewed and approved. Shown with the rest; re-asking one is a fresh request. */
    approved: {
      type:    Array,
      default: () => [],
    },

    /** `{ who, why }` - the people who already know this change. Drawn above the rest. */
    suggested: {
      type:    Array,
      default: () => [],
    },

    /** The pull request's author, who GitHub refuses a review request from. Left out entirely. */
    author: {
      type:    String,
      default: '',
    },
  },

  emits: ['changed', 'error'],

  data() {
    return {
      open:   false,
      filter: '',
      /** The repository's collaborators, read when the picker is first opened. */
      pool:   [],
      loading: false,
      /** The login being asked or un-asked right now, so its row can say so and not be pressed twice. */
      busy:   '',
      /** Which row the keyboard is on, as an index into `choices`. */
      active: 0,
      top:    0,
      left:   0,
      width:  0,
    };
  },

  computed: {
    /** GitHub's ceiling, for the panel's heading. A constant is not on the component. */
    max() {
      return MAX;
    },

    /**
     * The list above the picker: who has approved, then who is still being waited on.
     *
     * Approved first because it is the answer to the question the list is read for - is this
     * reviewed - and because an approval is a fact where a request is only a hope.
     */
    rows() {
      return [
        ...this.approved.map((who) => ({ who, state: 'approved' })),
        ...this.asked.filter((who) => !this.approved.includes(who)).map((who) => ({ who, state: 'awaiting' })),
      ];
    },

    /** Everyone this pull request already involves, for the ticks in the picker. */
    on() {
      return new Set([...this.asked, ...this.approved]);
    },

    /**
     * The picker's rows: the suggestions first, then everybody else, each matching the filter.
     *
     * The suggestions keep their reason ("already commented on the diff") because that is the
     * part GitHub cannot tell you - its own panel ranks by who owns the files, which on a
     * dashboard this size is most of the team. Anyone already asked stays in the list rather
     * than disappearing from it: the tick beside them is how the panel says they are on it, and
     * pressing them again is how a request comes off.
     */
    choices() {
      const needle = this.filter.trim().replace(/^@/, '').toLowerCase();
      const matches = (who) => !needle || who.toLowerCase().includes(needle);
      const suggested = this.suggested
        .map((s) => ({ who: String(s.who || ''), why: String(s.why || '') }))
        .filter((s) => s.who && s.who !== this.author && matches(s.who));
      const named = new Set(suggested.map((s) => s.who));
      const rest = [...new Set([...this.pool, ...this.asked, ...this.approved])]
        .filter((who) => who && who !== this.author && !named.has(who) && matches(who))
        .sort((a, b) => a.localeCompare(b))
        .map((who) => ({ who, why: '' }));

      /*
       * A login nobody here has heard of, offered only once nothing else matches.
       *
       * The field this replaces was free text, and somebody outside the collaborators - another
       * team's reviewer, a bot account - could always be named; losing that would be a step
       * back. But offering it alongside the matches makes a mess of typing: three letters into
       * `richard-cox` the panel would show that row and an "ask anyway" row for `ric`. Nothing
       * matching is the only moment the typed name is what was meant.
       */
      const typed = this.filter.trim().replace(/^@/, '');
      const unknown = typed && !suggested.length && !rest.length
        ? [{ who: typed, why: 'not a collaborator - ask anyway' }]
        : [];

      return [...suggested, ...rest, ...unknown];
    },

    full() {
      return this.rows.length >= MAX;
    },
  },

  watch: {
    // The highlighted row is an index into a list the filter rewrites, so it goes back to the
    // top with every keystroke: a stale index is the keyboard asking for somebody who is no
    // longer on screen.
    filter() {
      this.active = 0;
    },
  },

  beforeUnmount() {
    this.unbind();
  },

  methods: {
    togglePanel() {
      return this.open ? this.close() : this.show();
    },

    /**
     * Open the picker under the gear.
     *
     * Fixed to the viewport and measured off the trigger, the way SMenu does it: this column
     * scrolls and the panel would otherwise be clipped by it. Its width follows the block rather
     * than the gear, so the logins have room.
     */
    show() {
      const anchor = this.$refs.block?.getBoundingClientRect();

      if (!anchor) {
        return;
      }
      this.top = anchor.bottom + 4;
      this.left = anchor.left;
      this.width = Math.max(260, Math.min(360, anchor.width));
      this.filter = '';
      this.active = 0;
      this.open = true;
      this.loadPool();
      this.$nextTick(() => {
        const panel = this.$refs.panel;

        if (panel && this.top + panel.offsetHeight > window.innerHeight - 8) {
          this.top = Math.max(8, anchor.top - panel.offsetHeight - 4);
        }
        this.$refs.search?.focus?.();
      });
      document.addEventListener('keydown', this.onKey, true);
      document.addEventListener('mousedown', this.onOutside, true);
    },

    close() {
      if (!this.open) {
        return;
      }
      this.open = false;
      this.unbind();
    },

    unbind() {
      document.removeEventListener('keydown', this.onKey, true);
      document.removeEventListener('mousedown', this.onOutside, true);
    },

    onKey(e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.close();
        this.$refs.trigger?.focus?.();

        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const last = this.choices.length - 1;

        if (last < 0) {
          return;
        }
        this.active = Math.min(last, Math.max(0, this.active + (e.key === 'ArrowDown' ? 1 : -1)));
        this.$nextTick(() => this.$refs.panel?.querySelector('.reviewers__choice--active')?.scrollIntoView({ block: 'nearest' }));

        return;
      }
      if (e.key === 'Enter' && this.choices[this.active]) {
        e.preventDefault();
        this.toggle(this.choices[this.active].who);
      }
    },

    onOutside(e) {
      if (!this.$refs.panel?.contains(e.target) && !this.$refs.block?.contains(e.target)) {
        this.close();
      }
    },

    async loadPool() {
      if (this.pool.length || this.loading) {
        return;
      }
      this.loading = true;
      this.pool = await reviewerPool(this.repo).catch(() => []);
      this.loading = false;
    },

    /**
     * Ask somebody, or take the request back - whichever this row is not already.
     *
     * The panel stays open. GitHub's does too, and for the same reason: picking reviewers is
     * usually picking more than one, and a panel that shut after each would have to be reopened
     * between them.
     */
    async toggle(who) {
      const login = String(who || '').trim().replace(/^@/, '');

      if (!login || this.busy) {
        return;
      }
      const remove = this.asked.includes(login);

      if (!remove && this.full) {
        this.$emit('error', `A pull request takes at most ${ MAX } reviewers.`);

        return;
      }
      this.busy = login;
      try {
        if (remove) {
          await removeReviewers(this.repo, this.pr, [login]);
        } else {
          const { refused } = await requestReviewers(this.repo, this.pr, [login]);

          if (refused[login]) {
            throw new Error(refused[login]);
          }
        }
        // What the list should now be, so the page it is on can show it without waiting for a
        // read of the whole pull request.
        this.$emit('changed', remove
          ? this.asked.filter((name) => name !== login)
          : [...this.asked, login]);
        this.filter = '';
      } catch (e) {
        this.$emit('error', `${ login } could not be ${ remove ? 'removed' : 'asked' }: ${ e?.message || e }`);
      } finally {
        this.busy = '';
      }
    },

    initial(who) {
      return String(who || '?').slice(0, 1).toUpperCase();
    },
  },
};
</script>

<template>
  <div
    ref="block"
    class="reviewers"
  >
    <!-- The heading and the one control, as GitHub has them: the gear is the way in. -->
    <div class="reviewers__head">
      <span class="reviewers__label">Reviewers</span>
      <button
        ref="trigger"
        type="button"
        class="reviewers__gear"
        :class="{ 'reviewers__gear--on': open }"
        :aria-label="open ? 'Close the reviewer picker' : 'Request reviewers'"
        :aria-expanded="open ? 'true' : 'false'"
        aria-haspopup="listbox"
        @click.stop="togglePanel"
      >
        <i class="icon icon-gear" />
      </button>
    </div>

    <ul
      v-if="rows.length"
      class="reviewers__list"
    >
      <li
        v-for="row in rows"
        :key="row.who"
        class="reviewers__row"
      >
        <span class="reviewers__avatar">{{ initial(row.who) }}</span>
        <a
          class="reviewers__who"
          :href="`https://github.com/${ row.who }`"
          target="_blank"
          rel="noopener noreferrer"
        >{{ row.who }}</a>
        <span
          class="reviewers__state"
          :class="`reviewers__state--${ row.state }`"
          :title="row.state === 'approved' ? 'Approved these changes' : 'Has not reviewed yet'"
        >
          <i :class="row.state === 'approved' ? 'icon icon-checkmark' : 'icon icon-dot-open'" />
        </span>
        <!--
          Taking a request back, on the row. Only for a request that is outstanding: an approval
          is not a request any more, and GitHub has nothing to remove.
        -->
        <button
          v-if="asked.includes(row.who)"
          type="button"
          class="reviewers__drop"
          :disabled="!!busy"
          :aria-label="`Stop asking ${ row.who }`"
          :title="`Stop asking ${ row.who }`"
          @click="toggle(row.who)"
        >
          <i :class="busy === row.who ? 'icon icon-spinner icon-spin' : 'icon icon-close'" />
        </button>
      </li>
    </ul>
    <p
      v-else
      class="reviewers__none"
    >
      No reviews
    </p>

    <Teleport to="body">
      <div
        v-if="open"
        ref="panel"
        class="reviewers__panel"
        :style="{ top: `${ top }px`, left: `${ left }px`, width: `${ width }px` }"
        role="listbox"
        aria-label="Request reviewers"
      >
        <div class="reviewers__panel-head">Request up to {{ max }} reviewers</div>
        <input
          ref="search"
          v-model="filter"
          class="reviewers__search"
          type="text"
          placeholder="Type or choose a user"
          aria-label="Filter users"
          @keydown.enter.prevent
        >
        <div
          v-if="loading && !pool.length"
          class="reviewers__loading"
        >
          <i class="icon icon-spinner icon-spin" /> Reading the collaborators…
        </div>
        <ul class="reviewers__choices">
          <li
            v-for="(choice, i) in choices"
            :key="choice.who"
          >
            <button
              type="button"
              class="reviewers__choice"
              :class="{
                'reviewers__choice--active': i === active,
                'reviewers__choice--on': on.has(choice.who),
              }"
              role="option"
              :aria-selected="on.has(choice.who) ? 'true' : 'false'"
              :disabled="!!busy"
              @mouseenter="active = i"
              @click="toggle(choice.who)"
            >
              <span class="reviewers__tick">
                <i
                  v-if="busy === choice.who"
                  class="icon icon-spinner icon-spin"
                />
                <i
                  v-else-if="on.has(choice.who)"
                  class="icon icon-checkmark"
                />
              </span>
              <span class="reviewers__choice-who">{{ choice.who }}</span>
              <span
                v-if="choice.why"
                class="reviewers__why"
              >{{ choice.why }}</span>
            </button>
          </li>
          <li
            v-if="!choices.length && !loading"
            class="reviewers__empty"
          >
            Nobody here matches “{{ filter }}”.
          </li>
        </ul>
      </div>
    </Teleport>
  </div>
</template>

<style lang="scss" scoped>
.reviewers {
  display:        flex;
  flex-direction: column;
  gap:            6px;

  &__head {
    display:         flex;
    align-items:     center;
    justify-content: space-between;
    gap:             8px;
  }

  &__label {
    color:          var(--pr-muted);
    font-size:      12px;
    font-weight:    600;
    letter-spacing: .04em;
    text-transform: uppercase;
  }

  &__gear {
    display:       inline-flex;
    align-items:   center;
    padding:       2px 4px;
    min-height:    0;
    border:        none;
    border-radius: var(--r-sm);
    background:    transparent;
    color:         var(--pr-muted);
    cursor:        pointer;

    &:hover,
    &:focus-visible,
    &--on { color: var(--pr-accent); }

    .icon { font-size: 14px; }
  }

  &__list {
    display:        flex;
    flex-direction: column;
    gap:            2px;
    margin:         0;
    padding:        0;
    list-style:     none;
  }

  &__row {
    display:     flex;
    align-items: center;
    gap:         8px;
    min-width:   0;
  }

  // The same initial-in-a-circle the comment threads use, so a person reads the same here.
  &__avatar {
    display:         inline-flex;
    align-items:     center;
    justify-content: center;
    flex:            0 0 auto;
    width:           18px;
    height:          18px;
    border-radius:   50%;
    background:      var(--pr-el);
    color:           var(--pr-muted);
    font-size:       10px;
    font-weight:     700;
  }

  &__who {
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
    min-width:     0;
    flex:          1 1 auto;
    color:         var(--pr-text);
    font-size:     13px;

    &:hover { color: var(--pr-accent); }
  }

  &__state {
    flex: 0 0 auto;

    .icon { font-size: 12px; }

    &--approved { color: var(--pr-success); }
    &--awaiting { color: var(--pr-muted); }
  }

  // Out of the way until the row is under the pointer: a list of reviewers is read far more
  // often than it is edited, and four crosses down the side read as four things to undo.
  &__drop {
    flex:       0 0 auto;
    padding:    0 2px;
    min-height: 0;
    border:     none;
    background: transparent;
    color:      var(--pr-muted);
    cursor:     pointer;
    opacity:    0;

    .icon { font-size: 11px; }

    &:hover,
    &:focus-visible { color: var(--pr-error); }
  }

  &__row:hover &__drop,
  &__row:focus-within &__drop { opacity: 1; }

  &__none {
    margin:    0;
    color:     var(--pr-muted);
    font-size: 13px;
  }

  // ── The picker ────────────────────────────────────────────────────────────────────────────

  &__panel {
    position:       fixed;
    z-index:        100;
    display:        flex;
    flex-direction: column;
    max-height:     min(60vh, 420px);
    border:         1px solid var(--pr-border);
    border-radius:  var(--r-sm);
    background:     var(--pr-bg);
    box-shadow:     0 8px 24px rgba(0, 0, 0, .3);
    overflow:       hidden;
  }

  &__panel-head {
    padding:       8px 10px;
    border-bottom: 1px solid var(--pr-border);
    background:    var(--pr-bg-2);
    color:         var(--pr-muted);
    font-size:     12px;
  }

  &__search {
    width:         100%;
    min-height:    0;
    padding:       7px 10px;
    border:        none;
    border-bottom: 1px solid var(--pr-border);
    border-radius: 0;
    background:    var(--pr-bg);
    color:         var(--pr-text);
    font-size:     13px;

    &:focus { outline: none; }
  }

  &__loading,
  &__empty {
    padding:   10px;
    color:     var(--pr-muted);
    font-size: 12px;
  }

  &__choices {
    margin:     0;
    padding:    4px 0;
    list-style: none;
    overflow-y: auto;
  }

  &__choice {
    display:     flex;
    align-items: baseline;
    gap:         8px;
    width:       100%;
    min-height:  0;
    padding:     5px 10px;
    border:      none;
    background:  transparent;
    color:       var(--pr-text);
    font-size:   13px;
    text-align:  left;
    cursor:      pointer;

    &--active { background: var(--pr-el-hover); }

    &--on { font-weight: 600; }
  }

  // A fixed column for the tick, so the logins line up whether or not one is on the list.
  &__tick {
    flex:       0 0 14px;
    width:      14px;
    color:      var(--pr-success);
    text-align: left;

    .icon { font-size: 12px; }
  }

  &__choice-who {
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
    min-width:     0;
    flex:          0 1 auto;
  }

  // Why they are suggested, after the name and giving way before it.
  &__why {
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
    min-width:     0;
    flex:          1 1 auto;
    color:         var(--pr-muted);
    font-size:     11px;
    font-weight:   400;
  }
}
</style>
