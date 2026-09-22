<script>
// The "where should this run?" modal, asked each time a workspace is started.
//
// It is mounted once, in the sidebar, and registers itself with ranchers.ts so a start deep in
// reviews.ts can open it without threading props through every button that starts work. `pick`
// returns a promise the confirm/cancel resolves: the chosen Rancher's URL ('' for this one), or
// null when the person closes it, which the caller turns into a quiet abort.
//
// Its own small centered dialog rather than DevModal, which is sized (92vh) for the full-page Review
// and Browser views and would render a one-line choice into a near-empty full-screen sheet.
import { RcButton } from '@components/RcButton';
import {
  listRanchers, registerRancherPicker, RANCHER_STEPS
} from '../ranchers';

export default {
  name: 'RancherPicker',

  components: { RcButton },

  data() {
    return {
      open: false, ranchers: [], selected: '', loading: false, resolver: null,
    };
  },

  computed: {
    // Every Rancher, each marked with whether it can be picked: this one always, an instance once
    // it is up (it has no address to talk to before then). A non-ready instance is shown, greyed,
    // so it is clear it exists and is on its way rather than missing.
    rows() {
      return this.ranchers.map((rancher) => {
        const ready = rancher.kind === 'host' || rancher.phase === 'ready';

        return {
          value:  rancher.url || '',
          name:   rancher.name,
          host:   (rancher.url || '').replace(/^https?:\/\//, ''),
          kind:   rancher.kind,
          ready,
          detail: ready ? '' : (rancher.detail || RANCHER_STEPS[rancher.step] || 'starting'),
        };
      });
    },

    // Only a ready row that is actually selected can be confirmed - never while the list is still
    // loading (the remembered choice is unvalidated until then), never a stale/gone target.
    canConfirm() {
      return !this.loading && this.rows.some((r) => r.ready && r.value === this.selected);
    },
  },

  mounted() {
    registerRancherPicker(this.pick);
    this.onKey = (e) => {
      if (this.open && e.key === 'Escape') {
        this.cancel();
      }
    };
    window.addEventListener('keydown', this.onKey);
  },

  beforeUnmount() {
    registerRancherPicker(null);
    window.removeEventListener('keydown', this.onKey);
    this.settle(null); // a start awaiting the picker on a closing page is cancelled, not left hanging
  },

  methods: {
    /** Open the modal and resolve with the chosen URL, or null on cancel. See ranchers.ts pickRancher. */
    pick({ store, current }) {
      this.settle(null); // a prior pick still pending (should not happen) is cancelled, never orphaned
      this.loading = true;
      this.open = true;
      this.selected = current || '';
      this.ranchers = [];
      listRanchers(store)
        .then((list) => {
          this.ranchers = list || [];
          // Fall back to this Rancher if the remembered choice is gone or not up any more.
          if (!this.rows.some((r) => r.ready && r.value === this.selected)) {
            this.selected = '';
          }
        })
        .catch(() => { this.ranchers = []; })
        .finally(() => { this.loading = false; });

      return new Promise((resolve) => { this.resolver = resolve; });
    },

    choose(row) {
      if (row.ready) {
        this.selected = row.value;
      }
    },

    /** Resolve the pending pick (if any) and close, without settling twice. */
    settle(value) {
      const resolve = this.resolver;

      this.resolver = null;
      this.open = false;
      resolve?.(value);
    },

    confirm() {
      if (!this.canConfirm) {
        return;
      }
      this.settle(this.selected);
    },

    cancel() {
      this.settle(null);
    },
  },
};
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="rancher-picker"
      role="dialog"
      aria-label="Where should this workspace run?"
      @click.self="cancel"
    >
      <div class="rancher-picker__panel">
        <div class="rancher-picker__head">
          <span class="rancher-picker__title">Where should this workspace run?</span>
          <button
            type="button"
            class="rancher-picker__x"
            aria-label="Close"
            @click="cancel"
          >&times;</button>
        </div>

        <p class="rancher-picker__lead">New work runs on the Rancher you pick. This defaults to your last choice.</p>

        <div
          v-if="loading && !rows.length"
          class="rancher-picker__loading"
        >Loading Ranchers…</div>

        <ul class="rancher-picker__list">
          <li
            v-for="row in rows"
            :key="row.value + row.name"
          >
            <button
              type="button"
              class="rancher-picker__row"
              :class="{
                'rancher-picker__row--on':       row.ready && row.value === selected,
                'rancher-picker__row--disabled': !row.ready,
              }"
              :disabled="!row.ready"
              @click="choose(row)"
            >
              <span class="rancher-picker__radio">
                <i
                  v-if="row.ready && row.value === selected"
                  class="icon icon-checkmark"
                />
              </span>
              <span class="rancher-picker__body">
                <span class="rancher-picker__name">
                  {{ row.name }}
                  <span
                    v-if="row.kind === 'host'"
                    class="rancher-picker__tag"
                  >this Rancher</span>
                </span>
                <span class="rancher-picker__where">{{ row.ready ? row.host : row.detail }}</span>
              </span>
            </button>
          </li>
        </ul>

        <div class="rancher-picker__actions">
          <RcButton
            variant="secondary"
            @click="cancel"
          >Cancel</RcButton>
          <RcButton
            variant="primary"
            :disabled="!canConfirm"
            @click="confirm"
          >Start here</RcButton>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style lang="scss" scoped>
