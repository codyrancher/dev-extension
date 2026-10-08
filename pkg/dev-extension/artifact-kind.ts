// What a file in a workspace's artifacts is, for deciding how to draw it: which thumbnail it
// gets in the list, which preview it opens into, and whether it can be edited as text. Decided
// from the name, because the list is drawn before any file has been read; a name that says
// nothing is taken for text and corrected by `looksBinary` once its first bytes are in.
import { languageFor } from './highlight';

export type ArtifactKind = 'image' | 'video' | 'audio' | 'pdf' | 'markdown' | 'html' | 'code' | 'text' | 'binary';

const IMAGE = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'];
const VIDEO = ['mp4', 'webm', 'mov', 'mkv'];
const AUDIO = ['mp3', 'wav', 'ogg', 'm4a', 'flac'];
const MARKDOWN = ['md', 'markdown', 'mdx'];
const HTML = ['html', 'htm'];
/** Text with no language to highlight it in: read as it is. */
const PLAIN = ['txt', 'log', 'out', 'err', 'csv', 'tsv', 'lock', 'env', 'keep', 'gitignore', 'ndjson', 'jsonl'];
/** Structured text highlight.js has no alias for, and the language each is closest to. */
const CODE_AS: Record<string, string> = {
  map: 'json', har: 'json', jsonc: 'json', json5: 'json', vue: 'xml', xml: 'xml', svg: 'xml',
};
/** What nobody reads as text. Named so a font is not fetched and decoded to find that out. */
const BINARY = [
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'zip', 'gz', 'tgz', 'tar', 'bz2', 'xz', '7z', 'rar', 'bin', 'exe', 'dll', 'so', 'dylib',
  'wasm', 'class', 'jar', 'pyc', 'o', 'a', 'node', 'db', 'sqlite', 'sqlite3', 'heic', 'tif', 'tiff', 'psd', 'trace', 'pcap', 'dmg', 'iso',
];

/** The extension, lower-cased; '' for a name without one (`Makefile`, `.keep` is `keep`). */
export function extensionOf(name: string): string {
  const base = (name || '').split('/').pop() || '';
  const dot = base.lastIndexOf('.');

  return dot === -1 ? '' : base.slice(dot + 1).toLowerCase();
}

export function artifactKind(name: string): ArtifactKind {
  const ext = extensionOf(name);

  if (IMAGE.includes(ext)) {
    return 'image';
  }
  if (VIDEO.includes(ext)) {
    return 'video';
  }
  if (AUDIO.includes(ext)) {
    return 'audio';
  }
  if (ext === 'pdf') {
    return 'pdf';
  }
  if (MARKDOWN.includes(ext)) {
    return 'markdown';
  }
  if (HTML.includes(ext)) {
    return 'html';
  }
  if (BINARY.includes(ext)) {
    return 'binary';
  }
  if (PLAIN.includes(ext)) {
    return 'text';
  }

  return artifactLanguage(name) ? 'code' : 'text';
}

/** Whether a kind is read, and so edited, as text. */
export function isTextKind(kind: ArtifactKind): boolean {
  return kind === 'markdown' || kind === 'html' || kind === 'code' || kind === 'text';
}

/** The highlight.js language a file is shown in; '' when it is plain. */
export function artifactLanguage(name: string): string {
  const ext = extensionOf(name);

  if (PLAIN.includes(ext)) {
    return '';
  }

  return CODE_AS[ext] || languageFor(name);
}

/**
 * The mode CodeMirror edits a file in. The dashboard's build of it carries two, YAML and
 * JavaScript (which is also its JSON and TypeScript); everything else is edited as plain text,
 * which is `null` rather than a name it would have to guess at.
 */
export function editorMode(name: string): string | Record<string, unknown> | null {
  const ext = extensionOf(name);

  if (['yaml', 'yml'].includes(ext)) {
    return 'yaml';
  }
  if (['json', 'map', 'har', 'jsonc', 'json5'].includes(ext)) {
    return { name: 'javascript', json: true };
  }
  if (['ts', 'mts', 'cts', 'tsx'].includes(ext)) {
    return { name: 'javascript', typescript: true };
  }

  return ['js', 'mjs', 'cjs', 'jsx'].includes(ext) ? 'javascript' : null;
}

/** What a tile calls a file when it cannot show it: its extension, or `FILE`. */
export function artifactBadge(name: string): string {
  return (extensionOf(name) || 'file').slice(0, 5).toUpperCase();
}

/**
 * Whether bytes are something other than text: a NUL anywhere, or more control characters than
 * prose and source ever hold. For a file whose name did not say - the first bytes do.
 */
export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 4096);
  let odd = 0;

  for (let i = 0; i < n; i++) {
    const b = bytes[i];

    if (b === 0) {
      return true;
    }
    if (b < 7 || (b > 13 && b < 32 && b !== 27)) {
      odd++;
    }
  }

  return n > 0 && odd / n > 0.1;
}

export function sizeDisplay(size: number): string {
  if (!size) {
    return '';
  }
  if (size < 1024) {
    return `${ size } B`;
  }

  return size < 1024 * 1024 ? `${ Math.round(size / 1024) } KB` : `${ (size / 1024 / 1024).toFixed(1) } MB`;
}
