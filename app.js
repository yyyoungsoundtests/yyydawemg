'use strict';
/* Эфир — монтаж и сведение радиороликов. Один файл логики, без сборки. */

const SR = 48000;
const APP_VERSION = '0.8.0';
const $ = (s, r = document) => r.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'html') e.innerHTML = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
};
const dbToLin = (d) => Math.pow(10, d / 20);
const linToDb = (l) => 20 * Math.log10(Math.max(l, 1e-12));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const uid = () => Math.random().toString(36).slice(2, 10);
const fmtTime = (t) => {
  const s = Math.max(0, t), m = Math.floor(s / 60), r = s - m * 60;
  return `${m}:${r.toFixed(3).padStart(6, '0')}`;
};
const fmtDb = (d, p = 1) => (d === -Infinity || d < -150 ? '−∞' : (d >= 0 ? '+' : '−') + Math.abs(d).toFixed(p));
const isTouch = matchMedia('(pointer: coarse)').matches;
const BMRU_RE = /BMRU[_\s-]?(\d{1,4})[_\s-]?(\d{1,4})/i;
const findCode = (name) => { const m = BMRU_RE.exec(name || ''); return m ? `BMRU_${m[1]}_${m[2].padStart(3, '0')}` : null; };
const cleanName = (s) => String(s).trim().replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ');
const sanitize = (s) => String(s).trim().replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '_');

