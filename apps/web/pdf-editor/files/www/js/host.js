/* SPDX-License-Identifier: AGPL-3.0-or-later */
// host.js — what the app needs from wherever it runs: strings, the stamp library, saving a file.
// In NucleoOS that is the shell, through nucleo-app.js (the app may run without an origin, so no
// browser storage and no downloads of its own). A page that embeds the app differently sets
// window.PdfEditorHost first, with the same shape, and this file steps aside.
(function () {
  'use strict';
  if (window.PdfEditorHost) return;
  const N = window.NucleoApp;
  const inShell = window.parent !== window;

  // Where the stamp images live. A shell with NucleoApp.files.app keeps them as FILES of the app on the device
  // (/data/apps/pdf-editor/files/, 64 MB): full-size PNGs, as many as the user wants. An older shell has only
  // kv (64 KB for the whole app): stamps are stored small (WebP) and counted. The index is in kv either way.
  const FILES = !!(N.files && N.files.app);
  const KV_BUDGET = 60 * 1024;
  const FILES_BUDGET = 64 * 1024 * 1024;
  const keyOf = (id) => 'stamp.' + id;
  const fileOf = (id, mime) => 'stamp-' + id + (mime === 'image/webp' ? '.webp' : mime === 'image/jpeg' ? '.jpg' : '.png');
  const MIME = { webp: 'image/webp', jpg: 'image/jpeg', png: 'image/png' };

  function urlToBytes(url) {
    const m = /^data:(image\/[a-z+]+);base64,(.*)$/.exec(url || '');
    if (!m) return null;
    const bin = atob(m[2]);
    const b = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
    return { mime: m[1], bytes: b };
  }
  function bytesToUrl(buf, mime) {
    const b = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return 'data:' + mime + ';base64,' + btoa(s);
  }

  async function list() {
    const idx = await N.kv.get('stamps', []);
    return Array.isArray(idx) ? idx : [];
  }
  async function used() {
    if (FILES) { try { return (await N.files.app.list()).reduce((t, e) => t + (e.size || 0), 0); } catch (e) { return 0; } }
    try { return JSON.stringify(await N.kv.all()).length; } catch (e) { return 0; }
  }
  // A stamp saved by an older version sits in kv: once files are available, it moves there (kv gets its room back).
  async function migrate(meta) {
    const url = await N.kv.get(keyOf(meta.id), null);
    const d = urlToBytes(url);
    if (!d) return null;
    await N.files.app.write(fileOf(meta.id, d.mime), d.bytes);
    const idx = (await list()).map((m) => (m.id === meta.id ? Object.assign({}, m, { file: fileOf(meta.id, d.mime) }) : m));
    await N.kv.set('stamps', idx);
    await N.kv.remove(keyOf(meta.id));
    return url;
  }

  window.PdfEditorHost = {
    ready: N.ready,
    t: (k, v) => N.t(k, v),
    apply: (el) => N.apply(el),
    onLang: (fn) => N.onLang(fn),
    get lang() { return N.lang; },
    stampMaxSide: FILES ? 1600 : 560,
    compactStamps: !FILES,
    stamps: {
      list,
      async get(id) {
        if (!FILES) return N.kv.get(keyOf(id), null);
        const meta = (await list()).find((m) => m.id === id);
        if (!meta) return null;
        if (!meta.file) return migrate(meta);
        const buf = await N.files.app.read(meta.file);
        return buf ? bytesToUrl(buf, MIME[meta.file.split('.').pop()] || 'image/png') : null;
      },
      async put(meta, url) {
        if (FILES) {
          const d = urlToBytes(url);
          if (!d) throw new Error('bad image');
          try { await N.files.app.write(fileOf(meta.id, d.mime), d.bytes); }
          catch (e) { const err = new Error('full'); err.code = e && /no-space|too-many|too-large/.test(e.message) ? 'full' : 'storage'; throw err; }
          meta = Object.assign({}, meta, { file: fileOf(meta.id, d.mime) });
        } else {
          if (await used() + url.length + 400 > KV_BUDGET) { const e = new Error('full'); e.code = 'full'; throw e; }
          await N.kv.set(keyOf(meta.id), url);
        }
        const idx = (await list()).filter((m) => m.id !== meta.id);
        idx.push(meta);
        await N.kv.set('stamps', idx);
      },
      async remove(id) {
        const meta = (await list()).find((m) => m.id === id);
        await N.kv.set('stamps', (await list()).filter((m) => m.id !== id));
        if (FILES && meta && meta.file) await N.files.app.remove(meta.file).catch(() => {});
        await N.kv.remove(keyOf(id));
      },
      async usage() { return { used: await used(), total: FILES ? FILES_BUDGET : KV_BUDGET }; },
    },
    prefs: {
      get: () => N.kv.get('prefs', {}),
      set: (p) => N.kv.set('prefs', p),
    },
    // Files go through the OS Open / Save sheets (NucleoApp.files): the user picks the device's storage or
    // the computer/phone in front of them, the same on every edition. A shell from before them has no
    // NucleoApp.files: opening then uses the app's own file input, and saving the bare file.save download
    // ('denied' on a shell older still, which the app explains).
    open: N.files ? async (opts) => {
      try {
        const got = await N.files.open({ types: ['pdf'], multiple: !!(opts && opts.multiple) });
        return got ? got.map((f) => new File([f.data], f.name, { type: 'application/pdf' })) : null;
      } catch (e) {
        if (e && e.code === 'unsupported') return undefined;      // the app falls back to its own input
        throw e;
      }
    } : null,
    async initialFile() {
      if (!N.files) return null;
      const f = await N.files.launched();
      return f ? { name: f.name, bytes: new Uint8Array(f.data) } : null;
    },
    // handle: the file this document was last saved to (from an earlier save): "Save" writes it again with
    // no sheet; without one it is "Save as".
    async save(name, bytes, handle) {
      if (N.files) {
        try {
          const r = await N.files.save(name, bytes, handle ? { handle } : undefined);
          return r ? { ok: true, where: r.where, name: r.name, handle: r.handle || null } : { ok: false, code: 'cancelled' };
        } catch (e) {
          return { ok: false, code: e && e.code === 'unsupported' ? 'old-shell' : e && e.code === 'busy' ? 'busy' : 'failed', error: String(e && e.message) };
        }
      }
      if (inShell) {
        const r = await N.call('file.save', { name, data: bytes }, 120000);
        if (r && r.ok) return { ok: true, where: 'download' };
        const err = String((r && r.error) || '');
        return { ok: false, code: /^denied|unknown/.test(err) ? 'old-shell' : err === 'busy' ? 'busy' : 'failed', error: err };
      }
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      return { ok: true, where: 'download' };
    },
  };
})();
