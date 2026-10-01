// The skills the agents run on, editable from here: read and saved through the in-cluster API
// (dev-api), which keeps edits in a ConfigMap over the shipped seed and can commit them to the
// repository the skills are kept in. Every workspace lays out the edited skill the next time
// it is prepared - which refreshSkillsEverywhere does at once, and the sidebar's poll does
// whenever the seed's version moves (an agent may have saved one).
import { devApi } from './reviews';
import { listAllWorkspaces } from './api';
import { ensureWorkspaceReady } from './workspace-tools';

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

// ── The prompts the rail's buttons send ─────────────────────────────────────────────────────
//
// Each action has a template with `{{ variables }}` in it; what ships is the default, and an
// edit here is kept beside the skills (the same ConfigMap), so it holds for every workspace
// and everyone who opens one.

export async function readPrompts(): Promise<Record<string, string>> {
  return (await devApi('/prompts'))?.prompts || {};
}

export async function savePromptTemplate(key: string, template: string): Promise<void> {
  await devApi(`/prompts/${ encodeURIComponent(key) }`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ template }),
  });
}

export async function resetPromptTemplate(key: string): Promise<void> {
  await devApi(`/prompts/${ encodeURIComponent(key) }`, { method: 'DELETE' });
}

