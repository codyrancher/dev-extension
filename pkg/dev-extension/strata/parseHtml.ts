/**
 * Stored note HTML as an element to walk, in a document of its own.
 *
 * Not a detached div's innerHTML: Chrome starts fetching every <img> in that the moment it is
 * parsed, and a stored note's pictures are `/api/images/...` paths that only mean something once
 * imageSrc has pointed them at dev-api - each card, copy, download and label tree asked Rancher
 * for them and logged a 404. A DOMParser document is inert: nothing in it loads.
 */
export function parseNoteHtml(html: string): HTMLElement {
  return new DOMParser().parseFromString(html, 'text/html').body;
}
