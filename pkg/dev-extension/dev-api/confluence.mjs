/**
 * What an agent asks Confluence, made into what it can read.
 *
 * The docs are on confluence.suse.com, a Confluence *Server* whose personal access token is a
 * bearer token, the way jira.suse.com's is. dev-api holds it and makes the calls, so an agent asks
 * `$CLAUDE_HARNESS_API/confluence/...` and the token never reaches a workspace.
 *
 * Plain functions with no imports, because scripts/gen-dev-api.mjs inlines this into server.mjs;
 * tests/confluence.test.mjs holds them.
 */

/** A search's results per call, unless asked for fewer. Enough to choose from, few enough to read. */
export const CONFLUENCE_LIMIT = 10;
export const CONFLUENCE_LIMIT_MAX = 50;

/** A page longer than this is cut, and says so: an agent's context is the thing being spent. */
export const PAGE_TEXT_MAX = 200_000;

/** A space key as Confluence spells one. */
const SPACE_KEY = /^[A-Za-z0-9~_-]{1,255}$/;

function quoted(text) {
  return `"${ String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"') }"`;
}

/**
 * The CQL for a search, or '' when there is nothing to search for.
 *
 * Words are quoted rather than spliced, so a query cannot close the string and add clauses of
 * its own. `cql` is passed through as it is, for whoever needs more than words and a space.
 *
 * @param {URLSearchParams} params `q`, `space`, `type` or `cql`.
 * @returns {string} The CQL.
 */
export function searchCql(params) {
  const raw = String(params.get('cql') || '').trim();

  if (raw) {
    return raw;
  }
  const words = String(params.get('q') || '').trim();

  if (!words) {
    return '';
  }
  const space = String(params.get('space') || '').trim();
  const type = params.get('type') === 'blogpost' ? 'blogpost' : 'page';

  return [
    `text ~ ${ quoted(words) }`,
    `type = ${ type }`,
    ...(SPACE_KEY.test(space) ? [`space = ${ quoted(space) }`] : []),
  ].join(' AND ');
}

/** How many to ask for: the default, or what was asked within bounds. */
export function searchLimit(params) {
  const asked = Number.parseInt(params.get('limit') || '', 10);

  return Number.isFinite(asked) && asked > 0 ? Math.min(asked, CONFLUENCE_LIMIT_MAX) : CONFLUENCE_LIMIT;
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
};

function decode(text) {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, name) => {
    if (name[0] === '#') {
      const code = name[1].toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);

      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : all;
    }

    return ENTITIES[name.toLowerCase()] ?? all;
  });
}

/**
 * A page's rendered HTML as text an agent can read: headings marked, list items dashed, table
 * cells split, code kept on its own lines, and everything else just its words.
 *
 * @param {string} html Confluence's `body.view`.
 * @returns {string} The text.
 */
export function pageText(html) {
  return decode(String(html || '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<h([1-6])\b[^>]*>/gi, (all, level) => `\n\n${ '#'.repeat(Number(level)) } `)
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<pre\b[^>]*>/gi, '\n```\n')
    .replace(/<\/pre>/gi, '\n```\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|table|ul|ol|blockquote|section)>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** One search result, as much of it as is worth reading in a list. */
export function searchResult(item, base) {
  return {
    id:      String(item?.id || ''),
    title:   String(item?.title || ''),
    space:   String(item?.space?.key || ''),
    updated: String(item?.version?.when || ''),
    url:     item?._links?.webui ? `${ base }${ item._links.webui }` : '',
  };
}

/** One page, read: its place, its version, and its text, cut where it has to be. */
export function pageAnswer(page, base) {
  const text = pageText(page?.body?.view?.value);

  return {
    ...searchResult(page, base),
    version:   Number(page?.version?.number || 0),
    ancestors: (page?.ancestors || []).map((a) => String(a?.title || '')).filter(Boolean),
    text:      text.slice(0, PAGE_TEXT_MAX),
    truncated: text.length > PAGE_TEXT_MAX,
  };
}
