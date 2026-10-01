// Asking the agent about the card in front of you.
//
// The prototype this view came from had a chat bar of its own along the bottom. This product
// already has one conversation - the panel, and a workspace's own - and a second one here would
// be a place where half of what you asked ended up. So every "ask" from the deck goes into the
// conversation the work belongs to, and the panel opens so you see it arrive.
//
// Which conversation that is follows from the work rather than from this file: something that
// lives in a workspace is asked in that workspace, where the checkout and the tools are;
// anything else is asked in the panel, which is the conversation that belongs to no workspace.

import { openConversation, sayInConversation } from './reviews';
import {
  agentSessions, startAgentSession, queueSessionPrompt
} from './agent';
import { openAgentPanel } from './overlay';
import type { FocusTask } from './focus';

/**
 * Put a prompt where it belongs, and show it being put there.
 *
 * `task` may be null: the card editor asks about the cards themselves, which are nobody's
 * workspace.
 */
export async function askTheAgent(task: FocusTask | null, prompt: string): Promise<void> {
  if (!prompt.trim()) {
    return;
  }

  if (task?.workspace) {
    // The workspace's own conversation, made if there is none. Everything the agent would need
    // to act on this - the checkout, the branch, the tools - is in there and nowhere else.
    const conversation = await openConversation(task.workspace, 'Focus');

    await sayInConversation(conversation, prompt);

    return;
  }

  await panelAsk(prompt);
}

/**
 * The panel's conversation: the most recent one it owns, or a new one.
 *
 * Reused rather than started fresh each time, because a question about the queue is usually the
 * next question in the same conversation - and a panel that grows a tab per card is a panel
 * nobody can find anything in. `panel` rather than `api` as the origin: this one is meant to be
 * seen there. See agent.ts.
 */
async function panelAsk(prompt: string): Promise<void> {
  const sessions = await agentSessions().catch(() => []);
  const id = sessions.length ? sessions[sessions.length - 1].id : await startAgentSession('panel');

  await queueSessionPrompt(id, prompt);
  await openAgentPanel(id).catch(() => {});
}
