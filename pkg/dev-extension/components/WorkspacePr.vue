<script setup lang="ts">
// The pull request a workspace is for, and the review of it.
//
// The harness's PR review surface, ported: the full diff with GitHub's comments and the local
// pending ones inline, a file tree that is also the index of every comment, the review agent
// docked over the diff, a discussion under any comment, and submission of the approved comments
// to GitHub as one review. Same layout, same interactions, same names for things; what differs
// is where the pieces live. Comments and the review's progress are in the in-cluster API
// (reviews.ts), the agent and every discussion are conversations in Extension Studio's agent
// pod drawn by the Studio's own terminal (StudioTerminal), and GitHub is reached from the
// browser with the person's own token.
import {
  computed, onBeforeUnmount, onMounted, reactive, ref, watch, nextTick
} from 'vue';
import { useStore } from 'vuex';
import {
  parseHunks, highlightRows, hl, escapeHtml, renderMd
} from './pr/diff';
import type { DiffRow } from './pr/diff';
import { Banner } from '@components/Banner';
import StudioTerminal from './StudioTerminal.vue';
import CommentDiscussion from './pr/CommentDiscussion.vue';
import CommentAttachments from './pr/CommentAttachments.vue';
import PrButton from './pr/PrButton.vue';
import PrBadge from './pr/PrBadge.vue';
import {
  prDetail, listComments, addComment, updateComment, deleteComment, approvePr, submitReview, mergePr,
  replyToComment, prFile, commitsDiff, ciFailures, ciFailureDetail, reviewRun, cancelReview,
  startPrReview, startCiTriage, DEFAULT_REPO
} from '../reviews';
import type { LocalComment, ReviewRun } from '../reviews';
import { linkedPullRequest } from '../github';
import { listApps } from '../apps';
import { listConversations } from '../conversations';
import { DEFAULT_APP } from '../config/constants';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const props = defineProps<{
  workspace: Json;
  /** The PR number the workspace's name carries, or 0. */
  pr: number;
  /** The issue number it carries instead, or 0. */
  issue: number;
}>();

const store = useStore();

function toast(message: string, kind: 'success' | 'error' | 'info' = 'success', title = '') {
  store.dispatch(`growl/${ kind }`, { title: title || (kind === 'error' ? 'Pull request' : ''), message, timeout: kind === 'error' ? 8000 : 4000 }, { root: true });
}

function confirmAction(message: string): boolean {
  return window.confirm(message);
}

// ── Which PR, in which repo ──
const number = ref(0);
const repo = ref(DEFAULT_REPO);
const resolving = ref(true);
const resolveMessage = ref('');

async function resolveRepo() {
  const apps = await listApps(store).catch(() => []);
  const own = apps.find((app: Json) => app.id === props.workspace.app && app.repo);
  const fallback = apps.find((app: Json) => app.id === DEFAULT_APP && app.repo) || apps.find((app: Json) => !!app.repo);

  repo.value = (own || fallback)?.repo || DEFAULT_REPO;
}

async function resolveNumber() {
  resolving.value = true;
  resolveMessage.value = '';
  try {
    await resolveRepo();
    number.value = props.pr || (props.issue ? await linkedPullRequest(repo.value, props.issue) : 0);
    if (!number.value) {
      resolveMessage.value = props.issue ? `No pull request closes #${ props.issue } yet. One will show up here when it does.` : 'This workspace has no pr-<n> or issue-<n> in its name.';
    }
  } catch (e: Json) {
    resolveMessage.value = e?.message || String(e);
  } finally {
    resolving.value = false;
  }
}

// ── The PR ──
const detail = ref<Json | null>(null);
const localComments = ref<LocalComment[]>([]);
const loading = ref(false);
const error = ref('');
const startingReview = ref(false);
const submitting = ref(false);
const showConversation = ref(false);
// ── Commit range selection ──
const showCommits = ref(false);
const selectedShas = ref<Set<string>>(new Set());
const lastPicked = ref<string | null>(null);
const combinedDiff = ref(true);
const rangeFiles = ref<Json[] | null>(null);
const rangeLoading = ref(false);
let pollTimer: ReturnType<typeof setInterval> | null = null;

async function load() {
  if (!number.value) {
    return;
  }
  loading.value = true;
  error.value = '';
  try {
    detail.value = await prDetail(number.value, repo.value);
    localComments.value = detail.value.localComments || [];
    if (detail.value?.meta?.ci?.failing && !failures.value) {
      failures.value = await ciFailures(number.value, repo.value).catch(() => null);
    }
  } catch (e: Json) {
    error.value = e?.message || String(e);
  } finally {
    loading.value = false;
  }
}

// ── Polling ──
// Fast while an agent is filing comments, slow when nobody is, not at all in a background tab.
const COMMENT_POLL_ACTIVE_MS = 3000;
const COMMENT_POLL_IDLE_MS = 20000;
let commentPollMs = COMMENT_POLL_IDLE_MS;

async function pollComments() {
  if (document.hidden || !number.value) {
    return;
  }
  try {
    const comments = await listComments(number.value);

    if (!sameComments(comments, localComments.value)) {
      localComments.value = comments;
    }
  } catch { /* transient */ }
}

function sameComments(a: LocalComment[], b: LocalComment[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    const x = a[i]; const y = b[i];

    if (x.id !== y.id || x.status !== y.status || x.body !== y.body ||
      x.line !== y.line || x.updated_at !== y.updated_at || x.submitted_at !== y.submitted_at ||
      (x.attachments?.length || 0) !== (y.attachments?.length || 0)) {
      return false;
    }
  }

  return true;
}

function retimeCommentPoll() {
  const state = run.value?.state;
  const agentWorking = state === 'starting' || state === 'waiting-for-sidecars' || state === 'running';
  const wanted = agentWorking ? COMMENT_POLL_ACTIVE_MS : COMMENT_POLL_IDLE_MS;

  if (wanted === commentPollMs) {
    return;
  }
  commentPollMs = wanted;
  if (pollTimer) {
    clearInterval(pollTimer);
  }
  pollTimer = setInterval(pollComments, wanted);
}

function onVisibility() {
  if (document.hidden) {
    return;
  }
  pollComments();
  pollRun();
}

onMounted(async() => {
  await resolveNumber();
  if (!number.value) {
    return;
  }
  restoreUiState();
  await load();
  pruneDiscussions();
  pollRun();
  runPoll = setInterval(pollRun, 5000);
  pollTimer = setInterval(pollComments, commentPollMs);
  sizeReviewPanel();
  rootObserver = new ResizeObserver(sizeReviewPanel);
  if (rootEl.value) {
    rootObserver.observe(rootEl.value);
  }
  narrowMq = window.matchMedia('(max-width: 760px)');
  isNarrow.value = narrowMq.matches;
  narrowMq.addEventListener('change', onNarrow);
  document.addEventListener('visibilitychange', onVisibility);

  // Two screens of margin: files render before they scroll into view.
  nearObserver = new IntersectionObserver((entries) => {
    const next = new Set(nearFiles.value);

    for (const e of entries) {
      const path = (e.target as HTMLElement).dataset.path;

      if (!path) {
        continue;
      }
      if (e.isIntersecting) {
        next.add(path);
      } else if (next.has(path)) {
        rememberHeight(path); next.delete(path);
      }
    }
    nearFiles.value = next;
  }, { rootMargin: '1500px 0px' });
  for (const el of fileEls.values()) {
    nearObserver.observe(el);
  }
  setTimeout(updateActiveFile, 400);
});

onBeforeUnmount(() => {
  if (runPoll) {
    clearInterval(runPoll);
  }
  if (pollTimer) {
    clearInterval(pollTimer);
  }
  document.removeEventListener('visibilitychange', onVisibility);
  narrowMq?.removeEventListener('change', onNarrow);
  nearObserver?.disconnect();
  nearObserver = null;
  rootObserver?.disconnect();
  rootObserver = null;
});

// Full file contents (lines at the PR head), fetched lazily for gap expansion.
const fileContents = reactive(new Map<string, string[] | null>());
const expandedGaps = reactive(new Set<string>());

function buildRows(file: Json): DiffRow[] {
  const hunks = parseHunks(file.patch);

  if (!hunks.length) {
    return [];
  }
  const content = fileContents.get(file.path);
  const canExpand = file.status !== 'removed';
  const rows: DiffRow[] = [];
  let nextOld = 1;
  let nextNew = 1;

  const pushGap = (endNew: number, deltaOld: number, unknownEnd = false) => {
    if (!canExpand) {
      return;
    }
    const startNew = nextNew;
    const count = unknownEnd ? null : endNew - startNew + 1;

    if (!unknownEnd && (count as number) <= 0) {
      return;
    }
    const gapId = `${ file.path }@${ startNew }`;

    if (expandedGaps.has(gapId) && Array.isArray(content) && !unknownEnd) {
      for (let n = startNew; n <= endNew; n++) {
        rows.push({ type: 'ctx', oldN: n + deltaOld, newN: n, text: content[n - 1] ?? '' });
      }
    } else {
      rows.push({ type: 'expand', oldN: null, newN: null, text: '', gapId, count, deltaOld });
    }
  };

  for (const h of hunks) {
    pushGap(h.newStart - 1, h.oldStart - h.newStart);
    rows.push(...h.rows);
    nextOld = h.oldNext;
    nextNew = h.newNext;
  }
  if (Array.isArray(content)) {
    let len = content.length;

    if (len && content[len - 1] === '') {
      len--;
    }
    pushGap(len, nextOld - nextNew);
  } else {
    pushGap(0, nextOld - nextNew, true);
  }

  return rows;
}

async function expandGap(file: Json, row: DiffRow) {
  if (!row.gapId) {
    return;
  }
  if (!fileContents.has(file.path)) {
    try {
      const content = await prFile(number.value, file.path, detail.value?.meta.headSha || '', repo.value);

      fileContents.set(file.path, content.split('\n'));
    } catch (e: Json) {
      fileContents.set(file.path, null);
      toast(`Could not load ${ file.path }: ${ e?.message || e }`, 'error');

      return;
    }
  }
  if (!Array.isArray(fileContents.get(file.path))) {
    toast(`No content available for ${ file.path }`, 'error');

    return;
  }
  expandedGaps.add(row.gapId);
}

interface RowView {
  row: DiffRow;
  gh: Json[];
  local: LocalComment[];
}

interface FileView {
  file: Json;
  rows: RowView[];
  unanchoredGh: Json[];
  unanchoredLocal: LocalComment[];
  ghCount: number;
  localCount: number;
}

