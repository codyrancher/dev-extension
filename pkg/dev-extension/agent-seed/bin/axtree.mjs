// Chromium's computed accessibility tree, over CDP.
//
// This is what the browser hands to assistive technology, which makes it
// better evidence than a DOM linter for anything ARIA-shaped: a relation whose
// IDREF does not resolve is simply absent here, a name that never resolved
// comes out empty, and a role you thought you set shows up as whatever
// Chromium actually mapped it to. Before/after dumps of the same page are the
// cheapest proof an accessibility fix does something.
//
// Nothing to install — CDP is already there. The AT-SPI tooling in the browser
// sidecar (`a11y tree`) is the higher-fidelity version of the same idea, and
// tests the ATK bridge on top.
//
// Usage:
//   node /workspace/axtree.mjs [--url SUBSTR] [--role ROLE] [--grep TEXT]
//                              [--relations] [--json] [--save FILE] [--depth N]
//
//   --url        pick the page whose URL contains this (default: the first page)
//   --role       only nodes with this role (substring, case folded)
//   --grep       only nodes whose name contains this
//   --relations  show controls / labelledby / describedby / owns / flowto targets
//   --depth      how deep to print (default: unlimited)
//   --json       machine-readable, for diffing two runs
//   --save FILE  also write the output to FILE
import fs from 'fs'
import { chromium } from 'playwright-core'

const argv = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${ name }`)

  return i === -1 ? fallback : (argv[i + 1] ?? true)
}
const has = name => argv.includes(`--${ name }`)

const opts = {
  url:       flag('url'),
  role:      flag('role'),
  grep:      flag('grep'),
  depth:     Number(flag('depth', Infinity)),
  relations: has('relations'),
  json:      has('json'),
  save:      flag('save'),
};

// The relation properties worth seeing. `controls` is first because a broken
// aria-controls is the common finding and the one that vanishes silently.
const RELATIONS = ['controls', 'labelledby', 'describedby', 'owns', 'flowto', 'activedescendant', 'details', 'errormessage'];
// State-ish properties that change what gets announced.
const STATES = ['selected', 'checked', 'expanded', 'pressed', 'disabled', 'focused', 'level', 'hasPopup', 'invalid', 'live'];

const cdp = process.env.CLAUDE_BROWSER_CDP || 'http://localhost:9222';
const browser = await chromium.connectOverCDP(cdp);
const pages = browser.contexts().flatMap(c => c.pages());

if (!pages.length) {
  console.error('No pages open in the browser sidecar.');
  process.exit(1);
}

const page = opts.url ? pages.find(p => p.url().includes(opts.url)) : pages[0];

if (!page) {
  console.error(`No page matching "${ opts.url }". Open pages:\n  ${ pages.map(p => p.url()).join('\n  ') }`);
  process.exit(1);
}

const client = await page.context().newCDPSession(page);

await client.send('Accessibility.enable');

const { nodes } = await client.send('Accessibility.getFullAXTree');
const byId = new Map(nodes.map(n => [n.nodeId, n]));

const label = (node) => {
  const role = node.role?.value || '?';
  const name = node.name?.value || '';

  return `${ role }${ name ? ` "${ name }"` : '' }`;
};

const propsOf = (node) => {
  const out = {};

  for (const prop of node.properties || []) {
    if (RELATIONS.includes(prop.name) && opts.relations) {
      // relatedNodes is what makes the relation real. An `aria-controls` whose
      // target does not exist leaves the property off the node entirely, so an
      // empty list here and a missing key are both findings.
      out[prop.name] = (prop.value?.relatedNodes || []).map((r) => {
        const target = byId.get(r.backendDOMNodeId) || null;

        return target ? label(target) : (r.text || r.idref || '?');
      });
      // A state Chromium reports as off is noise — and it reports some of them
      // as the string "false" rather than the boolean.
    } else if (STATES.includes(prop.name) && prop.value?.value !== undefined
               && prop.value.value !== false && prop.value.value !== 'false') {
      out[prop.name] = prop.value.value;
    }
  }

  return out;
};

const roots = nodes.filter(n => !n.parentId || !byId.has(n.parentId));
const collected = [];

const walk = (node, depth) => {
  if (node.ignored) {
    // An ignored node still has children worth walking.
    for (const id of node.childIds || []) {
      const child = byId.get(id);

      if (child) {
        walk(child, depth);
      }
    }

    return;
  }

  const role = node.role?.value || '';
  const name = node.name?.value || '';
  const roleOk = !opts.role || role.toLowerCase().includes(String(opts.role).toLowerCase());
  const nameOk = !opts.grep || name.toLowerCase().includes(String(opts.grep).toLowerCase());

  if (roleOk && nameOk) {
    collected.push({
      depth, role, name, ...propsOf(node)
    });
  }

  if (depth >= opts.depth) {
    return;
  }

  for (const id of node.childIds || []) {
    const child = byId.get(id);

    if (child) {
      walk(child, depth + 1);
    }
  }
};

for (const root of roots) {
  walk(root, 0);
}

let output;

if (opts.json) {
  output = JSON.stringify(collected, null, 2);
} else {
  output = collected.map(({
    depth, role, name, ...rest
  }) => {
    const indent = '  '.repeat(opts.role || opts.grep ? 0 : depth);
    const extra = Object.entries(rest).map(([k, v]) => `${ k }: ${ JSON.stringify(v) }`).join('  ');

    return `${ indent }${ role }  "${ name }"${ extra ? `  ${ extra }` : '' }`;
  }).join('\n');
}

console.log(output || '(nothing matched)');

if (opts.save) {
  fs.writeFileSync(opts.save, `${ output }\n`);
  console.log(`\nsaved to ${ opts.save }`);
}

console.log(`\n${ collected.length } nodes from ${ page.url() }`);

await client.detach();
await browser.close();
