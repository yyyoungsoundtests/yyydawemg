'use strict';
/* Эфир — монтаж и сведение радиороликов. Один файл логики, без сборки. */

const SR = 48000;
const APP_VERSION = '0.1.0';
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
const TRACK_COLORS = { v1: '#F0B13C', v2: '#E7744E', mu: '#4DB6A8', fx: '#A595E6' };
const eqBand = (type, f, g = 0, q = 1, on = true) => ({ type, f, g, q, on });
function defaultEQ(kind) {
  if (kind === 'voice') return [eqBand('highpass', 80, 0, 0.71), eqBand('lowshelf', 180, 0), eqBand('peaking', 350, -2, 1.2), eqBand('peaking', 3200, 2, 1), eqBand('highshelf', 9000, 2), eqBand('lowpass', 18000, 0, 0.71, false)];
  if (kind === 'radio') return [eqBand('highpass', 380, 0, 0.9), eqBand('peaking', 900, -2, 1.4), eqBand('peaking', 1800, 5, 0.9), eqBand('lowpass', 3600, 0, 1.1)];
  if (kind === 'music') return [eqBand('highpass', 35, 0, 0.71), eqBand('peaking', 250, 0, 1), eqBand('peaking', 2500, 0, 1), eqBand('highshelf', 10000, 0)];
  if (kind === 'master') return [eqBand('highpass', 30, 0, 0.71), eqBand('lowshelf', 120, 0), eqBand('peaking', 3000, 0, 1), eqBand('highshelf', 12000, 0)];
  return [eqBand('highpass', 40, 0, 0.71), eqBand('peaking', 1000, 0, 1), eqBand('highshelf', 10000, 0)];
}
function makeRegionSet(start, variant) {
  const out = []; let t = start;
  for (const len of [30, 15, 10, 5]) {
    out.push({ id: uid(), name: variant > 1 ? `${len}с в${variant}` : `${len}с`, start: t, len });
    t += len + 3;
  }
  return out;
}
function newProject(name = 'Новый ролик') {
  return {
    id: uid(), name, created: Date.now(), updated: Date.now(), v: 1,
    tracks: [
      { id: 'v1', name: 'Голос', kind: 'voice', vol: 0, pan: 0, mute: false, solo: false, eq: defaultEQ('voice'), rvox: { on: true, amount: 5, gain: 0 }, drive: 0 },
      { id: 'v2', name: 'Голос радио', kind: 'voice', vol: 0, pan: 0, mute: false, solo: false, eq: defaultEQ('radio'), rvox: { on: true, amount: 6, gain: 0 }, drive: 0.35 },
      { id: 'mu', name: 'Музыка', kind: 'music', vol: -6, pan: 0, mute: false, solo: false, eq: defaultEQ('music'), duck: { on: true, depth: 8, sens: 6, attack: 10, release: 150, lo: 150, hi: 8000 } },
      { id: 'fx', name: 'Эффекты', kind: 'fx', vol: 0, pan: 0, mute: false, solo: false, eq: defaultEQ('fx') },
    ],
    master: {
      eq: defaultEQ('master'),
      comp: { on: true, thresh: -10, ratio: 4, attack: 10, release: 0.3, makeup: 0 },
      lim: { gain: 4, ceiling: -1, release: 80 },
      autoRms: true, targetRms: -10.5, fades: true, format: 'wav',
    },
    clips: [], regions: makeRegionSet(0, 1), files: {}, playhead: 0,
  };
}

/* ================= App state ================= */
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
      const clip = { id: uid(), track: trackId, src: fileId, name: f.name.replace(/\.[^.]+$/, ''), start: t, offset: 0, dur: buf.duration, gain: 0, fin: 0.005, fout: 0.005 };
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
let actx = null, workletReady = new WeakMap(), COMP_DELAY = 0.006;
function getCtx() {
  if (!actx) {
    try { actx = new AudioContext({ sampleRate: SR, latencyHint: 'playback' }); } catch { actx = new AudioContext(); }
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
  }
  return actx;
}
async function ensureWorklet(ctx) {
  if (!workletReady.has(ctx)) workletReady.set(ctx, ctx.audioWorklet.addModule('dsp.js'));
  await workletReady.get(ctx);
}
// Measure DynamicsCompressor pre-delay of this browser once, so tracks stay aligned.
async function measureCompDelay() {
  try {
    const c = new OfflineAudioContext(1, 2048, SR);
    const b = c.createBuffer(1, 2048, SR); b.getChannelData(0)[10] = 0.5;
    const s = c.createBufferSource(); s.buffer = b;
    const k = c.createDynamicsCompressor(); k.threshold.value = 0; k.ratio.value = 1;
    s.connect(k).connect(c.destination); s.start();
    const out = (await c.startRendering()).getChannelData(0);
    let mi = 0; for (let i = 0; i < out.length; i++) if (Math.abs(out[i]) > Math.abs(out[mi])) mi = i;
    COMP_DELAY = Math.max(0, (mi - 10) / SR);
  } catch (e) { console.warn('comp delay', e); }
}
const DUCK_N = 1024, LIM_LA = 69;
const latency = () => DUCK_N / SR + COMP_DELAY * 2 + LIM_LA / SR;

function setBand(node, b) {
  if (!b || !b.on) { node.type = 'peaking'; node.gain.value = 0; node.frequency.value = 1000; node.Q.value = 1; return; }
  node.type = b.type;
  node.frequency.value = clamp(b.f, 10, SR / 2 - 100);
  node.gain.value = b.type === 'highpass' || b.type === 'lowpass' ? 0 : b.g;
  node.Q.value = b.type === 'highpass' || b.type === 'lowpass' ? 20 * Math.log10(Math.max(0.1, b.q)) : Math.max(0.1, b.q);
}
const MAXB = 8;
function makeEQ(ctx) { const n = []; for (let i = 0; i < MAXB; i++) n.push(ctx.createBiquadFilter()); for (let i = 1; i < MAXB; i++) n[i - 1].connect(n[i]); return n; }
function driveCurve(d) {
  if (!d) return null;
  const k = 1 + d * 9, n = 2048, c = new Float32Array(n), norm = Math.tanh(k);
  for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; c[i] = Math.tanh(k * x) / norm; }
  return c;
}
const sslMakeupComp = (t, r) => 0.6 * t * (1 - 1 / r); // cancels the built-in auto make-up of DynamicsCompressor

