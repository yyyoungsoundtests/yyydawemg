'use strict';
/* Эфир ⇄ REAPER
   Импорт: .RPP (+ его аудиофайлы) или ZIP с папкой проекта → новые пустые дорожки (без эффектов),
           клипы на тех же местах, с подрезкой, фейдами и громкостью.
   Экспорт: ZIP «<имя>/<имя>.RPP + Media/» — сухой монтаж, открывается в REAPER. */

/* ---------- ZIP reading (stored + deflate via DecompressionStream) ---------- */
async function unzipFile(file) {
  const u8 = new Uint8Array(await file.arrayBuffer()), dv = new DataView(u8.buffer);
  let e = u8.length - 22;
  while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('не ZIP');
  const n = dv.getUint16(e + 10, true); let p = dv.getUint32(e + 16, true);
  const out = [], dec = new TextDecoder();
  for (let i = 0; i < n; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lo = dv.getUint32(p + 42, true);
    const nameBytes = u8.subarray(p + 46, p + 46 + nl);
    const name = (flags & 0x800) ? dec.decode(nameBytes) : decodeCp866(nameBytes);
    p += 46 + nl + xl + cl;
    if (name.endsWith('/') || /(^|\/)__MACOSX\//.test(name) || /(^|\/)\._/.test(name)) continue;
    const ds = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true);
    const raw = u8.subarray(ds, ds + csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) {
      if (typeof DecompressionStream === 'undefined') throw new Error('этот браузер не умеет распаковывать ZIP — выбери файлы проекта напрямую');
      data = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    } else continue;
    out.push(new File([data], name.split('/').pop(), { lastModified: Date.now() }));
    out[out.length - 1].path = name;
  }
  return out;
}
// Old Windows zips store names in CP866
function decodeCp866(b) {
  let ascii = true; for (const x of b) if (x > 127) { ascii = false; break; }
  if (ascii) return new TextDecoder().decode(b);
  try { return new TextDecoder('ibm866').decode(b); } catch { return new TextDecoder().decode(b); }
}

/* ---------- RPP parsing ---------- */
function rppTokens(line) {
  const t = []; let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === ' ' || ch === '\t') { i++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { const j = line.indexOf(ch, i + 1); t.push(line.slice(i + 1, j < 0 ? undefined : j)); i = j < 0 ? line.length : j + 1; continue; }
    let j = i; while (j < line.length && line[j] !== ' ' && line[j] !== '\t') j++;
    t.push(line.slice(i, j)); i = j;
  }
  return t;
}
const rv = (node, key) => { const l = node.lines.find((x) => x[0] === key); return l ? l.slice(1) : null; };
const rnum = (node, key, i = 0, d = 0) => { const v = rv(node, key); const x = v ? parseFloat(v[i]) : NaN; return isFinite(x) ? x : d; };

