<script setup lang="ts">
// Review: what the agent has changed, before it is anybody's pull request.
//
// The PR tab is GitHub's view of a branch somebody pushed. This is the view before that: every
// change on the branch the agent is working on, committed or not, read straight out of the
// checkout the agent works in and drawn the way the PR tab draws a diff. Comments here are not
// kept anywhere - they are the next thing said to the agent. Write a few against the lines they
// are about, press send, and they go into a conversation in this workspace as one prompt: fix
// these, or answer these. The agent's reply is the pane docked above the diff.
import {
  computed, onBeforeUnmount, onMounted, reactive, ref
} from 'vue';
import { Banner } from '@components/Banner';
import StudioTerminal from './StudioTerminal.vue';
import PrButton from './pr/PrButton.vue';
import PrBadge from './pr/PrBadge.vue';
import {
  parseHunks, highlightRows, hl
} from './pr/diff';
import type { DiffRow } from './pr/diff';
import { listConversations, startConversation, queuePrompt, paneCommand } from '../conversations';
import type { ProjectConversation } from '../conversations';
import { readInWorkspace, ensureWorkspaceReady } from '../workspace-tools';
import { listApps } from '../apps';
import { DEFAULT_APP, WORKSPACE_WORKDIR } from '../config/constants';
import { DEFAULT_REPO } from '../reviews';
import { useStore } from 'vuex';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const props = defineProps<{ workspace: Json }>();
const store = useStore();

const REFRESH_MS = 15000;

interface ChangedFile {
  path: string;
  status: 'added' | 'removed' | 'modified' | 'renamed';
  additions: number;
  deletions: number;
  patch: string;
  binary: boolean;
}

interface Note {
  id: number;
  path: string;
  line: number | null;
  side: 'LEFT' | 'RIGHT';
  code: string;
  body: string;
}

const repo = ref(DEFAULT_REPO);
const branch = ref('');
const base = ref('');
const files = ref<ChangedFile[]>([]);
const loading = ref(true);
const error = ref('');
const missing = ref('');
let timer: ReturnType<typeof setInterval> | null = null;

async function resolveRepo() {
  const apps = await listApps(store).catch(() => []);
  const own = apps.find((app: Json) => app.id === props.workspace.app && app.repo);
  const fallback = apps.find((app: Json) => app.id === DEFAULT_APP && app.repo) || apps.find((app: Json) => !!app.repo);

  repo.value = (own || fallback)?.repo || DEFAULT_REPO;
}

/** Where the agents work: the workspace's own checkout, which is where its dev server runs from too. */
const dir = computed(() => WORKSPACE_WORKDIR);

/**
 * The changes, read out of the clone: the branch against where it left the default branch,
 * plus whatever is not committed, plus files git does not know about yet.
 */
async function readChanges() {
  const script = [
    `cd ${ dir.value } 2>/dev/null || { echo "@@NOREPO"; exit 0; }`,
    // upstream is rancher/dashboard once workspace-tools has set the remotes; before that it is
    // origin, and a checkout with neither is diffed against itself.
    'base=$(git merge-base upstream/master HEAD 2>/dev/null || git merge-base origin/master HEAD 2>/dev/null || git merge-base origin/HEAD HEAD 2>/dev/null || git rev-parse HEAD)',
    'echo "@@BRANCH $(git rev-parse --abbrev-ref HEAD 2>/dev/null)"',
    'echo "@@BASE $base"',
    'git -c core.quotepath=off diff --no-color --no-ext-diff "$base" 2>/dev/null',
    'for f in $(git ls-files --others --exclude-standard | head -40); do git -c core.quotepath=off diff --no-color --no-index /dev/null "$f" 2>/dev/null; done',
    'echo "@@END"',
  ].join('; ');
  let out = '';

  try {
    out = await readInWorkspace(props.workspace.name, script);
  } catch (e: Json) {
    missing.value = e?.message || String(e);

    return;
  }

  if (out.includes('@@NOREPO')) {
    missing.value = `There is no checkout of ${ repo.value } in the workspace yet - it is cloned when the workspace starts.`;
    files.value = [];

    return;
  }
  missing.value = '';
  branch.value = /@@BRANCH (.*)/.exec(out)?.[1]?.trim() || '';
  base.value = /@@BASE (.*)/.exec(out)?.[1]?.trim() || '';
  files.value = parseDiff(out.slice(0, out.indexOf('@@END') >= 0 ? out.indexOf('@@END') : undefined));
}

