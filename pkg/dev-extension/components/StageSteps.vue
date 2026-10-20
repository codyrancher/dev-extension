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
/*
 * The workspace column's stepper, which is now everybody's.
 *
 * This component started as the tracker's lighter row of pills and the column kept its own
 * stepper, which is how there came to be two. Unifying them the first time took the wrong one:
 * the column is the place a person reads a stage carefully, and its drawing - the connecting
 * line, the filled circle for what is behind you, the ringed one for where you are - is what
 * says "a pipeline with a position in it" rather than "some labels". So that is the one kept,
 * and the tracker shows it too.
 */
.stage-steps {
  display:    flex;
  list-style: none;
  margin:     8px 0 4px;
  padding:    0 8px;
}

.stage-steps__step {
  flex:     1 1 0;
  position: relative;

  /* The line between dots: from this dot's centre to the next's. */
  &::after {
    content:    '';
    position:   absolute;
    top:        13px;
    left:       50%;
    right:      -50%;
    height:     2px;
    background: var(--border);
  }

  &:last-child::after { display: none; }
  &--done::after { background: var(--primary); }
}

.stage-steps__btn {
  position:       relative;
  z-index:        1;
  display:        flex;
  flex-direction: column;
  align-items:    center;
  gap:            6px;
  width:          100%;
  padding:        0;
  border:         0;
  background:     transparent;
  color:          var(--muted);
  font:           inherit;
  cursor:         pointer;

  &:disabled { cursor: default; }
}

.stage-steps__dot {
  display:         flex;
  align-items:     center;
  justify-content: center;
  width:           26px;
  height:          26px;
  border-radius:   50%;
  border:          2px solid var(--border);
  background:      var(--body-bg);
  font-size:       12px;
  font-weight:     700;

  .icon { font-size: 12px; }
}

.stage-steps__step--done .stage-steps__dot {
  background:   var(--primary);
  border-color: var(--primary);
  color:        #fff;
}

.stage-steps__step--now .stage-steps__dot {
  border-color: var(--warning);
  color:        var(--warning);
  box-shadow:   0 0 0 4px rgba(255, 228, 122, .15);
}

/* A step done in an earlier round and ahead of you again: the same tick, said quietly. */
.stage-steps__step--again .stage-steps__dot {
  border-style: dashed;
  opacity:      .85;
}

.stage-steps__step--now .stage-steps__label { color: var(--body-text); font-weight: 700; }
.stage-steps__step--shown .stage-steps__label { text-decoration: underline; text-underline-offset: 3px; }
.stage-steps__step--done .stage-steps__btn:hover .stage-steps__label { color: var(--body-text); }
.stage-steps__label { font-size: 12px; }

/* Which time round this step is being taken. Small, beside the label, never instead of it. */
.stage-steps__round {
  margin-left:    6px;
  padding:        1px 6px;
  border:         1px solid var(--warning);
  border-radius: var(--r-md);
  color:          var(--warning);
  font-size:      10px;
  font-weight:    700;
  letter-spacing: .04em;
  text-transform: uppercase;
  white-space:    nowrap;
}

/*
 * A row of these in a table is tighter than a column header: the tracker draws one per issue
 * inside an expanded row, where the column's vertical rhythm would be most of the row's height.
 * Same drawing, less air - set by the page rather than by a second component.
 */
:host(.stage-steps--tight),
.stage-steps--tight {
  margin:  2px 0;
  padding: 0;

  .stage-steps__dot { width: 20px; height: 20px; font-size: 11px; }
  .stage-steps__step::after { top: 10px; }
  .stage-steps__btn { gap: 4px; }
  .stage-steps__label { font-size: 11px; }
}
</style>
