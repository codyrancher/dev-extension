#!/usr/bin/env node
// Single-page screenshot with a labeled header bar, red highlight rectangles,
// and optional annotation badges. Same visual language as
// my-browser-screenshot-comparison, one panel instead of two.
//
// Usage:
//   node /workspace/.claude/skills/my-browser-screenshot/my-browser-screenshot.mjs [options]
//
// Options:
//   --url URL              Full page URL to capture
//   --path PATH            Path appended to SCREENSHOT_BASE_URL (or https://$RANCHER_HOST_NAME)
//   --title TEXT           Bold header text (default: current git branch)
//   --subtitle TEXT        Muted text in parentheses after the title
//   --highlight SELECTOR   Red outline around matching element(s), repeatable
//   --note SELECTOR=TEXT   Red outline plus a labeled badge, repeatable
//   --wait-for SELECTOR    Wait for this element instead of networkidle (dev servers)
//   --scroll-to SELECTOR   Scroll this element into view before capturing
//   --full-page            Capture the whole scrollable page, not just the viewport
//   --viewport WxH         Viewport size (default: 1280x720)
//   --no-url               Omit the URL line from the header
//   --output PATH          Output file (default: /workspace/screenshots/screenshot.png)
//
// Environment variables (fallbacks when flags are not provided):
//   SCREENSHOT_BASE_URL    Base URL for --path (default: https://$RANCHER_HOST_NAME)
//   SCREENSHOT_LABEL       Default --title
//   CLAUDE_BROWSER_CDP     Browser sidecar CDP endpoint (default: http://localhost:9222)

import { chromium } from 'playwright-core'
import { promises as fs } from 'node:fs'
import { execSync } from 'node:child_process'
import path from 'node:path'

const CDP = process.env.CLAUDE_BROWSER_CDP || 'http://localhost:9222'

const DEFAULT_WIDTH = 1280
const DEFAULT_HEIGHT = 720
const HEADER_HEIGHT = 52
const HIGHLIGHT_PADDING = 4
const HIGHLIGHT_COLOR = '#ff3333'
const HIGHLIGHT_BORDER_WIDTH = 2
const BADGE_HEIGHT = 20
const BADGE_MAX_WIDTH = 420

// Index of the "=" that separates SELECTOR from TEXT in a --note value.
// Attribute selectors carry their own "=" ([data-testid=submit]), so only a
// "=" outside brackets and quotes counts.
function splitPoint(raw) {
  let depth = 0
  let quote = ''
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (quote) {
      if (c === quote && raw[i - 1] !== '\\') quote = ''
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (c === '[' || c === '(') {
      depth++
    } else if (c === ']' || c === ')') {
      depth--
    } else if (c === '=' && depth === 0) {
      return i
    }
  }
  return -1
}

function parseArgs(argv) {
  const args = {
    url:       '',
    path:      '',
    title:     process.env.SCREENSHOT_LABEL || '',
    subtitle:  '',
    highlights: [],
    notes:     [],
    waitFor:   '',
    scrollTo:  '',
    fullPage:  false,
    width:     DEFAULT_WIDTH,
    height:    DEFAULT_HEIGHT,
    showUrl:   true,
    output:    '/workspace/screenshots/screenshot.png',
  }

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--url':       args.url      = argv[++i]; break
      case '--path':      args.path     = argv[++i]; break
      case '--title':     args.title    = argv[++i]; break
      case '--subtitle':  args.subtitle = argv[++i]; break
      case '--highlight': args.highlights.push(argv[++i]); break
      case '--note': {
        const raw = argv[++i] || ''
        const eq = splitPoint(raw)
        if (eq < 1) {
          console.error(`Error: --note expects SELECTOR=TEXT, got "${raw}"`)
          process.exit(1)
        }
        args.notes.push({ selector: raw.slice(0, eq), text: raw.slice(eq + 1) })
        break
      }
      case '--wait-for':  args.waitFor  = argv[++i]; break
      case '--scroll-to': args.scrollTo = argv[++i]; break
      case '--full-page': args.fullPage = true; break
      case '--no-url':    args.showUrl  = false; break
      case '--viewport': {
        const m = /^(\d+)x(\d+)$/.exec(argv[++i] || '')
        if (!m) { console.error('Error: --viewport expects WxH, e.g. 1440x900'); process.exit(1) }
        args.width = parseInt(m[1], 10)
        args.height = parseInt(m[2], 10)
        break
      }
      case '--output':    args.output   = argv[++i]; break
    }
  }

  if (!args.url && args.path) {
    const base = process.env.SCREENSHOT_BASE_URL
      || (process.env.RANCHER_HOST_NAME ? `https://${process.env.RANCHER_HOST_NAME}` : '')
    if (!base) {
      console.error('Error: --path needs SCREENSHOT_BASE_URL or RANCHER_HOST_NAME in the environment')
      process.exit(1)
    }
    const suffix = args.path.startsWith('/') ? args.path : `/${args.path}`
    args.url = base.replace(/\/+$/, '') + suffix
  }

  if (!args.url) {
    console.error('Error: --url or --path is required')
    process.exit(1)
  }

  if (!args.title) {
    try {
      args.title = execSync('git branch --show-current', { encoding: 'utf8', cwd: '/workspace/dashboard' }).trim()
    } catch { /* not a git checkout */ }
    if (!args.title) args.title = 'SCREENSHOT'
  }

  return args
}

