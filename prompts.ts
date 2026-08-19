/**
 * The prompts a queued conversation opens with, which belong to the person rather than to the
 * product.
 *
 * An action on My Work does two things: it makes the workspace for a pull request, and it starts
 * a conversation in it that is already about that pull request. The second half is a prompt, and
 * a prompt is exactly the kind of thing one person wants worded differently from the next, so
 * these are defaults rather than rules: they are copied into a per-user ConfigMap the first time
 * Settings is opened, and everything after that reads what is in there.
 *
 * That is the same arrangement the harness has for its shared skills, where the text an agent
 * runs on is browsable and editable rather than compiled in.
 *
 * The placeholders are the ones an action can actually fill in. They are deliberately few: a
 * prompt that needs a dozen substitutions is a program, and this is a sentence.
 *
 *   {{repo}}   rancher/dashboard
 *   {{pr}}     18536
 *   {{issue}}  18500, or an empty string when the pull request closes none
 *   {{title}}  the pull request's title
 *   {{url}}    the pull request's address
 */
export interface DevPrompt {
  id: string;
  label: string;
  /** What the action is for, shown under the field in Settings. */
  help: string;
  text: string;
}

export const DEFAULT_PROMPTS: DevPrompt[] = [
  {
    id:    'review-pr',
    label: 'Review a pull request',
    help:  'Queued by Review on My Work. The workspace is made for the pull request first, so the conversation opens in a checkout of it.',
    text:  [
      'Review {{url}} ({{repo}}#{{pr}}): "{{title}}".',
      '',
      'This is a placeholder prompt. Edit it in Settings to say what a review should actually do.',
      'Read the diff, then leave your findings as pending inline comments rather than submitting.',
    ].join('\n'),
  },
  {
    id:    'fix-issue',
    label: 'Fix an issue',
    help:  'Queued when a workspace is started for an issue rather than for a pull request.',
    text:  [
      'Fix issue #{{issue}} in {{repo}}.',
      '',
      'This is a placeholder prompt. Edit it in Settings to say what fixing an issue should involve:',
      'reproducing it first, what counts as verified, and whether to open a pull request at the end.',
    ].join('\n'),
  },
  {
    id:    'fix-dependabot',
    label: 'Fix a Dependabot alert',
    help:  'Queued by Start fix on a Dependabot alert. One advisory can raise several alerts, so the prompt is about the advisory rather than about one of them.',
    text:  [
      'Resolve the Dependabot advisory {{ghsa}} ({{cve}}) in {{repo}}: "{{title}}".',
      '',
      'It affects {{package}}, across {{files}} file(s). The fix is {{fix}}.',
      '',
      'This is a placeholder prompt. Edit it in Settings to say what resolving one should involve:',
      'whether to bump a direct dependency or a resolution, and what to check before opening a PR.',
    ].join('\n'),
  },
];

/** Fill a prompt in. An unknown placeholder is left alone rather than replaced with 'undefined'. */
export function fillPrompt(text: string, values: Record<string, string>): string {
  return text.replace(/{{(\w+)}}/g, (whole, key) => (key in values ? values[key] : whole));
}
