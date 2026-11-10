/**
 * Strata's REST calls, made to dev-api's `/strata` routes instead of Strata's own server.
 *
 * The same calls and the same shapes as Strata's services/api.ts, minus its sign-in: dev-api is
 * reached through the apiserver's proxy on the dashboard's own session, so there is no token to
 * carry and no 401 to retry.
 */
import { devFetch } from '../api';
import { devApiUrl } from '../reviews';

export interface Note {
  id: string;
  title: string;
  content: string;
  created_at: string;
  updated_at: string;
  deleted: number;
  sort_order: number;
  pinned: number;
  pin_order: number;
  label_ids: string[];
}

export interface Label {
  id: string;
  name: string;
  color: string;
  parent_id: string | null;
  pinned: number;
  pin_order: number;
  created_at: string;
}

export interface LineLabel {
  id: string;
  note_id: string;
  line_key: string;
  label_id: string;
  line_text: string;
  line_number: number;
  note_title?: string;
}

export interface UploadedImage {
  id: string;
  filename: string;
  width: number;
  height: number;
}

/**
 * Where images live in a note's HTML: Strata's own path, so a note reads the same here as it did
 * there. imageSrc() turns it into an address the browser can load.
 */
export const IMAGE_PATH = '/api/images/';

function call<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  return devFetch(devApiUrl(`/strata${ path }`), {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    timeoutMs: 60_000,
  }) as Promise<T>;
}

const enc = encodeURIComponent;

export const api = {
  getNotes:   () => call<Note[]>('/notes'),
  getNote:    (id: string) => call<Note>(`/notes/${ enc(id) }`),
  createNote: (data: Partial<Note>) => call<Note>('/notes', 'POST', data),
  updateNote: (id: string, data: Partial<Note>) => call<Note>(`/notes/${ enc(id) }`, 'PUT', data),
  deleteNote: (id: string) => call<void>(`/notes/${ enc(id) }`, 'DELETE'),
  restoreNote: (id: string) => call<Note>(`/notes/${ enc(id) }/restore`, 'POST', {}),

  getLabels:   () => call<Label[]>('/labels'),
  createLabel: (data: Partial<Label>) => call<Label>('/labels', 'POST', data),
  updateLabel: (id: string, data: Partial<Label>) => call<Label>(`/labels/${ enc(id) }`, 'PUT', data),
  deleteLabel: (id: string) => call<void>(`/labels/${ enc(id) }`, 'DELETE'),

  addNoteLabel:    (noteId: string, labelId: string) => call<unknown>(`/notes/${ enc(noteId) }/labels`, 'POST', { label_id: labelId }),
  removeNoteLabel: (noteId: string, labelId: string) => call<void>(`/notes/${ enc(noteId) }/labels/${ enc(labelId) }`, 'DELETE'),

  getLineLabels: (noteId: string) => call<LineLabel[]>(`/notes/${ enc(noteId) }/line-labels`),
  addLineLabel:  (noteId: string, lineKey: string, labelId: string, lineText = '', lineNumber = 0) => call<LineLabel>(
    `/notes/${ enc(noteId) }/line-labels`, 'POST', {
      line_key: lineKey, label_id: labelId, line_text: lineText, line_number: lineNumber
    }),
  removeLineLabel:      (id: string) => call<void>(`/line-labels/${ enc(id) }`, 'DELETE'),
  getLineLabelsByLabel: (labelId: string) => call<LineLabel[]>(`/labels/${ enc(labelId) }/line-labels`),

  uploadImage: (noteId: string, image: { filename: string; mimetype: string; data: string; thumbnail: string; width: number; height: number }) => call<UploadedImage>(`/notes/${ enc(noteId) }/images`, 'POST', image),
  deleteImage: (id: string) => call<void>(`/images/${ enc(id) }`, 'DELETE'),

  search: (q?: string, labels?: string) => {
    const params = new URLSearchParams();

    if (q) {
      params.set('q', q);
    }
    if (labels) {
      params.set('labels', labels);
    }

    return call<Note[]>(`/search?${ params }`);
  },
};

/** The path a note's HTML holds for an image, or its thumbnail. */
export function imagePath(id: string, thumbnail = false): string {
  return `${ IMAGE_PATH }${ id }${ thumbnail ? '/thumbnail' : '' }`;
}

/** An image id out of a src in a note, or null when the src is not one of ours. */
export function extractImageId(src: string): string | null {
  const match = /\/(?:api|strata)\/images\/([^/?"]+)/.exec(src || '');

  return match ? match[1] : null;
}

/** A src from a note's HTML as the browser can load it: ours go to dev-api, anything else is left. */
export function imageSrc(src: string): string {
  if (!src?.startsWith(IMAGE_PATH)) {
    return src;
  }

  return devApiUrl(`/strata/images/${ src.slice(IMAGE_PATH.length) }`);
}

/**
 * A note's HTML as it is kept: any image address the editor rendered for the browser turned back
 * into Strata's own path, so the stored note does not depend on where dev-api is reached.
 */
export function storedHtml(html: string): string {
  return html.split(devApiUrl('/strata/images/')).join(IMAGE_PATH);
}
