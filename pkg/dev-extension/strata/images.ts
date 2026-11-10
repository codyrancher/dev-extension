/**
 * A picture file as dev-api keeps it: the bytes, a 200px thumbnail and the size, all made here.
 *
 * Strata's server made the thumbnail with sharp; dev-api has no packages, so the page draws it.
 * Cover-cropped to a 200x200 square and saved as JPEG at 80%, which is what sharp was asked for.
 */
const THUMB = 200;

function toBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let text = '';

  for (let i = 0; i < view.length; i += 0x8000) {
    text += String.fromCharCode(...view.subarray(i, i + 0x8000));
  }

  return btoa(text);
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();

    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('That file could not be read as a picture.'));
    img.src = url;
  });
}

export interface PreparedImage {
  filename: string;
  mimetype: string;
  data: string;
  thumbnail: string;
  width: number;
  height: number;
}

export async function prepareImage(file: File): Promise<PreparedImage> {
  const url = URL.createObjectURL(file);

  try {
    const img = await loadImage(url);
    const width = img.naturalWidth;
    const height = img.naturalHeight;
    const canvas = document.createElement('canvas');

    canvas.width = THUMB;
    canvas.height = THUMB;
    const ctx = canvas.getContext('2d');
    let thumbnail = '';

    if (ctx && width && height) {
      const scale = Math.max(THUMB / width, THUMB / height);
      const w = width * scale;
      const h = height * scale;

      ctx.drawImage(img, (THUMB - w) / 2, (THUMB - h) / 2, w, h);
      thumbnail = canvas.toDataURL('image/jpeg', 0.8).split(',')[1] || '';
    }

    return {
      filename: file.name || 'image',
      mimetype: file.type || 'image/png',
      data:     toBase64(await file.arrayBuffer()),
      thumbnail,
      width,
      height,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}
