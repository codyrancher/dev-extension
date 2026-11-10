<script setup lang="ts">
/**
 * Where the notes are backed up, and when they last were: dev-api writes them to a private GitHub
 * repository once a day when something changed (strata-backup.mjs). Back up now runs it at once.
 */
import { computed, onMounted, ref } from 'vue';
import { api } from '../../strata/api';
import type { BackupState } from '../../strata/api';

const state = ref<BackupState | null>(null);
const busy = ref(false);
const failed = ref('');

function ago(iso?: string): string {
  const at = Date.parse(iso || '');

  if (!at) {
    return '';
  }
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));

  if (s < 60) {
    return 'just now';
  }
  if (s < 3600) {
    return `${ Math.floor(s / 60) }m ago`;
  }
  if (s < 86400) {
    return `${ Math.floor(s / 3600) }h ago`;
  }

  return new Date(at).toLocaleDateString();
}

async function read() {
  try {
    state.value = await api.getBackup();
    failed.value = '';
  } catch (e: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
    failed.value = e?.message || String(e);
  }
}

async function backUp() {
  busy.value = true;
  try {
    state.value = await api.backupNow();
    failed.value = '';
  } catch (e: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
    failed.value = e?.message || String(e);
  } finally {
    busy.value = false;
  }
}

onMounted(read);

const repoUrl = computed(() => (state.value?.repo ? `https://github.com/${ state.value.repo }` : ''));
const commitUrl = computed(() => (repoUrl.value && state.value?.commit ? `${ repoUrl.value }/commit/${ state.value.commit }` : ''));
</script>

<template>
  <div
    v-if="state || failed"
    class="strata-backup"
    data-testid="strata-backup"
  >
    <i class="icon icon-backup strata-backup__icon" />
    <span v-if="busy || state?.running">Backing up…</span>
    <span
      v-else-if="failed"
      class="strata-backup__error"
    >The backup could not be reached: {{ failed }}</span>
    <span
      v-else-if="state?.result === 'failed'"
      class="strata-backup__error"
      data-testid="strata-backup-error"
    >The last backup, {{ ago(state.checkedAt) }}, failed: {{ state.error }}</span>
    <span v-else-if="state?.backedUpAt">
      Backed up daily, when anything changed, to
      <a
        :href="repoUrl"
        target="_blank"
        rel="noopener noreferrer"
      >{{ state.repo }}</a>.
      Last <a
        v-if="commitUrl"
        :href="commitUrl"
        target="_blank"
        rel="noopener noreferrer"
        :title="state.commit"
      >backup {{ ago(state.backedUpAt) }}</a><template v-else>backup {{ ago(state.backedUpAt) }}</template><template v-if="state.result === 'unchanged'">; checked {{ ago(state.checkedAt) }}, nothing new</template>.
    </span>
    <span v-else-if="state?.result === 'empty'">
      Backed up daily to <code>{{ state.repo || 'your-login/strata' }}</code>, a private GitHub repository, once there is a note.
    </span>
    <span v-else>
      Backed up daily to <code>{{ state?.repo || 'your-login/strata' }}</code>, a private GitHub repository. Not yet backed up.
    </span>
    <button
      type="button"
      class="strata-backup__now"
      :disabled="busy || state?.running"
      data-testid="strata-backup-now"
      @click="backUp"
    >
      Back up now
    </button>
  </div>
</template>

<style lang="scss" scoped>
.strata-backup {
  display:     flex;
  flex-wrap:   wrap;
  align-items: baseline;
  gap:         var(--dev-space-2) var(--dev-space-4);
  color:       var(--muted);
  font-size:   12px;
  line-height: 1.5;

  &__icon { position: relative; top: 1px; }

  &__error { color: var(--error); overflow-wrap: anywhere; }

  code {
    padding:    0;
    border:     0;
    background: none;
    color:      var(--body-text);
    font-size:  12px;
  }

  &__now {
    min-height:  0;
    padding:     0;
    border:      0;
    background:  none;
    color:       var(--link);
    font-size:   12px;
    line-height: 1.5;
    cursor:      pointer;

    &:hover:not(:disabled) { text-decoration: underline; }
    &:disabled { color: var(--muted); cursor: default; }
  }
}
</style>
