// Asking the agent about the card in front of you.
//
// This product already has one conversation - the panel's, and a workspace's own - and a second
// one here would be a place where half of what you asked ended up. So every "ask" from the deck
// goes into the conversation the work belongs to.
//
// Which conversation that is follows from the work rather than from this file: something that
// lives in a workspace is asked in that workspace, where the checkout and the tools are;
// anything else is asked in the panel, which is the conversation that belongs to no workspace.
//
// What this file no longer does is *send*. It used to end in `openAgentPanel` - the shell's
// terminal drawer, which slides over the card you just asked about - and then, better, it
// queued the prompt through the agent API and let the view show the conversation somewhere
// else. Both of those are a card talking to the agent behind the chat's back: the message
// arrived without ever having been a message, so the bar could not show it as sent, could not
// tell you when claude had not recorded it, and could not put it in the log with the rest of
// what you have said.
//
// So this resolves *which* conversation and stops there, and the bar sends it through the same
// path as anything typed - one send path, in chat-conversation.ts. `queueForLater` is the old
// behaviour, kept for the one case the new one cannot cover: a conversation whose pane will not
// take a paste yet, where a queued prompt is read when it finally starts. See pages/Focus.vue.

import { openConversation, sayInConversation } from './reviews';
import {
  agentSessions, startAgentSession, queueSessionPrompt
} from './agent';
import type { FocusTask } from './focus';

/** A conversation to put something in: its id, and the workspace it belongs to if it has one. */
export interface AskTarget {
  id: string;
  /**
   * The workspace, or ''. The bar needs it to build the pane's argv: a workspace's conversation
   * runs in the agent pod but in that workspace's checkout, which is a different `shell.sh`
   * line from the panel's. See `paneCommand` in conversations.ts.
   */
  workspace: string;
}

/**
 * Where a question about this card belongs, made if it does not exist yet.
 *
 * `task` may be null: the card editor asks about the cards themselves, which are nobody's
 * workspace. An empty id means nothing could be opened, and the caller should say so rather
 * than pretend the question was asked.
 */
export async function conversationFor(task: FocusTask | null): Promise<AskTarget> {
  if (task?.workspace) {
    // The workspace's own conversation, made if there is none. Everything the agent would need
    // to act on this - the checkout, the branch, the tools - is in there and nowhere else.
    const conversation = await openConversation(task.workspace, 'Focus');

    return { id: conversation.id, workspace: task.workspace };
  }

  return { id: await panelConversation(), workspace: '' };
}

/**
 * The panel's conversation: the most recent one it owns, or a new one.
 *
 * Reused rather than started fresh each time, because a question about the queue is usually the
 * next question in the same conversation - and a panel that grows a tab per card is a panel
 * nobody can find anything in. `panel` rather than `api` as the origin: this one is meant to be
 * seen there. See agent.ts.
 */
export async function panelConversation(): Promise<string> {
  const sessions = await agentSessions().catch(() => []);

  return sessions.length ? sessions[sessions.length - 1].id : startAgentSession('panel');
}

/**
 * Leave the prompt where the conversation will read it when it starts.
 *
 * The fallback, and only the fallback. A pane that is not running cannot be pasted into, and a
 * workspace whose pod is still coming up has no pane at all - so the bar's send fails, and
 * rather than losing the question this writes it where `shell.sh` looks on its way into claude.
 * It is strictly worse than sending: nothing shows it as yours until claude records it, which
 * can be minutes. That is the trade, and it only applies when the alternative is nothing.
 */
export async function queueForLater(task: FocusTask | null, prompt: string): Promise<void> {
  if (!prompt.trim()) {
    return;
  }
  if (task?.workspace) {
    const conversation = await openConversation(task.workspace, 'Focus');

    await sayInConversation(conversation, prompt);

    return;
  }

  await queueSessionPrompt(await panelConversation(), prompt);
}
