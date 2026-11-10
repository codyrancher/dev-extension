import { htmlToMarkdown } from './markdown';
import { extractImageId, imagePath, imageSrc } from '../api';

const MIME_EXTENSIONS: Record<string, string> = { 'image/jpeg': 'jpg', 'image/svg+xml': 'svg' };

// The full-size image if there is one, else the thumbnail
async function fetchImageBlob(id: string): Promise<Blob | null> {
  for (const src of [imagePath(id), imagePath(id, true)]) {
    try {
      const res = await fetch(imageSrc(src));

      if (res.ok) {
        return res.blob();
      }
    } catch { /* try the thumbnail */ }
  }

  return null;
}

// Decode an inline data: URI (e.g. a pasted image) into a Blob
function dataUriToBlob(uri: string): Blob | null {
  const match = uri.match(/^data:([^;,]*)(;base64)?,(.*)$/s);

  if (!match) {
    return null;
  }
  const [, type, isBase64, data] = match;

  if (!isBase64) {
    return new Blob([decodeURIComponent(data)], { type });
  }
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return new Blob([bytes], { type });
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');

  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// Download a note as Markdown. Notes with images become a zip of the .md plus
// a media/ folder, with images referenced by relative path.
export async function downloadNoteMarkdown(title: string, html: string) {
  const baseName = (title.trim() || 'Untitled').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 100);
  const div = document.createElement('div');

  div.innerHTML = html;

  const media: Record<string, Uint8Array> = {};
  const pathsBySrc = new Map<string, string | null>();
  let inlineCount = 0;

  for (const img of Array.from(div.querySelectorAll('img'))) {
    const src = img.getAttribute('src') || '';

    if (!pathsBySrc.has(src)) {
      // Server-hosted images are named by id; inline (pasted) ones are numbered
      const id = extractImageId(src);
      let name: string | null = null;
      let blob: Blob | null = null;

      if (id) {
        name = id;
        blob = await fetchImageBlob(id);
      } else if (src.startsWith('data:')) {
        name = `image-${ ++inlineCount }`;
        blob = dataUriToBlob(src);
      }
      let path: string | null = null;

      if (name && blob) {
        const ext = MIME_EXTENSIONS[blob.type] || blob.type.split('/')[1]?.split('+')[0] || 'bin';

        path = `media/${ name }.${ ext }`;
        media[path] = new Uint8Array(await blob.arrayBuffer());
      }
      pathsBySrc.set(src, path);
    }
    const path = pathsBySrc.get(src);

    if (path) {
      img.setAttribute('src', path);
    }
  }

  const markdown = htmlToMarkdown(div.innerHTML);

  if (Object.keys(media).length === 0) {
    triggerDownload(new Blob([markdown], { type: 'text/markdown' }), `${ baseName }.md`);

    return;
  }
  const { zipSync, strToU8 } = await import(/* webpackChunkName: "strata" */ 'fflate');
  const zip = zipSync({ [`${ baseName }.md`]: strToU8(markdown), ...media }, { level: 0 });

  triggerDownload(new Blob([zip], { type: 'application/zip' }), `${ baseName }.zip`);
}