function matchesRow(row: DiffRow, side: string, line: number | null): boolean {
  if (line == null) {
    return false;
  }

  return side === 'LEFT' ? row.oldN === line : row.newN === line;
}

function normPath(p: string): string {
  return (p || '').replace(/^(\.\/|a\/|b\/)/, '');
}

const activeFiles = computed<Json[]>(() => rangeFiles.value ?? detail.value?.files ?? []);

const commitLabel = computed(() => {
  const n = selectedShas.value.size;
  const total = detail.value?.commits?.length || 0;

  if (!n || n === total) {
    return 'All commits';
  }

  return n === 1 ? `commit ${ [...selectedShas.value][0].slice(0, 7) }` : `${ n } of ${ total } commits`;
});

async function applySelection() {
  const commits = detail.value?.commits || [];
  const shas = commits.filter((c: Json) => selectedShas.value.has(c.sha)).map((c: Json) => c.sha);

  if (!shas.length || shas.length === commits.length) {
    rangeFiles.value = null;
    combinedDiff.value = true;

    return;
  }
  rangeLoading.value = true;
  try {
    const r = await commitsDiff(number.value, shas, repo.value);

    rangeFiles.value = r.files;
    combinedDiff.value = r.combined;
  } catch (e: Json) {
    toast(`Could not load those commits: ${ e?.message || e }`, 'error');
  } finally {
    rangeLoading.value = false;
  }
}

function toggleCommit(sha: string, e: MouseEvent) {
  const commits = detail.value?.commits || [];
  const next = new Set(selectedShas.value);

  if (e.shiftKey && lastPicked.value) {
    let a = commits.findIndex((c: Json) => c.sha === lastPicked.value);
    let b = commits.findIndex((c: Json) => c.sha === sha);

    if (a > b) {
      [a, b] = [b, a];
    }
    for (let i = a; i <= b; i++) {
      next.add(commits[i].sha);
    }
  } else if (next.has(sha)) {
    next.delete(sha);
  } else {
    next.add(sha);
  }
  lastPicked.value = sha;
  selectedShas.value = next;
  applySelection();
}

function selectAllCommits() {
  selectedShas.value = new Set();
  lastPicked.value = null;
  rangeFiles.value = null;
  combinedDiff.value = true;
}

function commitSelected(sha: string): boolean {
  return selectedShas.value.has(sha);
}

// The local comments that are still this review's: submitted ones are history.
const openComments = computed(() => localComments.value.filter((c) => !c.submitted_at));
const submittedComments = computed(() => localComments.value.filter((c) => !!c.submitted_at));

const fileViews = computed<FileView[]>(() => {
  if (!detail.value) {
    return [];
  }
  const ghByFile = new Map<string, Json[]>();

  for (const c of detail.value.reviewComments || []) {
    const key = normPath(c.path);

    if (!ghByFile.has(key)) {
      ghByFile.set(key, []);
    }
    ghByFile.get(key)!.push(c);
  }
  const localByFile = new Map<string, LocalComment[]>();

  for (const c of openComments.value) {
    const key = normPath(c.path);

    if (!localByFile.has(key)) {
      localByFile.set(key, []);
    }
    localByFile.get(key)!.push(c);
  }

  return activeFiles.value.map((file: Json) => {
    const gh = ghByFile.get(normPath(file.path)) || [];
    const local = localByFile.get(normPath(file.path)) || [];
    const placedGh = new Set<number>();
    const placedLocal = new Set<number>();
    const built = buildRows(file);

    highlightRows(file.path, built);
    const rows: RowView[] = built.map((row) => {
      const ghHere = gh.filter((c) => matchesRow(row, c.side, c.line));
      const localHere = local.filter((c) => matchesRow(row, c.side || 'RIGHT', c.line));

      ghHere.forEach((c) => placedGh.add(c.id));
      localHere.forEach((c) => placedLocal.add(c.id));

      return { row, gh: ghHere, local: localHere };
    });

    return {
      file,
      rows,
      unanchoredGh:    gh.filter((c) => !placedGh.has(c.id)),
      unanchoredLocal: local.filter((c) => !placedLocal.has(c.id)),
      ghCount:         gh.length,
      localCount:      local.length,
    };
  });
});

// ── File collapsing + sidebar navigation ──

const collapsedFiles = reactive(new Set<string>());
const fileEls = new Map<string, HTMLElement>();

function setFileEl(path: string, el: unknown) {
  if (el instanceof HTMLElement) {
    fileEls.set(path, el);
    el.dataset.path = path;
    nearObserver?.observe(el);
  } else {
    const old = fileEls.get(path);

    if (old) {
      nearObserver?.unobserve(old);
    }
    fileEls.delete(path);
  }
}

// ── Only render the diffs you can nearly see ──
const nearFiles = ref<Set<string>>(new Set());
const fileHeights = new Map<string, number>();
let nearObserver: IntersectionObserver | null = null;

function isNear(path: string): boolean {
  return nearFiles.value.has(path);
}

function rememberHeight(path: string): void {
  const el = fileEls.get(path);
  const table = el?.querySelector('.diff-table') as HTMLElement | null;

  if (table?.offsetHeight) {
    fileHeights.set(path, table.offsetHeight);
  }
}

function spacerHeight(fv: FileView): number {
  const known = fileHeights.get(fv.file.path);

  if (known) {
    return known;
  }

  return Math.max(40, fv.rows.length * 19);
}

// ── Scroll spy: which file is currently in view ──
const activeFile = ref<string | null>(null);
let hoveredEl: HTMLElement | null = null;

function hoverCommentEnter(path: string, cl: CommentLine) {
  hoverCommentLeave();
  const fileEl = fileEls.get(path);

  if (!fileEl) {
    return;
  }
  const sel = cl.localId != null ? `[data-local-comment="${ cl.localId }"]` : `[data-gh-comment="${ cl.ghId }"]`;
  const el = fileEl.querySelector(sel) as HTMLElement | null;

  if (!el) {
    return;
  }
  el.classList.add('nav-hover');
  hoveredEl = el;
}

function hoverCommentLeave() {
  hoveredEl?.classList.remove('nav-hover');
  hoveredEl = null;
}
const navEls = new Map<string, HTMLElement>();
const filenavEl = ref<HTMLElement | null>(null);

// The changed-files navigator as a tree rather than a column of full paths.
interface NavRow {
  kind: 'dir' | 'file';
  key: string;
  name: string;
  depth: number;
  path: string;
  fv?: FileView;
}

const collapsedDirs = ref<Set<string>>(new Set());
// Narrow screens: the file navigator is an overlay opened from a button.
const filesOpen = ref(false);

function toggleDir(path: string) {
  const next = new Set(collapsedDirs.value);

  if (next.has(path)) {
    next.delete(path);
  } else {
    next.add(path);
  }
  collapsedDirs.value = next;
}

const navRows = computed<NavRow[]>(() => {
  interface Node { children: Map<string, Node>; files: FileView[] }
  const root: Node = { children: new Map(), files: [] };

  for (const fv of fileViews.value) {
    const parts = fv.file.path.split('/');
    let node = root;

    for (const dir of parts.slice(0, -1)) {
      let next = node.children.get(dir);

      if (!next) {
        next = { children: new Map(), files: [] }; node.children.set(dir, next);
      }
      node = next;
    }
    node.files.push(fv);
  }
  const rows: NavRow[] = [];
  const walk = (node: Node, prefix: string, depth: number) => {
    for (const [name, child] of node.children) {
      let label = name;
      let path = prefix ? `${ prefix }/${ name }` : name;
      let cur = child;

      while (!cur.files.length && cur.children.size === 1) {
        const [onlyName, only] = [...cur.children][0];

        label += `/${ onlyName }`;
        path += `/${ onlyName }`;
        cur = only;
      }
      rows.push({ kind: 'dir', key: `dir:${ path }`, name: label, depth, path });
      if (!collapsedDirs.value.has(path)) {
        walk(cur, path, depth + 1);
      }
    }
    for (const fv of node.files) {
      rows.push({
        kind:  'file',
        key:   fv.file.path,
        name:  fv.file.path.split('/').pop() || fv.file.path,
        depth,
        path:  fv.file.path,
        fv,
      });
    }
  };

  walk(root, '', 0);

  return rows;
});
const bodyEl = ref<HTMLElement | null>(null);

function setNavEl(path: string, el: unknown) {
  if (el instanceof HTMLElement) {
    navEls.set(path, el);
  } else {
    navEls.delete(path);
  }
}

function updateActiveFile() {
  const scroller = bodyEl.value;

  if (!scroller) {
    return;
  }
  if (prLevelComments.value.length && scroller.scrollTop < 40) {
    activeFile.value = '';

    return;
  }
  const top = scroller.getBoundingClientRect().top;
  let best: string | null = null;
  let bestDist = Infinity;

  for (const [path, el] of fileEls) {
    const r = el.getBoundingClientRect();
    const dist = r.top - top;
    const score = dist <= 60 ? Math.abs(dist) : dist + 1000;

    if (score < bestDist) {
      bestDist = score; best = path;
    }
  }
  if (best && best !== activeFile.value) {
    activeFile.value = best;
    const navEl = navEls.get(best);

    if (navEl && filenavEl.value) {
      const nr = navEl.getBoundingClientRect();
      const fr = filenavEl.value.getBoundingClientRect();

      if (nr.top < fr.top || nr.bottom > fr.bottom) {
        navEl.scrollIntoView({ block: 'nearest' });
      }
    }
  }
}

// ── Commented lines shown under the active file ──
interface CommentLine {
  key: string;
  line: number | null;
  side: string;
  tone: 'approved' | 'pending' | 'github';
  preview: string;
  localId?: number;
  ghId?: number;
}

function commentLines(fv: FileView): CommentLine[] {
  const out: CommentLine[] = [];

  for (const c of openComments.value) {
    if (normPath(c.path) !== normPath(fv.file.path)) {
      continue;
    }
    out.push({
      key:     `l${ c.id }`,
      line:    c.line,
      side:    c.side || 'RIGHT',
      tone:    c.status === 'approved' ? 'approved' : 'pending',
      preview: c.body.replace(/\s+/g, ' ').slice(0, 60),
      localId: c.id,
    });
  }
  for (const c of (detail.value?.reviewComments || [])) {
    if (normPath(c.path) !== normPath(fv.file.path)) {
      continue;
    }
    out.push({
      key:     `g${ c.id }`,
      line:    c.line,
      side:    c.side || 'RIGHT',
      tone:    'github',
      preview: (c.author ? `${ c.author }: ` : '') + c.body.replace(/\s+/g, ' ').slice(0, 50),
      ghId:    c.id,
    });
  }

  return out.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
}

