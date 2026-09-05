#!/usr/bin/env node
// Generator for the two copies of the browser-recording skill.
//
//   node sync-skills.mjs            # write the generated files
//   node sync-skills.mjs --check    # exit 1 if any generated file is stale
//
// Source of truth is SKILL.md.hbs in this directory, plus overlay.mjs and
// record-template.mjs. Outputs are:
//
//   my-browser-record-video/SKILL.md
//   record-browser-video/SKILL.md
//   record-browser-video/overlay.mjs
//   record-browser-video/record-template.mjs
//
// The template language is one placeholder, `{{projectName}}`, so this does the
// substitution itself rather than pulling in handlebars. The frontmatter
// `name:` is set from the target directory name, which is what makes the two
// copies different files rather than the same one twice.
//
// There is a second overlay this generator does NOT own: `browser.mjs` carries
// its own inline `OVERLAY_SCRIPT`, and that is the one `record-script` - the
// recommended path - actually injects. `overlay.mjs` is the one
// `record-template.mjs` imports, i.e. the standalone fallback. They are
// separate implementations with different element ids and different compositor
// keepalives, so neither is a copy of the other and generating one from the
// other is not a rename. What we can check mechanically is that they have not
// drifted on the things a viewer sees, which is how the last defect got in: a
// banner-wrap fix had to be hand-applied to both copies and nothing would have
// noticed if it had only landed on one. `--check` runs that parity check and
// says which copy is missing which behaviour.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SKILLS = path.dirname(HERE)
const TARGETS = ['my-browser-record-video', 'record-browser-video']
const COPIED = ['overlay.mjs', 'record-template.mjs']
const check = process.argv.includes('--check')

// PROJECT_NAME/HARNESS_PROJECT when we have them; otherwise recover it from
// whatever is already generated, so a --check run in a bare shell still works.
async function projectName() {
  const env = process.env.PROJECT_NAME || process.env.HARNESS_PROJECT
  if (env) return env
  for (const t of TARGETS) {
    const existing = await fs.readFile(path.join(SKILLS, t, 'SKILL.md'), 'utf8').catch(() => '')
    const m = existing.match(/https:\/\/([a-z0-9-]+)-rancher/i)
    if (m) return m[1]
  }
  throw new Error('sync-skills: set PROJECT_NAME - no generated copy to recover it from')
}

const render = (src, { name, project }) => src
  .replace(/\{\{projectName\}\}/g, project)
  .replace(/^---\nname: .*$/m, `---\nname: ${name}`)

const stale = []
async function emit(file, content) {
  const current = await fs.readFile(file, 'utf8').catch(() => null)
  if (current === content) return
  if (check) { stale.push(path.relative(SKILLS, file)); return }
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
  console.log(`wrote ${path.relative(SKILLS, file)}`)
}

// --- Overlay parity -----------------------------------------------------------
// The two overlays are independent implementations, so this checks behaviour,
// not text. Each rule is something a viewer would notice going missing from one
// copy. It does NOT prove the copies are equivalent - only that none of these
// specific behaviours exists in one and not the other.
const OVERLAY_RULES = [
  ['banner text wraps instead of clipping', /white-space:normal/, /overflow-wrap:anywhere/],
  // `width:max-content` is load-bearing for the cap, not decoration: without
  // it the fixed, left:50% wrapper is shrink-to-fit against 50vw of space and
  // `max-width:80vw` never binds. Probed at 1280 wide: 633px without it, 1024
  // with. Both copies had the same defect, which is why the parity check passed
  // over it - so it is a rule now.
  ['banner stack is width-capped at 80vw', /max-width:80vw/, /width:max-content/],
  ['compositor keepalive is above the opacity short-circuit', /opacity:0\.003/, /requestAnimationFrame/],
  ['cursor press squashes the dot', /scale\(0\.68\)/],
  ['cursor has a transform-only transition (never top/left)', /transition:transform \.08s/],
  ['url bar follows SPA navigation', /pushState/, /replaceState/, /popstate/, /hashchange/],
  ['click ripples', /mousedown/, /animation:__[a-z_]*ripple/],
  ['keystroke badges', /keydown/, /keyfade/],
  ['webpack dev-server overlay is killed continuously', /webpack-dev-server-client-overlay/, /MutationObserver/],
  ['highlight api', /__highlight/, /__removeHighlight/, /__clearHighlights/],
  ['banner api', /__banner/, /__removeBanner/, /__clearBanners/],
]

// Pull `const OVERLAY_SCRIPT = () => { ... }` out of browser.mjs by matching braces.
function inlineOverlay(src) {
  const marker = 'const OVERLAY_SCRIPT = () => {'
  const at = src.indexOf(marker)
  if (at < 0) return null
  let depth = 0
  for (let i = at + marker.length - 1; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1)
  }
  return null
}

async function overlayParity() {
  const browserPath = process.env.BROWSER_MJS || path.resolve(SKILLS, '..', '..', 'browser.mjs')
  const browserSrc = await fs.readFile(browserPath, 'utf8').catch(() => null)
  if (browserSrc === null) {
    console.error(`sync-skills: no browser.mjs at ${browserPath}, skipping overlay parity (set $BROWSER_MJS)`)
    return []
  }
  const copies = [
    [`${browserPath} OVERLAY_SCRIPT (record-script)`, inlineOverlay(browserSrc)],
    ['my-browser-record-video/overlay.mjs (record-template)', await fs.readFile(path.join(HERE, 'overlay.mjs'), 'utf8')],
  ]
  const problems = []
  for (const [label, body] of copies) {
    if (!body) { problems.push(`${label}: could not be located`); continue }
    for (const [rule, ...patterns] of OVERLAY_RULES) {
      const missing = patterns.filter(p => !p.test(body))
      if (missing.length) problems.push(`${label}: ${rule} (no match for ${missing.join(', ')})`)
    }
  }
  return problems
}

const project = await projectName()
// SKILL.md.hbs only exists where the skill is authored (the harness strips the
// .hbs extension when it scaffolds a project), so inside a project fall back to
// this skill's own rendered SKILL.md. It has the project name substituted
// already, which render() leaves alone.
const src = await fs.readFile(path.join(HERE, 'SKILL.md.hbs'), 'utf8')
  .catch(() => fs.readFile(path.join(HERE, 'SKILL.md'), 'utf8'))
for (const name of TARGETS) {
  await emit(path.join(SKILLS, name, 'SKILL.md'), render(src, { name, project }))
  if (name === TARGETS[0]) continue
  for (const f of COPIED) await emit(path.join(SKILLS, name, f), await fs.readFile(path.join(HERE, f), 'utf8'))
}

const drifted = await overlayParity()
if (drifted.length) {
  console.error(`sync-skills: the two overlays have drifted:\n  ${drifted.join('\n  ')}`)
} else {
  console.log(`sync-skills: overlay parity ok (${OVERLAY_RULES.length} behaviours present in both copies)`)
}

if (check && (stale.length || drifted.length)) {
  if (stale.length) console.error(`sync-skills: stale, regenerate with sync-skills.mjs:\n  ${stale.join('\n  ')}`)
  process.exit(1)
}
console.log(check ? 'sync-skills: up to date' : 'sync-skills: done')