async function buildGraph(ctx, live, overrides = {}) {
  await ensureWorklet(ctx);
  const g = { ctx, tracks: {}, live };
  // master
  const m = {};
  m.input = ctx.createGain();
  m.eq = makeEQ(ctx);
  m.comp = ctx.createDynamicsCompressor();
  m.mk = ctx.createGain();
  const LM = P.master.lim;
  m.lim = new AudioWorkletNode(ctx, 'efir-limiter', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { p: { gain: overrides.limGain ?? LM.gain, ceiling: LM.ceiling, release: LM.release } } });
  m.input.connect(m.eq[0]); m.eq[MAXB - 1].connect(m.comp); m.comp.connect(m.mk); m.mk.connect(m.lim); m.lim.connect(ctx.destination);
  if (live) {
    m.split = ctx.createChannelSplitter(2);
    m.anL = ctx.createAnalyser(); m.anR = ctx.createAnalyser(); m.anL.fftSize = m.anR.fftSize = 2048;
    m.lim.connect(m.split); m.split.connect(m.anL, 0); m.split.connect(m.anR, 1);
    m.lim.port.onmessage = (e) => { Meter.limGr = e.data.gr; };
  }
  g.master = m;
  // sidechain bus for voices
  const sc = ctx.createGain();
  for (const t of P.tracks) {
    const n = { input: ctx.createGain(), eq: makeEQ(ctx), vol: ctx.createGain(), pan: ctx.createStereoPanner() };
    n.input.connect(n.eq[0]);
    let last = n.eq[MAXB - 1];
    if (t.kind === 'voice') {
      n.drive = ctx.createWaveShaper(); n.drive.oversample = '4x';
      n.comp = ctx.createDynamicsCompressor(); n.out = ctx.createGain();
      last.connect(n.drive); n.drive.connect(n.comp); n.comp.connect(n.out); n.out.connect(n.vol);
      n.vol.connect(n.pan);
      n.delay = ctx.createDelay(1); n.delay.delayTime.value = DUCK_N / SR;
      n.pan.connect(n.delay); n.delay.connect(m.input);
      n.pan.connect(sc);
    } else if (t.kind === 'music') {
      n.pre = ctx.createDelay(1); n.pre.delayTime.value = COMP_DELAY;
      last.connect(n.vol); n.vol.connect(n.pan); n.pan.connect(n.pre);
      n.duck = new AudioWorkletNode(ctx, 'efir-ducker', { numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { p: { ...t.duck } } });
      n.pre.connect(n.duck, 0, 0);
      n.duck.connect(m.input);
      if (live) n.duck.port.onmessage = (e) => { Meter.duckGr = e.data.gr; };
    } else {
      n.delay = ctx.createDelay(1); n.delay.delayTime.value = DUCK_N / SR + COMP_DELAY;
      last.connect(n.vol); n.vol.connect(n.pan); n.pan.connect(n.delay); n.delay.connect(m.input);
    }
    g.tracks[t.id] = n;
  }
  const mu = P.tracks.find((t) => t.kind === 'music');
  if (mu) sc.connect(g.tracks[mu.id].duck, 0, 1);
  applyGraph(g, overrides);
  return g;
}
function applyGraph(g, overrides = {}) {
  const anySolo = P.tracks.some((t) => t.solo);
  for (const t of P.tracks) {
    const n = g.tracks[t.id]; if (!n) continue;
    for (let i = 0; i < MAXB; i++) setBand(n.eq[i], t.eq[i]);
    const audible = !t.mute && (!anySolo || t.solo);
    n.vol.gain.value = audible ? dbToLin(t.vol) : 0;
    n.pan.pan.value = t.pan || 0;
    if (t.kind === 'voice') {
      n.drive.curve = driveCurve(t.drive);
      const a = t.rvox.on ? t.rvox.amount : 0;
      n.comp.threshold.value = -3 * a; n.comp.ratio.value = a > 0 ? 4 : 1; n.comp.knee.value = 8;
      n.comp.attack.value = 0.003; n.comp.release.value = 0.12;
      n.out.gain.value = dbToLin(t.rvox.on ? t.rvox.gain : 0);
    }
    if (t.kind === 'music') n.duck.port.postMessage({ ...t.duck });
  }
  const M = P.master, m = g.master;
  for (let i = 0; i < MAXB; i++) setBand(m.eq[i], M.eq[i]);
  const c = M.comp, thr = c.on ? c.thresh : 0, ratio = c.on ? c.ratio : 1;
  m.comp.threshold.value = thr; m.comp.ratio.value = ratio; m.comp.knee.value = 2;
  m.comp.attack.value = c.attack / 1000; m.comp.release.value = c.release;
  m.mk.gain.value = dbToLin((c.on ? c.makeup : 0) + sslMakeupComp(thr, ratio));
  m.lim.port.postMessage({ gain: overrides.limGain ?? M.lim.gain, ceiling: M.lim.ceiling, release: M.lim.release });
}

function scheduleClips(g, from, to, t0) {
  const ctx = g.ctx, srcs = [];
  for (const c of P.clips) {
    const e = buffers.get(c.src); if (!e) continue;
    const cs = c.start, ce = c.start + c.dur;
    if (ce <= from || cs >= to) continue;
    const a = Math.max(from, cs), b = Math.min(to, ce);
    const s = ctx.createBufferSource(); s.buffer = e.buf;
    const gn = ctx.createGain();
    const lin = dbToLin(c.gain);
    const rel0 = a - cs, rel1 = b - cs, when = t0 + (a - from);
    const pts = [[0, 0], [c.fin, 1], [c.dur - c.fout, 1], [c.dur, 0]].map(([t, v]) => [clamp(t, 0, c.dur), v]);
    const valAt = (t) => { for (let i = 1; i < pts.length; i++) if (t <= pts[i][0]) { const [t0_, v0] = pts[i - 1], [t1, v1] = pts[i]; return t1 - t0_ < 1e-6 ? v1 : v0 + (v1 - v0) * (t - t0_) / (t1 - t0_); } return 0; };
    gn.gain.setValueAtTime(valAt(rel0) * lin, when);
    for (const [t, v] of pts) if (t > rel0 && t <= rel1) gn.gain.linearRampToValueAtTime(v * lin, when + (t - rel0));
    s.connect(gn); gn.connect(g.tracks[c.track].input);
    s.start(when, c.offset + rel0, rel1 - rel0);
    srcs.push(s);
  }
  return srcs;
}

/* ================= Transport ================= */
const T = { g: null, srcs: [], t0: 0, from: 0, stopAt: Infinity, returnTo: 0 };
function projectEnd() { let e = 0; for (const c of P.clips) e = Math.max(e, c.start + c.dur); for (const r of P.regions) e = Math.max(e, r.start + r.len); return e; }
async function play(from = P.playhead, stopAt = Infinity) {
  const ctx = getCtx();
  if (ctx.state !== 'running') await ctx.resume();
  stop(false);
  await Promise.all(P.clips.map((c) => ensureBuffer(c.src)));
  T.g = await buildGraph(ctx, true);
  T.from = from; T.returnTo = from; T.t0 = ctx.currentTime + 0.08;
  T.stopAt = Math.min(stopAt, projectEnd() + 0.5);
  T.srcs = scheduleClips(T.g, from, Infinity, T.t0);
  S.playing = true; Meter.reset(); updateToolbar(); loop();
}
function stop(returnHead = true) {
  for (const s of T.srcs) { try { s.stop(); } catch {} }
  T.srcs = [];
  if (T.g) killGraph(T.g);
  T.g = null;
  if (S.playing && returnHead) P.playhead = T.returnTo;
  S.playing = false; updateToolbar(); redraw();
}
function killGraph(g) {
  try { g.master.lim.port.postMessage({ dead: true }); g.master.lim.disconnect(); } catch {}
  for (const n of Object.values(g.tracks)) if (n.duck) try { n.duck.port.postMessage({ dead: true }); n.duck.disconnect(); } catch {}
}
function transportTime() {
  if (!S.playing) return P.playhead;
  return T.from + Math.max(0, actx.currentTime - T.t0 - latency() - (actx.outputLatency || 0));
}
const togglePlay = () => (S.playing ? stop() : play());
function applyLive() { if (T.g) applyGraph(T.g); }

/* ================= Meters ================= */
const Meter = {
  limGr: 0, duckGr: 0, sumSq: 0, n: 0, win: [], pkL: 0, pkR: 0, hold: -99,
  reset() { this.sumSq = 0; this.n = 0; this.win = []; this.hold = -99; this.limGr = 0; this.duckGr = 0; },
  buf: new Float32Array(2048),
  tick() {
    if (!T.g || !T.g.master.anL) return;
    const take = Math.min(2048, Math.round(SR / 60));
    const read = (an) => { an.getFloatTimeDomainData(this.buf); let pk = 0, sq = 0; for (let i = 2048 - take; i < 2048; i++) { const v = this.buf[i]; sq += v * v; const a = Math.abs(v); if (a > pk) pk = a; } return [pk, sq]; };
    const [pl, sl] = read(T.g.master.anL), [pr, sr] = read(T.g.master.anR);
    const sq = (sl + sr) / 2;
    this.pkL = Math.max(pl, this.pkL * 0.92); this.pkR = Math.max(pr, this.pkR * 0.92);
    this.hold = Math.max(this.hold, linToDb(Math.max(pl, pr)));
    if (sq > 0) { this.sumSq += sq; this.n += take; }
    this.win.push([sq, take]); if (this.win.length > 180) this.win.shift();
  },
  rmsShort() { let s = 0, n = 0; for (const [a, b] of this.win) { s += a; n += b; } return n ? 10 * Math.log10(s / n + 1e-20) : -Infinity; },
  rmsInt() { return this.n ? 10 * Math.log10(this.sumSq / this.n + 1e-20) : -Infinity; },
};
function drawMeter() {
  const c = $('#meter'); if (!c) return;
  const dpr = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr; }
  const x = c.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, w, h);
  const scale = (db) => clamp((db + 48) / 48, 0, 1);
  const bars = [Meter.pkL, Meter.pkR];
  bars.forEach((pk, i) => {
    const y = 3 + i * 8, v = scale(linToDb(pk));
    x.fillStyle = 'rgba(255,255,255,.07)'; x.fillRect(0, y, w, 5);
    const grd = x.createLinearGradient(0, 0, w, 0); grd.addColorStop(0, '#4DB6A8'); grd.addColorStop(0.75, '#F0B13C'); grd.addColorStop(0.97, '#FF5A47');
    x.fillStyle = grd; x.fillRect(0, y, w * v, 5);
  });
  x.fillStyle = 'rgba(255,255,255,.35)'; x.fillRect(w * scale(-1) - 0.5, 0, 1, 19);
  $('#mRms').textContent = S.playing ? fmtDb(Meter.rmsShort()) : '—';
  $('#mRmsI').textContent = S.playing ? fmtDb(Meter.rmsInt()) : '—';
  $('#mPk').textContent = S.playing && Meter.hold > -99 ? fmtDb(Meter.hold) : '—';
  $('#mGr').textContent = S.playing ? (Meter.limGr > 0.05 ? '−' + Meter.limGr.toFixed(1) : '0.0') : '—';
  const dg = $('#duckGr'); if (dg) dg.style.width = S.playing ? clamp(Meter.duckGr / 18, 0, 1) * 100 + '%' : '0%';
  const sslGr = $('#sslGr'); if (sslGr) sslGr.textContent = S.playing && T.g ? fmtDb(T.g.master.comp.reduction) : '—';
  const limGrI = $('#limGrI'); if (limGrI) limGrI.textContent = S.playing ? '−' + Meter.limGr.toFixed(1) : '—';
  const duckGrI = $('#duckGrI'); if (duckGrI) duckGrI.textContent = S.playing ? '−' + Meter.duckGr.toFixed(1) : '—';
}

