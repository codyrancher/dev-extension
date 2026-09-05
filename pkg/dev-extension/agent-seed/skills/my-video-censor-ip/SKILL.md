---
name: my-video-censor-ip
description: Black out IP addresses (and other sensitive strings) in screen-recording MP4s before publishing them to GitHub PRs. Two paths — pure ffmpeg `drawbox` when you can enumerate each occurrence by hand (fastest, no deps), or a Node+sharp pixel-contrast scanner when there are too many to enumerate or the layout shifts. Use whenever a recorded Rancher video shows the dev IP in the URL bar, form fields, or summary/review screens — anywhere `192.168.x.x`, `10.x.x.x`, or `172.16.x.x` is visible.
---

The IP that leaks into Rancher recordings is the dev host's RFC1918 address — it shows up in the URL bar, in any "API host" / "Server URL" / "Callback URL" form field the user typed it into, in summary/review screens that echo back the config, and inline in things like SAML metadata XML or kubeconfigs. **Censor before publishing.** None of these IPs are useful to a reviewer and they leak the recorder's lan topology.

## Quick decision

| Situation | Use |
|-----------|-----|
| 1-6 IP occurrences and you can eyeball where they sit | **Path A — ffmpeg drawbox**, time-windowed if needed |
| Many occurrences, repeated across multiple videos of the same template flow, or IP shifts position across views | **Path B — Node + sharp scanner** |

Don't reach for OCR. **Tesseract isn't installed in the harness and won't `apt-get install` cleanly. Python's PIL/Pillow isn't either, and `pip`/`ensurepip` is missing.** Use ffmpeg directly or Node with `sharp` — both are already on the path.

## Toolchain probe (do once)

```bash
which ffmpeg ffprobe   # must succeed — both are baked into the project image
ffprobe -v quiet -select_streams v:0 -show_entries stream=width,height,r_frame_rate,duration \
  -of default=nokey=1:noprint_wrappers=1 <input>.mp4
```

For the scanner path:

```bash
cd /workspace && npm install --no-save --silent sharp
```

## Always censor the URL bar (1080p Rancher recordings)

At 1280×720 / 1920×1080 zoom levels we use, the URL bar IP sits at a constant rect for the whole video. Include this unconditionally on every recording:

```
x=265 y=5 w=105 h=22    # static across the whole video
```

Larger viewport recordings shift this — confirm by extracting frame 1 and eyeballing once per video size.

## Path A — ffmpeg `drawbox`, time-windowed

When you can hand-enumerate the redaction rects, one ffmpeg pass does everything. Each `drawbox` is a black box drawn over the named rect; the `enable=` expression scopes it to a time window so a single command covers form view → submit → summary view where the IP moves to a different rect.

```bash
ffmpeg -y -i input.mp4 -vf "\
drawbox=x=265:y=4:w=100:h=22:color=black:t=fill,\
drawbox=x=858:y=557:w=98:h=18:color=black:t=fill:enable='lte(t,7.5)',\
drawbox=x=1033:y=744:w=70:h=18:color=black:t=fill:enable='lte(t,7.5)',\
drawbox=x=506:y=376:w=96:h=18:color=black:t=fill:enable='gte(t,7.0)'\
" -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p input-censored.mp4
```

- The first `drawbox` (no `enable=`) is the always-on URL bar.
- The next three are the form-field IPs that disappear after submission at ~t=7.5s.
- The last one is the summary-view IP that only appears after t=7.0s.
- `-pix_fmt yuv420p` is mandatory — without it Safari/QuickTime can't play the output.
- `-crf 18` keeps quality close to the source; raise to 23 if file size matters.

### Finding the coordinates

1. Extract one frame per second so you can scrub through what's visible:

   ```bash
   mkdir -p /tmp/frames && \
   ffmpeg -y -i input.mp4 -vf "fps=1" /tmp/frames/frame_%03d.png
   ```