// Box geometry in DOCUMENT coordinates, so the same numbers work for a
// full-page capture and (after subtracting the scroll offset) a viewport one.
async function boxesFor(page, selector) {
  try {
    return await page.$$eval(selector, els => els.map(el => {
      const r = el.getBoundingClientRect()
      return {
        x: r.x + window.scrollX,
        y: r.y + window.scrollY,
        width: r.width,
        height: r.height,
      }
    }))
  } catch {
    return []
  }
}

async function capture(page, args) {
  if (args.waitFor) {
    await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.locator(args.waitFor).first().waitFor({ state: 'visible', timeout: 30_000 })
  } else {
    await page.goto(args.url, { waitUntil: 'networkidle', timeout: 30_000 })
  }

  if (args.scrollTo) {
    try {
      await page.locator(args.scrollTo).first().scrollIntoViewIfNeeded({ timeout: 10_000 })
      await page.waitForTimeout(300)
    } catch {
      console.warn(`Warning: --scroll-to "${args.scrollTo}" did not match, capturing as-is`)
    }
  }

  const marks = []
  for (const sel of args.highlights) {
    for (const box of await boxesFor(page, sel)) marks.push({ box, text: '' })
  }
  for (const note of args.notes) {
    const boxes = await boxesFor(page, note.selector)
    if (!boxes.length) console.warn(`Warning: --note selector "${note.selector}" matched nothing`)
    for (const box of boxes) marks.push({ box, text: note.text })
  }
  for (const sel of args.highlights) {
    if (!(await boxesFor(page, sel)).length) console.warn(`Warning: --highlight selector "${sel}" matched nothing`)
  }

  const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }))
  const docHeight = await page.evaluate(() => Math.max(
    document.body.scrollHeight, document.documentElement.scrollHeight,
  ))

  const buffer = await page.screenshot({ type: 'png', fullPage: args.fullPage })

  // Viewport captures are cropped to the visible region, so shift the boxes
  // from document space into image space. Full-page images already are
  // document space.
  const originX = args.fullPage ? 0 : scroll.x
  const originY = args.fullPage ? 0 : scroll.y
  const imageHeight = args.fullPage ? docHeight : args.height

  const visible = marks
    .map(m => ({ ...m, box: { ...m.box, x: m.box.x - originX, y: m.box.y - originY } }))
    .filter(m => m.box.y + m.box.height > 0 && m.box.y < imageHeight
              && m.box.x + m.box.width > 0 && m.box.x < args.width)

  const dropped = marks.length - visible.length
  if (dropped > 0) {
    console.warn(`Warning: ${dropped} highlight(s) fell outside the captured area (try --scroll-to or --full-page)`)
  }

  return { base64: buffer.toString('base64'), marks: visible, imageHeight }
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function markDivs(marks, imageWidth) {
  return marks.map(({ box, text }) => {
    const x = box.x - HIGHLIGHT_PADDING
    const y = HEADER_HEIGHT + box.y - HIGHLIGHT_PADDING
    const w = box.width + HIGHLIGHT_PADDING * 2
    const h = box.height + HIGHLIGHT_PADDING * 2

    const rect = `<div style="
      position:absolute;
      left:${x}px; top:${y}px;
      width:${w}px; height:${h}px;
      border:${HIGHLIGHT_BORDER_WIDTH}px solid ${HIGHLIGHT_COLOR};
      border-radius:3px;
      pointer-events:none;
      box-sizing:border-box;
    "></div>`

    if (!text) return rect

    // Above the box by default, flipped below when it would clip the header.
    const above = y - BADGE_HEIGHT - 2 >= HEADER_HEIGHT + 2
    const badgeY = above ? y - BADGE_HEIGHT - 2 : y + h + 2
    // Sized to the text, not to the box: a narrow target still gets a
    // readable note. Nudged left when it would run off the right edge.
    const badgeMax = Math.min(BADGE_MAX_WIDTH, imageWidth - 16)
    const badgeX = Math.max(8, Math.min(x, imageWidth - badgeMax - 8))
    const badge = `<div style="
      position:absolute;
      left:${badgeX}px; top:${badgeY}px;
      height:${BADGE_HEIGHT}px; max-width:${badgeMax}px; width:max-content;
      background:${HIGHLIGHT_COLOR}; color:#fff;
      font-size:11px; font-weight:600; line-height:${BADGE_HEIGHT}px;
      padding:0 7px; border-radius:3px;
      white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
      box-sizing:border-box;
    ">${escapeHtml(text)}</div>`

    return rect + '\n' + badge
  }).join('\n')
}

