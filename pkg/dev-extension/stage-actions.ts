/**
 * What can be done to a piece of work at the stage it is at - one definition for every view.
 *
 * The workspace's standard view (the rail) and the Focus deck both offer actions on the same work,
 * and they were written twice: the rail's per stage, the deck's per card. So a draft PR read
 * "Mark ready for review" and a skill in one place and "Mark it ready for review, Open the pull
 * request, Walk me through it, Request changes, Open the build" in the other - two answers to the
 * one question "what can I do about this now". This is the rail's answer, moved here unchanged,
 * and both views ask it.
 *
 *   - `stageAction` is the stage's headline, detail, primary and tools, for a fix or a review;
 *   - `stageRow` is the row the rail draws from it: the primary first, then your decisions, then
 *     the agent's, then the stage's skills;
 *   - `sayInWorkspace` is how an action puts a prompt in front of the workspace's agent: the
 *     conversation that one goes to, typed into a running pane or queued and started on a
 *     stopped one, or a new conversation for an action that starts one of its own.
 *
 * A Jira workspace's actions stay in the rail: they open the triage panel, which only it has.
 */
import type { WorkspaceStatus } from './workspace-status';
import {
  skillsFor, ACTION_TEMPLATES, promptVars, expandPrompt, contextClause, skillPrompt,
} from './workspace-rail';
import type { SkillButton } from './workspace-rail';
import { pickConversation, isDiscussion } from './conversation-pick.mjs';
import { isProjectConversationId } from './conversation-id.mjs';
import {
  listConversations, startConversation, queuePrompt, startPaneDetached, workspaceAgentStates, sendToPane,
} from './conversations';
import type { ProjectConversation } from './conversations';
import { ensureWorkspaceReady } from './workspace-tools';

/** One button: what it says, and the action it runs - a rail method, by name. */
export interface StageButton {
  label: string;
  run: string;
  arg?: string;
  title?: string;
  isPrimary?: boolean;
}

export interface StageAction {
  headline: string;
  detail: string;
  primary: StageButton | null;
  tools: StageButton[];
}