2. Open the frames in VSCode or the harness Browser tab. Eyeball the rect around each IP. Tight crops to verify:

   ```bash
   ffmpeg -y -i input.mp4 -ss 7 -vf "crop=100:22:858:557" \
     -frames:v 1 -update 1 /tmp/probe.png
   ```

   Use `-update 1` when writing a single image to a non-numbered filename, or ffmpeg warns.

3. Add 4-6px of padding to your rect so anti-aliased edges don't peek out.

## Path B — Node + sharp pixel-contrast scanner

When IPs appear in many places, or when the layout shifts mid-video (e.g. a long table that scrolls past), hand-enumerating gets tedious and you'll miss frames. The scanner walks every frame, finds bright-on-dark text rows in a given column band, and composites black RGBA patches over them.

Sketch (drop into `/workspace/censor.mjs` and tune the per-video config block):

```js
import sharp from 'sharp'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'

// Hand-tune per video. Each entry: {x, w, yStart, yEnd, ncc?} — x/w is the
// column band the IP lives in, yStart/yEnd narrows the y search range,
// ncc (optional) is a column-signature for verifying ambiguous text rows.
const CONFIG = {
  'github.mp4': {
    bands: [
      { x: 580, w: 100, yStart: 380, yEnd: 720 },  // Homepage URL
      { x: 650, w: 100, yStart: 380, yEnd: 720 },  // Callback URL
    ],
  },
  // ...add per-video entries as needed
}
const URL_BAR = { x: 265, y: 5, w: 105, h: 22 }  // always

const MIN_CONTRAST = 45   // max-min greyscale across a row to count as text
const MIN_ROWS = 6        // text run-length floor
const MAX_ROWS = 18       // text run-length ceiling (avoid headers)
const PAD_Y = 5
const DEDUPE_X = 30
const DEDUPE_Y = 15

function findTextBands(buf, fw, fh, x0, w, yStart, yEnd) {
  const bands = []
  let runStart = -1
  for (let y = yStart; y < yEnd; y++) {
    let min = 255, max = 0
    for (let x = x0; x < x0 + w; x++) {
      const v = buf[y * fw + x]
      if (v < min) min = v
      if (v > max) max = v
    }
    const isText = (max - min) >= MIN_CONTRAST
    if (isText && runStart < 0) runStart = y
    if ((!isText || y === yEnd - 1) && runStart >= 0) {
      const h = y - runStart
      if (h >= MIN_ROWS && h <= MAX_ROWS) bands.push({ y: runStart, h })
      runStart = -1
    }
  }
  return bands
}

function rgbaBlackBuffer(w, h) {
  // CORRECT way to build an opaque-black RGBA buffer for sharp.composite().
  // Buffer.alloc(...).fill(255, 3, 4) does NOT work — alpha must be set per pixel.
  const buf = Buffer.alloc(w * h * 4)
  for (let p = 0; p < w * h; p++) buf[p * 4 + 3] = 255
  return buf
}

async function censorFrame(framePath, cfg) {
  const img = sharp(framePath)
  const { width: fw, height: fh } = await img.metadata()
  const grey = await img.clone().greyscale().raw().toBuffer()

  const boxes = [{ ...URL_BAR }]
  for (const band of cfg.bands) {
    for (const b of findTextBands(grey, fw, fh, band.x, band.w, band.yStart, band.yEnd)) {
      const box = {
        x: band.x,
        y: Math.max(0, b.y - PAD_Y),
        w: Math.min(band.w, fw - band.x),
        h: Math.min(b.h + PAD_Y * 2, fh - (b.y - PAD_Y)),
      }
      if (!boxes.some(p => Math.abs(p.x - box.x) < DEDUPE_X && Math.abs(p.y - box.y) < DEDUPE_Y)) {
        boxes.push(box)
      }
    }
  }
  const composites = boxes.map(b => ({
    input: rgbaBlackBuffer(b.w, b.h),
    raw: { width: b.w, height: b.h, channels: 4 },
    top: b.y, left: b.x,
  }))
  await sharp(framePath).composite(composites).toFile(framePath + '.out.png')
  await fs.rename(framePath + '.out.png', framePath)
}

function sh(cmd, args) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: 'inherit' })
    p.on('exit', c => c === 0 ? res() : rej(new Error(`${cmd} exit ${c}`)))
  })
}

for (const input of process.argv.slice(2)) {
  const name = path.basename(input)
  const cfg = CONFIG[name]
  if (!cfg) { console.error(`no CONFIG entry for ${name}`); continue }
  const dir = `/tmp/${name}.frames`
  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(dir, { recursive: true })
  await sh('ffmpeg', ['-y', '-i', input, `${dir}/frame_%04d.png`])
  const frames = (await fs.readdir(dir)).filter(f => f.endsWith('.png')).sort()
  for (const f of frames) await censorFrame(path.join(dir, f), cfg)
  // get source fps
  const { stdout } = await new Promise((res, rej) => {
    const p = spawn('ffprobe', ['-v','quiet','-select_streams','v:0','-show_entries','stream=r_frame_rate','-of','default=nokey=1:noprint_wrappers=1', input])
    let buf = ''
    p.stdout.on('data', d => buf += d)
    p.on('exit', c => c === 0 ? res({ stdout: buf.trim() }) : rej(new Error('ffprobe failed')))
  })
  const [num, den] = stdout.split('/').map(Number)
  const fps = num / (den || 1)
  const out = input.replace(/\.mp4$/, '-censored.mp4')
  await sh('ffmpeg', ['-y','-framerate', String(fps), '-i', `${dir}/frame_%04d.png`,
    '-c:v','libx264','-preset','medium','-crf','18','-pix_fmt','yuv420p', out])
  console.log(`saved ${out}`)
}
```

