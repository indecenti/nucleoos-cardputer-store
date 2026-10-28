/* SPDX-License-Identifier: AGPL-3.0-or-later */
// app.js — the PDF editor: viewing (zoom, fit, search, print), pages (rotate, delete, reorder, insert
// other PDFs) and signatures/stamps placed on the pages.
//
// Pages: every page of every opened file is an ENTRY (key "src:index"); S.pages is the document as it
// will be saved — which entries, in which order, each with an extra rotation. Entries are never
// destroyed, so undo can bring a deleted page back.
// Items (stamps) live in their entry's viewport at scale 1 (PDF points, as the page is SHOWN, rotation
// included). At save, three corners of each item go through viewport.convertToPdfPoint, which gives the
// image's matrix in the page's own space whatever its /Rotate or crop box.
// Saving: stamps and rotations only → incremental update of the original (it stays byte-exact, earlier
// digital signatures stay valid); pages deleted, moved or merged → a new, clean file.
(function () {
  'use strict';
  const H = window.PdfEditorHost;
  const IT = window.ImageTools;
  const pdfjs = window.pdfjsLib;
  const $ = (id) => document.getElementById(id);
  const t = (k, v) => H.t(k, v);

  const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
  const MAX_CANVAS_PX = 16e6;
  const THUMB_PX = 96;
  const INKS = [
    { id: 'black', color: '#1d1d1d' },
    { id: 'blue', color: '#1f3f9f' },
    { id: 'red', color: '#b02525' },
  ];

  const S = {
    sources: [],                 // [{ bytes, pdf, name, writable, code }]
    entries: new Map(),          // key → entry
    pages: [],                   // the document, in order
    name: '',
    zoom: 1, fit: 'width',
    items: [], sel: null, armed: null,
    stamps: [], urls: new Map(),
    undo: [], redo: [], dirty: false,
    prefs: {},
    thumbSel: new Set(), anchor: null,
    search: { q: '', matches: [], i: -1, run: 0 },
    text: new Map(),             // key → text content items
  };

  // ── small UI helpers ─────────────────────────────────────────────────────────────────────────
  let toastTimer = 0;
  function toast(msg, err, action) {
    const el = $('toast');
    $('toastText').textContent = msg;
    el.classList.toggle('err', !!err);
    const act = $('toastAct');
    act.hidden = !action;
    if (action) { act.textContent = action.label; act.onclick = () => { el.hidden = true; action.run(); }; }
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, err || action ? 6500 : 3200);
  }
  function busy(msg) { $('busyText').textContent = msg || ''; $('busy').hidden = !msg; }
  function ask(title, text, opts) {
    const o = opts || {};
    return new Promise((resolve) => {
      const d = $('dlgAsk');
      $('askTitle').textContent = title;
      $('askText').textContent = text || '';
      $('askField').hidden = !o.password;
      $('askInput').value = '';
      $('askOk').textContent = o.ok || 'OK';
      $('askOk').classList.toggle('danger', !!o.danger);
      $('askCancel').hidden = !!o.alert;
      d.returnValue = '';
      d.onclose = () => resolve(d.returnValue === 'ok' ? (o.password ? $('askInput').value : true) : null);
      d.showModal();
      if (o.password) $('askInput').focus();
    });
  }
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const mod360 = (r) => ((r % 360) + 360) % 360;
  const posOf = (e) => S.pages.indexOf(e);

  // ── pdf.js worker ────────────────────────────────────────────────────────────────────────────
  // A real worker from a blob (the frame may have no origin, so no worker URL of our own); if the
  // browser refuses, the same code runs on the page (pdf.js "fake worker").
  let workerMode = 'none';
  let workerBlob = null;
  // One PDFWorker for the app's life, passed to every getDocument: a worker that pdf.js creates from
  // GlobalWorkerOptions.workerPort belongs to the first document, and closing that document tore it down,
  // so opening a second PDF failed ("the worker is being destroyed").
  let pdfWorker = null;
  function startWorker() {
    try {
      workerBlob = URL.createObjectURL(new Blob([self.PDFJS_WORKER_SRC], { type: 'text/javascript' }));
      const w = new Worker(workerBlob);
      w.addEventListener('error', () => { if (workerMode === 'worker?') workerMode = 'failed'; });
      pdfWorker = pdfjs.PDFWorker.create({ port: w });
      workerMode = 'worker?';
    } catch (e) { workerMode = 'failed'; }
  }
  async function mainThreadWorker() {
    if (globalThis.pdfjsWorker) return;
    pdfWorker = null;
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = workerBlob || URL.createObjectURL(new Blob([self.PDFJS_WORKER_SRC], { type: 'text/javascript' }));
      s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
    workerMode = 'main';
    console.info('pdf-editor: no worker in this browser, pdf.js runs on the page');
  }

  async function load(bytes) {
    const task = pdfjs.getDocument({
      data: bytes.slice(), isEvalSupported: false, enableXfa: false, useSystemFonts: true,
      disableAutoFetch: true, stopAtErrors: false, ...(pdfWorker ? { worker: pdfWorker } : {}),
    });
    task.onPassword = async (update, reason) => {
      busy('');
      const pw = await ask(t('pw.title'), reason === 2 ? t('pw.wrong') : t('pw.text'), { password: true, ok: t('pw.ok') });
      if (pw == null) { task.destroy(); return; }
      busy(t('busy.opening'));
      update(pw);
    };
    if (workerMode !== 'worker?') return task.promise;
    // The blob worker has not answered yet in this browser: give it a moment, then run on the page.
    const timeout = new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('worker'), { code: 'worker' })), 12000));
    try {
      const doc = await Promise.race([task.promise, timeout]);
      workerMode = 'worker';
      console.info('pdf-editor: pdf.js runs in a worker');
      return doc;
    } catch (e) {
      if (e && e.name === 'PasswordException') throw e;
      if (!(e && e.code === 'worker') && workerMode !== 'failed') throw e;
      task.destroy();
      await mainThreadWorker();
      return load(bytes);
    }
  }

  // ── opening and inserting ────────────────────────────────────────────────────────────────────
  async function readPdf(file) {
    if (file.size > 200 * 1024 * 1024) throw Object.assign(new Error('big'), { code: 'big' });
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!/%PDF-/.test(String.fromCharCode.apply(null, bytes.subarray(0, 1024)))) throw Object.assign(new Error('not pdf'), { code: 'notpdf' });
    return bytes;
  }
  function openError(e) {
    console.error(e);
    const code = e && (e.code || e.name);
    toast(code === 'big' ? t('err.tooBig') : code === 'notpdf' || code === 'InvalidPDFException' ? t('err.notPdf')
      : code === 'cancelled' || code === 'AbortException' ? t('err.cancelled') : t('err.open'), !(code === 'cancelled' || code === 'AbortException'));
  }

  // Loads one file as a source and makes its entries (not yet in the document).
  async function addSource(bytes, name, loaded) {
    const pdf = loaded || await load(bytes);
    const check = await PdfWriter.inspect(bytes);
    const src = S.sources.length;
    S.sources.push({ bytes, pdf, name, writable: check.ok, code: check.code });
    let refs = null;
    const made = [];
    for (let i = 0; i < pdf.numPages; i++) {
      const page = await pdf.getPage(i + 1);
      let ref = page.ref;
      if (!ref) { refs = refs || (check.ok ? await PdfWriter.pages(bytes) : []); ref = refs[i] || null; }
      const e = { key: src + ':' + i, src, idx: i, page, ref, rot0: mod360(page.rotate || 0), rot: 0, w: 0, h: 0,
        el: null, layer: null, canvas: null, scale: 0, task: null, visible: false, thumb: null, thumbRot: -1, thumbVisible: false };
      dims(e);
      makePageEl(e);
      S.entries.set(e.key, e);
      made.push(e);
    }
    return made;
  }

  async function openFile(file) {
    if (!file) return;
    if (S.dirty && !(await ask(t('open.discardTitle'), t('open.discardText'), { ok: t('open.discardOk'), danger: true }))) return;
    busy(t('busy.opening'));
    try {
      const bytes = await readPdf(file);
      const pdf = await load(bytes);          // before closing: a file that does not open leaves the current one alone
      closeDoc();
      const made = await addSource(bytes, file.name || 'document.pdf', pdf);
      S.pages = made;
      S.name = file.name || 'document.pdf';
      $('docName').textContent = S.name;
      $('docName').title = S.name;
      document.title = S.name + ' — ' + t('app.title');
      $('emptyState').hidden = true;
      $('pages').hidden = false;
      $('viewTools').hidden = false;
      S.fit = 'width';
      syncPages();
      applyZoom(fitZoom());
      updateBanner();
      updateButtons();
      $('viewer').scrollTop = 0;
    } catch (e) { openError(e); }
    finally { busy(''); }
  }

  // Open / Insert: the host's picker (the OS sheet: device storage or this computer/phone) when it has one,
  // else the page's own file input. undefined from the host = it cannot after all: the input then.
  async function pickWith(multiple, input) {
    if (H.open) {
      try {
        const got = await H.open({ multiple });
        if (got !== undefined) return got;
      } catch (e) { console.error(e); toast(t('err.open'), true); return null; }
    }
    $(input).click();
    return null;
  }
  async function pickOpen() {
    const got = await pickWith(false, 'filePdf');
    if (got && got[0]) openFile(got[0]);
  }
  async function pickInsert() {
    const got = await pickWith(true, 'fileInsert');
    if (got && got.length) insertFiles(got);
  }

  async function insertFiles(files) {
    if (!files || !files.length || !S.pages.length) return;
    const before = snapshot();
    busy(t('busy.opening'));
    let added = 0;
    try {
      // after the last selected page, or the page in view
      const sel = S.pages.filter((e) => S.thumbSel.has(e.key));
      let at = (sel.length ? posOf(sel[sel.length - 1]) : currentPage()) + 1;
      for (const f of files) {
        const made = await addSource(await readPdf(f), f.name);
        S.pages.splice(at, 0, ...made);
        at += made.length;
        added += made.length;
      }
    } catch (e) { openError(e); }
    finally { busy(''); }
    if (!added) return;
    syncPages();
    applyZoom(S.zoom);
    updateBanner();
    commit(before);
    toast(t('pages.inserted', { count: added }));
  }

  function closeDoc() {
    if (io) io.disconnect();
    if (tio) tio.disconnect();
    for (const e of S.entries.values()) if (e.task) e.task.cancel();
    for (const s of S.sources) s.pdf.destroy();
    S.sources = []; S.entries = new Map(); S.pages = []; S.items = []; S.sel = null;
    S.undo = []; S.redo = []; S.dirty = false; S.thumbSel.clear(); S.text.clear();
    S.search.matches = []; S.search.i = -1;
    $('pages').textContent = '';
    $('thumbs').textContent = '';
    hideSel();
  }

  function updateBanner() {
    const bad = S.sources.find((s) => !s.writable);
    $('banner').hidden = !bad;
    if (bad) $('bannerText').textContent = bad.code === 'encrypted' ? t('err.encrypted') : t('err.unwritable');
  }

  // ── page entries and their DOM ───────────────────────────────────────────────────────────────
  const total = (e) => mod360(e.rot0 + e.rot);
  const viewportOf = (e, scale) => e.page.getViewport({ scale, rotation: total(e) });
  function dims(e) { const vp = viewportOf(e, 1); e.w = vp.width; e.h = vp.height; }

  function makePageEl(e) {
    const el = document.createElement('div');
    el.className = 'page';
    el.dataset.key = e.key;
    const layer = document.createElement('div');
    layer.className = 'layer';
    const num = document.createElement('span');
    num.className = 'num';
    el.append(layer, num);
    e.el = el; e.layer = layer;
  }

  // Puts the DOM in the document's order: pages, their numbers, the thumbnails.
  function syncPages() {
    const holder = $('pages');
    const want = new Set(S.pages.map((e) => e.el));
    for (const el of Array.from(holder.children)) if (!want.has(el)) el.remove();
    S.pages.forEach((e, i) => {
      holder.appendChild(e.el);
      e.el.querySelector('.num').textContent = String(i + 1);
      e.el.setAttribute('aria-label', t('page.label', { n: i + 1 }));
    });
    for (const k of Array.from(S.thumbSel)) if (!S.pages.some((e) => e.key === k)) S.thumbSel.delete(k);
    $('pageCount').textContent = '/ ' + S.pages.length;
    observe();
    renderThumbs();
    placeHighlights();
  }

  // ── rendering ────────────────────────────────────────────────────────────────────────────────
  let io = null;
  function observe() {
    if (io) io.disconnect();
    io = new IntersectionObserver((list) => {
      for (const x of list) {
        const e = S.entries.get(x.target.dataset.key);
        if (!e) continue;
        e.visible = x.isIntersecting;
        if (e.visible) render(e);
      }
    }, { root: $('viewer'), rootMargin: '800px 0px' });
    for (const e of S.pages) io.observe(e.el);
  }

  function render(e) {
    const dpr = window.devicePixelRatio || 1;
    let scale = S.zoom * dpr;
    if (e.w * e.h * scale * scale > MAX_CANVAS_PX) scale = Math.sqrt(MAX_CANVAS_PX / (e.w * e.h));
    const sig = scale + '@' + total(e);
    if (e.scale === sig || (e.task && e.taskSig === sig)) return;
    if (e.task) e.task.cancel();
    const vp = viewportOf(e, scale);
    const cv = document.createElement('canvas');
    cv.className = 'render';
    cv.width = Math.floor(vp.width); cv.height = Math.floor(vp.height);
    e.taskSig = sig;
    const task = e.page.render({ canvasContext: cv.getContext('2d'), viewport: vp, annotationMode: pdfjs.AnnotationMode.ENABLE_FORMS });
    e.task = task;
    task.promise.then(() => {
      if (e.task !== task) return;
      if (e.canvas) e.canvas.remove();
      e.el.insertBefore(cv, e.layer);
      e.canvas = cv; e.scale = sig; e.task = null;
    }, () => { if (e.task === task) e.task = null; });
  }

  function dropFarCanvases() {
    // Pages far from view give their bitmaps back: a 300-page contract must not hold 300 canvases.
    for (const e of S.entries.values()) if (!e.visible && e.canvas) { e.canvas.width = e.canvas.height = 0; e.canvas.remove(); e.canvas = null; e.scale = 0; }
  }

  // ── zoom and fit ─────────────────────────────────────────────────────────────────────────────
  function fitZoom() {
    if (!S.pages.length) return 1;
    const v = $('viewer');
    const pad = window.innerWidth < 760 ? 16 : 48;
    if (S.fit === 'page') {
      const e = S.pages[currentPage()] || S.pages[0];
      return clamp(Math.min((v.clientWidth - pad) / e.w, (v.clientHeight - 40) / e.h), 0.25, 4);
    }
    const widest = Math.max.apply(null, S.pages.map((e) => e.w));
    return clamp((v.clientWidth - pad) / widest, 0.25, 1.5);
  }
  function setFit(mode) {
    S.fit = mode;
    $('btnFitW').setAttribute('aria-pressed', String(mode === 'width'));
    $('btnFitP').setAttribute('aria-pressed', String(mode === 'page'));
    if (mode) { const keep = currentPage(); applyZoom(fitZoom()); goPage(keep); }
  }
  let rerenderTimer = 0;
  function applyZoom(z, anchor) {
    const v = $('viewer');
    const old = S.zoom;
    z = clamp(z, 0.25, 4);
    const ax = anchor ? anchor.x : v.clientWidth / 2, ay = anchor ? anchor.y : v.clientHeight / 2;
    const fx = (v.scrollLeft + ax) / Math.max(1, v.scrollWidth), fy = (v.scrollTop + ay) / Math.max(1, v.scrollHeight);
    S.zoom = z;
    for (const e of S.pages) {
      e.el.style.width = Math.round(e.w * z) + 'px';
      e.el.style.height = Math.round(e.h * z) + 'px';
    }
    for (const it of S.items) placeEl(it);
    if (S.sel) showSel();
    placeHighlights();
    if (old !== z) { v.scrollLeft = fx * v.scrollWidth - ax; v.scrollTop = fy * v.scrollHeight - ay; }
    $('btnZoomVal').textContent = Math.round(z * 100) + '%';
    clearTimeout(rerenderTimer);
    rerenderTimer = setTimeout(() => { for (const e of S.pages) if (e.visible) render(e); dropFarCanvases(); }, 140);
  }
  function stepZoom(dir, anchor) {
    setFit(null);
    const z = S.zoom;
    const next = dir > 0 ? ZOOMS.find((v) => v > z + 0.001) : ZOOMS.slice().reverse().find((v) => v < z - 0.001);
    applyZoom(next || z, anchor);
  }

  function currentPage() {
    const v = $('viewer');
    const mid = v.scrollTop + v.clientHeight / 3;
    let best = 0;
    S.pages.forEach((e, i) => { if (e.el.offsetTop <= mid) best = i; });
    return best;
  }
  function goPage(i) {
    const e = S.pages[clamp(i, 0, S.pages.length - 1)];
    if (e) $('viewer').scrollTop = e.el.offsetTop - 12;
  }

  // ── history ──────────────────────────────────────────────────────────────────────────────────
  function snapshot() { return JSON.stringify({ items: S.items, pages: S.pages.map((e) => [e.key, e.rot]) }); }
  function commit(before) {
    if (before === snapshot()) return;
    S.undo.push(before);
    if (S.undo.length > 200) S.undo.shift();
    S.redo = [];
    S.dirty = true;
    updateButtons();
  }
  function restore(json) {
    const st = JSON.parse(json);
    for (const it of S.items) if (it.el) it.el.remove();
    S.items = st.items;
    S.pages = st.pages.map(([key, rot]) => {
      const e = S.entries.get(key);
      if (e.rot !== rot) { e.rot = rot; dims(e); e.scale = 0; }
      return e;
    });
    syncPages();
    applyZoom(S.zoom);
    for (const it of S.items) placeEl(it);
    if (S.sel && !S.items.some((i) => i.id === S.sel)) select(null); else if (S.sel) showSel();
    S.dirty = true;
    updateButtons();
  }
  function undo() { if (!S.undo.length) return; S.redo.push(snapshot()); restore(S.undo.pop()); }
  function redo() { if (!S.redo.length) return; S.undo.push(snapshot()); restore(S.redo.pop()); }

  // ── page operations ──────────────────────────────────────────────────────────────────────────
  // The pages an action applies to: the thumbnails selected in the Pages panel, else the page in view.
  function targetPages() {
    const sel = S.pages.filter((e) => S.thumbSel.has(e.key));
    return sel.length && !$('panel').hidden && !$('app').classList.contains('no-panel') && panelTab === 'pages' ? sel : [S.pages[currentPage()]].filter(Boolean);
  }

  function rotatePages(list, dir) {
    if (!list.length) return;
    const before = snapshot();
    for (const e of list) {
      const w = e.w, h = e.h;
      // the stamps turn with the page
      for (const it of S.items) {
        if (it.page !== e.key) continue;
        const x = it.cx, y = it.cy;
        if (dir > 0) { it.cx = h - y; it.cy = x; } else { it.cx = y; it.cy = w - x; }
        it.rot = mod360(it.rot + dir * 90);
      }
      e.rot = mod360(e.rot + dir * 90);
      dims(e);
      e.scale = 0;
    }
    applyZoom(S.zoom);
    for (const e of list) if (e.visible) render(e);
    renderThumbs();
    commit(before);
  }

  function deletePages(list) {
    if (!list.length) return;
    if (list.length >= S.pages.length) { toast(t('pages.lastOne'), true); return; }
    const before = snapshot();
    const gone = new Set(list.map((e) => e.key));
    S.pages = S.pages.filter((e) => !gone.has(e.key));
    S.items = S.items.filter((it) => { if (gone.has(it.page)) { if (it.el) it.el.remove(); return false; } return true; });
    if (S.sel && !S.items.some((i) => i.id === S.sel)) select(null);
    for (const k of gone) S.thumbSel.delete(k);
    syncPages();
    applyZoom(S.zoom);
    commit(before);
    toast(t('pages.deleted', { count: gone.size }), false, { label: t('bar.undoShort'), run: undo });
  }

  function movePages(list, toIndex) {
    const before = snapshot();
    const moving = new Set(list.map((e) => e.key));
    const rest = S.pages.filter((e) => !moving.has(e.key));
    const at = clamp(toIndex - S.pages.slice(0, toIndex).filter((e) => moving.has(e.key)).length, 0, rest.length);
    rest.splice(at, 0, ...list);
    S.pages = rest;
    syncPages();
    applyZoom(S.zoom);
    commit(before);
  }

  // ── thumbnails ───────────────────────────────────────────────────────────────────────────────
  let tio = null;
  function renderThumbs() {
    const ol = $('thumbs');
    if (tio) tio.disconnect();
    tio = new IntersectionObserver((list) => {
      for (const x of list) {
        const e = S.entries.get(x.target.dataset.key);
        if (!e) continue;
        e.thumbVisible = x.isIntersecting;
        if (e.thumbVisible) drawThumb(e);
      }
    }, { root: $('panel'), rootMargin: '300px 0px' });
    ol.textContent = '';
    const cur = currentPage();
    S.pages.forEach((e, i) => {
      if (!e.thumb) {
        const li = document.createElement('li');
        li.className = 'thumb';
        li.setAttribute('role', 'option');
        li.dataset.key = e.key;
        const fr = document.createElement('div');
        fr.className = 'tframe';
        const ph = document.createElement('div');
        ph.className = 'tph';
        fr.appendChild(ph);
        const n = document.createElement('span');
        n.className = 'tnum';
        li.append(fr, n);
        li.addEventListener('pointerdown', (ev) => thumbPointerDown(ev, e));
        li.addEventListener('keydown', (ev) => thumbKey(ev, e));
        e.thumb = li;
      }
      const li = e.thumb;
      li.tabIndex = i === cur ? 0 : -1;
      li.querySelector('.tnum').textContent = String(i + 1);
      li.setAttribute('aria-label', t('page.label', { n: i + 1 }));
      li.setAttribute('aria-selected', String(S.thumbSel.has(e.key)));
      li.classList.toggle('current', i === cur);
      const fr = li.querySelector('.tframe');
      let mark = fr.querySelector('.tmark');
      const has = S.items.some((it) => it.page === e.key);
      if (has && !mark) { mark = document.createElement('span'); mark.className = 'tmark'; fr.appendChild(mark); }
      if (!has && mark) mark.remove();
      ol.appendChild(li);
      tio.observe(li);
    });
    $('thumbsEmpty').hidden = S.pages.length > 0;
  }

  async function drawThumb(e) {
    if (e.thumbRot === total(e) || e.thumbBusy) return;
    e.thumbBusy = true;
    try {
      const dpr = window.devicePixelRatio || 1;
      const s = (THUMB_PX * dpr) / Math.max(e.w, e.h);
      const vp = viewportOf(e, s);
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.floor(vp.width)); cv.height = Math.max(1, Math.floor(vp.height));
      cv.style.width = cv.width / dpr + 'px';
      await e.page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
      const fr = e.thumb.querySelector('.tframe');
      const old = fr.querySelector('canvas, .tph');
      if (old) old.replaceWith(cv); else fr.prepend(cv);
      e.thumbRot = total(e);
    } catch (err) { /* cancelled or broken page: the placeholder stays */ }
    finally { e.thumbBusy = false; }
    if (e.thumbRot !== total(e) && e.thumbVisible) drawThumb(e);
  }

  function refreshThumbState() {
    const cur = currentPage();
    S.pages.forEach((e, i) => {
      if (!e.thumb) return;
      e.thumb.classList.toggle('current', i === cur);
      e.thumb.setAttribute('aria-selected', String(S.thumbSel.has(e.key)));
    });
  }

  function selectThumb(e, ev) {
    const i = posOf(e);
    if (ev && ev.shiftKey && S.anchor && S.entries.get(S.anchor) && posOf(S.entries.get(S.anchor)) >= 0) {
      const a = posOf(S.entries.get(S.anchor));
      if (!(ev.ctrlKey || ev.metaKey)) S.thumbSel.clear();
      for (let k = Math.min(a, i); k <= Math.max(a, i); k++) S.thumbSel.add(S.pages[k].key);
    } else if (ev && (ev.ctrlKey || ev.metaKey)) {
      if (S.thumbSel.has(e.key)) S.thumbSel.delete(e.key); else S.thumbSel.add(e.key);
      S.anchor = e.key;
    } else {
      S.thumbSel.clear(); S.thumbSel.add(e.key); S.anchor = e.key;
    }
    refreshThumbState();
  }

  function thumbKey(ev, e) {
    const i = posOf(e);
    const focus = (k) => { const n = S.pages[clamp(k, 0, S.pages.length - 1)]; if (n && n.thumb) { n.thumb.focus(); return n; } return null; };
    const cols = Math.max(1, Math.round($('thumbs').clientWidth / (e.thumb.offsetWidth + 10)));
    const step = { ArrowRight: 1, ArrowDown: cols, ArrowLeft: -1, ArrowUp: -cols }[ev.key];
    if (step) {
      ev.preventDefault();
      const n = focus(i + step);
      if (n && ev.altKey && (ev.ctrlKey || ev.metaKey)) return;
      if (n) { selectThumb(n, ev.shiftKey ? ev : null); goPage(posOf(n)); }
      return;
    }
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); selectThumb(e, ev); goPage(i); return; }
    if (ev.key === 'Delete') { ev.preventDefault(); deletePages(S.thumbSel.size ? S.pages.filter((x) => S.thumbSel.has(x.key)) : [e]); return; }
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'ArrowUp' || ev.key === 'PageUp')) { ev.preventDefault(); movePages([e], Math.max(0, i - 1)); e.thumb.focus(); }
  }

  // Click: select and show. Drag: move the selected pages (or this one) elsewhere.
  function thumbPointerDown(ev, e) {
    if (ev.button !== 0 && ev.pointerType === 'mouse') return;
    const x0 = ev.clientX, y0 = ev.clientY;
    let drag = null, target = null, after = false;
    const clear = () => { for (const p of S.pages) if (p.thumb) p.thumb.classList.remove('drop-before', 'drop-after'); };
    const move = (m) => {
      if (!drag && Math.hypot(m.clientX - x0, m.clientY - y0) > 7) {
        if (!S.thumbSel.has(e.key)) selectThumb(e, null);
        drag = document.createElement('div');
        drag.className = 'thumb-float';
        const c = e.thumb.querySelector('canvas');
        if (c) { const cc = document.createElement('canvas'); cc.width = c.width; cc.height = c.height; cc.getContext('2d').drawImage(c, 0, 0); drag.appendChild(cc); }
        document.body.appendChild(drag);
        for (const p of S.pages) if (S.thumbSel.has(p.key)) p.thumb.classList.add('dragging');
      }
      if (!drag) return;
      drag.style.left = m.clientX - 45 + 'px'; drag.style.top = m.clientY - 20 + 'px';
      clear();
      target = null;
      for (const p of S.pages) {
        const r = p.thumb.getBoundingClientRect();
        if (m.clientY >= r.top && m.clientY <= r.bottom && m.clientX >= r.left - 6 && m.clientX <= r.right + 6) {
          target = p; after = m.clientX > r.left + r.width / 2;
          p.thumb.classList.add(after ? 'drop-after' : 'drop-before');
          break;
        }
      }
      const panel = $('panel'), pr = panel.getBoundingClientRect();
      if (m.clientY < pr.top + 40) panel.scrollTop -= 12; else if (m.clientY > pr.bottom - 40) panel.scrollTop += 12;
    };
    const up = (u) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      clear();
      for (const p of S.pages) if (p.thumb) p.thumb.classList.remove('dragging');
      if (drag) {
        drag.remove();
        if (target && u.type === 'pointerup') {
          const list = S.pages.filter((p) => S.thumbSel.has(p.key));
          if (!list.includes(target)) movePages(list, posOf(target) + (after ? 1 : 0));
        }
      } else if (u.type === 'pointerup') {
        selectThumb(e, u);
        goPage(posOf(e));
        e.thumb.focus();
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  // ── panel tabs ───────────────────────────────────────────────────────────────────────────────
  let panelTab = 'stamps';
  function setPanelTab(tab) {
    panelTab = tab;
    for (const b of document.querySelectorAll('[data-ptab]')) b.setAttribute('aria-selected', String(b.dataset.ptab === tab));
    for (const s of document.querySelectorAll('[data-ppane]')) s.hidden = s.dataset.ppane !== tab;
    S.prefs.tab = tab;
    H.prefs.set(S.prefs).catch(() => {});
  }

  // ── stamps library ───────────────────────────────────────────────────────────────────────────
  async function loadStamps() {
    try {
      const list = await H.stamps.list();
      const kept = [];
      for (const m of list) {
        const url = await H.stamps.get(m.id);
        if (typeof url === 'string' && url.startsWith('data:image/')) { S.urls.set(m.id, url); kept.push(Object.assign({}, m, { kept: true })); }
      }
      S.stamps = kept.concat(S.stamps.filter((s) => !s.kept));
    } catch (e) { console.error(e); }
    renderStamps();
  }

  function renderStamps() {
    const ul = $('stampList');
    ul.textContent = '';
    for (const s of S.stamps) {
      const li = document.createElement('li');
      li.className = 'stamp';
      li.setAttribute('role', 'option');
      li.tabIndex = 0;
      li.dataset.id = s.id;
      li.setAttribute('aria-selected', String(S.armed === s.id));
      const th = document.createElement('div');
      th.className = 'thumb-img checker';
      const img = document.createElement('img');
      img.alt = s.name;
      img.src = S.urls.get(s.id);
      img.draggable = false;
      th.appendChild(img);
      const meta = document.createElement('div');
      meta.className = 'meta';
      const nm = document.createElement('span');
      nm.textContent = s.kept ? s.name : s.name + ' · ' + t('panel.once');
      const del = document.createElement('button');
      del.className = 'icon-btn sm';
      del.title = t('panel.delete');
      del.setAttribute('aria-label', t('panel.delete') + ': ' + s.name);
      del.innerHTML = '<svg><use href="#i-trash"/></svg>';
      del.addEventListener('click', (e) => { e.stopPropagation(); deleteStamp(s); });
      del.addEventListener('pointerdown', (e) => e.stopPropagation());
      meta.append(nm, del);
      li.append(th, meta);
      li.addEventListener('pointerdown', (e) => stampPointerDown(e, s));
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); if (S.armed === s.id && S.pages.length) placeAtCenter(s.id); else arm(s.id); }
        if (e.key === ' ') { e.preventDefault(); arm(S.armed === s.id ? null : s.id); }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const sib = e.key === 'ArrowDown' ? li.nextElementSibling : li.previousElementSibling; if (sib) sib.focus(); }
        if (e.key === 'Delete') { e.preventDefault(); deleteStamp(s); }
      });
      ul.appendChild(li);
    }
    $('stampEmpty').hidden = S.stamps.length > 0;
    $('stampHint').hidden = !S.stamps.length || !S.pages.length;
    updateStorage();
  }

  async function updateStorage() {
    const el = $('storageInfo');
    if (!H.stamps.usage) { el.hidden = true; return; }
    try {
      const u = await H.stamps.usage();
      const pct = Math.round((u.used / u.total) * 100);
      el.textContent = t('panel.storage', { pct });
      el.hidden = pct < 40;
    } catch (e) { el.hidden = true; }
  }

  async function deleteStamp(s) {
    if (!(await ask(t('panel.deleteTitle', { name: s.name }), t('panel.deleteText'), { ok: t('panel.delete'), danger: true }))) return;
    if (s.kept) { try { await H.stamps.remove(s.id); } catch (e) { toast(t('err.storage'), true); return; } }
    S.stamps = S.stamps.filter((x) => x.id !== s.id);
    if (S.armed === s.id) arm(null);
    renderStamps();
  }

  function arm(id) {
    S.armed = id;
    $('viewer').classList.toggle('arming', !!id);
    for (const li of $('stampList').children) li.setAttribute('aria-selected', String(li.dataset.id === id));
    if (!id) removeGhost();
    else if (!S.pages.length) toast(t('panel.openFirst'));
  }

  // Click a stamp to arm it; drag it straight onto a page to place it there.
  function stampPointerDown(e, s) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const li = e.currentTarget;
    const x0 = e.clientX, y0 = e.clientY;
    let drag = null;
    const move = (ev) => {
      if (!drag && Math.hypot(ev.clientX - x0, ev.clientY - y0) > 6 && S.pages.length) {
        drag = document.createElement('div');
        drag.className = 'stamp-ghost';
        drag.style.position = 'fixed';
        drag.style.zIndex = '50';
        const img = document.createElement('img');
        img.src = S.urls.get(s.id);
        drag.appendChild(img);
        document.body.appendChild(drag);
      }
      if (drag) {
        const size = defaultSize(s, null);
        const w = size.w * S.zoom, h = size.h * S.zoom;
        drag.style.width = w + 'px'; drag.style.height = h + 'px';
        drag.style.left = ev.clientX - w / 2 + 'px'; drag.style.top = ev.clientY - h / 2 + 'px';
      }
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (drag) {
        drag.remove();
        const hit = pageAt(ev.clientX, ev.clientY);
        if (hit) placeStamp(s.id, hit.page, hit.x, hit.y);
      } else if (ev.type === 'pointerup') {
        li.focus();
        arm(S.armed === s.id ? null : s.id);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  function pageAt(cx, cy) {
    for (const e of S.pages) {
      const r = e.el.getBoundingClientRect();
      if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) return { page: e, x: (cx - r.left) / S.zoom, y: (cy - r.top) / S.zoom };
    }
    return null;
  }

  // Keyboard placing: the middle of what is visible of the current page.
  function placeAtCenter(id) {
    const p = S.pages[currentPage()];
    if (!p) return;
    const v = $('viewer').getBoundingClientRect(), r = p.el.getBoundingClientRect();
    const top = Math.max(r.top, v.top), bottom = Math.min(r.bottom, v.bottom);
    placeStamp(id, p, p.w / 2, clamp(((top + bottom) / 2 - r.top) / S.zoom, 0, p.h));
    arm(null);
  }

  function stampOf(id) { return S.stamps.find((s) => s.id === id); }
  function defaultSize(s, page) {
    const pw = page ? page.w : 595;
    let w = Math.min(170, pw * 0.32);
    let h = (w * s.h) / s.w;
    if (h > 110) { h = 110; w = (h * s.w) / s.h; }
    return { w, h };
  }

  // ── items ────────────────────────────────────────────────────────────────────────────────────
  function placeStamp(stampId, e, x, y) {
    const s = stampOf(stampId);
    if (!s) return;
    const before = snapshot();
    const size = defaultSize(s, e);
    const it = {
      id: uid(), stampId, page: e.key,
      cx: clamp(x, size.w / 2, e.w - size.w / 2), cy: clamp(y, size.h / 2, e.h - size.h / 2),
      w: size.w, h: size.h, rot: 0,
    };
    S.items.push(it);
    placeEl(it);
    select(it.id);
    commit(before);
    removeGhost();
    renderThumbs();
  }

  function placeEl(it) {
    const e = S.entries.get(it.page);
    if (!e) return;
    let el = it.el && it.el.isConnected ? it.el : null;
    if (!el) {
      el = document.createElement('div');
      el.className = 'item';
      el.dataset.id = it.id;
      const img = document.createElement('img');
      img.alt = '';
      img.draggable = false;
      img.src = S.urls.get(it.stampId) || '';
      el.appendChild(img);
      Object.defineProperty(it, 'el', { value: el, enumerable: false, writable: true, configurable: true });
    }
    if (el.parentNode !== e.layer) e.layer.appendChild(el);
    const z = S.zoom;
    el.style.left = (it.cx - it.w / 2) * z + 'px';
    el.style.top = (it.cy - it.h / 2) * z + 'px';
    el.style.width = it.w * z + 'px';
    el.style.height = it.h * z + 'px';
    el.style.transform = it.rot ? 'rotate(' + it.rot + 'deg)' : '';
  }

  function itemOf(id) { return S.items.find((i) => i.id === id); }
  function select(id) {
    S.sel = id;
    if (id) showSel(); else hideSel();
    updateButtons();
  }
  function showSel() {
    const it = itemOf(S.sel);
    const box = $('sel');
    if (!it) { hideSel(); return; }
    const e = S.entries.get(it.page);
    // on the page itself, not its clipped layer: the handles and tools may stick out of the paper
    if (box.parentNode !== e.el) e.el.appendChild(box);
    const z = S.zoom;
    box.style.left = (it.cx - it.w / 2) * z + 'px';
    box.style.top = (it.cy - it.h / 2) * z + 'px';
    box.style.width = it.w * z + 'px';
    box.style.height = it.h * z + 'px';
    box.style.transform = it.rot ? 'rotate(' + it.rot + 'deg)' : '';
    const tools = box.querySelector('.sel-tools');
    tools.style.transform = 'translateX(-50%) rotate(' + -it.rot + 'deg)';
    tools.style.top = (it.cy + it.h / 2) * z + 50 > e.h * z ? '-46px' : '';
    box.hidden = false;
  }
  function hideSel() { const b = $('sel'); b.hidden = true; document.body.appendChild(b); }

  function removeItem(id) {
    const it = itemOf(id);
    if (!it) return;
    const before = snapshot();
    if (it.el) it.el.remove();
    S.items = S.items.filter((i) => i.id !== id);
    if (S.sel === id) select(null);
    commit(before);
    renderThumbs();
  }
  function duplicate(id) {
    const it = itemOf(id);
    if (!it) return;
    const before = snapshot();
    const e = S.entries.get(it.page);
    const c = { id: uid(), stampId: it.stampId, page: it.page, w: it.w, h: it.h, rot: it.rot,
      cx: clamp(it.cx + 14, it.w / 2, e.w - it.w / 2), cy: clamp(it.cy + 14, it.h / 2, e.h - it.h / 2) };
    S.items.push(c);
    placeEl(c);
    select(c.id);
    commit(before);
  }
  // The same stamp, at the same place relative to the page, on every other page (initials on each sheet).
  function toAllPages(id) {
    const it = itemOf(id);
    if (!it) return;
    const before = snapshot();
    const src = S.entries.get(it.page);
    let n = 0;
    for (const e of S.pages) {
      if (e.key === it.page) continue;
      const fx = it.cx / src.w, fy = it.cy / src.h;
      const c = { id: uid(), stampId: it.stampId, page: e.key, w: it.w, h: it.h, rot: it.rot,
        cx: clamp(fx * e.w, it.w / 2, e.w - it.w / 2), cy: clamp(fy * e.h, it.h / 2, e.h - it.h / 2) };
      S.items.push(c);
      placeEl(c);
      n++;
    }
    commit(before);
    renderThumbs();
    toast(t('sel.allPagesDone', { count: n }));
  }

  // ── pointer gestures on the pages ──────────────────────────────────────────────────────────────
  let ghost = null;
  function removeGhost() { if (ghost) { ghost.remove(); ghost = null; } }
  function showGhost(e, x, y) {
    const s = stampOf(S.armed);
    if (!s) return;
    if (!ghost) {
      ghost = document.createElement('div');
      ghost.className = 'stamp-ghost';
      const img = document.createElement('img');
      img.src = S.urls.get(s.id);
      ghost.appendChild(img);
    }
    if (ghost.parentNode !== e.layer) e.layer.appendChild(ghost);
    const size = defaultSize(s, e);
    ghost.style.left = (x - size.w / 2) * S.zoom + 'px';
    ghost.style.top = (y - size.h / 2) * S.zoom + 'px';
    ghost.style.width = size.w * S.zoom + 'px';
    ghost.style.height = size.h * S.zoom + 'px';
  }

  function local(e, ev) {
    const r = e.el.getBoundingClientRect();
    return { x: (ev.clientX - r.left) / S.zoom, y: (ev.clientY - r.top) / S.zoom };
  }

  // Two fingers on the pages: pinch to zoom.
  const touches = new Map();
  let pinch = null;
  function pinchDown(ev) {
    if (ev.pointerType !== 'touch') return false;
    touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (touches.size === 2) {
      const [a, b] = Array.from(touches.values());
      const r = $('viewer').getBoundingClientRect();
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: S.zoom, c: { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top } };
      setFit(null);
      return true;
    }
    return false;
  }
  function pinchMove(ev) {
    if (!touches.has(ev.pointerId)) return;
    touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (!pinch || touches.size < 2) return;
    const [a, b] = Array.from(touches.values());
    applyZoom(pinch.z * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d), pinch.c);
  }
  function pinchUp(ev) { touches.delete(ev.pointerId); if (touches.size < 2) pinch = null; }

  function onPagesPointerDown(ev) {
    if (pinchDown(ev)) return;
    if (ev.button !== 0 && ev.pointerType === 'mouse') return;
    const pageEl = ev.target.closest('.page');
    if (ev.target.closest('.sel-tools')) return;
    if (!pageEl) { select(null); return; }
    const e = S.entries.get(pageEl.dataset.key);
    const handle = ev.target.closest('[data-h]');
    const itemEl = ev.target.closest('.item');
    if (handle && S.sel) { ev.preventDefault(); gesture(ev, itemOf(S.sel), handle.dataset.h); return; }
    if (itemEl) { ev.preventDefault(); const it = itemOf(itemEl.dataset.id); select(it.id); gesture(ev, it, 'move'); return; }
    if (S.armed) {
      ev.preventDefault();
      const pt = local(e, ev);
      placeStamp(S.armed, e, pt.x, pt.y);
      if (!ev.shiftKey) arm(null);                    // Shift keeps the stamp armed for several places
      return;
    }
    select(null);
  }

  function gesture(ev, it, kind) {
    if (!it) return;
    const before = snapshot();
    const e0 = S.entries.get(it.page);
    const start = local(e0, ev);
    const o = { cx: it.cx, cy: it.cy, w: it.w, h: it.h, rot: it.rot };
    const d0 = Math.hypot(start.x - o.cx, start.y - o.cy) || 1;
    const target = ev.target;
    try { target.setPointerCapture(ev.pointerId); } catch (err) { /* synthetic events */ }
    const move = (m) => {
      if (pinch) return;
      const e = S.entries.get(it.page);
      const pt = local(e, m);
      if (kind === 'move') {
        it.cx = clamp(o.cx + pt.x - start.x, 0, e.w);
        it.cy = clamp(o.cy + pt.y - start.y, 0, e.h);
      } else if (kind === 'rot') {
        let a = (Math.atan2(pt.y - o.cy, pt.x - o.cx) * 180) / Math.PI + 90;
        a = mod360(a);
        if (m.shiftKey) a = Math.round(a / 15) * 15;
        else for (const s of [0, 90, 180, 270, 360]) if (Math.abs(a - s) < 4) a = s;
        it.rot = Math.round(a % 360);
      } else {
        const k = Math.max(0.05, Math.hypot(pt.x - o.cx, pt.y - o.cy) / d0);
        const w = clamp(o.w * k, 12, e.w * 1.5);
        it.w = w; it.h = (o.h * w) / o.w;
      }
      placeEl(it);
      showSel();
    };
    const up = (u) => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      if (kind === 'move') {
        // Dropped over another page: the item moves there.
        const hit = pageAt(u.clientX, u.clientY);
        if (hit && hit.page.key !== it.page) {
          const grab = { x: start.x - o.cx, y: start.y - o.cy };
          it.page = hit.page.key;
          it.cx = clamp(hit.x - grab.x, 0, hit.page.w);
          it.cy = clamp(hit.y - grab.y, 0, hit.page.h);
          placeEl(it);
          showSel();
          renderThumbs();
        }
      }
      commit(before);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  }

  // ── search ───────────────────────────────────────────────────────────────────────────────────
  const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  async function textOf(e) {
    if (!S.text.has(e.key)) S.text.set(e.key, e.page.getTextContent().then((c) => c.items.filter((i) => typeof i.str === 'string' && i.str)));
    return S.text.get(e.key);
  }
  function openSearch() {
    if (!S.pages.length) return;
    $('searchBar').hidden = false;
    $('searchInput').focus();
    $('searchInput').select();
  }
  function closeSearch() {
    $('searchBar').hidden = true;
    S.search = { q: '', matches: [], i: -1, run: S.search.run + 1 };
    placeHighlights();
    $('searchCount').textContent = '';
  }
  async function runSearch(q) {
    const run = ++S.search.run;
    S.search.q = q; S.search.matches = []; S.search.i = -1;
    placeHighlights();
    const nq = fold(q.trim());
    if (nq.length < 2) { $('searchCount').textContent = ''; return; }
    $('searchCount').textContent = '…';
    for (const e of S.pages) {
      const items = await textOf(e).catch(() => []);
      if (run !== S.search.run) return;
      items.forEach((item, idx) => {
        const s = fold(item.str);
        let at = s.indexOf(nq);
        while (at >= 0) { S.search.matches.push({ key: e.key, item: idx, start: at, len: nq.length, n: s.length }); at = s.indexOf(nq, at + nq.length); }
      });
      if (S.search.matches.length && S.search.i < 0) { S.search.i = 0; await placeHighlights(); revealMatch(); }
    }
    placeHighlights();
    $('searchCount').textContent = S.search.matches.length ? (S.search.i + 1) + ' / ' + S.search.matches.length : t('search.none');
  }
  async function stepSearch(dir) {
    const m = S.search.matches;
    if (!m.length) return;
    S.search.i = (S.search.i + dir + m.length) % m.length;
    await placeHighlights();
    revealMatch();
    $('searchCount').textContent = (S.search.i + 1) + ' / ' + m.length;
  }
  function revealMatch() {
    const cur = document.querySelector('.hl.cur');
    if (cur) cur.scrollIntoView({ block: 'center', inline: 'nearest' });
  }
  let hlGen = 0;
  async function placeHighlights() {
    const gen = ++hlGen;
    const ms = S.search.matches;
    const z = S.zoom;
    const made = [];
    for (let k = 0; k < ms.length; k++) {
      const m = ms[k];
      const e = S.entries.get(m.key);
      if (!e || posOf(e) < 0) continue;
      const items = await textOf(e);
      const item = items[m.item];
      if (!item) continue;
      const vp = viewportOf(e, 1);
      const tm = pdfjs.Util.transform(vp.transform, item.transform);
      const fh = Math.hypot(tm[2], tm[3]);
      const ang = Math.atan2(tm[1], tm[0]);
      const len = item.width || 0;
      const off = (len * m.start) / m.n, w = Math.max(2, (len * m.len) / m.n);
      const bx = tm[4] + Math.cos(ang) * off, by = tm[5] + Math.sin(ang) * off;
      const d = document.createElement('div');
      d.className = 'hl' + (k === S.search.i ? ' cur' : '');
      d.style.left = bx * z + 'px';
      d.style.top = (by - fh) * z + 'px';
      d.style.width = w * z + 'px';
      d.style.height = fh * 1.15 * z + 'px';
      if (ang) d.style.transform = 'rotate(' + ang + 'rad)';
      made.push([e.layer, d]);
    }
    if (gen !== hlGen) return;                 // a newer call is drawing them
    for (const el of document.querySelectorAll('.hl')) el.remove();
    for (const [layer, d] of made) layer.appendChild(d);
  }

  // ── printing ─────────────────────────────────────────────────────────────────────────────────
  async function printDoc() {
    if (!S.pages.length) return;
    busy(t('busy.printing'));
    const root = $('printRoot');
    root.textContent = '';
    const urls = [];
    try {
      const imgs = new Map();
      for (const it of S.items) if (!imgs.has(it.stampId)) {
        const im = new Image(); im.src = S.urls.get(it.stampId); await im.decode().catch(() => {}); imgs.set(it.stampId, im);
      }
      for (const e of S.pages) {
        let s = 150 / 72;
        if (e.w * e.h * s * s > 12e6) s = Math.sqrt(12e6 / (e.w * e.h));
        const vp = viewportOf(e, s);
        const cv = document.createElement('canvas');
        cv.width = Math.floor(vp.width); cv.height = Math.floor(vp.height);
        const g = cv.getContext('2d');
        await e.page.render({ canvasContext: g, viewport: vp, intent: 'print', annotationMode: pdfjs.AnnotationMode.ENABLE_STORAGE }).promise;
        for (const it of S.items) {
          if (it.page !== e.key) continue;
          g.save();
          g.translate(it.cx * s, it.cy * s);
          g.rotate((it.rot * Math.PI) / 180);
          g.drawImage(imgs.get(it.stampId), (-it.w / 2) * s, (-it.h / 2) * s, it.w * s, it.h * s);
          g.restore();
        }
        const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
        const url = URL.createObjectURL(blob);
        urls.push(url);
        const img = document.createElement('img');
        img.src = url;
        img.alt = '';
        root.appendChild(img);
        await img.decode().catch(() => {});
      }
    } catch (err) { console.error(err); toast(t('err.print'), true); busy(''); return; }
    busy('');
    const done = () => { root.textContent = ''; urls.forEach((u) => URL.revokeObjectURL(u)); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    try { window.print(); } catch (err) { toast(t('err.print'), true); done(); }
  }

  // ── saving ───────────────────────────────────────────────────────────────────────────────────
  function savedName(signed) {
    const base = S.name.replace(/\.pdf$/i, '') || 'document';
    return base + ' - ' + t(signed ? 'save.suffix' : 'save.suffixEdited') + '.pdf';
  }
  function structural() {
    const main = S.sources[0];
    if (!main || S.pages.length !== main.pdf.numPages) return true;
    return S.pages.some((e, i) => e.src !== 0 || e.idx !== i);
  }
  async function save() {
    if (!S.pages.length) return;
    const bad = S.sources.find((s) => !s.writable);
    if (bad) { await ask(t('save.cannotTitle'), $('bannerText').textContent, { alert: true }); return; }
    const restructured = structural();
    const rotated = S.pages.some((e) => e.rot);
    if (!S.items.length && !restructured && !rotated) { toast(t('save.nothing')); return; }
    busy(t('busy.saving'));
    try {
      const used = Array.from(new Set(S.items.map((i) => i.stampId)));
      const images = [];
      for (const id of used) {
        const px = await IT.pixels(S.urls.get(id), 2400);
        images.push({ id, width: px.width, height: px.height, rgba: px.rgba });
      }
      const spec = (e) => {
        const its = S.items.filter((i) => i.page === e.key);
        const vp = viewportOf(e, 1);
        return { src: e.src, ref: e.ref, rotate: e.rot ? total(e) : undefined, draws: its.map((it) => ({ image: it.stampId, matrix: matrixOf(it, vp) })) };
      };
      if (S.pages.some((e) => !e.ref)) throw new Error('page without reference');
      const out = restructured
        ? await PdfWriter.build(S.sources.map((s) => s.bytes), { images, pages: S.pages.map((e) => Object.assign(spec(e), { rotate: total(e) })) })
        : await PdfWriter.stamp(S.sources[0].bytes, { images, pages: S.pages.filter((e) => e.rot || S.items.some((i) => i.page === e.key)).map(spec) });
      const name = savedName(S.items.length > 0);
      const r = await H.save(name, out);
      if (r.ok) { S.dirty = false; updateButtons(); toast(t(r.where === 'device' ? 'save.doneDevice' : 'save.done', { name: r.name || name })); }
      else if (r.code !== 'cancelled') toast(r.code === 'old-shell' ? t('err.oldShell') : r.code === 'busy' ? t('err.busySave') : t('err.save'), true);
    } catch (e) {
      console.error(e);
      toast(e && e.code === 'encrypted' ? t('err.encrypted') : t('err.save'), true);
    } finally { busy(''); }
  }

  // The image's unit square → PDF user space: bottom-left, bottom-right and top-left corners of the
  // item as SHOWN, each through the viewport's inverse transform.
  function matrixOf(it, vp) {
    const a = (it.rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    const corner = (dx, dy) => vp.convertToPdfPoint(it.cx + dx * c - dy * s, it.cy + dx * s + dy * c);
    const bl = corner(-it.w / 2, it.h / 2), br = corner(it.w / 2, it.h / 2), tl = corner(-it.w / 2, -it.h / 2);
    return [br[0] - bl[0], br[1] - bl[1], tl[0] - bl[0], tl[1] - bl[1], bl[0], bl[1]];
  }

  // ── the "new stamp" dialog ─────────────────────────────────────────────────────────────────────
  const NEW = {
    tab: 'draw', pad: null, drawInk: INKS[0].color, txtFont: 'script', txtInk: INKS[0].color, result: null,
    // image tab
    src: null, srcName: '', processed: null, imgInk: 'orig', mode: 'paper', key: [255, 255, 255],
    strokes: [], erasing: false, picking: false, bg: 'checker',
  };

  function swatches(holder, list, current, onPick) {
    holder.textContent = '';
    for (const it of list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch' + (it.id === 'orig' ? ' orig' : '');
      if (it.color) b.style.background = it.color;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(it.color === current || (it.id === 'orig' && current === 'orig')));
      b.title = t('ink.' + it.id);
      b.setAttribute('aria-label', t('ink.' + it.id));
      b.addEventListener('click', () => { onPick(it.color || 'orig'); swatches(holder, list, it.color || 'orig', onPick); });
      holder.appendChild(b);
    }
  }
  function segment(holder, attr, value) {
    for (const b of holder.querySelectorAll('[' + attr + ']')) b.setAttribute('aria-checked', String(b.getAttribute(attr) === value));
  }

  function setTab(tab) {
    NEW.tab = tab;
    for (const b of document.querySelectorAll('.tab[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    for (const s of document.querySelectorAll('.tabpane')) s.hidden = s.dataset.pane !== tab;
    if (tab === 'draw') requestAnimationFrame(() => NEW.pad.resize());
    if (tab === 'text') { renderText(); if (!$('txtValue').value) $('txtValue').focus(); }
    refreshOk();
  }

  function refreshOk() {
    let ok = false;
    if (NEW.tab === 'draw') ok = !NEW.pad.empty();
    if (NEW.tab === 'image') ok = !!NEW.processed;
    if (NEW.tab === 'text') ok = !!$('txtValue').value.trim();
    $('newOk').disabled = !ok;
    $('padHint').hidden = NEW.tab === 'draw' && !NEW.pad.empty();
  }

  // ── image tab: background removal tools ──
  let imgTimer = 0;
  function processImage(now) {
    clearTimeout(imgTimer);
    const run = () => {
      if (!NEW.src) return;
      const remove = $('imgRemove').checked;
      let c = remove
        ? IT.removeBackground(NEW.src, { mode: NEW.mode, key: NEW.key, strength: +$('imgTol').value, softness: +$('imgSoft').value, darken: +$('imgDark').value, ink: NEW.imgInk })
        : IT.recolor(NEW.src, NEW.imgInk);
      c = IT.erase(c, NEW.strokes);
      if (remove) {
        const sp = +$('imgSpeck').value / 100;
        IT.despeckle(c, Math.round(sp * sp * (c.width * c.height) / 1500));
      }
      NEW.processed = c;
      const pv = $('imgPreview');
      pv.width = c.width; pv.height = c.height;
      pv.getContext('2d').drawImage(c, 0, 0);
      $('bgTools').setAttribute('aria-disabled', String(!remove));
      refreshOk();
    };
    if (now) run(); else imgTimer = setTimeout(run, 50);
  }

  async function pickImage(file) {
    if (!file || !/^image\//.test(file.type || 'image/')) { if (file) toast(t('err.image'), true); return; }
    try {
      NEW.src = await IT.load(file);
      NEW.srcName = (file.name || '').replace(/\.[^.]+$/, '');
      NEW.strokes = [];
      NEW.key = IT.sample(NEW.src, 2, 2);
      setMode('paper');
      $('imgRemove').checked = !IT.hasTransparency(NEW.src);
      $('imgStage').hidden = false;
      $('imgEmpty').hidden = true;
      $('imgTools').hidden = false;
      $('imgEraseUndo').disabled = true;
      if (!$('newName').value) $('newName').value = NEW.srcName.slice(0, 40);
      processImage(true);
    } catch (e) { toast(t('err.image'), true); }
  }

  function setMode(mode) {
    NEW.mode = mode;
    segment($('bgMode'), 'data-mode', mode);
    $('imgPickColor').hidden = mode !== 'color';
    $('keyChip').style.background = 'rgb(' + NEW.key.join(',') + ')';
    setPicking(mode === 'color' && NEW.picking);
  }
  function setPicking(on) {
    NEW.picking = on;
    if (on) setErasing(false);
    $('imgPickColor').setAttribute('aria-pressed', String(on));
    $('imgStage').classList.toggle('picking', on);
  }
  function setErasing(on) {
    NEW.erasing = on;
    if (on) setPicking(false);
    $('imgEraser').setAttribute('aria-pressed', String(on));
    $('eraserRow').hidden = !on;
    $('imgStage').classList.toggle('erasing', on);
    if (!on) $('brush').hidden = true;
  }
  function setBgView(bg) {
    NEW.bg = bg;
    segment($('bgView'), 'data-bg', bg);
    $('imgStage').className = 'img-stage bg-' + bg + (NEW.erasing ? ' erasing' : '') + (NEW.picking ? ' picking' : '');
  }
  function rotateImage(dir) {
    if (!NEW.src) return;
    const W = NEW.src.width, Hh = NEW.src.height;
    NEW.src = IT.rotate90(NEW.src, dir);
    for (const s of NEW.strokes) s.pts = s.pts.map(([x, y]) => (dir > 0 ? [Hh - y, x] : [y, W - x]));
    processImage(true);
  }

  // Eraser strokes and the eyedropper, in the image's own pixels.
  function wireStage() {
    const pv = $('imgPreview');
    const brush = $('brush');
    const toSrc = (ev) => { const r = pv.getBoundingClientRect(); const k = pv.width / r.width; return { x: (ev.clientX - r.left) * k, y: (ev.clientY - r.top) * k, k, r }; };
    const showBrush = (ev) => {
      if (!NEW.erasing) return;
      const r = pv.getBoundingClientRect();
      const d = +$('brushSize').value;
      brush.hidden = false;
      brush.style.width = brush.style.height = d + 'px';
      brush.style.left = ev.clientX - r.left + 'px';
      brush.style.top = ev.clientY - r.top + 'px';
    };
    pv.addEventListener('pointermove', showBrush);
    pv.addEventListener('pointerleave', () => { brush.hidden = true; });
    pv.addEventListener('pointerdown', (ev) => {
      if (!NEW.src) return;
      const p = toSrc(ev);
      if (NEW.picking) {
        NEW.key = IT.sample(NEW.src, p.x, p.y);
        $('keyChip').style.background = 'rgb(' + NEW.key.join(',') + ')';
        setPicking(false);
        $('imgRemove').checked = true;
        processImage(true);
        return;
      }
      if (!NEW.erasing) return;
      ev.preventDefault();
      try { pv.setPointerCapture(ev.pointerId); } catch (err) { /* not a live pointer */ }
      const stroke = { size: +$('brushSize').value * p.k, pts: [[p.x, p.y]] };
      const g = pv.getContext('2d');
      const dab = (q) => {
        g.save(); g.globalCompositeOperation = 'destination-out';
        g.lineCap = 'round'; g.lineWidth = stroke.size;
        const last = stroke.pts[stroke.pts.length - 1];
        g.beginPath(); g.moveTo(last[0], last[1]); g.lineTo(q.x + 0.01, q.y); g.stroke(); g.restore();
      };
      dab(p);
      const move = (m) => { showBrush(m); const q = toSrc(m); dab(q); stroke.pts.push([q.x, q.y]); };
      const up = () => {
        pv.removeEventListener('pointermove', move);
        pv.removeEventListener('pointerup', up);
        pv.removeEventListener('pointercancel', up);
        NEW.strokes.push(stroke);
        $('imgEraseUndo').disabled = false;
        processImage(true);
      };
      pv.addEventListener('pointermove', move);
      pv.addEventListener('pointerup', up);
      pv.addEventListener('pointercancel', up);
    });
  }

  function renderText() {
    const v = $('txtValue').value.trim();
    const pv = $('txtPreview');
    const r = pv.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    pv.width = Math.max(1, r.width * dpr); pv.height = Math.max(1, r.height * dpr);
    const g = pv.getContext('2d');
    g.clearRect(0, 0, pv.width, pv.height);
    NEW.result = v ? IT.text(v, NEW.txtFont, NEW.txtInk) : null;
    if (NEW.result) {
      const k = Math.min((pv.width * 0.92) / NEW.result.width, (pv.height * 0.8) / NEW.result.height);
      const w = NEW.result.width * k, h = NEW.result.height * k;
      g.drawImage(NEW.result, (pv.width - w) / 2, (pv.height - h) / 2, w, h);
    }
    refreshOk();
  }

  function openNew() {
    $('newName').value = '';
    $('newKeep').checked = true;
    NEW.result = null; NEW.src = null; NEW.processed = null; NEW.strokes = [];
    $('imgStage').hidden = true; $('imgEmpty').hidden = false; $('imgTools').hidden = true;
    setErasing(false); setPicking(false);
    $('txtValue').value = '';
    NEW.pad.clear();
    $('dlgNew').showModal();
    setTab(NEW.tab);
  }

  async function createStamp() {
    const kind = NEW.tab;
    let c = null;
    if (kind === 'draw') c = NEW.pad.export();
    else if (kind === 'image') c = NEW.processed ? IT.trim(NEW.processed, 0.03) : null;
    else c = NEW.result;
    if (!c) { toast(t('err.emptyStamp'), true); return false; }
    const enc = IT.encode(c, H.stampMaxSide, H.compactStamps);
    const fallback = kind === 'draw' ? t('new.defaultSign') : kind === 'text' ? $('txtValue').value.trim() : NEW.srcName || t('new.defaultStamp');
    const meta = { id: uid(), name: ($('newName').value.trim() || fallback).slice(0, 40), kind, w: enc.width, h: enc.height };
    const keep = $('newKeep').checked;
    if (keep) {
      try { await H.stamps.put(meta, enc.url); }
      catch (e) {
        toast(e && e.code === 'full' ? t('err.full') : t('err.storage'), true);
        return false;
      }
    }
    S.urls.set(meta.id, enc.url);
    S.stamps.push(Object.assign(meta, { kept: keep }));
    renderStamps();
    setPanelTab('stamps');
    arm(meta.id);
    if (S.pages.length) toast(t('new.placeHint'));
    return true;
  }

  function wireNew() {
    NEW.pad = new IT.Pad($('pad'), { color: NEW.drawInk, width: +$('drawWidth').value });
    NEW.pad.onchange = refreshOk;
    window.addEventListener('resize', () => { if ($('dlgNew').open && NEW.tab === 'draw') NEW.pad.resize(); });
    const paintSwatches = () => {
      swatches($('drawColors'), INKS, NEW.drawInk, (c) => { NEW.drawInk = c; NEW.pad.color = c; NEW.pad.draw(); });
      swatches($('imgColors'), [{ id: 'orig' }].concat(INKS), NEW.imgInk, (c) => { NEW.imgInk = c; processImage(); });
      swatches($('txtColors'), INKS, NEW.txtInk, (c) => { NEW.txtInk = c; renderText(); });
    };
    paintSwatches();
    H.onLang(paintSwatches);
    $('drawWidth').addEventListener('input', () => { NEW.pad.width = +$('drawWidth').value; NEW.pad.draw(); });
    $('padClear').addEventListener('click', () => NEW.pad.clear());
    for (const b of document.querySelectorAll('.tab[data-tab]')) b.addEventListener('click', () => setTab(b.dataset.tab));

    $('imgPick').addEventListener('click', () => $('fileImg').click());
    $('imgReplace').addEventListener('click', () => $('fileImg').click());
    $('fileImg').addEventListener('change', (e) => { pickImage(e.target.files[0]); e.target.value = ''; });
    $('imgRemove').addEventListener('change', () => processImage(true));
    for (const id of ['imgTol', 'imgSoft', 'imgSpeck', 'imgDark']) $(id).addEventListener('input', () => processImage());
    for (const b of $('bgMode').querySelectorAll('[data-mode]')) b.addEventListener('click', () => { setMode(b.dataset.mode); if (b.dataset.mode === 'color') setPicking(true); $('imgRemove').checked = true; processImage(true); });
    for (const b of $('bgView').querySelectorAll('[data-bg]')) b.addEventListener('click', () => setBgView(b.dataset.bg));
    $('imgPickColor').addEventListener('click', () => setPicking(!NEW.picking));
    $('imgEraser').addEventListener('click', () => setErasing(!NEW.erasing));
    $('imgEraseUndo').addEventListener('click', () => { NEW.strokes.pop(); $('imgEraseUndo').disabled = !NEW.strokes.length; processImage(true); });
    $('imgRotL').addEventListener('click', () => rotateImage(-1));
    $('imgRotR').addEventListener('click', () => rotateImage(1));
    wireStage();
    setBgView('checker');
    const drop = $('imgDrop');
    drop.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.add('dragging'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.remove('dragging'); pickImage(e.dataTransfer.files[0]); });

    $('txtValue').addEventListener('input', renderText);
    $('txtDate').addEventListener('click', () => {
      $('txtValue').value = new Date().toLocaleDateString(H.lang || undefined, { day: '2-digit', month: '2-digit', year: 'numeric' });
      renderText();
    });
    const fonts = $('txtFonts');
    const paintFonts = () => {
      fonts.textContent = '';
      for (const f of ['script', 'serif', 'sans']) {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', String(NEW.txtFont === f));
        b.textContent = t('font.' + f);
        b.addEventListener('click', () => { NEW.txtFont = f; paintFonts(); renderText(); });
        fonts.appendChild(b);
      }
    };
    paintFonts();
    H.onLang(paintFonts);
    $('newForm').addEventListener('submit', async (e) => {
      if (e.submitter && e.submitter.value === 'ok') {
        e.preventDefault();
        if (await createStamp() !== false) $('dlgNew').close();
      }
    });
  }

  // ── buttons, keys, files ───────────────────────────────────────────────────────────────────────
  function updateButtons() {
    $('btnUndo').disabled = !S.undo.length;
    $('btnRedo').disabled = !S.redo.length;
    $('btnSave').disabled = !S.pages.length || (!S.items.length && !S.dirty);
    $('stampHint').hidden = !S.stamps.length || !S.pages.length;
  }

  function onKey(e) {
    const tgt = e.target instanceof Element ? e.target : document.body;
    const inField = tgt.closest('input, textarea, select, dialog[open]');
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'o') { e.preventDefault(); pickOpen(); return; }
    if (mod && k === 's') { e.preventDefault(); save(); return; }
    if (mod && k === 'f') { e.preventDefault(); openSearch(); return; }
    if (mod && k === 'p') { e.preventDefault(); printDoc(); return; }
    if (e.key === 'F3' || (mod && k === 'g')) { e.preventDefault(); stepSearch(e.shiftKey ? -1 : 1); return; }
    if (inField) return;
    if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && k === 'y') { e.preventDefault(); redo(); return; }
    if (mod && k === 'd' && S.sel) { e.preventDefault(); duplicate(S.sel); return; }
    if (!S.pages.length) return;
    if ((e.key === '+' || e.key === '=') && !mod) { e.preventDefault(); stepZoom(1); return; }
    if (e.key === '-' && !mod) { e.preventDefault(); stepZoom(-1); return; }
    if (e.key === '0' && !mod) { e.preventDefault(); setFit('width'); return; }
    if (k === 'r' && !mod && !S.sel) { e.preventDefault(); rotatePages(targetPages(), e.shiftKey ? -1 : 1); return; }
    if (e.key === 'Escape') { if (!$('searchBar').hidden) closeSearch(); else if (S.armed) arm(null); else select(null); return; }
    if (e.key === 'Enter' && S.armed && !tgt.closest('button, [role="option"]')) { e.preventDefault(); placeAtCenter(S.armed); return; }
    if (!S.sel) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeItem(S.sel); return; }
    const step = e.shiftKey ? 10 : 1;
    const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (dir) {
      e.preventDefault();
      const it = itemOf(S.sel);
      const before = snapshot();
      const p = S.entries.get(it.page);
      it.cx = clamp(it.cx + dir[0] * step, 0, p.w);
      it.cy = clamp(it.cy + dir[1] * step, 0, p.h);
      placeEl(it); showSel();
      commit(before);
    }
  }

  function wire() {
    $('btnOpen').addEventListener('click', () => pickOpen());
    $('btnOpen2').addEventListener('click', () => pickOpen());
    $('filePdf').addEventListener('change', (e) => { openFile(e.target.files[0]); e.target.value = ''; });
    $('fileInsert').addEventListener('change', (e) => { insertFiles(Array.from(e.target.files)); e.target.value = ''; });
    $('btnSave').addEventListener('click', save);
    $('btnUndo').addEventListener('click', undo);
    $('btnRedo').addEventListener('click', redo);
    $('btnZoomIn').addEventListener('click', () => stepZoom(1));
    $('btnZoomOut').addEventListener('click', () => stepZoom(-1));
    $('btnZoomVal').addEventListener('click', () => setFit('width'));
    $('btnFitW').addEventListener('click', () => setFit('width'));
    $('btnFitP').addEventListener('click', () => setFit('page'));
    $('btnRotL').addEventListener('click', () => rotatePages(targetPages(), -1));
    $('btnRotR').addEventListener('click', () => rotatePages(targetPages(), 1));
    $('btnSearch').addEventListener('click', () => ($('searchBar').hidden ? openSearch() : closeSearch()));
    $('btnPrint').addEventListener('click', printDoc);
    $('pgRotL').addEventListener('click', () => rotatePages(targetPages(), -1));
    $('pgRotR').addEventListener('click', () => rotatePages(targetPages(), 1));
    $('pgDel').addEventListener('click', () => deletePages(targetPages()));
    $('pgInsert').addEventListener('click', () => { if (S.pages.length) pickInsert(); else toast(t('panel.openFirst')); });
    for (const b of document.querySelectorAll('[data-ptab]')) b.addEventListener('click', () => setPanelTab(b.dataset.ptab));
    $('btnPanel').addEventListener('click', () => {
      const off = $('app').classList.toggle('no-panel');
      $('btnPanel').setAttribute('aria-pressed', String(!off));
      S.prefs.panel = !off;
      H.prefs.set(S.prefs).catch(() => {});
      if (S.fit && S.pages.length) requestAnimationFrame(() => applyZoom(fitZoom()));
    });
    $('btnNewStamp').addEventListener('click', openNew);
    $('pageInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { const n = parseInt($('pageInput').value, 10); if (n > 0) goPage(n - 1); $('pageInput').blur(); }
    });
    let searchTimer = 0;
    $('searchInput').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => runSearch($('searchInput').value), 250); });
    $('searchInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); if ($('searchInput').value !== S.search.q) runSearch($('searchInput').value); else stepSearch(e.shiftKey ? -1 : 1); }
      if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
    });
    $('searchNext').addEventListener('click', () => stepSearch(1));
    $('searchPrev').addEventListener('click', () => stepSearch(-1));
    $('searchClose').addEventListener('click', closeSearch);
    $('sel').addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b || !S.sel) return;
      if (b.dataset.act === 'del') removeItem(S.sel);
      if (b.dataset.act === 'dup') duplicate(S.sel);
      if (b.dataset.act === 'all') toAllPages(S.sel);
    });

    const v = $('viewer');
    v.addEventListener('pointerdown', onPagesPointerDown);
    v.addEventListener('pointermove', (e) => {
      pinchMove(e);
      if (!S.armed || e.pointerType === 'touch') return;
      const pageEl = e.target.closest('.page');
      if (!pageEl) { removeGhost(); return; }
      const p = S.entries.get(pageEl.dataset.key);
      const pt = local(p, e);
      showGhost(p, pt.x, pt.y);
    });
    v.addEventListener('pointerup', pinchUp);
    v.addEventListener('pointercancel', pinchUp);
    v.addEventListener('pointerleave', removeGhost);
    let scrollRaf = 0;
    v.addEventListener('scroll', () => {
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = 0;
        if (document.activeElement !== $('pageInput')) $('pageInput').value = S.pages.length ? String(currentPage() + 1) : '';
        refreshThumbState();
      });
    });
    v.addEventListener('wheel', (e) => {
      if (!(e.ctrlKey || e.metaKey) || !S.pages.length) return;
      e.preventDefault();
      const r = v.getBoundingClientRect();
      stepZoom(e.deltaY < 0 ? 1 : -1, { x: e.clientX - r.left, y: e.clientY - r.top });
    }, { passive: false });
    v.addEventListener('dragover', (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) { e.preventDefault(); v.classList.add('dragging'); } });
    v.addEventListener('dragleave', () => v.classList.remove('dragging'));
    v.addEventListener('drop', (e) => {
      e.preventDefault();
      v.classList.remove('dragging');
      const f = Array.from(e.dataTransfer.files || []).find((x) => /pdf$/i.test(x.type) || /\.pdf$/i.test(x.name));
      if (f) openFile(f); else toast(t('err.notPdf'), true);
    });
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', () => { if (S.fit && S.pages.length) applyZoom(fitZoom()); });
    window.addEventListener('beforeunload', (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });
    H.onLang(() => {
      renderStamps();
      if (S.pages.length) { syncPages(); document.title = S.name + ' — ' + t('app.title'); updateBanner(); }
    });

    // A page that embeds the app on its own (no OS to follow) may offer a language choice.
    if (H.languages && H.setLang) {
      const sel = $('langPick');
      for (const l of H.languages) { const o = document.createElement('option'); o.value = l.code; o.textContent = l.name; sel.appendChild(o); }
      sel.value = H.lang;
      sel.hidden = false;
      sel.addEventListener('change', () => H.setLang(sel.value));
    }
  }

  // ── start ────────────────────────────────────────────────────────────────────────────────────
  (async function start() {
    await H.ready;
    startWorker();
    try { S.prefs = (await H.prefs.get()) || {}; } catch (e) { S.prefs = {}; }
    const narrow = window.innerWidth < 760;
    if (S.prefs.panel === false || (narrow && S.prefs.panel !== true)) { $('app').classList.add('no-panel'); $('btnPanel').setAttribute('aria-pressed', 'false'); }
    wire();
    wireNew();
    setPanelTab(S.prefs.tab === 'pages' ? 'pages' : 'stamps');
    await loadStamps();
    updateButtons();
    // A host that was started with a file (a desktop program opened with "Open with") hands it over.
    if (H.initialFile) {
      try {
        const f = await H.initialFile();
        if (f) await openFile(new File([f.bytes], f.name, { type: 'application/pdf' }));
      } catch (e) { console.error(e); }
    }
  })();
})();
