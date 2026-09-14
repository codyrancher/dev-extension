#!/usr/bin/env node
// Measure one component's accessibility in the states a page-load scan never sees.
//
// Every finding in rancher/dashboard#19128 was invisible to an axe run at page load: the pin
// button only exists once the flyout is open, the grey subtitle only fails on a highlighted row,
// focus is only lost after an unpin removes the row, and dark mode is a different palette. axe
// also files contrast over a `color-mix(... transparent)` background as "incomplete" rather than
// a violation, which is how a 4.3:1 subtitle passes a scan. So this drives the component into a
// state, then measures it there, in each theme:
//
//   contrast   every visible text node, background alpha-composited up the ancestor chain, in
//              the resting state and with each --hover / --focus element really hovered/focused
//   nested     interactive content inside interactive content (a role="button" in a <button>)
//   relations  aria-controls / labelledby / describedby / owns / activedescendant that point at
//              nothing, and aria-haspopup whose value does not match what it controls
//   names      interactive elements with no accessible name
//   target     interactive targets under 24x24 CSS px (WCAG 2.2 2.5.8), inline text links excepted
//   focus      with --keys, where focus is after each key; landing on <body> is the finding
//   axe        axe-core scoped to the component, violations AND incomplete
//
// Usage:
//   node /workspace/.claude/skills/my-pr-review-a11y/a11y-probe.mjs \
//     --goto https://localhost:8005/dashboard/c/local/explorer \
//     --steps 'click:[data-testid="top-level-menu"]; wait:.cluster-switcher' \
//     --scope '.cluster-switcher' \
//     --hover '.cluster-switcher .row' --focus '.cluster-switcher button' \
//     --keys 'Tab,ArrowDown,ArrowDown,Enter' \
//     --themes light,dark --json /workspace/artifacts/review/a11y/switcher.json
//
//   --goto URL      open URL in a new tab (closed on exit); or --url SUBSTR to use an open tab
//   --steps LIST    ';'-separated, run in order to reach the state:
//                   click:SEL  hover:SEL  focus:SEL  key:KEY  type:TEXT  wait:SEL  sleep:MS
//   --scope SEL     the component under review (default: body)
//   --hover SEL     elements to hover (pointer + :hover) and re-measure inside (first 6 matches)
//   --focus SEL     elements to focus (+ :focus-visible) and check the focus indicator (first 6)
//   --keys LIST     ','-separated key presses to walk, after --steps (Tab, Shift+Tab, ArrowDown...)
//   --themes LIST   light,dark (default both); toggled on <body>, so your own preference is untouched
//   --only LIST     subset of checks: contrast,nested,relations,names,target,focus,axe
//   --json FILE     write every result, not just failures
//
// Exit code 0 always; the report is the output. A check that cannot decide (a background image,
// a gradient) says so rather than guessing, the same way axe reports "incomplete".
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { lookup } from 'node:dns/promises';

const args = parse(process.argv.slice(2));
const CHECKS = new Set((args.only || 'contrast,nested,relations,names,target,focus,axe').split(',').map((s) => s.trim()));
const THEMES = (args.themes || 'light,dark').split(',').map((s) => s.trim()).filter(Boolean);
const SCOPE = args.scope || 'body';
const AXE = ['/workspace/dashboard/node_modules/axe-core/axe.min.js', '/workspace/node_modules/axe-core/axe.min.js'].find((p) => existsSync(p));

function parse(argv) {
  const out = {};

  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    }
  }

  return out;
}

// Chromium's CDP refuses a Host header that is not localhost or an IP.
async function endpoint() {
  const url = new URL(process.env.CLAUDE_BROWSER_CDP || 'http://localhost:9222');

  if (url.hostname !== 'localhost' && !/^[0-9.]+$/.test(url.hostname)) {
    url.hostname = (await lookup(url.hostname)).address;
  }

  return url.toString();
}

const browser = await chromium.connectOverCDP(await endpoint());
const context = browser.contexts()[0] || await browser.newContext();
let page;
let opened = false;

if (args.goto) {
  page = await context.newPage();
  opened = true;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(args.goto, { waitUntil: 'domcontentloaded' });
} else {
  page = context.pages().find((p) => !args.url || p.url().includes(args.url));
  if (!page) {
    console.error(`No open tab matches --url ${ args.url || '(any)' }. Use --goto to open one.`);
    process.exit(1);
  }
}

