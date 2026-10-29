// Which conversation a prompt goes to, when an action on the stage sends one.
//
// This has been wrong three times and each time it looked like the button doing nothing. The
// current one, measured on PR 19729: "Review the new commits" had delivered its prompt into SIX
// `Discuss` threads about single lines of one file, because the raw conversation list holds
// those too and they are newer than the review nearly by definition - so the page's idea of
// "the current conversation", refreshed from the end of that list on every poll, was a thread
// nobody could see. The strip hides discussions; the sender did not.
//
// So the rule is written down here, in one place, with the cases that have actually gone wrong
// pinned by tests - see tests/conversation-pick.test.mjs.
//
// Pure JavaScript and no imports, so `node --test` loads it directly.

/** A conversation named for work this stage is about: a review, a fix, this PR's number. */
const ABOUT = /^(Fix|Review|Feedback|Improve|CI) /;

/**
 * The conversation to send to, or null when there is none to send to.
 *
 * In the order a person would expect:
 *
 *   1. The tab on show. That is what "put it in the conversation" means when there is one in
 *      front of you, and it is the only one of these the person can see and change.
 *   2. The one the action is about - the review, the fix, the conversation named for this PR.
 *      The "original conversation" to go back to when nothing is open.
 *   3. The newest of what is left, which is the fallback this always had.
 *
 * `list` must already be this workspace's own; a discussion is not a candidate at any step. The
 * caller filters, because whose a conversation is depends on the workspace and this does not
 * need to know it.
 *
 * @param {{id: string, title?: string}[]} list The workspace's own conversations, oldest first.
 * @param {{focused?: string, current?: string, pr?: number}} where
 * @returns {object|null}
 */
export function pickConversation(list, { focused = '', current = '', pr = 0 } = {}) {
  const own = (list || []).filter((c) => c && c.id);

  if (!own.length) {
    return null;
  }

  const onShow = own.find((c) => c.id === focused) || own.find((c) => c.id === current);

  if (onShow) {
    return onShow;
  }

  const about = own.filter((c) => ABOUT.test(c.title || '') || (pr && String(c.title || '').includes(`#${ pr }`)));

  return about[about.length - 1] || own[own.length - 1];
}

/**
 * Whether a conversation is a discussion opened under something rather than one of the
 * workspace's own.
 *
 * Matched on the title because that is what survives a reload: which discussions a page opened
 * is the page's own memory, and a second tab - or this one after a refresh - knows nothing
 * about them.
 */
export function isDiscussion(title) {
  return /^Discuss\b/.test(String(title || ''));
}