function commentTone(fv: FileView): string {
  const locals = openComments.value.filter((c) => normPath(c.path) === normPath(fv.file.path));

  if (!locals.length) {
    return 'github';
  }

  return locals.every((c) => c.status === 'approved') ? 'approved' : 'pending';
}

function scrollToComment(path: string, cl: CommentLine) {
  const fileEl = fileEls.get(path);

  if (!fileEl) {
    return;
  }
  collapsedFiles.delete(path);
  requestAnimationFrame(() => {
    const sel = cl.localId != null ? `[data-local-comment="${ cl.localId }"]` : `[data-gh-comment="${ cl.ghId }"]`;
    const target = fileEl.querySelector(sel) as HTMLElement | null;

    (target || fileEl).scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}

function toggleCollapse(path: string) {
  if (collapsedFiles.has(path)) {
    collapsedFiles.delete(path);
  } else {
    collapsedFiles.add(path);
  }
}

function scrollToTop() {
  filesOpen.value = false;
  bodyEl.value?.scrollTo({ top: 0, behavior: 'smooth' });
}

function scrollToFile(path: string) {
  filesOpen.value = false;
  collapsedFiles.delete(path);
  requestAnimationFrame(() => {
    fileEls.get(path)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

const pendingCount = computed(() => openComments.value.filter((c) => c.status === 'pending').length);
const approvedCount = computed(() => openComments.value.filter((c) => c.status === 'approved').length);
const canSubmit = computed(() => openComments.value.length > 0 && pendingCount.value === 0);

// A comment with no path belongs to the review itself: what GitHub shows at the top of the PR.
const prLevelComments = computed(() => openComments.value.filter((c) => !c.path));

// Comments whose path doesn't match any changed file - shown under the files, not lost.
const orphanedComments = computed(() => {
  const withPath = openComments.value.filter((c) => c.path);

  if (!detail.value) {
    return withPath;
  }
  const filePaths = new Set((detail.value.files || []).map((f: Json) => normPath(f.path)));

  return withPath.filter((c) => !filePaths.has(normPath(c.path)));
});

const prLevelDraft = ref('');
const prLevelSaving = ref(false);

async function addPrLevelComment() {
  const body = prLevelDraft.value.trim();

  if (!body || prLevelSaving.value) {
    return;
  }
  prLevelSaving.value = true;
  try {
    const created = await addComment(number.value, body, undefined, 'you');

    localComments.value = [...localComments.value, created];
    prLevelDraft.value = '';
  } catch (e: Json) {
    toast(`Could not add: ${ e?.message || e }`, 'error');
  } finally {
    prLevelSaving.value = false;
  }
}

function age(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60_000);

  if (mins < 60) {
    return `${ Math.max(mins, 0) }m`;
  }
  const hours = Math.floor(mins / 60);

  if (hours < 24) {
    return `${ hours }h`;
  }

  return `${ Math.floor(hours / 24) }d`;
}

function stateTone(state: string): 'open' | 'merged' | 'closed' | 'neutral' {
  const s = (state || '').toUpperCase();

  if (s === 'OPEN') {
    return 'open';
  }
  if (s === 'MERGED') {
    return 'merged';
  }
  if (s === 'CLOSED') {
    return 'closed';
  }

  return 'neutral';
}

// ── The review agent ──
// A conversation in this workspace, in the Studio's agent pod, running the full review skill.
// Closing the panel keeps it running; the button toggles it back.
const reviewSession = ref<string | null>(null);
const showReviewPanel = ref(false);
const reviewTermState = ref('');

// The docked panel's height: a share of the pane rather than a fixed number, because the pane is
// whatever a tab inside Rancher's chrome gets - and with the Studio's drawer open that can be
// under 500px, where a fixed 380px panel would leave the diff a 40px slot. Measured, not a
// percentage: a percentage height inside a flex column resolves against nothing definite here.
const rootEl = ref<HTMLElement | null>(null);
const reviewPanelHeight = ref(320);
let rootObserver: ResizeObserver | null = null;

function sizeReviewPanel() {
  const total = rootEl.value?.clientHeight || 0;

  if (total) {
    reviewPanelHeight.value = Math.max(160, Math.min(420, Math.round(total * 0.45)));
  }
}

// ── Full review run ──
// The run is minutes of work in phases; the skill reports its phase to the API and the chip
// says which, including "starting" before anything has attached to the conversation.
const run = ref<ReviewRun | null>(null);
let runPoll: ReturnType<typeof setInterval> | undefined;

const runActive = computed(() => !!run.value && ['starting', 'waiting-for-sidecars', 'running'].includes(run.value.state));
const runIdle = computed(() => run.value?.state === 'idle');
const runQueued = computed(() => !!run.value && run.value.state === 'starting' && reviewTermState.value !== 'open');

const runLabel = computed(() => {
  if (!run.value) {
    return null;
  }
  if (run.value.state === 'complete') {
    return 'Review complete';
  }
  if (run.value.state === 'failed') {
    return 'Review failed';
  }
  if (run.value.state === 'cancelled') {
    return run.value.note || 'Review cancelled';
  }
  if (run.value.state === 'idle') {
    return 'Agent idle';
  }
  if (run.value.state === 'starting') {
    return reviewTermState.value === 'open' ? 'Starting…' : 'Queued - opens with the pane';
  }

  return run.value.note || 'Working…';
});

async function pollRun() {
  if (document.hidden || !number.value) {
    return;
  }
  try {
    run.value = await reviewRun(number.value);
    retimeCommentPoll();
  } catch { /* transient */ }
}

async function cancelRun() {
  if (!confirmAction('Cancel the review? The agent and every subagent it started are stopped. Comments already filed are kept.')) {
    return;
  }
  try {
    run.value = await cancelReview(number.value, props.workspace.name, reviewSession.value);
    reviewSession.value = null;
    showReviewPanel.value = false;
    persistUiState();
    toast('Review cancelled');
  } catch (e: Json) {
    toast(`Cancel failed: ${ e?.message || e }`, 'error');
  }
}

// True while there's a live conversation worth toggling back into.
const reviewLive = computed(() => !!reviewSession.value && !['cancelled', 'failed'].includes(run.value?.state || ''));

async function startReview() {
  if (startingReview.value) {
    return;
  }
  if (reviewLive.value) {
    showReviewPanel.value = !showReviewPanel.value;
    persistUiState();

    return;
  }
  reviewSession.value = null;
  startingReview.value = true;
  try {
    const started = await startPrReview(store, { number: number.value, issue: props.issue ? { number: props.issue } : null }, repo.value, props.workspace.name);

    reviewSession.value = started.conversation.id;
    await pollRun();
    showReviewPanel.value = true;
    persistUiState();
  } catch (e: Json) {
    toast(`Failed to start the review agent: ${ e?.message || e }`, 'error');
  } finally {
    startingReview.value = false;
  }
}

// A review started from My Work is a conversation titled for the PR; attach to it if it is there.
async function adoptExistingReview() {
  if (reviewSession.value) {
    return;
  }
  const conversations = await listConversations(props.workspace.name).catch(() => []);
  const review = conversations.find((c) => c.title === `Review #${ number.value }`);

  if (review) {
    reviewSession.value = review.id;
    if (runActive.value) {
      showReviewPanel.value = true;
    }
  }
}

// ── Red CI, spelled out, and the agent that triages it ──
const failures = ref<Json | null>(null);
const showFailures = ref(false);
const failureOpen = ref<number | null>(null);
const failureDetail = ref<Json | null>(null);
const triaging = ref(false);

async function openFailure(check: Json) {
  if (failureOpen.value === check.id) {
    failureOpen.value = null;

    return;
  }
  failureOpen.value = check.id;
  failureDetail.value = null;
  failureDetail.value = await ciFailureDetail(number.value, check.id, repo.value).catch((e: Json) => ({ error: e?.message || String(e) }));
}

async function triageCi() {
  if (triaging.value) {
    return;
  }
  triaging.value = true;
  try {
    const started = await startCiTriage(store, { number: number.value, issue: props.issue ? { number: props.issue } : null }, repo.value, props.workspace.name);

    toast(`CI triage opened as "${ started.conversation.title }" in Conversations. It decides whether the failures are this PR's and fixes or re-runs accordingly.`);
  } catch (e: Json) {
    toast(`Could not start CI triage: ${ e?.message || e }`, 'error');
  } finally {
    triaging.value = false;
  }
}

// ── Squash-merge ──
const merging = ref(false);

const mergeBlocker = computed(() => {
  const ci = detail.value?.meta.ci;

  if (!ci) {
    return null;
  }
  if (ci.failing) {
    return `${ ci.failing } check${ ci.failing === 1 ? '' : 's' } failing`;
  }
  if (ci.pending) {
    return `Waiting for CI - ${ ci.pending } check${ ci.pending === 1 ? '' : 's' } still running`;
  }

  return null;
});

async function doMerge() {
  if (merging.value || !detail.value) {
    return;
  }
  if (!confirmAction(`Squash and merge #${ number.value }?\n\n${ detail.value.meta.title }`)) {
    return;
  }
  merging.value = true;
  try {
    await mergePr(number.value, repo.value);
    toast(`#${ number.value } squashed and merged. The workspace stays until you delete it.`);
    await load();
  } catch (e: Json) {
    toast(`Merge failed: ${ e?.message || e }`, 'error');
  } finally {
    merging.value = false;
  }
}

// ── Replying to an existing GitHub comment ──
const replyingTo = ref<number | null>(null);
const replyDraft = ref('');
const replySending = ref(false);

function toggleReply(id: number) {
  replyingTo.value = replyingTo.value === id ? null : id;
  replyDraft.value = '';
}

async function sendReply(id: number) {
  const body = replyDraft.value.trim();

  if (!body || replySending.value) {
    return;
  }
  replySending.value = true;
  try {
    await replyToComment(number.value, id, body, repo.value);
    replyingTo.value = null;
    replyDraft.value = '';
    toast('Reply posted');
    await load();
  } catch (e: Json) {
    toast(`Reply failed: ${ e?.message || e }`, 'error');
  } finally {
    replySending.value = false;
  }
}

// ── Ship It ──
const shipOpen = ref(false);
const shipBody = ref('');
const shipping = ref(false);

async function shipIt() {
  if (shipping.value) {
    return;
  }
  shipping.value = true;
  try {
    const r = await approvePr(number.value, shipBody.value.trim(), repo.value);

    shipOpen.value = false;
    shipBody.value = '';
    toast(r.discarded ? `Approved - ${ r.discarded } pending comment${ r.discarded === 1 ? '' : 's' } discarded` : 'Approved');
    await load();
  } catch (e: Json) {
    toast(`Approve failed: ${ e?.message || e }`, 'error');
  } finally {
    shipping.value = false;
  }
}

async function toggleApprove(c: LocalComment) {
  try {
    const updated = await updateComment(number.value, c.id, { status: c.status === 'approved' ? 'pending' : 'approved' });

    localComments.value = localComments.value.map((x) => (x.id === c.id ? updated : x));
  } catch (e: Json) {
    toast(`Update failed: ${ e?.message || e }`, 'error');
  }
}

async function approveAll() {
  for (const c of openComments.value.filter((x) => x.status !== 'approved')) {
    await updateComment(number.value, c.id, { status: 'approved' }).catch(() => {});
  }
  await pollComments();
}

// ── Mobile: comments first ──
const isNarrow = ref(false);
let narrowMq: MediaQueryList | null = null;
const onNarrow = (e: MediaQueryListEvent | MediaQueryList) => {
  isNarrow.value = e.matches;
};

const mobileView = ref<'comments' | 'diff'>('comments');

interface CommentCard {
  id: number;
  kind: 'local' | 'github';
  path: string | null;
  line: number | null;
  side: string;
  body: string;
  status: string;
  comment?: LocalComment;
  author?: string;
  context: DiffRow[];
}

const CONTEXT_RADIUS = 4;

function contextFor(path: string | null, line: number | null): DiffRow[] {
  if (!path || line == null) {
    return [];
  }
  const fv = fileViews.value.find((f) => normPath(f.file.path) === normPath(path));

  if (!fv) {
    return [];
  }
  const rows = fv.rows.map((r) => r.row).filter((r) => r.type !== 'expand');
  const at = rows.findIndex((r) => r.newN === line || (r.newN == null && r.oldN === line));

  if (at === -1) {
    return rows.slice(0, CONTEXT_RADIUS * 2);
  }

  return rows.slice(Math.max(0, at - CONTEXT_RADIUS), at + CONTEXT_RADIUS + 1);
}

const commentCards = computed<CommentCard[]>(() => {
  const cards: CommentCard[] = [];

  for (const c of openComments.value) {
    cards.push({
      id:      c.id,
      kind:    'local',
      path:    c.path || null,
      line:    c.line,
      side:    c.side || 'RIGHT',
      body:    c.body,
      status:  c.status,
      comment: c,
      context: contextFor(c.path || null, c.line),
    });
  }
  for (const g of detail.value?.reviewComments || []) {
    cards.push({
      id:      g.id,
      kind:    'github',
      path:    g.path || null,
      line:    g.line,
      side:    g.side || 'RIGHT',
      body:    g.body,
      status:  g.pending ? 'pending on GitHub' : 'posted',
      author:  g.author,
      context: contextFor(g.path || null, g.line),
    });
  }

  return cards.sort((a, b) => {
    if (!a.path !== !b.path) {
      return a.path ? 1 : -1;
    }

    return (a.path || '').localeCompare(b.path || '') || (a.line || 0) - (b.line || 0);
  });
});

const expandedCard = ref<string | null>(null);

function cardKey(card: CommentCard): string {
  return `${ card.kind }-${ card.id }`;
}

function toggleCard(card: CommentCard): void {
  const key = cardKey(card);
  const opening = expandedCard.value !== key;

  expandedCard.value = opening ? key : null;
  if (opening) {
    nextTick(() => {
      document.querySelector(`[data-card="${ key }"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  }
}

function isExpanded(card: CommentCard): boolean {
  return expandedCard.value === cardKey(card);
}

function cardPreview(body: string): string {
  return (body || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[\[attach:[^\]]*\]\]/g, ' ')
    .replace(/[*_`>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90);
}

watch(() => commentCards.value.length, (n) => {
  if (n && expandedCard.value === null) {
    expandedCard.value = cardKey(commentCards.value[0]);
  }
});

function fileLabel(path: string | null): string {
  if (!path) {
    return 'PR-level';
  }
  const parts = path.split('/');

  return parts[parts.length - 1];
}

function showInDiff(card: CommentCard) {
  mobileView.value = 'diff';
  if (card.path) {
    nextTick(() => scrollToFile(card.path as string));
  }
}

// ── Inline discussions: one per comment, adjacent to the comment's card ──
// Which comments have a discussion open, and which conversation each belongs to - the latter
// persisted, so closing and reopening (or a reload) reattaches rather than starting another.
const openDiscussions = reactive(new Set<number>());
// Comment id -> the conversation discussing it. The API hands a deleted comment's id to the next
// one filed, so each entry also remembers when its comment was made and is dropped when the
// comment with that id is a different comment.
const discussionSessions = reactive(new Map<number, string>());
const discussionMade = reactive(new Map<number, string>());

function pruneDiscussions() {
  const byId = new Map(localComments.value.map((c) => [c.id, c.created_at]));

  for (const id of [...openDiscussions]) {
    if (!byId.has(id)) {
      openDiscussions.delete(id);
    }
  }
  for (const id of [...discussionSessions.keys()]) {
    // No record of which comment it was for, or a record of a different one: not this one's.
    if (!discussionMade.has(id) || byId.get(id) !== discussionMade.get(id)) {
      discussionSessions.delete(id);
      discussionMade.delete(id);
      openDiscussions.delete(id);
    }
  }
}
const discussionSeeds = reactive(new Map<number, string>());
// A conversation about the composer's line selection (no comment filed).
const composerDiscussion = ref<{ path: string; line: number; startLine: number | null; side: string; code: string; seed: string; session?: string } | null>(null);

function discuss(c: LocalComment) {
  if (openDiscussions.has(c.id)) {
    openDiscussions.delete(c.id);
  } else {
    openDiscussions.add(c.id);
  }
  persistUiState();
}

function closeDiscussion(id: number) {
  openDiscussions.delete(id);
  persistUiState();
}

function rememberDiscussion(id: number, session: string) {
  discussionSessions.set(id, session);
  discussionMade.set(id, localComments.value.find((c) => c.id === id)?.created_at || '');
  persistUiState();
}

// ── Persisted panel state ──
const STATE_KEY = () => `dev-extension.pr-review.${ number.value }`;

function persistUiState() {
  try {
    localStorage.setItem(STATE_KEY(), JSON.stringify({
      discussions:         [...openDiscussions],
      discussionSessions:  [...discussionSessions.entries()],
      discussionMade:      [...discussionMade.entries()],
      composerDiscussion:  composerDiscussion.value,
      reviewSession:       reviewSession.value,
      showReviewPanel:     showReviewPanel.value,
      showConversation:    showConversation.value,
    }));
  } catch { /* ignore */ }
}

function restoreUiState() {
  try {
    const raw = localStorage.getItem(STATE_KEY());

    if (!raw) {
      return;
    }
    const s = JSON.parse(raw);

    for (const id of s.discussions || []) {
      openDiscussions.add(Number(id));
    }
    for (const [id, session] of s.discussionSessions || []) {
      discussionSessions.set(Number(id), String(session));
    }
    for (const [id, made] of s.discussionMade || []) {
      discussionMade.set(Number(id), String(made));
    }
    if (s.composerDiscussion?.path) {
      composerDiscussion.value = s.composerDiscussion;
      composer.value = {
        path: s.composerDiscussion.path, side: s.composerDiscussion.side, line: s.composerDiscussion.line, startLine: s.composerDiscussion.startLine,
      };
    }
    if (typeof s.reviewSession === 'string') {
      reviewSession.value = s.reviewSession;
    }
    if (s.showReviewPanel) {
      showReviewPanel.value = true;
    }
    if (s.showConversation) {
      showConversation.value = true;
    }
  } catch { /* ignore */ }
}

watch(number, (n) => {
  if (n) {
    adoptExistingReview();
  }
});

// ── Manual line comments: click a line number to open a composer there;
// Shift+click another line (same file/side) extends it to a range. ──

const composer = ref<{ path: string; side: 'LEFT' | 'RIGHT'; line: number; startLine: number | null } | null>(null);
const composerDraft = ref('');
const composerSaving = ref(false);

function lineClick(path: string, row: DiffRow, e: MouseEvent) {
  const side: 'LEFT' | 'RIGHT' | null = row.newN != null ? 'RIGHT' : row.oldN != null ? 'LEFT' : null;

  if (!side) {
    return;
  }
  const line = (side === 'RIGHT' ? row.newN : row.oldN)!;
  const cur = composer.value;

  if (e.shiftKey && cur && cur.path === path && cur.side === side) {
    const lo = Math.min(cur.startLine ?? cur.line, line);
    const hi = Math.max(cur.startLine ?? cur.line, line);

    composer.value = { path, side, line: hi, startLine: lo === hi ? null : lo };
  } else if (cur && cur.path === path && cur.side === side && cur.line === line && !cur.startLine) {
    composer.value = null;
  } else {
    composer.value = { path, side, line, startLine: null };
  }
}

function composerMatches(path: string, row: DiffRow): boolean {
  const cmp = composer.value;

  if (!cmp || cmp.path !== path) {
    return false;
  }

  return cmp.side === 'RIGHT' ? row.newN === cmp.line : row.oldN === cmp.line;
}

function inComposerRange(path: string, row: DiffRow): boolean {
  const cmp = composer.value;

  if (!cmp || cmp.path !== path) {
    return false;
  }
  const n = cmp.side === 'RIGHT' ? row.newN : row.oldN;

  if (n == null) {
    return false;
  }

  return n >= (cmp.startLine ?? cmp.line) && n <= cmp.line;
}

function cancelComposer() {
  composer.value = null;
  composerDraft.value = '';
  composerDiscussion.value = null;
  persistUiState();
}

// The lines the composer covers, as plain text for the agent's context.
function selectedCode(cmp: { path: string; side: 'LEFT' | 'RIGHT'; line: number; startLine: number | null }): string {
  const fv = fileViews.value.find((f) => normPath(f.file.path) === normPath(cmp.path));

  if (!fv) {
    return '';
  }
  const lo = cmp.startLine ?? cmp.line;
  const out: string[] = [];

  for (const rv of fv.rows) {
    const n = cmp.side === 'RIGHT' ? rv.row.newN : rv.row.oldN;

    if (n != null && n >= lo && n <= cmp.line) {
      out.push(rv.row.text);
    }
  }

  return out.join('\n');
}

function discussComposer() {
  const cmp = composer.value;

  if (!cmp) {
    return;
  }
  composerDiscussion.value = {
    path:      cmp.path,
    line:      cmp.line,
    startLine: cmp.startLine,
    side:      cmp.side,
    code:      selectedCode(cmp),
    seed:      composerDraft.value.trim(),
  };
  persistUiState();
}

function rememberComposerDiscussion(session: string) {
  if (composerDiscussion.value) {
    composerDiscussion.value = { ...composerDiscussion.value, session };
    persistUiState();
  }
}

async function saveComposer() {
  const cmp = composer.value;
  const body = composerDraft.value.trim();

  if (!cmp || !body || composerSaving.value) {
    return;
  }
  composerSaving.value = true;
  try {
    const created = await addComment(number.value, body, {
      path: cmp.path, line: cmp.line, startLine: cmp.startLine ?? undefined, side: cmp.side,
    }, 'you');

    localComments.value = [...localComments.value, created];
    cancelComposer();
  } catch (e: Json) {
    toast(`Failed to add comment: ${ e?.message || e }`, 'error');
  } finally {
    composerSaving.value = false;
  }
}

// ── Manual editing of a local comment's body ──
const editingId = ref<number | null>(null);
const editDraft = ref('');

function startEdit(c: LocalComment) {
  editingId.value = c.id;
  editDraft.value = c.body;
}

function cancelEdit() {
  editingId.value = null;
}

async function saveEdit(c: LocalComment) {
  const body = editDraft.value.trim();

  if (!body) {
    return;
  }
  try {
    const updated = await updateComment(number.value, c.id, { body });

    localComments.value = localComments.value.map((x) => (x.id === c.id ? updated : x));
    editingId.value = null;
  } catch (e: Json) {
    toast(`Update failed: ${ e?.message || e }`, 'error');
  }
}

async function removeAttachment(c: LocalComment, path: string) {
  const keep = (c.attachments || []).filter((a) => a.path !== path);

  try {
    const updated = await updateComment(number.value, c.id, { attachments: keep.map((a) => ({ path: a.path, caption: a.caption })) });

    localComments.value = localComments.value.map((x) => (x.id === c.id ? updated : x));
  } catch (e: Json) {
    toast(`Could not remove the attachment: ${ e?.message || e }`, 'error');
  }
}

async function removeComment(c: LocalComment) {
  if (!confirmAction('Delete this pending comment? It has not been submitted to GitHub, so it is only removed from here.')) {
    return;
  }
  try {
    await deleteComment(number.value, c.id);
    localComments.value = localComments.value.filter((x) => x.id !== c.id);
  } catch (e: Json) {
    toast(`Delete failed: ${ e?.message || e }`, 'error');
  }
}

async function doSubmit() {
  if (!canSubmit.value || submitting.value) {
    return;
  }
  submitting.value = true;
  try {
    const r = await submitReview(number.value, repo.value);

    toast(`Posted ${ r.posted } comment${ r.posted === 1 ? '' : 's' } to GitHub as one review.${ r.url ? ` ${ r.url }` : '' }`);
    await load();
  } catch (e: Json) {
    toast(`Submit failed: ${ e?.message || e }`, 'error');
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div
    ref="rootEl"
    class="pr-review"
  >
    <Banner
      v-if="resolveMessage"
      color="info"
      :label="resolveMessage"
      class="prm-banner"
    />
    <div
      v-else-if="resolving"
      class="prm-loading"
    >
      Looking up the pull request…
    </div>
    <template v-else>
      <header class="prm-header">
        <div class="prm-header-row">
        <div class="prm-title">
          <PrBadge
            v-if="detail"
            :tone="stateTone(detail.meta.state)"
          >
            {{ detail.meta.state.toLowerCase() }}
          </PrBadge>
          <a
            v-if="detail"
            :href="detail.meta.url"
            target="_blank"
            rel="noopener"
          >#{{ number }}</a>
          <span v-else>#{{ number }}</span>
          <span class="prm-title-text">{{ detail?.meta.title || 'Loading...' }}</span>
          <PrBadge
            v-if="detail?.meta.approved"
            tone="success"
            class="approved-badge"
            title="Approved, with no outstanding changes requested"
          >
            ✓ approved
          </PrBadge>
        </div>
        <div class="prm-actions">
          <PrButton
            v-if="detail && detail.meta.state === 'OPEN' && !detail.meta.approved"
            size="sm"
            :variant="shipOpen ? 'accent' : 'default'"
            :class="{ ship: !shipOpen }"
            title="Approve this PR now (pending comments are discarded)"
            @click="shipOpen = !shipOpen"
          >
            Ship It
          </PrButton>
          <PrButton
            v-if="detail?.meta.approved && !detail.meta.merged && detail.meta.state === 'OPEN'"
            size="sm"
            class="merge"
            :disabled="merging || !!mergeBlocker"
            :title="mergeBlocker || 'Squash and merge this approved PR'"
            @click="doMerge"
          >
            {{ merging ? 'Merging…' : (mergeBlocker ? 'Waiting for CI' : 'Squash & merge') }}
          </PrButton>
          <span
            v-if="runLabel"
            class="run-chip"
            :class="run?.state"
            :title="run?.note || ''"
          >
            <i
              v-if="runActive"
              class="icon icon-spinner icon-spin"
            />
            {{ runLabel }}
          </span>
          <PrButton
            v-if="runActive || runIdle"
            size="sm"
            variant="danger"
            title="Stop the agent and all of its subagents"
            @click="cancelRun"
          >
            Cancel
          </PrButton>
          <PrButton
            size="sm"
            :variant="showReviewPanel ? 'accent' : 'default'"
            :disabled="startingReview"
            data-testid="pr-review-agent"
            @click="startReview()"
          >
            {{ startingReview ? 'Starting…' : (runActive || runIdle || reviewLive ? (showReviewPanel ? 'Hide agent' : 'Show agent') : 'Review / Respond') }}
          </PrButton>
          <PrButton
            v-if="pendingCount && openComments.length > 1"
            size="sm"
            title="Mark every pending comment good"
            @click="approveAll"
          >
            Mark all good
          </PrButton>
          <PrButton
            v-if="canSubmit"
            size="sm"
            variant="primary"
            :disabled="submitting"
            data-testid="pr-submit"
            @click="doSubmit"
          >
            {{ submitting ? 'Posting…' : `Submit ${ approvedCount } to GitHub` }}
          </PrButton>
        </div>
        </div>
        <div
          v-if="detail"
          class="prm-meta"
        >
          {{ detail.meta.author }} · {{ detail.meta.baseRef }} ← {{ detail.meta.headRef }} ·
          <span class="add-count">+{{ detail.meta.additions }}</span>
          <span class="del-count">−{{ detail.meta.deletions }}</span> ·
          {{ detail.meta.changedFiles }} files
          <button
            type="button"
            class="conv-toggle"
            @click="showCommits = !showCommits"
          >
            {{ commitLabel }} ({{ (detail.commits || []).length }} commits)
          </button>
          <button
            v-if="detail.meta.ci"
            type="button"
            class="conv-toggle"
            :class="{ 'ci-red': detail.meta.ci.failing, 'ci-pending': !detail.meta.ci.failing && detail.meta.ci.pending, 'ci-green': !detail.meta.ci.failing && !detail.meta.ci.pending }"
            :title="detail.meta.ci.failing ? 'Which checks failed, and why' : ''"
            @click="showFailures = !showFailures"
          >
            <template v-if="detail.meta.ci.failing">{{ detail.meta.ci.failing }} check{{ detail.meta.ci.failing === 1 ? '' : 's' }} failing</template>
            <template v-else-if="detail.meta.ci.pending">{{ detail.meta.ci.pending }} check{{ detail.meta.ci.pending === 1 ? '' : 's' }} running</template>
            <template v-else>CI green</template>
          </button>
        </div>
      </header>

      <!-- Ship It: an optional word, then the approval goes to GitHub. -->
      <div
        v-if="shipOpen"
        class="ship-box"
      >
        <textarea
          v-model="shipBody"
          class="edit-textarea"
          placeholder="Optional comment to go with the approval…"
        />
        <div class="ship-actions">
          <span
            v-if="openComments.length"
            class="ship-warn"
          >
            {{ openComments.length }} pending comment{{ openComments.length === 1 ? '' : 's' }} will be discarded.
          </span>
          <PrButton
            size="mini"
            @click="shipOpen = false"
          >
            Cancel
          </PrButton>
          <PrButton
            size="mini"
            variant="primary"
            :disabled="shipping"
            @click="shipIt"
          >
            {{ shipping ? 'Approving…' : 'Approve & submit' }}
          </PrButton>
        </div>
      </div>

      <!-- Red CI, spelled out: which checks, and on expand what the failure actually was. -->
      <div
        v-if="showFailures && detail?.meta.ci"
        class="prm-ci"
      >
        <div class="ci-head">
          <span v-if="!detail.meta.ci.failing">{{ detail.meta.ci.pending ? 'Checks are still running.' : `All ${ detail.meta.ci.total } checks passed.` }}</span>
          <span v-else-if="!failures">Reading the failing checks…</span>
          <span v-else>{{ failures.checks?.length || 0 }} failing check{{ (failures.checks?.length || 0) === 1 ? '' : 's' }} on {{ detail.meta.headSha.slice(0, 7) }}</span>
          <span class="ci-spacer" />
          <PrButton
            v-if="detail.meta.ci.failing"
            size="mini"
            variant="accent"
            :disabled="triaging"
            title="A conversation that decides whether the failures are this PR's and fixes or re-runs accordingly"
            @click="triageCi"
          >
            {{ triaging ? 'Opening…' : 'Fix CI with the agent' }}
          </PrButton>
          <PrButton
            size="mini"
            @click="showFailures = false"
          >
            Done
          </PrButton>
        </div>
        <div
          v-for="check in (failures?.checks || [])"
          :key="check.id"
          class="ci-check"
        >
          <button
            type="button"
            class="ci-check-name"
            @click="openFailure(check)"
          >
            <span class="filenav-caret" :class="{ folded: failureOpen !== check.id }">▾</span>
            {{ check.name }}
            <span class="muted"> {{ check.conclusion }}</span>
          </button>
          <a
            :href="check.url"
            target="_blank"
            rel="noopener noreferrer"
          >log</a>
          <div
            v-if="failureOpen === check.id"
            class="ci-check-detail"
          >
            <span
              v-if="!failureDetail"
              class="muted"
            >Reading the job log…</span>
            <p
              v-else-if="failureDetail.error"
              class="del-count"
            >{{ failureDetail.error }}</p>
            <template v-else>
              <p
                v-for="(a, i) in (failureDetail.annotations || []).slice(0, 6)"
                :key="i"
                class="ci-annotation"
              >
                <code>{{ a.path }}:{{ a.line }}</code> {{ a.message }}
              </p>
              <pre
                v-if="failureDetail.log"
                class="ci-log"
              >{{ failureDetail.log.text }}</pre>
            </template>
          </div>
        </div>
      </div>

      <!-- Waiting on the pane: the conversation exists but nothing has attached to it yet. -->
      <div
        v-if="showReviewPanel && runQueued && !reviewSession"
        class="prm-queued"
      >
        <i class="icon icon-spinner icon-spin" />
        <span>{{ run?.note || 'Waiting for the conversation…' }}</span>
      </div>

      <!-- Review agent terminal, docked directly below the title bar. -->
      <div
        v-if="showReviewPanel && reviewSession"
        class="prm-review-panel"
        :style="{ height: `${ reviewPanelHeight }px` }"
      >
        <div class="review-panel-header">
          <span class="review-panel-title">Review agent</span>
          <span class="review-panel-sub">
            PR #{{ number }} — files pending comments as it works · conversation {{ reviewSession }} in {{ workspace.name }}
          </span>
          <PrButton
            variant="ghost"
            size="mini"
            class="prm-close"
            title="Close panel (agent keeps running)"
            @click="showReviewPanel = false; persistUiState()"
          >
            &times;
          </PrButton>
        </div>
        <StudioTerminal
          :key="reviewSession"
          :session="reviewSession"
          class="review-term"
          @state="reviewTermState = $event"
        />
      </div>

      <!-- Commit picker: click one commit, shift+click another for a range. -->
      <div
        v-if="showCommits && detail"
        class="prm-commits"
      >
        <div class="commits-head">
          <span>Showing <strong>{{ commitLabel }}</strong></span>
          <span
            v-if="rangeLoading"
            class="muted"
          >loading…</span>
          <span
            v-if="!combinedDiff && rangeFiles"
            class="muted"
          >hunks grouped per commit</span>
          <PrButton
            size="mini"
            @click="selectAllCommits"
          >
            All commits
          </PrButton>
          <PrButton
            size="mini"
            @click="showCommits = false"
          >
            Done
          </PrButton>
        </div>
        <button
          v-for="(c, i) in (detail.commits || [])"
          :key="c.sha"
          type="button"
          class="commit-row"
          :class="{ selected: commitSelected(c.sha) }"
          :title="`${ c.sha }\n${ c.author }`"
          @click="toggleCommit(c.sha, $event)"
        >
          <span class="commit-check">{{ commitSelected(c.sha) ? '☑' : '☐' }}</span>
          <span class="commit-idx">{{ i + 1 }}</span>
          <span class="commit-sha">{{ c.sha.slice(0, 7) }}</span>
          <span class="commit-msg">{{ c.message }}</span>
          <span class="commit-author">{{ c.author }}</span>
        </button>
      </div>

      <div
        v-if="openComments.length || submittedComments.length"
        class="prm-progress"
      >
        <template v-if="openComments.length">
          {{ approvedCount }}/{{ openComments.length }} comments approved
          <span
            v-if="pendingCount"
            class="muted"
          >— approve every pending comment to enable submission</span>
        </template>
        <span
          v-if="submittedComments.length"
          class="muted"
        >{{ openComments.length ? ' · ' : '' }}{{ submittedComments.length }} already submitted to GitHub</span>
        <span
          v-if="orphanedComments.length"
          class="muted"
        >
          · {{ orphanedComments.length }} reference paths not in this diff
        </span>
      </div>

      <div
        v-if="error"
        class="prm-error"
      >
        {{ error }}
      </div>
      <div
        v-else-if="loading && !detail"
        class="prm-loading"
      >
        Loading PR #{{ number }}...
      </div>

      <div
        v-if="detail"
        class="prm-main"
      >
        <!-- Changed-files navigator: click scrolls to the file; the bubble marks files with comments. -->
        <aside
          ref="filenavEl"
          class="prm-filenav"
          :class="{ open: filesOpen }"
        >
          <div
            v-if="prLevelComments.length"
            class="filenav-item"
            :class="{ active: activeFile === '' }"
            title="The review body, at the top of the PR"
            @click="scrollToTop()"
          >
            <span class="filenav-name">root</span>
            <span class="filenav-icons">
              <span
                class="filenav-comments"
                :class="prLevelComments.every(c => c.status === 'approved') ? 'approved' : 'pending'"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                ><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
                {{ prLevelComments.length }}
              </span>
            </span>
          </div>
          <template
            v-for="row in navRows"
            :key="row.key"
          >
            <div
              v-if="row.kind === 'dir'"
              class="filenav-dir"
              :style="{ paddingLeft: `calc(var(--dev-space-4) + ${ row.depth } * var(--dev-space-3))` }"
              :title="row.path"
              @click="toggleDir(row.path)"
            >
              <span
                class="filenav-caret"
                :class="{ folded: collapsedDirs.has(row.path) }"
              >▾</span>
              <span class="filenav-dir-name">{{ row.name }}</span>
            </div>
            <template v-else-if="row.fv">
              <div
                class="filenav-item"
                :class="{ active: activeFile === row.fv.file.path }"
                :style="{ paddingLeft: `calc(var(--dev-space-4) + ${ row.depth } * var(--dev-space-3))` }"
                :ref="(el) => setNavEl(row.fv!.file.path, el)"
                :title="row.fv.file.path"
                @click="scrollToFile(row.fv.file.path)"
              >
                <span class="filenav-name">{{ row.name }}</span>
                <span class="filenav-icons">
                  <span
                    v-if="row.fv.ghCount + row.fv.localCount > 0"
                    class="filenav-comments"
                    :class="commentTone(row.fv)"
                    :title="`${ row.fv.localCount } pending/approved local, ${ row.fv.ghCount } GitHub`"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                    ><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
                    {{ row.fv.ghCount + row.fv.localCount }}
                  </span>
                </span>
              </div>
              <div
                v-if="activeFile === row.fv.file.path && commentLines(row.fv).length"
                class="filenav-lines"
              >
                <button
                  v-for="cl in commentLines(row.fv)"
                  :key="cl.key"
                  type="button"
                  class="filenav-line"
                  :class="cl.tone"
                  @click.stop="scrollToComment(row.fv!.file.path, cl)"
                  @mouseenter="hoverCommentEnter(row.fv!.file.path, cl)"
                  @mouseleave="hoverCommentLeave()"
                >
                  <span class="filenav-line-no">L{{ cl.line ?? '?' }}</span>
                  <span class="filenav-line-text">{{ cl.preview }}</span>
                </button>
              </div>
            </template>
          </template>
        </aside>

        <div
          v-if="filesOpen"
          class="filenav-backdrop"
          @click="filesOpen = false"
        />
        <!-- Narrow screens open on the comments; the diff is a tap away. -->
        <div
          v-if="isNarrow"
          class="prm-mobile-switch"
        >
          <PrButton
            size="sm"
            :variant="mobileView === 'comments' ? 'primary' : 'default'"
            @click="mobileView = 'comments'"
          >
            Comments <span v-if="commentCards.length">({{ commentCards.length }})</span>
          </PrButton>
          <PrButton
            size="sm"
            :variant="mobileView === 'diff' ? 'primary' : 'default'"
            @click="mobileView = 'diff'"
          >
            Diff
          </PrButton>
          <PrButton
            size="sm"
            variant="ghost"
            @click="filesOpen = !filesOpen"
          >
            Files
          </PrButton>
        </div>

        <div
          v-if="isNarrow && mobileView === 'comments'"
          class="prm-cards"
        >
          <p
            v-if="!commentCards.length"
            class="muted prm-cards-empty"
          >
            No comments on this PR yet.
          </p>

          <article
            v-for="card in commentCards"
            :key="cardKey(card)"
            class="prm-card"
            :class="{ expanded: isExpanded(card) }"
            :data-card="cardKey(card)"
          >
            <header
              class="prm-card-head"
              @click="toggleCard(card)"
            >
              <span class="prm-card-chevron">{{ isExpanded(card) ? '▾' : '▸' }}</span>
              <span class="prm-card-file">{{ fileLabel(card.path) }}<span
                v-if="card.line"
                class="muted"
              >:{{ card.line }}</span></span>
              <PrBadge :tone="card.kind === 'github' ? 'neutral' : (card.status === 'approved' ? 'success' : 'warning')">
                {{ card.kind === 'github' ? (card.author || 'github') : card.status }}
              </PrBadge>
            </header>

            <p
              v-if="!isExpanded(card)"
              class="prm-card-preview"
              @click="toggleCard(card)"
            >
              {{ cardPreview(card.body) }}
            </p>

            <div
              v-if="isExpanded(card) && card.context.length"
              class="prm-card-context"
            >
              <div
                v-for="(row, i) in card.context"
                :key="i"
                class="prm-ctx-row"
                :class="[row.type, { anchor: row.newN === card.line }]"
              >
                <span class="prm-ctx-no">{{ row.newN ?? row.oldN ?? '' }}</span>
                <span class="prm-ctx-code">{{ row.text }}</span>
              </div>
            </div>

            <div
              v-if="isExpanded(card) && editingId === card.id"
              class="prm-card-edit"
            >
              <textarea
                v-model="editDraft"
                class="edit-textarea"
              />
              <div class="prm-card-actions">
                <PrButton
                  size="sm"
                  variant="primary"
                  @click="saveEdit(card.comment!)"
                >
                  Save
                </PrButton>
                <PrButton
                  size="sm"
                  @click="cancelEdit"
                >
                  Cancel
                </PrButton>
              </div>
            </div>
            <div
              v-else-if="isExpanded(card)"
              class="prm-card-body md-body"
              v-html="renderMd(card.body)"
            />

            <CommentAttachments
              v-if="isExpanded(card) && card.comment?.attachments?.length"
              :pr="number"
              :attachments="card.comment.attachments"
              :removable="card.kind === 'local'"
              @remove="removeAttachment(card.comment!, $event)"
            />

            <div
              v-if="isExpanded(card)"
              class="prm-card-actions"
            >
              <template v-if="card.kind === 'local'">
                <PrButton
                  size="sm"
                  :variant="card.status === 'approved' ? 'success' : 'primary'"
                  @click="toggleApprove(card.comment!)"
                >
                  {{ card.status === 'approved' ? 'Approved' : 'Mark good' }}
                </PrButton>
                <PrButton
                  size="sm"
                  @click="startEdit(card.comment!)"
                >
                  Edit
                </PrButton>
                <PrButton
                  size="sm"
                  :variant="openDiscussions.has(card.id) ? 'accent' : 'default'"
                  @click="discuss(card.comment!)"
                >
                  {{ openDiscussions.has(card.id) ? 'Discussing' : 'Discuss' }}
                </PrButton>
                <PrButton
                  size="sm"
                  variant="danger"
                  @click="removeComment(card.comment!)"
                >
                  Delete
                </PrButton>
              </template>
              <PrButton
                v-if="card.path"
                size="sm"
                variant="ghost"
                @click="showInDiff(card)"
              >
                In diff ↓
              </PrButton>
            </div>

            <CommentDiscussion
              v-if="isExpanded(card) && card.comment && openDiscussions.has(card.id)"
              :pr="number"
              :repo="repo"
              :workspace="workspace.name"
              :comment="card.comment"
              :session="discussionSessions.get(card.id) || ''"
              :initial-message="discussionSeeds.get(card.id) || ''"
              class="prm-card-discussion"
              @session="rememberDiscussion(card.id, $event)"
              @close="closeDiscussion(card.id)"
            />
          </article>
        </div>

        <div
          v-show="!isNarrow || mobileView === 'diff'"
          ref="bodyEl"
          class="prm-body"
          @scroll.passive="updateActiveFile"
        >
          <!-- PR-level comments: the review's own body, above the diff. -->
          <section class="prm-prlevel">
            <div class="prlevel-head">
              <PrBadge tone="accent">
                PR-level
              </PrBadge>
              <span class="muted">Posted at the top of the PR, not against a line — this becomes the review body.</span>
            </div>
            <template
              v-for="c in prLevelComments"
              :key="c.id"
            >
              <div
                class="comment local-comment"
                :class="c.status"
                :data-local-comment="c.id"
              >
                <div class="comment-head">
                  <span class="comment-author">{{ c.author || 'pending' }} · PR-level</span>
                  <PrBadge :tone="c.status === 'approved' ? 'success' : 'warning'">
                    {{ c.status }}
                  </PrBadge>
                  <span class="comment-actions">
                    <PrButton
                      size="mini"
                      class="approve"
                      @click="toggleApprove(c)"
                    >{{ c.status === 'approved' ? 'Unapprove' : 'Mark good' }}</PrButton>
                    <PrButton
                      size="mini"
                      @click="startEdit(c)"
                    >Edit</PrButton>
                    <PrButton
                      size="mini"
                      :variant="openDiscussions.has(c.id) ? 'accent' : 'default'"
                      @click="discuss(c)"
                    >Discuss</PrButton>
                    <PrButton
                      size="mini"
                      variant="danger"
                      @click="removeComment(c)"
                    >Delete</PrButton>
                  </span>
                </div>
                <div
                  v-if="editingId === c.id"
                  class="comment-edit"
                >
                  <textarea
                    v-model="editDraft"
                    class="edit-textarea"
                    @keydown.esc.prevent="cancelEdit"
                  />
                  <div class="edit-btns">
                    <PrButton
                      size="mini"
                      class="approve"
                      @click="saveEdit(c)"
                    >Save</PrButton>
                    <PrButton
                      size="mini"
                      @click="cancelEdit"
                    >Cancel</PrButton>
                  </div>
                </div>
                <div
                  v-else
                  class="comment-body md-body"
                  v-html="renderMd(c.body)"
                />
                <CommentAttachments
                  v-if="c.attachments?.length"
                  :pr="number"
                  :attachments="c.attachments"
                  removable
                  @remove="removeAttachment(c, $event)"
                />
              </div>
              <CommentDiscussion
                v-if="openDiscussions.has(c.id)"
                :pr="number"
                :repo="repo"
                :workspace="workspace.name"
                :comment="c"
                :session="discussionSessions.get(c.id) || ''"
                :initial-message="discussionSeeds.get(c.id) || ''"
                @session="rememberDiscussion(c.id, $event)"
                @close="closeDiscussion(c.id)"
              />
            </template>
            <div
              v-if="!prLevelComments.length"
              class="prlevel-compose"
            >
              <textarea
                v-model="prLevelDraft"
                class="edit-textarea"
                rows="2"
                placeholder="Context for the whole PR — testing notes, what the recordings show, anything that isn't a change request."
              />
              <PrButton
                size="sm"
                variant="primary"
                :disabled="!prLevelDraft.trim() || prLevelSaving"
                @click="addPrLevelComment"
              >
                {{ prLevelSaving ? 'Adding…' : 'Add PR-level comment' }}
              </PrButton>
            </div>
          </section>

          <!-- The PR's own conversation: its description, then every comment, whole. Folded
               away by its own head, the way the files below fold. -->
          <section class="prm-conversation">
            <div
              class="prm-fold"
              @click="showConversation = !showConversation; persistUiState()"
            >
              <span
                class="collapse-chevron"
                :class="{ collapsed: !showConversation }"
              >▾</span>
              <span class="prm-fold-title">Conversation</span>
              <span class="muted">{{ (detail.discussion || []).length + (detail.meta.body ? 1 : 0) }} on GitHub - the description and every comment, as they are there</span>
            </div>
            <template v-if="showConversation">
            <div
              v-if="detail.meta.body"
              class="comment gh-comment conv-item"
            >
              <div class="comment-head">
                <span class="comment-author">{{ detail.meta.author }}</span>
                <span class="comment-age">opened this pull request</span>
              </div>
              <div
                class="comment-body md-body"
                v-html="renderMd(detail.meta.body)"
              />
            </div>
            <div
              v-for="(c, i) in (detail.discussion || [])"
              :key="i"
              class="comment gh-comment conv-item"
            >
              <div class="comment-head">
                <span class="comment-author">{{ c.author }}</span>
                <span class="comment-age">{{ age(c.createdAt) }} ago</span>
              </div>
              <div
                class="comment-body md-body"
                v-html="renderMd(c.body)"
              />
            </div>
            <div
              v-if="!(detail.discussion || []).length && !detail.meta.body"
              class="muted"
            >
              No conversation.
            </div>
            </template>
          </section>

          <!-- Comments whose path is not in this diff: kept where they can be seen and dealt with. -->
          <section
            v-if="orphanedComments.length"
            class="prm-orphans"
          >
            <div class="prlevel-head">
              <PrBadge tone="warning">
                Not in this diff
              </PrBadge>
              <span class="muted">These name a file the diff does not have. Edit the path, or delete them.</span>
            </div>
            <div
              v-for="c in orphanedComments"
              :key="c.id"
              class="comment local-comment"
              :class="c.status"
              :data-local-comment="c.id"
            >
              <div class="comment-head">
                <span class="comment-author">{{ c.path }}{{ c.line ? `:${ c.line }` : '' }}</span>
                <PrBadge :tone="c.status === 'approved' ? 'success' : 'warning'">
                  {{ c.status }}
                </PrBadge>
                <span class="comment-actions">
                  <PrButton
                    size="mini"
                    class="approve"
                    @click="toggleApprove(c)"
                  >{{ c.status === 'approved' ? 'Unapprove' : 'Mark good' }}</PrButton>
                  <PrButton
                    size="mini"
                    @click="startEdit(c)"
                  >Edit</PrButton>
                  <PrButton
                    size="mini"
                    variant="danger"
                    @click="removeComment(c)"
                  >Delete</PrButton>
                </span>
              </div>
              <div
                v-if="editingId === c.id"
                class="comment-edit"
              >
                <textarea
                  v-model="editDraft"
                  class="edit-textarea"
                  @keydown.esc.prevent="cancelEdit"
                />
                <div class="edit-btns">
                  <PrButton
                    size="mini"
                    class="approve"
                    @click="saveEdit(c)"
                  >Save</PrButton>
                  <PrButton
                    size="mini"
                    @click="cancelEdit"
                  >Cancel</PrButton>
                </div>
              </div>
              <div
                v-else
                class="comment-body md-body"
                v-html="renderMd(c.body)"
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
              @click="toggleCollapse(fv.file.path)"
            >
              <span
                class="collapse-chevron"
                :class="{ collapsed: collapsedFiles.has(fv.file.path) }"
              >▾</span>
              <span class="file-path">{{ fv.file.path }}</span>
              <span class="file-stats">
                <span
                  v-if="fv.ghCount + fv.localCount > 0"
                  class="header-comments"
                >💬 {{ fv.ghCount + fv.localCount }}</span>
                <span class="add-count">+{{ fv.file.additions }}</span>
                <span class="del-count">−{{ fv.file.deletions }}</span>
                <span
                  v-if="fv.file.status !== 'modified'"
                  class="file-status"
                >{{ fv.file.status }}</span>
              </span>
            </div>

            <div
              v-if="!collapsedFiles.has(fv.file.path) && (fv.unanchoredGh.length || fv.unanchoredLocal.length)"
              class="unanchored"
            >
              <div
                v-for="c in fv.unanchoredGh"
                :key="'g' + c.id"
                class="comment gh-comment"
                :data-gh-comment="c.id"
              >
                <span class="comment-author">{{ c.author }}</span>
                <span class="comment-age">{{ age(c.createdAt) }} ago{{ c.line ? ` · L${ c.line } (changed since)` : ' · outdated' }}</span>
                <PrBadge
                  v-if="c.pending"
                  tone="warning"
                >
                  pending on GitHub
                </PrBadge>
                <div
                  class="comment-body md-body"
                  v-html="renderMd(c.body)"
                />
                <div class="comment-actions">
                  <PrButton
                    size="mini"
                    :variant="replyingTo === c.id ? 'accent' : 'default'"
                    @click="toggleReply(c.id)"
                  >
                    Reply
                  </PrButton>
                </div>
                <div
                  v-if="replyingTo === c.id"
                  class="reply-box"
                >
                  <textarea
                    v-model="replyDraft"
                    class="edit-textarea"
                    placeholder="Reply — this posts to the thread on GitHub straight away"
                    @keydown.esc.prevent="toggleReply(c.id)"
                  />
                  <div class="reply-actions">
                    <PrButton
                      size="mini"
                      @click="toggleReply(c.id)"
                    >
                      Cancel
                    </PrButton>
                    <PrButton
                      size="mini"
                      variant="primary"
                      :disabled="!replyDraft.trim() || replySending"
                      @click="sendReply(c.id)"
                    >
                      {{ replySending ? 'Posting…' : 'Post reply' }}
                    </PrButton>
                  </div>
                </div>
              </div>
              <template
                v-for="c in fv.unanchoredLocal"
                :key="'l' + c.id"
              >
                <div
                  class="comment local-comment"
                  :class="c.status"
                  :data-local-comment="c.id"
                >
                  <div class="comment-head">
                    <span class="comment-author">{{ c.author || 'pending' }}{{ c.line ? ` · L${ c.line }` : '' }}</span>
                    <PrBadge :tone="c.status === 'approved' ? 'success' : 'warning'">
                      {{ c.status }}
                    </PrBadge>
                    <span class="comment-actions">
                      <PrButton
                        size="mini"
                        class="approve"
                        @click="toggleApprove(c)"
                      >{{ c.status === 'approved' ? 'Unapprove' : 'Mark good' }}</PrButton>
                      <PrButton
                        size="mini"
                        @click="startEdit(c)"
                      >Edit</PrButton>
                      <PrButton
                        size="mini"
                        :variant="openDiscussions.has(c.id) ? 'accent' : 'default'"
                        @click="discuss(c)"
                      >Discuss</PrButton>
                      <PrButton
                        size="mini"
                        variant="danger"
                        @click="removeComment(c)"
                      >Delete</PrButton>
                    </span>
                  </div>
                  <div
                    v-if="editingId === c.id"
                    class="comment-edit"
                  >
                    <textarea
                      v-model="editDraft"
                      class="edit-textarea"
                      @keydown.esc.prevent="cancelEdit"
                    />
                    <div class="edit-btns">
                      <PrButton
                        size="mini"
                        class="approve"
                        @click="saveEdit(c)"
                      >Save</PrButton>
                      <PrButton
                        size="mini"
                        @click="cancelEdit"
                      >Cancel</PrButton>
                    </div>
                  </div>
                  <div
                    v-else
                    class="comment-body md-body"
                    v-html="renderMd(c.body)"
                  />
                  <CommentAttachments
                    v-if="c.attachments?.length"
                    :pr="number"
                    :attachments="c.attachments"
                    removable
                    @remove="removeAttachment(c, $event)"
                  />
                </div>
                <CommentDiscussion
                  v-if="openDiscussions.has(c.id)"
                  :pr="number"
                  :repo="repo"
                  :workspace="workspace.name"
                  :comment="c"
                  :session="discussionSessions.get(c.id) || ''"
                  :initial-message="discussionSeeds.get(c.id) || ''"
                  @session="rememberDiscussion(c.id, $event)"
                  @close="closeDiscussion(c.id)"
                />
              </template>
            </div>

            <div
              v-if="fv.file.patch && !collapsedFiles.has(fv.file.path) && !isNear(fv.file.path)"
              class="diff-spacer"
              :style="{ height: spacerHeight(fv) + 'px' }"
            />
            <table
              v-else-if="fv.file.patch && !collapsedFiles.has(fv.file.path)"
              class="diff-table"
            >
              <tbody>
                <template
                  v-for="(rv, ri) in fv.rows"
                  :key="ri"
                >
                  <tr
                    v-if="rv.row.type === 'expand'"
                    class="expand-row"
                    @click="expandGap(fv.file, rv.row)"
                  >
                    <td
                      class="lineno expand-dots"
                      colspan="2"
                    >
                      ⋯
                    </td>
                    <td class="code expand-label">
                      {{ rv.row.count != null ? `Expand ${ rv.row.count } hidden line${ rv.row.count === 1 ? '' : 's' }` : 'Expand to end of file' }}
                    </td>
                  </tr>
                  <tr
                    v-else
                    class="diff-row"
                    :class="[rv.row.type, { 'in-comment-range': inComposerRange(fv.file.path, rv.row) }]"
                  >
                    <td
                      class="lineno"
                      :class="{ clickable: rv.row.oldN != null || rv.row.newN != null }"
                      title="Click to comment · Shift+click to select a range"
                      @click="lineClick(fv.file.path, rv.row, $event)"
                    >
                      {{ rv.row.oldN ?? '' }}
                    </td>
                    <td
                      class="lineno"
                      :class="{ clickable: rv.row.oldN != null || rv.row.newN != null }"
                      title="Click to comment · Shift+click to select a range"
                      @click="lineClick(fv.file.path, rv.row, $event)"
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
                          <span class="comment-author">
                            New comment — {{ composer!.startLine ? `L${ composer!.startLine }–L${ composer!.line }` : `L${ composer!.line }` }}{{ composer!.side === 'LEFT' ? ' (old side)' : '' }}
                          </span>
                        </div>
                        <textarea
                          v-model="composerDraft"
                          class="edit-textarea"
                          placeholder="Write a review comment… (Shift+click another line number to make this a range)"
                          @keydown.esc.prevent="cancelComposer"
                        />
                        <CommentDiscussion
                          v-if="composerDiscussion"
                          :pr="number"
                          :repo="repo"
                          :workspace="workspace.name"
                          :lines="composerDiscussion"
                          :session="composerDiscussion.session || ''"
                          :initial-message="composerDiscussion.seed"
                          @session="rememberComposerDiscussion($event)"
                          @close="composerDiscussion = null; persistUiState()"
                        />
                        <div class="edit-btns">
                          <PrButton
                            size="mini"
                            class="approve"
                            :disabled="!composerDraft.trim() || composerSaving"
                            @click="saveComposer"
                          >
                            {{ composerSaving ? 'Adding…' : 'Add comment' }}
                          </PrButton>
                          <PrButton
                            size="mini"
                            variant="accent"
                            :disabled="composerSaving"
                            title="Start an AI conversation about these lines"
                            @click="discussComposer"
                          >
                            Discuss with AI
                          </PrButton>
                          <PrButton
                            size="mini"
                            @click="cancelComposer"
                          >
                            Cancel
                          </PrButton>
                        </div>
                      </div>
                    </td>
                  </tr>
                  <tr
                    v-for="c in rv.gh"
                    :key="'g' + c.id"
                    class="comment-row"
                  >
                    <td colspan="3">
                      <div
                        class="comment gh-comment"
                        :class="{ reply: c.inReplyTo }"
                        :data-gh-comment="c.id"
                      >
                        <span class="comment-author">{{ c.author }}</span>
                        <span class="comment-age">{{ age(c.createdAt) }} ago</span>
                        <PrBadge
                          v-if="c.pending"
                          tone="warning"
                        >
                          pending on GitHub
                        </PrBadge>
                        <div
                          class="comment-body md-body"
                          v-html="renderMd(c.body)"
                        />
                        <div class="comment-actions">
                          <PrButton
                            size="mini"
                            :variant="replyingTo === c.id ? 'accent' : 'default'"
                            @click="toggleReply(c.id)"
                          >
                            Reply
                          </PrButton>
                        </div>
                        <div
                          v-if="replyingTo === c.id"
                          class="reply-box"
                        >
                          <textarea
                            v-model="replyDraft"
                            class="edit-textarea"
                            placeholder="Reply — this posts to the thread on GitHub straight away"
                            @keydown.esc.prevent="toggleReply(c.id)"
                          />
                          <div class="reply-actions">
                            <PrButton
                              size="mini"
                              @click="toggleReply(c.id)"
                            >
                              Cancel
                            </PrButton>
                            <PrButton
                              size="mini"
                              variant="primary"
                              :disabled="!replyDraft.trim() || replySending"
                              @click="sendReply(c.id)"
                            >
                              {{ replySending ? 'Posting…' : 'Post reply' }}
                            </PrButton>
                          </div>
                        </div>
                      </div>
                    </td>
                  </tr>
                  <tr
                    v-for="c in rv.local"
                    :key="'l' + c.id"
                    class="comment-row"
                  >
                    <td colspan="3">
                      <div
                        class="comment local-comment"
                        :class="c.status"
                        :data-local-comment="c.id"
                      >
                        <div class="comment-head">
                          <span class="comment-author">{{ c.author === 'you' ? 'your' : c.author || 'pending' }} review comment</span>
                          <PrBadge :tone="c.status === 'approved' ? 'success' : 'warning'">
                            {{ c.status }}
                          </PrBadge>
                          <span class="comment-actions">
                            <PrButton
                              size="mini"
                              class="approve"
                              @click="toggleApprove(c)"
                            >{{ c.status === 'approved' ? 'Unapprove' : 'Mark good' }}</PrButton>
                            <PrButton
                              size="mini"
                              @click="startEdit(c)"
                            >Edit</PrButton>
                            <PrButton
                              size="mini"
                              :variant="openDiscussions.has(c.id) ? 'accent' : 'default'"
                              @click="discuss(c)"
                            >Discuss</PrButton>
                            <PrButton
                              size="mini"
                              variant="danger"
                              @click="removeComment(c)"
                            >Delete</PrButton>
                          </span>
                        </div>
                        <div
                          v-if="editingId === c.id"
                          class="comment-edit"
                        >
                          <textarea
                            v-model="editDraft"
                            class="edit-textarea"
                            @keydown.esc.prevent="cancelEdit"
                          />
                          <div class="edit-btns">
                            <PrButton
                              size="mini"
                              class="approve"
                              @click="saveEdit(c)"
                            >Save</PrButton>
                            <PrButton
                              size="mini"
                              @click="cancelEdit"
                            >Cancel</PrButton>
                          </div>
                        </div>
                        <div
                          v-else
                          class="comment-body md-body"
                          v-html="renderMd(c.body)"
                        />
                        <CommentAttachments
                          v-if="c.attachments?.length"
                          :pr="number"
                          :attachments="c.attachments"
                          removable
                          @remove="removeAttachment(c, $event)"
                        />
                      </div>
                      <CommentDiscussion
                        v-if="openDiscussions.has(c.id)"
                        :pr="number"
                        :repo="repo"
                        :workspace="workspace.name"
                        :comment="c"
                        :session="discussionSessions.get(c.id) || ''"
                        :initial-message="discussionSeeds.get(c.id) || ''"
                        @session="rememberDiscussion(c.id, $event)"
                        @close="closeDiscussion(c.id)"
                      />
                    </td>
                  </tr>
                </template>
              </tbody>
            </table>
            <div
              v-else-if="!collapsedFiles.has(fv.file.path)"
              class="muted no-patch"
            >
              No diff available (binary or too large).
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style lang="scss" scoped src="./pr/panel.scss"></style>
