/* SPDX-License-Identifier: AGPL-3.0-or-later */
// runtime-fallback.js — for a device whose web OS has no /nucleo-app.js (firmware from before the shared
// web OS). Such a shell opens store apps in a same-origin frame, so the page can use its own files, this
// browser's storage, a file input and a download: the subset of NucleoApp the app needs, nothing more.
// Where /nucleo-app.js loaded, this file does nothing.
(function () {
  'use strict';
  if (window.NucleoApp) return;
  var LOCALES = { it: 'it-IT', en: 'en-US', es: 'es-ES', fr: 'fr-FR', de: 'de-DE' };
  var strings = {};
  var lang = 'en';
  var store = null;
  try { store = window.localStorage; store.getItem('x'); } catch (e) { store = null; }
  var mem = {};
  var key = function (k) { return 'nucleo.app.pdf-editor.' + k; };
  function getRaw(k) { return store ? store.getItem(key(k)) : (k in mem ? mem[k] : null); }
  function setRaw(k, v) { if (store) store.setItem(key(k), v); else mem[k] = v; }
  function delRaw(k) { if (store) store.removeItem(key(k)); else delete mem[k]; }

  function pickLang() {
    var l = '';
    try { l = (store && store.getItem('anima.lang')) || ''; } catch (e) {}
    l = (l || navigator.language || 'en').slice(0, 2).toLowerCase();
    return LOCALES[l] ? l : 'en';
  }
  function readJSON(url) {
    return fetch(url, { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : {}; }).catch(function () { return {}; });
  }
  function format(value, vars) {
    if (value && typeof value === 'object') {
      var n = vars && (vars.count != null ? vars.count : vars.n);
      var cat = 'other';
      try { cat = new Intl.PluralRules(LOCALES[lang] || 'en-US').select(Number(n)); } catch (e) {}
      value = value[cat] != null ? value[cat] : (value.other != null ? value.other : value.one);
    }
    if (typeof value !== 'string') return String(value);
    if (!vars) return value;
    return value.replace(/\{(\w+)\}/g, function (m, k) { return k in vars ? String(vars[k]) : m; });
  }
  function t(k, vars) { return format(Object.prototype.hasOwnProperty.call(strings, k) ? strings[k] : k, vars); }
  function apply(root) {
    var els = (root || document).querySelectorAll('[data-i18n],[data-i18n-attr]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i], vars;
      var a = el.getAttribute('data-i18n-args');
      if (a) { try { vars = JSON.parse(a); } catch (e) {} }
      var k = el.getAttribute('data-i18n');
      if (k) el.textContent = t(k, vars);
      var attr = el.getAttribute('data-i18n-attr');
      if (attr) attr.split(';').forEach(function (pair) {
        var j = pair.indexOf(':');
        if (j < 0) return;
        var name = pair.slice(0, j).trim(), kk = pair.slice(j + 1).trim();
        if (name && kk && !/^on/i.test(name)) el.setAttribute(name, t(kk, vars));
      });
    }
    document.documentElement.lang = lang;
  }

  var ready = Promise.resolve().then(function () {
    lang = pickLang();
    try { if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) document.documentElement.dataset.theme = 'light'; } catch (e) {}
    return Promise.all([readJSON('i18n.en.json'), lang === 'en' ? {} : readJSON('i18n.' + lang + '.json')]);
  }).then(function (p) {
    strings = Object.assign({}, p[0], p[1]);
    if (document.readyState === 'loading') return new Promise(function (r) { document.addEventListener('DOMContentLoaded', r, { once: true }); });
  }).then(function () { apply(); return { lang: lang, theme: { mode: document.documentElement.dataset.theme || 'dark' } }; });

  window.NucleoApp = {
    ready: ready,
    t: t,
    apply: apply,
    get lang() { return lang; },
    onLang: function () {},
    onTheme: function () {},
    kv: {
      get: function (k, fb) {
        try { var v = getRaw(k); return Promise.resolve(v == null ? (fb === undefined ? null : fb) : JSON.parse(v)); }
        catch (e) { return Promise.resolve(fb === undefined ? null : fb); }
      },
      set: function (k, v) { try { setRaw(k, JSON.stringify(v)); return Promise.resolve(); } catch (e) { return Promise.reject(e); } },
      remove: function (k) { delRaw(k); return Promise.resolve(); },
      all: function () {
        var out = {};
        if (store) { for (var i = 0; i < store.length; i++) { var s = store.key(i); if (s.indexOf(key('')) === 0) { try { out[s.slice(key('').length)] = JSON.parse(store.getItem(s)); } catch (e) {} } } }
        else for (var m in mem) { try { out[m] = JSON.parse(mem[m]); } catch (e) {} }
        return Promise.resolve(out);
      },
    },
    caps: { has: function () { return Promise.resolve(false); }, list: function () { return Promise.resolve([]); } },
    // No `files`: the app opens with its own file input. Saving is a plain download, which a same-origin frame may do.
    call: function (method, args) {
      if (method === 'file.save' && args && args.data) {
        var url = URL.createObjectURL(new Blob([args.data], { type: 'application/pdf' }));
        var a = document.createElement('a');
        a.href = url; a.download = args.name; a.style.display = 'none';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
        return Promise.resolve({ ok: true, where: 'download' });
      }
      return Promise.resolve({ ok: false, error: 'unsupported' });
    },
  };
})();
