// Reviews, fixes and merges: what My Work's buttons do, and what the PR tab is made of.
//
// Every action here has a twin in the harness, and does the same thing by the same route:
//
//   review a PR       -> a conversation in the PR's workspace running /my-pr-full-review, which
//                        files its comments through the in-cluster API (as the harness's did
//                        through the harness API)
//   fix an issue      -> a conversation running /my-issue-fix
//   fix a Dependabot  -> a conversation running /my-dependabot-fix, in a workspace named for
//   alert                the package
//   review a bot PR   -> a conversation running /my-dependabot-review, whose verdict (MERGE or
//                        STOP on its last line) is read off the pane
//   triage red CI     -> a conversation running /my-ci-triage with the failures pasted in
//   approve, submit,  -> GitHub, from the browser, with the person's own token; the same calls
//   merge, rerun         the harness made from its API
//
// The comments a review produces are local until somebody submits them: pending, then approved
// ("marked good"), then posted to GitHub as one review. That is the harness's flow exactly, and
// the local store is the in-cluster API's ConfigMaps rather than the harness's sqlite.

import {
  devFetch, clusterBase, githubToken, createWorkspace, listAllWorkspaces, workspacePod
} from './api';
import {
  listConversations, startConversation, endConversation, queuePrompt, Attachment, ProjectConversation
} from './conversations';
import {
  ensureWorkspaceReady, waitForWorkspacePod, queuePrompt as queueInWorkspace, conversationPane
} from './workspace-tools';
import type { WorkspaceContext } from './workspace-tools';
import { rerunFailed } from './github';
import { DEFAULT_APP, DEV_API_IN_CLUSTER } from './config/constants';
import { defaultRancherValues } from './ranchers';
import { ensureDefaultShare } from './previews';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Store = any;

/** The in-cluster API, through the apiserver's service proxy; the same service the agents call. */
const DEV_API = `${ clusterBase('local') }/api/v1/namespaces/dev-system/services/http:dev-api:8080/proxy`;

export { DEV_API_IN_CLUSTER };

export const DEFAULT_REPO = 'rancher/dashboard';

async function api(path: string, init?: RequestInit): Promise<Json> {
  return devFetch(`${ DEV_API }${ path }`, init);
}

// ── Pull request state ──────────────────────────────────────────────────────────────────────

export interface LocalComment {
  id: number;
  pr: number;
  path: string;
  line: number | null;
  start_line: number | null;
  side: string;
  body: string;
  status: 'pending' | 'approved';
  author: string;
  level: 'pr' | 'line';
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  attachments: LocalAttachment[];
}

export interface ReviewRun {
  pr: number;
  project: string | null;
  state: string;
  note: string;
  startedAt: string;
  updatedAt: string;
}

export async function prDetail(num: number, repo = DEFAULT_REPO): Promise<Json> {
  return api(`/my-work/pr/${ num }?repo=${ encodeURIComponent(repo) }`);
}

export async function listComments(num: number): Promise<LocalComment[]> {
  return api(`/my-work/pr/${ num }/comments`);
}

export async function addComment(num: number, body: string, at?: { path: string; line?: number | null; startLine?: number | null; side?: string }, author = 'you'): Promise<LocalComment> {
  return api(`/my-work/pr/${ num }/comments`, {
    method: 'POST',
    body:   JSON.stringify({
      body, level: at?.path ? 'line' : 'pr', path: at?.path || '', line: at?.line ?? null, startLine: at?.startLine ?? null, side: at?.side || 'RIGHT', author,
    }),
  });
}

export async function updateComment(num: number, id: number, changes: Partial<Pick<LocalComment, 'body' | 'status' | 'line' | 'path'>> & { attachments?: { path: string; caption?: string }[] }): Promise<LocalComment> {
  return api(`/my-work/pr/${ num }/comments/${ id }`, { method: 'PUT', body: JSON.stringify(changes) });
}

export async function deleteComment(num: number, id: number): Promise<void> {
  await api(`/my-work/pr/${ num }/comments/${ id }`, { method: 'DELETE' });
}

export async function reviewRun(num: number): Promise<ReviewRun | null> {
  return (await api(`/my-work/pr/${ num }/review-run`))?.run || null;
}

export async function setReviewRun(num: number, state: string, note = '', project?: string): Promise<ReviewRun> {
  return (await api(`/my-work/pr/${ num }/review-run`, { method: 'POST', body: JSON.stringify({ state, note, project }) })).run;
}

