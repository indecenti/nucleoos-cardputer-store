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

  // kv holds 64 KB for the whole app: stamps are stored small (WebP where possible) and counted.
  const KV_BUDGET = 60 * 1024;
  const keyOf = (id) => 'stamp.' + id;

  async function list() {
    const idx = await N.kv.get('stamps', []);
    return Array.isArray(idx) ? idx : [];
  }
  async function used() {
    try { return JSON.stringify(await N.kv.all()).length; } catch (e) { return 0; }
  }

  window.PdfEditorHost = {
    ready: N.ready,
    t: (k, v) => N.t(k, v),
    apply: (el) => N.apply(el),
    onLang: (fn) => N.onLang(fn),
    get lang() { return N.lang; },
    stampMaxSide: 560,
    compactStamps: true,
    stamps: {
      list,
      get: (id) => N.kv.get(keyOf(id), null),
      async put(meta, url) {
        if (await used() + url.length + 400 > KV_BUDGET) { const e = new Error('full'); e.code = 'full'; throw e; }
        await N.kv.set(keyOf(meta.id), url);
        const idx = (await list()).filter((m) => m.id !== meta.id);
        idx.push(meta);
        await N.kv.set('stamps', idx);
      },
      async remove(id) {
        await N.kv.set('stamps', (await list()).filter((m) => m.id !== id));
        await N.kv.remove(keyOf(id));
      },
      async usage() { return { used: await used(), total: KV_BUDGET }; },
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
    async save(name, bytes) {
      if (N.files) {
        try {
          const r = await N.files.save(name, bytes);
          return r ? { ok: true, where: r.where, name: r.name } : { ok: false, code: 'cancelled' };
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
