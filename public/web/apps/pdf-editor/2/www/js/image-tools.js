/* SPDX-License-Identifier: AGPL-3.0-or-later */
// image-tools.js — turning a photo, a drawing or a line of text into a stamp: an image with a
// transparent background, cropped to its ink.
(function (root) {
  'use strict';

  const WORK_MAX = 1800;            // longest side processed for a photo: plenty for a signature

  function canvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
    return c;
  }
  const ctx2d = (c) => c.getContext('2d', { willReadFrequently: true });

  // A File or data URL → a canvas no larger than maxSide.
  async function load(src, maxSide) {
    const url = typeof src === 'string' ? src : URL.createObjectURL(src);
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      await img.decode();
      const w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h) throw new Error('empty image');
      const k = Math.min(1, (maxSide || WORK_MAX) / Math.max(w, h));
      const c = canvas(w * k, h * k);
      const g = ctx2d(c);
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, 0, 0, c.width, c.height);
      return c;
    } finally {
      if (typeof src !== 'string') URL.revokeObjectURL(url);
    }
  }

  // Whether the image already has a transparent background (a PNG cut-out): then nothing is removed.
  function hasTransparency(c) {
    const d = ctx2d(c).getImageData(0, 0, c.width, c.height).data;
    let clear = 0;
    const step = Math.max(1, Math.floor(d.length / 4 / 40000)) * 4;
    let n = 0;
    for (let i = 3; i < d.length; i += step) { n++; if (d[i] < 250) clear++; }
    return clear / n > 0.01;
  }

  const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

  // The paper's brightness around every point: the brightest values of a coarse grid, spread and
  // smoothed. A phone photo is never evenly lit; comparing each pixel with ITS paper, not one global
  // white, is what keeps a shadowed corner from turning into ink.
  function paperMap(L, w, h) {
    const cell = Math.max(8, Math.round(Math.max(w, h) / 48));
    const gw = Math.ceil(w / cell), gh = Math.ceil(h / cell);
    let g = new Float32Array(gw * gh);
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
      let m = 0;
      const y1 = Math.min(h, (gy + 1) * cell), x1 = Math.min(w, (gx + 1) * cell);
      for (let y = gy * cell; y < y1; y++) for (let x = gx * cell; x < x1; x++) { const v = L[y * w + x]; if (v > m) m = v; }
      g[gy * gw + gx] = m;
    }
    const pass = (src, fn) => {
      const out = new Float32Array(src.length);
      for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
        let acc = fn === 'max' ? 0 : 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= gw || yy >= gh) continue;
          const v = src[yy * gw + xx];
          if (fn === 'max') acc = Math.max(acc, v); else { acc += v; n++; }
        }
        out[y * gw + x] = fn === 'max' ? acc : acc / n;
      }
      return out;
    };
    g = pass(pass(g, 'max'), 'avg');
    return function at(x, y) {
      const fx = Math.min(gw - 1, Math.max(0, x / cell - 0.5)), fy = Math.min(gh - 1, Math.max(0, y / cell - 0.5));
      const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(gw - 1, x0 + 1), y1 = Math.min(gh - 1, y0 + 1);
      const tx = fx - x0, ty = fy - y0;
      const a = g[y0 * gw + x0] * (1 - tx) + g[y0 * gw + x1] * tx;
      const b = g[y1 * gw + x0] * (1 - tx) + g[y1 * gw + x1] * tx;
      return Math.max(1, a * (1 - ty) + b * ty);
    };
  }

  function hexRgb(hex) { const n = parseInt(String(hex).slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }

  // A photo of ink on paper → ink on transparency.
  //   mode      'paper': each pixel against the paper around it (photos, scans);
  //             'color': distance from one chosen background colour (logos, coloured paper)
  //   key       [r, g, b] for 'color'
  //   strength  0..100, how much goes away     softness 0..100, how gradual the edge is
  //   darken    0..100, makes faint ink more solid
  //   ink       'orig' keeps the pen's colour, '#rrggbb' repaints every stroke
  function removeBackground(src, opts) {
    const o = opts || {};
    const w = src.width, h = src.height;
    const out = canvas(w, h);
    const d = ctx2d(src).getImageData(0, 0, w, h).data;
    const n = w * h;
    const st = Math.min(100, Math.max(0, o.strength == null ? 45 : o.strength)) / 100;
    const soft = 0.03 + 0.3 * (Math.min(100, Math.max(0, o.softness == null ? 40 : o.softness)) / 100);
    const gamma = 1 / (1 + 2.5 * (Math.min(100, Math.max(0, o.darken || 0)) / 100));
    const fixed = o.ink && o.ink !== 'orig' ? hexRgb(o.ink) : null;
    const res = new ImageData(w, h);
    const r = res.data;
    const finish = (j, a, rgb) => {
      const aa = Math.pow(a, gamma * 0.85) * (d[j + 3] / 255);
      if (fixed) { r[j] = fixed[0]; r[j + 1] = fixed[1]; r[j + 2] = fixed[2]; } else { r[j] = rgb[0]; r[j + 1] = rgb[1]; r[j + 2] = rgb[2]; }
      r[j + 3] = Math.round(255 * aa);
    };
    const rgb = [0, 0, 0];
    if (o.mode === 'color' && o.key) {
      const key = o.key;
      const t0 = 0.02 + 0.4 * st, t1 = t0 + soft;
      for (let i = 0, j = 0; i < n; i++, j += 4) {
        const dist = Math.sqrt((d[j] - key[0]) ** 2 + (d[j + 1] - key[1]) ** 2 + (d[j + 2] - key[2]) ** 2) / 441.7;
        const a = smooth(t0, t1, dist);
        if (a <= 0) continue;
        // the colour with the background's share taken out, so edges carry no halo of it
        const cov = Math.max(a, 0.2);
        for (let c = 0; c < 3; c++) rgb[c] = Math.max(0, Math.min(255, (d[j + c] - (1 - cov) * key[c]) / cov));
        finish(j, a, rgb);
      }
    } else {
      const L = new Float32Array(n);
      for (let i = 0, j = 0; i < n; i++, j += 4) L[i] = 0.2126 * d[j] + 0.7152 * d[j + 1] + 0.0722 * d[j + 2];
      const paper = paperMap(L, w, h);
      const t0 = 0.05 + 0.3 * st, t1 = t0 + soft * 0.9;
      for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
        const j = i * 4;
        const bg = paper(x, y);
        const dark = Math.min(1, Math.max(0, 1 - L[i] / bg));
        const a = smooth(t0, t1, dark);
        if (a <= 0) continue;
        // The pen's own colour: the pixel seen against white paper, with the paper's share taken out.
        const k = 255 / bg, cov = Math.max(dark, 0.2);
        for (let c = 0; c < 3; c++) rgb[c] = Math.max(0, Math.min(255, (Math.min(255, d[j + c] * k) - (1 - cov) * 255) / cov));
        finish(j, a, rgb);
      }
    }
    ctx2d(out).putImageData(res, 0, 0);
    return out;
  }

  // Removes specks: visible blobs smaller than minArea pixels (dust, paper grain, a stray dot).
  function despeckle(src, minArea) {
    if (!(minArea > 0)) return src;
    const w = src.width, h = src.height;
    const g = ctx2d(src);
    const img = g.getImageData(0, 0, w, h);
    const d = img.data;
    const seen = new Uint8Array(w * h);
    const stack = new Int32Array(w * h);
    const blob = [];
    for (let start = 0; start < w * h; start++) {
      if (seen[start] || d[start * 4 + 3] < 40) continue;
      let top = 0;
      stack[top++] = start; seen[start] = 1;
      blob.length = 0;
      while (top) {
        const i = stack[--top];
        blob.push(i);
        const x = i % w;
        const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w];
        for (const k of nb) if (k >= 0 && k < w * h && !seen[k] && d[k * 4 + 3] >= 40) { seen[k] = 1; stack[top++] = k; }
      }
      if (blob.length < minArea) for (const i of blob) d[i * 4 + 3] = 0;
    }
    g.putImageData(img, 0, 0);
    return src;
  }

  // A quarter turn clockwise (dir 1) or counter-clockwise (dir -1).
  function rotate90(src, dir) {
    const out = canvas(src.height, src.width);
    const g = ctx2d(out);
    g.translate(out.width / 2, out.height / 2);
    g.rotate((dir < 0 ? -1 : 1) * Math.PI / 2);
    g.drawImage(src, -src.width / 2, -src.height / 2);
    return out;
  }

  // Average colour around a point (the eyedropper).
  function sample(src, x, y) {
    const r = 3;
    const x0 = Math.max(0, Math.round(x) - r), y0 = Math.max(0, Math.round(y) - r);
    const w = Math.min(src.width - x0, r * 2 + 1), h = Math.min(src.height - y0, r * 2 + 1);
    const d = ctx2d(src).getImageData(x0, y0, Math.max(1, w), Math.max(1, h)).data;
    const s = [0, 0, 0];
    for (let i = 0; i < d.length; i += 4) { s[0] += d[i]; s[1] += d[i + 1]; s[2] += d[i + 2]; }
    const n = d.length / 4;
    return [Math.round(s[0] / n), Math.round(s[1] / n), Math.round(s[2] / n)];
  }

  // Erases round brush strokes ({ pts: [[x, y]...], size }) from an image, in its own pixels.
  function erase(src, strokes) {
    if (!strokes || !strokes.length) return src;
    const g = ctx2d(src);
    g.save();
    g.globalCompositeOperation = 'destination-out';
    g.lineCap = 'round'; g.lineJoin = 'round';
    for (const s of strokes) {
      g.lineWidth = s.size;
      g.beginPath();
      g.moveTo(s.pts[0][0], s.pts[0][1]);
      for (const p of s.pts) g.lineTo(p[0], p[1]);
      if (s.pts.length === 1) g.lineTo(s.pts[0][0] + 0.1, s.pts[0][1]);
      g.stroke();
    }
    g.restore();
    return src;
  }

  // Repaints the opaque parts of an image that already has transparency (a PNG cut-out).
  function recolor(src, ink) {
    const out = canvas(src.width, src.height);
    const g = ctx2d(out);
    g.drawImage(src, 0, 0);
    if (ink && ink !== 'orig') { g.globalCompositeOperation = 'source-in'; g.fillStyle = ink; g.fillRect(0, 0, out.width, out.height); }
    return out;
  }

  // Crops to what is visible, with a little air around it. null when nothing is visible.
  function trim(src, pad) {
    const w = src.width, h = src.height;
    const d = ctx2d(src).getImageData(0, 0, w, h).data;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 < 0) return null;
    const p = Math.round(Math.max(x1 - x0, y1 - y0) * (pad == null ? 0.03 : pad));
    x0 = Math.max(0, x0 - p); y0 = Math.max(0, y0 - p); x1 = Math.min(w - 1, x1 + p); y1 = Math.min(h - 1, y1 + p);
    const out = canvas(x1 - x0 + 1, y1 - y0 + 1);
    ctx2d(out).drawImage(src, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
    return out;
  }

  function fit(src, maxSide) {
    const k = Math.min(1, maxSide / Math.max(src.width, src.height));
    if (k >= 1) return src;
    const out = canvas(src.width * k, src.height * k);
    const g = ctx2d(out);
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, out.width, out.height);
    return out;
  }

  // Smallest faithful encoding: WebP keeps transparency at a fraction of PNG's size where the browser
  // can write it; PNG everywhere else.
  function encode(src, maxSide, compact) {
    const c = fit(src, maxSide);
    if (compact) {
      const webp = c.toDataURL('image/webp', 0.9);
      if (webp.startsWith('data:image/webp')) return { url: webp, width: c.width, height: c.height };
    }
    return { url: c.toDataURL('image/png'), width: c.width, height: c.height };
  }

  // Straight RGBA pixels of an image, for the PDF writer.
  async function pixels(url, maxSide) {
    const c = await load(url, maxSide || 2400);
    return { width: c.width, height: c.height, rgba: ctx2d(c).getImageData(0, 0, c.width, c.height).data };
  }

  // ── the signature pad ──
  // Strokes are kept as points with a width, so the ink colour and thickness can change afterwards and
  // the export is drawn again at a higher resolution instead of scaled up.
  function Pad(cv, opts) {
    this.cv = cv;
    this.strokes = [];
    this.color = (opts && opts.color) || '#1d1d1d';
    this.width = (opts && opts.width) || 3;
    this.onchange = null;
    let cur = null, last = null;
    const pos = (e) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, t: e.timeStamp, p: e.pressure }; };
    cv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* not a live pointer */ }
      const p = pos(e);
      p.w = 1;
      cur = { pen: e.pointerType === 'pen', pts: [p] };
      this.strokes.push(cur);
      last = p;
      this.draw();
      e.preventDefault();
    });
    cv.addEventListener('pointermove', (e) => {
      if (!cur) return;
      let evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      if (!evs.length) evs = [e];
      for (const ev of evs) {
        const p = pos(ev);
        const dist = Math.hypot(p.x - last.x, p.y - last.y);
        if (dist < 0.8) continue;
        const v = dist / Math.max(1, p.t - last.t);                       // px per ms
        const target = cur.pen && p.p > 0 ? 0.35 + p.p * 1.3 : Math.min(1.5, Math.max(0.45, 1.45 - v * 0.55));
        p.w = last.w + (target - last.w) * 0.35;                          // eased, so the line never steps
        cur.pts.push(p);
        last = p;
      }
      this.draw();
    });
    const end = () => { if (cur) { cur = null; if (this.onchange) this.onchange(); } };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
  }
  Pad.prototype.resize = function () {
    const r = this.cv.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.cv.width = Math.max(1, Math.round(r.width * dpr));
    this.cv.height = Math.max(1, Math.round(r.height * dpr));
    this.draw();
  };
  Pad.prototype.paint = function (g, scale) {
    g.lineCap = 'round'; g.lineJoin = 'round';
    g.strokeStyle = this.color; g.fillStyle = this.color;
    for (const s of this.strokes) {
      const p = s.pts;
      if (p.length === 1) { g.beginPath(); g.arc(p[0].x * scale, p[0].y * scale, this.width * scale * 0.6, 0, Math.PI * 2); g.fill(); continue; }
      for (let i = 1; i < p.length; i++) {
        const a = p[i - 1], b = p[i];
        const m0 = i > 1 ? { x: (p[i - 2].x + a.x) / 2, y: (p[i - 2].y + a.y) / 2 } : a;
        const m1 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        g.lineWidth = this.width * scale * (a.w + b.w) / 2;
        g.beginPath();
        g.moveTo(m0.x * scale, m0.y * scale);
        g.quadraticCurveTo(a.x * scale, a.y * scale, m1.x * scale, m1.y * scale);
        if (i === p.length - 1) g.lineTo(b.x * scale, b.y * scale);
        g.stroke();
      }
    }
  };
  Pad.prototype.draw = function () {
    const g = this.cv.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.cv.width, this.cv.height);
    this.paint(g, this.cv.width / Math.max(1, this.cv.getBoundingClientRect().width));
  };
  Pad.prototype.clear = function () { this.strokes = []; this.draw(); if (this.onchange) this.onchange(); };
  Pad.prototype.empty = function () { return !this.strokes.length; };
  Pad.prototype.export = function () {
    const r = this.cv.getBoundingClientRect();
    const k = 3;
    const c = canvas(r.width * k, r.height * k);
    this.paint(c.getContext('2d'), k);
    return trim(c, 0.04);
  };

  // ── text stamps ──
  const FONTS = {
    script: 'italic 400 {s}px "Segoe Script", "Brush Script MT", "Lucida Handwriting", "Apple Chancery", "URW Chancery L", cursive',
    serif: '400 {s}px Georgia, "Times New Roman", serif',
    sans: '600 {s}px system-ui, "Segoe UI", Roboto, Arial, sans-serif',
  };
  function text(str, font, color) {
    const size = 140;
    const f = (FONTS[font] || FONTS.sans).replace('{s}', size);
    const probe = canvas(10, 10).getContext('2d');
    probe.font = f;
    const w = Math.ceil(probe.measureText(str).width) + size;
    const c = canvas(Math.max(10, w), size * 1.8);
    const g = c.getContext('2d');
    g.font = f; g.fillStyle = color || '#1d1d1d'; g.textBaseline = 'middle';
    g.fillText(str, size / 2, c.height / 2);
    return trim(c, 0.06);
  }

  root.ImageTools = { load, hasTransparency, removeBackground, despeckle, rotate90, sample, erase, recolor, trim, fit, encode, pixels, Pad, text, FONTS };
})(window);
