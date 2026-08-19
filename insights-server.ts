/**
 * The server behind Insights: one SQLite database per person, written by their agents and read
 * by their Insights page.
 *
 * Kept here as text rather than as a file, for the reason the workspace's vue.config.js is (see
 * workspace-config.ts): it has to end up inside a container this code only ever talks to through
 * the Kubernetes API, so it travels as a ConfigMap.
 *
 * It is plain `node:24` and nothing else. Node has had a SQLite driver in core since 22.5
 * (`node:sqlite`), so there is no image to build, no dependency to install and nothing that can
 * be older than this file. That is the same trade every other container in this product makes.
 *
 * The API is the harness's, because the agents that will write to it already know that shape:
 *
 *   POST /api/insights/<table>   a JSON object, one row
 *   GET  /api/tables             every table, with its row count and columns
 *   POST /api/query              { sql } -> { columns, rows }
 *
 * Schema on write. An agent that posts `{"project":"x","tool":"jq"}` to `/api/insights/missing-tool`
 * creates `missing_tools` if it is not there and adds a column for a key it has not seen before.
 * That is what makes it usable from a shell script in a workspace without anyone declaring a
 * schema first, and it is the only way a table like `queued_actions` comes to exist at all.
 */
export const INSIGHTS_SERVER = `// Written by the Dev extension. See pkg/dev-extension/insights-server.ts.
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';

const PORT = Number(process.env.PORT || 8080);
const FILE = process.env.INSIGHTS_DB || '/data/insights.db';

const db = new DatabaseSync(FILE);

// Every write is one row and every read is one query, so the durability that matters is "it is
// there after the pod restarts" rather than throughput. WAL is what gives that without the
// synchronous cost of the default journal.
db.exec('PRAGMA journal_mode = WAL');

/**
 * Table and column names, made safe by construction rather than by escaping.
 *
 * These arrive from the body of a POST, so they are the one thing here that a caller controls
 * and that cannot be a bound parameter: SQLite has no placeholder for an identifier. Anything
 * outside this alphabet is replaced, so the worst a caller can do is create a table with a dull
 * name.
 */
function identifier(value, fallback) {
  const cleaned = String(value || '').toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+/, '');

  return cleaned || fallback;
}

function tableNames() {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);
}

function columnsOf(table) {
  return db.prepare(\`PRAGMA table_info("\${ table }")\`).all().map((row) => row.name);
}

/**
 * Add the row, and the table and columns it implies.
 *
 * Values are bound; only the names are interpolated, and only after identifier() has been over
 * them. Everything is TEXT apart from the id: a value that arrives as a number today and as a
 * string tomorrow is an ordinary thing for an agent to send, and a column that changes type
 * under it would be an insert that fails for a reason nobody could act on.
 */
function insert(table, row) {
  const name = identifier(table, 'rows');
  const keys = Object.keys(row).map((key) => identifier(key, 'value')).filter((key) => key !== 'id');

  if (!tableNames().includes(name)) {
    db.exec(\`CREATE TABLE "\${ name }" (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL)\`);
  }

  const existing = columnsOf(name);

  for (const key of keys) {
    if (!existing.includes(key)) {
      db.exec(\`ALTER TABLE "\${ name }" ADD COLUMN "\${ key }" TEXT\`);
    }
  }

  const columns = ['created_at', ...keys];
  const values = [new Date().toISOString(), ...keys.map((key, i) => {
    const value = row[Object.keys(row).filter((k) => identifier(k, 'value') !== 'id')[i]];

    // An object or an array is stored as the JSON it came as, rather than as [object Object].
    return value === null || value === undefined ? null
      : (typeof value === 'object' ? JSON.stringify(value) : String(value));
  })];

  const placeholders = columns.map(() => '?').join(', ');
  const quoted = columns.map((column) => \`"\${ column }"\`).join(', ');

  db.prepare(\`INSERT INTO "\${ name }" (\${ quoted }) VALUES (\${ placeholders })\`).run(...values);

  return { table: name };
}

/**
 * Run a query, and refuse anything that is not one.
 *
 * The page is a SQL box, so this is the whole of its API, and read-only is not a nicety: the
 * page is the only thing that calls it and it has nothing to write. A statement is allowed if it
 * starts with SELECT or WITH and contains no semicolon, which is what stops a second statement
 * being appended to a first that looked innocent.
 */
function query(sql) {
  const text = String(sql || '').trim().replace(/;\\s*$/, '');

  if (!/^(select|with)\\b/i.test(text)) {
    throw new Error('Only SELECT is allowed here.');
  }

  if (text.includes(';')) {
    throw new Error('One statement at a time.');
  }

  const rows = db.prepare(text).all();

  // The columns of the first row, which is what a table needs to draw a header. A query that
  // returns nothing has no columns to report, and the page says "no rows" rather than drawing an
  // empty table with no headings.
  return { columns: rows.length ? Object.keys(rows[0]) : [], rows };
}

function send(res, status, body) {
  const text = JSON.stringify(body);

  res.writeHead(status, {
    'content-type':                 'application/json',
    'content-length':               Buffer.byteLength(text),
    // The page is served from Rancher's origin and this is reached through the apiserver's
    // service proxy, so it is same-origin by the time a browser sees it. This is for the agents,
    // which are curl and do not care, and for anyone driving it from somewhere else.
    'access-control-allow-origin':  '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk;

      // A row is a handful of fields. Anything past this is a mistake or an attempt, and either
      // way it is not something to buffer.
      if (body.length > 1_000_000) {
        reject(new Error('That is too big to be a row.'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('The body is not JSON.'));
      }
    });
    req.on('error', reject);
  });
}

http.createServer(async(req, res) => {
  const url = new URL(req.url, 'http://insights');

  try {
    if (req.method === 'OPTIONS') {
      return send(res, 204, {});
    }

    if (req.method === 'GET' && url.pathname === '/api/tables') {
      return send(res, 200, {
        tables: tableNames().map((name) => ({
          name,
          columns: columnsOf(name),
          rows:    db.prepare(\`SELECT COUNT(*) AS n FROM "\${ name }"\`).get().n,
        })),
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/query') {
      const body = await readBody(req);

      return send(res, 200, query(body.sql));
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/insights/')) {
      const body = await readBody(req);
      // The harness posts to /api/insights/missing-tool and the table is missing_tools. The
      // pluralisation is the harness's own and it is kept, so a script written against one works
      // against the other.
      const singular = url.pathname.slice('/api/insights/'.length);
      const table = singular.endsWith('s') ? singular : \`\${ singular }s\`;

      return send(res, 200, insert(table, body));
    }

    // A liveness answer that is also the one-line description of what this is, for whoever
    // opens the address in a browser expecting a page.
    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, { insights: 'ok', file: FILE, tables: tableNames() });
    }

    return send(res, 404, { error: 'No such path.' });
  } catch (e) {
    return send(res, 400, { error: e.message });
  }
}).listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(\`[insights] \${ FILE } on :\${ PORT }\`);
});
`;