/* ================= Storage ================= */
const Store = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const rq = indexedDB.open('efir', 1);
      rq.onupgradeneeded = () => { const d = rq.result; d.createObjectStore('projects'); d.createObjectStore('blobs'); };
      rq.onsuccess = () => { this.db = rq.result; res(); };
      rq.onerror = () => rej(rq.error);
    });
  },
  tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, mode), s = t.objectStore(store);
      const r = fn(s);
      t.oncomplete = () => res(r && r.result);
      t.onerror = () => rej(t.error);
    });
  },
  get(store, key) { return this.tx(store, 'readonly', (s) => s.get(key)); },
  put(store, key, val) { return this.tx(store, 'readwrite', (s) => s.put(val, key)); },
  del(store, key) { return this.tx(store, 'readwrite', (s) => s.delete(key)); },
  all(store) { return this.tx(store, 'readonly', (s) => s.getAll()); },
};
const ls = {
  get(k, d) { try { const v = localStorage.getItem('efir.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('efir.' + k, JSON.stringify(v)); } catch {} },
};

/* ================= Project model ================= */

/* ================= Project model ================= */
const TRACK_COLORS = { v1: '#D6A544', v2: '#D07454', mu: '#4BAE98', fx: '#9D90D8' };
const eqBand = (type, f, g = 0, q = 1, on = true) => ({ type, f, g, q, on });
function defaultEQ(kind) {
  if (kind === 'voice') return [eqBand('highpass', 50, 0, 0.71), eqBand('lowshelf', 180, 0), eqBand('peaking', 350, -2, 1.2), eqBand('peaking', 3200, 2, 1), eqBand('highshelf', 9000, 2), eqBand('lowpass', 18000, 0, 0.71, false)];
  if (kind === 'radio') return [eqBand('highpass', 380, 0, 0.9), eqBand('peaking', 900, -2, 1.4), eqBand('peaking', 1800, 5, 0.9), eqBand('lowpass', 3600, 0, 1.1)];
  if (kind === 'music') return [eqBand('highpass', 35, 0, 0.71), eqBand('peaking', 250, 0, 1), eqBand('peaking', 2500, 0, 1), eqBand('highshelf', 10000, 0)];
  if (kind === 'master') return [eqBand('highpass', 30, 0, 0.71), eqBand('lowshelf', 120, 0), eqBand('peaking', 3000, 0, 1), eqBand('highshelf', 12000, 0)];
  return [eqBand('highpass', 40, 0, 0.71), eqBand('peaking', 1000, 0, 1), eqBand('highshelf', 10000, 0)];
}
// Opto/discrete compressor stepped controls
const SH_RATIOS = [1.2, 2, 3, 4, 6, 20], SH_RATIO_L = ['1.2', '2', '3', '4', '6', 'FLOOD'];
const SH_ATTS = [0.1, 0.5, 1, 5, 10, 30], SH_ATT_L = ['.1', '.5', '1', '5', '10', '30'];
const SH_RECS = [0.1, 0.25, 0.5, 0.8, 1.2, -1], SH_REC_L = ['.1', '.25', '.5', '.8', '1.2', 'DUAL'];
const DEF = {
  declick: () => ({ on: true, amount: 3, quality: 1, only: false }),
  vox: (comp = -12) => ({ on: true, gate: -80, comp, gain: 0 }),
  deessVoice: () => ({ on: true, thr: -30, range: 4, f1: 5500, f2: 12000, mode: 'vocal', band: 'split', link: 100, look: 5 }),
  deessMaster: () => ({ on: true, thr: -10, range: 6, f1: 2000, f2: 2974, mode: 'allround', band: 'wide', link: 100, look: 12 }),
  drive: (a = 0) => ({ on: a > 0, amount: a }),
  duck: () => ({ on: true, depth: 8, sens: 6, attack: 10, release: 150, lo: 150, hi: 8000 }),
  mbBand: () => ({ on: true, lThr: 0, lRatio: 10, lAtt: 20, lRel: 100, cThr: -22.8, cRatio: 2, cAtt: 20, cRel: 60, gain: 0, mix: 100 }),
  mb: () => ({ on: true, xo: [100, 580, 4500], bands: [0, 1, 2, 3].map(() => DEF.mbBand()) }),
  sh: () => ({ on: true, oOn: true, oThr: 9, oGain: 7, dOn: true, dThr: 9, dRatio: 2, dAtt: 5, dRec: 0, dGain: 7, xf: 0, mix: 100 }),
  la2a: () => ({ on: false, peak: 40, gain: 50, limit: false, meter: 'gr' }),
  tonal: () => ({ on: true, recover: 30, tame: 40, bias: 0, brighten: 0, boost: 0 }),
  sends: () => ({ on: true, dbl: -60, rev: -60 }),
  rcomp: () => ({ on: false, thresh: 0, ratio: 4.01, attack: 5.02, release: 50.2, gain: 0, mix: 100, trim: 0, arc: true, electro: true, warm: true }),
  glue: () => ({ on: true, thresh: -14, ratio: 2, attack: 10, release: 0.3, auto: true, makeup: 0, mix: 100, schp: 90 }),
  bus: () => ({ dbl: { delay: 14, detune: 8, width: 100, ret: 0 }, rev: { decay: 1.2, predelay: 20, tone: 6000, lowcut: 250, width: 100, ret: 0 } }),
  limBands: () => [[100, 'lowshelf'], [200, 'peaking'], [400, 'peaking'], [800, 'peaking'], [1600, 'peaking'], [3200, 'highshelf']].map(([f, type]) => ({ on: true, prio: 0, gain: 0, f, q: 1, type })),
  lim: () => ({ on: true, thresh: -7, ceiling: -0.3, release: 1, character: 'Default', separation: 'Medium', quantize: 24, dither: 'Type1', shaping: 'Normal', idr: true, bands: DEF.limBands() }),
};
const shThrDb = (v) => -2 - v * 1.2;
// Maximizer release: shown in the classic 0.01…1000 scale, 1.00 ≈ 80 ms here; the character picks auto-release behaviour
const LIM_CHAR = { Default: [1, true], ARC: [1.5, true], Fast: [0.6, false], Smooth: [2, false] };
const limMs = (L) => clamp(80 * Math.sqrt(Math.max(0.01, L.release)) * (LIM_CHAR[L.character] || LIM_CHAR.Default)[0], 8, 1500);
function upgradeLim(m) {
  const L = m.lim || {};
  if (!L.bands) {
    const fresh = DEF.lim();
    if (L.release != null && L.release > 5) L.release = Math.round(Math.pow(L.release / 80, 2) * 100) / 100; // old value in ms
    if (L.arc === false) L.character = 'Fast';
    delete L.arc; delete L.gain;
    m.lim = { ...fresh, ...L, bands: fresh.bands };
  }
  if (m.lim.on == null) m.lim.on = true;
  return m;
}
const shGainDb = (v) => v * 0.5;
function makeRegionSet(start, variant) {
  const out = []; let t = start;
  for (const len of [30, 15, 10, 5]) {
    out.push({ id: uid(), name: variant > 1 ? `${len}с в${variant}` : `${len}с`, start: t, len });
    t += len + 3;
  }
  return out;
}
function newProject(name = 'Новый ролик') {
  const p = baseProject(name);
  const def = Presets.getDefault();
  if (def) applyPresetTo(p, def);
  return p;
}
function baseProject(name) {
  return {
    id: uid(), name, created: Date.now(), updated: Date.now(), v: 6, loop: { s: 0, e: 0, on: false },
    tracks: [
      { id: 'v1', name: 'VOICE', kind: 'voice', vol: 0, pan: 0, mute: false, solo: false, declick: DEF.declick(), eq: { on: true, bands: defaultEQ('voice') }, vox: DEF.vox(-12), rcomp: DEF.rcomp(), la2a: DEF.la2a(), deess: DEF.deessVoice(), drive: DEF.drive(0), sends: DEF.sends() },
      { id: 'v2', name: 'RADIO FX', kind: 'voice', vol: 0, pan: 0, mute: false, solo: false, declick: DEF.declick(), eq: { on: true, bands: defaultEQ('radio') }, vox: DEF.vox(-15), rcomp: DEF.rcomp(), la2a: DEF.la2a(), deess: DEF.deessVoice(), drive: { on: false, amount: 0.35 }, sends: DEF.sends() },
      { id: 'mu', name: 'Музыка', kind: 'music', vol: -12, pan: 0, mute: false, solo: false, eq: { on: true, bands: defaultEQ('music') }, duck: DEF.duck() },
      { id: 'fx', name: 'SFX', kind: 'fx', vol: 0, pan: 0, mute: false, solo: false, eq: { on: true, bands: defaultEQ('fx') } },
    ],
    master: { bus: DEF.bus(), mb: DEF.mb(), eq: { on: true, bands: defaultEQ('master') }, tonal: DEF.tonal(), deess: DEF.deessMaster(), glue: DEF.glue(), sh: { ...DEF.sh(), on: false }, lim: DEF.lim(), autoRms: false, targetRms: -10.5, fades: true, format: 'wav' },
    clips: [], regions: makeRegionSet(0, 1), files: {}, playhead: 0,
  };
}
// Bring projects saved by 0.1 up to the current structure
function migrate(p) {
  if ((p.v || 1) < 2) migrateV1(p);
  if (p.v < 3) {
    for (const t of p.tracks) if (t.kind === 'voice' && !t.la2a) t.la2a = DEF.la2a();
    upgradeLim(p.master);
    p.v = 3;
  }
  if (p.v < 4) {
    p.master.tonal = p.master.tonal || DEF.tonal();
    for (const t of p.tracks) if (t.kind === 'voice') { const b = t.eq && t.eq.bands && t.eq.bands[0]; if (b && b.type === 'highpass' && b.f === 80) b.f = 50; }
    p.v = 4;
  }
  if (p.v < 5) {
    for (const t of p.tracks) if (t.kind === 'voice' && !t.sends) t.sends = DEF.sends();
    p.master.bus = p.master.bus || DEF.bus();
    p.v = 5;
  }
  if (p.v < 6) {
    const ren = { 'Голос': 'VOICE', 'Голос радио': 'RADIO FX', 'Эффекты': 'SFX' };
    for (const t of p.tracks) {
      if (ren[t.name]) t.name = ren[t.name];
      if (t.kind === 'voice') { t.rcomp = t.rcomp || DEF.rcomp(); if (t.drive) t.drive.on = false; }
    }
    const m = p.master;
    m.glue = m.glue || DEF.glue();
    m.autoRms = false;
    if (m.lim && m.lim.ceiling === -1) m.lim.ceiling = -0.3;
    p.v = 6;
  }
  if (!p.loop) p.loop = { s: 0, e: 0, on: false };
  return p;
}
function migrateV1(p) {
  for (const t of p.tracks) {
    if (Array.isArray(t.eq)) t.eq = { on: true, bands: t.eq };
    if (t.kind === 'voice') {
      t.declick = t.declick || DEF.declick();
      if (!t.vox) { t.vox = DEF.vox(t.rvox ? -(t.rvox.amount ?? 5) * 2.4 : -12); if (t.rvox) { t.vox.on = t.rvox.on; t.vox.gain = t.rvox.gain || 0; } }
      delete t.rvox;
      t.deess = t.deess || DEF.deessVoice();
      if (typeof t.drive !== 'object' || t.drive === null) t.drive = DEF.drive(+t.drive || 0);
    }
    if (t.kind === 'music') t.duck = t.duck || DEF.duck();
  }
  const m = p.master;
  if (Array.isArray(m.eq)) m.eq = { on: true, bands: m.eq };
  m.mb = m.mb || DEF.mb(); m.deess = m.deess || DEF.deessMaster(); m.sh = m.sh || DEF.sh();
  if (!m.lim || m.lim.thresh == null) m.lim = { ...DEF.lim(), ceiling: m.lim?.ceiling ?? -1, release: m.lim?.release ?? 80, thresh: -(m.lim?.gain ?? 4) };
  delete m.comp;
  if (m.targetRms == null) m.targetRms = -10.5;
  if (m.autoRms == null) m.autoRms = true;
  if (m.fades == null) m.fades = true;
  m.format = m.format || 'wav';
  p.v = 2;
}
// FX chains in processing order (shown like Reaper's FX chain)
const FX_NAMES = { declick: 'De-crackle', eq: 'Parametric EQ', vox: 'Vocal Leveler', deess: 'De-Esser', drive: 'Saturation', duck: 'Spectral Ducker', mb: 'Multiband Dynamics', sh: 'Opto/Discrete Comp', tonal: 'Auto Balance', lim: 'Multimaximizer', stats: 'Audio Statistics', la2a: 'Opto Leveler 2A', sends: 'Sends: Doubler · Reverb', rcomp: 'R-Compressor', glue: 'Bus Compressor' };
function chainFor(t) {
  if (t === 'master') return ['mb', 'eq', 'tonal', 'deess', 'glue', 'lim', 'stats'];
  if (t.kind === 'voice') return ['declick', 'eq', 'vox', 'rcomp', 'la2a', 'deess', 'sends'];
  if (t.kind === 'music') return ['eq', 'duck'];
  return ['eq'];
}
const targetObj = (id) => (id === 'master' ? P.master : P.tracks.find((t) => t.id === id));
const fxOn = (obj, key) => (key === 'stats' ? true : !!obj[key] && obj[key].on !== false);

let P = null;                 // current project
const buffers = new Map();    // fileId -> { buf, peaks }
const S = {
  pps: 40, x0: -0.5, sel: new Set(), selRegion: null, inspector: 'none', inspectorTrack: null,
  snap: ls.get('snap', true), ripple: ls.get('ripple', false), playing: false, follow: true,
  hist: [], hidx: -1, dirty: true, saveTimer: null,
};

/* ================= Undo ================= */
function snapshot() { const { playhead, ...rest } = P; return JSON.stringify(rest); }
function commit() {
  const snap = snapshot();
  if (S.hist[S.hidx] === snap) return;
  S.hist = S.hist.slice(0, S.hidx + 1); S.hist.push(snap);
  if (S.hist.length > 150) S.hist.shift();
  S.hidx = S.hist.length - 1;
  scheduleSave(); updateToolbar();
}
function restore(i) {
  if (i < 0 || i >= S.hist.length) return;
  const ph = P.playhead; P = JSON.parse(S.hist[i]); P.playhead = ph; S.hidx = i;
  for (const id of [...S.sel]) if (!P.clips.find((c) => c.id === id)) S.sel.delete(id);
  if (S.selRegion && !P.regions.find((r) => r.id === S.selRegion)) S.selRegion = null;
  applyLive(); renderHeaders(); renderInspector(); scheduleSave(); updateToolbar(); redraw();
}
const undo = () => restore(S.hidx - 1);
const redo = () => restore(S.hidx + 1);

function scheduleSave() {
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(async () => { P.updated = Date.now(); try { await Store.put('projects', P.id, JSON.parse(JSON.stringify(P))); ls.set('last', P.id); } catch (e) { console.warn(e); } }, 600);
}

/* ================= Audio files ================= */
let decodeCtx = null;
async function decodeBlob(blob) {
  const ab = await blob.arrayBuffer();
  if (!decodeCtx) decodeCtx = new OfflineAudioContext(2, 1, SR);
  return await decodeCtx.decodeAudioData(ab);
}
const PEAK_BIN = 128;
function computePeaks(buf) {
  const n = Math.ceil(buf.length / PEAK_BIN), mn = new Float32Array(n), mx = new Float32Array(n);
  const a = buf.getChannelData(0), b = buf.numberOfChannels > 1 ? buf.getChannelData(1) : a;
  for (let i = 0; i < n; i++) {
    let lo = 0, hi = 0; const e = Math.min(buf.length, (i + 1) * PEAK_BIN);
    for (let j = i * PEAK_BIN; j < e; j++) { const v = (a[j] + b[j]) * 0.5; if (v < lo) lo = v; if (v > hi) hi = v; }
    mn[i] = lo; mx[i] = hi;
  }
  return { mn, mx };
}
async function ensureBuffer(fileId) {
  if (buffers.has(fileId)) return buffers.get(fileId);
  const blob = await Store.get('blobs', fileId);
  if (!blob) return null;
  const buf = await decodeBlob(blob);
  const entry = { buf, peaks: computePeaks(buf) };
  buffers.set(fileId, entry);
  return entry;
}
const VOICE_TARGET_RMS = -20;
function voiceAutoGain(buf) {
  // RMS of the active (non-silent) 50 ms blocks only, so pauses don't skew it
  const a = buf.getChannelData(0), b = buf.numberOfChannels > 1 ? buf.getChannelData(1) : a, blk = Math.round(buf.sampleRate * 0.05);
  const blocks = [];
  for (let i = 0; i + blk <= a.length; i += blk) { let s = 0; for (let j = i; j < i + blk; j++) { const v = (a[j] + b[j]) * 0.5; s += v * v; } blocks.push(s / blk); }
  if (!blocks.length) return 0;
  const loud = Math.max(...blocks), act = blocks.filter((x) => x > loud * 0.001);
  const rms = 10 * Math.log10(act.reduce((x, y) => x + y, 0) / act.length + 1e-20);
  if (!isFinite(rms) || rms < -80) return 0;
  return Math.round(clamp(VOICE_TARGET_RMS - rms, -24, 24) * 10) / 10;
}
async function importFiles(files, trackId, at) {
  let t = at;
  for (const f of files) {
    toast(`Загружаю ${f.name}…`);
    try {
      const fileId = uid();
      const buf = await decodeBlob(f);
      await Store.put('blobs', fileId, f);
      buffers.set(fileId, { buf, peaks: computePeaks(buf) });
      P.files[fileId] = { name: f.name, size: f.size, dur: buf.duration };
      const tr = P.tracks.find((k) => k.id === trackId);
      // raw voice comes in at any level: bring the spoken parts to about -20 dBFS RMS so the mix starts balanced
      const gain = tr && tr.kind === 'voice' ? voiceAutoGain(buf) : 0;
      const clip = { id: uid(), track: trackId, src: fileId, name: f.name.replace(/\.[^.]+$/, ''), start: t, offset: 0, dur: buf.duration, gain, fin: 0.005, fout: 0.005 };
      P.clips.push(clip);
      S.sel = new Set([clip.id]);
      t += buf.duration;
    } catch (e) {
      console.error(e); toast(`Не получилось открыть ${f.name}. Поддерживаются WAV, MP3, AIFF, M4A.`, 4000);
    }
  }
  S.inspector = 'clip';
  commit(); renderInspector(); redraw(); toast('Готово', 1200);
}

/* ================= DSP graph ================= */
let actx = null, workletReady = new WeakMap();
function getCtx() {
  if (!actx) {
    try { actx = new AudioContext({ sampleRate: SR, latencyHint: 'playback' }); } catch { actx = new AudioContext(); }
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
  }
  return actx;
}
async function ensureWorklet(ctx) {
  if (!workletReady.has(ctx)) workletReady.set(ctx, ctx.audioWorklet.addModule('dsp.js?v=' + APP_VERSION));
  await workletReady.get(ctx);
}
// Fixed processing latencies in samples (must match dsp.js)
const LAT = { declick: 64, deess: 720, duck: 1024, tonal: 1024, lim: 69 };
const VOICE_LAT = LAT.declick + LAT.deess;
const TOTAL_LAT = VOICE_LAT + LAT.duck + LAT.tonal + LAT.deess + LAT.lim;
const latency = (ctx) => TOTAL_LAT / (ctx ? ctx.sampleRate : SR);

function setBand(node, b) {
  if (!b || !b.on) { node.type = 'peaking'; node.gain.value = 0; node.frequency.value = 1000; node.Q.value = 1; return; }
  node.type = b.type;
  node.frequency.value = clamp(b.f, 10, 22000);
  node.gain.value = b.type === 'highpass' || b.type === 'lowpass' ? 0 : b.g;
  node.Q.value = b.type === 'highpass' || b.type === 'lowpass' ? 20 * Math.log10(Math.max(0.1, b.q)) : Math.max(0.1, b.q);
}
const MAXB = 8;
function makeEQ(ctx) { const n = []; for (let i = 0; i < MAXB; i++) n.push(ctx.createBiquadFilter()); for (let i = 1; i < MAXB; i++) n[i - 1].connect(n[i]); return n; }
function applyEQ(nodes, eq) { for (let i = 0; i < MAXB; i++) setBand(nodes[i], eq.on ? eq.bands[i] : null); }
function driveCurve(d) {
  if (!d) return null;
  const k = 1 + d * 9, n = 2048, c = new Float32Array(n), norm = Math.tanh(k);
  for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; c[i] = Math.tanh(k * x) / norm; }
  return c;
}
// Parameters sent to each processor
const PR = {
  declick: (t) => ({ ...t.declick }),
  vox: (t) => ({ ...t.vox }),
  deess: (d) => ({ ...d, link: d.link / 100 }),
  duck: (t) => ({ ...t.duck }),
  mb: (m) => ({ on: m.mb.on, xo: m.mb.xo.slice(), bands: m.mb.bands.map((b) => ({ ...b })) }),
  sh: (m) => {
    const s = m.sh;
    return { on: s.on, oOn: s.oOn, oThr: shThrDb(s.oThr), oGain: shGainDb(s.oGain), dOn: s.dOn, dThr: shThrDb(s.dThr), dRatio: SH_RATIOS[s.dRatio], dAtt: SH_ATTS[s.dAtt], dRec: SH_RECS[s.dRec], dGain: shGainDb(s.dGain), xf: s.xf, mix: s.mix / 100 };
  },
  lim: (m, ov = {}) => ({ on: m.lim.on !== false, gain: ov.limGain ?? -m.lim.thresh, ceiling: m.lim.ceiling, release: limMs(m.lim), arc: (LIM_CHAR[m.lim.character] || LIM_CHAR.Default)[1], separation: m.lim.separation, bands: m.lim.bands.map((b) => ({ ...b })) }),
  tonal: (m) => ({ ...m.tonal }),
  la2a: (t) => ({ ...t.la2a }),
  rcomp: (t) => ({ ...(t.rcomp || DEF.rcomp()) }),
  glue: (m) => ({ ...(m.glue || DEF.glue()) }),
};

async function buildGraph(ctx, live, ov = {}) {
  await ensureWorklet(ctx);
  const sr = ctx.sampleRate;
  const W = (name, p, key, ins = 1) => {
    const n = new AudioWorkletNode(ctx, name, { numberOfInputs: ins, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { p } });
    if (live && key) n.port.onmessage = (e) => { Meter.gr[key] = e.data; };
    return n;
  };
  const delay = (samples) => { const d = ctx.createDelay(1); d.delayTime.value = samples / sr; return d; };
  const an = () => { const a = ctx.createAnalyser(); a.fftSize = 4096; a.smoothingTimeConstant = 0.75; return a; };
  const g = { ctx, tracks: {}, live, workers: [] };
  const M = P.master, m = {};
  m.input = ctx.createGain();
  m.mb = W('efir-mb', PR.mb(M), 'master.mb');
  m.eq = makeEQ(ctx);
  m.deess = W('efir-deess', PR.deess(M.deess), 'master.deess');
  m.tonal = W('efir-tonal', PR.tonal(M), 'master.tonal');
  m.glue = W('efir-buscomp', PR.glue(M), 'master.glue');
  m.lim = W('efir-limiter', PR.lim(M, ov), 'master.lim');
  m.input.connect(m.mb); m.mb.connect(m.eq[0]); m.eq[MAXB - 1].connect(m.tonal); m.tonal.connect(m.deess); m.deess.connect(m.glue); m.glue.connect(m.lim); m.lim.connect(ctx.destination);
  g.workers.push(m.mb, m.tonal, m.deess, m.glue, m.lim);
  if (live) {
    m.anIn = an(); m.input.connect(m.anIn);
    m.anEq = an(); m.eq[MAXB - 1].connect(m.anEq);
    m.split = ctx.createChannelSplitter(2);
    m.anL = ctx.createAnalyser(); m.anR = ctx.createAnalyser(); m.anL.fftSize = m.anR.fftSize = 2048;
    m.lim.connect(m.split); m.split.connect(m.anL, 0); m.split.connect(m.anR, 1);
  }
  g.master = m;
  const sc = ctx.createGain();
  // Send buses (doubler, reverb): their returns are delayed like the voices so everything stays aligned
  const B = M.bus || DEF.bus(), bus = {};
  bus.dIn = ctx.createGain(); bus.dIn.channelCount = 1; bus.dIn.channelCountMode = 'explicit'; bus.dIn.channelInterpretation = 'speakers';
  bus.dOut = ctx.createGain();
  bus.dl = [0, 1].map((i) => {
    const d = ctx.createDelay(0.2), lfo = ctx.createOscillator(), depth = ctx.createGain(), pan = ctx.createStereoPanner();
    lfo.frequency.value = i ? 0.43 : 0.31; lfo.connect(depth); depth.connect(d.delayTime); lfo.start(0);
    bus.dIn.connect(d); d.connect(pan); pan.connect(bus.dOut);
    return { d, depth, pan, lfo };
  });
  bus.rIn = ctx.createGain(); bus.rPre = ctx.createDelay(0.5); bus.rLow = ctx.createBiquadFilter(); bus.rLow.type = 'highpass';
  bus.rConv = ctx.createConvolver(); bus.rOut = ctx.createGain();
  bus.rIn.connect(bus.rPre); bus.rPre.connect(bus.rLow); bus.rLow.connect(bus.rConv); bus.rConv.connect(bus.rOut);
  bus.out = ctx.createGain(); bus.dOut.connect(bus.out); bus.rOut.connect(bus.out);
  bus.post = delay(LAT.duck); bus.out.connect(bus.post); bus.post.connect(m.input);
  g.bus = bus;
  for (const t of P.tracks) {
    const n = { input: ctx.createGain(), eq: makeEQ(ctx), vol: ctx.createGain(), pan: ctx.createStereoPanner() };
    if (t.kind === 'voice') {
      n.declick = W('efir-declick', PR.declick(t), t.id + '.declick');
      n.vox = W('efir-vox', PR.vox(t), t.id + '.vox');
      n.la2a = W('efir-la2a', PR.la2a(t), t.id + '.la2a');
      n.rcomp = W('efir-rcomp', PR.rcomp(t), t.id + '.rcomp');
      n.deess = W('efir-deess', PR.deess(t.deess), t.id + '.deess');
      n.input.connect(n.declick); n.declick.connect(n.eq[0]); n.eq[MAXB - 1].connect(n.vox); n.vox.connect(n.rcomp); n.rcomp.connect(n.la2a); n.la2a.connect(n.deess); n.deess.connect(n.vol);
      n.vol.connect(n.pan);
      n.post = delay(LAT.duck); n.pan.connect(n.post); n.post.connect(m.input);
      n.sendD = ctx.createGain(); n.sendR = ctx.createGain();
      n.pan.connect(n.sendD); n.sendD.connect(bus.dIn); n.pan.connect(n.sendR); n.sendR.connect(bus.rIn);
      n.out = n.post;
      n.pan.connect(sc);
      g.workers.push(n.declick, n.vox, n.rcomp, n.la2a, n.deess);
    } else if (t.kind === 'music') {
      n.input.connect(n.eq[0]); n.eq[MAXB - 1].connect(n.vol); n.vol.connect(n.pan);
      n.pre = delay(VOICE_LAT); n.pan.connect(n.pre);
      n.duck = W('efir-ducker', PR.duck(t), t.id + '.duck', 2);
      n.pre.connect(n.duck, 0, 0); n.duck.connect(m.input); n.out = n.duck;
      g.workers.push(n.duck);
    } else {
      n.input.connect(n.eq[0]); n.eq[MAXB - 1].connect(n.vol); n.vol.connect(n.pan);
      n.post = delay(VOICE_LAT + LAT.duck); n.pan.connect(n.post); n.post.connect(m.input); n.out = n.post;
    }
    if (live) { n.an = an(); n.eq[MAXB - 1].connect(n.an); }
    g.tracks[t.id] = n;
  }
  const mu = P.tracks.find((t) => t.kind === 'music');
  if (mu) sc.connect(g.tracks[mu.id].duck, 0, 1);
  applyGraph(g, ov);
  return g;
}
function applyGraph(g, ov = {}) {
  const anySolo = P.tracks.some((t) => t.solo);
  for (const t of P.tracks) {
    const n = g.tracks[t.id]; if (!n) continue;
    applyEQ(n.eq, t.eq);
    const audible = !t.mute && (!anySolo || t.solo);
    n.vol.gain.value = audible ? dbToLin(t.vol) : 0;
    n.pan.pan.value = t.pan || 0;
    if (t.kind === 'voice') {
      n.declick.port.postMessage(PR.declick(t));
      n.vox.port.postMessage(PR.vox(t));
      n.la2a.port.postMessage(PR.la2a(t));
      n.rcomp.port.postMessage(PR.rcomp(t));
      n.deess.port.postMessage(PR.deess(t.deess));
      const sd = t.sends || DEF.sends(), son = sd.on !== false;
      n.sendD.gain.value = son && sd.dbl > -59.5 ? dbToLin(sd.dbl) : 0;
      n.sendR.gain.value = son && sd.rev > -59.5 ? dbToLin(sd.rev) : 0;
    }
    if (t.kind === 'music') n.duck.port.postMessage(PR.duck(t));
  }
  const M = P.master, m = g.master;
  applyBus(g.bus, M.bus || DEF.bus(), g.ctx);
  m.mb.port.postMessage(PR.mb(M));
  applyEQ(m.eq, M.eq);
  m.deess.port.postMessage(PR.deess(M.deess));
  m.tonal.port.postMessage(PR.tonal(M));
  m.glue.port.postMessage(PR.glue(M));
  m.lim.port.postMessage(PR.lim(M, ov));
}
// Reverb impulse response: early reflections + decorrelated noise tail that gets darker as it decays
const irCache = new Map();
function makeIR(ctx, r) {
  const key = [ctx.sampleRate, r.decay, r.tone, r.width].join('|');
  if (irCache.has(key)) return irCache.get(key);
  const sr = ctx.sampleRate, len = Math.round(sr * (r.decay * 1.3 + 0.05));
  const ir = ctx.createBuffer(2, len, sr);
  let seed = 12345; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
  const w = r.width / 100;
  const early = [7, 11, 17, 23, 31, 41, 53].map((ms, i) => [Math.round(ms * sr / 1000), (i % 2 ? -1 : 1) * 0.6 * Math.pow(0.82, i)]);
  const L = ir.getChannelData(0), R = ir.getChannelData(1);
  let lpL = 0, lpR = 0;
  for (let i = 0; i < len; i++) {
    const t = i / sr, env = Math.exp(-6.91 * t / r.decay) * Math.min(1, t / 0.008);
    const fc = r.tone * Math.exp(-t / (r.decay * 0.9)) + 600;
    const a = 1 - Math.exp(-2 * Math.PI * fc / sr);
    const nl = rnd(), nr = rnd() * w + nl * (1 - w);
    lpL += (nl - lpL) * a; lpR += (nr - lpR) * a;
    L[i] = lpL * env; R[i] = lpR * env;
  }
  for (const [n, gain] of early) if (n < len) { L[n] += gain; R[Math.min(len - 1, n + Math.round(w * 0.0007 * sr))] += gain * (w ? -1 : 1) * 0.9; }
  irCache.set(key, ir);
  if (irCache.size > 12) irCache.delete(irCache.keys().next().value);
  return ir;
}
function applyBus(bus, B, ctx) {
  const d = B.dbl, r = B.rev;
  bus.dl.forEach((x, i) => {
    const base = (d.delay + (i ? 7 : 0)) / 1000, f = x.lfo.frequency.value;
    x.d.delayTime.value = base;
    x.depth.gain.value = (Math.pow(2, d.detune / 1200) - 1) / (2 * Math.PI * f);
    x.pan.pan.value = (i ? 1 : -1) * d.width / 100;
  });
  bus.dOut.gain.value = dbToLin(d.ret) * 0.7;
  bus.rPre.delayTime.value = r.predelay / 1000;
  bus.rLow.frequency.value = r.lowcut;
  const ir = makeIR(ctx, r);
  if (bus.rConv.buffer !== ir) bus.rConv.buffer = ir;
  bus.rOut.gain.value = dbToLin(r.ret) * 0.5;
}
function killGraph(g) {
  if (g.bus) for (const x of g.bus.dl) { try { x.lfo.stop(); } catch {} }
  for (const w of g.workers) { try { w.port.postMessage({ dead: true }); w.disconnect(); } catch {} }
}

// Clip gain: equal-power fade shapes; overlaps on the same track become crossfades automatically
const fadeShape = (x) => Math.sin(clamp(x, 0, 1) * Math.PI / 2);
function effFades(c) {
  let xin = 0, xout = 0;
  const ce = c.start + c.dur;
  for (const o of P.clips) {
    if (o === c || o.track !== c.track) continue;
    const oe = o.start + o.dur;
    if (o.start < c.start - 1e-6 && oe > c.start + 1e-6 && oe < ce + 1e-6) xin = Math.max(xin, oe - c.start);
    else if (o.start > c.start + 1e-6 && o.start < ce - 1e-6 && oe > ce - 1e-6) xout = Math.max(xout, ce - o.start);
  }
  let fin = Math.max(c.fin, xin), fout = Math.max(c.fout, xout);
  if (fin + fout > c.dur) { const k = c.dur / (fin + fout); fin *= k; fout *= k; }
  return { fin, fout, xin, xout };
}
function gainAt(c, F, t) {
  let g = 1;
  if (t < F.fin) g *= fadeShape(t / F.fin);
  if (t > c.dur - F.fout) g *= fadeShape((c.dur - t) / F.fout);
  return g;
}
function scheduleClips(g, from, to, t0) { return scheduleList(g.ctx, P.clips, from, to, t0, (c) => g.tracks[c.track].input); }
function scheduleList(ctx, clips, from, to, t0, destFor) {
  const srcs = [];
  for (const c of clips) {
    const e = buffers.get(c.src); if (!e) continue;
    const cs = c.start, ce = c.start + c.dur;
    if (ce <= from || cs >= to) continue;
    const a = Math.max(from, cs), b = Math.min(to, ce);
    const s = ctx.createBufferSource(); s.buffer = e.buf;
    const gn = ctx.createGain(), lin = dbToLin(c.gain), F = effFades(c);
    const rel0 = a - cs, rel1 = b - cs, when = t0 + (a - from);
    gn.gain.value = gainAt(c, F, rel0) * lin;
    for (const [x0, x1] of [[0, F.fin], [c.dur - F.fout, c.dur]]) {
      const s0 = Math.max(x0, rel0), s1 = Math.min(x1, rel1);
      if (s1 - s0 < 0.003) continue;
      const n = 48, curve = new Float32Array(n);
      for (let i = 0; i < n; i++) curve[i] = gainAt(c, F, s0 + (s1 - s0) * i / (n - 1)) * lin;
      try { gn.gain.setValueCurveAtTime(curve, when + (s0 - rel0), s1 - s0 - 0.0005); } catch (err) { console.warn(err); }
    }
    // 3 ms micro-fades where playback cuts into a clip (loop wrap, start mid-clip) so there is no click
    let node = gn;
    if (a > cs + 1e-4 || b < ce - 1e-4) {
      const eg = ctx.createGain(), d = b - a;
      if (a > cs + 1e-4) { eg.gain.setValueAtTime(0, when); eg.gain.linearRampToValueAtTime(1, when + Math.min(0.003, d / 2)); }
      if (b < ce - 1e-4 && isFinite(b)) { eg.gain.setValueAtTime(1, when + d - Math.min(0.003, d / 2)); eg.gain.linearRampToValueAtTime(0, when + d); }
      gn.connect(eg); node = eg;
    }
    s.connect(gn); node.connect(destFor(c));
    s.start(when, c.offset + rel0, rel1 - rel0);
    srcs.push(s);
  }
  return srcs;
}

/* ================= Transport ================= */
const T = { g: null, srcs: [], segs: [], loop: null, stopAt: Infinity, returnTo: 0 };
function projectEnd() { let e = 0; for (const c of P.clips) e = Math.max(e, c.start + c.dur); for (const r of P.regions) e = Math.max(e, r.start + r.len); return e; }
async function play(from = P.playhead, stopAt = Infinity) {
  const ctx = getCtx();
  if (ctx.state !== 'running') await ctx.resume();
  stop(false);
  await Promise.all(P.clips.map((c) => ensureBuffer(c.src)));
  T.g = await buildGraph(ctx, true);
  const L = P.loop;
  T.loop = L && L.on && L.e - L.s > 0.05 && stopAt === Infinity && from < L.e - 0.01 ? { s: L.s, e: L.e } : null;
  T.returnTo = from; T.segs = []; T.srcs = [];
  T.stopAt = T.loop ? Infinity : Math.min(stopAt, projectEnd() + 0.5);
  addSeg(from, T.loop ? T.loop.e : Infinity, ctx.currentTime + 0.08);
  pumpLoop();
  S.playing = true; Meter.reset(); updateToolbar(); redraw();
}
function addSeg(from, to, ctx0) { T.segs.push({ from, to, ctx0 }); T.srcs.push(...scheduleClips(T.g, from, to, ctx0)); }
// keep ~2 s of loop iterations scheduled ahead on the same graph, so the loop is seamless
function pumpLoop() {
  if (!T.loop || !T.g) return;
  let last = T.segs[T.segs.length - 1];
  while (last.ctx0 + (last.to - last.from) < actx.currentTime + 2) {
    addSeg(T.loop.s, T.loop.e, last.ctx0 + (last.to - last.from));
    last = T.segs[T.segs.length - 1];
  }
  if (T.segs.length > 8) T.segs.splice(0, T.segs.length - 8);
  if (T.srcs.length > 400) T.srcs.splice(0, T.srcs.length - 200);
}
function stop(returnHead = true) {
  for (const s of T.srcs) { try { s.stop(); } catch {} }
  T.srcs = [];
  if (T.g) killGraph(T.g);
  T.g = null;
  if (S.playing && returnHead) P.playhead = T.returnTo;
  S.playing = false; updateToolbar(); redraw();
}
function transportTime() {
  if (!S.playing) return P.playhead;
  const t = actx.currentTime - latency(actx) - (actx.outputLatency || 0);
  let seg = T.segs[0];
  if (!seg) return P.playhead;
  for (const x of T.segs) if (x.ctx0 <= t) seg = x;
  return seg.from + Math.max(0, Math.min(t - seg.ctx0, seg.to - seg.from));
}
const togglePlay = () => (S.playing ? stop() : play());
function applyLive() { if (T.g) applyGraph(T.g); }

/* ================= Meters ================= */
const Meter = {
  gr: {}, sumSq: 0, n: 0, win: [], pkL: 0, pkR: 0, hold: -99, maxPk: -99,
  reset() { this.sumSq = 0; this.n = 0; this.win = []; this.hold = -99; this.maxPk = -99; this.gr = {}; },
  buf: new Float32Array(2048),
  tick() {
    if (!T.g || !T.g.master.anL) return;
    const take = Math.min(2048, Math.round(SR / 60));
    const read = (an) => { an.getFloatTimeDomainData(this.buf); let pk = 0, sq = 0; for (let i = 2048 - take; i < 2048; i++) { const v = this.buf[i]; sq += v * v; const a = Math.abs(v); if (a > pk) pk = a; } return [pk, sq]; };
    const [pl, sl] = read(T.g.master.anL), [pr, sr] = read(T.g.master.anR);
    const sq = (sl + sr) / 2;
    this.pkL = Math.max(pl, this.pkL * 0.9); this.pkR = Math.max(pr, this.pkR * 0.9);
    const pk = linToDb(Math.max(pl, pr));
    this.hold = Math.max(this.hold, pk); this.maxPk = Math.max(this.maxPk, pk);
    if (sq > 0) { this.sumSq += sq; this.n += take; }
    this.win.push([sq, take]); if (this.win.length > 180) this.win.shift();
  },
  rmsShort() { let s = 0, n = 0; for (const [a, b] of this.win) { s += a; n += b; } return n ? 10 * Math.log10(s / n + 1e-20) : -Infinity; },
  rmsInt() { return this.n ? 10 * Math.log10(this.sumSq / this.n + 1e-20) : -Infinity; },
  limGr() { return this.gr['master.lim'] ? this.gr['master.lim'].gr : 0; },
};
function drawBarMeter(c, vertical) {
  if (!c || !c.isConnected) return;
  const dpr = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  if (!w || !h) return;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const x = c.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, w, h);
  const scale = (db) => clamp((db + 60) / 60, 0, 1);
  const vals = S.playing ? [Meter.pkL, Meter.pkR] : [0, 0];
  const len = vertical ? h : w, th = vertical ? (w - 6) / 2 : (h - 4) / 2;
  vals.forEach((pk, i) => {
    const v = scale(linToDb(pk)) * len;
    x.fillStyle = '#1b1c1d';
    vertical ? x.fillRect(i * (th + 2), 0, th, h) : x.fillRect(0, i * (th + 2), w, th);
    const grd = vertical ? x.createLinearGradient(0, h, 0, 0) : x.createLinearGradient(0, 0, w, 0);
    grd.addColorStop(0, '#2f9e5b'); grd.addColorStop(0.8, '#8fcf3f'); grd.addColorStop(0.95, '#e6c33a'); grd.addColorStop(1, '#e8483a');
    x.fillStyle = grd;
    vertical ? x.fillRect(i * (th + 2), h - v, th, v) : x.fillRect(0, i * (th + 2), v, th);
  });
  if (vertical) {
    x.fillStyle = 'rgba(255,255,255,.55)'; x.font = '9px ui-monospace, Menlo, monospace'; x.textAlign = 'right';
    for (const d of [0, -6, -12, -18, -24, -36, -48]) { const y = h - scale(d) * h; x.fillRect(w - 4, y, 4, 1); x.fillText(String(d), w - 6, Math.max(8, y + 3)); }
  } else { x.fillStyle = 'rgba(255,255,255,.6)'; x.fillRect(w * scale(-1), 0, 1, h); }
}
function updateMeterText() {
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  set('mRms', S.playing ? fmtDb(Meter.rmsShort()) : '—');
  set('mRmsI', S.playing ? fmtDb(Meter.rmsInt()) : '—');
  set('mPk', S.playing && Meter.hold > -99 ? fmtDb(Meter.hold) : '—');
  set('mRmsM', S.playing ? fmtDb(Meter.rmsShort()) : '—');
  set('mPkM', S.playing && Meter.hold > -99 ? fmtDb(Meter.hold) : '—');
  set('mGr', S.playing ? '−' + Meter.limGr().toFixed(1) : '—');
  const d = Meter.gr['mu.duck'], dg = document.getElementById('duckGr');
  if (dg) dg.style.width = S.playing && d ? clamp(d.gr / 18, 0, 1) * 100 + '%' : '0%';
}

/* ================= Timeline (Reaper-style arrange view) ================= */
const RULER_H = 30, REG_H = 20, TOP = RULER_H + REG_H;
let cv, cx, W = 0, Hh = 0, laneH = 80;
const tToX = (t) => (t - S.x0) * S.pps;
const xToT = (x) => S.x0 + x / S.pps;
const trackIndex = (id) => P.tracks.findIndex((t) => t.id === id);
const laneY = (i) => TOP + i * laneH;
const C = {
  arr: '#2E3031', lane: '#323435', lane2: '#2D2F30', grid: 'rgba(255,255,255,.05)', grid2: 'rgba(255,255,255,.09)',
  ruler: '#232425', rulerTxt: '#A9AEAF', regLane: '#26282A', region: '#3E8C78', regionSel: '#5FC0A5',
  item: '#8E9896', itemSel: '#B9C3C1', itemHead: '#6E7876', itemHeadSel: '#97A3A0', wave: '#1C1F20', edit: '#62D6B9', play: '#F1F3F3',
};

function resize() {
  if (!P) return;
  const wrap = $('#tlwrap');
  W = wrap.clientWidth; Hh = wrap.clientHeight;
  laneH = Math.max(56, Math.floor((Hh - TOP) / (P.tracks.length + 1)));
  const dpr = devicePixelRatio || 1;
  cv.width = Math.round(W * dpr); cv.height = Math.round(Hh * dpr);
  cv.style.width = W + 'px'; cv.style.height = Hh + 'px';
  cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  renderTCP(); redraw();
}
function redraw() { S.dirty = true; if (!S.raf) S.raf = requestAnimationFrame(frame); }
function frame() {
  S.raf = 0;
  let t = P.playhead;
  if (S.playing) {
    pumpLoop();
    t = transportTime();
    if (t >= T.stopAt) stop();
    else {
      if (S.follow && !Drag.active) {
        const x = tToX(t);
        if (x > W * 0.85 || x < 0) S.x0 = t - (W * 0.15) / S.pps;
      }
      Meter.tick(); S.dirty = true;
    }
  }
  const tm = $('#time'); if (tm) tm.textContent = fmtTime(S.playing ? t : P.playhead);
  drawBarMeter($('#meterT'), false); drawBarMeter($('#meterM'), false); updateMeterText();
  if (S.dirty) { draw(); S.dirty = false; }
  if (S.playing) S.raf = requestAnimationFrame(frame);
}
function niceStep() {
  const steps = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120];
  for (const s of steps) if (s * S.pps >= 70) return s;
  return 300;
}
function fmtRuler(t, step) {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(step < 0.1 ? 2 : step < 1 ? 1 : 0).padStart(step < 0.1 ? 5 : step < 1 ? 4 : 2, '0')}`;
}
function draw() {
  const x = cx;
  x.fillStyle = C.arr; x.fillRect(0, 0, W, Hh);
  P.tracks.forEach((t, i) => { x.fillStyle = i % 2 ? C.lane2 : C.lane; x.fillRect(0, laneY(i), W, laneH); x.fillStyle = 'rgba(0,0,0,.35)'; x.fillRect(0, laneY(i) + laneH - 1, W, 1); });
  { // master lane: no clips, just a quiet strip under the tracks
    const y = laneY(P.tracks.length); x.fillStyle = '#26282A'; x.fillRect(0, y, W, Hh - y); x.fillStyle = '#121314'; x.fillRect(0, y, W, 2);
    x.fillStyle = 'rgba(255,255,255,.08)'; x.font = '700 22px -apple-system, system-ui, sans-serif'; x.textBaseline = 'middle'; x.fillText('MASTER', 14, y + laneH / 2);
  }
  // ruler
  x.fillStyle = C.ruler; x.fillRect(0, 0, W, RULER_H);
  x.fillStyle = C.regLane; x.fillRect(0, RULER_H, W, REG_H);
  const step = niceStep(), t0 = Math.floor(xToT(0) / step) * step;
  x.textBaseline = 'alphabetic';
  for (let t = t0; tToX(t) < W; t += step) {
    if (t < -1e-9) continue;
    const px = Math.round(tToX(t)) + 0.5;
    x.fillStyle = C.grid2; x.fillRect(px - 0.5, TOP, 1, Hh - TOP);
    for (let k = 1; k < 4; k++) { const sx = Math.round(tToX(t + step * k / 4)); x.fillStyle = C.grid; x.fillRect(sx, TOP, 1, Hh - TOP); x.fillStyle = '#4A4E50'; x.fillRect(sx, RULER_H - 5, 1, 5); }
    x.fillStyle = '#5A5F61'; x.fillRect(px - 0.5, 4, 1, RULER_H - 4);
    x.fillStyle = C.rulerTxt; x.font = '600 11px -apple-system, system-ui, sans-serif';
    x.fillText(fmtRuler(t, step), px + 4, 14);
    x.fillStyle = '#7C8284'; x.font = '10px ui-monospace, Menlo, monospace';
    x.fillText(fmtTime(t), px + 4, 26);
  }
  if (tToX(0) > 0) { x.fillStyle = 'rgba(0,0,0,.3)'; x.fillRect(0, TOP, tToX(0), Hh - TOP); }
  // loop range: band in the ruler, light tint over the tracks when the loop is on
  const LP = P.loop;
  if (LP && LP.e - LP.s > 0.01) {
    const a = tToX(LP.s), b = tToX(LP.e);
    x.fillStyle = LP.on ? 'rgba(255,214,90,.30)' : 'rgba(255,255,255,.12)'; x.fillRect(a, 0, b - a, RULER_H);
    x.fillStyle = LP.on ? '#FFD65A' : '#9A9FA1'; x.fillRect(a, 0, 2, RULER_H); x.fillRect(b - 2, 0, 2, RULER_H);
    if (LP.on) { x.fillStyle = 'rgba(255,214,90,.05)'; x.fillRect(a, TOP, b - a, Hh - TOP); }
  }
  // regions (Reaper: coloured bars in the region lane, dashed edges through the tracks)
  x.font = '600 11px -apple-system, system-ui, sans-serif'; x.textBaseline = 'middle';
  for (const r of P.regions) {
    const a = tToX(r.start), b = tToX(r.start + r.len); if (b < 0 || a > W) continue;
    const sel = S.selRegion === r.id;
    x.fillStyle = sel ? 'rgba(95,192,165,.10)' : 'rgba(95,192,165,.035)'; x.fillRect(a, TOP, b - a, Hh - TOP);
    x.fillStyle = sel ? C.regionSel : C.region; x.fillRect(a, RULER_H + 2, b - a, REG_H - 4);
    x.fillStyle = sel ? '#0F2A23' : '#E9F5F1';
    x.save(); x.beginPath(); x.rect(a, RULER_H, Math.max(0, b - a - 3), REG_H); x.clip();
    const lenTxt = `${+r.len.toFixed(2)}`;
    x.fillText(r.name.startsWith(lenTxt) ? r.name : `${r.name} · ${lenTxt} с`, a + 6, RULER_H + REG_H / 2); x.restore();
    x.strokeStyle = sel ? 'rgba(95,192,165,.9)' : 'rgba(95,192,165,.35)'; x.setLineDash([3, 4]);
    for (const px of [a, b]) { x.beginPath(); x.moveTo(Math.round(px) + 0.5, TOP); x.lineTo(Math.round(px) + 0.5, Hh); x.stroke(); }
    x.setLineDash([]);
  }
  for (const c of P.clips) drawClip(c);
  // edit cursor / play cursor
  const ed = tToX(P.playhead);
  if (ed >= -2 && ed <= W + 2) {
    x.fillStyle = C.edit; x.fillRect(Math.round(ed) - 0.5, RULER_H, 1.5, Hh - RULER_H);
    x.beginPath(); x.moveTo(ed - 6, 0); x.lineTo(ed + 6, 0); x.lineTo(ed, 9); x.fill();
  }
  if (S.playing) {
    const ph = tToX(transportTime());
    if (ph >= -2 && ph <= W + 2) { x.fillStyle = C.play; x.fillRect(Math.round(ph) - 0.5, 0, 1.5, Hh); }
  }
  if (Drag.snapX != null) { x.fillStyle = 'rgba(255,255,255,.7)'; x.fillRect(Math.round(Drag.snapX), TOP, 1, Hh - TOP); }
  if (Drag.stretchTxt && Drag.active && Drag.active.clip) {
    const r = clipRect(Drag.active.clip); x.font = '700 13px -apple-system, system-ui, sans-serif';
    const tw = x.measureText(Drag.stretchTxt).width + 16, bx = Math.min(W - tw - 4, Math.max(4, r.x + r.w - tw)), by = r.y + HEAD + 6;
    x.fillStyle = '#FFD65A'; x.fillRect(bx, by, tw, 22); x.fillStyle = '#1B1608'; x.textBaseline = 'middle'; x.fillText(Drag.stretchTxt, bx + 8, by + 11);
  }
  x.fillStyle = '#121314'; x.fillRect(0, TOP - 1, W, 1);
}
function clipRect(c) {
  const i = trackIndex(c.track);
  return { x: tToX(c.start), y: laneY(i) + 2, w: c.dur * S.pps, h: laneH - 5 };
}
const HEAD = 15;
function drawClip(c) {
  const r = clipRect(c); if (r.x > W || r.x + r.w < 0) return;
  const x = cx, tc = TRACK_COLORS[c.track] || '#999', sel = S.sel.has(c.id), e = buffers.get(c.src), F = effFades(c);
  x.save(); x.beginPath(); x.rect(r.x, r.y, r.w, r.h); x.clip();
  x.fillStyle = sel ? C.itemSel : C.item; x.fillRect(r.x, r.y, r.w, r.h);
  x.fillStyle = tc; x.globalAlpha = 0.22; x.fillRect(r.x, r.y, r.w, r.h); x.globalAlpha = 1;
  x.fillStyle = sel ? C.itemHeadSel : C.itemHead; x.fillRect(r.x, r.y, r.w, HEAD);
  x.fillStyle = tc; x.fillRect(r.x, r.y, r.w, 2);
  if (e) {
    const mid = r.y + HEAD + (r.h - HEAD) / 2, amp = (r.h - HEAD - 4) / 2, lin = dbToLin(c.gain);
    const xa = Math.max(0, Math.floor(r.x)), xb = Math.min(W, Math.ceil(r.x + r.w));
    x.fillStyle = C.wave;
    const { mn, mx } = e.peaks;
    for (let px = xa; px < xb; px++) {
      const rel = (px - r.x) / S.pps, srcT = c.offset + rel * (c._pv || 1);
      const b0 = Math.floor(srcT * SR / PEAK_BIN), b1 = Math.max(b0 + 1, Math.floor((srcT + 1 / S.pps) * SR / PEAK_BIN));
      let lo = 0, hi = 0;
      for (let b = Math.max(0, b0); b < b1 && b < mn.length; b++) { if (mn[b] < lo) lo = mn[b]; if (mx[b] > hi) hi = mx[b]; }
      const g = gainAt(c, F, rel) * lin;
      const y0 = mid - Math.min(1, hi * g) * amp, y1 = mid - Math.max(-1, lo * g) * amp;
      x.fillRect(px, y0, 1, Math.max(1, y1 - y0));
    }
  }
  // fade curves
  x.strokeStyle = 'rgba(10,12,12,.85)'; x.lineWidth = 1.2;
  const top = r.y + HEAD, bot = r.y + r.h, fh = bot - top;
  if (F.fin > 0.004) { x.beginPath(); for (let i = 0; i <= 24; i++) { const t = F.fin * i / 24, px = r.x + t * S.pps, py = bot - fadeShape(t / F.fin) * fh; i ? x.lineTo(px, py) : x.moveTo(px, py); } x.stroke(); }
  if (F.fout > 0.004) { x.beginPath(); for (let i = 0; i <= 24; i++) { const t = F.fout * i / 24, px = r.x + r.w - t * S.pps, py = bot - fadeShape(t / F.fout) * fh; i ? x.lineTo(px, py) : x.moveTo(px, py); } x.stroke(); }
  if (F.xin > 0) { x.fillStyle = 'rgba(98,214,185,.18)'; x.fillRect(r.x, top, F.xin * S.pps, fh); }
  x.lineWidth = 1;
  // label
  x.fillStyle = '#121414'; x.font = '600 11px -apple-system, system-ui, sans-serif'; x.textBaseline = 'middle';
  x.fillText((c.gain ? `[${fmtDb(c.gain)} dB] ` : '') + c.name, r.x + 5 + Math.max(0, -r.x), r.y + 8.5);
  x.restore();
  x.strokeStyle = sel ? '#F4F7F6' : 'rgba(0,0,0,.55)'; x.lineWidth = sel ? 1.5 : 1;
  x.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1); x.lineWidth = 1;
  if (sel) {
    x.fillStyle = '#fff';
    for (const hx of [r.x + c.fin * S.pps, r.x + r.w - c.fout * S.pps]) { x.beginPath(); x.arc(hx, r.y + HEAD, isTouch ? 5 : 4, 0, Math.PI * 2); x.fill(); }
    x.fillStyle = 'rgba(255,255,255,.95)';
    x.fillRect(r.x + 2, r.y + HEAD + (r.h - HEAD) / 2 - 9, 3, 18); x.fillRect(r.x + r.w - 5, r.y + HEAD + (r.h - HEAD) / 2 - 9, 3, 18);
  }
}

function snapPoints(exclClips, exclReg, track = null) {
  const pts = [0, P.playhead];
  for (const r of P.regions) if (r.id !== exclReg) pts.push(r.start, r.start + r.len);
  for (const c of P.clips) if (!exclClips.has(c.id) && c.track !== track) pts.push(c.start, c.start + c.dur);
  return pts;
}
const snapSec = (t) => (S.snap ? Math.round(t) : Math.round(t * 100) / 100);
// Snaps t (and optionally t+len) to the nearest edge; remembers where to draw the guide line.
function snapTime(t, exclClips = new Set(), len = null, exclReg = null, track = null) {
  Drag.snapX = null;
  if (!S.snap) return t;
  let best = t, bd = (isTouch ? 14 : 9) / S.pps, line = null;
  for (const p of snapPoints(exclClips, exclReg, track)) {
    const d = Math.abs(p - t); if (d < bd) { bd = d; best = p; line = p; }
    if (len != null) { const d2 = Math.abs(p - (t + len)); if (d2 < bd) { bd = d2; best = p - len; line = p; } }
  }
  if (line != null) Drag.snapX = tToX(line);
  return best;
}

/* ================= Pointer interaction ================= */
const Drag = { active: null, ptrs: new Map(), pinch: null, snapX: null };
function hitClip(px, py) {
  for (let i = P.clips.length - 1; i >= 0; i--) {
    const c = P.clips[i], r = clipRect(c);
    if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return { c, r };
  }
  return null;
}
function hitRegion(px) {
  for (const r of P.regions) { const a = tToX(r.start), b = tToX(r.start + r.len); if (px >= a - 6 && px <= b + 6) return { r, a, b }; }
  return null;
}
function onDown(e) {
  cv.setPointerCapture(e.pointerId);
  const rect = cv.getBoundingClientRect(), px = e.clientX - rect.left, py = e.clientY - rect.top;
  Drag.ptrs.set(e.pointerId, { x: px, y: py });
  if (Drag.ptrs.size === 2) {
    if (Drag.active && Drag.active.orig) cancelDrag();
    const [a, b] = [...Drag.ptrs.values()];
    const cxm = (a.x + b.x) / 2;
    Drag.pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, pps0: S.pps, tc: xToT(cxm) };
    Drag.active = null; return;
  }
  if (Drag.ptrs.size > 2) return;
  const t = xToT(px);
  const D = { kind: null, sx: px, sy: py, t0: t, moved: false, shift: e.shiftKey };
  if (py < RULER_H) { D.kind = 'ruler'; }
  else if (py < TOP) {
    const h = hitRegion(px);
    if (h) {
      S.selRegion = h.r.id; S.inspector = 'region'; renderInspector();
      const edge = isTouch ? 16 : 8;
      D.kind = Math.abs(px - h.b) < edge ? 'regLen' : 'regMove'; D.reg = h.r; D.orig = { ...h.r };
    } else { D.kind = 'pan'; D.x00 = S.x0; }
  } else {
    const h = hitClip(px, py);
    if (h) {
      const { c, r } = h;
      D.shift = e.shiftKey || S.multi;
      if (D.shift) { S.sel.has(c.id) && S.sel.size > 1 ? S.sel.delete(c.id) : S.sel.add(c.id); }
      else if (!S.sel.has(c.id)) S.sel = new Set([c.id]);
      S.inspector = 'clip'; renderInspector();
      const edge = Math.min(isTouch ? 18 : 9, r.w / 4);
      const fiX = r.x + c.fin * S.pps, foX = r.x + r.w - c.fout * S.pps;
      const fadeZone = py < r.y + 26;
      if (fadeZone && Math.abs(px - fiX) < (isTouch ? 16 : 8) && S.sel.has(c.id)) D.kind = 'fadeIn';
      else if (fadeZone && Math.abs(px - foX) < (isTouch ? 16 : 8) && S.sel.has(c.id)) D.kind = 'fadeOut';
      else if (S.tool === 'stretch') { D.kind = 'stretch'; D.dur0 = c.dur; S.sel = new Set([c.id]); }
      else if (px - r.x < edge) D.kind = 'trimL';
      else if (r.x + r.w - px < edge) D.kind = 'trimR';
      else D.kind = 'move';
      D.clip = c; D.orig = P.clips.filter((k) => S.sel.has(k.id)).map((k) => ({ ...k }));
      D.track0 = trackIndex(c.track);
    } else { D.kind = 'empty'; D.x00 = S.x0; }
  }
  Drag.active = D; redraw();
}
function cancelDrag() {
  const D = Drag.active; if (!D || !D.orig) return;
  if (Array.isArray(D.orig)) for (const o of D.orig) Object.assign(P.clips.find((c) => c.id === o.id) || {}, o);
  else if (D.reg) Object.assign(D.reg, D.orig);
  Drag.active = null;
}
function onMove(e) {
  if (!Drag.ptrs.has(e.pointerId)) return;
  const rect = cv.getBoundingClientRect(), px = e.clientX - rect.left, py = e.clientY - rect.top;
  Drag.ptrs.set(e.pointerId, { x: px, y: py });
  if (Drag.pinch && Drag.ptrs.size === 2) {
    const [a, b] = [...Drag.ptrs.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y) || 1, cxm = (a.x + b.x) / 2;
    S.pps = clamp(Drag.pinch.pps0 * d / Drag.pinch.d0, 2, 4000);
    S.x0 = Drag.pinch.tc - cxm / S.pps; redraw(); return;
  }
  const D = Drag.active; if (!D) return;
  const dx = px - D.sx, dy = py - D.sy;
  if (!D.moved && Math.hypot(dx, dy) < (isTouch ? 6 : 3)) return;
  D.moved = true;
  const dt = dx / S.pps;
  switch (D.kind) {
    case 'seek': seekTo(xToT(px)); break;
    case 'ruler': {
      const a = snapTime(D.t0, new Set()), b = snapTime(xToT(px), new Set());
      P.loop = { s: Math.max(0, Math.min(a, b)), e: Math.max(0, Math.max(a, b)), on: true };
      updateToolbar(); break;
    }
    case 'pan': case 'empty': S.x0 = D.x00 - dt; break;
    case 'regMove': D.reg.start = Math.max(0, snapSec(D.orig.start + dt)); Drag.snapX = tToX(D.reg.start); break;
    case 'regLen': D.reg.len = Math.max(1, snapSec(D.orig.start + D.orig.len + dt - D.reg.start)); Drag.snapX = tToX(D.reg.start + D.reg.len); break;
    case 'move': {
      const lead = D.orig.find((o) => o.id === D.clip.id);
      let ti = clamp(Math.floor((py - TOP) / laneH), 0, P.tracks.length - 1), dTrack = ti - D.track0;
      const ns = snapTime(lead.start + dt, S.sel, lead.dur, null, P.tracks[ti].id);
      const delta = ns - lead.start;
      for (const o of D.orig) {
        const c = P.clips.find((k) => k.id === o.id);
        c.start = Math.max(0, o.start + delta);
        const oi = trackIndex(o.track);
        c.track = P.tracks[clamp(oi + dTrack, 0, P.tracks.length - 1)].id;
      }
      break;
    }
    case 'trimL': {
      const o = D.orig.find((k) => k.id === D.clip.id), c = D.clip;
      let ns = snapTime(o.start + dt, S.sel, null, null, c.track);
      ns = clamp(ns, o.start - o.offset, o.start + o.dur - 0.02);
      const d = ns - o.start; c.start = ns; c.offset = o.offset + d; c.dur = o.dur - d;
      c.fin = Math.min(c.fin, c.dur / 2); break;
    }
    case 'trimR': {
      const o = D.orig.find((k) => k.id === D.clip.id), c = D.clip, e2 = buffers.get(c.src);
      const maxD = e2 ? e2.buf.duration - o.offset : o.dur;
      const ne = snapTime(o.start + o.dur + dt, S.sel, null, null, c.track);
      c.dur = clamp(ne - o.start, 0.02, maxD); c.fout = Math.min(c.fout, c.dur / 2); break;
    }
    case 'stretch': {
      const c = D.clip, ne = snapTime(c.start + D.dur0 + dt, S.sel, null, null, c.track);
      c.dur = clamp(ne - c.start, D.dur0 / 2, D.dur0 * 2); c._pv = D.dur0 / c.dur;
      Drag.stretchTxt = `${Math.round(c._pv * 1000) / 10}% · ${c.dur.toFixed(2)} с`;
      break;
    }
    case 'fadeIn': { const c = D.clip; c.fin = clamp(xToT(px) - c.start, 0.002, c.dur - c.fout); break; }
    case 'fadeOut': { const c = D.clip; c.fout = clamp(c.start + c.dur - xToT(px), 0.002, c.dur - c.fin); break; }
  }
  redraw();
  if (S.inspector === 'clip' || S.inspector === 'region') refreshInspectorValues();
}
function onUp(e) {
  Drag.ptrs.delete(e.pointerId);
  if (Drag.pinch) { if (Drag.ptrs.size === 0) Drag.pinch = null; return; }
  const D = Drag.active; Drag.active = null; Drag.snapX = null;
  if (!D) return;
  if (D.kind === 'stretch') {
    const c = D.clip, tempo = c._pv; Drag.stretchTxt = null;
    c.dur = D.dur0; delete c._pv;
    if (D.moved && tempo && Math.abs(tempo - 1) > 0.002) stretchSel(tempo); else { renderBar(); redraw(); }
    return;
  }
  if (D.kind === 'ruler') {
    if (!D.moved) seekTo(D.t0);
    else { commit(); if (S.playing) restartPlayback(); }
    redraw(); return;
  }
  if (D.kind === 'empty' && !D.moved) {
    // tap on empty space: deselect and put the cursor there
    S.sel.clear(); S.selRegion = null; S.inspector = 'none';
    P.playhead = Math.max(0, D.t0); if (S.playing) restartPlayback();
    renderInspector();
  } else if (!D.moved && D.clip && !D.shift) {
    // tap on a clip: select it and move the edit cursor to the tap point (like Reaper)
    P.playhead = Math.max(0, D.t0); if (S.playing) restartPlayback();
    refreshInspectorValues();
  }
  if (D.moved && D.orig) { commit(); if (S.playing) restartPlayback(); }
  else if (D.orig) updateToolbar();
  redraw();
}
function seekTo(t) {
  P.playhead = Math.max(0, t);
  if (S.playing) restartPlayback(); else redraw();
}
let restartT = null;
function restartPlayback() { clearTimeout(restartT); restartT = setTimeout(() => { if (S.playing) play(P.playhead); }, 60); }
function onWheel(e) {
  e.preventDefault();
  const rect = cv.getBoundingClientRect(), px = e.clientX - rect.left;
  if (e.ctrlKey || e.metaKey) { const tc = xToT(px); S.pps = clamp(S.pps * Math.exp(-e.deltaY * 0.01), 2, 4000); S.x0 = tc - px / S.pps; }
  else S.x0 += (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) / S.pps;
  redraw();
}
function zoom(f, around) {
  const px = around ?? clamp(tToX(P.playhead), 0, W); const tc = xToT(px);
  S.pps = clamp(S.pps * f, 2, 4000); S.x0 = tc - px / S.pps; redraw();
}
function zoomFit() {
  const end = Math.max(5, projectEnd());
  S.pps = clamp((W - 30) / (end + 1), 2, 4000); S.x0 = -0.3; redraw();
}
function zoomRegion(r) { S.pps = clamp((W - 40) / (r.len + 1), 2, 4000); S.x0 = r.start - 0.5; redraw(); }

/* ================= Editing ops ================= */
const selClips = () => P.clips.filter((c) => S.sel.has(c.id));
function splitAt(t = P.playhead) {
  let targets = selClips().filter((c) => t > c.start + 0.005 && t < c.start + c.dur - 0.005);
  if (!targets.length) targets = P.clips.filter((c) => t > c.start + 0.005 && t < c.start + c.dur - 0.005);
  if (!targets.length) { toast('Под курсором нет клипа'); return; }
  const newSel = new Set();
  for (const c of targets) {
    const d = t - c.start;
    const right = { ...c, id: uid(), start: t, offset: c.offset + d, dur: c.dur - d, fin: 0.005 };
    c.dur = d; c.fout = 0.005; c.fin = Math.min(c.fin, d / 2); right.fout = Math.min(right.fout, right.dur / 2);
    P.clips.push(right); newSel.add(right.id);
  }
  S.sel = newSel; commit(); renderInspector(); redraw();
}
function deleteSel() {
  const cs = selClips(); if (!cs.length) { if (S.selRegion) deleteRegion(); return; }
  for (const c of cs) {
    P.clips.splice(P.clips.indexOf(c), 1);
    if (S.ripple) for (const o of P.clips) if (o.track === c.track && o.start >= c.start + c.dur - 1e-6) o.start -= c.dur;
  }
  S.sel.clear(); S.inspector = 'none'; commit(); renderInspector(); redraw();
}
function nudge(dt) { const cs = selClips(); if (!cs.length) return; for (const c of cs) c.start = Math.max(0, c.start + dt); commit(); redraw(); refreshInspectorValues(); }
function duplicateSel() {
  const cs = selClips(); if (!cs.length) return;
  const end = Math.max(...cs.map((c) => c.start + c.dur)), beg = Math.min(...cs.map((c) => c.start));
  const ns = new Set();
  for (const c of cs) { const k = { ...c, id: uid(), start: c.start + (end - beg) }; P.clips.push(k); ns.add(k.id); }
  S.sel = ns; commit(); redraw();
}
function normalizeSel() {
  for (const c of selClips()) {
    const e = buffers.get(c.src); if (!e) continue;
    let pk = 0; const a0 = Math.floor(c.offset * SR), a1 = Math.min(e.buf.length, Math.floor((c.offset + c.dur) * SR));
    for (let ch = 0; ch < e.buf.numberOfChannels; ch++) { const d = e.buf.getChannelData(ch); for (let i = a0; i < a1; i++) { const v = Math.abs(d[i]); if (v > pk) pk = v; } }
    if (pk > 0) c.gain = Math.round((-1 - linToDb(pk)) * 10) / 10;
  }
  commit(); redraw(); renderInspector();
}
function deleteRegion() {
  const i = P.regions.findIndex((r) => r.id === S.selRegion); if (i < 0) return;
  P.regions.splice(i, 1); S.selRegion = null; S.inspector = 'none'; commit(); renderInspector(); redraw();
}
function regionsEnd() { return P.regions.reduce((m, r) => Math.max(m, r.start + r.len), 0); }
function addVariantSet() {
  const v = 1 + Math.max(1, ...P.regions.map((r) => +(/в(\d+)/.exec(r.name) || [0, 1])[1]));
  const start = Math.ceil(Math.max(regionsEnd(), projectEnd()) + 4);
  P.regions.push(...makeRegionSet(start, v)); commit(); redraw(); toast(`Добавлен набор регионов в${v}`);
  S.x0 = start - 1; redraw();
}
function duplicateRegion(r) {
  const start = Math.ceil(Math.max(regionsEnd(), projectEnd()) + 3), shift = start - r.start, end = r.start + r.len;
  const nr = { id: uid(), name: r.name.replace(/( копия \d+)?$/, '') + ' копия', start, len: r.len };
  let n = 2; while (P.regions.some((x) => x.name === nr.name)) nr.name = r.name + ' копия ' + n++;
  for (const c of [...P.clips]) {
    const cs = Math.max(c.start, r.start), ce = Math.min(c.start + c.dur, end);
    if (ce - cs < 0.01) continue;
    P.clips.push({ ...c, id: uid(), start: cs + shift, offset: c.offset + (cs - c.start), dur: ce - cs, fin: cs > c.start ? 0.005 : c.fin, fout: ce < c.start + c.dur ? 0.005 : c.fout });
  }
  P.regions.push(nr); S.selRegion = nr.id; commit(); renderInspector(); zoomRegion(nr);
}


/* ---------- glue (consolidate) and time-stretch: rendered into new audio files, undoable ---------- */
function makeBuffer(ch) {
  const b = new AudioBuffer({ length: Math.max(1, ch[0].length), numberOfChannels: 2, sampleRate: SR });
  b.copyToChannel(ch[0], 0); b.copyToChannel(ch[1] || ch[0], 1);
  return b;
}
async function addRenderedFile(ch, name) {
  const blob = encodeWav24At(ch.length === 1 ? [ch[0], ch[0]] : ch, SR);
  const fileId = uid();
  await Store.put('blobs', fileId, blob);
  const buf = makeBuffer(ch);
  buffers.set(fileId, { buf, peaks: computePeaks(buf) });
  P.files[fileId] = { name, size: blob.size, dur: buf.duration };
  return { fileId, dur: buf.duration };
}
function sliceClipAudio(c) {
  const e = buffers.get(c.src), a = Math.round(c.offset * SR), n = Math.round(c.dur * SR);
  return [0, 1].map((k) => e.buf.getChannelData(Math.min(k, e.buf.numberOfChannels - 1)).slice(a, a + n));
}
let busy = false;
async function withBusy(label, fn) {
  if (busy) { toast('Подожди, идёт обработка'); return null; }
  busy = true; stop(false);
  try { return await fn(); } catch (e) { console.error(e); toast('Не получилось: ' + e.message, 4000); return null; } finally { busy = false; }
}
async function consolidateClips(list) {
  const track = list[0].track;
  list = list.filter((c) => c.track === track).sort((a, b) => a.start - b.start);
  await Promise.all(list.map((c) => ensureBuffer(c.src)));
  const s = Math.min(...list.map((c) => c.start)), e = Math.max(...list.map((c) => c.start + c.dur));
  const ctx = new OfflineAudioContext(2, Math.max(1, Math.ceil((e - s) * SR)), SR);
  scheduleList(ctx, list, s, e, 0, () => ctx.destination);
  const out = await ctx.startRendering();
  const base = list[0].name.replace(/ ⏩\d+%$/, '').replace(/ \(склейка\)$/, '');
  const { fileId, dur } = await addRenderedFile([out.getChannelData(0), out.getChannelData(1)], base + '_склейка.wav');
  for (const c of list) P.clips.splice(P.clips.indexOf(c), 1);
  const nc = { id: uid(), track, src: fileId, name: base + ' (склейка)', start: s, offset: 0, dur, gain: 0, fin: 0.003, fout: 0.003 };
  P.clips.push(nc);
  return nc;
}
async function glueSel() {
  const cs = selClips(); if (!cs.length) { toast('Выдели клипы'); return; }
  await withBusy('glue', async () => {
    toast('Склеиваю…', 8000);
    const nc = await consolidateClips(cs);
    S.sel = new Set([nc.id]); S.inspector = 'clip';
    commit(); renderBar(); redraw(); toast('Склеено в один клип');
  });
}
async function stretchSel(tempo) {
  let cs = selClips();
  if (!cs.length) { toast('Выдели клип голоса'); return; }
  if (!isFinite(tempo) || Math.abs(tempo - 1) < 0.0005 || tempo < 0.5 || tempo > 2) { toast('Скорость от 50% до 200%'); return; }
  await withBusy('stretch', async () => {
    let c = cs[0];
    if (cs.length > 1) { toast('Склеиваю выделенное…', 8000); c = await consolidateClips(cs); }
    await ensureBuffer(c.src);
    const mode = ls.get('stretchMode', 'st');
    const out = await stretchAudio(sliceClipAudio(c), SR, tempo, mode, (p) => toast(`Ускоряю… ${Math.round(p * 100)}%`, 8000));
    const total = (c.tempo || 1) * tempo, pct = Math.round(total * 1000) / 10;
    const base = c.name.replace(/ ⏩[\d.]+%$/, '');
    const { fileId, dur } = await addRenderedFile(out, `${base}_${pct}%.wav`);
    const oldEnd = c.start + c.dur;
    if (!c.orig) c.orig = { src: c.src, offset: c.offset, dur: c.dur, name: c.name, fin: c.fin, fout: c.fout };
    Object.assign(c, { src: fileId, offset: 0, dur, tempo: total, name: `${base} ⏩${pct}%`, fin: Math.min(c.fin, dur / 2), fout: Math.min(c.fout, dur / 2) });
    if (S.ripple) { const d = c.start + dur - oldEnd; for (const o of P.clips) if (o !== c && o.track === c.track && o.start >= oldEnd - 1e-6) o.start += d; }
    S.sel = new Set([c.id]); S.inspector = 'clip';
    commit(); renderBar(); redraw(); toast(`Готово: ${pct}% · ${dur.toFixed(2)} с (${mode === 'speech' ? 'речь' : 'SoundTouch'})`, 3000);
  });
}
function unstretchSel() {
  const cs = selClips().filter((c) => c.orig); if (!cs.length) return;
  for (const c of cs) {
    const oldEnd = c.start + c.dur;
    Object.assign(c, c.orig); delete c.orig; delete c.tempo;
    if (S.ripple) { const d = c.start + c.dur - oldEnd; for (const o of P.clips) if (o !== c && o.track === c.track && o.start >= oldEnd - 1e-6) o.start += d; }
  }
  commit(); renderBar(); redraw(); toast('Вернул исходную скорость');
}
function selectTrack() {
  const cs = selClips(); if (!cs.length) return;
  S.sel = new Set(P.clips.filter((c) => c.track === cs[0].track).map((c) => c.id)); renderBar(); redraw();
}
function selSpan() { const cs = selClips(); if (!cs.length) return 0; const tr = cs[0].track, l = cs.filter((c) => c.track === tr); return Math.max(...l.map((c) => c.start + c.dur)) - Math.min(...l.map((c) => c.start)); }
function loopTo(s, e) { P.loop = { s, e, on: true }; commit(); updateToolbar(); redraw(); if (S.playing) restartPlayback(); }
function toggleLoop() {
  if (!P.loop || P.loop.e - P.loop.s < 0.05) {
    const cs = selClips(), r = P.regions.find((k) => k.id === S.selRegion);
    if (cs.length) return loopTo(Math.min(...cs.map((c) => c.start)), Math.max(...cs.map((c) => c.start + c.dur)));
    if (r) return loopTo(r.start, r.start + r.len);
    toast('Проведи пальцем по линейке времени, чтобы задать участок лупа', 3500); return;
  }
  P.loop.on = !P.loop.on; commit(); updateToolbar(); redraw(); if (S.playing) restartPlayback();
}

async function renderRange(start, len, limGain) {
  const extra = TOTAL_LAT + 32;
  const frames = Math.ceil(len * SR);
  const ctx = new OfflineAudioContext(2, frames + extra, SR);
  const g = await buildGraph(ctx, false, { limGain });
  scheduleClips(g, start, start + len, 0);
  const out = await ctx.startRendering();
  const off = TOTAL_LAT;
  const L = out.getChannelData(0).slice(off, off + frames), R = out.getChannelData(1).slice(off, off + frames);
  return [L, R];
}
// Everything before the maximizer doesn't depend on its threshold: render that once, then re-run only the limiter
async function renderPre(start, len) {
  const frames = Math.ceil(len * SR) + TOTAL_LAT + LAT.lim + 64;
  const ctx = new OfflineAudioContext(2, frames, SR);
  const saved = P.master.lim.on; P.master.lim.on = false;
  try {
    const g = await buildGraph(ctx, false, {});
    scheduleClips(g, start, start + len, 0);
    return await ctx.startRendering();
  } finally { P.master.lim.on = saved; }
}
async function renderLim(pre, len, limGain) {
  const ctx = new OfflineAudioContext(2, pre.length, SR);
  await ensureWorklet(ctx);
  const src = ctx.createBufferSource(); src.buffer = pre;
  const lim = new AudioWorkletNode(ctx, 'efir-limiter', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { p: PR.lim(P.master, { limGain }) } });
  src.connect(lim); lim.connect(ctx.destination); src.start(0);
  const out = await ctx.startRendering();
  // pre already carries the limiter's latency once (bypassed limiter keeps its delay); this pass adds it again
  const off = TOTAL_LAT + LAT.lim, frames = Math.ceil(len * SR);
  return [out.getChannelData(0).slice(off, off + frames), out.getChannelData(1).slice(off, off + frames)];
}
// Stems: one render, every track (after its own FX, before the master chain) lands in its own channel pair
async function renderStems(start, len, limGain) {
  const stems = [...P.tracks.map((t) => ({ id: t.id, name: t.name })), { id: 'bus', name: 'Даблер и ревер' }];
  const frames = Math.ceil(len * SR), off = VOICE_LAT + LAT.duck;
  const ctx = new OfflineAudioContext(stems.length * 2, frames + off + 64, SR);
  const g = await buildGraph(ctx, false, { limGain });
  g.master.lim.disconnect();
  const merger = ctx.createChannelMerger(stems.length * 2);
  stems.forEach((st, k) => {
    const node = st.id === 'bus' ? g.bus.post : g.tracks[st.id].out;
    const sp = ctx.createChannelSplitter(2); node.connect(sp);
    sp.connect(merger, 0, 2 * k); sp.connect(merger, 1, 2 * k + 1);
  });
  merger.connect(ctx.destination);
  scheduleClips(g, start, start + len, 0);
  const out = await ctx.startRendering();
  return stems.map((st, k) => ({ ...st, ch: [out.getChannelData(2 * k).slice(off, off + frames), out.getChannelData(2 * k + 1).slice(off, off + frames)] }));
}
function encodeWavFloat(ch) {
  const n = ch[0].length, nc = ch.length, data = n * nc * 4;
  const buf = new ArrayBuffer(44 + data), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + data, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 3, true); v.setUint16(22, nc, true); v.setUint32(24, SR, true);
  v.setUint32(28, SR * nc * 4, true); v.setUint16(32, nc * 4, true); v.setUint16(34, 32, true);
  w(36, 'data'); v.setUint32(40, data, true);
  let o = 44; for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) { v.setFloat32(o, ch[c][i], true); o += 4; }
  return new Blob([buf], { type: 'audio/wav' });
}
// Minimal ZIP writer (stored, UTF-8 names) — opens everywhere, no extra library
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
async function makeZip(entries, name) {
  const enc = new TextEncoder(), parts = [], cen = [];
  const d = new Date(), dt = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF, dd = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
  let off = 0;
  for (const e of entries) {
    const data = new Uint8Array(await e.blob.arrayBuffer()), nm = enc.encode(e.name), crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, dt, true); h.setUint16(12, dd, true); h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true);
    h.setUint16(26, nm.length, true); h.setUint16(28, 0, true);
    parts.push(h.buffer, nm, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
    c.setUint16(12, dt, true); c.setUint16(14, dd, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
    c.setUint16(28, nm.length, true); c.setUint32(42, off, true);
    cen.push(c.buffer, nm);
    off += 30 + nm.length + data.length;
  }
  const cenSize = cen.reduce((a, b) => a + b.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true); end.setUint32(12, cenSize, true); end.setUint32(16, off, true);
  return new File([...parts, ...cen, end.buffer], name, { type: 'application/zip' });
}
function rmsDb(ch) { let s = 0, n = 0; for (const d of ch) { for (let i = 0; i < d.length; i++) s += d[i] * d[i]; n += d.length; } return n ? 10 * Math.log10(s / n + 1e-20) : -Infinity; }
function samplePeak(ch) { let p = 0; for (const d of ch) for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > p) p = a; } return p; }
// 4x oversampled true peak (windowed-sinc, 48 taps)
const TP_TAPS = (() => {
  const taps = 12, ph = 4, out = [];
  for (let p = 0; p < ph; p++) {
    const f = []; const frac = p / ph;
    for (let k = -taps / 2 + 1; k <= taps / 2; k++) {
      const x = k - frac, w = 0.5 + 0.5 * Math.cos(Math.PI * x / (taps / 2 + 1));
      f.push((Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)) * w);
    }
    out.push(f);
  }
  return out;
})();
function truePeak(ch) {
  let p = 0;
  for (const d of ch) {
    const n = d.length;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(d[i]); if (a > p) p = a;
      if (a < p * 0.4 && (i + 1 >= n || Math.abs(d[i + 1]) < p * 0.4)) continue;
      for (let ph = 1; ph < 4; ph++) {
        const f = TP_TAPS[ph]; let s = 0;
        for (let k = 0; k < f.length; k++) { const j = i + (k - 5); if (j >= 0 && j < n) s += d[j] * f[k]; }
        const v = Math.abs(s); if (v > p) p = v;
      }
    }
  }
  return p;
}
function lufsI(ch) {
  const kw = (d) => {
    const o = new Float32Array(d.length);
    const s1 = [1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585];
    const s2 = [1, -2, 1, -1.99004745483398, 0.99007225036621];
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0, z1 = 0, z2 = 0;
    for (let i = 0; i < d.length; i++) {
      const x = d[i], y = s1[0] * x + s1[1] * x1 + s1[2] * x2 - s1[3] * y1 - s1[4] * y2; x2 = x1; x1 = x;
      const z = s2[0] * y + s2[1] * y1 + s2[2] * y2 - s2[3] * z1 - s2[4] * z2; y2 = y1; y1 = y; z2 = z1; z1 = z; o[i] = z;
    }
    return o;
  };
  const f = ch.map(kw), blk = Math.round(0.4 * SR), hop = Math.round(0.1 * SR), n = f[0].length;
  const ms = [];
  for (let s = 0; s + blk <= n; s += hop) { let sum = 0; for (const d of f) { let q = 0; for (let i = s; i < s + blk; i++) q += d[i] * d[i]; sum += q / blk; } ms.push(sum); }
  if (!ms.length) return -Infinity;
  const L = (z) => -0.691 + 10 * Math.log10(z + 1e-20);
  const g1 = ms.filter((z) => L(z) > -70); if (!g1.length) return -Infinity;
  const rel = L(g1.reduce((a, b) => a + b, 0) / g1.length) - 10;
  const g2 = g1.filter((z) => L(z) > rel);
  return L(g2.reduce((a, b) => a + b, 0) / g2.length);
}
function finalize(raw) {
  // safety: the exported file never goes above -0.1 dBTP, whatever the limiter is set to
  const M = P.master, ch = raw.map((d) => d.slice());
  const ceil = dbToLin(-0.1), tp = truePeak(ch);
  if (tp > ceil) { const k = ceil / tp * 0.999; for (const d of ch) for (let i = 0; i < d.length; i++) d[i] *= k; }
  if (M.fades) {
    const nf = Math.round(0.05 * SR);
    for (const d of ch) { const n = d.length; for (let i = 0; i < nf && i < n / 2; i++) { const g = i / nf; d[i] *= g; d[n - 1 - i] *= g; } }
  }
  return ch;
}
async function processRegion(r, onStep) {
  const M = P.master; let gain = -M.lim.thresh;
  const pre = await renderPre(r.start, r.len);
  const run = async (g) => (M.lim.on === false ? finalize(await renderRange(r.start, r.len, g)) : finalize(await renderLim(pre, r.len, g)));
  let ch = await run(gain);
  if (M.autoRms) {
    let prev = null;
    for (let it = 0; it < 8; it++) {
      const rm = rmsDb(ch); if (rm < -70) break;
      const diff = M.targetRms - rm; if (Math.abs(diff) < 0.05) break;
      // secant step: how many dB of output RMS one dB of limiter input buys right now
      let slope = 1;
      if (prev && Math.abs(gain - prev.g) > 0.01) slope = clamp((rm - prev.rm) / (gain - prev.g), 0.08, 1);
      prev = { g: gain, rm };
      const ng = clamp(gain + diff / slope, -24, 36);
      if (Math.abs(ng - gain) < 0.01) break;
      gain = ng;
      onStep && onStep(`вход лимитера ${fmtDb(gain)} дБ`);
      ch = await run(gain);
    }
  }
  const stats = { len: r.len, rms: rmsDb(ch), rmsL: rmsDb([ch[0]]), rmsR: rmsDb([ch[1]]), peak: linToDb(samplePeak(ch)), tp: linToDb(truePeak(ch)), lufs: lufsI(ch), gain };
  return { ch, stats };
}

/* ================= Encoders ================= */
function encodeWavQ(ch, L) {
  if ((L.quantize | 0) !== 16) return L.dither === 'None' ? encodeWavBits(ch, 24, false) : encodeWav24(ch);
  return encodeWavBits(ch, 16, L.dither !== 'None');
}
function encodeWavBits(ch, bits, dither) {
  const n = ch[0].length, nc = ch.length, bps = bits / 8, data = n * nc * bps;
  const buf = new ArrayBuffer(44 + data), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + data, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nc, true); v.setUint32(24, SR, true);
  v.setUint32(28, SR * nc * bps, true); v.setUint16(32, nc * bps, true); v.setUint16(34, bits, true);
  w(36, 'data'); v.setUint32(40, data, true);
  let o = 44; const max = bits === 16 ? 32767 : 8388607;
  for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) {
    let s = Math.round(clamp(ch[c][i], -1, 1) * max + (dither ? Math.random() - Math.random() : 0)); s = clamp(s, -max - 1, max);
    if (bits === 16) { v.setInt16(o, s, true); o += 2; } else { v.setUint8(o, s & 255); v.setUint8(o + 1, (s >> 8) & 255); v.setUint8(o + 2, (s >> 16) & 255); o += 3; }
  }
  return new Blob([buf], { type: 'audio/wav' });
}
function encodeWav24(ch) {
  const n = ch[0].length, nc = ch.length, bps = 3, data = n * nc * bps;
  const buf = new ArrayBuffer(44 + data), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + data, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nc, true); v.setUint32(24, SR, true);
  v.setUint32(28, SR * nc * bps, true); v.setUint16(32, nc * bps, true); v.setUint16(34, 24, true);
  w(36, 'data'); v.setUint32(40, data, true);
  let o = 44; const max = 8388607;
  for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) {
    const dith = (Math.random() - Math.random());
    let s = Math.round(clamp(ch[c][i], -1, 1) * max + dith); s = clamp(s, -max - 1, max);
    v.setUint8(o, s & 255); v.setUint8(o + 1, (s >> 8) & 255); v.setUint8(o + 2, (s >> 16) & 255); o += 3;
  }
  return new Blob([buf], { type: 'audio/wav' });
}
let lamePromise = null;
function loadLame() {
  if (window.lamejs) return Promise.resolve();
  if (!lamePromise) lamePromise = new Promise((res, rej) => {
    const urls = ['https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js', 'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js'];
    const tryNext = (i) => {
      if (i >= urls.length) { lamePromise = null; rej(new Error('Нет связи с сервером MP3-кодировщика. Проверь интернет или выбери WAV.')); return; }
      const s = document.createElement('script'); s.src = urls[i]; s.onload = () => res(); s.onerror = () => { s.remove(); tryNext(i + 1); };
      document.head.append(s);
    };
    tryNext(0);
  });
  return lamePromise;
}
async function encodeMp3(ch, sr = SR, kbps = 320, onProgress) {
  await loadLame();
  const mono = ch.length === 1;
  const enc = new lamejs.Mp3Encoder(mono ? 1 : 2, sr, kbps), n = ch[0].length, blk = 1152, parts = [];
  const toI16 = (d) => { const o = new Int16Array(d.length); for (let i = 0; i < d.length; i++) o[i] = clamp(Math.round(d[i] * 32767), -32768, 32767); return o; };
  const L = toI16(ch[0]), R = mono ? null : toI16(ch[1]);
  for (let i = 0, k = 0; i < n; i += blk, k++) {
    const b = mono ? enc.encodeBuffer(L.subarray(i, i + blk)) : enc.encodeBuffer(L.subarray(i, i + blk), R.subarray(i, i + blk));
    if (b.length) parts.push(new Uint8Array(b));
    if (onProgress && k % 400 === 0) { onProgress(i / n); await new Promise((r) => setTimeout(r, 0)); }
  }
  const e = enc.flush(); if (e.length) parts.push(new Uint8Array(e));
  return new Blob(parts, { type: 'audio/mpeg' });
}
function encodeWav24At(ch, sr) {
  const n = ch[0].length, nc = ch.length, bps = 3, data = n * nc * bps;
  const buf = new ArrayBuffer(44 + data), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + data, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nc, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * nc * bps, true); v.setUint16(32, nc * bps, true); v.setUint16(34, 24, true);
  w(36, 'data'); v.setUint32(40, data, true);
  let o = 44; const max = 8388607;
  for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) {
    let x = Math.round(clamp(ch[c][i], -1, 1) * max + (Math.random() - Math.random())); x = clamp(x, -max - 1, max);
    v.setUint8(o, x & 255); v.setUint8(o + 1, (x >> 8) & 255); v.setUint8(o + 2, (x >> 16) & 255); o += 3;
  }
  return new Blob([buf], { type: 'audio/wav' });
}


/* ================= UI: toolbar, track panel, master strip, context bar ================= */
function toast(msg, ms = 2200) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, ms);
}
const ICON = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l13-7.5z" fill="currentColor"/></svg>',
  stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" fill="currentColor"/></svg>',
};
function updateToolbar() {
  if (!P) return;
  const b = $('#bPlay');
  b.classList.toggle('on', S.playing); b.setAttribute('aria-label', S.playing ? 'Стоп' : 'Играть');
  b.innerHTML = S.playing ? ICON.stop : ICON.play;
  $('#tstate').textContent = S.playing ? 'Воспроизведение' : 'Остановлено';
  $('#bSnap').classList.toggle('on', S.snap);
  $('#bRipple').classList.toggle('on', S.ripple);
  const lb = $('#bLoop'); if (lb) lb.classList.toggle('on', !!(P.loop && P.loop.on && P.loop.e > P.loop.s));
  $('#bStretch').classList.toggle('on', S.tool === 'stretch'); $('#bMulti').classList.toggle('on', !!S.multi);
  $('#tl').style.cursor = S.tool === 'stretch' ? 'ew-resize' : '';
  $('#bUndo').disabled = S.hidx <= 0; $('#bRedo').disabled = S.hidx >= S.hist.length - 1;
  $('#projName').textContent = P.name;
}
const renderHeaders = () => renderTCP();
const renderInspector = () => renderBar();
const refreshInspectorValues = () => refreshBar();

function renderTCP() {
  if (!P) return;
  const h = $('#heads'); h.innerHTML = '';
  h.append(el('div', { class: 'tcpTop', style: `height:${TOP}px` }, el('span', {}, 'Дорожки'), el('small', {}, 'тап по имени — FX')));
  const anySolo = P.tracks.some((k) => k.solo);
  P.tracks.forEach((t, i) => {
    const fileIn = el('input', { type: 'file', multiple: true, accept: 'audio/*,.wav,.mp3,.aif,.aiff,.m4a,.flac,.ogg', hidden: true, onchange: (e) => { importFiles([...e.target.files], t.id, P.playhead); e.target.value = ''; } });
    const chain = chainFor(t), active = chain.some((k) => fxOn(t, k));
    const vol = el('input', { type: 'range', class: 'fader', min: -40, max: 12, step: 0.1, value: t.vol, 'aria-label': 'Громкость ' + t.name });
    const volTxt = el('span', { class: 'vtxt mono' }, fmtDb(t.vol) + 'dB');
    vol.addEventListener('input', () => { t.vol = +vol.value; volTxt.textContent = fmtDb(t.vol) + 'dB'; applyLive(); });
    vol.addEventListener('change', commit);
    vol.addEventListener('dblclick', () => { t.vol = 0; vol.value = 0; volTxt.textContent = fmtDb(0) + 'dB'; applyLive(); commit(); });
    const row = el('div', { class: 'tcp' + (t.mute || (anySolo && !t.solo) ? ' muted' : ''), style: `height:${laneH}px;--tc:${TRACK_COLORS[t.id]}` },
      el('div', { class: 'tnum' }, String(i + 1)),
      el('div', { class: 'tmain' },
        el('div', { class: 'trow' },
          el('button', { class: 'tname', onclick: () => openFx(t.id) }, t.name),
          el('button', { class: 'fxb' + (active ? ' act' : ''), onclick: () => openFx(t.id), title: 'Цепочка обработки' }, 'FX'),
          el('button', { class: 'addb', onclick: () => fileIn.click(), 'aria-label': 'Добавить файл на дорожку' }, '+'), fileIn),
        el('div', { class: 'trow' }, vol),
        el('div', { class: 'trow sub' }, volTxt,
          t.kind === 'music' ? el('span', { class: 'grbar', title: 'Подавление музыки голосом' }, el('i', { id: 'duckGr' })) : null)),
      el('div', { class: 'tms' },
        el('button', { class: 'ms' + (t.mute ? ' m' : ''), onclick: () => { t.mute = !t.mute; commit(); applyLive(); renderTCP(); }, 'aria-label': 'Mute' }, 'M'),
        el('button', { class: 'ms' + (t.solo ? ' s' : ''), onclick: () => { t.solo = !t.solo; commit(); applyLive(); renderTCP(); }, 'aria-label': 'Solo' }, 'S')));
    h.append(row);
  });
  // master as its own track row: FX chain + output meter
  const mActive = chainFor('master').some((k) => k !== 'stats' && fxOn(P.master, k));
  h.append(el('div', { class: 'tcp master', style: `height:${Math.max(56, Hh - TOP - laneH * P.tracks.length)}px` },
    el('div', { class: 'tnum' }, 'M'),
    el('div', { class: 'tmain' },
      el('div', { class: 'trow' },
        el('button', { class: 'tname', onclick: () => openFx('master') }, 'MASTER'),
        el('button', { class: 'fxb' + (mActive ? ' act' : ''), onclick: () => openFx('master'), title: 'Мастер-цепочка' }, 'FX')),
      el('div', { class: 'trow' }, el('canvas', { id: 'meterM', class: 'mmtr', 'aria-label': 'Выход мастера' })),
      el('div', { class: 'trow sub' }, el('span', { class: 'mono' }, 'RMS ', el('b', { id: 'mRmsM' }, '—')), el('span', { class: 'mono' }, 'Пик ', el('b', { id: 'mPkM' }, '—')))),
    el('div', { class: 'tms' })));
  redraw();
}
function renderMasterStrip() {
  const fx = document.querySelector('.tcp.master .fxb');
  if (fx) fx.classList.toggle('act', chainFor('master').some((k) => k !== 'stats' && fxOn(P.master, k)));
  const box = $('#mfx'); if (!box) return;
  box.innerHTML = '';
  for (const k of chainFor('master')) {
    const on = fxOn(P.master, k);
    const chk = k === 'stats' ? el('span', { class: 'dotfx on' }) : el('input', { type: 'checkbox', checked: on, 'aria-label': 'Включить ' + FX_NAMES[k] });
    if (chk.tagName === 'INPUT') chk.addEventListener('change', () => { P.master[k].on = chk.checked; applyLive(); commit(); renderMasterStrip(); });
    box.append(el('div', { class: 'mfxrow' + (on ? '' : ' off') }, chk, el('button', { onclick: () => openFx('master', k) }, FX_NAMES[k])));
  }
  const all = allBypassed('master');
  box.append(el('button', { class: 'mbyp' + (all ? ' on' : ''), onclick: () => { toggleBypassAll('master'); renderMasterStrip(); } }, all ? 'Включить все FX' : 'Bypass all'));
}
// Bypass every effect in a chain and remember what was on, so the second press restores exactly that
function allBypassed(target) {
  const obj = targetObj(target), chain = chainFor(target === 'master' ? 'master' : obj).filter((k) => k !== 'stats');
  return chain.every((k) => !fxOn(obj, k));
}
function toggleBypassAll(target) {
  const obj = targetObj(target), chain = chainFor(target === 'master' ? 'master' : obj).filter((k) => k !== 'stats');
  if (!allBypassed(target)) { obj._byp = {}; for (const k of chain) { obj._byp[k] = fxOn(obj, k); obj[k].on = false; } }
  else { for (const k of chain) obj[k].on = obj._byp ? obj._byp[k] !== false : true; delete obj._byp; }
  applyLive(); commit(); renderTCP();
}

/* ---------- context bar (item / region properties) ---------- */
function renderBar() {
  const box = $('#ctx'); if (!box || !P) return;
  box.innerHTML = '';
  const cs = selClips();
  if (S.inspector === 'clip' && cs.length) return barClip(box, cs);
  const r = S.inspector === 'region' && P.regions.find((k) => k.id === S.selRegion);
  if (r) return barRegion(box, r);
  box.append(el('div', { class: 'hint' },
    el('span', {}, el('b', {}, '+'), ' на дорожке — добавить файл'),
    el('span', {}, 'тап — курсор, S — разрезать'),
    el('span', {}, 'наложи клипы — будет кроссфейд'),
    el('span', {}, 'проведи по линейке — луп'),
    el('span', {}, '⧉ Выбор — несколько клипов, ⏱ — растянуть мышкой'),
    el('span', {}, 'имя дорожки или FX — обработка')));
}
function numField(id, value, step, min, onSet, w = '4.6em') {
  const n = el('input', { type: 'number', id, inputmode: 'decimal', step, min, value, class: 'num', style: `width:${w}` });
  n.addEventListener('change', () => { const v = parseFloat(n.value); if (!isNaN(v)) onSet(v); });
  return n;
}
function barClip(box, cs) {
  const c = cs[0];
  const g = el('input', { type: 'range', class: 'fader small', min: -24, max: 12, step: 0.1, value: c.gain, id: 'cGain' });
  const gt = el('span', { class: 'mono vtxt' }, fmtDb(c.gain) + ' dB');
  g.addEventListener('input', () => { for (const k of cs) k.gain = +g.value; gt.textContent = fmtDb(+g.value) + ' dB'; redraw(); });
  g.addEventListener('change', () => { commit(); restartIfPlaying(); });
  g.addEventListener('dblclick', () => { for (const k of cs) k.gain = 0; commit(); renderBar(); redraw(); });
  const fi = numField('cFin', Math.round(c.fin * 1000), 1, 0, (v) => { for (const k of cs) k.fin = clamp(v / 1000, 0.002, k.dur - k.fout); commit(); redraw(); restartIfPlaying(); });
  const fo = numField('cFout', Math.round(c.fout * 1000), 1, 0, (v) => { for (const k of cs) k.fout = clamp(v / 1000, 0.002, k.dur - k.fin); commit(); redraw(); restartIfPlaying(); });
  box.append(
    el('div', { class: 'cgrp' }, el('b', { class: 'cname' }, cs.length > 1 ? `Клипов: ${cs.length}` : c.name), el('span', { id: 'clipPos', class: 'mono dim' }, '')),
    el('label', { class: 'cgrp' }, 'Громкость', g, gt),
    el('label', { class: 'cgrp' }, 'Фейд-ин', fi, 'мс'),
    el('label', { class: 'cgrp' }, 'Фейд-аут', fo, 'мс'),
    el('div', { class: 'cgrp' },
      el('button', { class: 'btn', onclick: () => splitAt() }, 'Разрезать'),
      el('button', { class: 'btn', onclick: duplicateSel }, 'Дубль'),
      el('button', { class: 'btn', onclick: selectTrack, title: 'Выделить все клипы на этой дорожке' }, 'Все на дорожке'),
      el('button', { class: 'btn' + (cs.length > 1 ? ' primary' : ''), onclick: glueSel, title: 'Склеить выделенные клипы в один файл' }, cs.length > 1 ? `Склеить (${cs.length})` : 'Склеить'),
      el('button', { class: 'btn', onclick: () => loopTo(Math.min(...cs.map((k) => k.start)), Math.max(...cs.map((k) => k.start + k.dur))) }, 'Луп'),
      el('button', { class: 'btn danger', onclick: deleteSel }, S.ripple ? 'Удалить со сдвигом' : 'Удалить')));
  if (c.track === 'mu') box.append(raoInline(c.src));
  else if (S.tool === 'stretch') box.append(speedBar(cs));
  refreshBar();
}
function speedBar(cs) {
  const mode = ls.get('stretchMode', 'st');
  const pct = numField('spPct', 110, 0.5, 50, (v) => stretchSel(v / 100), '4.6em');
  const span = selSpan();
  const len = numField('spLen', span.toFixed(2), 0.01, 0.5, (v) => stretchSel(selSpan() / v), '5.2em');
  return el('div', { class: 'cgrp speed' },
    el('b', {}, 'Ускорить'),
    ...[103, 105, 108, 110, 115, 120].map((p) => el('button', { class: 'btn sp', onclick: () => stretchSel(p / 100) }, '+' + (p - 100) + '%')),
    cs.some((c) => c.orig) ? el('button', { class: 'btn danger', onclick: unstretchSel }, 'Отменить ускорение') : null,
    el('button', { class: 'btn sp', onclick: () => stretchSel(0.95), title: 'Замедлить на 5%' }, '−5%'),
    el('label', { class: 'cgrp' }, pct, '%'),
    el('label', { class: 'cgrp' }, 'под', len, 'с'),
    seg2Small([['st', 'SoundTouch'], ['speech', 'Речь']], mode, (v) => { ls.set('stretchMode', v); }));
}
function seg2Small(options, value, onChange) {
  const box = el('div', { class: 'seg2 small' });
  for (const [v, t] of options) { const b = el('button', { class: v === value ? 'on' : '', onclick: () => { for (const k of box.children) k.classList.remove('on'); b.classList.add('on'); onChange(v); } }, t); box.append(b); }
  return box;
}
function raoInline(fileId) {
  const f = P.files[fileId] || { name: '?' }, code = findCode(f.name);
  return el('div', { class: 'cgrp rao' },
    el('button', { class: 'btn', onclick: () => copyText(f.name.replace(/\.[^.]+$/, ''), 'Название скопировано') }, 'Копировать название'),
    code ? el('button', { class: 'btn', onclick: () => copyText(code, 'Код скопирован') }, code) : null,
    el('a', { class: 'btn primary', href: code ? `https://zvukobaza.com/${code}` : 'https://zvukobaza.com/catalog/search', target: '_blank', rel: 'noopener' }, 'Звукобаза'));
}
function barRegion(box, r) {
  const name = el('input', { type: 'text', id: 'regName', value: r.name, class: 'txt', style: 'width:8em' });
  name.addEventListener('change', () => { r.name = name.value.trim() || r.name; commit(); redraw(); });
  const len = numField('regLen', r.len.toFixed(2), 0.01, 0.5, (v) => { r.len = Math.max(0.5, v); commit(); redraw(); refreshBar(); }, '5em');
  box.append(
    el('div', { class: 'cgrp' }, el('b', {}, 'Регион'), name, el('span', { id: 'regPos', class: 'mono dim' }, '')),
    el('label', { class: 'cgrp' }, 'Длина', len, 'с'),
    el('div', { class: 'cgrp' }, ...[5, 10, 15, 20, 30].map((s) => el('button', { class: 'btn' + (Math.abs(r.len - s) < 1e-6 ? ' on' : ''), onclick: () => { r.len = s; commit(); renderBar(); redraw(); } }, s + 'с'))),
    el('div', { class: 'cgrp' },
      el('button', { class: 'btn primary', onclick: () => { P.playhead = r.start; play(r.start, r.start + r.len); } }, 'Слушать'),
      el('button', { class: 'btn', onclick: () => zoomRegion(r) }, 'Показать'),
      el('button', { class: 'btn', onclick: () => loopTo(r.start, r.start + r.len) }, 'Луп'),
      el('button', { class: 'btn primary', onclick: () => duplicateRegion(r), title: 'Копия региона вместе с голосом и музыкой — например, чтобы поменять музыку' }, 'Дублировать регион'),
      el('button', { class: 'btn', onclick: addVariantSet }, '+ набор 30/15/10/5'),
      el('button', { class: 'btn danger', onclick: deleteRegion }, 'Удалить')));
  refreshBar();
}
function refreshBar() {
  const c = selClips()[0], s = $('#clipPos');
  if (c && s) s.textContent = `${fmtTime(c.start)} – ${fmtTime(c.start + c.dur)} · ${c.dur.toFixed(3)} с`;
  const r = P.regions.find((k) => k.id === S.selRegion), rp = $('#regPos');
  if (r && rp) rp.textContent = `${fmtTime(r.start)} – ${fmtTime(r.start + r.len)}`;
  const l = $('#regLen'); if (r && l && document.activeElement !== l) l.value = r.len.toFixed(2);
}
function restartIfPlaying() { if (S.playing) restartPlayback(); }
async function copyText(s, msg = 'Скопировано') {
  try { await navigator.clipboard.writeText(s); toast(msg); }
  catch { const ta = el('textarea', {}, s); document.body.append(ta); ta.select(); try { document.execCommand('copy'); toast(msg); } catch { toast('Выдели и скопируй вручную'); } ta.remove(); }
}
function raoCard(fileId) {
  const f = P.files[fileId] || { name: '?' }, code = findCode(f.name);
  return el('div', { class: 'raocard' },
    el('div', { class: 'raoName mono' }, f.name),
    el('div', { class: 'btns' },
      el('button', { class: 'btn', onclick: () => copyText(f.name.replace(/\.[^.]+$/, ''), 'Название скопировано') }, 'Копировать название'),
      code ? el('button', { class: 'btn', onclick: () => copyText(code, 'Код скопирован') }, 'Копировать ' + code) : null,
      el('a', { class: 'btn primary', href: code ? `https://zvukobaza.com/${code}` : 'https://zvukobaza.com/catalog/search', target: '_blank', rel: 'noopener' }, code ? 'Открыть в Звукобазе' : 'Поиск в Звукобазе')));
}

