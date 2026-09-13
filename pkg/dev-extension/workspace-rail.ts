// The stage rail: the stages a workspace's work moves through, what there is to look at in
// each of them, and what pressing the one button does. The page (WorkspaceRail.vue) draws it;
// this decides it.
//
// The first column is the point of the rail: at every stage it holds what is needed to judge
// the work, drawn from where the work actually is - the agent's last report out of its
// transcript, the branch's commits and diff out of the checkout, the recordings out of the
// workspace's artifacts, the PR with its body, checklist, CI and comments out of GitHub. Every
// stage can be looked at again after it has passed: the evidence is composed per stage, from
// what that stage left behind, so a past step on the rail is a way back to its artifacts.
import { prDetail, DEFAULT_REPO } from './reviews';
import { readInWorkspace } from './workspace-tools';
import { latestAgentReport } from './conversations';
import { devFetch, workspaceMediaListUrl, workspaceMediaFileUrl } from './api';
import type { WorkspaceStatus, Stage } from './workspace-status';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface RailStep {
  key: Stage;
  label: string;
}

export const FIX_STEPS: RailStep[] = [
  { key: 'assess', label: 'Assess' },
  { key: 'code', label: 'Code' },
  { key: 'draft', label: 'Draft PR' },
  { key: 'review', label: 'In review' },
  { key: 'feedback', label: 'Feedback' },
  { key: 'merged', label: 'Merged' },
];

export const REVIEW_STEPS: RailStep[] = [
  { key: 'agent', label: 'Agent review' },
  { key: 'findings', label: 'Your pass' },
  { key: 'submitted', label: 'Submitted' },
  { key: 'response', label: 'Developer responded' },
  { key: 'approved', label: 'Approved' },
];

export function stepsFor(kind: WorkspaceStatus['kind']): RailStep[] {
  return kind === 'review' ? REVIEW_STEPS : kind === 'fix' ? FIX_STEPS : [];
}

// ── Evidence ────────────────────────────────────────────────────────────────────────────────

export type EvidenceItem =
  | { kind: 'text'; text: string; at?: string; who?: string }
  | { kind: 'kv'; rows: { k: string; v: string; tone?: string }[] }
  | { kind: 'media'; items: { label: string; url: string; video: boolean; at: string }[] }
  | { kind: 'comments'; items: { who: string; where: string; body: string; at: string; answered: boolean }[] }
  | { kind: 'commits'; items: { sha: string; message: string; who: string; at: string }[] }
  | { kind: 'files'; items: { path: string; note: string }[] }
  | { kind: 'links'; items: { label: string; url: string }[] }
  | { kind: 'empty'; text: string };

export interface EvidenceSection {
  title: string;
  items: EvidenceItem[];
}

interface Branch {
  branch: string;
  commits: { sha: string; message: string; who: string; at: string }[];
  stat: string;
  files: string[];
}

export const ago = (iso: string): string => {
  const ms = Date.now() - (Date.parse(iso || '') || Date.now());
  const m = Math.round(ms / 60_000);

  if (m < 2) {
    return 'just now';
  }
  if (m < 60) {
    return `${ m } min ago`;
  }
  const h = Math.round(m / 60);

  if (h < 36) {
    return `${ h } h ago`;
  }

  return `${ Math.round(h / 24) } days ago`;
};

/** The branch as the checkout has it: its commits over upstream, the diff's size, the files. */
async function readBranch(workspace: string): Promise<Branch | null> {
  const script = [
    'cd $WS/dashboard 2>/dev/null || { echo "@@NOREPO"; exit 0; }',
    'base=$(git merge-base upstream/master HEAD 2>/dev/null || git merge-base origin/master HEAD 2>/dev/null || git rev-parse HEAD)',
    'echo "@@BRANCH $(git rev-parse --abbrev-ref HEAD 2>/dev/null)"',
    'echo "@@COMMITS"',
    'git log --format="%h%x09%s%x09%an%x09%aI" "$base"..HEAD 2>/dev/null | head -30',
    'echo "@@STAT"',
    'git diff --shortstat "$base" 2>/dev/null',
    'echo "@@FILES"',
    'git diff --name-only "$base" 2>/dev/null | head -80',
    'echo "@@END"',
  ].join('\n');
  const out = await readInWorkspace(workspace, script).catch(() => '');

  if (!out || out.includes('@@NOREPO')) {
    return null;
  }
  const section = (name: string, next: string) => out.slice(out.indexOf(`@@${ name }`) + name.length + 3, out.indexOf(`@@${ next }`)).trim();

  return {
    branch:  /@@BRANCH (\S*)/.exec(out)?.[1] || '',
    commits: section('COMMITS', 'STAT').split('\n').filter(Boolean).map((line) => {
      const [sha, message, who, at] = line.split('\t');

      return {
        sha, message: message || '', who: who || '', at: at || '',
      };
    }),
    stat:  section('STAT', 'FILES'),
    files: section('FILES', 'END').split('\n').filter(Boolean),
  };
}