const cdp = await context.newCDPSession(page);
const report = { url: '', scope: SCOPE, themes: {} };

async function runSteps(list) {
  for (const raw of (list || '').split(';').map((s) => s.trim()).filter(Boolean)) {
    const [verb, ...rest] = raw.split(':');
    const arg = rest.join(':').trim();

    if (verb === 'click') {
      await page.locator(arg).first().click();
    } else if (verb === 'hover') {
      await page.locator(arg).first().hover();
    } else if (verb === 'focus') {
      await page.locator(arg).first().focus();
    } else if (verb === 'key') {
      await page.keyboard.press(arg);
    } else if (verb === 'type') {
      await page.keyboard.type(arg);
    } else if (verb === 'wait') {
      await page.locator(arg).first().waitFor({ state: 'attached', timeout: 20000 });
    } else if (verb === 'sleep') {
      await page.waitForTimeout(Number(arg) || 500);
    } else {
      throw new Error(`Unknown step "${ raw }"`);
    }
    await page.waitForTimeout(150);
  }
}

async function setTheme(theme) {
  await page.evaluate((t) => {
    document.body.classList.remove('theme-light', 'theme-dark');
    document.body.classList.add(`theme-${ t }`);
  }, theme);
  await page.waitForTimeout(400);
}

// ── In-page measurement. One function, shipped to the page, so every check sees the same DOM. ──
const IN_PAGE = ({ scopeSel, only }) => {
  const scope = document.querySelector(scopeSel);

  if (!scope) {
    return { error: `--scope ${ scopeSel } matched nothing in this state` };
  }

  const canvas = document.createElement('canvas');

  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  // Any CSS colour the browser understands - rgb(), color(srgb ...), oklch(), color-mix() - as
  // sRGB bytes, by letting the canvas parse it. Computed styles come back in all of those forms.
  const rgba = (css) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;

    return {
      r, g, b, a: a / 255
    };
  };
  const over = (top, bottom) => {
    const a = top.a + bottom.a * (1 - top.a);

    if (!a) {
      return {
        r: 0, g: 0, b: 0, a: 0
      };
    }
    const mix = (k) => Math.round((top[k] * top.a + bottom[k] * bottom.a * (1 - top.a)) / a);

    return {
      r: mix('r'), g: mix('g'), b: mix('b'), a
    };
  };
  const lum = ({ r, g, b }) => {
    const c = (v) => {
      v /= 255;

      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };

    return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
  };
  const ratio = (x, y) => {
    const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p);

    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  };
  const hex = ({ r, g, b }) => `#${ [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('') }`;
  const describe = (el) => {
    if (!el || el === document.body) {
      return '<body>';
    }
    const id = el.id ? `#${ el.id }` : '';
    const cls = typeof el.className === 'string' && el.className.trim() ? `.${ el.className.trim().split(/\s+/).slice(0, 2).join('.') }` : '';
    const role = el.getAttribute('role') ? `[role=${ el.getAttribute('role') }]` : '';
    const text = (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);

    return `<${ el.tagName.toLowerCase() }${ id }${ cls }${ role }>${ text ? ` "${ text }"` : '' }`;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);

    return r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && cs.display !== 'none' && (el.checkVisibility ? el.checkVisibility({ opacityProperty: true }) : true);
  };
  const disabled = (el) => !!el.closest(':disabled, [aria-disabled="true"], .disabled');

  // The backdrop a text node actually sits on: every ancestor's background, composited from the
  // page up. A background image or gradient makes this undecidable, and says so.
  const backdrop = (el) => {
    const layers = [];
    let undecidable = '';

    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);

      if (cs.backgroundImage && cs.backgroundImage !== 'none') {
        undecidable = `background-image on ${ describe(n) }`;
      }
      const c = rgba(cs.backgroundColor);

      if (c.a > 0) {
        layers.push(c);
      }
      if (c.a >= 1) {
        break;
      }
    }
    let bg = {
      r: 255, g: 255, b: 255, a: 1
    };

    for (const layer of layers.reverse()) {
      bg = over(layer, bg);
    }

    return { bg, undecidable };
  };

  const out = {};
  const INTERACTIVE = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex]:not([tabindex="-1"]), [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="option"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="treeitem"], [role="combobox"], [role="slider"], [contenteditable="true"]';

  out.contrastIn = (root, label) => {
    const results = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (t) => (t.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) });
    const seen = new Set();

    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const el = t.parentElement;

      if (!el || seen.has(el) || !visible(el)) {
        continue;
      }
      seen.add(el);
      const cs = getComputedStyle(el);
      let fg = rgba(cs.color);
      let opacity = 1;

      for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
        opacity *= Number(getComputedStyle(n).opacity);
      }
      fg = { ...fg, a: fg.a * opacity };
      const { bg, undecidable } = backdrop(el);
      const effective = over(fg, bg);
      const size = parseFloat(cs.fontSize);
      const bold = Number(cs.fontWeight) >= 700;
      const large = size >= 24 || (size >= 18.66 && bold);
      const needs = large ? 3 : 4.5;
      const got = ratio(effective, bg);

      results.push({
        state: label, element: describe(el), text: t.textContent.replace(/\s+/g, ' ').trim().slice(0, 50), fg: hex(effective), bg: hex(bg), ratio: got, needs, large, disabled: disabled(el), undecidable, pass: disabled(el) || got >= needs,
      });
    }

    return results;
  };

  out.run = () => {
    const res = {};

    if (only.includes('contrast')) {
      res.contrast = out.contrastIn(scope, 'rest');
    }

    if (only.includes('nested')) {
      res.nested = [...scope.querySelectorAll(INTERACTIVE)].concat(scope.matches(INTERACTIVE) ? [scope] : [])
        .filter(visible)
        .map((el) => ({ el, inner: [...el.querySelectorAll(INTERACTIVE)].filter(visible) }))
        .filter((x) => x.inner.length)
        .map((x) => ({ outer: describe(x.el), inner: x.inner.slice(0, 4).map(describe) }));
    }

    if (only.includes('relations')) {
      const broken = [];
      const popup = [];

      for (const el of [scope, ...scope.querySelectorAll('*')]) {
        for (const attr of ['aria-controls', 'aria-labelledby', 'aria-describedby', 'aria-owns', 'aria-activedescendant', 'aria-errormessage']) {
          const v = el.getAttribute(attr);

          if (!v) {
            continue;
          }
          const missing = v.split(/\s+/).filter((id) => id && !document.getElementById(id));

          if (missing.length) {
            broken.push({ element: describe(el), attr, missing });
          }
        }
        const hp = el.getAttribute('aria-haspopup');

        if (hp && hp !== 'false') {
          const want = hp === 'true' ? 'menu' : hp;
          const ids = (el.getAttribute('aria-controls') || '').split(/\s+/).filter(Boolean);
          const targets = ids.map((id) => document.getElementById(id)).filter(Boolean);
          const roles = targets.map((t) => t.getAttribute('role') || t.tagName.toLowerCase());

          popup.push({
            element: describe(el), haspopup: hp, expanded: el.getAttribute('aria-expanded'), controls: ids, targetRoles: roles, match: targets.length ? roles.includes(want) : null,
          });
        }
      }
      res.relations = { broken, popup };
    }

    if (only.includes('target')) {
      res.target = [...scope.querySelectorAll(INTERACTIVE)].filter(visible).map((el) => {
        const r = el.getBoundingClientRect();
        const inlineLink = el.tagName === 'A' && getComputedStyle(el).display === 'inline' && el.parentElement && el.parentElement.textContent.trim().length > el.textContent.trim().length + 10;

        return {
          element: describe(el), width: Math.round(r.width), height: Math.round(r.height), pass: inlineLink || (r.width >= 24 && r.height >= 24), inlineLink
        };
      }).filter((x) => !x.pass);
    }

    return res;
  };

  return out.run();
};