// Items: takes are separated by "TAKE" lines; the active one is marked "TAKE SEL" (or the first)
function rppItem(it) {
  const takes = [{ lines: [], kids: [], sel: false }];
  // walk lines and kids in document order is not kept by the tree, so rebuild it from both: lines/kids before the first TAKE belong to take 0
  let ti = 0; const order = it._order || [];
  for (const o of order) {
    if (o.line && o.line[0] === 'TAKE') { takes.push({ lines: [], kids: [], sel: o.line[1] === 'SEL' }); ti = takes.length - 1; continue; }
    if (o.line) takes[ti].lines.push(o.line); else takes[ti].kids.push(o.kid);
  }
  let take = takes.find((t) => t.sel) || takes[0];
  const itemLines = it.lines;
  const g = (lines, key) => { const l = lines.find((x) => x[0] === key); return l ? l.slice(1) : null; };
  const num = (v, i, d) => { const x = v ? parseFloat(v[i]) : NaN; return isFinite(x) ? x : d; };
  // item-level keys always come before the first TAKE line; take-level keys (NAME, SOFFS, VOLPAN, PLAYRATE, SOURCE) can be in take 0 too
  const tl = take.lines;
  let src = take.kids.find((k) => k.tag === 'SOURCE');
  let secStart = 0;
  while (src && src.args[0] === 'SECTION') { secStart += num(g(src.lines, 'STARTPOS'), 0, 0); src = src.kids.find((k) => k.tag === 'SOURCE'); }
  const file = src ? (g(src.lines, 'FILE') || [])[0] : null;
  // VOLPAN before the take NAME is the item volume, after it the take volume
  const t0 = takes[0].lines, ni = t0.findIndex((l) => l[0] === 'NAME');
  const itemV = t0.find((l, i) => l[0] === 'VOLPAN' && ni >= 0 && i < ni);
  const takeV = (take === takes[0] ? t0.filter((l, i) => l[0] === 'VOLPAN' && (ni < 0 || i > ni)) : tl.filter((l) => l[0] === 'VOLPAN'))[0];
  const itemVol = num(itemV && itemV.slice(1), 0, 1), takeVol = num(takeV && takeV.slice(1), 0, 1);
  const pr = g(tl, 'PLAYRATE') || g(itemLines, 'PLAYRATE');
  return {
    pos: num(g(itemLines, 'POSITION'), 0, 0), len: num(g(itemLines, 'LENGTH'), 0, 0),
    fin: num(g(itemLines, 'FADEIN'), 1, 0), fout: num(g(itemLines, 'FADEOUT'), 1, 0),
    mute: num(g(itemLines, 'MUTE'), 0, 0) === 1,
    name: (g(tl, 'NAME') || g(itemLines, 'NAME') || [''])[0],
    soffs: num(g(tl, 'SOFFS') || g(itemLines, 'SOFFS'), 0, 0) + secStart,
    vol: Math.abs(itemVol * takeVol), rate: num(pr, 0, 1), keepPitch: num(pr, 1, 1) === 1,
    type: src ? src.args[0] : null, file,
  };
}
// parseRpp drops the interleaving of lines and blocks inside ITEM; re-parse items keeping the order
function parseRppOrdered(text) {
  const root = { tag: 'ROOT', args: [], lines: [], kids: [], _order: [] }, st = [root];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line) continue;
    const top = st[st.length - 1];
    if (line[0] === '<') { const tk = rppTokens(line.slice(1)); const n = { tag: (tk[0] || '').toUpperCase(), args: tk.slice(1), lines: [], kids: [], _order: [] }; top.kids.push(n); top._order.push({ kid: n }); st.push(n); }
    else if (line === '>') { if (st.length > 1) st.pop(); }
    else { const l = rppTokens(line); top.lines.push(l); top._order.push({ line: l }); }
  }
  return root.kids.find((k) => k.tag === 'REAPER_PROJECT') || root;
}
function rppProject(text) {
  const pr = parseRppOrdered(text);
  const tracks = [];
  for (const tr of pr.kids.filter((k) => k.tag === 'TRACK')) {
    const name = (rv(tr, 'NAME') || [''])[0];
    const ms = rv(tr, 'MUTESOLO');
    tracks.push({ name, vol: rnum(tr, 'VOLPAN', 0, 1), mute: ms ? ms[0] === '1' : false, items: tr.kids.filter((k) => k.tag === 'ITEM').map(rppItem) });
  }
  return { tracks, sr: rnum(pr, 'SAMPLERATE', 0, 48000) };
}