/* ================= Timeline geometry ================= */
const RULER_H = 26, REG_H = 26, TOP = RULER_H + REG_H;
let cv, cx, W = 0, Hh = 0, laneH = 80;
const tToX = (t) => (t - S.x0) * S.pps;
const xToT = (x) => S.x0 + x / S.pps;
const trackIndex = (id) => P.tracks.findIndex((t) => t.id === id);
const laneY = (i) => TOP + i * laneH;

function resize() {
  if (!P) return;
  const wrap = $('#tlwrap');
  W = wrap.clientWidth; Hh = wrap.clientHeight;
  laneH = Math.max(56, Math.floor((Hh - TOP) / P.tracks.length));
  const dpr = devicePixelRatio || 1;
  cv.width = Math.round(W * dpr); cv.height = Math.round(Hh * dpr);
  cv.style.width = W + 'px'; cv.style.height = Hh + 'px';
  cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  renderHeaders(); redraw();
}
function redraw() { S.dirty = true; if (!S.raf) S.raf = requestAnimationFrame(frame); }
function loop() { redraw(); }
function frame() {
  S.raf = 0;
  if (S.playing) {
    const t = transportTime();
    if (t >= T.stopAt) { stop(); }
    else {
      if (S.follow && !Drag.active) {
        const x = tToX(t);
        if (x > W * 0.85 || x < 0) S.x0 = t - (W * 0.15) / S.pps;
      }
      Meter.tick(); S.dirty = true;
    }
    $('#time').textContent = fmtTime(S.playing ? t : P.playhead);
  } else $('#time').textContent = fmtTime(P.playhead);
  drawMeter();
  if (S.dirty) { draw(); S.dirty = false; }
  if (S.playing) S.raf = requestAnimationFrame(frame);
}
function niceStep() {
  const steps = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120];
  for (const s of steps) if (s * S.pps >= 64) return s;
  return 300;
}
function fmtRuler(t, step) { const m = Math.floor(t / 60), s = t - m * 60; return step < 1 ? `${m}:${s.toFixed(step < 0.1 ? 2 : 1).padStart(step < 0.1 ? 5 : 4, '0')}` : `${m}:${String(Math.round(s)).padStart(2, '0')}`; }

function draw() {
  const x = cx, css = getComputedStyle(document.documentElement);
  const col = (n) => css.getPropertyValue(n).trim();
  x.clearRect(0, 0, W, Hh);
  // lanes
  P.tracks.forEach((t, i) => { x.fillStyle = i % 2 ? col('--lane2') : col('--lane'); x.fillRect(0, laneY(i), W, laneH); });
  // grid + ruler
  x.fillStyle = col('--panel'); x.fillRect(0, 0, W, TOP);
  const step = niceStep(), t0 = Math.floor(xToT(0) / step) * step;
  x.font = '500 10.5px "JetBrains Mono", ui-monospace, monospace'; x.textBaseline = 'middle';
  for (let t = t0; tToX(t) < W; t += step) {
    const px = Math.round(tToX(t)) + 0.5; if (t < -1e-9) continue;
    x.strokeStyle = col('--grid'); x.beginPath(); x.moveTo(px, TOP); x.lineTo(px, Hh); x.stroke();
    x.strokeStyle = col('--dim'); x.beginPath(); x.moveTo(px, RULER_H - 7); x.lineTo(px, RULER_H); x.stroke();
    x.fillStyle = col('--dim'); x.fillText(fmtRuler(t, step), px + 4, RULER_H / 2);
    for (let k = 1; k < 4; k++) { const sx = Math.round(tToX(t + step * k / 4)) + 0.5; x.beginPath(); x.moveTo(sx, RULER_H - 3); x.lineTo(sx, RULER_H); x.stroke(); }
  }
  if (tToX(0) > 0) { x.fillStyle = 'rgba(0,0,0,.35)'; x.fillRect(0, TOP, tToX(0), Hh - TOP); }
  // regions
  x.font = '600 11px "Golos Text", system-ui, sans-serif';
  for (const r of P.regions) {
    const a = tToX(r.start), b = tToX(r.start + r.len); if (b < 0 || a > W) continue;
    const sel = S.selRegion === r.id;
    x.fillStyle = sel ? 'rgba(240,177,60,.12)' : 'rgba(240,177,60,.045)'; x.fillRect(a, TOP, b - a, Hh - TOP);
    x.fillStyle = sel ? col('--accent') : 'rgba(240,177,60,.38)';
    x.fillRect(a, RULER_H + 3, b - a, REG_H - 6);
    x.fillStyle = sel ? '#1b1508' : col('--fg');
    x.save(); x.beginPath(); x.rect(a, RULER_H, Math.max(0, b - a - 4), REG_H); x.clip();
    const lenTxt = `${+r.len.toFixed(2)}`; x.fillText(r.name.startsWith(lenTxt) ? r.name : `${r.name}  ·  ${lenTxt} с`, a + 7, RULER_H + REG_H / 2); x.restore();
    x.strokeStyle = sel ? 'rgba(240,177,60,.9)' : 'rgba(240,177,60,.35)'; x.setLineDash([4, 4]);
    for (const px of [a, b]) { x.beginPath(); x.moveTo(Math.round(px) + 0.5, TOP); x.lineTo(Math.round(px) + 0.5, Hh); x.stroke(); }
    x.setLineDash([]);
  }
  // clips
  for (const c of P.clips) drawClip(c);
  // playhead
  const ph = tToX(S.playing ? transportTime() : P.playhead);
  if (ph >= -2 && ph <= W + 2) {
    x.strokeStyle = col('--play'); x.lineWidth = 1.5; x.beginPath(); x.moveTo(ph, 0); x.lineTo(ph, Hh); x.stroke(); x.lineWidth = 1;
    x.fillStyle = col('--play'); x.beginPath(); x.moveTo(ph - 6, 0); x.lineTo(ph + 6, 0); x.lineTo(ph, 9); x.fill();
  }
  if (Drag.snapX != null) { x.strokeStyle = '#fff'; x.globalAlpha = 0.6; x.beginPath(); x.moveTo(Drag.snapX + 0.5, TOP); x.lineTo(Drag.snapX + 0.5, Hh); x.stroke(); x.globalAlpha = 1; }
  x.strokeStyle = col('--line'); x.beginPath(); x.moveTo(0, TOP - 0.5); x.lineTo(W, TOP - 0.5); x.stroke();
}
function clipRect(c) {
  const i = trackIndex(c.track);
  return { x: tToX(c.start), y: laneY(i) + 3, w: c.dur * S.pps, h: laneH - 6 };
}
function drawClip(c) {
  const r = clipRect(c); if (r.x > W || r.x + r.w < 0) return;
  const x = cx, color = TRACK_COLORS[c.track] || '#999', sel = S.sel.has(c.id);
  const e = buffers.get(c.src);
  x.save(); x.beginPath(); x.roundRect ? x.roundRect(r.x, r.y, r.w, r.h, 4) : x.rect(r.x, r.y, r.w, r.h); x.clip();
  x.fillStyle = color + (sel ? '55' : '2e'); x.fillRect(r.x, r.y, r.w, r.h);
  x.fillStyle = color + (sel ? 'ee' : '99'); x.fillRect(r.x, r.y, r.w, 15);
  // waveform
  if (e) {
    const mid = r.y + 15 + (r.h - 15) / 2, amp = (r.h - 19) / 2, lin = dbToLin(c.gain);
    const xa = Math.max(0, Math.floor(r.x)), xb = Math.min(W, Math.ceil(r.x + r.w));
    x.fillStyle = sel ? color : color + 'cc';
    const { mn, mx } = e.peaks;
    for (let px = xa; px < xb; px++) {
      const rel = (px - r.x) / S.pps, srcT = c.offset + rel;
      const b0 = Math.floor(srcT * SR / PEAK_BIN), b1 = Math.max(b0 + 1, Math.floor((srcT + 1 / S.pps) * SR / PEAK_BIN));
      let lo = 0, hi = 0;
      for (let b = b0; b < b1 && b < mn.length; b++) { if (b < 0) continue; if (mn[b] < lo) lo = mn[b]; if (mx[b] > hi) hi = mx[b]; }
      let fg = 1; if (rel < c.fin) fg = rel / c.fin; else if (rel > c.dur - c.fout) fg = (c.dur - rel) / c.fout;
      const y0 = mid - Math.min(1, hi * lin * clamp(fg, 0, 1)) * amp, y1 = mid - Math.max(-1, lo * lin * clamp(fg, 0, 1)) * amp;
      x.fillRect(px, y0, 1, Math.max(1, y1 - y0));
    }
  } else { x.fillStyle = color; x.fillText('…', r.x + 6, r.y + r.h / 2); }
  // fades
  x.strokeStyle = 'rgba(255,255,255,.75)'; x.lineWidth = 1;
  const fi = c.fin * S.pps, fo = c.fout * S.pps;
  x.beginPath(); x.moveTo(r.x, r.y + r.h); x.lineTo(r.x + fi, r.y + 15); x.stroke();
  x.beginPath(); x.moveTo(r.x + r.w - fo, r.y + 15); x.lineTo(r.x + r.w, r.y + r.h); x.stroke();
  // name
  x.fillStyle = '#121212'; x.font = '600 10.5px "Golos Text", system-ui, sans-serif'; x.textBaseline = 'middle';
  x.fillText(c.name + (c.gain ? `  ${fmtDb(c.gain)} дБ` : ''), r.x + 6 + Math.max(0, -r.x), r.y + 8);
  x.restore();
  if (sel) {
    x.strokeStyle = '#fff'; x.lineWidth = 1.5; x.strokeRect(r.x + 0.75, r.y + 0.75, r.w - 1.5, r.h - 1.5); x.lineWidth = 1;
    // fade handles
    x.fillStyle = '#fff';
    for (const hx of [r.x + fi, r.x + r.w - fo]) { x.beginPath(); x.arc(hx, r.y + 15, isTouch ? 5 : 4, 0, Math.PI * 2); x.fill(); }
    // trim grips
    x.fillStyle = 'rgba(255,255,255,.9)';
    x.fillRect(r.x + 2, r.y + r.h / 2 - 10, 3, 20); x.fillRect(r.x + r.w - 5, r.y + r.h / 2 - 10, 3, 20);
  }
}