// Accessible names from Chromium's own AX tree - the name an AT receives, not a guess at it.
async function unnamed() {
  const roles = ['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem', 'combobox', 'slider', 'textbox', 'searchbox', 'spinbutton', 'listbox', 'menu', 'dialog'];
  const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: SCOPE });

  if (!nodeId) {
    return { missing: [] };
  }
  const missing = [];

  for (const role of roles) {
    const { nodes } = await cdp.send('Accessibility.queryAXTree', { nodeId, role }).catch(() => ({ nodes: [] }));

    for (const n of nodes) {
      if (n.ignored || (n.name?.value || '').trim()) {
        continue;
      }
      const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: n.backendDOMNodeId }).catch(() => ({ object: null }));
      const html = object ? (await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function () { return this.outerHTML.slice(0, 160); }', returnByValue: true })).result.value : '';

      missing.push({ role, html });
    }
  }

  return { missing };
}

async function hoverAndFocus() {
  const found = [];

  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');

  for (const [kind, sel] of [['hover', args.hover], ['focus', args.focus]]) {
    if (!sel) {
      continue;
    }
    const count = Math.min(await page.locator(sel).count(), 6);

    for (let i = 0; i < count; i++) {
      const loc = page.locator(sel).nth(i);

      if (!(await loc.isVisible().catch(() => false))) {
        continue;
      }
      if (kind === 'hover') {
        await loc.hover().catch(() => {});
      } else {
        await loc.focus().catch(() => {});
      }
      const handle = await loc.elementHandle();

      // Force the pseudo-class as well: a rule on :hover or :focus-visible applies whether or
      // not the synthetic pointer or key event would have triggered it.
      let forcedOn = null;

      try {
        const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
        const marker = `a11y-probe-${ kind }-${ i }`;

        await handle.evaluate((e, m) => e.setAttribute('data-a11y-probe', m), marker);
        const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: `[data-a11y-probe="${ marker }"]` });

        await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: kind === 'hover' ? ['hover'] : ['focus', 'focus-visible'] });
        forcedOn = nodeId;
      } catch { /* the real hover/focus still applies */ }
      await page.waitForTimeout(250);

      const measured = await handle.evaluate((el, k) => {
        const canvas = document.createElement('canvas');

        canvas.width = canvas.height = 1;
        const c2d = canvas.getContext('2d', { willReadFrequently: true });
        const rgba = (css) => {
          c2d.clearRect(0, 0, 1, 1);
          c2d.fillStyle = '#000';
          c2d.fillStyle = css;
          c2d.fillRect(0, 0, 1, 1);
          const [r, g, b, a] = c2d.getImageData(0, 0, 1, 1).data;

          return {
            r, g, b, a: a / 255
          };
        };
        const cs = getComputedStyle(el);
        const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0 ? { color: cs.outlineColor, width: cs.outlineWidth } : null;
        const shadow = cs.boxShadow && cs.boxShadow !== 'none' ? cs.boxShadow : null;

        return {
          active:    el.matches(':focus'),
          indicator: k === 'focus' ? (outline || shadow ? { outline, shadow } : null) : undefined,
          outlineRgba: outline ? rgba(outline.color) : null,
        };
      }, kind);

      // Re-run the contrast walk inside this one element, in this state.
      const texts = await handle.evaluate((el) => window.__a11yProbeContrast(el));

      found.push({
        kind, selector: sel, index: i, element: await handle.evaluate((e) => `<${ e.tagName.toLowerCase() }${ e.className && typeof e.className === 'string' ? `.${ e.className.trim().split(/\s+/).slice(0, 2).join('.') }` : '' }> "${ (e.getAttribute('aria-label') || e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40) }"`), ...measured, contrast: texts,
      });

      if (forcedOn) {
        await cdp.send('CSS.forcePseudoState', { nodeId: forcedOn, forcedPseudoClasses: [] }).catch(() => {});
      }
      await handle.evaluate((e) => e.removeAttribute('data-a11y-probe')).catch(() => {});
    }
  }
  await page.mouse.move(0, 0);

  return found;
}

