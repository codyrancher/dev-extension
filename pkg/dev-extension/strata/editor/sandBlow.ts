import html2canvas from 'html2canvas';

interface Particle {
  x: number; y: number; vx: number; vy: number;
  r: number; g: number; b: number;
  size: number; grounded: boolean;
  groundY: number; windDelay: number; alpha: number;
}

// Crumble an element into sand that falls and blows away. Resolves with a
// cover element hiding the original — the caller removes it after mutating
// the document.
export async function sandBlowElement(el: HTMLElement): Promise<HTMLElement> {
  const rect = el.getBoundingClientRect();
  const scrollEl = el.closest('.strata-editor-scroll');
  const scrollRect = scrollEl?.getBoundingClientRect();
  const floorY = scrollRect ? scrollRect.bottom - rect.top : rect.height + 200;
  const dpr = window.devicePixelRatio || 1;

  // Step 1: Capture element with html2canvas
  const captureCanvas = await html2canvas(el, {
    backgroundColor: null,
    scale: dpr,
    onclone: (clonedDoc: Document) => {
      // Copy all CSS custom properties so they resolve in the cloned document
      const rootStyles = getComputedStyle(document.documentElement);
      const vars: string[] = [];
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            const matches = rule.cssText.match(/--[\w-]+/g);
            if (matches) vars.push(...matches);
          }
        } catch { /* cross-origin sheet */ }
      }
      const declarations = [...new Set(vars)]
        .map(v => { const val = rootStyles.getPropertyValue(v).trim(); return val ? `${v}:${val}` : ''; })
        .filter(Boolean)
        .join(';');
      clonedDoc.documentElement.style.cssText += ';' + declarations;
    },
  });
  const cw = captureCanvas.width;
  const ch = captureCanvas.height;
  const displayW = cw / dpr;
  const displayH = ch / dpr;

  // Sample pixels into particles
  const captureCtx = captureCanvas.getContext('2d')!;
  const pxData = captureCtx.getImageData(0, 0, cw, ch).data;
  const particles: Particle[] = [];

  for (let py = 0; py < ch; py += 2) {
    for (let px = 0; px < cw; px += 2) {
      const i = (py * cw + px) * 4;
      if (pxData[i + 3] > 20) {
        particles.push({
          x: px / dpr, y: py / dpr, vx: 0, vy: 0,
          r: pxData[i], g: pxData[i + 1], b: pxData[i + 2],
          size: 1.2 + Math.random() * 0.8,
          grounded: false,
          groundY: floorY - 2 - Math.random() * 4,
          windDelay: 0.6 + Math.random() * 1.0,
          alpha: 1,
        });
      }
    }
  }

  // Step 2: Place capture canvas over the element, start transparent
  captureCanvas.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${displayW}px;height:${displayH}px;z-index:2147483647;pointer-events:none;opacity:0;transition:opacity 0.4s ease;`;
  document.body.appendChild(captureCanvas);

  // Fade in the grayscale capture over the colored original
  requestAnimationFrame(() => { captureCanvas.style.opacity = '1'; });

  // Wait for fade-in, then swap
  await new Promise(r => setTimeout(r, 500));

  // Now the capture is fully visible — cover the original line with a solid div
  let editorBg = getComputedStyle(document.body).backgroundColor || '#1b1c21';
  let bgEl: HTMLElement | null = el;
  while (bgEl) {
    const bg = getComputedStyle(bgEl).backgroundColor;
    if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') {
      editorBg = bg;
      break;
    }
    bgEl = bgEl.parentElement;
  }
  const cover = document.createElement('div');
  cover.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${displayW}px;height:${displayH}px;z-index:2147483645;background:${editorBg};pointer-events:none;opacity:0;transition:opacity 0.4s ease;`;
  document.body.appendChild(cover);
  requestAnimationFrame(() => { cover.style.opacity = '1'; });

  // Step 3: Create animation canvas for falling/blowing particles
  const animCanvas = document.createElement('canvas');
  animCanvas.width = cw;
  animCanvas.height = Math.ceil((floorY + 100) * dpr);
  animCanvas.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${displayW}px;height:${floorY + 100}px;z-index:2147483646;pointer-events:none;`;
  document.body.appendChild(animCanvas);
  const ctx = animCanvas.getContext('2d')!;
  ctx.scale(dpr, dpr);

  // Brief hold showing the static grayscale, then crumble
  const HOLD = 0.3;
  const GRAVITY = 900;
  const WIND = 400;
  const TOTAL_TIME = 3.5;

  return new Promise<HTMLElement>(resolve => {
    let start = 0;
    let lastTs = 0;

    function animate(ts: number) {
      if (!start) { start = ts; lastTs = ts; }
      const dt = Math.min((ts - lastTs) / 1000, 0.033);
      lastTs = ts;
      const elapsed = (ts - start) / 1000;

      if (elapsed < HOLD) {
        requestAnimationFrame(animate);
        return;
      }

      // Remove the static capture overlay once particles start moving
      if (captureCanvas.parentNode) captureCanvas.remove();

      ctx.clearRect(0, 0, displayW, floorY + 100);

      const t = elapsed - HOLD;
      let alive = false;

      for (const p of particles) {
        if (p.alpha <= 0) continue;
        alive = true;

        if (!p.grounded) {
          p.vy += GRAVITY * dt;
          p.vx += (Math.random() - 0.5) * 30;
          p.y += p.vy * dt;
          p.x += p.vx * dt;

          if (p.y >= p.groundY) {
            p.y = p.groundY;
            p.grounded = true;
            p.vy = 0;
            p.vx = 0;
          }
        } else if (t > p.windDelay) {
          const wt = t - p.windDelay;
          p.vx += WIND * dt * (1 + Math.random() * 0.5);
          p.vy += (-50 - Math.random() * 80) * dt;
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          p.alpha = Math.max(0, 1 - wt * 1.0);
          p.size *= 0.997;
        }

        ctx.globalAlpha = p.alpha;
        ctx.fillStyle = `rgb(${p.r},${p.g},${p.b})`;
        ctx.fillRect(p.x, p.y, p.size, p.size);
      }

      if (alive && elapsed < TOTAL_TIME) {
        requestAnimationFrame(animate);
      } else {
        animCanvas.remove();
        if (captureCanvas.parentNode) captureCanvas.remove();
        resolve(cover);
      }
    }
    requestAnimationFrame(animate);
  });
}