/* ---------- FX chain window (Reaper-style: list on the left, plugin on the right) ---------- */
const FXW = { target: null, key: null, raf: 0, tick: null };
function openFx(target, key) {
  stopFxLoop();
  const obj = targetObj(target), chain = chainFor(target === 'master' ? 'master' : obj);
  key = key || FXW.lastKey?.[target] || chain[0];
  FXW.target = target; FXW.key = key; (FXW.lastKey ||= {})[target] = key;
  closeModal();
  const trackNo = target === 'master' ? 'Master' : `Track ${trackIndex(target) + 1} «${obj.name}»`;
  const list = el('div', { class: 'fxlist', role: 'listbox' });
  chain.forEach((k, i) => {
    const on = fxOn(obj, k);
    const chk = k === 'stats' ? el('span', { class: 'dotfx on' }) : el('input', { type: 'checkbox', checked: on, 'aria-label': 'Включить ' + FX_NAMES[k] });
    if (chk.tagName === 'INPUT') chk.addEventListener('change', (e) => { e.stopPropagation(); obj[k].on = chk.checked; applyLive(); commit(); renderTCP(); openFx(target, FXW.key); });
    list.append(el('div', { class: 'fxrow' + (k === key ? ' sel' : '') + (on ? '' : ' off'), role: 'option', onclick: (e) => { if (e.target !== chk) openFx(target, k); } }, chk, el('span', {}, FX_NAMES[k])));
  });
  const byp = allBypassed(target);
  list.append(el('button', { class: 'mbyp' + (byp ? ' on' : ''), onclick: () => { toggleBypassAll(target); renderMasterStrip(); openFx(target, FXW.key); } }, byp ? 'Включить все FX' : 'Bypass all'));
  list.append(el('p', { class: 'fxnote' }, 'Обработка идёт сверху вниз'));
  const gui = el('div', { class: 'fxgui' });
  const win = el('div', { class: 'fxwin', role: 'dialog', 'aria-modal': 'true' },
    el('header', { class: 'fxtitle' },
      el('span', {}, `FX: ${trackNo} [${chain.indexOf(key) + 1}/${chain.length}] ${FX_NAMES[key]}`),
      el('button', { class: 'x', 'aria-label': 'Закрыть', onclick: closeModal }, '×')),
    el('div', { class: 'fxbody' }, list, gui));
  const m = el('div', { class: 'modal', id: 'modal', onclick: (e) => { if (e.target.id === 'modal') closeModal(); } }, win);
  document.body.append(m);
  const ctx = { obj, target, key, color: target === 'master' ? '#E8E4DA' : TRACK_COLORS[target], an: () => T.g && (target === 'master' ? (key === 'mb' ? T.g.master.anIn : T.g.master.anEq) : T.g.tracks[target]?.an), gr: (k) => Meter.gr[(target === 'master' ? 'master' : target) + '.' + k], change: () => { applyLive(); }, commit: () => { commit(); renderMasterStrip(); } };
  const ui = FXUI[key](obj, ctx);
  gui.append(ui.el);
  FXW.tick = ui.tick || null;
  if (FXW.tick) startFxLoop();
}
function startFxLoop() {
  const loop = () => { if (!$('#modal .fxwin')) { FXW.raf = 0; return; } try { FXW.tick && FXW.tick(); } catch (e) { console.warn(e); } FXW.raf = requestAnimationFrame(loop); };
  FXW.raf = requestAnimationFrame(loop);
}
function stopFxLoop() { if (FXW.raf) cancelAnimationFrame(FXW.raf); FXW.raf = 0; FXW.tick = null; }

