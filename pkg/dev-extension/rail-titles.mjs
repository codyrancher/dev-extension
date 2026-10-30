/**
 * Section titles that carry a count, with the count marked so it can be coloured.
 *
 * `Your threads (5 answered, 0 waiting on the developer)` is a sentence with two numbers in it,
 * and the numbers are the whole reason the line is there - the words around them are the same
 * every time. So a title comes as both: the plain string, which is what the section is keyed
 * and labelled by everywhere else, and the pieces, which is what the strip draws.
 *
 * Its own module, with nothing imported, so a test can hold the two to each other: the pieces
 * joined must be exactly the string, or the strip and the modal header start saying different
 * things about the same section.
 *
 * @typedef {{ text: string, tone?: 'good' | 'warn' }} TitlePart
 * @typedef {{ title: string, parts: TitlePart[] }} CountedTitle
 */

/** The plain string a set of pieces spells. */
export function titleOf(parts) {
  return (parts || []).map((part) => part.text).join('');
}

/**
 * `Your threads (N answered, M waiting on the developer)`.
 *
 * A zero is drawn plain. The colour is there to say what wants doing, and "0 waiting" in the
 * colour of something that wants doing says the opposite of what is true; the same goes for a
 * green nought. So a tone marks a count that is actually there.
 *
 * @param {number} answered
 * @param {number} waiting
 * @returns {CountedTitle}
 */
export function threadsTitle(answered, waiting) {
  const parts = [
    { text: 'Your threads (' },
    ...(answered ? [{ text: String(answered), tone: 'good' }] : [{ text: '0' }]),
    { text: ' answered, ' },
    ...(waiting ? [{ text: String(waiting), tone: 'warn' }] : [{ text: '0' }]),
    { text: ' waiting on the developer)' },
  ];

  return { title: titleOf(parts), parts };
}