// Where focus goes after each key. Focus on <body> is only a finding when the element that held it
// was taken out of the DOM (an unpin removing its own row) or a non-Tab key dropped it; Tab past the
// last control leaving the page is just the end of the tab order.
async function walkKeys() {
  const steps = [];

  for (const key of (args.keys || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    await page.evaluate(() => {
      window.__a11yProbePrev = document.activeElement;
    });
    await page.keyboard.press(key);
    await page.waitForTimeout(300);
    steps.push({
      key,
      ...(await page.evaluate(({ sel, k }) => {
        const a = document.activeElement;
        const prev = window.__a11yProbePrev;
        const scope = document.querySelector(sel);
        const text = (a?.getAttribute?.('aria-label') || a?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
        const onBody = !a || a === document.body || a === document.documentElement;
        const removed = !!(prev && prev !== document.body && !prev.isConnected);
        const tab = /^(Shift\+)?Tab$/.test(k);

        return {
          focus:            onBody ? '<body>' : `<${ a.tagName.toLowerCase() }${ a.getAttribute('role') ? `[role=${ a.getAttribute('role') }]` : '' }> "${ text }"`,
          lost:             onBody && (removed || !tab),
          cause:            onBody ? (removed ? 'the focused element was removed from the DOM' : tab ? 'end of the tab order' : `${ k } moved focus nowhere`) : '',
          inScope:          !!(scope && a && scope.contains(a)),
          activedescendant: a?.getAttribute?.('aria-activedescendant') || null,
        };
      }, { sel: SCOPE, k: key })),
    });
  }

  return steps;
}

async function axeScan() {
  if (!AXE) {
    return { error: 'axe-core not found under /workspace/dashboard/node_modules - run yarn install in the checkout' };
  }
  await page.evaluate(readFileSync(AXE, 'utf8'));

  return page.evaluate(async(sel) => {
    const r = await window.axe.run(sel, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] }, resultTypes: ['violations', 'incomplete'] });
    const slim = (list) => list.map((v) => ({
      id: v.id, impact: v.impact, help: v.help, tags: v.tags.filter((t) => /^wcag\d/.test(t)), nodes: v.nodes.slice(0, 5).map((n) => ({ target: n.target.join(' '), summary: (n.failureSummary || n.any?.[0]?.message || '').slice(0, 200) })),
    }));

    return { violations: slim(r.violations), incomplete: slim(r.incomplete) };
  }, SCOPE);
}