/* ---------- generic modal ---------- */
function modal(titleText, body, actions = []) {
  closeModal();
  const m = el('div', { class: 'modal', id: 'modal', role: 'dialog', 'aria-modal': 'true', onclick: (e) => { if (e.target.id === 'modal') closeModal(); } },
    el('div', { class: 'sheet' },
      el('header', {}, el('h2', {}, titleText), el('button', { class: 'x', 'aria-label': 'Закрыть', onclick: closeModal }, '×')),
      el('div', { class: 'sheetBody' }, body),
      actions.length ? el('footer', {}, ...actions) : null));
  document.body.append(m);
  return m;
}
function closeModal() { stopFxLoop(); const m = $('#modal'); if (m) m.remove(); }

async function openExport() {
  const M = P.master;
  if (!P.regions.length) { toast('Нет регионов. Добавь регион на панели региона.'); return; }
  const checks = P.regions.map((r) => el('label', { class: 'tog' }, el('input', { type: 'checkbox', checked: true, 'data-id': r.id }), el('span', {}, `${r.name}`, el('small', { class: 'mono' }, `  ${r.len} с`))));
  const fmtSel = el('div', { class: 'seg' },
    ...[['wav', `WAV 48 кГц / ${P.master.lim.quantize === 16 ? 16 : 24} бит`], ['mp3', 'MP3 320']].map(([v, t]) => el('label', {}, el('input', { type: 'radio', name: 'fmt', value: v, checked: M.format === v }), el('span', {}, t))));
  const res = el('div', { class: 'results' });
  const stemsChk = el('input', { type: 'checkbox', id: 'expStems', checked: !!M.stems });
  const nameIn = el('input', { type: 'text', class: 'txt', id: 'expName', value: P.exportName || sanitize(P.name), style: 'flex:1;min-width:14em', autocomplete: 'off' });
  const hint = () => {
    const ids = [...document.querySelectorAll('#modal .checks input:checked')].map((i) => i.dataset.id), base = cleanName(nameIn.value || P.name) || 'Ролик';
    const r = P.regions.filter((x) => ids.includes(x.id)), h = document.getElementById('expNameHint');
    if (h) h.textContent = r.length === 1 ? `→ ${base}.wav` : r.length ? `→ ${base}_${sanitize(r[0].name)}.wav …` : '';
  };
  nameIn.addEventListener('input', () => { P.exportName = nameIn.value; scheduleSave(); hint(); });
  setTimeout(() => { hint(); document.querySelectorAll('#modal .checks input').forEach((c) => c.addEventListener('change', hint)); }, 0);
  stemsChk.addEventListener('change', () => { M.stems = stemsChk.checked; scheduleSave(); });
  const body = el('div', {},
    el('h4', {}, 'Регионы'), el('div', { class: 'checks' }, ...checks),
    el('h4', {}, 'Формат'), fmtSel,
    el('h4', {}, 'Имя файла'),
    el('div', { class: 'btns' }, nameIn, el('span', { class: 'dim', id: 'expNameHint' }, '')),
    el('label', { class: 'tog' }, stemsChk, el('span', {}, 'Ещё и стемы в ZIP — каждая дорожка отдельно (с её обработкой, без мастера) + микс')),
    el('p', { class: 'note' }, `Рендер как звучит сейчас: порог лимитера ${fmtDb(M.lim.thresh)} дБ, потолок ${M.lim.ceiling.toFixed(1)} dBTP. Страховка на выходе — не выше −0.1 dBTP.`, M.fades ? ' Фейды 50 мс.' : ''),
    res);
  const go = async (encode) => {
    stop();
    const fmt = body.querySelector('input[name=fmt]:checked').value; M.format = fmt; scheduleSave();
    const ids = [...body.querySelectorAll('.checks input:checked')].map((i) => i.dataset.id);
    const regs = P.regions.filter((r) => ids.includes(r.id));
    if (!regs.length) { toast('Отметь хотя бы один регион'); return; }
    bRun.disabled = bAn.disabled = true;
    await Promise.all(P.clips.map((c) => ensureBuffer(c.src)));
    res.innerHTML = '';
    const table = el('table', { class: 'stats' }, el('thead', {}, el('tr', {}, ...['Регион', 'RMS', 'L / R', 'Peak', 'True peak', 'LUFS-I', 'Порог лим.'].map((h) => el('th', {}, h)))));
    const tb = el('tbody'); table.append(tb);
    res.append(el('div', { class: 'tablewrap' }, table));
    const files = [], zipEntries = [], wantStems = encode && stemsChk.checked;
    for (const r of regs) {
      const row = el('tr', {}, el('td', {}, r.name), el('td', { colspan: 6, class: 'dim' }, 'Рендер…')); tb.append(row);
      try {
        const { ch, stats } = await processRegion(r, (s) => { row.lastChild.textContent = 'Рендер… ' + s; });
        row.lastChild.remove();
        const okTp = stats.tp <= M.lim.ceiling + 0.05;
        const missed = M.autoRms && stats.rms > -70 && Math.abs(stats.rms - M.targetRms) > 0.3;
        row.append(el('td', { class: 'mono' + (missed ? ' bad' : ''), title: missed ? 'Цель не достигнута: лимитер упёрся в предел. Проверь, нет ли в регионе тишины.' : null }, fmtDb(stats.rms, 2)), el('td', { class: 'mono dim' }, `${fmtDb(stats.rmsL)} / ${fmtDb(stats.rmsR)}`), el('td', { class: 'mono' }, fmtDb(stats.peak, 2)),
          el('td', { class: 'mono ' + (okTp ? 'ok' : 'bad') }, fmtDb(stats.tp, 2)), el('td', { class: 'mono' }, fmtDb(stats.lufs, 1)), el('td', { class: 'mono dim' }, fmtDb(-stats.gain)));
        if (encode) {
          const blob = fmt === 'mp3' ? await encodeMp3(ch) : encodeWavQ(ch, P.master.lim);
          const base = cleanName(nameIn.value || P.name) || 'Ролик';
          const name = regs.length === 1 ? `${base}.${fmt}` : `${base}_${sanitize(r.name)}.${fmt}`;
          files.push(new File([blob], name, { type: blob.type }));
          if (wantStems) {
            row.lastChild.textContent = 'стемы…';
            const dir = `${cleanName(nameIn.value || P.name) || 'Ролик'}_${sanitize(r.name)}/`;
            zipEntries.push({ name: dir + `00_Микс.${fmt}`, blob });
            const stems = await renderStems(r.start, r.len, stats.gain);
            let k = 1;
            for (const st of stems) {
              const pk = samplePeak(st.ch); if (pk < 1e-5) continue;
              if (M.fades) { const nf = Math.round(0.05 * SR); for (const d of st.ch) { const n = d.length; for (let i = 0; i < nf && i < n / 2; i++) { const g = i / nf; d[i] *= g; d[n - 1 - i] *= g; } } }
              // pre-master stems can go over 0 dBFS: then they are written as 32-bit float so nothing clips
              const sb = pk > 0.999 ? encodeWavFloat(st.ch) : encodeWav24(st.ch);
              zipEntries.push({ name: dir + `${String(k++).padStart(2, '0')}_${sanitize(st.name)}.wav`, blob: sb });
            }
          }
        }
      } catch (e) { console.error(e); row.lastChild.textContent = 'Ошибка: ' + e.message; row.lastChild.className = 'bad'; }
      await new Promise((ok) => setTimeout(ok, 0));
    }
    bRun.disabled = bAn.disabled = false;
    if (zipEntries.length) { toast('Упаковываю ZIP…', 3000); files.unshift(await makeZip(zipEntries, `${cleanName(nameIn.value || P.name) || 'Ролик'}_стемы.zip`)); }
    if (encode && files.length) { const fp = filesPanel(files, 'Готово — послушай и отправь'); res.prepend(fp); fp.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  };
  const bAn = el('button', { class: 'btn', onclick: () => go(false) }, 'Только статистика');
  const bRun = el('button', { class: 'btn primary', onclick: () => go(true) }, 'Рендер');
  modal('Экспорт регионов', body, [bAn, bRun]);
}
// Result list: each file with its waveform, a play button and ways to save/send it
function filesPanel(files, title = 'Файлы готовы') {
  const urls = files.map((f) => URL.createObjectURL(f));
  const canShare = !!(navigator.canShare && navigator.canShare({ files }));
  const share = async (fs) => {
    try { await navigator.share({ files: fs, title: fs.length === 1 ? fs[0].name : P.name }); }
    catch (e) { if (e.name !== 'AbortError') toast('Не получилось открыть «Поделиться»: ' + e.message, 4000); }
  };
  let current = null;
  const rows = files.map((f, i) => {
    const isAudio = /^audio\//.test(f.type) || /\.(wav|mp3)$/i.test(f.name);
    const wave = isAudio ? el('canvas', { class: 'rwave' }) : null;
    const audio = isAudio ? el('audio', { src: urls[i], preload: 'metadata' }) : null;
    const playBtn = isAudio ? el('button', { class: 'btn rplay', 'aria-label': 'Слушать', onclick: () => {
      if (current && current !== audio) { current.pause(); current.currentTime = 0; }
      if (audio.paused) { audio.play(); current = audio; } else audio.pause();
    } }, '▶') : null;
    if (audio) {
      audio.addEventListener('play', () => { playBtn.textContent = '❚❚'; });
      audio.addEventListener('pause', () => { playBtn.textContent = '▶'; });
      audio.addEventListener('timeupdate', () => { if (wave) wave.parentElement.style.setProperty('--p', (audio.currentTime / (audio.duration || 1) * 100) + '%'); });
    }
    const info = el('small', { class: 'dim' }, (/\.zip$/i.test(f.name) ? 'архив стемов · ' : '') + (f.size / 1048576).toFixed(2) + ' МБ');
    if (wave) (async () => {
      try {
        const buf = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(await f.arrayBuffer());
        info.textContent = `${buf.duration.toFixed(2)} с · ${(f.size / 1048576).toFixed(2)} МБ`;
        requestAnimationFrame(() => {
          const [x, w, h] = canvas2d(wave), d0 = buf.getChannelData(0), d1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : d0, step = d0.length / w;
          x.fillStyle = '#17191A'; x.fillRect(0, 0, w, h); x.fillStyle = '#62D6B9';
          for (let px = 0; px < w; px++) { let mx = 0; for (let j = Math.floor(px * step); j < Math.floor((px + 1) * step); j++) { const v = Math.max(Math.abs(d0[j]), Math.abs(d1[j])); if (v > mx) mx = v; } const hh = mx * (h / 2 - 2); x.fillRect(px, h / 2 - hh, 1, Math.max(1, hh * 2)); }
          x.fillStyle = 'rgba(255,255,255,.12)'; x.fillRect(0, h / 2, w, 1);
        });
      } catch {}
    })();
    return el('div', { class: 'rrow' },
      el('div', { class: 'rhead' }, playBtn, el('span', { class: 'mono rname' }, f.name), info),
      wave ? el('div', { class: 'rwavewrap' }, wave) : null, audio,
      el('div', { class: 'btns' },
        canShare ? el('button', { class: 'btn', onclick: () => share([f]) }, 'Отправить / в Файлы') : null,
        el('a', { class: 'btn', href: urls[i], download: f.name }, 'Скачать')));
  });
  return el('div', { class: 'files results' },
    el('h4', {}, title),
    canShare ? el('div', { class: 'btns' },
      el('button', { class: 'btn primary big', onclick: () => share(files) }, files.length > 1 ? `Отправить все (${files.length}) — Облако, Telegram, почта, Файлы` : 'Отправить — Облако, Telegram, почта, Файлы')) : null,
    el('p', { class: 'note' }, canShare ? 'Чтобы положить в «Загрузки»: «Отправить» → «Сохранить в Файлы» → папка «Загрузки».' : 'Нажми «Скачать» — файл появится в папке «Загрузки».'),
    ...rows,
    el('div', { class: 'btns' }, el('button', { class: 'btn', onclick: () => copyText(files.map((f) => f.name).join('\n'), 'Имена файлов скопированы') }, 'Копировать имена файлов')));
}

function openRao() {
  const used = new Map();
  for (const c of P.clips) if (c.track === 'mu') {
    const u = used.get(c.src) || { secs: 0, regions: new Map() }; u.secs += c.dur;
    for (const r of P.regions) { const ov = Math.min(c.start + c.dur, r.start + r.len) - Math.max(c.start, r.start); if (ov > 0.01) u.regions.set(r.name, (u.regions.get(r.name) || 0) + ov); }
    used.set(c.src, u);
  }
  const body = el('div', {});
  if (!used.size) body.append(el('p', { class: 'note' }, 'На дорожке «Музыка» пока нет файлов. Когда добавишь трек из Звукобазы, здесь появится его название, код и кнопка, которая открывает карточку трека.'));
  for (const [fid, u] of used) {
    body.append(raoCard(fid));
    body.lastChild.append(el('p', { class: 'note' }, [...u.regions].map(([n, s]) => `${n}: ${s.toFixed(1)} с`).join(' · ') || 'Вне регионов'));
  }
  const all = [...used.keys()].map((f) => (P.files[f]?.name || '').replace(/\.[^.]+$/, '')).join('\n');
  modal('Музыка для РАО', body, used.size ? [el('button', { class: 'btn', onclick: () => copyText(all, 'Названия скопированы') }, 'Копировать все названия'), el('a', { class: 'btn primary', href: 'https://zvukobaza.com/catalog/search', target: '_blank', rel: 'noopener' }, 'Открыть Звукобазу')] : []);
}

async function openProjects() {
  const list = (await Store.all('projects')).sort((a, b) => b.updated - a.updated);
  const body = el('div', {});
  const nameIn = el('input', { type: 'text', class: 'txt', value: P.name, id: 'pName' });
  nameIn.addEventListener('change', () => { P.name = nameIn.value.trim() || P.name; commit(); updateToolbar(); });
  body.append(el('label', { class: 'ctl wide' }, el('span', {}, 'Название текущего проекта (идёт в имена файлов)'), nameIn, el('output')));
  const fileIn = el('input', { type: 'file', accept: '.efir', hidden: true, onchange: async (e) => { const f = e.target.files[0]; if (f) { await importProjectFile(f); closeModal(); } } });
  body.append(el('div', { class: 'btns' },
    el('button', { class: 'btn primary', onclick: async () => { await saveNow(); await loadProject(newProject()); closeModal(); } }, 'Новый проект'),
    el('button', { class: 'btn', onclick: async () => { const f = await exportProjectFile(); modal('Файл проекта', filesPanel([f])); } }, 'Сохранить файл проекта'),
    el('button', { class: 'btn', onclick: () => fileIn.click() }, 'Открыть файл проекта'), fileIn));
  body.append(el('h4', {}, 'Проекты на этом устройстве'));
  for (const p of list) {
    const conf = el('span', { class: 'confirm', hidden: true }, 'Удалить без возврата? ',
      el('button', { class: 'btn small danger', onclick: async () => { await Store.del('projects', p.id); if (p.id === P.id) { await loadProject(newProject()); } openProjects(); } }, 'Да'),
      el('button', { class: 'btn small', onclick: (e) => { e.target.parentElement.hidden = true; } }, 'Нет'));
    body.append(el('div', { class: 'frow' + (p.id === P.id ? ' cur' : '') },
      el('button', { class: 'plink', onclick: async () => { await saveNow(); await loadProject(p); closeModal(); } }, p.name),
      el('small', { class: 'dim' }, new Date(p.updated).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ` · клипов: ${p.clips.length}`),
      el('button', { class: 'btn small', onclick: () => { conf.hidden = false; } }, 'Удалить'), conf));
  }
  body.append(el('p', { class: 'note' }, `Эфир ${APP_VERSION}. Проекты и аудио хранятся только на этом устройстве. Для переноса или резервной копии сохраняй файл проекта.`));
  modal('Проекты', body);
}
async function saveNow() { clearTimeout(S.saveTimer); P.updated = Date.now(); await Store.put('projects', P.id, JSON.parse(JSON.stringify(P))); }
// Project file: "EFIR1" + u32 json length + json + raw blobs in order
async function exportProjectFile() {
  await saveNow();
  const ids = Object.keys(P.files), blobs = [];
  for (const id of ids) blobs.push(await Store.get('blobs', id));
  const meta = { project: P, blobs: ids.map((id, i) => ({ id, size: blobs[i] ? blobs[i].size : 0, type: blobs[i] ? blobs[i].type : '' })) };
  const json = new TextEncoder().encode(JSON.stringify(meta));
  const head = new Uint8Array(9); head.set(new TextEncoder().encode('EFIR1')); new DataView(head.buffer).setUint32(5, json.length, true);
  return new File([head, json, ...blobs.filter(Boolean)], sanitize(P.name) + '.efir', { type: 'application/octet-stream' });
}
async function importProjectFile(f) {
  const ab = await f.arrayBuffer(), u8 = new Uint8Array(ab);
  if (new TextDecoder().decode(u8.subarray(0, 5)) !== 'EFIR1') { toast('Это не файл проекта Эфира'); return; }
  const len = new DataView(ab).getUint32(5, true);
  const meta = JSON.parse(new TextDecoder().decode(u8.subarray(9, 9 + len)));
  let o = 9 + len;
  for (const b of meta.blobs) { if (!b.size) continue; await Store.put('blobs', b.id, new Blob([u8.subarray(o, o + b.size)], { type: b.type })); o += b.size; }
  const p = meta.project; p.id = uid(); p.name = p.name + ' (импорт)';
  await Store.put('projects', p.id, p);
  await loadProject(p); toast('Проект открыт');
}

/* ================= Boot ================= */
async function loadProject(p) {
  stop(false);
  P = migrate(p); S.sel.clear(); S.selRegion = null; S.inspector = 'none';
  S.hist = []; S.hidx = -1; commit();
  ls.set('last', P.id);
  renderHeaders(); renderInspector(); updateToolbar(); resize();
  await Promise.all(Object.keys(P.files).map((id) => ensureBuffer(id).catch(() => null)));
  if (P.clips.length) zoomFit(); else { S.pps = clamp((W - 30) / 70, 4, 200); S.x0 = -0.5; }
  redraw();
}


function bindUI() {
  cv = $('#tl'); cx = cv.getContext('2d');
  cv.addEventListener('pointerdown', onDown); cv.addEventListener('pointermove', onMove);
  cv.addEventListener('pointerup', onUp); cv.addEventListener('pointercancel', onUp);
  cv.addEventListener('wheel', onWheel, { passive: false });
  cv.addEventListener('dragover', (e) => e.preventDefault());
  cv.addEventListener('drop', (e) => {
    e.preventDefault(); const r = cv.getBoundingClientRect(), py = e.clientY - r.top, px = e.clientX - r.left;
    const ti = clamp(Math.floor((py - TOP) / laneH), 0, P.tracks.length - 1);
    const fs = [...e.dataTransfer.files].filter((f) => /audio|\.(wav|mp3|aiff?|m4a|flac|ogg)$/i.test(f.type + f.name));
    if (fs.length) importFiles(fs, P.tracks[ti].id, Math.max(0, xToT(px)));
  });
  new ResizeObserver(resize).observe($('#tlwrap'));
  $('#bPlay').onclick = togglePlay;
  $('#bHome').onclick = () => { seekTo(0); S.x0 = -0.5; redraw(); };
  $('#bSplit').onclick = () => splitAt();
  $('#bDel').onclick = deleteSel;
  $('#bUndo').onclick = undo; $('#bRedo').onclick = redo;
  $('#bSnap').onclick = () => { S.snap = !S.snap; ls.set('snap', S.snap); updateToolbar(); };
  $('#bRipple').onclick = () => { S.ripple = !S.ripple; ls.set('ripple', S.ripple); updateToolbar(); renderBar(); };
  $('#bZin').onclick = () => zoom(1.5); $('#bZout').onclick = () => zoom(1 / 1.5); $('#bFit').onclick = zoomFit;
  $('#bExport').onclick = openExport; $('#bRao').onclick = openRao; $('#projName').onclick = openProjects;
  $('#bStretch').onclick = () => { S.tool = S.tool === 'stretch' ? 'edit' : 'stretch'; updateToolbar(); renderBar(); toast(S.tool === 'stretch' ? 'Растяжение: тяни клип за край — длина меняется вместе со скоростью' : 'Обычный монтаж', 2600); };
  $('#bMulti').onclick = () => { S.multi = !S.multi; updateToolbar(); toast(S.multi ? 'Мультивыбор: тапай клипы по очереди, потом «Склеить»' : 'Мультивыбор выключен', 2600); };
  $('#bPresets').onclick = openPresets; $('#bConvert').onclick = openConverter; $('#bLoop').onclick = toggleLoop;


  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input[type=text], input[type=number], textarea, select')) return;
    const mod = e.metaKey || e.ctrlKey;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (mod && e.code === 'KeyZ') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && e.code === 'KeyY') { e.preventDefault(); redo(); }
    else if (mod && e.code === 'KeyD') { e.preventDefault(); duplicateSel(); }
    else if (!mod && e.code === 'KeyS') splitAt();
    else if (e.code === 'Delete' || e.code === 'Backspace') { e.preventDefault(); deleteSel(); }
    else if (e.code === 'ArrowLeft') { e.preventDefault(); selClips().length ? nudge(e.shiftKey ? -0.1 : -0.01) : seekTo(P.playhead - (e.shiftKey ? 1 : 0.1)); }
    else if (e.code === 'ArrowRight') { e.preventDefault(); selClips().length ? nudge(e.shiftKey ? 0.1 : 0.01) : seekTo(P.playhead + (e.shiftKey ? 1 : 0.1)); }
    else if (e.key === '=' || e.key === '+') zoom(1.5);
    else if (e.key === '-') zoom(1 / 1.5);
    else if (e.code === 'Home') seekTo(0);
    else if (!mod && e.code === 'KeyR') toggleLoop();
    else if (!mod && e.code === 'KeyG') glueSel();
    else if (e.code === 'Escape') { if ($('#modal')) closeModal(); else { S.sel.clear(); S.selRegion = null; S.inspector = 'none'; renderBar(); redraw(); } }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow().catch(() => {}); });
}
async function boot() {
  bindUI();
  try { await Store.open(); } catch (e) { toast('Хранилище браузера недоступно: проекты не сохранятся', 5000); }
  let p = null;
  try { const last = ls.get('last'); if (last) p = await Store.get('projects', last); } catch {}
  await loadProject(p || newProject());
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
}
window.addEventListener('DOMContentLoaded', boot);


