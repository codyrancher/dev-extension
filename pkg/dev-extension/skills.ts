// The skills the agents run on, editable from here: read and saved through the in-cluster API
// (dev-api), which keeps edits in a ConfigMap over the shipped seed and can commit them to the
// repository the skills are kept in. Every workspace lays out the edited skill the next time
// it is prepared - which refreshSkillsEverywhere does at once, and the sidebar's poll does
// whenever the seed's version moves (an agent may have saved one).
import { devApi } from './reviews';
import { listAllWorkspaces } from './api';
import { ensureWorkspaceReady } from './workspace-tools';
import {
  listConversations, startConversation, transcriptPathOf, ProjectConversation
} from './conversations';
import { workspaceRoot } from './config/constants';

export interface SkillSummary {
  name: string;
  description: string;
  overridden: boolean;
}

export interface Skill {
  name: string;
  content: string;
  baked: string;
  overridden: boolean;
}

export async function listSkills(): Promise<{ skills: SkillSummary[]; version: string }> {
  return devApi('/skills');
}

export async function readSkill(name: string): Promise<Skill> {
  return devApi(`/skills/${ encodeURIComponent(name) }`);
}

export async function saveSkill(name: string, content: string, commit = false, message = ''): Promise<{ overridden: boolean; commit: { committed: boolean; url: string } | null; version: string }> {
  return devApi(`/skills/${ encodeURIComponent(name) }`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content, commit, message }),
  });
}

export async function resetSkill(name: string): Promise<void> {
  await devApi(`/skills/${ encodeURIComponent(name) }/reset`, { method: 'POST', body: '{}' });
}

export async function seedVersion(): Promise<string> {
  return (await devApi('/agent-seed/version'))?.version || '';
}

/**
 * Lay the current skills out in every running workspace on this cluster, one after another.
 * ensureWorkspaceReady is cheap when a workspace already has the seed at this version and a
 * few seconds when it does not. Failures are reported per workspace, not thrown.
 */
export async function refreshSkillsEverywhere(onNote?: (note: string) => void): Promise<{ done: string[]; failed: { name: string; error: string }[] }> {
  const workspaces = (await listAllWorkspaces().catch(() => [])).filter((w) => (w.cluster || 'local') === 'local' && !w.preview && w.state === 'running');
  const done: string[] = [];
  const failed: { name: string; error: string }[] = [];

  for (const w of workspaces) {
    onNote?.(`updating ${ w.name }…`);
    try {
      await ensureWorkspaceReady(w.name);
      done.push(w.name);
    } catch (e) {
      failed.push({ name: w.name, error: (e as Error)?.message || String(e) });
    }
  }

  return { done, failed };
}

/** Every workspace's conversations, for picking the one a skill should learn from. */
export async function allConversations(): Promise<(ProjectConversation & { workspace: string })[]> {
  const workspaces = (await listAllWorkspaces().catch(() => [])).filter((w) => (w.cluster || 'local') === 'local' && !w.preview);
  const out: (ProjectConversation & { workspace: string })[] = [];

  for (const w of workspaces) {
    for (const c of await listConversations(w.name).catch(() => [])) {
      out.push({ ...c, workspace: w.name });
    }
  }

  return out;
}

/**
 * Ask an agent to improve a skill from what a conversation shows, in a new conversation of
 * that conversation's workspace - so it can be watched and talked to like any other. The
 * transcript is read with the file tools (they run in the agent pod, where it is); the save
 * goes through the API, which updates every workspace and commits to the repository.
 */
export async function improveSkillWith(skill: string, from: ProjectConversation & { workspace: string }, notes = ''): Promise<ProjectConversation> {
  const transcript = await transcriptPathOf(from.workspace, from.id);
  const skillPath = `${ workspaceRoot(from.workspace) }/.claude/skills/${ skill }/SKILL.md`;
  const save = `curl -fsS -X PUT "$CLAUDE_HARNESS_API/skills/${ skill }" -H 'content-type: application/json' --data-binary "$(node -e 'process.stdout.write(JSON.stringify({content:require(\"fs\").readFileSync(process.argv[1],\"utf8\"),commit:true,message:process.argv[2]}))' ${ skillPath } "Skill ${ skill }: <one line on what changed>")"`;
  const prompt = [
    `Improve the skill \`${ skill }\` using what the conversation "${ from.title }" (${ from.id }) shows.`,
    transcript ? `That conversation's transcript is the file ${ transcript } - read it with the Read and Grep tools (they run where the file is; a shell command does not).` : 'Read the transcript of that conversation from ~/.claude/projects with the Read and Grep tools.',
    `The skill's current text is ${ skillPath }.`,
    notes ? `What to look at in particular: ${ notes }` : '',
    'Work out what the conversation shows the skill should say differently: a step that was missing or wrong, an instruction the agent misread, a check that would have caught what went wrong, time spent that better guidance would have saved. Rewrite the skill: keep its structure and voice, change only what the evidence supports, and keep it the same length or shorter.',
    'Write the new text over the skill file, then save it with exactly this command, which updates every workspace and commits it to the skills repository:',
    '',
    save,
    '',
    'Finish with a short report: what changed and why, pointing at the moments in the conversation that showed it.',
  ].filter((line) => line !== null).join('\n');

  await ensureWorkspaceReady(from.workspace);

  return startConversation(from.workspace, `Improve ${ skill }`, prompt);
}