try {
  report.url = page.url();

  for (const theme of THEMES) {
    // Each theme starts from the same place: reload, reach the state again. A state reached
    // once and re-themed can keep hover or open-state styling the second theme never earned.
    if (opened && theme !== THEMES[0]) {
      await page.goto(args.goto, { waitUntil: 'domcontentloaded' });
    }
    await setTheme(theme);
    await runSteps(args.steps);
    await setTheme(theme);

    const base = await page.evaluate(IN_PAGE, { scopeSel: SCOPE, only: [...CHECKS] });

    if (base.error) {
      report.themes[theme] = base;
      continue;
    }

    // The per-element contrast walk for hover/focus states, installed once per theme.
    await page.evaluate((src) => {
      // eslint-disable-next-line no-new-func
      const factory = new Function(`return (${ src })`)();

      window.__a11yProbeContrast = (el) => {
        const tmp = el.getAttribute('data-a11y-probe');

        return factory({ scopeSel: `[data-a11y-probe="${ tmp }"]`, only: ['contrast'] }).contrast;
      };
    }, IN_PAGE.toString());

    const t = { ...base };

    if (CHECKS.has('names')) {
      t.names = await unnamed().catch((e) => ({ error: e.message }));
    }
    if (CHECKS.has('contrast') && (args.hover || args.focus)) {
      t.states = await hoverAndFocus().catch((e) => ({ error: e.message }));
    }
    if (CHECKS.has('axe')) {
      t.axe = await axeScan().catch((e) => ({ error: e.message }));
    }
    // Last, and from a clean start: the hover and focus checks above moved focus, and a walk that
    // begins wherever they left it tests a path no user takes. Keys can also change the DOM (an
    // unpin removes a row), which is why nothing is measured after this.
    if (CHECKS.has('focus') && args.keys) {
      if (opened) {
        await page.goto(args.goto, { waitUntil: 'domcontentloaded' });
        await setTheme(theme);
        await runSteps(args.steps);
      } else {
        await page.evaluate(() => document.activeElement?.blur?.());
      }
      await page.mouse.move(0, 0);
      t.focus = await walkKeys().catch((e) => ({ error: e.message }));
    }
    report.themes[theme] = t;
  }
} finally {
  if (opened) {
    await page.close().catch(() => {});
  }
  await browser.close().catch(() => {});
}

// ── Report: failures first, then the one-line tallies. Numbers, not adjectives. ──
const lines = [`a11y-probe  ${ report.url }  scope ${ SCOPE }`];