/* ================= Presets (whole-mix settings) ================= */
// A preset keeps every track's processing, volume and pan plus the whole master chain; clips and regions stay untouched.
const Presets = {
  all() { const v = ls.get('presets', []); return Array.isArray(v) ? v : []; },
  save(list) { ls.set('presets', list); },
  getDefault() { const id = ls.get('presetDefault', null); return id ? this.all().find((p) => p.id === id) || null : null; },
  setDefault(id) { ls.set('presetDefault', id); },
};
const PRESET_TRACK_KEYS = ['vol', 'pan', 'declick', 'eq', 'vox', 'rcomp', 'la2a', 'deess', 'drive', 'duck', 'sends'];
function capturePreset(name) {
  const tracks = {};
  for (const t of P.tracks) { tracks[t.id] = {}; for (const k of PRESET_TRACK_KEYS) if (t[k] !== undefined) tracks[t.id][k] = JSON.parse(JSON.stringify(t[k])); }
  const { format, ...master } = P.master;
  return { id: uid(), name, created: Date.now(), v: 2, tracks, master: JSON.parse(JSON.stringify(master)) };
}
function applyPresetTo(p, pr) {
  for (const t of p.tracks) { const src = pr.tracks && pr.tracks[t.id]; if (src) for (const k of PRESET_TRACK_KEYS) if (src[k] !== undefined) t[k] = JSON.parse(JSON.stringify(src[k])); }
  if (pr.master) Object.assign(p.master, JSON.parse(JSON.stringify(pr.master)));
  upgradeLim(p.master);
  for (const t of p.tracks) if (t.kind === 'voice') { if (!t.la2a) t.la2a = DEF.la2a(); if (!t.sends) t.sends = DEF.sends(); if (!t.rcomp) t.rcomp = DEF.rcomp(); if (t.drive) t.drive.on = false; }
  if (!p.master.glue) p.master.glue = DEF.glue();
  if (!p.master.bus) p.master.bus = DEF.bus();
  if (!p.master.tonal) p.master.tonal = DEF.tonal();
  return p;
}
function openPresets() {
  const body = el('div', {});
  const list = Presets.all(), defId = ls.get('presetDefault', null);
  const nameIn = el('input', { type: 'text', class: 'txt', id: 'presetName', placeholder: 'Например: «Радио, голос + музыка»', style: 'flex:1;min-width:12em' });
  const mkDef = el('input', { type: 'checkbox', id: 'presetDef', checked: !list.length });
  body.append(el('p', { class: 'note' }, 'Пресет запоминает обработку всех дорожек и мастера: FX, громкости, панораму, лимитер и целевой RMS. Клипы и регионы не трогает.'));
  body.append(el('h4', {}, 'Сохранить текущие настройки'));
  body.append(el('div', { class: 'btns' }, nameIn,
    el('button', { class: 'btn primary', onclick: () => {
      const name = nameIn.value.trim() || `Пресет ${new Date().toLocaleDateString('ru-RU')}`;
      const pr = capturePreset(name), all = Presets.all();
      const same = all.findIndex((x) => x.name === name);
      if (same >= 0) { pr.id = all[same].id; all[same] = pr; } else all.push(pr);
      Presets.save(all); if (mkDef.checked) Presets.setDefault(pr.id);
      toast(same >= 0 ? 'Пресет обновлён' : 'Пресет сохранён'); openPresets();
    } }, 'Сохранить')));
  body.append(el('label', { class: 'tog' }, mkDef, el('span', {}, 'Использовать для всех новых проектов')));
  body.append(el('h4', {}, 'Мои пресеты'));
  if (!list.length) body.append(el('p', { class: 'note' }, 'Пока пусто. Настрой обработку один раз и сохрани её здесь.'));
  for (const pr of list) {
    const isDef = pr.id === defId;
    const conf = el('span', { class: 'confirm', hidden: true }, 'Удалить? ',
      el('button', { class: 'btn small danger', onclick: () => { Presets.save(Presets.all().filter((x) => x.id !== pr.id)); if (isDef) Presets.setDefault(null); openPresets(); } }, 'Да'),
      el('button', { class: 'btn small', onclick: (e) => { e.target.parentElement.hidden = true; } }, 'Нет'));
    body.append(el('div', { class: 'frow' + (isDef ? ' cur' : '') },
      el('b', { class: 'plink' }, (isDef ? '★ ' : '') + pr.name),
      el('small', { class: 'dim' }, new Date(pr.created).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })),
      el('button', { class: 'btn small primary', onclick: () => { applyPresetTo(P, pr); commit(); applyLive(); renderTCP(); toast(`Применён «${pr.name}»`); closeModal(); } }, 'Применить'),
      el('button', { class: 'btn small', onclick: () => { Presets.setDefault(isDef ? null : pr.id); openPresets(); } }, isDef ? 'Убрать по умолчанию' : 'По умолчанию'),
      el('button', { class: 'btn small', onclick: () => { const f = new File([JSON.stringify(pr, null, 1)], sanitize(pr.name) + '.efirpreset', { type: 'application/json' }); modal('Файл пресета', filesPanel([f], 'Пресет для переноса на другое устройство')); } }, 'В файл'),
      el('button', { class: 'btn small', onclick: () => { conf.hidden = false; } }, 'Удалить'), conf));
  }
  const fileIn = el('input', { type: 'file', accept: '.efirpreset,application/json', hidden: true, onchange: async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const pr = JSON.parse(await f.text());
      if (!pr || !pr.tracks || !pr.master) throw new Error('bad');
      pr.id = uid(); const all = Presets.all(); all.push(pr); Presets.save(all); toast(`Добавлен «${pr.name}»`); openPresets();
    } catch { toast('Это не файл пресета Эфира'); }
  } });
  body.append(el('div', { class: 'btns' }, el('button', { class: 'btn', onclick: () => fileIn.click() }, 'Открыть файл пресета'), fileIn,
    el('button', { class: 'btn', onclick: () => { applyPresetTo(P, { tracks: Object.fromEntries(baseProject('').tracks.map((t) => [t.id, t])), master: baseProject('').master }); commit(); applyLive(); renderTCP(); toast('Вернул заводские настройки'); closeModal(); } }, 'Заводские настройки')));
  modal('Пресеты', body);
}