/* ---------- Import ---------- */
function openReaperImport() {
  const inp = el('input', { type: 'file', multiple: true, accept: '.rpp,.RPP,.zip,application/zip,audio/*,.wav,.mp3,.aif,.aiff,.flac,.ogg,.m4a', style: 'display:none' });
  inp.addEventListener('change', () => { const fs = [...inp.files]; inp.remove(); if (fs.length) importReaper(fs); });
  document.body.append(inp); inp.click();
}
const baseName = (p) => String(p || '').split(/[\\/]/).pop();
async function importReaper(files) {
  await withBusy('reaper', async () => {
    toast('Читаю проект REAPER…', 8000);
    let all = [];
    for (const f of files) {
      if (/\.zip$/i.test(f.name)) { try { all.push(...await unzipFile(f)); } catch (e) { toast('Не получилось распаковать ZIP: ' + e.message, 5000); return; } }
      else all.push(f);
    }
    const rpps = all.filter((f) => /\.rpp$/i.test(f.name));
    if (!rpps.length) { toast('Нужен файл .RPP — выбери его вместе с аудиофайлами или ZIP с папкой проекта', 5000); return; }
    const rpp = rpps.find((f) => !/-bak\.rpp$|\.rpp-bak$/i.test(f.name)) || rpps[0];
    const proj = rppProject(await rpp.text());
    const byName = new Map(); for (const f of all) if (!/\.rpp/i.test(f.name)) byName.set(f.name.toLowerCase(), f);
    const decoded = new Map(), missing = new Set();
    const getFile = async (path) => {
      const key = baseName(path).toLowerCase();
      if (decoded.has(key)) return decoded.get(key);
      const f = byName.get(key); let r = null;
      if (f) {
        try {
          const buf = await decodeBlob(f), fileId = uid();
          await Store.put('blobs', fileId, f);
          buffers.set(fileId, { buf, peaks: computePeaks(buf) });
          P.files[fileId] = { name: f.name, size: f.size, dur: buf.duration };
          r = { fileId, buf };
        } catch (e) { console.error(e); }
      }
      if (!r) missing.add(baseName(path));
      decoded.set(key, r); return r;
    };
    let nTracks = 0, nClips = 0, skipped = 0, k0 = P.tracks.filter((t) => t.custom).length;
    for (const rt of proj.tracks) {
      const items = rt.items.filter((it) => !it.mute && it.file && it.len > 0.001 && it.type !== 'MIDI');
      skipped += rt.items.length - items.length;
      if (!items.length) continue;
      const t = { id: 't' + uid(), name: (rt.name || `REAPER ${nTracks + 1}`).slice(0, 40), kind: 'fx', custom: true, mono: false, color: EXTRA_COLORS[(k0 + nTracks) % EXTRA_COLORS.length], vol: clamp(linToDb(rt.vol), -60, 12), pan: 0, mute: rt.mute, solo: false, eq: { on: false, bands: defaultEQ('fx') }, fromReaper: true };
      const clips = []; let allMono = true;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        toast(`${t.name}: клип ${i + 1}/${items.length}…`, 8000);
        const src = await getFile(it.file); if (!src) continue;
        if (src.buf.numberOfChannels > 1) allMono = false;
        const gain = clamp(linToDb(it.vol || 1), -60, 24);
        const c = { id: uid(), track: t.id, src: src.fileId, name: (it.name || baseName(it.file)).replace(/\.[^.]+$/, ''), start: Math.max(0, it.pos), offset: Math.max(0, it.soffs), dur: it.len, gain, fin: Math.max(0.002, it.fin), fout: Math.max(0.002, it.fout) };
        if (Math.abs(it.rate - 1) > 0.0005) {
          // REAPER play rate: render it into a new file (keep pitch → time-stretch, otherwise resample)
          const n = Math.round(it.len * it.rate * SR), a = Math.round(c.offset * SR), b = src.buf;
          const ch = []; for (let k = 0; k < b.numberOfChannels; k++) { const d = new Float32Array(n), s = b.getChannelData(k); for (let j = 0; j < n; j++) d[j] = s[(a + j) % s.length] || 0; ch.push(d); }
          let out;
          if (it.keepPitch && it.rate >= 0.5 && it.rate <= 2) out = await stretchAudio(ch, SR, it.rate, 'st');
          else { const m = Math.round(it.len * SR); out = ch.map((d) => { const o = new Float32Array(m); for (let j = 0; j < m; j++) { const x = j * it.rate, i0 = Math.floor(x), f = x - i0; o[j] = (d[i0] || 0) * (1 - f) + (d[i0 + 1] || 0) * f; } return o; }); }
          const r = await addRenderedFile(out, `${c.name}_${Math.round(it.rate * 1000) / 10}%.wav`);
          Object.assign(c, { src: r.fileId, offset: 0, dur: Math.min(it.len, r.dur) });
        } else {
          // REAPER loops the source past its end; here a clip stops at the end of the file
          const room = src.buf.duration - c.offset;
          if (room <= 0.001) continue;
          c.dur = Math.min(c.dur, room);
        }
        c.fin = Math.min(c.fin, c.dur / 2); c.fout = Math.min(c.fout, c.dur / 2);
        clips.push(c);
      }
      if (!clips.length) continue;
      t.mono = allMono;
      P.tracks.push(t); P.clips.push(...clips);
      nTracks++; nClips += clips.length;
    }
    if (!nTracks) {
      modal('Импорт из REAPER', el('div', {}, el('p', {}, missing.size ? 'Не нашёл аудиофайлы проекта. Выбери .RPP вместе с файлами из папки проекта (обычно Media / Audio) или ZIP всей папки.' : 'В проекте нет аудиоклипов.'),
        missing.size ? el('p', { class: 'note' }, 'Нужны: ' + [...missing].slice(0, 12).join(', ') + (missing.size > 12 ? ' …' : '')) : ''));
      return;
    }
    S.sel = new Set(P.clips.filter((c) => P.tracks.find((t) => t.id === c.track)?.fromReaper && !S.sel.has(c.id)).slice(-nClips).map((c) => c.id));
    stop(false); commit(); resize(); renderInspector(); zoomFit(); redraw();
    const parts = [el('p', {}, `Добавлено дорожек: ${nTracks}, клипов: ${nClips}. Дорожки пустые, без эффектов — растаскивай клипы по своим дорожкам, лишние удаляй «×».`)];
    if (missing.size) parts.push(el('p', { class: 'note' }, `Не найдены файлы (${missing.size}): ` + [...missing].slice(0, 12).join(', ') + (missing.size > 12 ? ' …' : '') + '. Их клипы пропущены.'));
    if (skipped) parts.push(el('p', { class: 'note' }, `Пропущено (выключенные, MIDI, пустые): ${skipped}.`));
    modal('Импорт из REAPER', el('div', {}, ...parts));
  });
}