Run with:

```bash
node /workspace/censor.mjs /workspace/videos/github.mp4 /workspace/videos/saml.mp4
```

### When band-detection over-triggers

Summary/review screens often have sibling text on the same row (labels like `Issuer:` next to the IP value). The contrast scanner accepts both rows. Add an `ncc` reference signature to the config entry and verify each accepted band:

```js
// in CONFIG entry
ncc: { refFrame: 200, x: 480, y: 376, w: 96, h: 18, threshold: 0.6 }
```

Capture the reference column-signature from a known-good frame and skip any candidate whose normalized cross-correlation against it is below `threshold`. Saves you from needing more heuristics; copies the agent's approach for the OIDC summary view.

## Verification

After producing `*-censored.mp4`, re-extract frames at fps=1 and visually scan:

```bash
mkdir -p /tmp/verify && \
ffmpeg -y -i input-censored.mp4 -vf "fps=1" /tmp/verify/frame_%03d.png && \
ls /tmp/verify
```

Open the frames and confirm every IP is covered. Check edge frames (first second, last second, the moment between form view and summary view) — these are where redactions most often slip.

## Output settings reference

| Flag | Why |
|------|-----|
| `-c:v libx264` | GitHub PR uploads accept H.264 in MP4; widely playable |
| `-preset medium` | Balanced encode speed vs size |
| `-crf 18` | Visually transparent on UI footage; lower = larger file |
| `-pix_fmt yuv420p` | Required for Safari/QuickTime playback |
| `-framerate <src_fps>` | Always match source; otherwise playback speed drifts |

## Gotchas

- **Tesseract / Pillow / pip are not available.** Stick to ffmpeg + node-sharp.
- **`Buffer.alloc(n).fill(255, 3, 4)` does NOT produce a valid opaque-black RGBA buffer.** Use the per-pixel loop shown above.
- **Clip box width/height to image bounds** before passing to `sharp.composite()` — it throws on out-of-range rects.
- **`-pix_fmt yuv420p` is not optional** for shareable output.
- **`-update 1` is required** when writing a single image to a non-numbered filename in ffmpeg.
- **IP coordinates shift between views** of the same flow (form vs summary). Treat each view as its own band in the config; don't reuse one band entry across views.
- **Don't redact the `localhost` URL** — only the bare IPs. localhost is meaningful to reviewers ("this happens on the dev server too").
