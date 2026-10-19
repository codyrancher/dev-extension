<script>
/**
 * The stage stepper: numbered dots, a tick for what is behind you, and the round when there has
 * been more than one.
 *
 * Lifted out of WorkspaceRail so the Issue tracker shows the same stages in the same shape
 * rather than a second stepper that looks like this one until somebody changes one of them.
 *
 * Presentational, and only that. It is told the steps, which one is current and which have been
 * through before; it holds no stage, reads no store and decides nothing. The rail's own
 * controls - setting a stage by hand, looking back at what a past stage left - stay in the rail
 * and arrive through the `after` slot, because they are things that page can do and this one
 * cannot.
 */
export default {
  name: 'StageSteps',

  props: {
    /** `[{ key, label }]`, in order. See stepsFor in workspace-rail.ts. */
    steps: {
      type:     Array,
      required: true,
    },
    /** Which step is now. -1 for work that has not started. */
    currentIndex: {
      type:    Number,
      default: -1,
    },
    /** Which pass this is; only drawn past the first. */
    round: {
      type:    Number,
      default: 1,
    },
    /** The step being looked at, if the page lets one be looked at. */
    shown: {
      type:    String,
      default: '',
    },
    /** Step keys that were done in an earlier round and are ahead again. */
    repeated: {
      type:    Array,
      default: () => [],
    },
    /** Whether a step can be pressed. A tracker lists stages; the rail navigates them. */
    interactive: {
      type:    Boolean,
      default: false,
    },
  },

  emits: ['look'],

  methods: {
    again(step, index) {
      return this.repeated.includes(step.key) && index > this.currentIndex;
    },

    done(step, index) {
      return index < this.currentIndex || this.again(step, index);
    },

    stepClass(step, index) {
      return {
        'stage-steps__step--done':   index < this.currentIndex,
        'stage-steps__step--now':    index === this.currentIndex,
        'stage-steps__step--shown':  !!this.shown && step.key === this.shown,
        'stage-steps__step--future': index > this.currentIndex,
        'stage-steps__step--again':  this.again(step, index),
      };
    },

    title(step, index) {
      if (index < this.currentIndex) {
        return `Look at what ${ step.label } left behind`;
      }
      if (index === this.currentIndex) {
        return this.round > 1 ? `Now, round ${ this.round }` : 'Now';
      }

      return this.again(step, index) ? `Done in round ${ this.round - 1 }; ahead of you again` : 'Not yet';
    },
  },
};
</script>

<template>
  <ol class="stage-steps">
    <li
      v-for="(step, index) in steps"
      :key="step.key"
      class="stage-steps__step"
      :class="stepClass(step, index)"
    >
      <button
        type="button"
        class="stage-steps__btn"
        :disabled="!interactive || index > currentIndex"
        :title="title(step, index)"
        @click="$emit('look', { step, index })"
      >
        <span class="stage-steps__dot">
          <i
            v-if="done(step, index)"
            class="icon icon-checkmark"
          />
          <span v-else>{{ index + 1 }}</span>
        </span>
        <span class="stage-steps__label">{{ step.label }}</span>
        <!--
          Which time round this is. The same step twice with nothing to tell the two apart reads
          as no progress, so a pass that follows a review of yours says "round 2" and the steps
          it has already been through keep their ticks.
        -->
        <span
          v-if="index === currentIndex && round > 1"
          class="stage-steps__round"
        >round {{ round }}</span>
      </button>
      <!-- Beside the step's button, never inside it: a button cannot hold another. -->
      <slot
        name="after"
        :step="step"
        :index="index"
      />
    </li>
  </ol>
</template>

<style lang="scss" scoped>
.stage-steps {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.stage-steps__step {
  display: flex;
  align-items: center;
  gap: 2px;
}

.stage-steps__btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border: 0;
  border-radius: 12px;
  background: transparent;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.2;
  cursor: default;

  &:not(:disabled) { cursor: pointer; }
  &:not(:disabled):hover { background: var(--accent-btn); color: var(--body-text); }
}

.stage-steps__dot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: 1px solid var(--border);
  border-radius: 50%;
  font-size: 10px;
  line-height: 1;

  .icon { font-size: 11px; }
}

.stage-steps__round {
  padding: 0 6px;
  border-radius: 8px;
  background: var(--warning-banner-bg);
  color: var(--warning);
  font-size: 10px;
}

/* Behind you. */
.stage-steps__step--done .stage-steps__dot {
  border-color: var(--success);
  background: var(--success);
  color: var(--success-banner-bg, #fff);
}
.stage-steps__step--done .stage-steps__btn { color: var(--body-text); }

/* Now. */
.stage-steps__step--now .stage-steps__btn {
  background: var(--primary-banner-bg, var(--accent-btn));
  color: var(--primary);
  font-weight: 600;
}
.stage-steps__step--now .stage-steps__dot {
  border-color: var(--primary);
  color: var(--primary);
}

/* Done before and ahead of you again. */
.stage-steps__step--again .stage-steps__dot {
  border-color: var(--warning);
  color: var(--warning);
}

/* Being looked at. */
.stage-steps__step--shown .stage-steps__btn {
  outline: 1px solid var(--primary);
  outline-offset: -1px;
}

.stage-steps__step--future .stage-steps__btn { opacity: 0.75; }
</style>