/** A file at a ref - the PR head - for expanding the context between a diff's hunks. */
export async function prFile(num: number, path: string, ref: string, repo = DEFAULT_REPO): Promise<string> {
  return (await api(`/my-work/pr/${ num }/file?path=${ encodeURIComponent(path) }&ref=${ encodeURIComponent(ref) }&repo=${ encodeURIComponent(repo) }`)).content;
}

/** The files a subset of the PR's commits changed. */
export async function commitsDiff(num: number, shas: string[], repo = DEFAULT_REPO): Promise<{ combined: boolean; files: Json[] }> {
  return api(`/my-work/pr/${ num }/commits-diff?shas=${ shas.join(',') }&repo=${ encodeURIComponent(repo) }`);
}

/** Where one attached piece of evidence can be looked at: a file in the agent's workspace, through the API. */
export function artifactUrl(num: number, path: string): string {
  return `${ DEV_API }/my-work/pr/${ num }/artifact?path=${ encodeURIComponent(path) }`;
}

/** Comments as the API keeps them, with everything a reader needs about their evidence. */
export interface LocalAttachment {
  path: string;
  caption: string;
  name: string;
  kind: 'image' | 'video' | 'file';
  found: boolean;
}

export async function ciFailures(num: number, repo = DEFAULT_REPO): Promise<Json> {
  return api(`/my-work/pr/${ num }/ci?repo=${ encodeURIComponent(repo) }`);
}

export async function ciFailureDetail(num: number, checkId: number, repo = DEFAULT_REPO): Promise<Json> {
  return api(`/my-work/pr/${ num }/ci/${ checkId }?repo=${ encodeURIComponent(repo) }`);
}

// ── GitHub, from the browser ────────────────────────────────────────────────────────────────