/** git's unified diff, split into the shape the PR tab draws: one entry per file with its patch. */
function parseDiff(text: string): ChangedFile[] {
  const out: ChangedFile[] = [];
  const chunks = text.split(/^diff --git /m).slice(1);

  for (const chunk of chunks) {
    const lines = chunk.split('\n');
    const head = lines[0] || '';
    const m = /^"?a\/(.*?)"? "?b\/(.*?)"?$/.exec(head) || /^(\S+) (\S+)$/.exec(head);
    let path = (m?.[2] || m?.[1] || head).replace(/^"?b\//, '').replace(/"$/, '');

    if (path === '/dev/null') {
      path = (m?.[1] || '').replace(/^a\//, '');
    }
    const meta = lines.slice(1);
    const status: ChangedFile['status'] = meta.some((l) => l.startsWith('new file mode') || l.startsWith('--- /dev/null')) ? 'added'
      : meta.some((l) => l.startsWith('deleted file mode') || l.startsWith('+++ /dev/null')) ? 'removed'
        : meta.some((l) => l.startsWith('rename from')) ? 'renamed' : 'modified';
    const at = meta.findIndex((l) => l.startsWith('@@'));
    const patch = at === -1 ? '' : meta.slice(at).join('\n').replace(/\n$/, '');
    const binary = meta.some((l) => /^Binary files/.test(l));
    const additions = (patch.match(/^\+(?!\+\+)/gm) || []).length;
    const deletions = (patch.match(/^-(?!--)/gm) || []).length;

    out.push({
      path: path.replace(/^\.\//, ''), status, additions, deletions, patch, binary,
    });
  }

  return out.sort((a, b) => a.path.localeCompare(b.path));
}

interface RowView { row: DiffRow; notes: Note[] }
interface FileView { file: ChangedFile; rows: RowView[]; count: number }

const notes = ref<Note[]>([]);
let nextNote = 1;

const fileViews = computed<FileView[]>(() => files.value.map((file) => {
  const rows: DiffRow[] = parseHunks(file.patch).flatMap((h) => h.rows);

  highlightRows(file.path, rows);

  return {
    file,
    rows:  rows.map((row) => ({
      row,
      notes: notes.value.filter((n) => n.path === file.path && n.line != null && (n.side === 'LEFT' ? row.oldN === n.line : row.newN === n.line)),
    })),
    count: notes.value.filter((n) => n.path === file.path).length,
  };
}));

const totals = computed(() => ({
  additions: files.value.reduce((t, f) => t + f.additions, 0),
  deletions: files.value.reduce((t, f) => t + f.deletions, 0),
}));

const collapsed = reactive(new Set<string>());
const fileEls = new Map<string, HTMLElement>();

function setFileEl(path: string, el: unknown) {
  if (el instanceof HTMLElement) {
    fileEls.set(path, el);
  } else {
    fileEls.delete(path);
  }
}

function scrollToFile(path: string) {
  collapsed.delete(path);
  requestAnimationFrame(() => fileEls.get(path)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

// ── Notes: click a line, say something about it ──
const composer = ref<{ path: string; side: 'LEFT' | 'RIGHT'; line: number; code: string } | null>(null);
const composerDraft = ref('');

function lineClick(path: string, row: DiffRow) {
  const side: 'LEFT' | 'RIGHT' | null = row.newN != null ? 'RIGHT' : row.oldN != null ? 'LEFT' : null;

  if (!side) {
    return;
  }
  const line = (side === 'RIGHT' ? row.newN : row.oldN)!;

  if (composer.value && composer.value.path === path && composer.value.line === line && composer.value.side === side) {
    composer.value = null;

    return;
  }
  composer.value = {
    path, side, line, code: row.text,
  };
  composerDraft.value = '';
}

function composerMatches(path: string, row: DiffRow): boolean {
  const c = composer.value;

  return !!c && c.path === path && (c.side === 'RIGHT' ? row.newN === c.line : row.oldN === c.line);
}

function addNote() {
  const c = composer.value;
  const body = composerDraft.value.trim();

  if (!c || !body) {
    return;
  }
  notes.value = [...notes.value, {
    id: nextNote++, path: c.path, line: c.line, side: c.side, code: c.code, body,
  }];
  composer.value = null;
  composerDraft.value = '';
}

function removeNote(id: number) {
  notes.value = notes.value.filter((n) => n.id !== id);
}

// A question, or a remark about the whole change, with no line to hang it on.
const general = ref('');

// ── Sending it to the agent ──
const conversations = ref<ProjectConversation[]>([]);
const target = ref('new');
const session = ref('');
const sending = ref(false);
const showPane = ref(false);

async function loadConversations() {
  conversations.value = await listConversations(props.workspace.name).catch(() => []);
}

const canSend = computed(() => notes.value.length > 0 || general.value.trim().length > 0);

function prompt(): string {
  const lines: string[] = [];

  lines.push(`Review feedback on your changes on branch ${ branch.value || '(current)' } in ${ dir.value }, from the person reviewing them in the Rancher dashboard. Address each point: make the change if it asks for one, answer it here if it is a question, and say what you did for each. Do not open a pull request unless asked.`);
  notes.value.forEach((n, i) => {
    lines.push(`\n${ i + 1 }. ${ n.path }:${ n.line }${ n.side === 'LEFT' ? ' (the removed line)' : '' } - on \`${ n.code.trim().slice(0, 160) }\`:\n${ n.body }`);
  });
  if (general.value.trim()) {
    lines.push(`\n${ notes.value.length ? `${ notes.value.length + 1 }. ` : '' }${ general.value.trim() }`);
  }

  return lines.join('\n');
}

async function send() {
  if (!canSend.value || sending.value) {
    return;
  }
  sending.value = true;
  error.value = '';
  try {
    const text = prompt();

    if (target.value === 'new') {
      await ensureWorkspaceReady(props.workspace.name);

      const conversation = await startConversation(props.workspace.name, 'Review feedback', text);

      session.value = conversation.id;
      target.value = conversation.id;
      await loadConversations();
    } else {
      const conversation = conversations.value.find((c) => c.id === target.value);

      if (!conversation) {
        throw new Error('That conversation is gone. Pick another, or a new one.');
      }
      await queuePrompt(conversation.attach, text);
      session.value = conversation.id;
    }
    showPane.value = true;
    notes.value = [];
    general.value = '';
    store.dispatch('growl/success', { title: '', message: 'Sent to the agent. Its reply is the pane above the diff.', timeout: 4000 }, { root: true });
  } catch (e: Json) {
    error.value = e?.message || String(e);
  } finally {
    sending.value = false;
  }
}

function fileTone(f: ChangedFile): string {
  return f.status === 'added' ? 'success' : f.status === 'removed' ? 'error' : 'neutral';
}

async function refresh() {
  try {
    await readChanges();
    error.value = '';
  } catch (e: Json) {
    error.value = e?.message || String(e);
  } finally {
    loading.value = false;
  }
}

onMounted(async() => {
  await resolveRepo();
  await Promise.all([refresh(), loadConversations()]);
  timer = setInterval(() => {
    if (!document.hidden) {
      refresh();
    }
  }, REFRESH_MS);
});

onBeforeUnmount(() => {
  if (timer) {
    clearInterval(timer);
  }
});

defineExpose({ refresh });
</script>

<template>
  <div class="pr-review workspace-review">
    <header class="prm-header">
      <div class="prm-header-row">
        <div class="prm-title">
          <PrBadge :tone="files.length ? 'accent' : 'neutral'">
            {{ branch || 'no branch' }}
          </PrBadge>
          <span class="prm-title-text">{{ repo }}</span>
          <span
            v-if="files.length"
            class="muted prm-title-sub"
          >{{ files.length }} file{{ files.length === 1 ? '' : 's' }} changed · <span class="add-count">+{{ totals.additions }}</span> <span class="del-count">−{{ totals.deletions }}</span></span>
        </div>
        <div class="prm-actions">
          <select
            v-model="target"
            class="review-target"
            title="Which conversation the feedback goes to"
          >
            <option value="new">
              A new conversation
            </option>
            <option
              v-for="c in conversations"
              :key="c.id"
              :value="c.id"
            >
              {{ c.title }}
            </option>
          </select>
          <PrButton
            v-if="session"
            size="sm"
            :variant="showPane ? 'accent' : 'default'"
            @click="showPane = !showPane"
          >
            {{ showPane ? 'Hide agent' : 'Show agent' }}
          </PrButton>
          <PrButton
            size="sm"
            @click="refresh"
          >
            Refresh
          </PrButton>
          <PrButton
            size="sm"
            variant="primary"
            :disabled="!canSend || sending"
            data-testid="review-send"
            @click="send"
          >
            {{ sending ? 'Sending…' : `Send ${ notes.length + (general.trim() ? 1 : 0) || '' } to the agent` }}
          </PrButton>
        </div>
      </div>
      <div class="prm-meta">
        <span>Everything on this branch since {{ base ? base.slice(0, 7) : 'its base' }}, committed or not, read from the agent's checkout in {{ dir }}. Comments are not kept: they are the next thing said to the agent.</span>
      </div>
    </header>

    <div
      v-if="showPane && session"
      class="prm-review-panel"
    >
      <div class="review-panel-header">
        <span class="review-panel-title">Agent</span>
        <span class="review-panel-sub">conversation {{ session }} in {{ workspace.name }}</span>
        <PrButton
          variant="ghost"
          size="mini"
          class="prm-close"
          @click="showPane = false"
        >
          &times;
        </PrButton>
      </div>
      <StudioTerminal
        :key="session"
        :session="session"
        :command="paneCommand(workspace.name, session)"
        class="review-term"
      />
    </div>

    <Banner
      v-if="error"
      color="error"
      :label="error"
      class="prm-banner"
    />
    <Banner
      v-else-if="missing"
      color="info"
      :label="missing"
      class="prm-banner"
    />
    <div
      v-else-if="loading"
      class="prm-loading"
    >
      Reading the checkout…
    </div>
    <div
      v-else-if="!files.length"
      class="prm-loading"
    >
      Nothing has changed on {{ branch || 'this branch' }} yet.
    </div>

    <div
      v-if="files.length"
      class="prm-main"
    >
      <aside class="prm-filenav">
        <div
          v-for="fv in fileViews"
          :key="fv.file.path"
          class="filenav-item"
          :title="fv.file.path"
          @click="scrollToFile(fv.file.path)"
        >
          <span class="filenav-name">{{ fv.file.path }}</span>
          <span class="filenav-icons">
            <span
              v-if="fv.count"
              class="filenav-comments pending"
            >{{ fv.count }}</span>
            <span class="add-count">+{{ fv.file.additions }}</span>
            <span class="del-count">−{{ fv.file.deletions }}</span>
          </span>
        </div>
      </aside>

      <div class="prm-body">
        <!-- A question, or a remark about the whole change. -->
        <section class="prm-prlevel">
          <div class="prlevel-head">
            <PrBadge tone="accent">
              To the agent
            </PrBadge>
            <span class="muted">A question about the change, or a note that is not about one line. Sent with the line comments below.</span>
          </div>
          <div class="prlevel-compose">
            <textarea
              v-model="general"
              class="edit-textarea"
              rows="2"
              placeholder="Why did you change the validator this way? / Please also cover the IPv6 zone-id case."
            />
          </div>
        </section>

        <div
          v-for="fv in fileViews"
          :key="fv.file.path"
          :ref="(el) => setFileEl(fv.file.path, el)"
          class="prm-file"
        >
          <div
            class="file-header clickable"
            @click="collapsed.has(fv.file.path) ? collapsed.delete(fv.file.path) : collapsed.add(fv.file.path)"
          >
            <span
              class="collapse-chevron"
              :class="{ collapsed: collapsed.has(fv.file.path) }"
            >▾</span>
            <span class="file-path">{{ fv.file.path }}</span>
            <span class="file-stats">
              <PrBadge :tone="fileTone(fv.file)">
                {{ fv.file.status }}
              </PrBadge>
              <span class="add-count">+{{ fv.file.additions }}</span>
              <span class="del-count">−{{ fv.file.deletions }}</span>
            </span>
          </div>
          <table
            v-if="fv.file.patch && !collapsed.has(fv.file.path)"
            class="diff-table"
          >
            <tbody>
              <template
                v-for="(rv, ri) in fv.rows"
                :key="ri"
              >
                <tr
                  class="diff-row"
                  :class="rv.row.type"
                >
                  <td
                    class="lineno"
                    :class="{ clickable: rv.row.oldN != null || rv.row.newN != null }"
                    title="Click to comment"
                    @click="lineClick(fv.file.path, rv.row)"
                  >
                    {{ rv.row.oldN ?? '' }}
                  </td>
                  <td
                    class="lineno"
                    :class="{ clickable: rv.row.oldN != null || rv.row.newN != null }"
                    title="Click to comment"
                    @click="lineClick(fv.file.path, rv.row)"
                  >
                    {{ rv.row.newN ?? '' }}
                  </td>
                  <td class="code">
                    <span class="sign">{{ rv.row.type === 'add' ? '+' : rv.row.type === 'del' ? '−' : ' ' }}</span><span v-if="rv.row.type === 'hunk'">{{ rv.row.text }}</span><span
                      v-else
                      v-html="hl(rv.row)"
                    />
                  </td>
                </tr>
                <tr
                  v-if="composerMatches(fv.file.path, rv.row)"
                  class="comment-row"
                >
                  <td colspan="3">
                    <div class="comment composer-card">
                      <div class="comment-head">
                        <span class="comment-author">To the agent — L{{ composer!.line }}</span>
                      </div>
                      <textarea
                        v-model="composerDraft"
                        class="edit-textarea"
                        placeholder="What should change here, or what do you want to know about it?"
                        @keydown.esc.prevent="composer = null"
                        @keydown.enter.ctrl.prevent="addNote"
                      />
                      <div class="edit-btns">
                        <PrButton
                          size="mini"
                          class="approve"
                          :disabled="!composerDraft.trim()"
                          @click="addNote"
                        >
                          Add
                        </PrButton>
                        <PrButton
                          size="mini"
                          @click="composer = null"
                        >
                          Cancel
                        </PrButton>
                      </div>
                    </div>
                  </td>
                </tr>
                <tr
                  v-for="n in rv.notes"
                  :key="n.id"
                  class="comment-row"
                >
                  <td colspan="3">
                    <div class="comment local-comment pending">
                      <div class="comment-head">
                        <span class="comment-author">to the agent</span>
                        <PrBadge tone="warning">
                          unsent
                        </PrBadge>
                        <span class="comment-actions">
                          <PrButton
                            size="mini"
                            variant="danger"
                            @click="removeNote(n.id)"
                          >Remove</PrButton>
                        </span>
                      </div>
                      <div class="comment-body">
                        {{ n.body }}
                      </div>
                    </div>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
          <div
            v-else-if="!collapsed.has(fv.file.path)"
            class="muted no-patch"
          >
            {{ fv.file.binary ? 'Binary file.' : 'No diff to show.' }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped src="./pr/panel.scss"></style>
<style lang="scss" scoped>
.review-target {
  height:    28px;
  padding:   0 var(--dev-space-3);
  font-size: 12px;
  max-width: 220px;
}

.prm-title-sub { font-weight: 400; font-size: 12px; white-space: nowrap; }
</style>