/* ================= Snapping ================= */
function snapPoints(exclClips, exclReg) {
  const pts = [0, P.playhead];
  for (const r of P.regions) if (r.id !== exclReg) pts.push(r.start, r.start + r.len);
  for (const c of P.clips) if (!exclClips.has(c.id)) pts.push(c.start, c.start + c.dur);
  return pts;
}
// Snaps t (and optionally t+len) to the nearest edge; remembers where to draw the guide line.
function snapTime(t, exclClips = new Set(), len = null, exclReg = null) {
  Drag.snapX = null;
  if (!S.snap) return t;
  let best = t, bd = (isTouch ? 14 : 9) / S.pps, line = null;
  for (const p of snapPoints(exclClips, exclReg)) {
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
  if (py < RULER_H) { D.kind = 'seek'; seekTo(t); }
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
      if (e.shiftKey) { S.sel.has(c.id) ? S.sel.delete(c.id) : S.sel.add(c.id); }
      else if (!S.sel.has(c.id)) S.sel = new Set([c.id]);
      S.inspector = 'clip'; renderInspector();
      const edge = Math.min(isTouch ? 18 : 9, r.w / 4);
      const fiX = r.x + c.fin * S.pps, foX = r.x + r.w - c.fout * S.pps;
      const fadeZone = py < r.y + 26;
      if (fadeZone && Math.abs(px - fiX) < (isTouch ? 16 : 8) && S.sel.has(c.id)) D.kind = 'fadeIn';
      else if (fadeZone && Math.abs(px - foX) < (isTouch ? 16 : 8) && S.sel.has(c.id)) D.kind = 'fadeOut';
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
    case 'pan': case 'empty': S.x0 = D.x00 - dt; break;
    case 'regMove': D.reg.start = Math.max(0, snapTime(D.orig.start + dt, new Set(), D.orig.len, D.reg.id)); break;
    case 'regLen': D.reg.len = Math.max(0.5, snapTime(D.orig.start + D.orig.len + dt, new Set(), null, D.reg.id) - D.reg.start); break;
    case 'move': {
      const lead = D.orig.find((o) => o.id === D.clip.id);
      const ns = snapTime(lead.start + dt, S.sel, lead.dur);
      const delta = ns - lead.start;
      let ti = clamp(Math.floor((py - TOP) / laneH), 0, P.tracks.length - 1), dTrack = ti - D.track0;
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
      let ns = snapTime(o.start + dt, S.sel);
      ns = clamp(ns, o.start - o.offset, o.start + o.dur - 0.02);
      const d = ns - o.start; c.start = ns; c.offset = o.offset + d; c.dur = o.dur - d;
      c.fin = Math.min(c.fin, c.dur / 2); break;
    }
    case 'trimR': {
      const o = D.orig.find((k) => k.id === D.clip.id), c = D.clip, e2 = buffers.get(c.src);
      const maxD = e2 ? e2.buf.duration - o.offset : o.dur;
      const ne = snapTime(o.start + o.dur + dt, S.sel);
      c.dur = clamp(ne - o.start, 0.02, maxD); c.fout = Math.min(c.fout, c.dur / 2); break;
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
  if (D.kind === 'empty' && !D.moved) {
    S.sel.clear(); S.selRegion = null; S.inspector = S.inspector === 'clip' || S.inspector === 'region' ? 'none' : S.inspector;
    seekTo(snapTime(D.t0, new Set())); Drag.snapX = null; renderInspector();
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

/* ================= Rendering & analysis ================= */
async function renderRange(start, len, limGain) {
  const lat = latency(), extra = Math.ceil(lat * SR) + 32;
  const frames = Math.ceil(len * SR);
  const ctx = new OfflineAudioContext(2, frames + extra, SR);
  const g = await buildGraph(ctx, false, { limGain });
  scheduleClips(g, start, start + len, 0);
  const out = await ctx.startRendering();
  const off = Math.round(lat * SR);
  const L = out.getChannelData(0).slice(off, off + frames), R = out.getChannelData(1).slice(off, off + frames);
  return [L, R];
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
  const M = P.master, ch = raw.map((d) => d.slice());
  const ceil = dbToLin(M.lim.ceiling), tp = truePeak(ch);
  if (tp > ceil) { const k = ceil / tp * 0.999; for (const d of ch) for (let i = 0; i < d.length; i++) d[i] *= k; }
  if (M.fades) {
    const nf = Math.round(0.05 * SR);
    for (const d of ch) { const n = d.length; for (let i = 0; i < nf && i < n / 2; i++) { const g = i / nf; d[i] *= g; d[n - 1 - i] *= g; } }
  }
  return ch;
}
async function processRegion(r, onStep) {
  const M = P.master; let gain = M.lim.gain;
  let ch = finalize(await renderRange(r.start, r.len, gain));
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
      ch = finalize(await renderRange(r.start, r.len, gain));
    }
  }
  const stats = { len: r.len, rms: rmsDb(ch), rmsL: rmsDb([ch[0]]), rmsR: rmsDb([ch[1]]), peak: linToDb(samplePeak(ch)), tp: linToDb(truePeak(ch)), lufs: lufsI(ch), gain };
  return { ch, stats };
}

/* ================= Encoders ================= */
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
async function encodeMp3(ch) {
  await loadLame();
  const enc = new lamejs.Mp3Encoder(2, SR, 320), n = ch[0].length, blk = 1152, parts = [];
  const toI16 = (d) => { const o = new Int16Array(d.length); for (let i = 0; i < d.length; i++) o[i] = clamp(Math.round(d[i] * 32767), -32768, 32767); return o; };
  const L = toI16(ch[0]), R = toI16(ch[1]);
  for (let i = 0; i < n; i += blk) { const b = enc.encodeBuffer(L.subarray(i, i + blk), R.subarray(i, i + blk)); if (b.length) parts.push(new Uint8Array(b)); }
  const e = enc.flush(); if (e.length) parts.push(new Uint8Array(e));
  return new Blob(parts, { type: 'audio/mpeg' });
}

/* ================= UI: toolbar & headers ================= */
function toast(msg, ms = 2200) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, ms);
}
function updateToolbar() {
  if (!P) return;
  $('#bPlay').classList.toggle('on', S.playing);
  $('#bPlay').setAttribute('aria-label', S.playing ? 'Стоп' : 'Играть');
  $('#bPlay').innerHTML = S.playing ? ICON.stop : ICON.play;
  $('#bSnap').classList.toggle('on', S.snap);
  $('#bRipple').classList.toggle('on', S.ripple);
  $('#bUndo').disabled = S.hidx <= 0; $('#bRedo').disabled = S.hidx >= S.hist.length - 1;
  $('#projName').textContent = P.name;
}
function renderHeaders() {
  const h = $('#heads'); h.innerHTML = '';
  h.append(el('div', { class: 'headTop', style: `height:${TOP}px` },
    el('button', { class: 'chip', onclick: () => openInspector('master'), 'aria-label': 'Мастер' }, 'Мастер')));
  P.tracks.forEach((t) => {
    const anyS = P.tracks.some((k) => k.solo);
    const fileIn = el('input', { type: 'file', multiple: true, accept: 'audio/*,.wav,.mp3,.aif,.aiff,.m4a,.flac,.ogg', hidden: true, onchange: (e) => { importFiles([...e.target.files], t.id, P.playhead); e.target.value = ''; } });
    const row = el('div', { class: 'head' + (S.inspector === 'track' && S.inspectorTrack === t.id ? ' active' : '') + (t.mute || (anyS && !t.solo) ? ' muted' : ''), style: `height:${laneH}px;--tc:${TRACK_COLORS[t.id]}` },
      el('button', { class: 'tname', onclick: () => openInspector('track', t.id) }, t.name),
      el('div', { class: 'hrow' },
        el('button', { class: 'ms' + (t.mute ? ' m' : ''), onclick: () => { t.mute = !t.mute; commit(); applyLive(); renderHeaders(); }, 'aria-label': 'Заглушить' }, 'M'),
        el('button', { class: 'ms' + (t.solo ? ' s' : ''), onclick: () => { t.solo = !t.solo; commit(); applyLive(); renderHeaders(); }, 'aria-label': 'Соло' }, 'S'),
        el('button', { class: 'ms add', onclick: () => fileIn.click(), 'aria-label': 'Добавить файл' }, '+'), fileIn),
      t.kind === 'music' ? el('div', { class: 'grbar', title: 'Подавление музыки голосом' }, el('i', { id: 'duckGr' })) : null);
    h.append(row);
  });
}