/* ---------- Export ---------- */
function sniffExt(u8, fallback) {
  const s = String.fromCharCode(...u8.subarray(0, 12));
  if (s.startsWith('RIFF')) return 'wav';
  if (s.startsWith('FORM')) return 'aif';
  if (s.startsWith('fLaC')) return 'flac';
  if (s.startsWith('OggS')) return 'ogg';
  if (s.startsWith('ID3') || (u8[0] === 0xFF && (u8[1] & 0xE0) === 0xE0)) return 'mp3';
  if (s.slice(4, 8) === 'ftyp') return 'm4a';
  return fallback || 'wav';
}
const RPP_SRC = { wav: 'WAVE', aif: 'WAVE', flac: 'FLAC', ogg: 'VORBIS', mp3: 'MP3', m4a: 'VIDEO' };
const q = (s) => `"${String(s).replace(/"/g, "'")}"`;
const f6 = (x) => (+x).toFixed(6).replace(/\.?0+$/, '') || '0';
async function exportReaper(baseNameIn) {
  const base = cleanName(baseNameIn || P.name) || 'Ролик';
  await withBusy('reaper', async () => {
    toast('Собираю проект REAPER…', 8000);
    const used = [...new Set(P.clips.map((c) => c.src))];
    const media = new Map(), taken = new Set(), entries = [];
    for (const id of used) {
      const blob = await Store.get('blobs', id); if (!blob) continue;
      const u8 = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
      const orig = (P.files[id]?.name || 'audio').replace(/\.[^.]+$/, '');
      const ext = sniffExt(u8, (P.files[id]?.name.match(/\.(\w+)$/) || [])[1]);
      let nm = `${sanitize(orig) || 'audio'}.${ext}`, k = 2;
      while (taken.has(nm.toLowerCase())) nm = `${sanitize(orig)}_${k++}.${ext}`;
      taken.add(nm.toLowerCase());
      media.set(id, { file: `Media/${nm}`, type: RPP_SRC[ext] || 'WAVE' });
      entries.push({ name: `${base}/Media/${nm}`, blob });
    }
    const L = [];
    L.push(`<REAPER_PROJECT 0.1 "6.0/efir" ${Math.floor(Date.now() / 1000)}`);
    L.push('  SAMPLERATE 48000 0 0', '  TEMPO 120 4 4', `  CURSOR ${f6(P.playhead)}`, '  ZOOM 100 0 0');
    if (P.loop) { L.push(`  LOOP ${P.loop.on ? 1 : 0}`, `  SELECTION ${f6(P.loop.s)} ${f6(P.loop.e)}`, `  SELECTION2 ${f6(P.loop.s)} ${f6(P.loop.e)}`); }
    P.regions.forEach((r, i) => { L.push(`  MARKER ${i + 1} ${f6(r.start)} ${q(r.name)} 1`, `  MARKER ${i + 1} ${f6(r.start + r.len)} "" 1`); });
    const anySolo = P.tracks.some((t) => t.solo);
    for (const t of P.tracks) {
      L.push(`  <TRACK {${guid()}}`, `    NAME ${q(t.name)}`, `    VOLPAN ${f6(dbToLin(t.vol))} 0 -1 -1 1`, `    MUTESOLO ${t.mute ? 1 : 0} ${anySolo && t.solo ? 1 : 0} 0`, '    NCHAN 2');
      for (const c of P.clips.filter((x) => x.track === t.id).sort((a, b) => a.start - b.start)) {
        const m = media.get(c.src); if (!m) continue;
        const F = effFades(c);
        L.push('    <ITEM', `      POSITION ${f6(c.start)}`, `      LENGTH ${f6(c.dur)}`, '      LOOP 0',
          `      FADEIN 1 ${f6(F.fin)} 0 1 0 0 0`, `      FADEOUT 1 ${f6(F.fout)} 0 1 0 0 0`, '      MUTE 0 0',
          `      NAME ${q(c.name)}`, `      VOLPAN ${f6(dbToLin(c.gain || 0))} 0 1 -1`, `      SOFFS ${f6(c.offset)}`, '      PLAYRATE 1 1 0 -1 0 0.0025', '      CHANMODE 0',
          `      <SOURCE ${m.type}`, `        FILE ${q(m.file)}`, '      >', '    >');
      }
      L.push('  >');
    }
    L.push('>');
    entries.unshift({ name: `${base}/${base}.RPP`, blob: new Blob([L.join('\n') + '\n'], { type: 'text/plain' }) });
    const zip = await makeZip(entries, `${base}_REAPER.zip`);
    modal('Проект для REAPER', filesPanel([zip], 'Распакуй и открой .RPP в REAPER — дорожки, клипы, фейды, громкость и регионы на месте. Обработка «Эфира» не переносится.'));
  });
}
function guid() { const h = () => Math.floor(Math.random() * 65536).toString(16).toUpperCase().padStart(4, '0'); return `${h()}${h()}-${h()}-${h()}-${h()}-${h()}${h()}${h()}`; }