/* ================= Converter (any audio → MP3 / WAV) ================= */
function openConverter() {
  const st = { files: [], kbps: ls.get('convKbps', 320), sr: ls.get('convSr', 44100), fmt: ls.get('convFmt', 'mp3') };
  const body = el('div', {});
  const listBox = el('div', { class: 'files' });
  const fileIn = el('input', { type: 'file', multiple: true, accept: 'audio/*,.wav,.mp3,.aif,.aiff,.m4a,.flac,.ogg,.aac,.wma,video/*', hidden: true, onchange: (e) => { st.files.push(...e.target.files); e.target.value = ''; renderList(); } });
  const res = el('div', {});
  const renderList = () => {
    listBox.innerHTML = '';
    if (!st.files.length) listBox.append(el('p', { class: 'note' }, 'Файлы не выбраны. Подойдут WAV, AIFF, M4A, MP3, FLAC и звук из видео.'));
    st.files.forEach((f, i) => listBox.append(el('div', { class: 'frow' }, el('span', { class: 'mono' }, f.name), el('small', { class: 'dim' }, (f.size / 1048576).toFixed(1) + ' МБ'),
      el('button', { class: 'x', 'aria-label': 'Убрать', onclick: () => { st.files.splice(i, 1); renderList(); } }, '×'))));
    go.disabled = !st.files.length;
  };
  const opt = (name, options, key) => el('div', { class: 'seg' }, ...options.map(([v, t]) => el('label', {}, el('input', { type: 'radio', name, value: v, checked: String(st[key]) === String(v), onchange: () => { st[key] = isNaN(+v) ? v : +v; ls.set('conv' + key[0].toUpperCase() + key.slice(1), st[key]); kb.hidden = st.fmt !== 'mp3'; } }), el('span', {}, t))));
  const kb = el('div', {}, el('h4', {}, 'Битрейт'), opt('kbps', [[320, '320 kbps'], [256, '256'], [192, '192'], [128, '128']], 'kbps'));
  kb.hidden = st.fmt !== 'mp3';
  const go = el('button', { class: 'btn primary', onclick: async () => {
    go.disabled = true; res.innerHTML = '';
    const out = [], log = el('div', { class: 'files' }); res.append(log);
    for (const f of st.files) {
      const row = el('div', { class: 'frow' }, el('span', { class: 'mono' }, f.name), el('small', { class: 'dim' }, 'декодирую…')); log.append(row);
      try {
        const ctx = new OfflineAudioContext(2, 1, st.sr);
        const buf = await ctx.decodeAudioData(await f.arrayBuffer());
        const ch = []; for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) ch.push(buf.getChannelData(c));
        const base = f.name.replace(/\.[^.]+$/, '');
        let blob;
        if (st.fmt === 'mp3') blob = await encodeMp3(ch, st.sr, st.kbps, (p) => { row.lastChild.textContent = 'кодирую ' + Math.round(p * 100) + '%'; });
        else blob = encodeWav24At(ch, st.sr);
        out.push(new File([blob], `${base}.${st.fmt}`, { type: blob.type }));
        row.lastChild.textContent = `${buf.duration.toFixed(1)} с · ${(blob.size / 1048576).toFixed(2)} МБ`; row.lastChild.className = 'ok';
      } catch (e) { console.error(e); row.lastChild.textContent = /Нет связи/.test(e.message) ? e.message : 'не удалось прочитать файл'; row.lastChild.className = 'bad'; }
    }
    if (out.length) res.append(filesPanel(out, 'Готово'));
    go.disabled = false;
  } }, 'Конвертировать');
  body.append(
    el('div', { class: 'btns' }, el('button', { class: 'btn', onclick: () => fileIn.click() }, '+ Выбрать файлы'), fileIn),
    listBox,
    el('h4', {}, 'Формат'), opt('fmt', [['mp3', 'MP3'], ['wav', 'WAV 24 бит']], 'fmt'),
    kb,
    el('h4', {}, 'Частота'), opt('sr', [[44100, '44.1 кГц'], [48000, '48 кГц']], 'sr'),
    el('p', { class: 'note' }, 'Конвертирует без обработки: громкость и звук не меняются. Стерео остаётся стерео, моно — моно.'),
    res);
  modal('Конвертер', body, [go]);
  renderList();
}