for (const [theme, t] of Object.entries(report.themes)) {
  lines.push('', `== ${ theme } ==`);
  if (t.error) {
    lines.push(`  ERROR ${ t.error }`);
    continue;
  }
  const failing = (list) => (Array.isArray(list) ? list.filter((c) => !c.pass) : []);
  // One line per distinct failure, naming every state it fails in, rather than one per state.
  const contrast = new Map();
  const note = (c, state) => {
    const key = `${ c.element }|${ c.fg }|${ c.bg }`;

    if (!contrast.has(key)) {
      contrast.set(key, { ...c, states: new Set() });
    }
    contrast.get(key).states.add(state);
  };

  failing(t.contrast).forEach((c) => note(c, 'rest'));
  for (const s of Array.isArray(t.states) ? t.states : []) {
    failing(s.contrast).forEach((c) => note(c, s.kind));
  }
  for (const c of contrast.values()) {
    lines.push(`  CONTRAST (1.4.3) ${ c.ratio }:1 needs ${ c.needs }:1  ${ c.fg } on ${ c.bg }  ${ c.element }  [${ [...c.states].join(', ') }]${ c.undecidable ? `  undecidable: ${ c.undecidable }` : '' }`);
  }
  for (const s of Array.isArray(t.states) ? t.states : []) {
    if (s.kind === 'focus' && s.active && !s.indicator) {
      lines.push(`  FOCUS VISIBLE (2.4.7) no outline or box-shadow when focused: ${ s.element }`);
    }
  }
  for (const n of t.nested || []) {
    lines.push(`  NESTED INTERACTIVE (4.1.2) ${ n.outer } contains ${ n.inner.join(', ') }`);
  }
  for (const b of t.relations?.broken || []) {
    lines.push(`  BROKEN RELATION (1.3.1) ${ b.element } ${ b.attr } -> missing #${ b.missing.join(' #') }`);
  }
  for (const p of t.relations?.popup || []) {
    if (p.match === false) {
      lines.push(`  POPUP ROLE MISMATCH (4.1.2) ${ p.element } aria-haspopup="${ p.haspopup }" but controls ${ p.targetRoles.join(', ') }`);
    } else if (p.match === null && p.expanded === 'true') {
      lines.push(`  POPUP UNVERIFIABLE (4.1.2) ${ p.element } aria-haspopup="${ p.haspopup }" expanded, but aria-controls points at nothing - check the panel's role by hand`);
    }
  }
  for (const n of t.names?.missing || []) {
    lines.push(`  NO ACCESSIBLE NAME (4.1.2) role=${ n.role }  ${ n.html }`);
  }
  for (const x of t.target || []) {
    lines.push(`  TARGET SIZE (2.5.8) ${ x.width }x${ x.height } < 24x24  ${ x.element }`);
  }
  for (const f of Array.isArray(t.focus) ? t.focus : []) {
    lines.push(`  ${ f.lost ? 'FOCUS LOST (2.4.3)' : 'focus' } after ${ f.key.padEnd(10) } -> ${ f.focus }${ f.cause ? `  (${ f.cause })` : '' }${ f.activedescendant ? ` (activedescendant #${ f.activedescendant })` : '' }${ f.focus !== '<body>' && !f.inScope ? '  [left the component]' : '' }`);
  }
  for (const v of t.axe?.violations || []) {
    lines.push(`  AXE ${ v.id } (${ v.impact }; ${ v.tags.join(' ') }) ${ v.nodes.length } node(s): ${ v.nodes.map((n) => n.target).join(' | ').slice(0, 160) }`);
  }
  for (const v of t.axe?.incomplete || []) {
    lines.push(`  AXE-INCOMPLETE ${ v.id } ${ v.nodes.length } node(s) - axe could not decide; measure these: ${ v.nodes.map((n) => n.target).join(' | ').slice(0, 140) }`);
  }
  if (t.axe?.error) {
    lines.push(`  AXE ERROR ${ t.axe.error }`);
  }
  const texts = (t.contrast || []).length + (Array.isArray(t.states) ? t.states.reduce((a, s) => a + (s.contrast || []).length, 0) : 0);

  lines.push(`  -- measured ${ texts } text nodes, ${ (t.nested || []).length } nested, ${ (t.relations?.popup || []).length } popup trigger(s), ${ (t.focus || []).length } key(s)`);
}

console.log(lines.join('\n'));

if (args.json) {
  mkdirSync(dirname(args.json), { recursive: true });
  writeFileSync(args.json, JSON.stringify(report, null, 2));
  console.log(`\nfull results: ${ args.json }`);
}