async function readMedia(workspace: string): Promise<{ label: string; url: string; video: boolean; at: string; path: string }[]> {
  const data = await devFetch(workspaceMediaListUrl(workspace)).catch(() => null);
  const files: Json[] = data?.files || [];

  return files
    .filter((f) => !/^a11y\//.test(f.path))
    .sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0))
    .slice(0, 12)
    .map((f) => ({
      label: f.path, url: workspaceMediaFileUrl(workspace, f.path), video: /video/.test(f.type || ''), at: new Date(f.mtimeMs || 0).toISOString(), path: f.path,
    }));
}

const mediaUnder = (media: Awaited<ReturnType<typeof readMedia>>, ...dirs: string[]) => media.filter((m) => dirs.some((d) => m.path.startsWith(`${ d }/`)));

function checklist(body: string): { ticked: number; total: number } {
  const ticked = (body.match(/- \[x\]/gi) || []).length;
  const open = (body.match(/- \[ \]/g) || []).length;

  return { ticked, total: ticked + open };
}

function prRows(d: Json): { k: string; v: string; tone?: string }[] {
  const m = d.meta || {};
  const ci = m.ci || {};
  const state = m.merged ? 'merged' : m.draft ? 'draft' : String(m.state || '').toLowerCase();
  const rows: { k: string; v: string; tone?: string }[] = [
    { k: 'PR', v: `#${ m.number } · ${ state }${ m.approved ? ` · approved by ${ (m.approvedBy || []).join(', ') }` : '' }` },
    { k: 'Size', v: `${ m.changedFiles ?? d.files?.length ?? 0 } files · +${ m.additions ?? 0 } −${ m.deletions ?? 0 }` },
  ];

  if (ci.total) {
    const state = ci.failing ? `${ ci.failing } failing` : ci.pending ? `${ ci.pending } running` : 'green';

    rows.push({ k: 'CI', v: `${ state } · ${ ci.total } jobs`, tone: ci.failing ? 'bad' : ci.pending ? '' : 'ok' });
  }
  const list = checklist(m.body || '');

  if (list.total) {
    rows.push({ k: 'Checklist', v: `${ list.ticked } of ${ list.total } boxes ticked` });
  }

  return rows;
}

/** Comments on a PR by people other than its author, after a moment, each with whether the author answered. */
function feedback(d: Json, since: number): { who: string; where: string; body: string; at: string; answered: boolean }[] {
  const m = d.meta || {};
  const all: Json[] = [
    ...(d.reviewComments || []).map((c: Json) => ({ ...c, where: c.path ? `${ c.path }${ c.line ? `:${ c.line }` : '' }` : 'review' })),
    ...(d.discussion || []).map((c: Json) => ({ ...c, where: 'discussion' })),
  ];
  const mine = all.filter((c) => c.author === m.author);

  return all
    .filter((c) => c.author && c.author !== m.author && !c.pending && (Date.parse(c.createdAt) || 0) > since)
    .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0))
    .map((c) => ({
      who: c.author, where: c.where, body: String(c.body || '').slice(0, 400), at: c.createdAt, answered: mine.some((r) => (r.inReplyTo && r.inReplyTo === c.id) || (Date.parse(r.createdAt) || 0) > (Date.parse(c.createdAt) || 0)),
    }));
}

const pushedAt = (d: Json) => Math.max(0, ...(d.commits || []).map((c: Json) => Date.parse(c.date || '') || 0));

/**
 * What there is to look at for one stage of a workspace's work - the current one, or one that
 * has passed. Everything is read fresh: the branch, the recordings, the PR, the agent's report.
 */