/* ================= UI: inspector ================= */
function openInspector(mode, track) {
  S.inspector = mode; S.inspectorTrack = track || null;
  if (mode === 'track' || mode === 'master') { S.sel.clear(); }
  $('#insp').classList.remove('collapsed');
  renderInspector(); renderHeaders(); redraw();
}
function ctrlSlider({ id, label, min, max, step = 0.1, value, unit = '', fmt, onInput, onChange }) {
  const out = el('output', { for: id }, (fmt ? fmt(value) : value) + (unit ? ' ' + unit : ''));
  const inp = el('input', { type: 'range', id, min, max, step, value });
  inp.addEventListener('input', () => { const v = parseFloat(inp.value); out.textContent = (fmt ? fmt(v) : v) + (unit ? ' ' + unit : ''); onInput(v); });
  inp.addEventListener('change', () => { onChange ? onChange() : commit(); });
  inp.addEventListener('dblclick', () => { if (inp.dataset.def != null) { inp.value = inp.dataset.def; inp.dispatchEvent(new Event('input')); inp.dispatchEvent(new Event('change')); } });
  return el('label', { class: 'ctl', for: id }, el('span', {}, label), inp, out);
}
function ctrlSelect({ id, label, options, value, onChange }) {
  const s = el('select', { id }, ...options.map(([v, t]) => el('option', { value: v, selected: String(v) === String(value) }, t)));
  s.addEventListener('change', () => { onChange(s.value); commit(); });
  return el('label', { class: 'ctl' }, el('span', {}, label), s, el('output', {}, ''));
}
function ctrlToggle({ id, label, value, onChange }) {
  const c = el('input', { type: 'checkbox', id, checked: value });
  c.addEventListener('change', () => { onChange(c.checked); commit(); });
  return el('label', { class: 'tog', for: id }, c, el('span', {}, label));
}
const fmt1 = (v) => (v > 0 ? '+' : '') + Number(v).toFixed(1);
function section(title, ...kids) { return el('section', { class: 'sec' }, el('h3', {}, title), ...kids); }

function renderInspector() {
  const box = $('#inspBody'); box.innerHTML = '';
  const title = $('#inspTitle');
  const mode = S.inspector;
  if (mode === 'clip' && selClips().length) return inspClip(box, title);
  if (mode === 'track') { const t = P.tracks.find((k) => k.id === S.inspectorTrack); if (t) return inspTrack(box, title, t); }
  if (mode === 'master') return inspMaster(box, title);
  if (mode === 'region') { const r = P.regions.find((k) => k.id === S.selRegion); if (r) return inspRegion(box, title, r); }
  title.textContent = 'Подсказки';
  box.append(el('div', { class: 'hint' },
    el('p', {}, el('b', {}, '+'), ' на дорожке добавляет файлы с позиции курсора. Тап по клипу выделяет его, края тянут обрезку, белые точки сверху — фейды.'),
    el('p', {}, 'Два пальца сводят и разводят масштаб, перетаскивание пустого места двигает таймлайн. Тап по линейке ставит курсор.'),
    el('p', {}, 'Клавиатура на iPad: пробел — играть, S — разрезать, Delete — удалить, ⌘Z — отменить, стрелки — сдвиг на 10 мс.'),
    el('p', {}, 'Имя дорожки открывает её обработку, «Мастер» — мастер-цепочку. Регионы сверху выгружаются отдельными файлами.')));
}
function refreshInspectorValues() {
  if (S.inspector === 'clip') { const c = selClips()[0]; if (!c) return; const s = $('#clipPos'); if (s) s.textContent = `${fmtTime(c.start)} → ${fmtTime(c.start + c.dur)}  ·  ${c.dur.toFixed(3)} с`; }
  if (S.inspector === 'region') { const r = P.regions.find((k) => k.id === S.selRegion); const s = $('#regPos'); if (r && s) s.textContent = `${fmtTime(r.start)} → ${fmtTime(r.start + r.len)}`; const l = $('#regLen'); if (r && l && document.activeElement !== l) l.value = r.len.toFixed(2); }
}
function inspClip(box, title) {
  const cs = selClips(), c = cs[0];
  title.textContent = cs.length > 1 ? `Клипы: ${cs.length}` : c.name;
  const tr = P.tracks.find((t) => t.id === c.track);
  box.append(el('div', { class: 'meta' }, el('span', { class: 'dot', style: `background:${TRACK_COLORS[c.track]}` }), tr.name, el('span', { id: 'clipPos', class: 'mono' }, '')));
  const applyAll = (fn) => { for (const k of cs) fn(k); redraw(); };
  box.append(el('div', { class: 'grid' },
    ctrlSlider({ id: 'cGain', label: 'Громкость клипа', min: -24, max: 12, step: 0.1, value: c.gain, unit: 'дБ', fmt: fmt1, onInput: (v) => applyAll((k) => { k.gain = v; }), onChange: () => { commit(); restartIfPlaying(); } }),
    ctrlSlider({ id: 'cFin', label: 'Фейд-ин', min: 0, max: Math.min(3000, c.dur * 500), step: 1, value: Math.round(c.fin * 1000), unit: 'мс', onInput: (v) => applyAll((k) => { k.fin = clamp(v / 1000, 0.002, k.dur - k.fout); }), onChange: () => { commit(); restartIfPlaying(); } }),
    ctrlSlider({ id: 'cFout', label: 'Фейд-аут', min: 0, max: Math.min(3000, c.dur * 500), step: 1, value: Math.round(c.fout * 1000), unit: 'мс', onInput: (v) => applyAll((k) => { k.fout = clamp(v / 1000, 0.002, k.dur - k.fin); }), onChange: () => { commit(); restartIfPlaying(); } })));
  box.append(el('div', { class: 'btns' },
    el('button', { class: 'btn', onclick: () => splitAt() }, 'Разрезать по курсору'),
    el('button', { class: 'btn', onclick: () => nudge(-0.01) }, '← 10 мс'),
    el('button', { class: 'btn', onclick: () => nudge(0.01) }, '10 мс →'),
    el('button', { class: 'btn', onclick: duplicateSel }, 'Дублировать'),
    el('button', { class: 'btn', onclick: normalizeSel }, 'Пик −1 дБ'),
    el('button', { class: 'btn danger', onclick: deleteSel }, S.ripple ? 'Удалить со сдвигом' : 'Удалить')));
  if (c.track === 'mu') box.append(raoCard(c.src));
  refreshInspectorValues();
}
function restartIfPlaying() { if (S.playing) restartPlayback(); }
function raoCard(fileId) {
  const f = P.files[fileId] || { name: '?' }, code = findCode(f.name);
  return el('div', { class: 'rao' },
    el('div', { class: 'raoName mono' }, f.name),
    el('div', { class: 'btns' },
      el('button', { class: 'btn', onclick: () => copyText(f.name.replace(/\.[^.]+$/, ''), 'Название скопировано') }, 'Копировать название'),
      code ? el('button', { class: 'btn', onclick: () => copyText(code, 'Код скопирован') }, 'Копировать ' + code) : null,
      el('a', { class: 'btn primary', href: code ? `https://zvukobaza.com/${code}` : 'https://zvukobaza.com/catalog/search', target: '_blank', rel: 'noopener' }, code ? 'Открыть в Звукобазе' : 'Поиск в Звукобазе')));
}
async function copyText(s, msg = 'Скопировано') {
  try { await navigator.clipboard.writeText(s); toast(msg); }
  catch { const ta = el('textarea', {}, s); document.body.append(ta); ta.select(); try { document.execCommand('copy'); toast(msg); } catch { toast('Выдели и скопируй вручную'); } ta.remove(); }
}

