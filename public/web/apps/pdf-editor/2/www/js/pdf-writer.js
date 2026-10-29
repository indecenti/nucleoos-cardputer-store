/* SPDX-License-Identifier: AGPL-3.0-or-later */
// pdf-writer.js — adds images to the pages of an existing PDF as an INCREMENTAL UPDATE.
//
// The original bytes are kept exactly as they were; the new objects, the changed page objects and a new
// cross-reference section are appended after them. That is what a professional signing tool does:
// whatever the file held (forms, links, earlier digital signatures) stays valid for its revision, and
// the stamps are part of the page content, so every reader and printer shows them.
//
//   const out = await PdfWriter.stamp(bytes, {
//     images: [{ id, width, height, rgba }],                       // straight (not premultiplied) RGBA
//     pages:  [{ ref: { num, gen }, draws: [{ image: id, matrix: [a, b, c, d, e, f] }] }],
//   });                                                             // matrix maps the unit square to PDF space
//
// Only what that needs is parsed: the trailer chain (tables, streams, hybrids), object streams, the
// page objects and their inherited resources. A file whose cross-reference is broken is re-indexed by
// scanning it. Encrypted files are refused (PdfWriter.Error code 'encrypted').
(function (root) {
  'use strict';

  function PdfError(code, message) { const e = new Error(message || code); e.code = code; e.name = 'PdfWriterError'; return e; }

  // ── bytes and text ───────────────────────────────────────────────────────────────────────────────
  // The file is handled as a latin-1 string: one char per byte, so offsets match and nothing is lost.
  function latin1(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return s;
  }
  function toBytes(str) {
    const out = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
    return out;
  }
  function concat(parts) {
    let n = 0;
    for (const p of parts) n += p.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  async function pump(stream, input) {
    const chunks = [];
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    writer.write(input).catch(() => {});
    writer.close().catch(() => {});
    try {
      for (;;) { const r = await reader.read(); if (r.done) break; chunks.push(r.value); }
    } catch (e) {
      // A damaged stream (bad checksum, cut short): keep what was inflated, as every reader does.
      if (!chunks.length) throw e;
    }
    return concat(chunks);
  }
  const deflate = (bytes) => pump(new CompressionStream('deflate'), bytes);
  async function inflate(bytes) {
    try { return await pump(new DecompressionStream('deflate'), bytes); }
    catch (e) { return pump(new DecompressionStream('deflate-raw'), bytes.subarray(2)); }
  }

  // ── the PDF syntax ──────────────────────────────────────────────────────────────────────────────
  // Values: numbers/keywords/strings keep their source text (raw) so they are written back unchanged.
  const WS = '\x00\t\n\x0c\r ';
  const DELIM = '()<>[]{}/%';
  const isWS = (c) => WS.indexOf(c) >= 0;
  const isRegular = (c) => c !== '' && !isWS(c) && DELIM.indexOf(c) < 0;

  function Ref(num, gen) { this.num = num; this.gen = gen; }
  function Name(name) { this.name = name; }       // without the slash, still #-escaped as in the file
  function Raw(text) { this.text = text; }        // a number, string, keyword: written back as is
  function Dict(map) { this.map = map || new Map(); }
  Dict.prototype.get = function (k) { return this.map.get(k); };
  Dict.prototype.set = function (k, v) { this.map.set(k, v); return this; };
  Dict.prototype.has = function (k) { return this.map.has(k); };
  Dict.prototype.clone = function () { return new Dict(new Map(this.map)); };

  function Lexer(src, pos) { this.s = src; this.p = pos || 0; }
  Lexer.prototype.skip = function () {
    const s = this.s;
    for (;;) {
      while (this.p < s.length && isWS(s[this.p])) this.p++;
      if (s[this.p] === '%') { while (this.p < s.length && s[this.p] !== '\n' && s[this.p] !== '\r') this.p++; continue; }
      return;
    }
  };
  Lexer.prototype.token = function () {
    this.skip();
    const s = this.s, start = this.p, c = s[start];
    if (c === undefined) return null;
    if (c === '[' || c === ']' || c === '{' || c === '}') { this.p++; return c; }
    if (c === '<' && s[start + 1] === '<') { this.p += 2; return '<<'; }
    if (c === '>' && s[start + 1] === '>') { this.p += 2; return '>>'; }
    if (c === '<') { const e = s.indexOf('>', start); if (e < 0) throw PdfError('syntax', 'bad hex string'); this.p = e + 1; return new Raw(s.slice(start, e + 1)); }
    if (c === '(') {
      let depth = 0, i = start;
      for (; i < s.length; i++) {
        const ch = s[i];
        if (ch === '\\') { i++; continue; }
        if (ch === '(') depth++;
        else if (ch === ')' && --depth === 0) break;
      }
      this.p = i + 1;
      return new Raw(s.slice(start, i + 1));
    }
    if (c === '/') { let i = start + 1; while (isRegular(s[i])) i++; this.p = i; return new Name(s.slice(start + 1, i)); }
    let i = start;
    while (isRegular(s[i])) i++;
    if (i === start) { this.p++; return c; }             // a stray delimiter: ')' or '>'
    this.p = i;
    return s.slice(start, i);                          // a bare word: number, keyword, R, obj...
  };

  const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)$/;
  const INT_RE = /^\d+$/;
  // Parses one value. After it, lx.p is right after the value (and its stream keyword, if any).
  function parseValue(lx) {
    const t = lx.token();
    if (t === null) throw PdfError('syntax', 'unexpected end of file');
    if (t === '<<') {
      const d = new Dict();
      for (;;) {
        const save = lx.p;
        const k = lx.token();
        if (k === '>>') break;
        if (k === null) throw PdfError('syntax', 'unterminated dictionary');
        if (!(k instanceof Name)) { if (lx.p === save) lx.p++; continue; }   // tolerate junk keys
        const v = parseValue(lx);
        d.set(k.name, v);
      }
      return d;
    }
    if (t === '[') {
      const a = [];
      for (;;) {
        const save = lx.p;
        lx.skip();
        if (lx.s[lx.p] === ']') { lx.p++; break; }
        if (lx.p >= lx.s.length) throw PdfError('syntax', 'unterminated array');
        a.push(parseValue(lx));
        if (lx.p === save) lx.p++;
      }
      return a;
    }
    if (t instanceof Name || t instanceof Raw) return t;
    if (typeof t === 'string' && INT_RE.test(t)) {
      // "n g R" is a reference: look ahead without consuming when it is not.
      const save = lx.p;
      const g = lx.token();
      if (typeof g === 'string' && INT_RE.test(g)) {
        const r = lx.token();
        if (r === 'R') return new Ref(+t, +g);
      }
      lx.p = save;
      return new Raw(t);
    }
    if (typeof t === 'string' && (NUM_RE.test(t) || t === 'true' || t === 'false' || t === 'null')) return new Raw(t);
    return new Raw(t);                                 // anything else is kept verbatim
  }

  function serialize(v) {
    if (v instanceof Ref) return v.num + ' ' + v.gen + ' R';
    if (v instanceof Name) return '/' + v.name;
    if (v instanceof Raw) return v.text;
    if (v instanceof Dict) {
      let out = '<<';
      v.map.forEach((val, k) => { out += '/' + k + ' ' + serialize(val) + ' '; });
      return out + '>>';
    }
    if (Array.isArray(v)) return '[' + v.map(serialize).join(' ') + ']';
    if (typeof v === 'number') return fmt(v);
    if (typeof v === 'string') return v;
    throw PdfError('syntax', 'cannot write value');
  }
  function fmt(n) {
    if (!isFinite(n)) return '0';
    const r = Math.round(n * 10000) / 10000;
    return Object.is(r, -0) ? '0' : String(r);
  }
  const num = (v) => (v instanceof Raw && NUM_RE.test(v.text) ? +v.text : (typeof v === 'number' ? v : NaN));
  const nameOf = (v) => (v instanceof Name ? v.name : null);

  // ── the document ────────────────────────────────────────────────────────────────────────────────
  function Doc(bytes) {
    this.bytes = bytes;
    this.s = latin1(bytes);
    this.xref = new Map();          // num → { type: 1, offset, gen } | { type: 2, stm, idx }
    this.trailer = null;            // the newest trailer dictionary
    this.lastXref = -1;             // offset of the newest cross-reference section
    this.lastIsStream = false;
    this.maxNum = 0;
    this.cache = new Map();
    this.stmCache = new Map();
  }

  Doc.prototype.load = async function () {
    try {
      await this.readXrefChain();
      if (!this.trailer || !(this.trailer.get('Root') instanceof Ref)) throw PdfError('syntax', 'no root');
    } catch (e) {
      if (e && e.code === 'encrypted') throw e;
      await this.rebuild();
    }
    if (this.trailer.has('Encrypt')) throw PdfError('encrypted', 'the PDF is encrypted');
  };

  Doc.prototype.readXrefChain = async function () {
    const s = this.s;
    const at = s.lastIndexOf('startxref');
    if (at < 0) throw PdfError('syntax', 'no startxref');
    const lx = new Lexer(s, at + 9);
    let off = parseInt(lx.token(), 10);
    if (!(off >= 0 && off < s.length)) throw PdfError('syntax', 'bad startxref');
    this.lastXref = off;
    const seen = new Set();
    let first = true;
    while (off >= 0 && !seen.has(off)) {
      seen.add(off);
      const lx2 = new Lexer(s, off);
      lx2.skip();
      let trailer;
      if (s.startsWith('xref', lx2.p)) {
        trailer = this.readTable(lx2);
        if (first) this.lastIsStream = false;
        const stm = num(trailer.get('XRefStm'));
        if (stm >= 0) await this.readXrefStream(stm);            // hybrid file: the stream is part of this section
      } else {
        trailer = await this.readXrefStream(lx2.p);
        if (first) this.lastIsStream = true;
      }
      if (first) this.trailer = trailer;
      first = false;
      const prev = num(trailer.get('Prev'));
      off = prev >= 0 && prev < s.length ? prev : -1;
    }
  };

  Doc.prototype.setEntry = function (n, entry) {
    if (n > this.maxNum) this.maxNum = n;
    if (!this.xref.has(n)) this.xref.set(n, entry);          // newer sections are read first and win
  };

  Doc.prototype.readTable = function (lx) {
    lx.token();                                               // 'xref'
    for (;;) {
      const save = lx.p;
      const t = lx.token();
      if (t === 'trailer') break;
      if (typeof t !== 'string' || !INT_RE.test(t)) throw PdfError('syntax', 'bad xref table');
      const start = +t;
      const count = +lx.token();
      for (let i = 0; i < count; i++) {
        const o = lx.token(), g = lx.token(), kind = lx.token();
        if (kind === 'n') { const off = +o; if (off > 0) this.setEntry(start + i, { type: 1, offset: off, gen: +g }); }
        else if (kind === 'f') { if (!this.xref.has(start + i)) this.xref.set(start + i, { type: 0 }); }
        else throw PdfError('syntax', 'bad xref entry');
      }
      if (lx.p === save) throw PdfError('syntax', 'bad xref table');
    }
    const tr = parseValue(lx);
    if (!(tr instanceof Dict)) throw PdfError('syntax', 'bad trailer');
    return tr;
  };

  // "n g obj <<...>> stream" at offset: returns { num, gen, value, streamStart }.
  Doc.prototype.parseAt = function (offset) {
    const lx = new Lexer(this.s, offset);
    const n = lx.token(), g = lx.token(), kw = lx.token();
    if (kw !== 'obj' || !INT_RE.test(String(n)) || !INT_RE.test(String(g))) throw PdfError('syntax', 'no object at ' + offset);
    const value = parseValue(lx);
    const save = lx.p;
    const t = lx.token();
    let streamStart = -1;
    if (t === 'stream') {
      let p = lx.p;
      if (this.s[p] === '\r') p++;
      if (this.s[p] === '\n') p++;
      streamStart = p;
    } else lx.p = save;
    return { num: +n, gen: +g, value, streamStart };
  };

  Doc.prototype.streamBytes = function (dict, start) {
    let len = num(dict.get('Length'));
    const L = dict.get('Length');
    if (L instanceof Ref) {
      const e = this.xref.get(L.num);
      if (e && e.type === 1) { try { len = num(this.parseAt(e.offset).value); } catch (err) { len = NaN; } }
    }
    const s = this.s;
    const looksRight = (n) => n >= 0 && start + n <= s.length && /^\s*endstream/.test(s.slice(start + n, start + n + 20));
    if (!looksRight(len)) {
      const e = s.indexOf('endstream', start);
      if (e < 0) throw PdfError('syntax', 'unterminated stream');
      len = e - start;
      while (len > 0 && (s[start + len - 1] === '\n' || s[start + len - 1] === '\r')) len--;
    }
    return this.bytes.subarray(start, start + len);
  };

  Doc.prototype.decode = async function (dict, raw) {
    let filters = dict.get('Filter');
    let parms = dict.get('DecodeParms');
    if (!filters) return raw;
    if (!Array.isArray(filters)) { filters = [filters]; parms = [parms]; }
    if (!Array.isArray(parms)) parms = [parms];
    let data = raw;
    for (let i = 0; i < filters.length; i++) {
      const f = nameOf(filters[i]);
      if (f !== 'FlateDecode' && f !== 'Fl') throw PdfError('unsupported', 'filter ' + f);
      data = await inflate(data);
      const p = parms[i] instanceof Ref ? await this.get(parms[i]) : parms[i];
      if (p instanceof Dict && num(p.get('Predictor')) >= 10) data = unpredict(data, num(p.get('Columns')) || 1, num(p.get('Colors')) || 1, num(p.get('BitsPerComponent')) || 8);
    }
    return data;
  };

  function unpredict(data, columns, colors, bpc) {
    const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
    const rowLen = Math.ceil((columns * colors * bpc) / 8);
    const rows = Math.floor(data.length / (rowLen + 1));
    const out = new Uint8Array(rows * rowLen);
    let prev = new Uint8Array(rowLen);
    for (let r = 0; r < rows; r++) {
      const type = data[r * (rowLen + 1)];
      const row = data.subarray(r * (rowLen + 1) + 1, (r + 1) * (rowLen + 1));
      const cur = out.subarray(r * rowLen, (r + 1) * rowLen);
      for (let i = 0; i < rowLen; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
        let v = row[i];
        if (type === 1) v += a;
        else if (type === 2) v += b;
        else if (type === 3) v += (a + b) >> 1;
        else if (type === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
        cur[i] = v & 0xff;
      }
      prev = cur;
    }
    return out;
  }

  Doc.prototype.readXrefStream = async function (offset) {
    const o = this.parseAt(offset);
    const d = o.value;
    if (!(d instanceof Dict) || o.streamStart < 0) throw PdfError('syntax', 'bad xref stream');
    if (o.num > this.maxNum) this.maxNum = o.num;
    const data = await this.decode(d, this.streamBytes(d, o.streamStart));
    const W = (d.get('W') || []).map(num);
    const size = num(d.get('Size'));
    let index = d.get('Index');
    index = Array.isArray(index) ? index.map(num) : [0, size];
    const rec = W[0] + W[1] + W[2];
    if (!(rec > 0)) throw PdfError('syntax', 'bad xref stream widths');
    let p = 0;
    const field = (w, dflt) => { if (!w) return dflt; let v = 0; for (let i = 0; i < w; i++) v = v * 256 + data[p++]; return v; };
    for (let k = 0; k + 1 < index.length; k += 2) {
      const start = index[k], count = index[k + 1];
      for (let i = 0; i < count && p + rec <= data.length; i++) {
        const type = field(W[0], 1), f2 = field(W[1], 0), f3 = field(W[2], 0);
        const n = start + i;
        if (type === 1) this.setEntry(n, { type: 1, offset: f2, gen: f3 });
        else if (type === 2) this.setEntry(n, { type: 2, stm: f2, idx: f3 });
        else if (!this.xref.has(n)) this.xref.set(n, { type: 0 });
      }
    }
    return d;
  };

  // A file whose cross-reference cannot be read: find every "n g obj" and the newest trailer, as readers do.
  Doc.prototype.rebuild = async function () {
    this.xref = new Map(); this.maxNum = 0; this.cache.clear(); this.stmCache.clear();
    const s = this.s;
    const re = /(?:^|[\r\n\s])(\d{1,10})\s+(\d{1,5})\s+obj\b/g;
    let m;
    const found = new Map();
    while ((m = re.exec(s))) {
      const off = m.index + m[0].indexOf(m[1]);
      found.set(+m[1], { type: 1, offset: off, gen: +m[2] });     // a later copy of an object replaces an earlier one
    }
    found.forEach((e, n) => { this.xref.set(n, e); if (n > this.maxNum) this.maxNum = n; });
    // Objects that live inside object streams.
    for (const [n, e] of found) {
      let o;
      try { o = this.parseAt(e.offset); } catch (err) { continue; }
      if (o.value instanceof Dict && nameOf(o.value.get('Type')) === 'ObjStm' && o.streamStart >= 0) {
        try {
          const list = await this.objStmIndex(n);
          list.forEach((it, idx) => { if (!this.xref.has(it.num)) { this.xref.set(it.num, { type: 2, stm: n, idx }); if (it.num > this.maxNum) this.maxNum = it.num; } });
        } catch (err) { /* a broken object stream: skip it */ }
      }
    }
    // The trailer: the last "trailer" dictionary, or the last xref stream, or a catalog we can find.
    let tr = null;
    const t = s.lastIndexOf('trailer');
    if (t >= 0) { try { tr = parseValue(new Lexer(s, t + 7)); } catch (err) { tr = null; } }
    if (!(tr instanceof Dict) || !(tr.get('Root') instanceof Ref)) {
      tr = null;
      for (const [n, e] of found) {
        if (e.type !== 1) continue;
        let o; try { o = this.parseAt(e.offset); } catch (err) { continue; }
        if (o.value instanceof Dict && nameOf(o.value.get('Type')) === 'XRef' && o.value.get('Root') instanceof Ref) tr = o.value;
      }
    }
    if (!tr) {
      for (const n of this.xref.keys()) {
        let v; try { v = await this.get(new Ref(n, 0)); } catch (err) { continue; }
        if (v instanceof Dict && nameOf(v.get('Type')) === 'Catalog') { tr = new Dict().set('Root', new Ref(n, this.xref.get(n).gen || 0)); break; }
      }
    }
    if (!tr) throw PdfError('syntax', 'not a PDF this tool can read');
    this.trailer = tr;
    this.lastXref = -1;              // the old cross-reference is not trustworthy: write a complete table
    this.lastIsStream = false;
  };

  Doc.prototype.objStmIndex = async function (stmNum) {
    if (this.stmCache.has(stmNum)) return this.stmCache.get(stmNum);
    const e = this.xref.get(stmNum);
    if (!e || e.type !== 1) throw PdfError('syntax', 'object stream ' + stmNum + ' not found');
    const o = this.parseAt(e.offset);
    const d = o.value;
    const data = latin1(await this.decode(d, this.streamBytes(d, o.streamStart)));
    const n = num(d.get('N')), first = num(d.get('First'));
    const lx = new Lexer(data, 0);
    const list = [];
    for (let i = 0; i < n; i++) list.push({ num: +lx.token(), off: +lx.token() });
    const res = list.map((it) => ({ num: it.num, value: parseValue(new Lexer(data, first + it.off)) }));
    this.stmCache.set(stmNum, res);
    return res;
  };

  // Resolves a reference (or returns a direct value as is).
  Doc.prototype.get = async function (v) {
    if (!(v instanceof Ref)) return v;
    if (this.cache.has(v.num)) return this.cache.get(v.num);
    const e = this.xref.get(v.num);
    let out = null;
    if (e && e.type === 1) out = this.parseAt(e.offset).value;
    else if (e && e.type === 2) { const list = await this.objStmIndex(e.stm); out = list[e.idx] ? list[e.idx].value : null; }
    this.cache.set(v.num, out);
    return out;
  };

  // ── writing ─────────────────────────────────────────────────────────────────────────────────────
  async function imageObjects(img) {
    const n = img.width * img.height;
    const rgb = new Uint8Array(n * 3);
    const alpha = new Uint8Array(n);
    let opaque = true;
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      rgb[i * 3] = img.rgba[j]; rgb[i * 3 + 1] = img.rgba[j + 1]; rgb[i * 3 + 2] = img.rgba[j + 2];
      alpha[i] = img.rgba[j + 3];
      if (alpha[i] !== 255) opaque = false;
    }
    return { rgb: await deflate(rgb), alpha: opaque ? null : await deflate(alpha) };
  }

  // The images, each written once however many times it is drawn. → Map(id → object number)
  async function writeImages(images, add) {
    const out = new Map();
    for (const img of images || []) {
      if (!(img.width > 0 && img.height > 0) || !img.rgba || img.rgba.length < img.width * img.height * 4) throw PdfError('input', 'bad image');
      const enc = await imageObjects(img);
      let smask = '';
      if (enc.alpha) {
        const sm = add('<</Type/XObject/Subtype/Image/Width ' + img.width + '/Height ' + img.height +
          '/ColorSpace/DeviceGray/BitsPerComponent 8/Filter/FlateDecode/Length ' + enc.alpha.length + '>>', enc.alpha);
        smask = '/SMask ' + sm + ' 0 R';
      }
      out.set(img.id, add('<</Type/XObject/Subtype/Image/Width ' + img.width + '/Height ' + img.height +
        '/ColorSpace/DeviceRGB/BitsPerComponent 8/Interpolate true' + smask + '/Filter/FlateDecode/Length ' + enc.rgb.length + '>>', enc.rgb));
    }
    return out;
  }

  const INHERITED = ['Resources', 'MediaBox', 'CropBox', 'Rotate'];
  // A page attribute, from the page or the nearest ancestor that has it (unresolved, source space).
  async function inherited(doc, page, key) {
    let node = page, guard = 0;
    while (node instanceof Dict && guard++ < 64) {
      if (node.has(key)) return node.get(key);
      node = node.get('Parent') ? await doc.get(node.get('Parent')) : null;
    }
    return undefined;
  }

  // Draws images on a page: XObjects added to its resources, the old content wrapped in q/Q so whatever
  // state it leaves cannot move the stamps. `page` is the source dictionary, `np` the one being written;
  // conv turns a source value into a target one (identity for an incremental update, a deep copy when
  // the whole file is rewritten).
  async function addDraws(doc, page, np, draws, imageRef, add, conv) {
    const res = await doc.get(await inherited(doc, page, 'Resources'));
    let nres = res instanceof Dict ? await conv(res) : new Dict();
    nres = nres === res ? res.clone() : nres;
    const xo = await doc.get(res instanceof Dict ? res.get('XObject') : undefined);
    let nxo = xo instanceof Dict ? await conv(xo) : new Dict();
    nxo = nxo === xo ? xo.clone() : nxo;
    let ops = '';
    let k = 0;
    for (const d of draws) {
      const imNum = imageRef.get(d.image);
      if (!imNum) throw PdfError('input', 'unknown image ' + d.image);
      let nm;
      do { nm = 'NcStamp' + (++k); } while (nxo.has(nm));
      nxo.set(nm, new Ref(imNum, 0));
      ops += 'q ' + d.matrix.map(fmt).join(' ') + ' cm /' + nm + ' Do Q\n';
    }
    nres.set('XObject', nxo);
    np.set('Resources', nres);
    const contents = page.get('Contents');
    let list = [];
    if (contents instanceof Ref) {
      const target = await doc.get(contents);
      list = Array.isArray(target) ? target : [contents];
    } else if (Array.isArray(contents)) list = contents;
    const mapped = [];
    for (const c of list) mapped.push(await conv(c));
    if (mapped.length) {
      const pre = add('<</Length 2>>', toBytes('q\n'));
      const post = toBytes('\nQ\n' + ops);
      const tail = add('<</Length ' + post.length + '>>', post);
      np.set('Contents', [new Ref(pre, 0)].concat(mapped, [new Ref(tail, 0)]));
    } else {
      const body = toBytes(ops);
      np.set('Contents', new Ref(add('<</Length ' + body.length + '>>', body), 0));
    }
  }

  const same = async (v) => v;

  // Incremental update: stamps and page rotations appended after the untouched original.
  //   pages: [{ ref, draws?, rotate? }]   rotate = the page's new /Rotate (0, 90, 180, 270)
  async function stamp(input, spec) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const doc = new Doc(bytes);
    await doc.load();
    let next = Math.max(doc.maxNum + 1, num(doc.trailer.get('Size')) || 0);
    const objects = [];                 // { num, gen, head (string), body (Uint8Array|null) }
    const add = (head, body, gen) => { const n = next++; objects.push({ num: n, gen: gen || 0, head, body }); return n; };
    const imageRef = await writeImages(spec.images, add);

    for (const pg of spec.pages || []) {
      const hasDraws = pg.draws && pg.draws.length;
      if (!hasDraws && pg.rotate == null) continue;
      const ref = new Ref(pg.ref.num, pg.ref.gen || 0);
      const page = await doc.get(ref);
      if (!(page instanceof Dict)) throw PdfError('syntax', 'page ' + ref.num + ' not found');
      const np = page.clone();
      if (pg.rotate != null) np.set('Rotate', new Raw(String(((pg.rotate % 360) + 360) % 360)));
      if (hasDraws) await addDraws(doc, page, np, pg.draws, imageRef, add, same);
      objects.push({ num: ref.num, gen: ref.gen, head: serialize(np), body: null });
    }

    // Append: objects, then the cross-reference section and trailer.
    const parts = [bytes];
    let pos = bytes.length;
    const last = bytes[bytes.length - 1];
    if (last !== 0x0a && last !== 0x0d) { parts.push(toBytes('\n')); pos++; }
    const offsets = new Map();
    for (const o of objects) {
      offsets.set(o.num, { offset: pos, gen: o.gen });
      const head = toBytes(o.num + ' ' + o.gen + ' obj\n' + o.head + (o.body ? '\nstream\n' : '\nendobj\n'));
      parts.push(head); pos += head.length;
      if (o.body) { const tail = toBytes('\nendstream\nendobj\n'); parts.push(o.body, tail); pos += o.body.length + tail.length; }
    }

    const tr = doc.trailer;
    const keep = (d) => { for (const k of ['Root', 'Info', 'ID']) if (tr.has(k)) d.set(k, tr.get(k)); return d; };
    // A re-indexed file gets one complete section (no /Prev), so readers never fall back to the broken one.
    const rebuilt = doc.lastXref < 0;
    const entries = new Map();          // num → [type, field2, field3]
    if (rebuilt) {
      entries.set(0, [0, 0, 65535]);
      doc.xref.forEach((e, n) => {
        if (e.type === 1) entries.set(n, [1, e.offset, e.gen]);
        else if (e.type === 2) entries.set(n, [2, e.stm, e.idx]);
      });
    }
    offsets.forEach((e, n) => entries.set(n, [1, e.offset, e.gen]));
    const hasCompressed = Array.from(entries.values()).some((e) => e[0] === 2);
    let size = Math.max(next, num(tr.get('Size')) || 0);

    if ((doc.lastIsStream && !rebuilt) || hasCompressed) {
      // Cross-reference stream: what the file already uses, or the only way to point into object streams.
      const self = next++;
      size = Math.max(size, next);
      entries.set(self, [1, pos, 0]);
      const nums = Array.from(entries.keys()).sort((p, q) => p - q);
      const index = [];
      const rows = [];
      for (let i = 0; i < nums.length; i++) {
        if (i === 0 || nums[i] !== nums[i - 1] + 1) index.push(nums[i], 0);
        index[index.length - 1]++;
        const e = entries.get(nums[i]);
        rows.push(e[0], (e[1] >>> 24) & 255, (e[1] >>> 16) & 255, (e[1] >>> 8) & 255, e[1] & 255, (e[2] >> 8) & 255, e[2] & 255);
      }
      const data = new Uint8Array(rows);
      const d = keep(new Dict().set('Type', new Name('XRef')).set('Size', new Raw(String(size))));
      d.set('Index', index.map((v) => new Raw(String(v)))).set('W', [new Raw('1'), new Raw('4'), new Raw('2')]);
      if (!rebuilt) d.set('Prev', new Raw(String(doc.lastXref)));
      d.set('Length', new Raw(String(data.length)));
      parts.push(toBytes(self + ' 0 obj\n' + serialize(d) + '\nstream\n'), data, toBytes('\nendstream\nendobj\nstartxref\n' + pos + '\n%%EOF\n'));
      return concat(parts);
    }

    const nums = Array.from(entries.keys()).sort((p, q) => p - q);
    let x = 'xref\n';
    for (let i = 0; i < nums.length;) {
      let j = i;
      while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
      x += nums[i] + ' ' + (j - i + 1) + '\n';
      for (let q = i; q <= j; q++) {
        const e = entries.get(nums[q]);
        x += String(e[1]).padStart(10, '0') + ' ' + String(e[2]).padStart(5, '0') + (e[0] === 0 ? ' f' : ' n') + '\r\n';
      }
      i = j + 1;
    }
    const d = keep(new Dict().set('Size', new Raw(String(size))));
    if (!rebuilt) d.set('Prev', new Raw(String(doc.lastXref)));
    x += 'trailer\n' + serialize(d) + '\nstartxref\n' + pos + '\n%%EOF\n';
    parts.push(toBytes(x));
    return concat(parts);
  }

  // Every page object of a document, in order.
  async function pageRefs(doc) {
    const out = [];
    const seen = new Set();
    const walk = async (ref, depth) => {
      if (!(ref instanceof Ref) || seen.has(ref.num) || depth > 64) return;
      seen.add(ref.num);
      const n = await doc.get(ref);
      if (!(n instanceof Dict)) return;
      if (nameOf(n.get('Type')) === 'Pages' || n.has('Kids')) { for (const k of (await doc.get(n.get('Kids'))) || []) await walk(k, depth + 1); }
      else out.push(ref);
    };
    const cat = await doc.get(doc.trailer.get('Root'));
    if (cat instanceof Dict) await walk(cat.get('Pages'), 0);
    return out;
  }

  // A value with its raw stream (still encoded), for copying between files.
  Doc.prototype.getFull = async function (ref) {
    const e = this.xref.get(ref.num);
    if (e && e.type === 1) {
      const o = this.parseAt(e.offset);
      return { value: o.value, stream: o.streamStart >= 0 && o.value instanceof Dict ? this.streamBytes(o.value, o.streamStart) : null };
    }
    return { value: await this.get(ref), stream: null };
  };

  // Catalog entries that travel with the document (from the first source).
  const CATALOG_KEEP = ['AcroForm', 'Outlines', 'Names', 'Dests', 'Lang', 'MarkInfo', 'ViewerPreferences', 'PageMode', 'PageLayout', 'Metadata', 'StructTreeRoot', 'OCProperties'];

  // A NEW file with exactly these pages, in this order, from one or more source PDFs: what deleting,
  // reordering and merging pages need. Only what the kept pages reach is copied, so a deleted page is
  // really gone (an incremental update would leave it in the previous revision); references to pages
  // that are not kept become null.
  //   build([bytesA, bytesB], { images, pages: [{ src, ref, rotate?, draws? }] })
  async function build(sourceBytes, spec) {
    const docs = [];
    for (const b of sourceBytes) { const d = new Doc(b instanceof Uint8Array ? b : new Uint8Array(b)); await d.load(); docs.push(d); }
    const allPages = [];
    for (const d of docs) allPages.push(new Set((await pageRefs(d)).map((r) => r.num)));
    if (!spec.pages || !spec.pages.length) throw PdfError('input', 'no pages');

    let next = 1;
    const objects = [];
    const add = (head, body) => { const n = next++; objects.push({ num: n, gen: 0, head, body }); return n; };
    const reserve = () => next++;
    const map = new Map();               // "src:num" → new number
    const queue = [];
    const pagesNode = reserve();
    const kept = new Map();              // "src:num" → new number, for the pages in the result
    for (const pg of spec.pages) {
      const key = pg.src + ':' + pg.ref.num;
      if (kept.has(key)) throw PdfError('input', 'a page appears twice');
      kept.set(key, reserve());
    }

    const conv = (src) => {
      const f = async (v) => {
        if (v instanceof Ref) {
          const key = src + ':' + v.num;
          if (kept.has(key)) return new Ref(kept.get(key), 0);
          if (allPages[src].has(v.num)) return new Raw('null');
          if (!map.has(key)) { const n = reserve(); map.set(key, n); queue.push({ src, ref: v, num: n }); }
          return new Ref(map.get(key), 0);
        }
        if (v instanceof Dict) { const d = new Dict(); for (const [k, x] of v.map) d.set(k, await f(x)); return d; }
        if (Array.isArray(v)) { const a = []; for (const x of v) a.push(await f(x)); return a; }
        return v;
      };
      return f;
    };

    const imageRef = await writeImages(spec.images, add);
    const kids = [];
    for (const pg of spec.pages) {
      const doc = docs[pg.src];
      if (!doc) throw PdfError('input', 'bad source');
      const page = await doc.get(new Ref(pg.ref.num, pg.ref.gen || 0));
      if (!(page instanceof Dict)) throw PdfError('syntax', 'page ' + pg.ref.num + ' not found');
      const c = conv(pg.src);
      const np = new Dict();
      for (const [k, v] of page.map) if (k !== 'Parent') np.set(k, await c(v));
      for (const k of INHERITED) {
        if (np.has(k)) continue;
        const v = await inherited(doc, page, k);
        if (v !== undefined) np.set(k, await c(v));
      }
      if (!np.has('MediaBox')) np.set('MediaBox', [new Raw('0'), new Raw('0'), new Raw('612'), new Raw('792')]);
      if (pg.rotate != null) np.set('Rotate', new Raw(String(((pg.rotate % 360) + 360) % 360)));
      np.set('Parent', new Ref(pagesNode, 0));
      if (pg.draws && pg.draws.length) await addDraws(doc, page, np, pg.draws, imageRef, add, c);
      const n = kept.get(pg.src + ':' + pg.ref.num);
      objects.push({ num: n, gen: 0, head: serialize(np), body: null });
      kids.push(n + ' 0 R');
    }
    objects.push({ num: pagesNode, gen: 0, head: '<</Type/Pages/Kids[' + kids.join(' ') + ']/Count ' + kids.length + '>>', body: null });

    const main = docs[0];
    const cat = await main.get(main.trailer.get('Root'));
    const ncat = new Dict().set('Type', new Name('Catalog')).set('Pages', new Ref(pagesNode, 0));
    if (cat instanceof Dict) for (const k of CATALOG_KEEP) if (cat.has(k)) ncat.set(k, await conv(0)(cat.get(k)));
    const catNum = reserve();
    objects.push({ num: catNum, gen: 0, head: serialize(ncat), body: null });
    let infoNum = 0;
    if (main.trailer.get('Info')) {
      const info = await main.get(main.trailer.get('Info'));
      if (info instanceof Dict) { infoNum = reserve(); objects.push({ num: infoNum, gen: 0, head: serialize(await conv(0)(info)), body: null }); }
    }

    // Everything the kept objects reach, copied once.
    while (queue.length) {
      const it = queue.shift();
      const full = await docs[it.src].getFull(it.ref);
      let v = await conv(it.src)(full.value);
      if (v === null || v === undefined) v = new Raw('null');
      if (full.stream && v instanceof Dict) v.set('Length', new Raw(String(full.stream.length)));
      objects.push({ num: it.num, gen: 0, head: serialize(v), body: full.stream });
    }

    objects.sort((a, b) => a.num - b.num);
    const parts = [toBytes('%PDF-1.7\n%' + String.fromCharCode(0xe2, 0xe3, 0xcf, 0xd3) + '\n')];
    let pos = parts[0].length;
    const offsets = new Array(next).fill(0);
    for (const o of objects) {
      offsets[o.num] = pos;
      const head = toBytes(o.num + ' 0 obj\n' + o.head + (o.body ? '\nstream\n' : '\nendobj\n'));
      parts.push(head); pos += head.length;
      if (o.body) { const tail = toBytes('\nendstream\nendobj\n'); parts.push(o.body, tail); pos += o.body.length + tail.length; }
    }
    let x = 'xref\n0 ' + next + '\n0000000000 65535 f\r\n';
    for (let n = 1; n < next; n++) x += offsets[n] ? String(offsets[n]).padStart(10, '0') + ' 00000 n\r\n' : '0000000000 00000 f\r\n';
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    x += 'trailer\n<</Size ' + next + '/Root ' + catNum + ' 0 R' + (infoNum ? '/Info ' + infoNum + ' 0 R' : '') + '/ID[<' + id + '><' + id + '>]>>\nstartxref\n' + pos + '\n%%EOF\n';
    parts.push(toBytes(x));
    return concat(parts);
  }

  // The page objects of a file, in order (which reference is page n).
  async function pages(input) {
    const doc = new Doc(input instanceof Uint8Array ? input : new Uint8Array(input));
    await doc.load();
    return (await pageRefs(doc)).map((r) => ({ num: r.num, gen: r.gen }));
  }

  // Whether the file can be written (not encrypted, readable): the UI asks before the user does the work.
  async function inspect(input) {
    const doc = new Doc(input instanceof Uint8Array ? input : new Uint8Array(input));
    try { await doc.load(); return { ok: true }; }
    catch (e) { return { ok: false, code: (e && e.code) || 'syntax' }; }
  }

  root.PdfWriter = { stamp: stamp, build: build, pages: pages, inspect: inspect, _internal: { Doc: Doc, Lexer: Lexer, parseValue: parseValue, serialize: serialize } };
})(typeof self !== 'undefined' ? self : globalThis);
