<script>
// One run of an agent, as a line: how it went, when, what set it off, and the way in to what
// it actually said. A component of its own because the card shows the last few and the history
// modal shows all of them, and a row that is written twice is a row that stops matching itself.
import {
  DEV_PRODUCT, BLANK_CLUSTER, WORKSPACE_ROUTE, CONVERSATIONS_ROUTE
} from '../config/constants';

export default {
  name: 'AgentRunRow',

  props: { run: { type: Object, required: true } },

  computed: {
    /** Runs before 0.3.17 were conversations in a workspace; that workspace is still a link. */
    workspaceTo() {
      return this.run.workspace ? {
        name: WORKSPACE_ROUTE, params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER, workspace: this.run.workspace }, hash: '#conversations',
      } : null;
    },

    /** The run's own conversation: what it said and did, with its artifacts. */
    conversationTo() {
      return this.run.conversation ? {
        name: CONVERSATIONS_ROUTE, params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER }, query: { c: this.run.conversation },
      } : null;
    },

    when() {
      const d = new Date(this.run.startedAt);

      return !this.run.startedAt || Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });
    },

    duration() {
      if (!this.run.startedAt) {
        return '';
      }
      const end = this.run.endedAt ? Date.parse(this.run.endedAt) : Date.now();
      const s = Math.max(0, Math.round((end - Date.parse(this.run.startedAt)) / 1000));

      return s < 60 ? `${ s }s` : s < 3600 ? `${ Math.round(s / 60) }m` : `${ (s / 3600).toFixed(1) }h`;
    },

    /** What set it off, and for a resource trigger which resource did. */
    trigger() {
      const c = this.run.context;

      return c?.name ? `${ c.event || 'changed' } ${ c.name }` : this.run.trigger;
    },
  },
};
</script>

<template>
  <li
    class="agent-run"
    :class="`agent-run--${ run.state }`"
    :title="run.note || ''"
  >
    <span class="agent-run__dot" />
    <span class="agent-run__state">{{ run.state }}</span>
    <span class="agent-run__when">{{ when }}</span>
    <span
      class="agent-run__trigger"
      :title="run.context ? JSON.stringify(run.context) : ''"
    >{{ trigger }}</span>
    <router-link
      v-if="workspaceTo"
      :to="workspaceTo"
      class="agent-run__where"
    >
      {{ run.workspace }}
    </router-link>
    <span
      v-else
      class="agent-run__where text-muted"
      title="A conversation in the agents drawer"
    >{{ run.conversation || '…' }}</span>
    <span class="agent-run__dur">{{ duration }}</span>
    <router-link
      v-if="conversationTo"
      :to="conversationTo"
      class="agent-run__open"
      title="Open this run's conversation: its output, tool calls and artifacts"
    >
      output
    </router-link>
    <span
      v-else
      class="agent-run__open text-muted"
    >&nbsp;</span>
  </li>
</template>

<style lang="scss" scoped>
.agent-run {
  display:               grid;
  grid-template-columns: 8px 62px auto 1fr minmax(0, 1fr) 44px 46px;
  align-items:           center;
  gap:                   var(--dev-space-3);
  padding:               5px var(--dev-space-4);
  font-size:             12px;
  border-top:            1px solid var(--border);

  &:first-child { border-top: 0; }

  &__dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
  &--running &__dot, &--starting &__dot { background: var(--dev-accent); animation: agent-run-pulse 1.4s infinite ease-in-out; }
  &--done &__dot { background: var(--success); }
  &--failed &__dot { background: var(--error); }
  &--requested &__dot { background: var(--warning); }

  &__state { text-transform: uppercase; font-weight: 600; letter-spacing: 0.04em; font-size: 10px; }
  &--running &__state, &--starting &__state { color: var(--dev-accent); }
  &--done &__state { color: var(--success); }
  &--failed &__state { color: var(--error); }
  &--requested &__state { color: var(--warning); }

  &__when, &__trigger, &__dur { color: var(--muted); }
  &__trigger, &__where { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  &__dur { text-align: right; }
  &__where { font-family: monospace; }
  &__open { text-align: right; color: var(--link); font-size: 11px; }
}

@keyframes agent-run-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

/* ── Phones: state, when and the way in. The trigger and the duration go: they are the two
   the line can be read without, and eight columns at 390px is a column of ellipses. ── */
@media (max-width: 760px) {
  .agent-run {
    grid-template-columns: 8px 58px 1fr 46px;
    gap: var(--dev-space-2);

    &__trigger, &__dur { display: none; }
  }
}
</style>