/* EQ editor */
const fToX = (f, w) => Math.log(f / 20) / Math.log(1000) * w;
const xToF = (x, w) => 20 * Math.pow(1000, x / w);
let eqCtx = null;
function eqResponse(bands, freqs) {
  if (!eqCtx) eqCtx = new OfflineAudioContext(1, 128, SR);
  const tot = new Float32Array(freqs.length), mag = new Float32Array(freqs.length), ph = new Float32Array(freqs.length);
  const per = [];
  for (const b of bands) {
    if (!b.on) { per.push(null); continue; }
    const n = eqCtx.createBiquadFilter(); setBand(n, b);
    n.getFrequencyResponse(freqs, mag, ph);
    const db = new Float32Array(freqs.length);
    for (let i = 0; i < freqs.length; i++) { db[i] = 20 * Math.log10(mag[i] + 1e-9); tot[i] += db[i]; }
    per.push(db);
  }
  return { tot, per };
}
function eqEditor(bands, color, onChange) {
  const wrap = el('div', { class: 'eq' });
  const c = el('canvas', { class: 'eqc', 'aria-label': 'Эквалайзер, тяните точки' });
  const list = el('div', { class: 'eqlist' });
  wrap.append(c, list);
  const GR = 18;
  let sel = 0;
  const draw = () => {
    const dpr = devicePixelRatio || 1, w = c.clientWidth || 300, h = c.clientHeight || 150;
    if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const x = c.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, w, h);
    const yOf = (db) => h / 2 - db / GR * (h / 2 - 8);
    x.strokeStyle = 'rgba(255,255,255,.07)'; x.fillStyle = 'rgba(255,255,255,.35)'; x.font = '10px "JetBrains Mono", monospace';
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) { const px = fToX(f, w); x.beginPath(); x.moveTo(px, 0); x.lineTo(px, h); x.stroke(); x.fillText(f >= 1000 ? f / 1000 + 'k' : f, px + 3, h - 4); }
    for (const d of [-12, -6, 0, 6, 12]) { const py = yOf(d); x.beginPath(); x.moveTo(0, py); x.lineTo(w, py); x.stroke(); }
    const N = Math.min(400, Math.floor(w)), freqs = new Float32Array(N);
    for (let i = 0; i < N; i++) freqs[i] = xToF(i / (N - 1) * w, w);
    const { tot, per } = eqResponse(bands, freqs);
    if (per[sel]) { x.fillStyle = color + '33'; x.beginPath(); x.moveTo(0, yOf(0)); for (let i = 0; i < N; i++) x.lineTo(i / (N - 1) * w, yOf(clamp(per[sel][i], -GR - 6, GR + 6))); x.lineTo(w, yOf(0)); x.fill(); }
    x.strokeStyle = color; x.lineWidth = 2; x.beginPath();
    for (let i = 0; i < N; i++) { const py = yOf(clamp(tot[i], -GR - 6, GR + 6)); i ? x.lineTo(i / (N - 1) * w, py) : x.moveTo(0, py); }
    x.stroke(); x.lineWidth = 1;
    bands.forEach((b, i) => {
      const px = fToX(b.f, w), py = yOf(b.type === 'highpass' || b.type === 'lowpass' ? 0 : b.g);
      x.fillStyle = i === sel ? '#fff' : b.on ? color : 'rgba(255,255,255,.25)';
      x.beginPath(); x.arc(px, py, i === sel ? 7 : 5.5, 0, Math.PI * 2); x.fill();
      x.fillStyle = '#111'; x.font = '600 9px "JetBrains Mono", monospace'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(i + 1, px, py + 0.5); x.textAlign = 'start'; x.textBaseline = 'alphabetic';
    });
  };
  const renderList = () => {
    list.innerHTML = '';
    bands.forEach((b, i) => {
      const num = (k, min, max, step, w) => { const n = el('input', { type: 'number', inputmode: 'decimal', min, max, step, value: k === 'f' ? Math.round(b.f) : +(+b[k]).toFixed(2), class: 'num', style: `width:${w}` }); n.addEventListener('change', () => { b[k] = clamp(parseFloat(n.value) || 0, min, max); onChange(); draw(); commit(); }); n.addEventListener('focus', () => { sel = i; draw(); }); return n; };
      const ty = el('select', { class: 'ty' }, ...[['highpass', 'HP'], ['lowshelf', 'LS'], ['peaking', 'Bell'], ['highshelf', 'HS'], ['lowpass', 'LP']].map(([v, t]) => el('option', { value: v, selected: b.type === v }, t)));
      ty.addEventListener('change', () => { b.type = ty.value; onChange(); draw(); commit(); });
      const on = el('input', { type: 'checkbox', checked: b.on, 'aria-label': 'Включить полосу ' + (i + 1) });
      on.addEventListener('change', () => { b.on = on.checked; onChange(); draw(); commit(); });
      const rm = el('button', { class: 'x', 'aria-label': 'Удалить полосу', onclick: () => { bands.splice(i, 1); sel = 0; onChange(); renderList(); draw(); commit(); } }, '×');
      list.append(el('div', { class: 'eqrow' + (i === sel ? ' sel' : ''), onclick: () => { sel = i; draw(); [...list.children].forEach((r, j) => r.classList.toggle('sel', j === i)); } },
        on, el('b', {}, i + 1), ty, num('f', 10, 22000, 1, '5.4em'), el('small', {}, 'Гц'), num('g', -24, 24, 0.5, '3.6em'), el('small', {}, 'дБ'), num('q', 0.1, 18, 0.01, '4.8em'), el('small', {}, 'Q'), rm));
    });
    if (bands.length < MAXB) list.append(el('button', { class: 'btn small', onclick: () => { bands.push(eqBand('peaking', 1000, 0, 1)); sel = bands.length - 1; onChange(); renderList(); draw(); commit(); } }, '+ полоса'));
  };
  // drag points
  let drag = null;
  c.addEventListener('pointerdown', (e) => {
    const r = c.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top, w = r.width, h = r.height;
    const yOf = (db) => h / 2 - db / GR * (h / 2 - 8);
    let best = -1, bd = isTouch ? 28 : 16;
    bands.forEach((b, i) => { const d = Math.hypot(fToX(b.f, w) - px, yOf(b.type === 'highpass' || b.type === 'lowpass' ? 0 : b.g) - py); if (d < bd) { bd = d; best = i; } });
    if (best < 0) return;
    sel = best; drag = { w, h }; c.setPointerCapture(e.pointerId); renderList(); draw();
  });
  c.addEventListener('pointermove', (e) => {
    if (!drag) return; const r = c.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    const b = bands[sel]; b.f = Math.round(clamp(xToF(clamp(px, 0, drag.w), drag.w), 20, 20000));
    if (b.type !== 'highpass' && b.type !== 'lowpass') b.g = Math.round(clamp((drag.h / 2 - py) / (drag.h / 2 - 8) * GR, -GR, GR) * 2) / 2;
    if (!b.on) b.on = true;
    onChange(); draw();
    const row = list.children[sel]; if (row) { const ns = row.querySelectorAll('input.num'); ns[0].value = Math.round(b.f); ns[1].value = b.g; }
  });
  c.addEventListener('pointerup', () => { if (drag) { drag = null; renderList(); commit(); } });
  c.addEventListener('wheel', (e) => { const b = bands[sel]; if (!b) return; e.preventDefault(); b.q = Math.round(clamp(b.q * Math.exp(-e.deltaY * 0.003), 0.1, 18) * 100) / 100; onChange(); draw(); renderList(); }, { passive: false });
  renderList();
  requestAnimationFrame(draw);
  new ResizeObserver(draw).observe(c);
  return wrap;
}
function inspTrack(box, title, t) {
  title.textContent = t.name;
  const color = TRACK_COLORS[t.id];
  box.append(el('div', { class: 'grid' },
    ctrlSlider({ id: 'tVol', label: 'Громкость', min: -36, max: 12, value: t.vol, unit: 'дБ', fmt: fmt1, onInput: (v) => { t.vol = v; applyLive(); } }),
    ctrlSlider({ id: 'tPan', label: 'Панорама', min: -1, max: 1, step: 0.01, value: t.pan || 0, fmt: (v) => (Math.abs(v) < 0.01 ? 'центр' : v < 0 ? 'L' + Math.round(-v * 100) : 'R' + Math.round(v * 100)), onInput: (v) => { t.pan = v; applyLive(); } })));
  box.append(section('Эквалайзер', eqEditor(t.eq, color, applyLive)));
  if (t.kind === 'voice') {
    box.append(section('Вокальный компрессор (как RVOX)',
      el('div', { class: 'grid' },
        ctrlToggle({ id: 'rvOn', label: 'Включён', value: t.rvox.on, onChange: (v) => { t.rvox.on = v; applyLive(); } }),
        ctrlSlider({ id: 'rvAmt', label: 'Компрессия', min: 0, max: 10, step: 0.1, value: t.rvox.amount, fmt: (v) => v.toFixed(1), onInput: (v) => { t.rvox.amount = v; applyLive(); } }),
        ctrlSlider({ id: 'rvGain', label: 'Выход', min: -18, max: 12, value: t.rvox.gain, unit: 'дБ', fmt: fmt1, onInput: (v) => { t.rvox.gain = v; applyLive(); } }),
        ctrlSlider({ id: 'drv', label: 'Перегруз', min: 0, max: 1, step: 0.01, value: t.drive || 0, fmt: (v) => Math.round(v * 100) + '%', onInput: (v) => { t.drive = v; applyLive(); } }))));
  }
  if (t.kind === 'music') {
    const d = t.duck;
    box.append(section('Динамическое подавление голосом (Mid)',
      el('p', { class: 'note' }, 'Музыка проседает только в тех полосах частот, где сейчас звучит голос. Side не трогается, ширина сохраняется. Сейчас: ', el('b', { id: 'duckGrI', class: 'mono' }, '—'), ' дБ'),
      el('div', { class: 'grid' },
        ctrlToggle({ id: 'dkOn', label: 'Включено', value: d.on, onChange: (v) => { d.on = v; applyLive(); } }),
        ctrlSlider({ id: 'dkDepth', label: 'Глубина', min: 0, max: 18, step: 0.5, value: d.depth, unit: 'дБ', fmt: (v) => v.toFixed(1), onInput: (v) => { d.depth = v; applyLive(); } }),
        ctrlSlider({ id: 'dkSens', label: 'Чувствительность', min: 0, max: 18, step: 0.5, value: d.sens, unit: 'дБ', fmt: (v) => v.toFixed(1), onInput: (v) => { d.sens = v; applyLive(); } }),
        ctrlSlider({ id: 'dkAtt', label: 'Атака', min: 1, max: 100, step: 1, value: d.attack, unit: 'мс', fmt: (v) => v, onInput: (v) => { d.attack = v; applyLive(); } }),
        ctrlSlider({ id: 'dkRel', label: 'Восстановление', min: 20, max: 800, step: 5, value: d.release, unit: 'мс', fmt: (v) => v, onInput: (v) => { d.release = v; applyLive(); } }),
        ctrlSlider({ id: 'dkLo', label: 'Нижняя граница', min: 40, max: 1000, step: 5, value: d.lo, unit: 'Гц', fmt: (v) => v, onInput: (v) => { d.lo = v; applyLive(); } }),
        ctrlSlider({ id: 'dkHi', label: 'Верхняя граница', min: 2000, max: 16000, step: 100, value: d.hi, unit: 'Гц', fmt: (v) => v, onInput: (v) => { d.hi = v; applyLive(); } }))));
  }
}
function inspMaster(box, title) {
  title.textContent = 'Мастер';
  const M = P.master, c = M.comp, l = M.lim;
  box.append(section('Эквалайзер', eqEditor(M.eq, '#E8E4DA', applyLive)));
  box.append(section('Шинный компрессор (как SSL)',
    el('p', { class: 'note' }, 'Подавление сейчас: ', el('b', { id: 'sslGr', class: 'mono' }, '—'), ' дБ'),
    el('div', { class: 'grid' },
      ctrlToggle({ id: 'scOn', label: 'Включён', value: c.on, onChange: (v) => { c.on = v; applyLive(); } }),
      ctrlSlider({ id: 'scThr', label: 'Порог', min: -30, max: 0, step: 0.5, value: c.thresh, unit: 'дБ', fmt: (v) => v.toFixed(1), onInput: (v) => { c.thresh = v; applyLive(); } }),
      ctrlSelect({ id: 'scRatio', label: 'Ratio', options: [[2, '2:1'], [4, '4:1'], [10, '10:1']], value: c.ratio, onChange: (v) => { c.ratio = +v; applyLive(); } }),
      ctrlSelect({ id: 'scAtt', label: 'Атака', options: [[0.1, '0.1 мс'], [0.3, '0.3 мс'], [1, '1 мс'], [3, '3 мс'], [10, '10 мс'], [30, '30 мс']], value: c.attack, onChange: (v) => { c.attack = +v; applyLive(); } }),
      ctrlSelect({ id: 'scRel', label: 'Восстановление', options: [[0.1, '0.1 с'], [0.3, '0.3 с'], [0.6, '0.6 с'], [1.2, '1.2 с']], value: c.release, onChange: (v) => { c.release = +v; applyLive(); } }),
      ctrlSlider({ id: 'scMk', label: 'Make-up', min: 0, max: 15, step: 0.5, value: c.makeup, unit: 'дБ', fmt: fmt1, onInput: (v) => { c.makeup = v; applyLive(); } }))));
  box.append(section('Лимитер с true peak (как L316)',
    el('p', { class: 'note' }, 'Ограничение сейчас: ', el('b', { id: 'limGrI', class: 'mono' }, '—'), ' дБ. При экспорте пики дополнительно проверяются с 4× передискретизацией.'),
    el('div', { class: 'grid' },
      ctrlSlider({ id: 'lmGain', label: 'Вход', min: -12, max: 24, step: 0.1, value: l.gain, unit: 'дБ', fmt: fmt1, onInput: (v) => { l.gain = v; applyLive(); } }),
      ctrlSlider({ id: 'lmCeil', label: 'Потолок', min: -3, max: 0, step: 0.1, value: l.ceiling, unit: 'dBTP', fmt: (v) => v.toFixed(1), onInput: (v) => { l.ceiling = v; applyLive(); } }),
      ctrlSlider({ id: 'lmRel', label: 'Восстановление', min: 10, max: 500, step: 5, value: l.release, unit: 'мс', fmt: (v) => v, onInput: (v) => { l.release = v; applyLive(); } }))));
  box.append(section('Громкость при экспорте',
    el('div', { class: 'grid' },
      ctrlToggle({ id: 'arOn', label: 'Подгонять RMS автоматически', value: M.autoRms, onChange: (v) => { M.autoRms = v; } }),
      ctrlSlider({ id: 'arT', label: 'Целевой RMS', min: -16, max: -6, step: 0.5, value: M.targetRms, unit: 'дБ', fmt: (v) => v.toFixed(1), onInput: (v) => { M.targetRms = v; } }),
      ctrlToggle({ id: 'fdOn', label: 'Фейды 50 мс на краях регионов', value: M.fades, onChange: (v) => { M.fades = v; } })),
    el('p', { class: 'note' }, 'Авто RMS для каждого региона подбирает вход лимитера, пока RMS не совпадёт с целью с точностью ±0.1 дБ.')));
}
function inspRegion(box, title, r) {
  title.textContent = 'Регион ' + r.name;
  const name = el('input', { type: 'text', id: 'regName', value: r.name, class: 'txt' });
  name.addEventListener('change', () => { r.name = name.value.trim() || r.name; commit(); redraw(); title.textContent = 'Регион ' + r.name; });
  const len = el('input', { type: 'number', id: 'regLen', inputmode: 'decimal', step: 0.01, min: 0.5, value: r.len.toFixed(2), class: 'num' });
  len.addEventListener('change', () => { r.len = Math.max(0.5, parseFloat(len.value) || r.len); commit(); redraw(); refreshInspectorValues(); });
  box.append(el('div', { class: 'meta' }, el('span', { class: 'dot', style: 'background:var(--accent)' }), el('span', { id: 'regPos', class: 'mono' }, '')));
  box.append(el('div', { class: 'grid' },
    el('label', { class: 'ctl' }, el('span', {}, 'Название'), name, el('output', {}, '')),
    el('label', { class: 'ctl' }, el('span', {}, 'Длина, с'), len, el('output', {}, ''))));
  box.append(el('div', { class: 'btns' }, ...[5, 10, 15, 20, 30].map((s) => el('button', { class: 'btn' + (Math.abs(r.len - s) < 1e-6 ? ' on' : ''), onclick: () => { r.len = s; commit(); renderInspector(); redraw(); } }, s + ' с'))));
  box.append(el('div', { class: 'btns' },
    el('button', { class: 'btn primary', onclick: () => { P.playhead = r.start; play(r.start, r.start + r.len); } }, 'Слушать регион'),
    el('button', { class: 'btn', onclick: () => zoomRegion(r) }, 'Показать целиком'),
    el('button', { class: 'btn', onclick: () => duplicateRegion(r) }, 'Вариант: копия с содержимым'),
    el('button', { class: 'btn', onclick: addVariantSet }, '+ набор 30/15/10/5'),
    el('button', { class: 'btn danger', onclick: deleteRegion }, 'Удалить регион')));
  refreshInspectorValues();
}