function buildHtml(shot, args) {
  const totalHeight = HEADER_HEIGHT + shot.imageHeight
  const titlePart = escapeHtml(args.title)
  const subtitlePart = args.subtitle
    ? ` <span style="font-weight:400; color:#88aacc;">(${escapeHtml(args.subtitle)})</span>`
    : ''
  const urlLine = args.showUrl
    ? `<div style="
        font-size:11px; color:#888;
        font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
        margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
      ">${escapeHtml(args.url)}</div>`
    : ''

  return `<!DOCTYPE html>
<html><head><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    width:${args.width}px; height:${totalHeight}px;
    overflow:hidden; background:#1a1a2e;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
  }
</style></head>
<body>

  <div style="
    position:absolute; left:0; top:0;
    width:${args.width}px; height:${HEADER_HEIGHT}px;
    background:#1a1a2a; border-bottom:1px solid #444;
    padding:8px 16px;
  ">
    <div style="font-size:14px; font-weight:700; color:#6bc5ff; letter-spacing:0.5px;">
      ${titlePart}${subtitlePart}
    </div>
    ${urlLine}
  </div>

  <img src="data:image/png;base64,${shot.base64}" style="
    position:absolute; left:0; top:${HEADER_HEIGHT}px;
    width:${args.width}px; height:${shot.imageHeight}px;
  ">

  ${markDivs(shot.marks, args.width)}

</body></html>`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  const browser = await chromium.connectOverCDP(CDP)
  const ctx = browser.contexts()[0] || await browser.newContext()

  console.log(`Capturing: ${args.url}`)
  const page = await ctx.newPage()
  await page.setViewportSize({ width: args.width, height: args.height })

  let shot
  try {
    shot = await capture(page, args)
  } finally {
    await page.close()
  }

  console.log('Compositing...')
  const composePage = await ctx.newPage()
  await composePage.setViewportSize({ width: args.width, height: HEADER_HEIGHT + shot.imageHeight })
  await composePage.setContent(buildHtml(shot, args), { waitUntil: 'load' })
  await composePage.waitForFunction(() => {
    const imgs = document.querySelectorAll('img')
    return Array.from(imgs).every(img => img.complete && img.naturalWidth > 0)
  })

  await fs.mkdir(path.dirname(args.output), { recursive: true })
  await composePage.screenshot({ path: args.output, type: 'png', fullPage: true })
  await composePage.close()

  try { await browser.close() } catch { /* already gone */ }
  console.log(`Saved screenshot: ${args.output} (${args.width}x${HEADER_HEIGHT + shot.imageHeight}, ${shot.marks.length} highlight(s))`)
}

main().catch(err => {
  console.error(err.message || err)
  process.exit(1)
})