async function gh(method: string, path: string, body?: Json): Promise<Json> {
  const token = await githubToken();

  if (!token) {
    throw new Error('No GitHub token is set. Add one in Settings.');
  }

  const response = await fetch(`https://api.github.com${ path }`, {
    method,
    headers: {
      authorization: `Bearer ${ token }`,
      accept:        'application/vnd.github+json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`GitHub ${ method } ${ path } answered ${ response.status }: ${ text.slice(0, 300) }`);
  }

  return text ? JSON.parse(text) : null;
}

/**
 * Approve the PR now. Pending local comments are discarded on the way, as the harness does:
 * approving is saying there is nothing more to say.
 */
export async function approvePr(num: number, body = '', repo = DEFAULT_REPO): Promise<{ url: string; discarded: number }> {
  const pending = (await listComments(num)).filter((c) => !c.submitted_at);

  for (const c of pending) {
    await deleteComment(num, c.id);
  }

  const review = await gh('POST', `/repos/${ repo }/pulls/${ num }/reviews`, { event: 'APPROVE', ...(body ? { body } : {}) });

  return { url: review?.html_url || '', discarded: pending.length };
}

/**
 * Post every approved local comment to GitHub as one review.
 *
 * All of them have to be approved first - that is what marking a comment good is for - and the
 * PR-level ones become the review's body while the line ones ride as inline comments. Then they
 * are stamped submitted here, so the next review starts from nothing.
 */
export async function submitReview(num: number, repo = DEFAULT_REPO): Promise<{ url: string | null; posted: number }> {
  const comments = (await listComments(num)).filter((c) => !c.submitted_at);

  if (!comments.length) {
    throw new Error('There are no comments to submit.');
  }

  const pending = comments.filter((c) => c.status !== 'approved');

  if (pending.length) {
    throw new Error(`${ pending.length } comment${ pending.length === 1 ? ' is' : 's are' } still pending. Mark them good, or delete them, before submitting.`);
  }

  // Evidence goes with the comment it belongs to. A text file - a test, a log - is read from the
  // agent's workspace and inlined as a code block, which is how a reviewer wants to read it
  // anyway. An image or a recording cannot be uploaded to GitHub from here (that needs a
  // github.com session, not an API token), so the comment names it and where it is instead of
  // silently dropping it.
  const withEvidence = await Promise.all(comments.map(async(c) => ({ ...c, body: await bodyWithEvidence(num, c) })));
  const inline = withEvidence.filter((c) => c.path);
  const body = withEvidence.filter((c) => !c.path).map((c) => c.body).join('\n\n');
  const review = await gh('POST', `/repos/${ repo }/pulls/${ num }/reviews`, {
    event:    'COMMENT',
    ...(body ? { body } : {}),
    comments: inline.map((c) => ({
      path: c.path,
      line: c.line ?? undefined,
      side: c.side || 'RIGHT',
      ...(c.start_line ? { start_line: c.start_line, start_side: c.side || 'RIGHT' } : {}),
      body: c.body,
    })),
  });
  const stamp = new Date().toISOString();

  for (const c of comments) {
    await api(`/my-work/pr/${ num }/comments/${ c.id }`, { method: 'PUT', body: JSON.stringify({ submitted_at: stamp }) });
  }

  return { url: review?.html_url || null, posted: comments.length };
}

/** Reply to a comment on GitHub. There is no draft for a reply: it lands in the thread now. */
export async function replyToComment(num: number, commentId: number, body: string, repo = DEFAULT_REPO): Promise<{ id: number; url: string }> {
  const reply = await gh('POST', `/repos/${ repo }/pulls/${ num }/comments/${ commentId }/replies`, { body });

  return { id: reply?.id, url: reply?.html_url || '' };
}

const CODE_LANG: Record<string, string> = {
  '.ts': 'ts', '.js': 'js', '.mjs': 'js', '.vue': 'vue', '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.sh': 'bash', '.log': 'text', '.txt': 'text', '.md': 'md',
};
const ATTACH_MARKER = /\[\[attach:([^\]]+)\]\]/g;
const MAX_INLINE = 60_000;

async function bodyWithEvidence(num: number, c: LocalComment): Promise<string> {
  const items = c.attachments || [];

  if (!items.length) {
    return c.body;
  }

  let body = c.body;
  const trailing: string[] = [];

  for (const item of items) {
    const ext = item.name.slice(item.name.lastIndexOf('.')).toLowerCase();
    let embed = '';

    if (CODE_LANG[ext] && item.found) {
      const text = await fetch(artifactUrl(num, item.path), { credentials: 'same-origin' }).then((r) => (r.ok ? r.text() : '')).catch(() => '');

      if (text && text.length <= MAX_INLINE) {
        embed = `${ item.caption ? `${ item.caption }\n\n` : '' }\`\`\`${ CODE_LANG[ext] }\n${ text.replace(/\`\`\`/g, '\u0060\u0060\u0060') }\n\`\`\``;
      }
    }

    if (!embed) {
      embed = `_${ item.caption ? `${ item.caption } - ` : '' }${ item.kind } \`${ item.name }\`, recorded in the workspace at \`${ item.path }\`_`;
    }

    let used = false;

    body = body.replace(ATTACH_MARKER, (whole, ref) => {
      if (ref.trim() !== item.name && ref.trim() !== item.path) {
        return whole;
      }
      used = true;

      return embed;
    });

    if (!used) {
      trailing.push(embed);
    }
  }

  return trailing.length ? `${ body }\n\n${ trailing.join('\n\n') }` : body;
}

/** Squash-merge, after checking CI is not red or still running. */
export async function mergePr(num: number, repo = DEFAULT_REPO): Promise<{ sha: string }> {
  const meta = await gh('GET', `/repos/${ repo }/pulls/${ num }`);
  const sha = meta.head?.sha;

  if (sha) {
    const [checks, status] = await Promise.all([
      gh('GET', `/repos/${ repo }/commits/${ sha }/check-runs?per_page=100`).catch(() => null),
      gh('GET', `/repos/${ repo }/commits/${ sha }/status`).catch(() => null),
    ]);
    const runs: Json[] = checks?.check_runs || [];
    const red = runs.some((r) => ['failure', 'timed_out'].includes(r.conclusion)) || (status?.statuses || []).some((s: Json) => ['failure', 'error'].includes(s.state));
    const running = runs.some((r) => r.status !== 'completed') || (status?.statuses || []).some((s: Json) => s.state === 'pending');

    if (red) {
      throw new Error('CI is red on this PR. Fix or re-run it first.');
    }
    if (running) {
      throw new Error('CI is still running on this PR. Wait for it.');
    }
  }

  const result = await gh('PUT', `/repos/${ repo }/pulls/${ num }/merge`, { merge_method: 'squash', sha });

  return { sha: result?.sha || '' };
}

export interface MergeStep { step: string; ok: boolean; note?: string }

/** Approve, squash-merge, delete the branch: the harness's "Approve & merge" for a bot PR. */
export async function approveAndMerge(num: number, repo = DEFAULT_REPO): Promise<{ steps: MergeStep[] }> {
  const steps: MergeStep[] = [];
  const meta = await gh('GET', `/repos/${ repo }/pulls/${ num }`);

  await gh('POST', `/repos/${ repo }/pulls/${ num }/reviews`, { event: 'APPROVE' });
  steps.push({ step: 'approve', ok: true });
  await mergePr(num, repo);
  steps.push({ step: 'merge', ok: true });

  const branch = meta.head?.ref;
  const fork = meta.head?.repo?.full_name && meta.head.repo.full_name !== repo;

  if (branch && !fork) {
    try {
      await gh('DELETE', `/repos/${ repo }/git/refs/heads/${ branch }`);
      steps.push({ step: 'delete-branch', ok: true });
    } catch (e: Json) {
      const gone = /422|Reference does not exist/.test(String(e?.message));

      steps.push({ step: 'delete-branch', ok: gone, note: gone ? 'already deleted' : String(e?.message || e).slice(0, 120) });
    }
  } else {
    steps.push({ step: 'delete-branch', ok: true, note: 'branch is on a fork - left alone' });
  }

  return { steps };
}

/** Re-run every failed workflow run behind a PR's red checks. */
export async function rerunFailedJobs(pr: { repo: string; runs: Json[] }): Promise<number> {
  await Promise.all((pr.runs || []).map((run) => rerunFailed(pr.repo, run)));

  return (pr.runs || []).length;
}

// ── Agent actions ───────────────────────────────────────────────────────────────────────────

/**
 * The harness's prompts, verbatim.
 *
 * The harness built its project containers so that these were all a skill needed to be told;
 * workspace-tools.ts builds the workspace's pod the same way, so they are the same words here,
 * em dashes and all. `$CLAUDE_HARNESS_API` is set in the pod (the App's env and the seed's
 * settings.json) to the in-cluster API, which answers the same routes.
 */
const API_HINT = '$CLAUDE_HARNESS_API/my-work/pr';

export function reviewPrompt(pr: number, repo = DEFAULT_REPO): string {
  return `/my-pr-full-review Review ${ repo } PR #${ pr } — harness portal context, file through ${ API_HINT }/${ pr }.`;
}

export function fixPrompt(num: number, repo = DEFAULT_REPO): string {
  return `/my-issue-fix Fix ${ repo } issue #${ num } — this project was created for it.`;
}

async function ensureWorkspace(store: Store, name: string): Promise<boolean> {
  const existing = (await listAllWorkspaces().catch(() => [])).some((workspace) => workspace.name === name);

  if (!existing) {
    // Pointed at the starred Rancher (ranchers.ts), as the Create page would be.
    await createWorkspace(store, name, DEFAULT_APP, undefined, await defaultRancherValues());
  }

  return !existing;
}

/**
 * A conversation in the workspace with a prompt queued, the workspace's pod made ready for it.
 *
 * The registration is immediate; the rest waits for the pod, which for a workspace made a
 * moment ago is minutes away (a clone and a yarn install), and runs in the background so the
 * button that asked for this comes back now. The pane, docked wherever it was asked for,
 * shows the pod arriving and then the prompt starting. `onNote` hears where it has got to.
 */
async function openWith(workspace: string, title: string, prompt: string, ctx?: WorkspaceContext, onNote?: (note: string) => void, store?: Store): Promise<ProjectConversation> {
  const conversation = await startConversation(workspace, title);
  const prepare = async() => {
    onNote?.('preparing the workspace (skills, gh, browser)');
    await ensureWorkspaceReady(workspace, ctx);
    await queueInWorkspace(workspace, conversation.id, prompt);
    onNote?.('prompt queued; the review starts when its pane is attached');
    // Shared by default: the workspace's build, on a link, from the start (previews.ts).
    if (store) {
      ensureDefaultShare(store, workspace).catch(() => {});
    }
  };

  // A pod that is up is prepared now, before this returns: a page that navigates away a
  // moment after the click would otherwise take the preparation with it and leave a
  // conversation with nothing queued. Only a pod that does not exist yet is waited for in the
  // background, since that wait is minutes and the pane shows it arriving.
  if (await workspacePod(workspace).catch(() => null)) {
    await prepare();

    return conversation;
  }

  (async() => {
    try {
      onNote?.('waiting for the workspace pod');
      await waitForWorkspacePod(workspace);
      await prepare();
    } catch (e: Json) {
      onNote?.(`could not start: ${ e?.message || e }`);
      console.error('[dev] preparing the workspace failed', e); // eslint-disable-line no-console
    }
  })();

  return conversation;
}

export interface Started {
  workspace: string;
  conversation: ProjectConversation;
  created: boolean;
}

export function prWorkspaceName(pr: { number: number; issue?: { number: number } | null }): string {
  return pr.issue ? `issue-${ pr.issue.number }` : `pr-${ pr.number }`;
}

/** Review a PR: the harness's "Review" button. Reattaches to a review already running. */
export async function startPrReview(store: Store, pr: { number: number; issue?: { number: number } | null }, repo = DEFAULT_REPO, inWorkspace = ''): Promise<Started> {
  const workspace = inWorkspace || prWorkspaceName(pr);
  const created = await ensureWorkspace(store, workspace);
  const title = `Review #${ pr.number }`;
  const existing = (await listConversations(workspace).catch(() => [])).find((c) => c.title === title);

  if (existing) {
    return { workspace, conversation: existing, created };
  }

  const conversation = await openWith(workspace, title, reviewPrompt(pr.number, repo), { pr: pr.number, issue: pr.issue?.number || null },
    (note) => setReviewRun(pr.number, 'starting', note, workspace).catch(() => {}), store);

  await setReviewRun(pr.number, 'starting', 'conversation opened; waiting for the workspace', workspace).catch(() => {});

  return { workspace, conversation, created };
}

/** Fix an issue: the harness's "Start fix". */
export async function startIssueFix(store: Store, issue: { number: number; title: string }, repo = DEFAULT_REPO): Promise<Started> {
  const workspace = `issue-${ issue.number }`;
  const created = await ensureWorkspace(store, workspace);
  const conversation = await openWith(workspace, `Fix #${ issue.number }`, fixPrompt(issue.number, repo), { issue: issue.number }, undefined, store);

  return { workspace, conversation, created };
}

export function alertWorkspaceName(group: { packages: string[]; slug: string }): string {
  const pkg = (group.packages[0] || group.slug).replace(/^@/, '').replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase();

  return `dependabot-${ pkg }`.replace(/-+$/, '').slice(0, 40);
}

/** Fix a Dependabot advisory: the harness's "Start fix" on an alert group. */
export async function startAlertFix(store: Store, group: Json, repo = DEFAULT_REPO): Promise<Started> {
  const workspace = alertWorkspaceName(group);
  const created = await ensureWorkspace(store, workspace);
  const alertList = (group.alerts || []).map((a: Json) => `#${ a.number } ${ a.packageName } in ${ a.manifest }`).join('; ');
  const conversation = await openWith(workspace, `Fix ${ group.packages[0] || group.slug }`,
    `/my-dependabot-fix ${ JSON.stringify(group.title) } — ${ (group.alerts || []).length } open alert(s): ${ alertList }. The advisories: $CLAUDE_HARNESS_API/my-work/dependabot.`);

  return { workspace, conversation, created };
}

/** Review a Dependabot PR: the harness's merge checklist, ending in MERGE or STOP. */
export async function startDependabotReview(store: Store, pr: { number: number }, repo = DEFAULT_REPO): Promise<Started> {
  const workspace = `pr-${ pr.number }`;
  const created = await ensureWorkspace(store, workspace);
  const title = `Dependabot review #${ pr.number }`;
  const existing = (await listConversations(workspace).catch(() => [])).find((c) => c.title === title);
  const conversation = existing || await openWith(workspace, title,
    `/my-dependabot-review Review ${ repo } PR #${ pr.number } — a dependabot bump. Its full context: curl -s "$CLAUDE_HARNESS_API/my-work/dependabot/pr/${ pr.number }/review-context". Finish with MERGE or STOP alone on the last line.`, { pr: pr.number });

  await api(`/my-work/dependabot/reviews/${ pr.number }`, {
    method: 'PUT',
    body:   JSON.stringify({
      workspace, conversation: conversation.id, state: existing ? 'running' : 'starting', verdict: null, reason: '', startedAt: new Date().toISOString(),
    }),
  }).catch(() => {});

  return { workspace, conversation, created };
}

/** Triage red CI: the first step of the harness's smart rerun, as a conversation. */
export async function startCiTriage(store: Store, pr: { number: number; issue?: { number: number } | null }, repo = DEFAULT_REPO, inWorkspace = ''): Promise<Started> {
  const workspace = inWorkspace || prWorkspaceName(pr);
  const created = await ensureWorkspace(store, workspace);
  const failures = await ciFailures(pr.number, repo).catch(() => ({ checks: [] }));
  const details = (failures.checks || []).slice(0, 6).map((c: Json) => `- ${ c.name }: ${ c.conclusion }${ c.title ? ` - ${ c.title }` : '' }${ c.summary ? `\n  ${ c.summary.slice(0, 300) }` : '' } (${ c.url })`).join('\n');
  const conversation = await openWith(workspace, `CI #${ pr.number }`,
    `/my-ci-triage ${ repo } PR #${ pr.number } is red. The failing checks:\n\n${ details || '(read them from $CLAUDE_HARNESS_API/my-work/pr/' + pr.number + '/ci)' }\n\nDecide whether this PR's own change caused them. If they are ours, fix them with /my-ci-fix, verify, commit and push; if not, re-run the failed jobs with gh. Finish with OURS or FLAKE alone on the last line.`);

  return { workspace, conversation, created };
}

/** The opening prompt of a discussion about one pending comment: the harness's, with this API in it. */
export function discussPrompt(num: number, comment: LocalComment, message: string, repo = DEFAULT_REPO): string {
  const oneline = String(comment.body).replace(/\s+/g, ' ').slice(0, 400);
  const where = comment.path ? `file ${ comment.path }${ comment.line ? `, line ${ comment.line }` : '' }` : 'a PR-level comment';
  const opener = message
    ? ` The user's opening message about it: "${ message.replace(/\s+/g, ' ').slice(0, 600) }" — address that directly first.`
    : ' Anything after this sentence is their question — answer that; if there is nothing there, start with your read of the code in question and whether the comment holds up.';
  const apiHint = API_HINT;

  return `The user wants to discuss pending review comment #${ comment.id } on ${ repo } PR #${ num } — ${ where }: "${ oneline }". Fetch the PR for context with: curl -s ${ apiHint }/${ num } (find the relevant hunk in files[].patch${ comment.path ? ` for ${ comment.path }` : '' }).${ opener } Keep responses conversational and concise — this is a live discussion. When the user settles on improved wording, update the comment: curl -s -X PUT ${ apiHint }/${ num }/comments/${ comment.id } -H 'Content-Type: application/json' -d '{"body":"<new text>"}'. If they decide to drop it: curl -s -X DELETE ${ apiHint }/${ num }/comments/${ comment.id }.`;
}

/** The opening prompt of a discussion about some lines, with no comment filed. */
export function linesPrompt(num: number, lines: { path: string; line: number; startLine: number | null; side: string; code?: string }, message: string, repo = DEFAULT_REPO): string {
  const range = lines.startLine ? `lines ${ lines.startLine }-${ lines.line }` : `line ${ lines.line }`;
  const apiHint = API_HINT;
  const code = (lines.code || '').slice(0, 4000);

  return `The user is reviewing ${ repo } PR #${ num } and wants to discuss ${ lines.path } ${ range } (${ lines.side } side of the diff). Fetch the PR with: curl -s ${ apiHint }/${ num } and find that file in files[].patch for context.${ code ? ` The selected lines are:\n\n${ code }\n` : '' }${ message ? ` Their opening message: "${ message.replace(/\s+/g, ' ').slice(0, 600) }" — address it directly.` : ' Anything after this sentence is their question — answer that; if there is nothing there, start with your read of that code.' } Keep it conversational. Do NOT file a review comment unless the user asks; if they do, run: curl -s -X POST ${ apiHint }/${ num }/comments -H 'Content-Type: application/json' -d '{"path":"${ lines.path }","line":${ lines.line }${ lines.startLine ? `,"startLine":${ lines.startLine }` : '' },"side":"${ lines.side }","body":"<comment>"}'`;
}

/** A discussion: a conversation in the workspace, opened with its context, the pod made ready. */
export async function startDiscussion(workspace: string, title: string, prompt: string): Promise<ProjectConversation> {
  return openWith(workspace, title, prompt);
}

/** The workspace made ready for whatever a person types: the same preparation an action gets. */
export async function prepareWorkspace(workspace: string): Promise<void> {
  await ensureWorkspaceReady(workspace);
}

/** Say something into a running conversation: queued the same way, read by the pane's runner. */
export async function sayInConversation(conversation: ProjectConversation, message: string): Promise<void> {
  await queuePrompt(conversation.attach, message);
}

/**
 * End a review: the conversation and every process in it, and the run marked cancelled so the
 * panel stops waiting. The comments it filed stay.
 */
export async function cancelReview(num: number, workspace: string, conversationId: string | null): Promise<ReviewRun> {
  if (conversationId) {
    await endConversation(workspace, conversationId).catch(() => {});
  }

  return setReviewRun(num, 'cancelled', 'Cancelled - the agent and its subagents were stopped', workspace);
}

// ── Verdicts, read off a pane ───────────────────────────────────────────────────────────────

function cleanPaneLine(line: string): string {
  return line
    .replace(/[─-╿]/g, ' ')
    .replace(/^[\s>·*⏺●✻✽◯◉⎿→←]+/, '')
    .replace(/\s+$/, '')
    .trim();
}

export function verdictFromPane(pane: string, words: string[] = ['MERGE', 'STOP']): { verdict: string | null; reason: string } {
  const all = pane.split('\n').map(cleanPaneLine);
  const verdictRe = new RegExp(`^(${ words.join('|') })[.!]?$`);
  const furniture = (t: string) => /^(esc to interrupt|\? for shortcuts|bypass permissions|\/my-|Churned for|Cooked for|✻|●|Try ")/i.test(t);
  const listItem = (t: string) => /^\d+\.\s/.test(t) || /^#{1,6}\s/.test(t) || /^[-*]\s/.test(t);

  for (let i = all.length - 1; i >= 0; i--) {
    const m = all[i].match(verdictRe);

    if (!m) {
      continue;
    }

    let j = i - 1;
    const skippable = (t: string) => !t || furniture(t) || verdictRe.test(t);

    while (j >= 0 && skippable(all[j])) {
      j--;
    }

    const para: string[] = [];

    for (; j >= 0; j--) {
      const text = all[j];

      if (!text || furniture(text) || verdictRe.test(text)) {
        break;
      }
      para.unshift(text);
      if (listItem(text)) {
        break;
      }
    }

    return { verdict: m[1].toLowerCase(), reason: para.join(' ').replace(/\s+/g, ' ').trim().slice(0, 500) };
  }

  return { verdict: null, reason: '' };
}

const BUSY_RE = /esc to interrupt|Interrupt ·|tokens · esc|⏳|Thinking…|Working…/i;

export interface BotReview {
  pr: number;
  workspace: string;
  conversation: string;
  state: 'starting' | 'running' | 'done' | 'ended';
  verdict: 'merge' | 'stop' | null;
  reason: string;
  startedAt: string;
  updatedAt: string;
}

export async function dependabotReviews(): Promise<Record<string, BotReview>> {
  return (await api('/my-work/dependabot/reviews'))?.reviews || {};
}

export async function closeDependabotReview(num: number): Promise<void> {
  await api(`/my-work/dependabot/reviews/${ num }`, { method: 'DELETE' });
}

/** Read one bot review's pane and record what it says. */
export async function refreshDependabotReview(review: BotReview, attach: Attachment): Promise<BotReview> {
  const pane = await conversationPane(attach.workspace, attach.id, 80).catch(() => ({ text: '', running: false }));
  const { verdict, reason } = verdictFromPane(pane.text);
  const busy = BUSY_RE.test(pane.text);
  const state: BotReview['state'] = verdict ? 'done' : (pane.running ? (busy ? 'running' : 'ended') : review.state);
  const next = {
    ...review, state, verdict: (verdict as BotReview['verdict']) || review.verdict, reason: reason || review.reason,
  };

  if (next.state !== review.state || next.verdict !== review.verdict) {
    await api(`/my-work/dependabot/reviews/${ review.pr }`, { method: 'PUT', body: JSON.stringify(next) }).catch(() => {});
  }

  return next;
}

export async function dependabotData(repo = DEFAULT_REPO): Promise<Json> {
  return api(`/my-work/dependabot?repo=${ encodeURIComponent(repo) }`);
}

export { listConversations };