/**
 * The stage's action, for a fix or a review workspace; null for any other kind.
 *
 * @param s     the workspace's status (workspace-status.ts)
 * @param stage the stage being looked at - the current one, or a past one looked back at
 * @param issue the issue a fix workspace is named for, 0 for none
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function stageAction(s: WorkspaceStatus | any, stage: string, issue = 0): StageAction | null {
  if (s.kind === 'fix') {
    switch (stage) {
    case 'assess':
      // An issue workspace is here to be fixed, so "Fix it" is the action at this stage whatever
      // the agent is doing: it runs the whole my-issue-fix flow - reproduce, fix, verify, open a
      // draft PR. It is the primary while nothing is being worked, and a tool while the agent is
      // mid-assessment so it does not cut across a conversation already going. The assessment
      // skills (reproduce, root cause) sit beside it on the Actions row, marked as the
      // agent's.
      // A developer workspace not named for an issue has nothing for "Fix it" to start from.
      if (!issue) {
        return s.agent === 'input' ? {
          headline: 'The agent is waiting for an answer', detail: 'It asked something in its conversation and stopped until it hears back.', primary: { label: 'Answer it', run: 'openTab', arg: 'conversations' }, tools: [],
        } : {
          headline: s.agent === 'working' ? 'The agent is working' : 'Nothing is on this branch yet', detail: 'This workspace is not for an issue: say what it is for in its conversation.', primary: null, tools: [],
        };
      }
      if (s.agent === 'input') {
        return {
          headline: 'The agent is waiting for an answer', detail: 'It asked something in its conversation and stopped until it hears back.', primary: { label: 'Answer it', run: 'openTab', arg: 'conversations' }, tools: [{ label: 'Fix it', run: 'startFix' }],
        };
      }
      if (s.agent === 'working') {
        return {
          headline: 'The agent is looking at the issue', detail: 'Follow along in the conversation, or tell it to go ahead and fix it.', primary: { label: 'Fix it', run: 'startFix' }, tools: [],
        };
      }

      return {
        headline: s.agent === 'none' ? 'Nothing has started on this issue' : 'The agent stopped before opening a PR', detail: 'Fix it starts a conversation that reproduces the issue, fixes it, verifies the fix and opens a draft PR.', primary: { label: 'Fix it', run: 'startFix' }, tools: [],
      };
    case 'code':
      if (s.agent === 'input') {
        return {
          headline: 'The agent is waiting for an answer', detail: 'It asked something in its conversation and stopped until it hears back.', primary: { label: 'Answer it', run: 'openTab', arg: 'conversations' }, tools: [],
        };
      }

      // Stopped with the work on the branch and no PR: putting it up is the one thing to press.
      return {
        headline: s.agent === 'working' ? 'The agent is working on the fix' : 'The agent stopped before opening a PR',
        detail:   s.agent === 'working' ? 'Follow along in the conversation, or ask it something below.' : 'Read its report on the left. Put it up for review pushes the branch, uploads the recordings and opens a draft PR; or ask the agent to carry on, or to change course, below.',
        primary:  s.agent === 'working' ? null : { label: 'Put it up for review', run: 'openPr' },
        tools:    [],
      };
    case 'draft':
      return {
        // No "Ask for a change" beside it: the conversation is on this page, under this
        // bar, with its own box to type in. A button whose whole job is to move the cursor
        // into a box the reader can already see is a button that reads as another decision.
        headline: 'The draft PR is ready for you to read', detail: 'Read the description and the change on the left. Marking it ready is yours; so is the reviewer, on GitHub.', primary: { label: 'Mark ready for review', run: 'markReady' }, tools: [],
      };
    case 'review':
      return {
        headline: 'Waiting for a reviewer', detail: 'Nothing here is yours until someone comments. The agent can still be asked for something meanwhile.', primary: { label: 'Ask the agent', run: 'focusAsk' }, tools: [],
      };
    case 'feedback':
      return {
        headline: 'Reviewers left comments after your last push', detail: 'The agent reads each comment, answers or changes the code, re-verifies and pushes. You read its report before anything else happens.', primary: { label: 'Answer the feedback', run: 'answerFeedback' }, tools: [{ label: 'Re-verify the fix', run: 'reverify' }, { label: 'Ask the agent', run: 'focusAsk' }],
      };
    case 'merged':
      // Merged is not the end of the conversation. The agent that did the work is the one
      // that knows how it was done, and the questions that follow a merge - why this way,
      // what about the other call site, can you write the follow-up issue - are worth more
      // here than anywhere else. So the way in stays on the page; only deleting the
      // workspace takes it away.
      return {
        headline: s.label === 'Approved' ? 'Approved' : 'Merged', detail: 'Nothing is waiting on you. The agent is still here for follow-up questions; deleting the workspace is what ends it (the PR and the transcript stay).', primary: s.label === 'Approved' ? { label: 'Merge', run: 'merge' } : null, tools: [{ label: 'Delete the workspace', run: 'remove' }],
      };
    }
  }
  /*
   * No "Open the whole PR" anywhere in here.
   *
   * Every stage that had it already carries the pull request: its number and its link are
   * in the header, the Pull request section below holds the description, the checks, the
   * checklist and now the whole conversation, and each finding links to its own thread on
   * GitHub. A button to open what is already open, next to links that already go there,
   * was a third way to say the same thing.
   */
  if (s.kind === 'review') {
    switch (stage) {
    case 'agent':
      if (s.agent === 'none') {
        return {
          headline: 'No review has run yet', detail: 'Starts a review conversation over the PR; its findings land on the left as it goes.', primary: { label: 'Review this PR', run: 'startReview' }, tools: [],
        };
      }

      // This stage never had "Open the conversation" and no stage has it now, for the reason
      // that kept it off this one: the conversation is already on this page, in the strip
      // above this box, so a button to open what is open is one more thing to read past.
      /*
       * Whether the pass is still being made, which is not the same question as whether the
       * main agent is writing this second.
       *
       * The stage is held here by the agent's own run record now (review-pass.mjs), so
       * `idle` is the ordinary reading of a pass whose work is in subagents - and reading
       * the agent state alone put "The agent stopped" over a review with seven passes
       * running. `working` on the tone is what the run record set.
       */
      return {
        headline: s.agent === 'working' || s.tone === 'working' ? 'The agent is reviewing' : 'The agent stopped',
        // What has landed so far, where the status counted it: a pass an hour in with six
        // findings on the left said nothing here about either. Only the running pass's own
        // label, which is that count - the other labels this stage carries ("not started")
        // are not a number of anything.
        detail:   s.tone === 'working' && s.label ? `${ s.label } on the left; go through them once it is done.` : 'Its findings land on the left as it goes; go through them once it is done.',
        primary:  { label: 'Full review', run: 'startReview' },
        tools:    [],
      };
    case 'findings':
      // A pass ends one of three ways, and all three are here: send the findings back as
      // changes to make, approve with them attached, or approve and let them go. Each
      // marked-good finding rides along; the cards on the left are where they are read.
      //
      // A pass after a review of yours is another round of the same step, so it says so
      // and offers the agent another look at what the developer did.
      // Every finding went, so the two buttons that carry findings back to GitHub have
      // nothing to carry. The pass is still yours: ship it, or send the agent round again.
      if (s.label === 'nothing left to go through') {
        return {
          headline: 'Nothing left from the agent\'s pass',
          detail:   'Its findings have all been read and cleared. Ship the PR, or ask for another look.',
          primary:  { label: 'Ship it', run: 'openApprove' },
          tools:    [
            { label: 'Review this PR again', run: s.reviewed ? 'reviewAgain' : 'startReview' },
          ],
        };
      }

      return {
        headline: s.reviewed ? 'A new pass over what the agent found in the developer\'s changes' : 'The agent\'s findings are ready for your pass',
        detail:   s.reviewed ? 'The findings are on the left, under them what the agent looked at, then the commits and threads of this round.' : 'Go through them on the left: keep the ones you agree with, then send them back or approve.',
        primary:  { label: 'Ask for changes', run: 'requestChanges' },
        tools:    [
          { label: 'Ship it with comments', run: 'shipWithComments' },
          { label: 'Ship it', run: 'openApprove' },
          // Filing what is pending without a verdict on the pull request - the third thing
          // a finished pass can do, and the only one that was not on this row.
          { label: 'Post comments', run: 'postComments' },
          ...(s.reviewed ? [{ label: 'Review the new commits again', run: 'reviewAgain' }] : []),
          // No "Ask the agent" at this stage, on either round. The conversation is on the
          // page under these buttons, and the row here is for deciding what happens to the
          // findings - a general "ask it something" is not one of those decisions.
        ],
      };
    case 'submitted':
      // One button, because there is one thing to do. The review is with the developer:
      // the stage either waits or it is approved, and "Go through the findings" and
      // "Review the branch" were two more ways to look at what is already on the page
      // below - offered at the one stage with nothing to decide but that.
      return {
        headline: 'Your review is with the developer',
        // Says what actually moves it on, which is not a push: a commit can be a rebase or a
        // merge of main, and the stage used to take any of them for an answer.
        detail:   s.pushedSince
          ? 'They have pushed since your review but have not answered your comments or asked for another look, so this is still with them. You can review the new commits anyway.'
          : 'This moves on when they reply to your comments or ask you to look again. Your comments are on the left; the PR and its diff are a click away.',
        primary: { label: 'Approve', run: 'openApprove' },
        tools:   s.pushedSince ? [{ label: 'Review the new commits', run: 'reviewAgain' }] : [],
      };
    case 'response':
      // Nothing is filed yet: what the agent finds puts the rail back on Your pass, which
      // is where findings are gone through, whichever round it is.
      return {
        headline: 'The developer responded', detail: 'New commits and replies since your review are on the left. The agent can review what changed against your comments; what it finds comes back here as a second pass.', primary: { label: 'Review the new commits', run: 'reviewAgain' }, tools: [{ label: 'Approve', run: 'openApprove' }],
      };
    case 'approved':
      return {
        // Your part is over either way: merging is the author's, so what is left here is
        // to let the workspace go. The conversations and the PR outlive it.
        headline: s.label === 'Merged' ? 'Merged' : 'Approved', detail: s.label === 'Merged' ? 'Nothing is waiting on you. The agent is still here if you want to ask it something about what it found.' : 'Your review is done and the author merges. The agent is still here for anything you want to ask about it.', primary: null, tools: [{ label: 'Delete the workspace', run: 'remove' }],
      };
    }
  }

  return null;
}

