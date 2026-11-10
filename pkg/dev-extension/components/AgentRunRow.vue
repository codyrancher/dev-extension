<script>
// One run of an automation, as a line: how it went, when, what set it off, what it came to, and
// the way in to its log. A component of its own because the card shows the last few and the
// history modal shows all of them, and a row that is written twice is a row that stops matching
// itself.
import { duration, stamp } from '../automations';
import { exitNote } from '../dev-api/automation-rules.mjs';

export default {
  name: 'AgentRunRow',

  props: { run: { type: Object, required: true } },

  emits: ['open'],

  computed: {
    when() {
      return stamp(this.run.startedAt);
    },

    took() {
      return duration(this.run);
    },

    /** What set it off: the event's name and subject, a resource, or the trigger's word. */
    trigger() {
      const r = this.run;

      if (r.event) {
        return `${ r.event.name } · ${ r.event.subject }`;
      }

      return r.context?.name ? `${ r.context.event || 'changed' } ${ r.context.name }` : r.trigger;
    },

    /** The one line it came to: the agent's last word, the script's last line, or why it failed. */
    outcome() {
      const r = this.run;
      const exit = typeof r.exitCode === 'number' && r.exitCode !== 0 ? exitNote(r.exitCode) : '';

      return [exit, r.result || r.note || ''].filter(Boolean).join(' · ');
    },

    state() {
      return this.run.state === 'requested' ? 'queued' : this.run.state;
    },
  },
};
</script>

<template>
  <li
    class="agent-run"
    :class="`agent-run--${ run.state }`"
  >
    <button
      type="button"
      class="agent-run__line"
      :title="outcome || run.note || ''"
      data-testid="automation-run-row"
      @click="$emit('open', run)"
    >
      <span class="agent-run__dot" />
      <span class="agent-run__state">{{ state }}</span>
      <span class="agent-run__when">{{ when }}</span>
      <span
        class="agent-run__trigger"
        :title="run.event ? run.event.title : (run.context ? JSON.stringify(run.context) : '')"
      >{{ trigger }}</span>
      <span class="agent-run__outcome">{{ outcome }}</span>
      <span class="agent-run__dur">{{ took }}</span>
      <span class="agent-run__open">log</span>
    </button>
  </li>
</template>

<style lang="scss" scoped>
.agent-run {
  border-top: 1px solid var(--border);

  &:first-child { border-top: 0; }

  &__line {
    display:               grid;
    grid-template-columns: 8px 58px auto minmax(0, 1fr) minmax(0, 1.2fr) 52px 24px;
    align-items:           center;
    gap:                   var(--dev-space-3);
    width:                 100%;
    min-height:            0;
    padding:               5px var(--dev-space-4);
    border:                0;
    background:            none;
    color:                 var(--body-text);
    font-size:             12px;
    line-height:           1.4;
    text-align:            left;
    cursor:                pointer;

    &:hover { background: color-mix(in srgb, var(--body-text) 4%, transparent); }
    &:focus-visible { outline: 2px solid var(--dev-accent); outline-offset: -2px; }
  }

  &__dot { width: 7px; height: 7px; border-radius: 50%; background: var(--status-idle); }
  &--running &__dot, &--starting &__dot { background: var(--status-working); animation: agent-run-pulse 1.4s infinite ease-in-out; }
  &--waiting &__dot, &--requested &__dot { background: var(--status-input); }
  &--done &__dot { background: var(--status-done); }
  &--failed &__dot { background: var(--status-error); }

  &__state { text-transform: uppercase; font-weight: 600; letter-spacing: 0.04em; font-size: 10px; }
  &--running &__state, &--starting &__state { color: var(--status-working); }
  &--waiting &__state, &--requested &__state { color: var(--status-input); }
  &--done &__state { color: var(--status-done); }
  &--failed &__state { color: var(--status-error); }

  &__when, &__trigger, &__dur { color: var(--muted); }
  &__when { white-space: nowrap; font-variant-numeric: tabular-nums; }
  &__trigger, &__outcome { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  &__trigger { font-family: monospace; font-size: 11px; }
  &--failed &__outcome { color: var(--error); }
  &__dur { text-align: right; font-variant-numeric: tabular-nums; }
  &__open { text-align: right; color: var(--link); font-size: 11px; }
}

@keyframes agent-run-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

/* ── Phones: state, when, what it came to and the way in. ── */
@media (max-width: 760px) {
  .agent-run__line {
    grid-template-columns: 8px 54px auto minmax(0, 1fr) 24px;
    gap: var(--dev-space-2);
  }

  .agent-run__trigger, .agent-run__dur { display: none; }
}
</style>
