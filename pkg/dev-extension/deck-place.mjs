/**
 * Where the reader is after the Focus deck has changed under them.
 *
 * The deck is a ranked list and the place in it was an index, so anything that left or arrived
 * above the card on top moved the reader onto a different card without a turn. A card handed to an
 * agent that went a moment after somebody had moved past it took the next card with it; an agent
 * finishing put its card back above the reader and stepped them back one. The place is the card
 * now: the same card wherever it has gone, or - when it is the card that went - the first of the
 * ones after it that is still there, which is what being dealt off looks like.
 *
 * @param {{ key: string }[]} before the deck as it was
 * @param {{ key: string }[]} now    the deck as it is
 * @param {number} index             where the reader was in `before`
 * @returns {{ index: number, left: boolean }} where they are in `now`, and whether their card went
 */
export function holdPlace(before, now, index) {
  const last = Math.max(0, now.length - 1);
  const was = before[index];

  if (!was) {
    return { index: Math.min(Math.max(0, index), last), left: false };
  }

  const at = now.findIndex((task) => task.key === was.key);

  if (at >= 0) {
    return { index: at, left: false };
  }
  for (let i = index + 1; i < before.length; i += 1) {
    const next = now.findIndex((task) => task.key === before[i].key);

    if (next >= 0) {
      return { index: next, left: true };
    }
  }

  // Nothing after it is left: the end of the deck, as `settle` has always put it.
  return { index: last, left: true };
}