/* ================= Modals ================= */
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
function closeModal() { const m = $('#modal'); if (m) m.remove(); }

async function openExport() {
  const M = P.master;
  if (!P.regions.length) { toast('Нет регионов. Добавь регион на панели региона.'); return; }
  const checks = P.regions.map((r) => el('label', { class: 'tog' }, el('input', { type: 'checkbox', checked: true, 'data-id': r.id }), el('span', {}, `${r.name}`, el('small', { class: 'mono' }, `  ${r.len} с`))));
  const fmtSel = el('div', { class: 'seg' },
    ...[['wav', 'WAV 48 кГц / 24 бит'], ['mp3', 'MP3 320']].map(([v, t]) => el('label', {}, el('input', { type: 'radio', name: 'fmt', value: v, checked: M.format === v }), el('span', {}, t))));
  const res = el('div', { class: 'results' });
  const body = el('div', {},
    el('h4', {}, 'Регионы'), el('div', { class: 'checks' }, ...checks),
    el('h4', {}, 'Формат'), fmtSel,
    el('p', { class: 'note' }, M.autoRms ? `RMS подгоняется к ${M.targetRms.toFixed(1)} дБ, потолок ${M.lim.ceiling.toFixed(1)} dBTP` : `Авто RMS выключен, вход лимитера ${fmtDb(M.lim.gain)} дБ, потолок ${M.lim.ceiling.toFixed(1)} dBTP`, M.fades ? ', фейды 50 мс.' : '.'),
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
    const table = el('table', { class: 'stats' }, el('thead', {}, el('tr', {}, ...['Регион', 'RMS', 'L / R', 'Peak', 'True peak', 'LUFS-I', 'Вход лим.'].map((h) => el('th', {}, h)))));
    const tb = el('tbody'); table.append(tb);
    res.append(el('div', { class: 'tablewrap' }, table));
    const files = [];
    for (const r of regs) {
      const row = el('tr', {}, el('td', {}, r.name), el('td', { colspan: 6, class: 'dim' }, 'Рендер…')); tb.append(row);
      try {
        const { ch, stats } = await processRegion(r, (s) => { row.lastChild.textContent = 'Рендер… ' + s; });
        row.lastChild.remove();
        const okTp = stats.tp <= M.lim.ceiling + 0.05;
        const missed = M.autoRms && stats.rms > -70 && Math.abs(stats.rms - M.targetRms) > 0.3;
        row.append(el('td', { class: 'mono' + (missed ? ' bad' : ''), title: missed ? 'Цель не достигнута: лимитер упёрся в предел. Проверь, нет ли в регионе тишины.' : null }, fmtDb(stats.rms, 2)), el('td', { class: 'mono dim' }, `${fmtDb(stats.rmsL)} / ${fmtDb(stats.rmsR)}`), el('td', { class: 'mono' }, fmtDb(stats.peak, 2)),
          el('td', { class: 'mono ' + (okTp ? 'ok' : 'bad') }, fmtDb(stats.tp, 2)), el('td', { class: 'mono' }, fmtDb(stats.lufs, 1)), el('td', { class: 'mono dim' }, fmtDb(stats.gain)));
        if (encode) {
          const blob = fmt === 'mp3' ? await encodeMp3(ch) : encodeWav24(ch);
          const name = `${sanitize(P.name)}_${sanitize(r.name)}.${fmt}`;
          files.push(new File([blob], name, { type: blob.type }));
        }
      } catch (e) { console.error(e); row.lastChild.textContent = 'Ошибка: ' + e.message; row.lastChild.className = 'bad'; }
      await new Promise((ok) => setTimeout(ok, 0));
    }
    bRun.disabled = bAn.disabled = false;
    if (encode && files.length) res.append(filesPanel(files));
  };
  const bAn = el('button', { class: 'btn', onclick: () => go(false) }, 'Только статистика');
  const bRun = el('button', { class: 'btn primary', onclick: () => go(true) }, 'Рендер');
  modal('Экспорт регионов', body, [bAn, bRun]);
}
function filesPanel(files) {
  const urls = files.map((f) => URL.createObjectURL(f));
  const canShare = !!(navigator.canShare && navigator.canShare({ files }));
  return el('div', { class: 'files' },
    el('h4', {}, 'Файлы готовы'),
    ...files.map((f, i) => el('div', { class: 'frow' },
      el('span', { class: 'mono' }, f.name), el('small', { class: 'dim' }, (f.size / 1048576).toFixed(2) + ' МБ'),
      el('a', { class: 'btn small', href: urls[i], download: f.name }, 'Скачать'))),
    el('div', { class: 'btns' },
      canShare ? el('button', { class: 'btn primary', onclick: async () => { try { await navigator.share({ files, title: P.name }); } catch (e) { if (e.name !== 'AbortError') toast('Не получилось открыть «Поделиться»: ' + e.message); } } }, 'Поделиться (Облако, Telegram, почта)') : el('p', { class: 'note' }, 'Этот браузер не умеет делиться файлами. Скачай их кнопками выше.'),
      el('button', { class: 'btn', onclick: () => copyText(files.map((f) => f.name).join('\n'), 'Имена файлов скопированы') }, 'Копировать имена файлов')));
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
  P = p; S.sel.clear(); S.selRegion = null; S.inspector = 'none';
  S.hist = []; S.hidx = -1; commit();
  ls.set('last', P.id);
  renderHeaders(); renderInspector(); updateToolbar(); resize();
  await Promise.all(Object.keys(P.files).map((id) => ensureBuffer(id).catch(() => null)));
  if (P.clips.length) zoomFit(); else { S.pps = clamp((W - 30) / 70, 4, 200); S.x0 = -0.5; }
  redraw();
}
const ICON = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l13-7.5z" fill="currentColor"/></svg>',
  stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor"/></svg>',
};
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
  $('#bRipple').onclick = () => { S.ripple = !S.ripple; ls.set('ripple', S.ripple); updateToolbar(); renderInspector(); };
  $('#bZin').onclick = () => zoom(1.5); $('#bZout').onclick = () => zoom(1 / 1.5); $('#bFit').onclick = zoomFit;
  $('#bExport').onclick = openExport; $('#bRao').onclick = openRao; $('#bProj').onclick = openProjects; $('#projName').onclick = openProjects;
  $('#bInsp').onclick = () => { $('#insp').classList.toggle('collapsed'); };
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
    else if (e.code === 'Escape') { S.sel.clear(); S.selRegion = null; closeModal(); renderInspector(); redraw(); }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow().catch(() => {}); });
}
async function boot() {
  bindUI();
  try { await Store.open(); } catch (e) { toast('Хранилище браузера недоступно: проекты не сохранятся', 5000); }
  await measureCompDelay();
  let p = null;
  try { const last = ls.get('last'); if (last) p = await Store.get('projects', last); } catch {}
  await loadProject(p || newProject());
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
}
window.addEventListener('DOMContentLoaded', boot);