.rancher-picker {
  position:        fixed;
  inset:           0;
  z-index:         1200;
  display:         flex;
  align-items:     center;
  justify-content: center;
  padding:         16px;
  background:      rgba(0, 0, 0, .5);

  &__panel {
    display:        flex;
    flex-direction: column;
    gap:            14px;
    width:          100%;
    max-width:      460px;
    max-height:     85vh;
    overflow:       auto;
    padding:        20px;
    border:         1px solid var(--border);
    border-radius:  var(--border-radius);
    background:     var(--default);
    box-shadow:     0 8px 32px rgba(0, 0, 0, .35);
  }

  &__head {
    display:         flex;
    align-items:     center;
    justify-content: space-between;
  }

  &__title {
    font-size:   16px;
    font-weight: 600;
  }

  &__x {
    border:      0;
    background:  none;
    color:       var(--muted);
    font-size:   22px;
    line-height: 1;
    cursor:      pointer;

    &:hover { color: var(--body-text); }
  }

  &__lead {
    margin: 0;
    color:  var(--muted);
  }

  &__loading {
    color:      var(--muted);
    font-style: italic;
  }

  &__list {
    display:        flex;
    flex-direction: column;
    gap:            8px;
    margin:         0;
    padding:        0;
    list-style:     none;
  }

  &__row {
    display:       flex;
    align-items:   center;
    gap:           10px;
    width:         100%;
    padding:       10px 12px;
    border:        1px solid var(--border);
    border-radius: var(--border-radius);
    background:    var(--box-bg);
    color:         var(--body-text);
    font:          inherit;
    text-align:    left;
    cursor:        pointer;

    &:hover:not(&--disabled) { border-color: var(--link); }

    &--on {
      border-color: var(--primary);
      background:   var(--accent-btn);
    }

    &--disabled {
      opacity: .55;
      cursor:  default;
    }
  }

  &__radio {
    display:         inline-flex;
    align-items:     center;
    justify-content: center;
    width:           18px;
    height:          18px;
    flex:            0 0 18px;
    border:          1px solid var(--border);
    border-radius:   50%;
    color:           var(--primary);
    font-size:       11px;
  }

  &__row--on &__radio { border-color: var(--primary); }

  &__body {
    display:        flex;
    flex-direction: column;
    gap:            2px;
    min-width:      0;
  }

  &__name {
    font-weight: 600;
  }

  &__tag {
    margin-left:    6px;
    padding:        1px 6px;
    border-radius:  10px;
    background:     var(--tag-bg, var(--border));
    color:          var(--muted);
    font-size:      10px;
    font-weight:    700;
    letter-spacing: .04em;
    text-transform: uppercase;
  }

  &__where {
    color:     var(--muted);
    font-size: 12px;
  }

  &__actions {
    display:         flex;
    justify-content: flex-end;
    gap:             8px;
  }
}
</style>