/** The runs that put something in front of the agent rather than being a decision of yours. */
export function agentRun(button: StageButton): boolean {
  return !!ACTION_TEMPLATES[button.run] || button.run === 'focusAsk' || (button.run === 'openTab' && button.arg === 'conversations');
}

/** One item in the row: a stage button, or one of the stage's skills. */
export interface StageRowItem {
  key: string;
  label: string;
  /** The rail method it runs; '' for a skill. */
  run: string;
  arg?: string;
  skill?: SkillButton;
  isPrimary: boolean;
  /** Whether it sets the agent working, which the views mark. */
  ai: boolean;
  title: string;
}

/**
 * The row the rail draws for a stage, in the rail's order: the primary first, then the decisions
 * that are yours, then what the agent is asked to do, then the stage's skills.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function stageRow(s: WorkspaceStatus | any, stage: string, issue = 0): StageRowItem[] {
  const action = stageAction(s, stage, issue);
  const buttons: StageButton[] = action ? [...action.tools, ...(action.primary ? [{ ...action.primary, isPrimary: true }] : [])] : [];
  const item = (b: StageButton, ai: boolean): StageRowItem => ({
    key: `${ ai ? 'agent' : 'you' }:${ b.label }`, label: b.label, run: b.run, arg: b.arg, isPrimary: !!b.isPrimary, ai, title: b.title || '',
  });
  const mine = buttons.filter((b) => !agentRun(b)).map((b) => item(b, false));
  const theirs = buttons.filter((b) => agentRun(b)).map((b) => item(b, true));
  const skills: StageRowItem[] = skillsFor(s?.kind, stage as never, !!s?.reviewed).map((button) => ({
    key: `skill:${ button.skill }`, label: button.label, run: '', skill: button, isPrimary: false, ai: true, title: button.note,
  }));
  const all = [...mine, ...theirs, ...skills];

  return [...all.filter((a) => a.isPrimary), ...all.filter((a) => !a.isPrimary)];
}

/**
 * The prompt an agent's action sends, filled in: the person's edited template where there is one
 * (the rail's middle-click editor, keyed by skill or by run), the shipped one where not. '' for a
 * decision, which sends nothing.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function stagePrompt(item: { run: string; skill?: SkillButton }, s: WorkspaceStatus | any, issue: number, workspace: string, repo: string, edited: Record<string, string> = {}): string {
  if (item.skill) {
    return skillPrompt(item.skill, s, issue, workspace, edited[item.skill.skill] || '', repo);
  }
  const template = edited[item.run] || ACTION_TEMPLATES[item.run] || '';

  return template ? expandPrompt(template, [...promptVars(s, issue, workspace, repo), contextClause(s)]) : '';
}

/**
 * Put a prompt in front of a workspace's agent, the way a stage's action does.
 *
 * Which conversation, in the order a person would expect: the one on show (`focused`), the one
 * the action is about (`current`, then the one named for the PR), then the newest of the
 * workspace's own - never a discussion. A running pane is typed into, because a queued prompt is
 * only read when claude starts; a stopped one has it queued and is started to read it. `reuse`
 * false - an action that names a conversation of its own - starts a new one with the prompt.
 */
export async function sayInWorkspace(workspace: string, title: string, text: string, {
  reuse = !title, from = title, focused = '', current = '', pr = 0,
}: { reuse?: boolean; from?: string; focused?: string; current?: string; pr?: number } = {}): Promise<{ conversation: ProjectConversation; running: boolean; started: boolean }> {
  await ensureWorkspaceReady(workspace);
  const own = (await listConversations(workspace).catch(() => [] as ProjectConversation[]))
    .filter((c) => isProjectConversationId(workspace, c.id))
    .filter((c) => !isDiscussion(c.title));
  const newest = pickConversation(own, { focused, current, pr }) as ProjectConversation | null;

  if (newest && reuse) {
    const states = await workspaceAgentStates(workspace).catch(() => ({} as Record<string, string>));
    const running = ['working', 'input', 'idle'].includes(states[newest.id]);

    if (running) {
      await sendToPane(newest.id, text);
    } else {
      await queuePrompt(newest.attach, text);
      await startPaneDetached(workspace, newest.id).catch(() => {});
    }

    return { conversation: newest, running, started: false };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const started = await startConversation(workspace, title, text, '', from as any);

  return { conversation: started, running: false, started: true };
}