export async function gatherEvidence(workspace: string, status: WorkspaceStatus, stage: Stage): Promise<EvidenceSection[]> {
  const [report, branch, media, d] = await Promise.all([
    latestAgentReport(workspace).catch(() => null),
    readBranch(workspace).catch(() => null),
    readMedia(workspace).catch(() => []),
    status.pr ? prDetail(status.pr).catch(() => null) : Promise.resolve(null),
  ]);
  const sections: EvidenceSection[] = [];
  const reportSection = (title = 'Agent\'s report') => report && sections.push({ title, items: [{ kind: 'text', text: report.text, at: report.at }] });
  const mediaSection = (title: string, items: ReturnType<typeof mediaUnder>) => items.length && sections.push({ title, items: [{ kind: 'media', items }] });
  const branchSection = () => {
    if (!branch) {
      return;
    }
    const tests = branch.files.filter((f) => /\.(test|spec)\.[jt]sx?$|__tests__\//.test(f));
    const items: EvidenceItem[] = [];

    if (branch.commits.length) {
      items.push({ kind: 'commits', items: branch.commits });
    }
    items.push({ kind: 'kv', rows: [{ k: 'Branch', v: branch.branch }, { k: 'Diff', v: branch.stat || 'no changes over upstream' }, { k: 'Tests', v: tests.length ? tests.join(', ') : 'none added', tone: tests.length ? 'ok' : 'warn' }] });
    if (branch.files.length) {
      items.push({ kind: 'files', items: branch.files.map((path) => ({ path, note: tests.includes(path) ? 'test' : '' })) });
    }
    sections.push({ title: 'The change', items });
  };
  const prSection = () => d && sections.push({ title: 'Pull request', items: [{ kind: 'kv', rows: prRows(d) }, { kind: 'text', text: String(d.meta?.body || '').slice(0, 1200) || '(no description)' }] });

  if (status.kind === 'fix') {
    switch (stage) {
    case 'assess':
      reportSection(report && branch?.commits.length ? 'Agent\'s latest report' : 'Agent\'s assessment');
      mediaSection('Reproduced', mediaUnder(media, 'reproduce'));
      sections.push({ title: 'The issue', items: [{ kind: 'links', items: status.links.filter((l) => l.label.startsWith('Issue')) }] });
      break;
    case 'code':
      branchSection();
      mediaSection('Before and after', [...mediaUnder(media, 'verify'), ...mediaUnder(media, 'reproduce')]);
      reportSection();
      break;
    case 'draft':
      prSection();
      mediaSection('Recorded', [...mediaUnder(media, 'verify'), ...mediaUnder(media, 'reproduce')]);
      reportSection();
      break;
    case 'review':
      prSection();
      if (d) {
        const fb = feedback(d, 0);

        sections.push({ title: 'Reviewers', items: fb.length ? [{ kind: 'comments', items: fb }] : [{ kind: 'empty', text: 'Nobody has commented yet.' }] });
      }
      break;
    case 'feedback':
      if (d) {
        const fresh = feedback(d, pushedAt(d));
        const older = feedback(d, 0).filter((c) => !fresh.includes(c));

        sections.push({ title: 'Since your last push', items: fresh.length ? [{ kind: 'comments', items: fresh }] : [{ kind: 'empty', text: 'Nothing new since the last push.' }] });
        if (older.length) {
          sections.push({ title: 'Earlier rounds', items: [{ kind: 'comments', items: older }] });
        }
      }
      prSection();
      reportSection();
      break;
    case 'merged':
      prSection();
      branchSection();
      break;
    }
  } else if (status.kind === 'review') {
    const local: Json[] = d?.localComments || [];
    const pending = local.filter((c) => !c.submitted_at);
    const submitted = local.filter((c) => c.submitted_at);
    const submittedAt = Math.max(0, ...submitted.map((c) => Date.parse(c.submitted_at) || 0));
    const findings = (list: Json[]) => ({
      kind: 'comments' as const,
      items: list.map((c) => ({
        who: c.author || 'agent', where: c.path ? `${ c.path }${ c.line ? `:${ c.line }` : '' }` : 'PR', body: String(c.body || '').slice(0, 400), at: c.created_at || '', answered: !!c.submitted_at,
      })),
    });

    switch (stage) {
    case 'agent':
      prSection();
      reportSection(status.agent === 'working' ? 'Where the agent is' : 'Agent\'s report');
      break;
    case 'findings':
      sections.push({ title: `Findings (${ pending.length } to go through)`, items: pending.length ? [findings(pending)] : [{ kind: 'empty', text: submitted.length ? 'All submitted.' : 'None yet.' }] });
      prSection();
      reportSection();
      break;
    case 'submitted':
      sections.push({ title: `Your review (${ submitted.length } comments)`, items: submitted.length ? [findings(submitted)] : [{ kind: 'empty', text: 'Nothing submitted yet.' }] });
      prSection();
      break;
    case 'response':
      if (d) {
        const newCommits = (d.commits || []).filter((c: Json) => (Date.parse(c.date || '') || 0) > submittedAt).map((c: Json) => ({
          sha: String(c.sha || '').slice(0, 7), message: c.message, who: c.author, at: c.date,
        }));
        const replies = [...(d.reviewComments || []), ...(d.discussion || [])]
          .filter((c: Json) => c.author === d.meta?.author && (Date.parse(c.createdAt) || 0) > submittedAt)
          .map((c: Json) => ({
            who: c.author, where: c.path ? `${ c.path }:${ c.line || '' }` : 'discussion', body: String(c.body || '').slice(0, 400), at: c.createdAt, answered: true,
          }));

        sections.push({ title: 'Since your review', items: [...(newCommits.length ? [{ kind: 'commits' as const, items: newCommits }] : []), ...(replies.length ? [{ kind: 'comments' as const, items: replies }] : []), ...(!newCommits.length && !replies.length ? [{ kind: 'empty' as const, text: 'No new commits or replies.' }] : [])] });
      }
      prSection();
      break;
    case 'approved':
      prSection();
      break;
    }
  }

  return sections;
}

/** The GitHub URL of the PR a status is about, or of the issue when there is no PR yet. */
export function primaryLink(status: WorkspaceStatus): string {
  return (status.links.find((l) => l.label.startsWith('PR')) || status.links[0])?.url || `https://github.com/${ DEFAULT_REPO }`;
}
