(async function () {
  /* ── Detection tuning ────────────────────────────────────────────── */
  const SLAB_RATIO  = 1.6875;    // PSA standard: 135mm / 80mm
  const DS          = 6;          // downsample factor for fast detection
  const BG_THRESH   = 0.12;      // V threshold: below = scanner background (dark)
  const MIN_AREA    = 0.005;     // minimum component area as fraction of image
  const RATIO_LO    = 1.2;       // aspect ratio filter: minimum H:W
  const RATIO_HI    = 2.5;       // aspect ratio filter: maximum H:W
  const REFINE_PAD  = 20;        // small padding
  const SAT_THRESH  = 0.12;      // saturation cutoff
  const VAL_THRESH  = 0.10;      // value cutoff for colorful check
  const CASE_EDGE   = 35;        // pixels to extend above PSA label

  /* ── DOM ──────────────────────────────────────────────────────────── */
  const statusEl       = document.getElementById('status');
  const dropzoneEl     = document.getElementById('dropzone');
  const fileInputEl    = document.getElementById('fileInput');
  const dropLabel      = document.getElementById('dropLabel');
  const queueEl        = document.getElementById('queue');
  const pairsGrid      = document.getElementById('pairsGrid');
  const actionsEl      = document.getElementById('actions');
  const downloadAllBtn = document.getElementById('downloadAll');
  const copyAllBtn     = document.getElementById('copyAll');
  const resetBtn       = document.getElementById('resetBtn');
  const lightboxEl     = document.getElementById('lightbox');
  const lightboxImg    = document.getElementById('lightboxImg');
  const helperStatusEl = document.getElementById('helperStatus');
  const helperDot      = document.getElementById('helperDot');
  const helperLabel    = document.getElementById('helperLabel');

  /* ── STATE ────────────────────────────────────────────────────────── */
  let imageIndex      = 0;
  let pairs           = [];
  let processing      = false;
  let frontFirst      = true;

  /* ── SCAN STATE ───────────────────────────────────────────────────── */
  const scanControlsEl = document.getElementById('scanControls');
  const scanBtnEl      = document.getElementById('scanBtn');
  const scanStatusEl   = document.getElementById('scanStatus');
  let scanAvailable    = false;

  /* ── INSTALL BANNER ─────────────────────────────────────────────── */
  const installBanner = document.getElementById('installBanner');
  const copyInstallBtn = document.getElementById('copyInstallCmd');
  copyInstallBtn.addEventListener('click', () => {
    const cmd = 'git clone https://github.com/nbethard-cell/slabscanner.git ~/slabscanner && ~/slabscanner/install/install.command';
    navigator.clipboard.writeText(cmd);
    copyInstallBtn.textContent = 'Copied!';
    setTimeout(() => { copyInstallBtn.textContent = 'Copy'; }, 1500);
  });

  /* ── HELPER CONNECTION ────────────────────────────────────────────── */
  let helperConnectedOnce = false;
  SlabHelper.onStatusChange = (state, caps) => {
    helperStatusEl.className = 'helper-pill ' + state;
    if (state === 'connected') {
      helperConnectedOnce = true;
      helperLabel.textContent = caps.scan ? 'Scanner + OCR' : 'OCR only';
      installBanner.classList.add('hidden');
      if (caps.scan) {
        scanAvailable = true;
        scanControlsEl.classList.remove('hidden');
        scanBtnEl.disabled = false;
        scanStatusEl.textContent = 'Ready';
      } else {
        scanAvailable = false;
        scanControlsEl.classList.add('hidden');
      }
      readyForNext();
    } else if (state === 'connecting') {
      helperLabel.textContent = 'Connecting...';
    } else {
      helperLabel.textContent = 'No helper';
      scanAvailable = false;
      scanControlsEl.classList.add('hidden');
      // Show install banner after first failed connection attempt
      if (!helperConnectedOnce) {
        setTimeout(() => {
          if (!SlabHelper.connected) installBanner.classList.remove('hidden');
        }, 4000);
      }
      readyForNext();
    }
  };

  SlabHelper.onScanMessage = (msg) => {
    if (msg.type === 'scan_progress') {
      scanBtnEl.disabled = true;
      scanBtnEl.classList.add('scanning');
      scanBtnEl.textContent = 'Scanning...';
      scanStatusEl.textContent = 'Page ' + msg.page + (msg.total_estimate ? '/' + msg.total_estimate : '');

      // Convert base64 to File and feed into pipeline
      if (msg.image_base64) {
        const binary = atob(msg.image_base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: 'image/jpeg' });
        const file = new File([blob], 'scan_page_' + msg.page + '.jpg', { type: 'image/jpeg' });
        queueFiles([file]);
      }
    } else if (msg.type === 'scan_complete') {
      scanBtnEl.disabled = false;
      scanBtnEl.classList.remove('scanning');
      updateScanBtnLabel();
      scanStatusEl.textContent = 'Scan complete (' + msg.page_count + ' pages)';
    } else if (msg.type === 'scan_error') {
      scanBtnEl.disabled = false;
      scanBtnEl.classList.remove('scanning');
      updateScanBtnLabel();
      scanStatusEl.textContent = msg.error;
    }
  };

  // Start connection
  SlabHelper.connect();

  // Initial ready state (works without helper via drag-drop)
  readyForNext();

  /* ── SCAN BUTTON ──────────────────────────────────────────────────── */
  function updateScanBtnLabel() {
    const isFirstSide = imageIndex % 2 === 0;
    const isFront = frontFirst ? isFirstSide : !isFirstSide;
    scanBtnEl.textContent = isFront ? 'Scan Front' : 'Scan Back';
  }

  scanBtnEl.addEventListener('click', () => {
    if (!scanAvailable) return;
    const dpi = parseInt(document.getElementById('dpiSelect').value) || 300;
    if (SlabHelper.scanStart(dpi)) {
      scanBtnEl.disabled = true;
      scanBtnEl.classList.add('scanning');
      scanBtnEl.textContent = 'Scanning...';
      scanStatusEl.textContent = 'Starting scan...';
    }
  });

  /* ── EVENTS ───────────────────────────────────────────────────────── */
  dropzoneEl.addEventListener('click', () => fileInputEl.click());
  dropzoneEl.addEventListener('dragover', e => { e.preventDefault(); dropzoneEl.classList.add('dragover'); });
  dropzoneEl.addEventListener('dragleave', () => dropzoneEl.classList.remove('dragover'));
  dropzoneEl.addEventListener('drop', e => { e.preventDefault(); dropzoneEl.classList.remove('dragover'); queueFiles(e.dataTransfer.files); });
  fileInputEl.addEventListener('change', () => { queueFiles(fileInputEl.files); fileInputEl.value = ''; });
  document.addEventListener('paste', e => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) if (item.type.startsWith('image/')) { queueFiles([item.getAsFile()]); return; }
  });
  const scanOrderToggle = document.getElementById('scanOrderToggle');
  scanOrderToggle.addEventListener('click', e => {
    e.preventDefault();
    frontFirst = !frontFirst;
    scanOrderToggle.textContent = frontFirst ? 'Front first' : 'Back first';
    readyForNext();
  });

  downloadAllBtn.addEventListener('click', downloadAll);
  copyAllBtn.addEventListener('click', copyAllCerts);
  resetBtn.addEventListener('click', resetAll);
  lightboxEl.addEventListener('click', () => lightboxEl.classList.remove('open'));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') lightboxEl.classList.remove('open'); });

  /* ── FILE QUEUE ───────────────────────────────────────────────────── */
  const fileQueue = [];
  function queueFiles(files) {
    for (const f of files) if (f && f.type.startsWith('image/')) fileQueue.push(f);
    drainQueue();
  }
  async function drainQueue() {
    if (processing) return;
    while (fileQueue.length) {
      processing = true;
      await processImage(fileQueue.shift());
    }
    processing = false;
    readyForNext();
  }

  /* ════════════════════════════════════════════════════════════════════
     HSV HELPERS
     ════════════════════════════════════════════════════════════════════ */

  function computeSV(data, count) {
    const s = new Float32Array(count);
    const v = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      v[i] = mx / 255;
      s[i] = mx === 0 ? 0 : (mx - mn) / mx;
    }
    return { s, v };
  }

  /* ════════════════════════════════════════════════════════════════════
     SLAB DETECTION
     ════════════════════════════════════════════════════════════════════ */

  function greenMaskFromData(data, w, h) {
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mx < 30) continue;
      const delta = mx - mn;
      if (delta === 0) continue;
      if (delta / mx < 0.12) continue;
      let hue;
      if (mx === g) hue = 60 * ((b - r) / delta + 2);
      else if (mx === r) hue = 60 * (((g - b) / delta) % 6);
      else hue = 60 * ((r - g) / delta + 4);
      if (hue < 0) hue += 360;
      if (hue >= 50 && hue <= 150) mask[i] = 1;
    }
    return mask;
  }

  function hasGreenBed(canvas) {
    const W = canvas.width, H = canvas.height;
    const sw = Math.ceil(W / DS), sh = Math.ceil(H / DS);
    const small = document.createElement('canvas');
    small.width = sw; small.height = sh;
    small.getContext('2d').drawImage(canvas, 0, 0, sw, sh);
    const data = small.getContext('2d').getImageData(0, 0, sw, sh).data;
    const mask = greenMaskFromData(data, sw, sh);
    let total = 0;
    for (let i = 0; i < sw * sh; i++) if (mask[i]) total++;
    const pct = total / (sw * sh);
    console.log('[green] Coverage:', (pct * 100).toFixed(1) + '%');
    return pct > 0.003;
  }

  function detectGreenScreenSlabs(canvas) {
    const W = canvas.width, H = canvas.height;
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, W, H).data;

    const greenMask = greenMaskFromData(data, W, H);
    const foreground = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) foreground[i] = greenMask[i] ? 0 : 1;

    const scale = DS;
    const sw = Math.ceil(W / scale), sh = Math.ceil(H / scale);
    const small = new Uint8Array(sw * sh);
    for (let sy = 0; sy < sh; sy++) {
      for (let sx = 0; sx < sw; sx++) {
        const fx = Math.min(sx * scale, W - 1);
        const fy = Math.min(sy * scale, H - 1);
        small[sy * sw + sx] = foreground[fy * W + fx];
      }
    }

    let buf = morphDilate(small, sw, sh, 1);
    buf = morphDilate(buf, sw, sh, 1);
    buf = morphErode(buf, sw, sh, 1);
    buf = morphErode(buf, sw, sh, 1);
    buf = morphErode(buf, sw, sh, 1);

    const comps = connectedComponents(buf, sw, sh);

    const TRIM = 5;
    const minArea = sw * sh * 0.02;
    const boxes = [];

    for (const c of comps) {
      if (c.area < minArea) continue;
      let bx = c.minX * scale + TRIM;
      let by = c.minY * scale + TRIM;
      let bw = (c.maxX - c.minX + 1) * scale - TRIM * 2;
      let bh = (c.maxY - c.minY + 1) * scale - TRIM * 2;
      bx = Math.max(0, bx); by = Math.max(0, by);
      bw = Math.min(bw, W - bx); bh = Math.min(bh, H - by);
      const aspect = bh / bw;
      if (aspect < RATIO_LO || aspect > RATIO_HI) continue;

      const cx = bx + bw / 2, cy = by + bh / 2;
      const stdW = Math.min(bw, bh / SLAB_RATIO);
      const stdH = stdW * SLAB_RATIO;
      const nx = Math.max(0, Math.round(cx - stdW / 2));
      const ny = Math.max(0, Math.round(cy - stdH / 2));
      boxes.push({ x: nx, y: ny, w: Math.round(stdW), h: Math.round(stdH) });
    }

    const rowTol = H * 0.08;
    boxes.sort((a, b) => {
      if (Math.abs(a.y - b.y) < rowTol) return a.x - b.x;
      return a.y - b.y;
    });

    console.log('[green] Found', boxes.length, 'slabs');
    return boxes.slice(0, 6);
  }

  function morphDilate(buf, w, h, r) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let found = false;
        for (let dy = -r; dy <= r && !found; dy++) {
          for (let dx = -r; dx <= r && !found; dx++) {
            const ny = y + dy, nx = x + dx;
            if (ny >= 0 && ny < h && nx >= 0 && nx < w && buf[ny * w + nx]) found = true;
          }
        }
        out[y * w + x] = found ? 1 : 0;
      }
    }
    return out;
  }

  function morphErode(buf, w, h, r) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let all = true;
        for (let dy = -r; dy <= r && all; dy++) {
          for (let dx = -r; dx <= r && all; dx++) {
            const ny = y + dy, nx = x + dx;
            if (ny < 0 || ny >= h || nx < 0 || nx >= w || !buf[ny * w + nx]) all = false;
          }
        }
        out[y * w + x] = all ? 1 : 0;
      }
    }
    return out;
  }

  function detectSlabs(canvas) {
    const W = canvas.width, H = canvas.height;

    if (hasGreenBed(canvas)) {
      const boxes = detectGreenScreenSlabs(canvas);
      if (boxes.length > 0) return boxes;
    }

    const sw = Math.ceil(W / DS), sh = Math.ceil(H / DS);
    const small = document.createElement('canvas');
    small.width = sw; small.height = sh;
    small.getContext('2d').drawImage(canvas, 0, 0, sw, sh);
    const sData = small.getContext('2d').getImageData(0, 0, sw, sh).data;
    const sv = computeSV(sData, sw * sh);

    const mask = new Uint8Array(sw * sh);
    for (let i = 0; i < sw * sh; i++) {
      mask[i] = sv.v[i] > BG_THRESH ? 1 : 0;
    }

    const comps = connectedComponents(mask, sw, sh);
    const minA = sw * sh * MIN_AREA;
    const large = comps.filter(c => c.area >= minA);

    if (large.length === 0) { console.log('[detect] No components found'); return []; }

    const slabLike = large.filter(c => {
      const cw = c.maxX - c.minX + 1;
      const ch = c.maxY - c.minY + 1;
      const ratio = ch / cw;
      return ratio > RATIO_LO && ratio < RATIO_HI && c.area > cw * ch * 0.35;
    });

    let rawBoxes;
    if (slabLike.length >= 2) {
      rawBoxes = slabLike.map(c => ({
        x: c.minX * DS, y: c.minY * DS,
        w: (c.maxX - c.minX + 1) * DS, h: (c.maxY - c.minY + 1) * DS,
      }));
      console.log('[detect] Individual slabs found:', rawBoxes.length);
    } else {
      const biggest = large.reduce((a, b) => a.area > b.area ? a : b);
      rawBoxes = subdivideHolder(biggest, sv, sw, sh);
      console.log('[detect] Holder blob -> subdivided into', rawBoxes.length, 'quadrants');
    }

    const refined = rawBoxes.map(b => refineEdges(canvas, b, W, H));

    const minW = W * 0.04, minH = H * 0.06;
    const valid = refined.filter(b =>
      b.w > minW && b.h > minH && b.h / b.w > RATIO_LO && b.h / b.w < RATIO_HI
    );

    const rowTol = H * 0.08;
    valid.sort((a, b) => {
      if (Math.abs(a.y - b.y) < rowTol) return a.x - b.x;
      return a.y - b.y;
    });

    console.log('[detect] Final slab count:', valid.length);
    return valid.slice(0, 6);
  }

  function connectedComponents(mask, w, h) {
    const labels = new Int32Array(w * h);
    const comps = [];
    let next = 1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        if (!mask[idx] || labels[idx]) continue;
        const lbl = next++;
        let minX = x, minY = y, maxX = x, maxY = y, area = 0;
        const stack = [idx];
        labels[idx] = lbl;
        while (stack.length) {
          const ci = stack.pop();
          const cy = (ci / w) | 0, cx = ci % w;
          area++;
          if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
          if (cy > 0     && mask[ci - w] && !labels[ci - w]) { labels[ci - w] = lbl; stack.push(ci - w); }
          if (cy < h - 1 && mask[ci + w] && !labels[ci + w]) { labels[ci + w] = lbl; stack.push(ci + w); }
          if (cx > 0     && mask[ci - 1] && !labels[ci - 1]) { labels[ci - 1] = lbl; stack.push(ci - 1); }
          if (cx < w - 1 && mask[ci + 1] && !labels[ci + 1]) { labels[ci + 1] = lbl; stack.push(ci + 1); }
        }
        comps.push({ minX, minY, maxX, maxY, area });
      }
    }
    return comps;
  }

  function subdivideHolder(comp, sv, sw, sh) {
    const x1 = comp.minX, y1 = comp.minY;
    const bw = comp.maxX - comp.minX + 1;
    const bh = comp.maxY - comp.minY + 1;

    const yMid1 = y1 + Math.round(bh * 0.25);
    const yMid2 = y1 + Math.round(bh * 0.75);

    const vProj = new Float32Array(bw);
    for (let x = 0; x < bw; x++) {
      let colorful = 0, total = 0;
      for (let y = yMid1; y < yMid2; y++) {
        const idx = y * sw + (x1 + x);
        total++;
        if (sv.s[idx] > SAT_THRESH && sv.v[idx] > VAL_THRESH) colorful++;
      }
      vProj[x] = total > 0 ? colorful / total : 0;
    }
    const splitX = findProjectionMinimum(vProj, 0.3, 0.7);

    const xMid1 = x1 + Math.round(bw * 0.25);
    const xMid2 = x1 + Math.round(bw * 0.75);

    const hProj = new Float32Array(bh);
    for (let y = 0; y < bh; y++) {
      let colorful = 0, total = 0;
      for (let x = xMid1; x < xMid2; x++) {
        const idx = (y1 + y) * sw + x;
        total++;
        if (sv.s[idx] > SAT_THRESH && sv.v[idx] > VAL_THRESH) colorful++;
      }
      hProj[y] = total > 0 ? colorful / total : 0;
    }
    const splitY = findProjectionMinimum(hProj, 0.3, 0.7);

    const cx = (x1 + splitX) * DS, cy = (y1 + splitY) * DS;
    const bx1 = x1 * DS, by1 = y1 * DS;
    const bx2 = (comp.maxX + 1) * DS, by2 = (comp.maxY + 1) * DS;

    return [
      { x: bx1, y: by1, w: cx - bx1, h: cy - by1 },
      { x: cx,  y: by1, w: bx2 - cx, h: cy - by1 },
      { x: bx1, y: cy,  w: cx - bx1, h: by2 - cy },
      { x: cx,  y: cy,  w: bx2 - cx, h: by2 - cy },
    ];
  }

  function findProjectionMinimum(arr, loFrac, hiFrac) {
    const lo = Math.round(arr.length * loFrac);
    const hi = Math.round(arr.length * hiFrac);
    let best = Infinity, idx = Math.round((lo + hi) / 2);
    for (let i = lo; i < hi; i++) {
      let sum = 0, n = 0;
      for (let k = -3; k <= 3; k++) {
        const j = i + k;
        if (j >= 0 && j < arr.length) { sum += arr[j]; n++; }
      }
      const avg = sum / n;
      if (avg < best) { best = avg; idx = i; }
    }
    return idx;
  }

  function refineEdges(canvas, box, W, H) {
    const rx = Math.max(0, box.x - REFINE_PAD);
    const ry = Math.max(0, box.y - REFINE_PAD);
    const rw = Math.min(box.w + REFINE_PAD * 2, W - rx);
    const rh = Math.min(box.h + REFINE_PAD * 2, H - ry);

    const data = canvas.getContext('2d').getImageData(rx, ry, rw, rh).data;

    function maxCh(x, y) {
      if (x < 0 || x >= rw || y < 0 || y >= rh) return 0;
      const i = (y * rw + x) * 4;
      return Math.max(data[i], data[i + 1], data[i + 2]);
    }

    const colMax = new Float32Array(rw);
    for (let x = 0; x < rw; x++) {
      let mx = 0;
      for (let y = 0; y < rh; y += 3) {
        const v = maxCh(x, y);
        if (v > mx) mx = v;
      }
      colMax[x] = mx;
    }
    const sColMax = smooth(colMax, 3);

    const GAP_TH = 100;
    const cx = Math.round(rw / 2);

    let left = 0;
    for (let x = cx; x >= 0; x--) {
      if (sColMax[x] < GAP_TH) { left = x + 1; break; }
    }

    let right = rw - 1;
    for (let x = cx; x < rw; x++) {
      if (sColMax[x] < GAP_TH) { right = x - 1; break; }
    }

    const slabW = right - left + 1;

    const xInner = Math.round(slabW * 0.15);
    let top = 0;
    for (let y = 0; y < Math.round(rh * 0.5); y++) {
      let bright = 0, total = 0;
      for (let x = left + xInner; x < right - xInner; x += 3) {
        if (maxCh(x, y) > 150) bright++;
        total++;
      }
      if (total > 0 && bright / total > 0.25) {
        top = Math.max(0, y - CASE_EDGE);
        break;
      }
    }

    const slabH = Math.round(slabW * SLAB_RATIO);

    return {
      x: Math.max(0, rx + left),
      y: Math.max(0, ry + top),
      w: Math.min(slabW, W - (rx + left)),
      h: Math.min(slabH, H - (ry + top)),
    };
  }

  function smooth(arr, radius) {
    const out = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      let s = 0, n = 0;
      for (let k = -radius; k <= radius; k++) {
        const j = i + k;
        if (j >= 0 && j < arr.length) { s += arr[j]; n++; }
      }
      out[i] = s / n;
    }
    return out;
  }

  /* ════════════════════════════════════════════════════════════════════
     CORE PROCESSING
     ════════════════════════════════════════════════════════════════════ */

  async function processImage(file) {
    const isFirstSide = imageIndex % 2 === 0;
    const isFront = frontFirst ? isFirstSide : !isFirstSide;
    const label   = isFront ? 'FRONT' : 'BACK';
    const batchNum = Math.floor(imageIndex / 2) + 1;

    setStatus('Loading ' + label + ' (batch ' + batchNum + ')...', 'loading');
    const img    = await loadImage(file);
    const canvas = imageToCanvas(img);

    setStatus('Detecting slabs...', 'loading');
    const boxes = detectSlabs(canvas);

    if (boxes.length === 0) {
      setStatus('No slabs detected \u2014 check image', 'error');
      return;
    }

    console.log('[process]', label, '\u2014 detected', boxes.length, 'slabs');

    const crops = [];
    for (let i = 0; i < boxes.length; i++) {
      const slabCanvas = cropRegion(canvas, boxes[i]);
      let cert = null;
      if (isFront) {
        setStatus(label + ': OCR slab ' + (i + 1) + '/' + boxes.length + '...', 'loading');
        cert = await extractCertNumber(slabCanvas);
        console.log('[ocr]', label, 'slab', i + 1, '\u2192 cert:', cert || '(none)');
      }
      const stdCanvas = standardizeCrop(slabCanvas);
      crops.push({ canvas: stdCanvas, cert });
    }

    // ── Pairing ──
    if (isFront) {
      for (let ci = 0; ci < crops.length; ci++) {
        const c = crops[ci];
        let matched = false;

        if (c.cert) {
          const existing = pairs.find(p => p.cert === c.cert && !p.frontCanvas);
          if (existing) {
            existing.frontCanvas = c.canvas;
            existing.frontCert = c.cert;
            matched = true;
          }
        }

        if (!matched) {
          pairs.push({
            cert: c.cert,
            frontCert: c.cert,
            backCert: null,
            frontCanvas: c.canvas,
            backCanvas: null,
          });
        }
      }
    } else {
      // Match backs by position — slabs flip in place
      const awaitingBack = pairs.filter(p => p.frontCanvas && !p.backCanvas);
      for (let i = 0; i < crops.length && i < awaitingBack.length; i++) {
        awaitingBack[i].backCanvas = crops[i].canvas;
        awaitingBack[i].backCert = awaitingBack[i].frontCert;
      }
    }

    addQueueTag(label, crops.length);
    imageIndex++;
    renderPairs();
    actionsEl.classList.toggle('hidden', pairs.length === 0);
  }

  function certDistance(a, b) {
    if (!a || !b) return Infinity;
    if (a === b) return 0;
    if (a.length === b.length) {
      let diff = 0;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
      return diff;
    }
    if (Math.abs(a.length - b.length) === 1) {
      const longer = a.length > b.length ? a : b;
      const shorter = a.length > b.length ? b : a;
      for (let skip = 0; skip < longer.length; skip++) {
        const trimmed = longer.slice(0, skip) + longer.slice(skip + 1);
        if (trimmed === shorter) return 1;
      }
      return 3;
    }
    return Infinity;
  }

  function fuzzyMergeOrphans() {
    const frontOnly = pairs.filter(p => p.cert && p.frontCanvas && !p.backCanvas);
    const backOnly  = pairs.filter(p => p.cert && !p.frontCanvas && p.backCanvas);
    if (!frontOnly.length || !backOnly.length) return;

    for (const fp of frontOnly) {
      let bestMatch = null, bestDist = Infinity;
      for (const bp of backOnly) {
        const d = certDistance(fp.cert, bp.cert);
        if (d > 0 && d <= 2 && d < bestDist) {
          bestDist = d;
          bestMatch = bp;
        }
      }
      if (bestMatch) {
        console.log('[fuzzy] Merging', fp.cert, '+', bestMatch.cert, '(dist=' + bestDist + ')');
        fp.backCanvas = bestMatch.backCanvas;
        fp.backCert = bestMatch.backCert;
        pairs.splice(pairs.indexOf(bestMatch), 1);
      }
    }
  }

  /* ════════════════════════════════════════════════════════════════════
     OCR (via helper WebSocket)
     ════════════════════════════════════════════════════════════════════ */

  function ocrCrop(slabCanvas, x, y, w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(slabCanvas, x, y, w, h, 0, 0, w, h);
    return c;
  }

  async function extractCertNumber(slabCanvas) {
    if (!SlabHelper.connected || !SlabHelper.capabilities.ocr) return null;

    const W = slabCanvas.width, H = slabCanvas.height;

    // Crop top 22% — PSA label area
    const labelCanvas = ocrCrop(slabCanvas, 0, 0, W, Math.round(H * 0.22));

    const result = await SlabHelper.ocr(labelCanvas);
    if (result && result.text) {
      console.log('[ocr] Vision:', result.text.substring(0, 80));
      const cert = parseCert(result.text);
      if (cert) return cert;
    }

    // Try right half only (skip barcode)
    const rightCanvas = ocrCrop(slabCanvas, Math.round(W * 0.45), 0,
      Math.round(W * 0.55), Math.round(H * 0.12));
    const result2 = await SlabHelper.ocr(rightCanvas);
    if (result2 && result2.text) {
      const cert = parseCert(result2.text);
      if (cert) return cert;
    }

    return null;
  }

  function parseCert(raw) {
    const tokens = raw.split(/[\s\n,;:|]+/);
    const eightDigit = tokens.filter(t => /^\d{8}$/.test(t.trim()));
    if (eightDigit.length > 0) return eightDigit[eightDigit.length - 1].trim();
    const longDigit = tokens.filter(t => /^\d{7,10}$/.test(t));
    if (longDigit.length > 0) return longDigit[longDigit.length - 1];
    for (let i = tokens.length - 1; i >= 0; i--) {
      const m = tokens[i].match(/\d{8}/);
      if (m) return m[0];
    }
    return null;
  }

  /* ════════════════════════════════════════════════════════════════════
     IMAGE HELPERS
     ════════════════════════════════════════════════════════════════════ */

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload  = () => resolve(img);
      img.onerror = () => reject(new Error('Image load failed'));
      img.src = URL.createObjectURL(file);
    });
  }

  function imageToCanvas(img) {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    return c;
  }

  function cropRegion(canvas, box) {
    const c = document.createElement('canvas');
    c.width = box.w; c.height = box.h;
    c.getContext('2d').drawImage(canvas, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
    return c;
  }

  const STD_W = 1200, STD_H = Math.round(1200 * SLAB_RATIO);
  const CORNER_R = 30;
  function standardizeCrop(canvas) {
    const c = document.createElement('canvas');
    c.width = STD_W; c.height = STD_H;
    const ctx = c.getContext('2d');
    ctx.beginPath();
    ctx.roundRect(0, 0, STD_W, STD_H, CORNER_R);
    ctx.closePath();
    ctx.clip();
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, STD_W, STD_H);
    ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, STD_W, STD_H);
    return c;
  }

  /* ════════════════════════════════════════════════════════════════════
     UI
     ════════════════════════════════════════════════════════════════════ */

  function setStatus(msg, type) {
    statusEl.textContent = msg;
    statusEl.className = 'status ' + type;
  }

  function readyForNext() {
    const isFirstSide = imageIndex % 2 === 0;
    const isFront = frontFirst ? isFirstSide : !isFirstSide;
    const label = isFront ? 'FRONT' : 'BACK';
    const batch = Math.floor(imageIndex / 2) + 1;
    dropLabel.textContent = 'Drop ' + label + ' scan (batch ' + batch + ')';
    dropzoneEl.classList.remove('disabled');
    setStatus('Ready \u2014 ' + (scanAvailable ? 'scan or drop ' : 'drop ') + label.toLowerCase() + ' scan for batch ' + batch, 'ready');
    updateScanBtnLabel();
  }

  function addQueueTag(label, count) {
    // Update or create tag
    const cls = label.toLowerCase();
    let tag = queueEl.querySelector('.queue-tag.' + cls);
    if (!tag) {
      tag = document.createElement('span');
      tag.className = 'queue-tag ' + cls;
      queueEl.appendChild(tag);
    }
    const prev = parseInt(tag.dataset.count || '0');
    const total = prev + count;
    tag.dataset.count = total;
    tag.textContent = label + ' \u00d7' + total;
  }

  function updateStats() {
    const statsRow = document.getElementById('statsRow');
    if (pairs.length === 0) { statsRow.classList.add('hidden'); return; }
    statsRow.classList.remove('hidden');
    const paired = pairs.filter(p => p.frontCanvas && p.backCanvas).length;
    const awaiting = pairs.length - paired;
    document.getElementById('statTotal').textContent = pairs.length;
    document.getElementById('statPaired').textContent = paired;
    document.getElementById('statAwaiting').textContent = awaiting;
  }

  function openLightbox(src) {
    lightboxImg.src = src;
    lightboxEl.classList.add('open');
  }

  function handleSlabDrop(e, targetIdx, targetSide) {
    const data = e.dataTransfer.getData('text/plain');
    if (!data || !data.includes(':')) return;
    const [srcIdxStr, srcSide] = data.split(':');
    const srcIdx = parseInt(srcIdxStr);
    if (isNaN(srcIdx)) return;

    const src = pairs[srcIdx];
    const tgt = pairs[targetIdx];
    if (!src || !tgt) return;

    const srcCanvas = srcSide === 'front' ? src.frontCanvas : src.backCanvas;
    const srcCert = srcSide === 'front' ? src.frontCert : src.backCert;
    if (!srcCanvas) return;

    if (src === tgt && srcSide === targetSide) return;

    const tgtCanvas = targetSide === 'front' ? tgt.frontCanvas : tgt.backCanvas;
    const tgtCert = targetSide === 'front' ? tgt.frontCert : tgt.backCert;

    if (targetSide === 'front') { tgt.frontCanvas = srcCanvas; tgt.frontCert = srcCert; }
    else { tgt.backCanvas = srcCanvas; tgt.backCert = srcCert; }

    if (srcSide === 'front') { src.frontCanvas = tgtCanvas || null; src.frontCert = tgtCert || null; }
    else { src.backCanvas = tgtCanvas || null; src.backCert = tgtCert || null; }

    tgt.cert = tgt.frontCert || tgt.backCert || tgt.cert;
    if (src.frontCanvas || src.backCanvas) {
      src.cert = src.frontCert || src.backCert || src.cert;
    }

    if (!src.frontCanvas && !src.backCanvas && src !== tgt) {
      const idx = pairs.indexOf(src);
      if (idx >= 0) pairs.splice(idx, 1);
    }

    renderPairs();
    actionsEl.classList.toggle('hidden', pairs.length === 0);
  }

  /** Create a clickable/editable cert label that sits under an image. */
  function makeCertUnder(p, side) {
    const cert = side === 'front' ? p.frontCert : p.backCert;
    const otherCert = side === 'front' ? p.backCert : p.frontCert;
    const el = document.createElement('div');
    el.className = 'cert-under' + (cert ? '' : ' pending') +
      (cert && otherCert && cert !== otherCert ? ' mismatch' : '');
    el.textContent = cert || 'click to set';
    el.title = 'Click to edit';
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const input = document.createElement('input');
      input.type = 'text';
      input.value = cert || '';
      input.placeholder = 'cert #';
      input.style.cssText = 'font-size:0.62rem;font-weight:700;text-align:center;width:10ch;padding:1px 3px;border:1px solid #4af;border-radius:3px;background:#0a0a14;color:#fff;font-family:monospace;';
      el.replaceWith(input);
      input.focus();
      input.select();
      const finish = () => {
        const val = input.value.trim().replace(/\D/g, '');
        if (val && val.length >= 7) {
          if (side === 'front') p.frontCert = val;
          else p.backCert = val;
          p.cert = p.frontCert || p.backCert || val;
          const orphan = pairs.find(op => op !== p && op.cert === val);
          if (orphan) {
            if (!p.frontCanvas && orphan.frontCanvas) { p.frontCanvas = orphan.frontCanvas; p.frontCert = orphan.frontCert; }
            if (!p.backCanvas && orphan.backCanvas) { p.backCanvas = orphan.backCanvas; p.backCert = orphan.backCert; }
            pairs.splice(pairs.indexOf(orphan), 1);
            p.cert = p.frontCert || p.backCert || val;
          }
        }
        renderPairs();
      };
      input.addEventListener('keydown', e => { if (e.key === 'Enter') finish(); if (e.key === 'Escape') renderPairs(); });
      input.addEventListener('blur', finish);
    });
    return el;
  }

  function renderPairs() {
    pairsGrid.innerHTML = '';
    for (let i = 0; i < pairs.length; i++) {
      const p = pairs[i];
      const hasBoth = p.frontCert && p.backCert;
      const mismatch = hasBoth && p.frontCert !== p.backCert;

      const card = document.createElement('div');
      card.className = 'pair-card' + (mismatch ? ' mismatch-card' : '');

      // Images row with certs underneath
      const imagesRow = document.createElement('div');
      imagesRow.className = 'pair-images';

      // Front side
      const frontSide = document.createElement('div');
      frontSide.className = 'pair-side';
      const frontImg = document.createElement('div');
      frontImg.className = 'pair-img' + (p.frontCanvas ? '' : ' waiting');
      frontImg.addEventListener('dragover', e => { e.preventDefault(); frontImg.classList.add('drop-hover'); });
      frontImg.addEventListener('dragleave', () => frontImg.classList.remove('drop-hover'));
      frontImg.addEventListener('drop', e => { e.preventDefault(); frontImg.classList.remove('drop-hover'); handleSlabDrop(e, i, 'front'); });
      if (p.frontCanvas) {
        const img = document.createElement('img');
        img.src = p.frontCanvas.toDataURL('image/jpeg', 0.85);
        img.addEventListener('click', () => openLightbox(p.frontCanvas.toDataURL('image/jpeg', 0.95)));
        img.draggable = true;
        img.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', i + ':front'); });
        const lbl = document.createElement('div');
        lbl.className = 'side-label';
        lbl.textContent = 'front';
        frontImg.append(img, lbl);
      } else {
        frontImg.textContent = 'awaiting';
      }
      frontSide.appendChild(frontImg);
      frontSide.appendChild(makeCertUnder(p, 'front'));

      // Back side
      const backSide = document.createElement('div');
      backSide.className = 'pair-side';
      const backImg = document.createElement('div');
      backImg.className = 'pair-img' + (p.backCanvas ? '' : ' waiting');
      backImg.addEventListener('dragover', e => { e.preventDefault(); backImg.classList.add('drop-hover'); });
      backImg.addEventListener('dragleave', () => backImg.classList.remove('drop-hover'));
      backImg.addEventListener('drop', e => { e.preventDefault(); backImg.classList.remove('drop-hover'); handleSlabDrop(e, i, 'back'); });
      if (p.backCanvas) {
        const img = document.createElement('img');
        img.src = p.backCanvas.toDataURL('image/jpeg', 0.85);
        img.addEventListener('click', () => openLightbox(p.backCanvas.toDataURL('image/jpeg', 0.95)));
        img.draggable = true;
        img.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', i + ':back'); });
        const lbl = document.createElement('div');
        lbl.className = 'side-label';
        lbl.textContent = 'back';
        backImg.append(img, lbl);
      } else {
        backImg.textContent = 'awaiting';
      }
      backSide.appendChild(backImg);
      backSide.appendChild(makeCertUnder(p, 'back'));

      imagesRow.append(frontSide, backSide);
      card.appendChild(imagesRow);

      // Status line
      const statusLine = document.createElement('div');
      statusLine.className = 'pair-status';
      if (mismatch) {
        statusLine.classList.add('warn');
        statusLine.textContent = '\u26a0 Cert mismatch';
      } else if (p.frontCanvas && p.backCanvas && hasBoth) {
        statusLine.classList.add('ok');
        statusLine.textContent = 'Matched';
      } else if (!p.frontCanvas || !p.backCanvas) {
        statusLine.classList.add('wait');
        statusLine.textContent = p.frontCanvas ? 'Awaiting back' : 'Awaiting front';
      } else {
        statusLine.classList.add('wait');
        statusLine.textContent = 'No cert detected';
      }
      card.appendChild(statusLine);

      // Action buttons
      const btns = document.createElement('div');
      btns.className = 'pair-actions';
      const copyB = document.createElement('button');
      copyB.textContent = 'Copy';
      copyB.disabled = !p.cert;
      copyB.addEventListener('click', () => {
        navigator.clipboard.writeText(p.cert);
        copyB.textContent = 'Copied!';
        setTimeout(() => { copyB.textContent = 'Copy'; }, 1200);
      });
      const dlB = document.createElement('button');
      dlB.textContent = 'Save';
      dlB.addEventListener('click', () => downloadPair(p, i));
      const swapB = document.createElement('button');
      swapB.textContent = 'Swap';
      swapB.addEventListener('click', () => {
        [p.frontCanvas, p.backCanvas] = [p.backCanvas, p.frontCanvas];
        [p.frontCert, p.backCert] = [p.backCert, p.frontCert];
        renderPairs();
      });
      const delB = document.createElement('button');
      delB.textContent = 'Del';
      delB.className = 'del-btn';
      delB.addEventListener('click', () => {
        pairs.splice(i, 1);
        renderPairs();
        actionsEl.classList.toggle('hidden', pairs.length === 0);
      });
      btns.append(copyB, dlB, swapB, delB);
      card.appendChild(btns);

      pairsGrid.appendChild(card);
    }
    updateStats();
  }

  /* ════════════════════════════════════════════════════════════════════
     DOWNLOADS
     ════════════════════════════════════════════════════════════════════ */

  let pickedDirHandle = null;

  const chooseFolderBtn = document.getElementById('chooseFolderBtn');
  chooseFolderBtn.addEventListener('click', async () => {
    try {
      pickedDirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      chooseFolderBtn.textContent = '\ud83d\udcc1 ' + pickedDirHandle.name;
      chooseFolderBtn.title = 'Saving to: ' + pickedDirHandle.name;
    } catch (e) {
      if (e.name !== 'AbortError') console.warn('[save] Folder picker error:', e);
    }
  });

  async function canvasToBlob(canvas) {
    return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.95));
  }

  async function saveToPickedFolder(pairsToSave) {
    const folderInput = document.getElementById('folderName');
    const subfolderName = (folderInput.value || '').trim();
    let targetDir = pickedDirHandle;

    if (subfolderName && targetDir) {
      targetDir = await targetDir.getDirectoryHandle(subfolderName, { create: true });
    }

    let saved = 0;
    for (let i = 0; i < pairsToSave.length; i++) {
      const p = pairsToSave[i];
      const name = pairName(p, i);
      if (p.frontCanvas) {
        const blob = await canvasToBlob(p.frontCanvas);
        const fh = await targetDir.getFileHandle(name + '_front.jpg', { create: true });
        const writable = await fh.createWritable();
        await writable.write(blob);
        await writable.close();
        saved++;
      }
      if (p.backCanvas) {
        const blob = await canvasToBlob(p.backCanvas);
        const fh = await targetDir.getFileHandle(name + '_back.jpg', { create: true });
        const writable = await fh.createWritable();
        await writable.write(blob);
        await writable.close();
        saved++;
      }
    }
    return saved;
  }

  function downloadCanvas(canvas, filename) {
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/jpeg', 0.95);
    a.download = filename;
    a.click();
  }

  function pairName(p, idx) { return p.cert || ('unknown_' + (idx + 1)); }

  /** Build a CSV string logging all pairs. */
  function buildCertsCSV() {
    const rows = ['Pair,Front Cert,Back Cert,Status,Front File,Back File'];
    for (let i = 0; i < pairs.length; i++) {
      const p = pairs[i];
      const name = pairName(p, i);
      const fc = p.frontCert || '';
      const bc = p.backCert || '';
      const hasBoth = p.frontCanvas && p.backCanvas;
      const mismatch = fc && bc && fc !== bc;
      const status = mismatch ? 'MISMATCH' : (hasBoth && fc ? 'Matched' : 'Incomplete');
      const frontFile = p.frontCanvas ? name + '_front.jpg' : '';
      const backFile = p.backCanvas ? name + '_back.jpg' : '';
      rows.push([i + 1, fc, bc, status, frontFile, backFile].join(','));
    }
    return rows.join('\n');
  }

  function downloadPair(p, idx) {
    const name = pairName(p, idx);
    if (p.frontCanvas) downloadCanvas(p.frontCanvas, name + '_front.jpg');
    if (p.backCanvas)  downloadCanvas(p.backCanvas,  name + '_back.jpg');
  }

  async function downloadAll() {
    const folderInput = document.getElementById('folderName');
    const folder = (folderInput.value || '').trim();

    // Priority 1: Helper save_file (saves to ~/Desktop/<folder>)
    if (SlabHelper.connected && folder) {
      downloadAllBtn.disabled = true;
      downloadAllBtn.textContent = 'Saving...';
      let saved = 0;
      for (let i = 0; i < pairs.length; i++) {
        const p = pairs[i];
        const name = pairName(p, i);
        if (p.frontCanvas) {
          const base64 = p.frontCanvas.toDataURL('image/jpeg', 0.95).split(',')[1];
          SlabHelper.saveFile(folder, name + '_front.jpg', base64);
          saved++;
          await new Promise(r => setTimeout(r, 100));
        }
        if (p.backCanvas) {
          const base64 = p.backCanvas.toDataURL('image/jpeg', 0.95).split(',')[1];
          SlabHelper.saveFile(folder, name + '_back.jpg', base64);
          saved++;
          await new Promise(r => setTimeout(r, 100));
        }
      }
      // Save CSV log
      const csv = buildCertsCSV();
      const csvBase64 = btoa(unescape(encodeURIComponent(csv)));
      SlabHelper.saveFile(folder, 'certs.csv', csvBase64);
      saved++;
      downloadAllBtn.textContent = 'Saved ' + saved + ' files!';
      setTimeout(() => { downloadAllBtn.disabled = false; downloadAllBtn.textContent = 'Save All'; }, 2000);
      return;
    }

    // Priority 2: File System Access API (picked folder)
    if (pickedDirHandle) {
      downloadAllBtn.disabled = true;
      downloadAllBtn.textContent = 'Saving...';
      try {
        const saved = await saveToPickedFolder(pairs);
        // Save CSV to same folder
        const folderInput2 = document.getElementById('folderName');
        const subName = (folderInput2.value || '').trim();
        let csvDir = pickedDirHandle;
        if (subName) csvDir = await csvDir.getDirectoryHandle(subName, { create: true });
        const csvFh = await csvDir.getFileHandle('certs.csv', { create: true });
        const csvW = await csvFh.createWritable();
        await csvW.write(buildCertsCSV());
        await csvW.close();
        downloadAllBtn.textContent = 'Saved ' + (saved + 1) + ' files!';
      } catch (e) {
        console.error('[save] File System Access error:', e);
        downloadAllBtn.textContent = 'Save failed \u2014 try again';
      }
      setTimeout(() => { downloadAllBtn.disabled = false; downloadAllBtn.textContent = 'Save All'; }, 2000);
      return;
    }

    // Priority 3: Browser download fallback
    for (let i = 0; i < pairs.length; i++) {
      downloadPair(pairs[i], i);
      await new Promise(r => setTimeout(r, 250));
    }
    // CSV as browser download
    const csvBlob = new Blob([buildCertsCSV()], { type: 'text/csv' });
    const csvUrl = URL.createObjectURL(csvBlob);
    const csvA = document.createElement('a');
    csvA.href = csvUrl;
    csvA.download = 'certs.csv';
    csvA.click();
    URL.revokeObjectURL(csvUrl);
  }

  function copyAllCerts() {
    const text = pairs.filter(p => p.cert).map(p => p.cert).join('\n');
    navigator.clipboard.writeText(text);
    copyAllBtn.textContent = 'Copied!';
    setTimeout(() => { copyAllBtn.textContent = 'Copy All Certs'; }, 1200);
  }

  function resetAll() {
    imageIndex = 0;
    pairs = [];
    pairsGrid.innerHTML = '';
    queueEl.innerHTML = '';
    actionsEl.classList.add('hidden');
    updateStats();
    readyForNext();
  }
})();
