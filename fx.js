'use strict';
/* Эфир — плагинные окна и контролы. Загружается до app.js; использует его глобальные функции во время работы. */

/* ================= Controls ================= */
function knob(o) {
  const { min = 0, max = 1, size = 48, cls = 'k-def', log = false, steps = 0, labels = null, bipolar = false, label = null, title = null } = o;
  const fmt = o.fmt || ((v) => (+v).toFixed(1));
  const def = o.def ?? o.value;
  let v = o.value;
  const norm = (x) => (steps ? x / (steps - 1) : log ? Math.log(x / min) / Math.log(max / min) : (x - min) / (max - min));
  const denorm = (n) => { n = Math.min(1, Math.max(0, n)); return steps ? Math.round(n * (steps - 1)) : log ? min * Math.pow(max / min, n) : min + n * (max - min); };
  const wrap = el('div', { class: 'knob ' + cls, style: `--ks:${size}px`, title: title || label || '' });
  const pad = labels ? 1.42 : 1;
  const svgSize = Math.round(size * pad);
  const lab = labels ? labels.map((t, i) => {
    const a = (-135 + 270 * (labels.length === 1 ? 0.5 : i / (labels.length - 1))) * Math.PI / 180;
    const r = 46;
    return `<text x="${50 + Math.sin(a) * r}" y="${50 - Math.cos(a) * r + 2.5}" text-anchor="middle">${t}</text>`;
  }).join('') : '';
  const sc = 1 / pad, off = 50 - 50 * sc;
  wrap.innerHTML = `<svg viewBox="0 0 100 100" width="${svgSize}" height="${svgSize}" role="slider" tabindex="0" aria-label="${label || title || ''}">
    <defs><radialGradient id="kg${size}${cls}" cx="40%" cy="32%" r="75%"><stop offset="0" class="kg0"/><stop offset="1" class="kg1"/></radialGradient></defs>
    <g class="lab">${lab}</g>
    <g transform="translate(${off} ${off}) scale(${sc})">
      <path class="ktrack" d="${arcPath(0, 1)}"/>
      <path class="karc" d=""/>
      <circle class="kbody" cx="50" cy="50" r="33" fill="url(#kg${size}${cls})"/>
      <g class="kptr"><line x1="50" y1="${cls === 'k-sh' ? 22 : 24}" x2="50" y2="${cls === 'k-sh' ? 44 : 38}"/></g>
    </g></svg>`;
  const svg = wrap.firstElementChild, arc = svg.querySelector('.karc'), ptr = svg.querySelector('.kptr');
  const val = label != null ? el('div', { class: 'kval mono' }, '') : null;
  if (label != null) wrap.append(val, el('div', { class: 'klab' }, label));
  function arcPath(a, b) {
    const p = (n) => { const ang = (-135 + 270 * n) * Math.PI / 180; return [50 + Math.sin(ang) * 42, 50 - Math.cos(ang) * 42]; };
    const [x0, y0] = p(a), [x1, y1] = p(b), large = (b - a) * 270 > 180 ? 1 : 0;
    return `M${x0} ${y0} A42 42 0 ${large} 1 ${x1} ${y1}`;
  }
  const render = () => {
    const n = norm(v);
    ptr.setAttribute('transform', `rotate(${-135 + 270 * n} 50 50)`);
    const a = bipolar ? Math.min(0.5, n) : 0, b = bipolar ? Math.max(0.5, n) : n;
    arc.setAttribute('d', b - a > 0.002 ? arcPath(a, b) : '');
    const txt = steps && o.stepFmt ? o.stepFmt(v) : fmt(v);
    if (val) val.textContent = txt;
    if (wrap.onFmt) wrap.onFmt(txt);
    svg.setAttribute('aria-valuetext', txt);
  };
  const setN = (n, fire = true) => { const nv = denorm(n); if (nv === v) return; v = nv; render(); if (fire && o.onInput) o.onInput(v); };
  let drag = null;
  svg.addEventListener('pointerdown', (e) => { e.preventDefault(); svg.setPointerCapture(e.pointerId); drag = { y: e.clientY, n: norm(v), moved: false }; });
  svg.addEventListener('pointermove', (e) => { if (!drag) return; const dy = drag.y - e.clientY; if (Math.abs(dy) > 2) drag.moved = true; setN(drag.n + dy / (e.shiftKey ? 800 : 180)); });
  const end = () => { if (drag && drag.moved && o.onChange) o.onChange(v); drag = null; };
  svg.addEventListener('pointerup', end); svg.addEventListener('pointercancel', end);
  svg.addEventListener('dblclick', () => { v = def; render(); o.onInput && o.onInput(v); o.onChange && o.onChange(v); });
  svg.addEventListener('wheel', (e) => { e.preventDefault(); setN(norm(v) - e.deltaY / (steps ? 300 : 1200)); clearTimeout(wrap._wt); wrap._wt = setTimeout(() => o.onChange && o.onChange(v), 300); }, { passive: false });
  svg.addEventListener('keydown', (e) => {
    const d = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return; e.preventDefault(); setN(norm(v) + d * (steps ? 1 / (steps - 1) : 0.01)); o.onChange && o.onChange(v);
  });
  wrap.set = (nv) => { v = nv; render(); };
  wrap.fmtNow = () => (steps && o.stepFmt ? o.stepFmt(v) : fmt(v));
  render();
  return wrap;
}
function vslider(o) {
  const { min, max, height = 180, cls = '', label, fmt = (v) => v.toFixed(1), def = o.value } = o;
  let v = o.value;
  const thumb = el('div', { class: 'vthumb' }), track = el('div', { class: 'vtrack', style: `height:${height}px` }, el('div', { class: 'vfill' }), thumb);
  const val = el('div', { class: 'vval mono' }, '');
  const wrap = el('div', { class: 'vslider ' + cls }, el('div', { class: 'vlab' }, label), track, val);
  const n = () => (v - min) / (max - min);
  const render = () => { const p = n() * 100; thumb.style.bottom = `calc(${p}% - 9px)`; track.firstChild.style.height = p + '%'; val.textContent = fmt(v); };
  let drag = null;
  track.addEventListener('pointerdown', (e) => { e.preventDefault(); track.setPointerCapture(e.pointerId); drag = { y: e.clientY, v, moved: false }; });
  track.addEventListener('pointermove', (e) => { if (!drag) return; const dy = drag.y - e.clientY; if (Math.abs(dy) > 2) drag.moved = true; v = Math.min(max, Math.max(min, drag.v + dy / height * (max - min) * (e.shiftKey ? 0.25 : 1))); render(); o.onInput && o.onInput(v); });
  const end = () => { if (drag && drag.moved) o.onChange && o.onChange(v); drag = null; };
  track.addEventListener('pointerup', end); track.addEventListener('pointercancel', end);
  track.addEventListener('dblclick', () => { v = def; render(); o.onInput && o.onInput(v); o.onChange && o.onChange(v); });
  wrap.set = (nv) => { v = nv; render(); };
  wrap.track = track;
  render();
  return wrap;
}
function dragNum(o) {
  const { min, max, step = 0.1, fmt = (v) => (+v).toFixed(1), color } = o;
  let v = o.value;
  const s = el('span', { class: 'dnum mono', tabindex: '0', role: 'spinbutton', style: color ? `color:${color}` : '' });
  const render = () => { s.textContent = fmt(v) + (o.unit ? o.unit : ''); };
  let drag = null;
  s.addEventListener('pointerdown', (e) => { e.preventDefault(); s.setPointerCapture(e.pointerId); drag = { y: e.clientY, v, moved: false }; });
  s.addEventListener('pointermove', (e) => {
    if (!drag) return; const dy = drag.y - e.clientY; if (Math.abs(dy) > 3) drag.moved = true; if (!drag.moved) return;
    const span = o.log ? null : (max - min);
    let nv = o.log ? drag.v * Math.pow(max / min, dy / 400) : drag.v + dy / 300 * span * (e.shiftKey ? 0.2 : 1);
    nv = Math.round(Math.min(max, Math.max(min, nv)) / step) * step;
    if (nv !== v) { v = nv; render(); o.onInput && o.onInput(v); }
  });
  s.addEventListener('pointerup', () => {
    if (drag && drag.moved) o.onChange && o.onChange(v);
    else if (drag) {
      const inp = el('input', { type: 'number', inputmode: 'decimal', class: 'num dinput', value: +(+v).toFixed(3), step, min, max });
      s.replaceWith(inp); inp.focus(); inp.select();
      const done = () => { const nv = parseFloat(inp.value); if (!isNaN(nv)) { v = Math.min(max, Math.max(min, nv)); o.onInput && o.onInput(v); o.onChange && o.onChange(v); } render(); inp.replaceWith(s); };
      inp.addEventListener('blur', done); inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
    }
    drag = null;
  });
  s.set = (nv) => { v = nv; render(); };
  render();
  return s;
}
function seg(options, value, onChange, cls = '') {
  const box = el('div', { class: 'seg2 ' + cls });
  for (const [v, t] of options) {
    const b = el('button', { class: String(v) === String(value) ? 'on' : '', onclick: () => { for (const k of box.children) k.classList.remove('on'); b.classList.add('on'); onChange(v); } }, t);
    box.append(b);
  }
  return box;
}
function powerBtn(obj, ctx, key = 'on') {
  return el('button', { class: 'pwr' + (obj[key] !== false ? ' on' : ''), 'aria-label': 'Вкл/выкл', title: 'Включить/выключить', onclick: () => { obj[key] = !(obj[key] !== false); ctx.change(); ctx.commit(); renderTCP(); openFx(ctx.target, ctx.key); } },
    el('span', { html: '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M12 3v8M6.3 6.3a8 8 0 1 0 11.4 0" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>' }));
}
function canvas2d(c) {
  const dpr = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const x = c.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0);
  return [x, w, h];
}
const F_MIN = 20, F_MAX = 20000;
const fx2x = (f, w) => Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN) * w;
const x2fx = (x, w) => F_MIN * Math.pow(F_MAX / F_MIN, x / w);
const fmtHz = (f) => (f >= 1000 ? (f / 1000).toFixed(f >= 10000 ? 1 : 2).replace(/\.?0+$/, '') + ' кГц' : Math.round(f) + ' Гц');
let specBuf = null;
function drawSpectrum(x, an, w, h, fill, stroke, floor = -96) {
  if (!an || !S.playing) return;
  if (!specBuf || specBuf.length !== an.frequencyBinCount) specBuf = new Float32Array(an.frequencyBinCount);
  an.getFloatFrequencyData(specBuf);
  const sr = an.context.sampleRate, n = specBuf.length, yOf = (db) => h - Math.min(1, Math.max(0, (db - floor) / (-floor - 6))) * h;
  x.beginPath(); x.moveTo(0, h);
  let lastX = -1;
  for (let i = 1; i < n; i++) {
    const f = i * sr / 2 / n; if (f < F_MIN) continue; if (f > F_MAX) break;
    const px = fx2x(f, w); if (px - lastX < 1.5) continue; lastX = px;
    x.lineTo(px, yOf(specBuf[i] + 4.5 * Math.log2(f / 1000)));
  }
  x.lineTo(w, h); x.closePath();
  x.fillStyle = fill; x.fill(); if (stroke) { x.strokeStyle = stroke; x.stroke(); }
}
function freqGrid(x, w, h, color = 'rgba(255,255,255,.06)', txt = 'rgba(255,255,255,.35)', marks = [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
  x.font = '10px ui-monospace, Menlo, monospace'; x.fillStyle = txt;
  for (const f of marks) { const px = fx2x(f, w); x.fillStyle = color; x.fillRect(Math.round(px), 0, 1, h); x.fillStyle = txt; x.fillText(f >= 1000 ? f / 1000 + 'k' : String(f), px + 3, h - 4); }
}
const grOf = (m) => (m && typeof m.gr === 'number' ? m.gr : 0);

/* ================= Plugin GUIs ================= */
const FXUI = {};

/* ---- Parametric EQ (dynamic-EQ-style display with analyser) ---- */
const EQ_COLORS = ['#F5C342', '#F0855A', '#E85D9E', '#A974F2', '#5B8CF5', '#3CC6D9', '#5ED48A', '#C8D85A'];
let eqCtx = null;
function eqResponse(bands, freqs) {
  if (!eqCtx) eqCtx = new OfflineAudioContext(1, 128, SR);
  const tot = new Float32Array(freqs.length), mag = new Float32Array(freqs.length), ph = new Float32Array(freqs.length), per = [];
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
FXUI.eq = (obj, ctx) => {
  const E = obj.eq, bands = E.bands;
  const root = el('div', { class: 'pl pl-eq' });
  const c = el('canvas', { class: 'eqc', 'aria-label': 'Эквалайзер: тяни точки, колесо/щипок меняет Q' });
  const list = el('div', { class: 'eqlist' });
  root.append(el('div', { class: 'plhead' }, powerBtn(E, ctx), el('b', {}, 'Parametric EQ'), el('span', { class: 'dim' }, 'двойной тап по полю — новая полоса')), c, list);
  const GR = 18; let sel = 0, resp = null;
  const recalc = () => { resp = null; };
  const draw = () => {
    const [x, w, h] = canvas2d(c);
    x.fillStyle = '#121820'; x.fillRect(0, 0, w, h);
    const yOf = (db) => h / 2 - db / GR * (h / 2 - 10);
    for (const d of [-12, -6, 0, 6, 12]) { x.fillStyle = d ? 'rgba(255,255,255,.05)' : 'rgba(255,255,255,.12)'; x.fillRect(0, Math.round(yOf(d)), w, 1); x.fillStyle = 'rgba(255,255,255,.3)'; x.font = '10px ui-monospace, Menlo, monospace'; x.fillText((d > 0 ? '+' : '') + d, w - 24, yOf(d) - 2); }
    freqGrid(x, w, h);
    drawSpectrum(x, ctx.an(), w, h, 'rgba(120,170,220,.16)', 'rgba(140,190,240,.35)');
    const N = Math.min(400, Math.floor(w));
    if (!resp || resp.N !== N || resp.w !== w) { const fr = new Float32Array(N); for (let i = 0; i < N; i++) fr[i] = x2fx(i / (N - 1) * w, w); resp = { ...eqResponse(bands, fr), N, w }; }
    const { tot, per } = resp;
    if (per[sel]) { x.fillStyle = EQ_COLORS[sel % 8] + '30'; x.beginPath(); x.moveTo(0, yOf(0)); for (let i = 0; i < N; i++) x.lineTo(i / (N - 1) * w, yOf(Math.max(-GR - 6, Math.min(GR + 6, per[sel][i])))); x.lineTo(w, yOf(0)); x.fill(); }
    x.strokeStyle = E.on ? '#F2F4F6' : 'rgba(255,255,255,.35)'; x.lineWidth = 2; x.beginPath();
    for (let i = 0; i < N; i++) { const py = yOf(Math.max(-GR - 6, Math.min(GR + 6, tot[i]))); i ? x.lineTo(i / (N - 1) * w, py) : x.moveTo(0, py); }
    x.stroke(); x.lineWidth = 1;
    bands.forEach((b, i) => {
      const px = fx2x(b.f, w), py = yOf(b.type === 'highpass' || b.type === 'lowpass' ? 0 : b.g);
      x.fillStyle = b.on ? EQ_COLORS[i % 8] : 'rgba(255,255,255,.25)';
      x.beginPath(); x.arc(px, py, i === sel ? 9 : 7, 0, Math.PI * 2); x.fill();
      if (i === sel) { x.strokeStyle = '#fff'; x.lineWidth = 2; x.stroke(); x.lineWidth = 1; }
      x.fillStyle = '#111'; x.font = '700 10px ui-monospace, Menlo, monospace'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(i + 1, px, py + 0.5); x.textAlign = 'start'; x.textBaseline = 'alphabetic';
    });
  };
  const TYPES = [['highpass', 'Low Cut'], ['lowshelf', 'Low Shelf'], ['peaking', 'Bell'], ['highshelf', 'High Shelf'], ['lowpass', 'High Cut']];
  const renderList = () => {
    list.innerHTML = '';
    bands.forEach((b, i) => {
      const upd = () => { recalc(); ctx.change(); draw(); };
      const on = el('input', { type: 'checkbox', checked: b.on, 'aria-label': 'Полоса ' + (i + 1) });
      on.addEventListener('change', () => { b.on = on.checked; upd(); ctx.commit(); });
      const ty = el('select', { class: 'ty' }, ...TYPES.map(([v, t]) => el('option', { value: v, selected: b.type === v }, t)));
      ty.addEventListener('change', () => { b.type = ty.value; upd(); ctx.commit(); });
      const row = el('div', { class: 'eqrow' + (i === sel ? ' sel' : ''), style: `--bc:${EQ_COLORS[i % 8]}`, onclick: () => { sel = i; draw(); [...list.querySelectorAll('.eqrow')].forEach((r, j) => r.classList.toggle('sel', j === i)); } },
        on, el('b', {}, i + 1), ty,
        dragNum({ value: b.f, min: 20, max: 20000, log: true, step: 1, fmt: (v) => fmtHz(v), onInput: (v) => { b.f = v; upd(); }, onChange: ctx.commit }),
        dragNum({ value: b.g, min: -24, max: 24, step: 0.1, fmt: (v) => (v > 0 ? '+' : '') + v.toFixed(1) + ' дБ', onInput: (v) => { b.g = v; upd(); }, onChange: ctx.commit }),
        dragNum({ value: b.q, min: 0.1, max: 18, step: 0.01, log: true, fmt: (v) => 'Q ' + v.toFixed(2), onInput: (v) => { b.q = v; upd(); }, onChange: ctx.commit }),
        el('button', { class: 'x', 'aria-label': 'Удалить полосу', onclick: (e) => { e.stopPropagation(); bands.splice(i, 1); sel = 0; recalc(); ctx.change(); renderList(); draw(); ctx.commit(); } }, '×'));
      list.append(row);
    });
  };
  let drag = null; const ptrs = new Map();
  const hit = (px, py, w, h) => { const yOf = (db) => h / 2 - db / GR * (h / 2 - 10); let best = -1, bd = isTouch ? 30 : 16; bands.forEach((b, i) => { const d = Math.hypot(fx2x(b.f, w) - px, yOf(b.type === 'highpass' || b.type === 'lowpass' ? 0 : b.g) - py); if (d < bd) { bd = d; best = i; } }); return best; };
  c.addEventListener('pointerdown', (e) => {
    const r = c.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 2 && drag) { const [a, b2] = [...ptrs.values()]; drag.pinch = { d0: Math.hypot(a.x - b2.x, a.y - b2.y) || 1, q0: bands[sel].q }; return; }
    const i = hit(px, py, r.width, r.height); if (i < 0) return;
    sel = i; drag = { w: r.width, h: r.height }; c.setPointerCapture(e.pointerId); renderList(); draw();
  });
  c.addEventListener('pointermove', (e) => {
    if (!drag) return; ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const b = bands[sel];
    if (drag.pinch && ptrs.size === 2) { const [a, b2] = [...ptrs.values()]; b.q = Math.min(18, Math.max(0.1, drag.pinch.q0 * (Math.hypot(a.x - b2.x, a.y - b2.y) / drag.pinch.d0))); recalc(); ctx.change(); draw(); return; }
    const r = c.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    b.f = Math.round(Math.min(20000, Math.max(20, x2fx(Math.min(drag.w, Math.max(0, px)), drag.w))));
    if (b.type !== 'highpass' && b.type !== 'lowpass') b.g = Math.round(Math.min(GR, Math.max(-GR, (drag.h / 2 - py) / (drag.h / 2 - 10) * GR)) * 10) / 10;
    b.on = true; recalc(); ctx.change(); draw();
  });
  const up = (e) => { ptrs.delete(e.pointerId); if (drag && ptrs.size === 0) { drag = null; renderList(); ctx.commit(); } };
  c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
  c.addEventListener('wheel', (e) => { const b = bands[sel]; if (!b) return; e.preventDefault(); b.q = Math.round(Math.min(18, Math.max(0.1, b.q * Math.exp(-e.deltaY * 0.003))) * 100) / 100; recalc(); ctx.change(); draw(); clearTimeout(c._wt); c._wt = setTimeout(() => { renderList(); ctx.commit(); }, 300); }, { passive: false });
  c.addEventListener('dblclick', (e) => {
    if (bands.length >= 8) return;
    const r = c.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    if (hit(px, py, r.width, r.height) >= 0) return;
    bands.push(eqBand('peaking', Math.round(x2fx(px, r.width)), Math.round((r.height / 2 - py) / (r.height / 2 - 10) * GR * 10) / 10, 1));
    sel = bands.length - 1; recalc(); ctx.change(); renderList(); draw(); ctx.commit();
  });
  renderList();
  requestAnimationFrame(draw);
  return { el: root, tick: () => { if (S.playing || c.width === 0) draw(); } };
};

/* ---- De-crackle (restoration-suite style) ---- */
FXUI.declick = (obj, ctx) => {
  const d = obj.declick;
  const cps = el('b', { class: 'mono' }, '—');
  const amt = el('input', { type: 'range', min: 0, max: 10, step: 0.1, value: d.amount, class: 'hrange' });
  const amtV = el('span', { class: 'mono' }, d.amount.toFixed(1));
  amt.addEventListener('input', () => { d.amount = +amt.value; amtV.textContent = d.amount.toFixed(1); ctx.change(); });
  amt.addEventListener('change', ctx.commit);
  const only = el('input', { type: 'checkbox', checked: d.only });
  only.addEventListener('change', () => { d.only = only.checked; ctx.change(); ctx.commit(); });
  const root = el('div', { class: 'pl pl-rx' },
    el('div', { class: 'plhead' }, powerBtn(d, ctx), el('b', {}, 'De-crackle'), el('span', { class: 'rxtag' }, 'Restoration')),
    el('div', { class: 'rxbody' },
      el('div', { class: 'rxrow' }, el('span', { class: 'rxl' }, 'Quality'), seg([[0, 'Low'], [1, 'Medium'], [2, 'High']], d.quality, (v) => { d.quality = +v; ctx.change(); ctx.commit(); })),
      el('div', { class: 'rxrow' }, el('span', { class: 'rxl' }, 'Amount'), amt, amtV),
      el('label', { class: 'rxrow' }, only, el('span', {}, 'Output crackle only — слушать только то, что убирается')),
      el('div', { class: 'rxrow' }, el('span', { class: 'rxl' }, 'Найдено щелчков'), cps, el('span', { class: 'dim' }, 'в секунду')),
      el('p', { class: 'note' }, 'Лёгкая настройка 2–4 убирает щелчки губ и цифровой треск, не трогая голос. Включи «Output crackle only», чтобы проверить, что уходят только щелчки.')));
  return { el: root, tick: () => { const m = ctx.gr('declick'); cps.textContent = S.playing && m ? String(Math.round(m.cps)) : '—'; } };
};

/* ---- Vocal Leveler (one-fader vocal compressor style) ---- */
FXUI.vox = (obj, ctx) => {
  const v = obj.vox;
  const meter = (cls) => el('canvas', { class: 'rvmeter ' + cls });
  const grM = meter('gr'), outM = meter('out');
  const gate = vslider({ label: 'Gate', min: -80, max: 0, value: v.gate, def: -80, fmt: (x) => (x <= -79 ? 'Off' : x.toFixed(1)), onInput: (x) => { v.gate = x; ctx.change(); }, onChange: ctx.commit, cls: 'rv' });
  const comp = vslider({ label: 'Comp', min: -36, max: 0, value: v.comp, def: -12, fmt: (x) => x.toFixed(1), onInput: (x) => { v.comp = x; ctx.change(); }, onChange: ctx.commit, cls: 'rv big' });
  const gain = vslider({ label: 'Gain', min: -18, max: 18, value: v.gain, def: 0, fmt: (x) => (x > 0 ? '+' : '') + x.toFixed(1), onInput: (x) => { v.gain = x; ctx.change(); }, onChange: ctx.commit, cls: 'rv' });
  const led = el('span', { class: 'led' });
  const root = el('div', { class: 'pl pl-rv' },
    el('div', { class: 'plhead' }, powerBtn(v, ctx), el('b', {}, 'Vocal Leveler'), el('span', { class: 'rvsub' }, 'gate · comp · auto make-up · limiter')),
    el('div', { class: 'rvbody' },
      el('div', { class: 'rvcol' }, gate, el('div', { class: 'rvled' }, led, 'Gate')),
      comp,
      el('div', { class: 'rvmeters' }, el('div', {}, grM, el('small', {}, 'GR')), el('div', {}, outM, el('small', {}, 'Out'))),
      gain),
    el('p', { class: 'note' }, 'Тяни Comp вниз — голос становится ровнее и громче, уровень подтягивается сам. Gate глушит паузы, если в записи шумно.'));
  const vm = { gr: 0, out: -60 };
  const drawM = (c, val, color, fromTop) => {
    const [x, w, h] = canvas2d(c); x.fillStyle = '#15181a'; x.fillRect(0, 0, w, h);
    const k = Math.min(1, Math.max(0, val)); x.fillStyle = color;
    fromTop ? x.fillRect(2, 0, w - 4, k * h) : x.fillRect(2, h - k * h, w - 4, k * h);
    x.fillStyle = 'rgba(255,255,255,.25)'; for (let i = 1; i < 8; i++) x.fillRect(0, Math.round(h * i / 8), 3, 1);
  };
  return { el: root, tick: () => {
    const m = ctx.gr('vox');
    const tg = S.playing && m ? m.gr : 0, to = S.playing && m ? m.out : -60;
    vm.gr += (tg - vm.gr) * 0.3; vm.out = Math.max(to, vm.out - 1.2);
    drawM(grM, vm.gr / 24, '#F0B33A', true); drawM(outM, (vm.out + 60) / 60, '#55C46E', false);
    led.classList.toggle('on', !!(S.playing && m && m.gate));
  } };
};

/* ---- De-Esser (big-knob de-esser with history display) ---- */
FXUI.deess = (obj, ctx) => {
  const d = obj.deess;
  const hist = el('canvas', { class: 'dshist' }), grBar = el('canvas', { class: 'dsgr' });
  const H = []; // [lvl, gr]
  const thr = knob({ value: d.thr, min: -60, max: 0, def: -20, size: 92, cls: 'k-fab', label: 'THRESHOLD', fmt: (v) => v.toFixed(1) + ' dB', onInput: (v) => { d.thr = v; ctx.change(); }, onChange: ctx.commit });
  const rng = knob({ value: d.range, min: 0, max: 24, def: 6, size: 92, cls: 'k-fab', label: 'RANGE', fmt: (v) => v.toFixed(1) + ' dB', onInput: (v) => { d.range = v; ctx.change(); }, onChange: ctx.commit });
  const link = knob({ value: d.link, min: 0, max: 100, def: 100, size: 52, cls: 'k-dsg', label: 'STEREO LINK', fmt: (v) => Math.round(v) + '% MID', onInput: (v) => { d.link = v; ctx.change(); }, onChange: ctx.commit });
  const look = knob({ value: d.look, min: 0, max: 15, def: 5, size: 52, cls: 'k-dsg', label: 'LOOKAHEAD', fmt: (v) => v.toFixed(1) + ' ms', onInput: (v) => { d.look = v; ctx.change(); }, onChange: ctx.commit });
  // frequency band bar
  const bar = el('div', { class: 'dsband' }), fill = el('div', { class: 'dsfill' }), h1 = el('div', { class: 'dsh' }), h2 = el('div', { class: 'dsh' });
  const f1t = el('span', { class: 'mono' }), f2t = el('span', { class: 'mono' });
  bar.append(fill, h1, h2);
  const FL = 1000, FH = 20000, pos = (f) => Math.log(f / FL) / Math.log(FH / FL), fq = (p) => FL * Math.pow(FH / FL, Math.min(1, Math.max(0, p)));
  const renderBand = () => { const a = pos(d.f1) * 100, b = pos(d.f2) * 100; h1.style.left = a + '%'; h2.style.left = b + '%'; fill.style.left = a + '%'; fill.style.width = (b - a) + '%'; f1t.textContent = fmtHz(d.f1); f2t.textContent = fmtHz(d.f2); };
  for (const [h, k] of [[h1, 'f1'], [h2, 'f2']]) {
    h.addEventListener('pointerdown', (e) => { e.preventDefault(); h.setPointerCapture(e.pointerId); h._d = true; });
    h.addEventListener('pointermove', (e) => { if (!h._d) return; const r = bar.getBoundingClientRect(); let f = Math.round(fq((e.clientX - r.left) / r.width)); if (k === 'f1') f = Math.min(f, d.f2 / 1.05); else f = Math.max(f, d.f1 * 1.05); d[k] = Math.round(f); renderBand(); ctx.change(); });
    h.addEventListener('pointerup', () => { if (h._d) { h._d = false; ctx.commit(); } });
  }
  renderBand();
  const root = el('div', { class: 'pl pl-ds' },
    el('div', { class: 'plhead' }, powerBtn(d, ctx), el('b', { class: 'dslogo' }, 'De·Esser'), el('span', { class: 'dim' }, 'жёлтое — подавление, зелёное — уровень в полосе')),
    el('div', { class: 'dstop' }, hist, grBar),
    el('div', { class: 'dsctl' },
      el('div', { class: 'dsknobs' }, thr, rng),
      el('div', { class: 'dsmid' },
        el('div', { class: 'dslab' }, 'MODE'),
        seg([['vocal', 'SINGLE VOCAL'], ['allround', 'ALLROUND']], d.mode, (v) => { d.mode = v; ctx.change(); ctx.commit(); }, 'dsseg'),
        seg([['wide', 'WIDE BAND'], ['split', 'SPLIT BAND']], d.band, (v) => { d.band = v; ctx.change(); ctx.commit(); }, 'dsseg'),
        el('div', { class: 'dslab' }, 'ДЕТЕКЦИЯ'), bar, el('div', { class: 'dsfreq' }, f1t, f2t)),
      el('div', { class: 'dsknobs small' }, link, look)));
  return { el: root, tick: () => {
    const m = ctx.gr('deess');
    if (S.playing && m) { H.push([m.lvl, m.gr]); if (H.length > 400) H.shift(); }
    const [x, w, h] = canvas2d(hist);
    x.fillStyle = '#1d1f22'; x.fillRect(0, 0, w, h);
    for (let i = 1; i < 6; i++) { x.fillStyle = 'rgba(255,255,255,.05)'; x.fillRect(0, Math.round(h * i / 6), w, 1); }
    const yOf = (db) => h - Math.min(1, Math.max(0, (db + 72) / 72)) * h;
    const step = w / 400, off = w - H.length * step;
    x.fillStyle = 'rgba(160,210,90,.55)'; x.beginPath(); x.moveTo(off, h);
    H.forEach(([l], i) => x.lineTo(off + i * step, yOf(l))); x.lineTo(w, h); x.fill();
    x.fillStyle = 'rgba(245,200,70,.85)';
    H.forEach(([l, g], i) => { if (g > 0.05) { const y = yOf(l); x.fillRect(off + i * step, y, Math.max(1, step), Math.min(h - y, g / 24 * h * 2)); } });
    x.fillStyle = 'rgba(255,255,255,.75)'; x.fillRect(0, Math.round(yOf(d.thr)), w, 1);
    x.font = '10px ui-monospace, Menlo, monospace'; x.fillText('threshold ' + d.thr.toFixed(1), 6, yOf(d.thr) - 4);
    const [y, w2, h2] = canvas2d(grBar); y.fillStyle = '#16181a'; y.fillRect(0, 0, w2, h2);
    const g = S.playing && m ? m.gr : 0; y.fillStyle = '#F2C94C'; y.fillRect(3, 0, w2 - 6, Math.min(1, g / 24) * h2);
    y.fillStyle = 'rgba(255,255,255,.75)'; y.font = '10px ui-monospace, Menlo, monospace'; y.fillText('−' + g.toFixed(1), 2, h2 - 4);
  } };
};

/* ---- Saturation ---- */
FXUI.drive = (obj, ctx) => {
  const d = obj.drive;
  const k = knob({ value: d.amount, min: 0, max: 1, def: 0.35, size: 96, cls: 'k-def', label: 'DRIVE', fmt: (v) => Math.round(v * 100) + '%', onInput: (v) => { d.amount = v; ctx.change(); }, onChange: ctx.commit });
  return { el: el('div', { class: 'pl pl-sat' }, el('div', { class: 'plhead' }, powerBtn(d, ctx), el('b', {}, 'Saturation'), el('span', { class: 'dim' }, 'ламповый перегруз с 4× передискретизацией')), el('div', { class: 'satbody' }, k), el('p', { class: 'note' }, 'Для «голоса под радио»: вместе с узкой полосой EQ даёт звук приёмника или телефона.')) };
};

/* ---- Spectral Ducker (resonance-suppressor style) ---- */
FXUI.duck = (obj, ctx) => {
  const d = obj.duck;
  const c = el('canvas', { class: 'dkc' });
  const kn = (key, label, min, max, def, fmt, log) => knob({ value: d[key], min, max, def, log, size: 64, cls: 'k-sth', label, fmt, onInput: (v) => { d[key] = v; ctx.change(); }, onChange: ctx.commit });
  const root = el('div', { class: 'pl pl-dk' },
    el('div', { class: 'plhead' }, powerBtn(d, ctx), el('b', {}, 'Spectral Ducker'), el('span', { class: 'dim' }, 'музыка уступает голосу только в его частотах, Mid')),
    c,
    el('div', { class: 'dkknobs' },
      kn('depth', 'DEPTH', 0, 18, 8, (v) => v.toFixed(1) + ' dB'),
      kn('sens', 'SHARPNESS', 0, 18, 6, (v) => v.toFixed(1)),
      kn('attack', 'ATTACK', 1, 100, 10, (v) => Math.round(v) + ' ms', true),
      kn('release', 'RELEASE', 20, 800, 150, (v) => Math.round(v) + ' ms', true),
      el('div', { class: 'dkrange' }, el('span', { class: 'klab' }, 'ДИАПАЗОН'),
        dragNum({ value: d.lo, min: 40, max: 1000, log: true, step: 1, fmt: fmtHz, onInput: (v) => { d.lo = v; ctx.change(); }, onChange: ctx.commit }),
        el('span', { class: 'dim' }, '—'),
        dragNum({ value: d.hi, min: 2000, max: 16000, log: true, step: 10, fmt: fmtHz, onInput: (v) => { d.hi = v; ctx.change(); }, onChange: ctx.commit }))));
  let sm = null;
  return { el: root, tick: () => {
    const [x, w, h] = canvas2d(c);
    x.fillStyle = '#17191c'; x.fillRect(0, 0, w, h);
    freqGrid(x, w, h, 'rgba(255,255,255,.05)', 'rgba(255,255,255,.3)');
    x.fillStyle = 'rgba(255,140,60,.06)'; x.fillRect(fx2x(d.lo, w), 0, fx2x(d.hi, w) - fx2x(d.lo, w), h);
    const m = ctx.gr('duck');
    if (m && m.bands && m.freqs) {
      if (!sm || sm.length !== m.bands.length) sm = new Float32Array(m.bands.length);
      for (let i = 0; i < sm.length; i++) sm[i] += ((S.playing ? m.bands[i] : 0) - sm[i]) * 0.35;
      x.strokeStyle = '#FF8A3D'; x.lineWidth = 2; x.fillStyle = 'rgba(255,138,61,.25)'; x.beginPath(); x.moveTo(0, 6);
      m.freqs.forEach((f, i) => x.lineTo(fx2x(f, w), 6 + sm[i] / 18 * (h - 24)));
      x.lineTo(w, 6); x.stroke(); x.lineTo(w, 0); x.lineTo(0, 0); x.fill(); x.lineWidth = 1;
    }
    x.fillStyle = 'rgba(255,255,255,.4)'; x.font = '10px ui-monospace, Menlo, monospace'; x.fillText('подавление по частотам ↓', 8, h - 18);
  } };
};

/* ---- Multiband dynamics (mastering-suite style) ---- */
const MB_COLORS = ['#30B6EE', '#E354D6', '#F26A63', '#4DA6F5'];
FXUI.mb = (obj, ctx) => {
  const mb = obj.mb, B = mb.bands;
  const disp = el('canvas', { class: 'mbc' });
  const cols = el('div', { class: 'mbcols' });
  const meters = [];
  const root = el('div', { class: 'pl pl-mb' },
    el('div', { class: 'plhead mbhead' }, powerBtn(mb, ctx), el('b', { class: 'mblogo' }, 'Dynamics'), el('span', { class: 'mbmode' }, 'Stereo'), el('span', { class: 'dim' }, 'тяни белые ручки — частоты раздела, точки на шкалах — пороги')),
    disp, cols);
  const bandName = (i) => { const lo = i ? mb.xo[i - 1] : 20, hi = i < 3 ? mb.xo[i] : 20000; return `${fmtHz(lo)} – ${fmtHz(hi)}`; };
  const renderCols = () => {
    cols.innerHTML = ''; meters.length = 0;
    B.forEach((b, i) => {
      const col = MB_COLORS[i];
      const dn = (key, min, max, step, fmt, log) => dragNum({ value: b[key], min, max, step, log, fmt, color: col, onInput: (v) => { b[key] = v; ctx.change(); }, onChange: ctx.commit });
      const m = el('canvas', { class: 'mbm' }); meters.push(m);
      const lThr = el('span', { class: 'mono', style: `color:${col}` }), cThr = el('span', { class: 'mono', style: `color:${col}` });
      const sync = () => { lThr.textContent = b.lThr.toFixed(1); cThr.textContent = b.cThr.toFixed(1); };
      sync();
      // drag thresholds on the meter
      let drag = null;
      const yToDb = (y, h) => Math.round(Math.min(0, Math.max(-60, -y / h * 60)) * 10) / 10;
      m.addEventListener('pointerdown', (e) => {
        e.preventDefault(); const r = m.getBoundingClientRect(), py = e.clientY - r.top;
        const yl = -b.lThr / 60 * r.height, yc = -b.cThr / 60 * r.height;
        drag = Math.abs(py - yl) < Math.abs(py - yc) ? 'lThr' : 'cThr'; m.setPointerCapture(e.pointerId);
      });
      m.addEventListener('pointermove', (e) => { if (!drag) return; const r = m.getBoundingClientRect(); b[drag] = yToDb(e.clientY - r.top, r.height); sync(); ctx.change(); });
      m.addEventListener('pointerup', () => { if (drag) { drag = null; ctx.commit(); } });
      const pw = el('button', { class: 'mbpw' + (b.on !== false ? ' on' : ''), style: `--bc:${col}`, 'aria-label': 'Вкл/выкл полосу', onclick: () => { b.on = b.on === false; pw.classList.toggle('on', b.on !== false); ctx.change(); ctx.commit(); } }, '⏻');
      cols.append(el('div', { class: 'mbcol', style: `--bc:${col}` },
        el('div', { class: 'mbtop' }, pw, el('b', {}, 'Band ' + (i + 1)), el('small', { class: 'dim mbrange' }, bandName(i))),
        el('div', { class: 'mbmain' },
          el('div', { class: 'mbthr' },
            el('div', { class: 'mbtl' }, el('small', {}, 'Limiter'), lThr),
            m,
            el('div', { class: 'mbtl c' }, el('small', {}, 'Comp'), cThr)),
          el('div', { class: 'mbpar' },
            el('b', {}, 'Limiter'),
            el('small', {}, 'Ratio'), dn('lRatio', 1, 20, 0.1, (v) => v.toFixed(1) + ':1'),
            el('small', {}, 'Attack'), dn('lAtt', 0.1, 200, 0.1, (v) => v.toFixed(1) + ' ms', true),
            el('small', {}, 'Release'), dn('lRel', 5, 2000, 1, (v) => Math.round(v) + ' ms', true),
            el('b', {}, 'Compressor'),
            el('small', {}, 'Ratio'), dn('cRatio', 1, 20, 0.1, (v) => v.toFixed(1) + ':1'),
            el('small', {}, 'Attack'), dn('cAtt', 0.1, 200, 0.1, (v) => v.toFixed(1) + ' ms', true),
            el('small', {}, 'Release'), dn('cRel', 5, 2000, 1, (v) => Math.round(v) + ' ms', true))),
        el('div', { class: 'mbfoot' },
          el('span', {}, el('small', {}, 'Gain '), dn('gain', -12, 12, 0.1, (v) => (v > 0 ? '+' : '') + v.toFixed(1) + ' dB')),
          el('span', {}, el('small', {}, 'Parallel '), dn('mix', 0, 100, 1, (v) => Math.round(v) + '%')))));
    });
  };
  renderCols();
  // crossover dragging on the display
  let xd = null;
  disp.addEventListener('pointerdown', (e) => {
    const r = disp.getBoundingClientRect(), px = e.clientX - r.left;
    let best = -1, bd = isTouch ? 26 : 14;
    mb.xo.forEach((f, i) => { const d = Math.abs(fx2x(f, r.width) - px); if (d < bd) { bd = d; best = i; } });
    if (best < 0) return; xd = { i: best, w: r.width }; disp.setPointerCapture(e.pointerId);
  });
  disp.addEventListener('pointermove', (e) => {
    if (!xd) return; const r = disp.getBoundingClientRect();
    let f = x2fx(Math.min(xd.w, Math.max(0, e.clientX - r.left)), xd.w);
    const lo = xd.i ? mb.xo[xd.i - 1] * 1.3 : 40, hi = xd.i < 2 ? mb.xo[xd.i + 1] / 1.3 : 16000;
    mb.xo[xd.i] = Math.round(Math.min(hi, Math.max(lo, f)));
    ctx.change();
    cols.querySelectorAll('.mbrange').forEach((s, i) => { s.textContent = bandName(i); });
  });
  disp.addEventListener('pointerup', () => { if (xd) { xd = null; ctx.commit(); } });
  const sm = [0, 0, 0, 0], lv = [-90, -90, -90, -90];
  return { el: root, tick: () => {
    const [x, w, h] = canvas2d(disp);
    x.fillStyle = '#101722'; x.fillRect(0, 0, w, h);
    freqGrid(x, w, h, 'rgba(255,255,255,.05)', 'rgba(255,255,255,.35)', [60, 100, 300, 600, 1000, 3000, 6000, 10000]);
    drawSpectrum(x, ctx.an(), w, h, 'rgba(150,165,185,.18)', 'rgba(190,205,225,.55)');
    const edges = [20, ...mb.xo, 20000];
    for (let i = 0; i < 4; i++) {
      const a = fx2x(edges[i], w), b2 = fx2x(edges[i + 1], w);
      x.fillStyle = MB_COLORS[i]; x.globalAlpha = B[i].on === false ? 0.25 : 0.9; x.fillRect(a + 2, 22, b2 - a - 4, 2); x.globalAlpha = 1;
      x.fillStyle = 'rgba(255,255,255,.75)'; x.font = '600 11px -apple-system, system-ui, sans-serif'; x.fillText(String(i + 1), (a + b2) / 2 - 3, 16);
    }
    mb.xo.forEach((f) => {
      const px = Math.round(fx2x(f, w));
      x.fillStyle = 'rgba(255,255,255,.85)'; x.fillRect(px - 1, 0, 2, h);
      x.fillStyle = '#E9EEF4'; x.strokeStyle = '#101722';
      x.beginPath(); x.roundRect ? x.roundRect(px - 6, 6, 12, 32, 6) : x.rect(px - 6, 6, 12, 32); x.fill(); x.stroke();
      x.fillStyle = 'rgba(255,255,255,.7)'; x.font = '10px ui-monospace, Menlo, monospace'; x.fillText(fmtHz(f), px + 9, 48);
    });
    const m = ctx.gr('mb');
    meters.forEach((c, i) => {
      if (!c.isConnected) return;
      const [y, mw, mh] = canvas2d(c);
      const tg = S.playing && m ? m.gr[i] : 0; sm[i] += (tg - sm[i]) * 0.35;
      const tl = S.playing && m ? m.lvl[i] : -90; lv[i] = Math.max(tl, lv[i] - 1.5);
      y.fillStyle = '#0D131B'; y.fillRect(0, 0, mw, mh);
      const yOf = (db) => Math.min(1, Math.max(0, -db / 60)) * mh;
      for (let d = -6; d > -60; d -= 6) { y.fillStyle = 'rgba(255,255,255,.07)'; y.fillRect(0, Math.round(yOf(d)), mw, 1); }
      y.fillStyle = 'rgba(200,210,225,.55)'; y.fillRect(mw * 0.18, yOf(lv[i]), mw * 0.28, mh - yOf(lv[i]));
      y.fillStyle = MB_COLORS[i]; y.fillRect(mw * 0.54, 0, mw * 0.28, Math.min(mh, sm[i] / 24 * mh));
      const b = B[i];
      for (const [k, r] of [['lThr', 6], ['cThr', 6]]) { const py = yOf(b[k]); y.fillStyle = 'rgba(255,255,255,.85)'; y.fillRect(0, Math.round(py), mw, 1); y.beginPath(); y.arc(mw * 0.5, Math.max(r, Math.min(mh - r, py)), r, 0, Math.PI * 2); y.fill(); }
    });
  } };
};

/* ---- Opto / Discrete mastering compressor (hardware-style) ---- */
FXUI.sh = (obj, ctx) => {
  const s = obj.sh;
  const n20 = ['0', '2', '4', '6', '8', '10', '12', '14', '16', '18', '20'];
  const big = (key, label, fmt) => knob({ value: s[key], min: 0, max: 20, def: s[key], size: 86, cls: 'k-sh', labels: n20, label, fmt, onInput: (v) => { s[key] = v; ctx.change(); }, onChange: ctx.commit });
  const stepK = (key, label, labels, fmt) => knob({ value: s[key], steps: labels.length, size: 70, cls: 'k-sh', labels, label, stepFmt: fmt, onInput: (v) => { s[key] = v; ctx.change(); }, onChange: ctx.commit });
  const tog = (key, label) => {
    const b = el('button', { class: 'shtog' + (s[key] ? ' on' : ''), onclick: () => { s[key] = !s[key]; b.classList.toggle('on', s[key]); lamp.classList.toggle('on', s[key]); ctx.change(); ctx.commit(); } }, el('i'), el('span', {}, s[key] ? 'IN' : 'OUT'));
    const lamp = el('span', { class: 'shlamp' + (s[key] ? ' on' : '') });
    b.addEventListener('click', () => { b.lastChild.textContent = s[key] ? 'IN' : 'OUT'; });
    return el('div', { class: 'shtg' }, lamp, b, el('small', {}, label));
  };
  const vuO = el('canvas', { class: 'vu' }), vuD = el('canvas', { class: 'vu' });
  const xf = el('div', { class: 'shxf' }, ...['NICKEL', 'IRON', 'STEEL'].map((t, i) => el('button', { class: s.xf === i ? 'on' : '', onclick: (e) => { s.xf = i; [...xf.children].forEach((b, j) => b.classList.toggle('on', j === i)); ctx.change(); ctx.commit(); } }, el('span', { class: 'shlamp' }), t)));
  const mix = knob({ value: s.mix, min: 0, max: 100, def: 100, size: 46, cls: 'k-sh', label: 'MIX', fmt: (v) => Math.round(v) + '%', onInput: (v) => { s.mix = v; ctx.change(); }, onChange: ctx.commit });
  const root = el('div', { class: 'pl pl-sh' },
    el('div', { class: 'shbar' }, powerBtn(s, ctx), el('span', { class: 'shtitle' }, 'OPTO · DISCRETE'), el('span', { class: 'dim' }, 'двойной тап по ручке — сброс')),
    el('div', { class: 'shpanel' },
      el('div', { class: 'shsec' },
        el('div', { class: 'shcap' }, 'OPTICAL'),
        big('oThr', 'THRESHOLD', (v) => shThrDb(v).toFixed(1) + ' dB'),
        big('oGain', 'GAIN', (v) => '+' + shGainDb(v).toFixed(1) + ' dB'),
        tog('oOn', 'BYPASS')),
      el('div', { class: 'shcenter' },
        el('div', { class: 'shname' }, 'MASTERING COMPRESSOR'),
        el('div', { class: 'vus' }, el('div', {}, vuO, el('small', {}, 'OPTICAL GR')), el('div', {}, vuD, el('small', {}, 'DISCRETE GR'))),
        el('div', { class: 'shmid' }, xf, mix, el('div', { class: 'shst' }, el('span', { class: 'shlamp on' }), 'STEREO'))),
      el('div', { class: 'shsec disc' },
        el('div', { class: 'shcap' }, 'DISCRETE'),
        el('div', { class: 'shgrid' },
          big('dThr', 'THRESHOLD', (v) => shThrDb(v).toFixed(1) + ' dB'),
          stepK('dRatio', 'RATIO', SH_RATIO_L, (i) => (SH_RATIOS[i] === 20 ? 'Flood' : SH_RATIOS[i] + ':1')),
          stepK('dAtt', 'ATTACK', SH_ATT_L, (i) => SH_ATTS[i] + ' ms'),
          stepK('dRec', 'RECOVER', SH_REC_L, (i) => (SH_RECS[i] < 0 ? 'Dual' : SH_RECS[i] + ' s')),
          big('dGain', 'GAIN', (v) => '+' + shGainDb(v).toFixed(1) + ' dB'),
          tog('dOn', 'BYPASS')))));
  const nd = { o: 0, d: 0 };
  const drawVU = (c, gr) => {
    const [x, w, h] = canvas2d(c);
    const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#F3EBD2'); g.addColorStop(1, '#D9CDAA');
    x.fillStyle = '#0a0a0a'; x.fillRect(0, 0, w, h); x.fillStyle = g; x.beginPath(); x.roundRect ? x.roundRect(4, 4, w - 8, h - 8, 8) : x.rect(4, 4, w - 8, h - 8); x.fill();
    const cxp = w / 2, cy = h * 0.98, R = Math.min(h * 0.68, w * 0.42);
    const ang = (db) => (-50 + (db + 20) / 23 * 100) * Math.PI / 180; // -20..+3
    x.strokeStyle = '#222'; x.lineWidth = 1.5; x.beginPath(); x.arc(cxp, cy, R, -Math.PI / 2 + ang(-20), -Math.PI / 2 + ang(0)); x.stroke();
    x.strokeStyle = '#C8312B'; x.lineWidth = 4; x.beginPath(); x.arc(cxp, cy, R, -Math.PI / 2 + ang(0), -Math.PI / 2 + ang(3)); x.stroke();
    x.fillStyle = '#222'; x.font = `600 ${Math.max(8, h * 0.085)}px -apple-system, system-ui, sans-serif`; x.textAlign = 'center';
    for (const d of [-20, -10, -7, -5, -3, -2, -1, 0, 1, 2, 3]) {
      const a = ang(d) - Math.PI / 2, r1 = R + 2, r2 = R + (d % 5 === 0 || d > -4 ? 9 : 5);
      x.lineWidth = 1.2; x.strokeStyle = d > 0 ? '#C8312B' : '#222';
      x.beginPath(); x.moveTo(cxp + Math.cos(a) * r1, cy + Math.sin(a) * r1); x.lineTo(cxp + Math.cos(a) * r2, cy + Math.sin(a) * r2); x.stroke();
      if ([-20, -10, -5, -3, -1, 0, 1, 3].includes(d)) { x.fillStyle = d > 0 ? '#C8312B' : '#222'; x.fillText(String(d > 0 ? '+' + d : d), cxp + Math.cos(a) * (R + 15), cy + Math.sin(a) * (R + 15) + 3); }
    }
    x.fillStyle = '#222'; x.font = `700 ${Math.max(8, h * 0.09)}px -apple-system, system-ui, sans-serif`; x.fillText('VU', cxp - R * 0.62, h * 0.64); x.fillStyle = '#C8312B'; x.fillText('VU', cxp + R * 0.62, h * 0.64);
    x.fillStyle = '#555'; x.font = `${Math.max(7, h * 0.07)}px -apple-system, system-ui, sans-serif`; x.fillText('GAIN REDUCTION', cxp, h * 0.74);
    const a = ang(Math.max(-20, -gr)) - Math.PI / 2;
    x.strokeStyle = '#111'; x.lineWidth = 1.6; x.beginPath(); x.moveTo(cxp, cy); x.lineTo(cxp + Math.cos(a) * R * 1.02, cy + Math.sin(a) * R * 1.02); x.stroke();
    x.fillStyle = '#1b1b1b'; x.beginPath(); x.arc(cxp, h - 4, h * 0.16, Math.PI, 0); x.fill();
    x.textAlign = 'start'; x.lineWidth = 1;
  };
  return { el: root, tick: () => {
    const m = ctx.gr('sh');
    const to = S.playing && m ? m.o : 0, td = S.playing && m ? m.d : 0;
    nd.o += (to - nd.o) * 0.12; nd.d += (td - nd.d) * 0.12;
    drawVU(vuO, nd.o); drawVU(vuD, nd.d);
  } };
};

/* ---- shared VU meter face ---- */
function drawVUFace(c, needle, sub = 'GAIN REDUCTION') {
  const [x, w, h] = canvas2d(c);
  const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#F5ECCF'); g.addColorStop(1, '#DCCFA6');
  x.fillStyle = '#0a0a0a'; x.fillRect(0, 0, w, h); x.fillStyle = g; x.beginPath(); x.roundRect ? x.roundRect(4, 4, w - 8, h - 8, 8) : x.rect(4, 4, w - 8, h - 8); x.fill();
  const cxp = w / 2, cy = h * 0.98, R = Math.min(h * 0.68, w * 0.42);
  const ang = (db) => (-50 + (db + 20) / 23 * 100) * Math.PI / 180;
  x.strokeStyle = '#222'; x.lineWidth = 1.5; x.beginPath(); x.arc(cxp, cy, R, -Math.PI / 2 + ang(-20), -Math.PI / 2 + ang(0)); x.stroke();
  x.strokeStyle = '#C8312B'; x.lineWidth = 4; x.beginPath(); x.arc(cxp, cy, R, -Math.PI / 2 + ang(0), -Math.PI / 2 + ang(3)); x.stroke();
  x.font = `600 ${Math.max(8, h * 0.085)}px -apple-system, system-ui, sans-serif`; x.textAlign = 'center';
  for (const d of [-20, -10, -7, -5, -3, -2, -1, 0, 1, 2, 3]) {
    const a = ang(d) - Math.PI / 2, r1 = R + 2, r2 = R + (d % 5 === 0 || d > -4 ? 9 : 5);
    x.lineWidth = 1.2; x.strokeStyle = d > 0 ? '#C8312B' : '#222';
    x.beginPath(); x.moveTo(cxp + Math.cos(a) * r1, cy + Math.sin(a) * r1); x.lineTo(cxp + Math.cos(a) * r2, cy + Math.sin(a) * r2); x.stroke();
    if ([-20, -10, -5, -3, -1, 0, 1, 3].includes(d)) { x.fillStyle = d > 0 ? '#C8312B' : '#222'; x.fillText(String(d > 0 ? '+' + d : d), cxp + Math.cos(a) * (R + 15), cy + Math.sin(a) * (R + 15) + 3); }
  }
  x.fillStyle = '#222'; x.font = `700 ${Math.max(9, h * 0.1)}px -apple-system, system-ui, sans-serif`; x.fillText('VU', cxp, h * 0.64);
  x.fillStyle = '#555'; x.font = `${Math.max(7, h * 0.07)}px -apple-system, system-ui, sans-serif`; x.fillText(sub, cxp, h * 0.76);
  const a = ang(Math.max(-20, Math.min(3.5, needle))) - Math.PI / 2;
  x.strokeStyle = '#111'; x.lineWidth = 1.6; x.beginPath(); x.moveTo(cxp, cy); x.lineTo(cxp + Math.cos(a) * R * 1.02, cy + Math.sin(a) * R * 1.02); x.stroke();
  x.fillStyle = '#1b1b1b'; x.beginPath(); x.arc(cxp, h - 4, h * 0.14, Math.PI, 0); x.fill();
  x.textAlign = 'start'; x.lineWidth = 1;
}

/* ---- Opto leveler (classic tube optical compressor style) ---- */
FXUI.la2a = (obj, ctx) => {
  const L = obj.la2a;
  const n100 = ['0', '10', '20', '30', '40', '50', '60', '70', '80', '90', '100'];
  const gain = knob({ value: L.gain, min: 0, max: 100, def: 50, size: 104, cls: 'k-2a', labels: n100, label: 'GAIN', fmt: (v) => (v >= 40 ? '+' : '') + ((v - 40) * 0.45).toFixed(1) + ' dB', onInput: (v) => { L.gain = v; ctx.change(); }, onChange: ctx.commit });
  const peak = knob({ value: L.peak, min: 0, max: 100, def: 40, size: 104, cls: 'k-2a', labels: n100, label: 'PEAK REDUCTION', fmt: (v) => Math.round(v), onInput: (v) => { L.peak = v; ctx.change(); }, onChange: ctx.commit });
  const vu = el('canvas', { class: 'vu va' });
  const sw = (opts, key, cls) => el('div', { class: 'sw2a ' + (cls || '') }, ...opts.map(([v, t]) => el('button', { class: String(L[key]) === String(v) ? 'on' : '', onclick: (e) => { L[key] = v; [...e.currentTarget.parentElement.children].forEach((b) => b.classList.toggle('on', b === e.currentTarget)); ctx.change(); ctx.commit(); } }, t)));
  const lamp = el('span', { class: 'lamp2a' + (L.on ? ' on' : '') });
  const root = el('div', { class: 'pl pl-2a' },
    el('div', { class: 'plhead' }, powerBtn(L, ctx), el('b', {}, 'Opto Leveler'), el('span', { class: 'dim' }, 'оптический ламповый компрессор: мягкий, «дышит» вместе с голосом')),
    el('div', { class: 'face2a' },
      el('div', { class: 'brand2a' }, el('span', {}, 'LEVELING AMPLIFIER'), el('small', {}, 'OPTICAL · TUBE')),
      el('div', { class: 'row2a' },
        gain,
        el('div', { class: 'mid2a' }, vu,
          el('div', { class: 'sws2a' },
            el('div', {}, el('small', {}, 'METER'), sw([['gr', 'GAIN RED.'], ['10', '+10'], ['4', '+4']], 'meter')),
            el('div', {}, el('small', {}, 'MODE'), sw([[false, 'COMPRESS'], [true, 'LIMIT']], 'limit')),
            el('div', { class: 'pw2a' }, lamp, el('small', {}, 'POWER')))),
        peak)),
    el('p', { class: 'note' }, 'Peak Reduction — сколько поджимать, Gain — громкость на выходе. Compress мягче (≈3:1), Limit плотнее. Стоит в цепочке после Vocal Leveler: можно использовать вместе или вместо него.'));
  let nd = 0;
  return { el: root, tick: () => {
    const m = ctx.gr('la2a'); lamp.classList.toggle('on', L.on !== false);
    let target = 0;
    if (S.playing && m) target = L.meter === 'gr' ? -m.gr : L.meter === '10' ? m.out + 8 : m.out + 14;
    else if (L.meter !== 'gr') target = -20;
    nd += (target - nd) * 0.12;
    drawVUFace(vu, nd, L.meter === 'gr' ? 'GAIN REDUCTION' : 'OUTPUT ' + (L.meter === '10' ? '+10' : '+4'));
  } };
};

/* ---- Multimaximizer (6-band true-peak limiter, classic multimaximizer layout) ---- */
const L3_COLORS = ['#E8892B', '#E8D22B', '#3FCF4C', '#E04242', '#3F8CF0', '#B048E0'];
function l3fader({ value, min, max, log = false, fmt, height = 300, onInput, onChange, meters = [] }) {
  let v = value;
  const norm = (x) => (log ? Math.log(x / min) / Math.log(max / min) : (x - min) / (max - min));
  const den = (n) => { n = clamp(n, 0, 1); return log ? min * Math.pow(max / min, n) : min + n * (max - min); };
  const badge = el('div', { class: 'l3badge mono' });
  const track = el('div', { class: 'l3track', style: `height:${height}px` }, ...meters, el('div', { class: 'l3rail' }), badge);
  const render = () => { badge.style.bottom = `calc(${norm(v) * 100}% - 12px)`; badge.textContent = fmt(v); };
  let d = null;
  track.addEventListener('pointerdown', (e) => { e.preventDefault(); track.setPointerCapture(e.pointerId); d = { y: e.clientY, n: norm(v), moved: false }; });
  track.addEventListener('pointermove', (e) => { if (!d) return; const dy = d.y - e.clientY; if (Math.abs(dy) > 2) d.moved = true; v = den(d.n + dy / height * (e.shiftKey ? 0.25 : 1)); render(); onInput(v); });
  const end = () => { if (d && d.moved) onChange(v); d = null; };
  track.addEventListener('pointerup', end); track.addEventListener('pointercancel', end);
  track.set = (nv) => { v = nv; render(); };
  render();
  return track;
}
function l3select(options, value, onChange) {
  const s = el('select', { class: 'l3sel' }, ...options.map(([v, t]) => el('option', { value: v, selected: String(v) === String(value) }, t)));
  s.addEventListener('change', () => onChange(s.value));
  return s;
}
const SHAPE_ICON = {
  lowshelf: '<svg viewBox="0 0 40 14"><path d="M2 4h12c6 0 8 6 14 6h10" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  peaking: '<svg viewBox="0 0 40 14"><path d="M2 11h10c4 0 5-8 8-8s4 8 8 8h10" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  highshelf: '<svg viewBox="0 0 40 14"><path d="M2 10h10c6 0 8-6 14-6h12" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
};
FXUI.lim = (obj, ctx) => {
  const M = obj, L = M.lim;
  const mc = () => el('canvas', { class: 'l3mtr' });
  const inL = mc(), inR = mc(), outL = mc(), outR = mc(), at = el('canvas', { class: 'l3at' });
  const H = 300;
  const thr = l3fader({ value: L.thresh, min: -30, max: 0, height: H, fmt: (v) => v.toFixed(1), meters: [inL, inR], onInput: (v) => { L.thresh = Math.round(v * 10) / 10; ctx.change(); }, onChange: ctx.commit });
  const ceil = l3fader({ value: L.ceiling, min: -30, max: 0, height: H, fmt: (v) => v.toFixed(1), meters: [outL, outR], onInput: (v) => { L.ceiling = Math.round(v * 10) / 10; ctx.change(); }, onChange: ctx.commit });
  const rel = l3fader({ value: L.release, min: 0.01, max: 1000, log: true, height: H, fmt: (v) => (v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : Math.round(v)), onInput: (v) => { L.release = v; ctx.change(); }, onChange: ctx.commit });
  const ro = [0, 1, 2, 3].map(() => el('span', { class: 'l3ro mono' }, '-Inf')); const roAt = el('span', { class: 'l3ro mono' }, '0.0');
  const atScale = el('div', { class: 'l3scale' }, ...[0, 6, 12, 18, 24, 30].map((d) => el('span', { style: `top:${d / 30 * 100}%` }, d + ' –')));
  const left = el('div', { class: 'l3left' },
    el('div', { class: 'l3cols' },
      el('div', { class: 'l3col' }, el('span', { class: 'l3cap' }, 'Threshold'), thr),
      el('div', { class: 'l3col' }, el('span', { class: 'l3cap' }, 'Out Ceiling'), ceil),
      el('div', { class: 'l3col' }, el('span', { class: 'l3cap' }, 'Atten'), el('div', { class: 'l3atwrap', style: `height:${H}px` }, atScale, at)),
      el('div', { class: 'l3col' }, el('span', { class: 'l3cap' }, 'Release'), rel)),
    el('div', { class: 'l3ros' }, ...ro, roAt),
    el('div', { class: 'l3box2' },
      el('div', {}, el('span', { class: 'l3cap' }, 'Release Character'), l3select([['Default', 'Default'], ['ARC', 'ARC'], ['Fast', 'Fast'], ['Smooth', 'Smooth']], L.character, (v) => { L.character = v; ctx.change(); ctx.commit(); })),
      el('div', {}, el('span', { class: 'l3cap' }, 'Separation'), l3select([['Low', 'Low'], ['Medium', 'Medium'], ['High', 'High']], L.separation, (v) => { L.separation = v; ctx.commit(); }))),
    el('div', { class: 'l3bottom' },
      el('div', { class: 'l3box2 v' },
        el('span', { class: 'l3cap' }, 'Quantize'), l3select([[24, '24 Bits'], [16, '16 Bits']], L.quantize, (v) => { L.quantize = +v; ctx.commit(); }),
        el('span', { class: 'l3cap' }, 'Dither'), l3select([['Type1', 'Type1'], ['Type2', 'Type2'], ['None', 'None']], L.dither, (v) => { L.dither = v; ctx.commit(); }),
        el('span', { class: 'l3cap' }, 'Shaping'), l3select([['Normal', 'Normal'], ['Moderate', 'Moderate'], ['None', 'None']], L.shaping, (v) => { L.shaping = v; ctx.commit(); })),
      el('div', { class: 'l3logo' },
        el('button', { class: 'l3idr' + (L.idr ? ' on' : ''), onclick: (e) => { L.idr = !L.idr; e.currentTarget.classList.toggle('on', L.idr); ctx.commit(); } }, 'IDR'),
        el('div', { class: 'l3brand' }, el('b', {}, 'MULTI'), el('small', {}, 'MAXIMIZER · 6 BAND')))));
  // band display
  const disp = el('canvas', { class: 'l3disp' });
  const cols = el('div', { class: 'l3bands' }, el('div', { class: 'l3lab' }, el('span', {}, 'Priority'), el('span', {}, 'Gain'), el('span', {}, 'Freq'), el('span', {}, 'Q')));
  const FL = 16, FH = 20000, fx = (f, w) => Math.log(f / FL) / Math.log(FH / FL) * w, xf = (x, w) => FL * Math.pow(FH / FL, x / w);
  let resp = null; const recalc = () => { resp = null; };
  L.bands.forEach((b, i) => {
    const box = (key, min, max, step, fmt, log, acc) => el('div', { class: 'l3num', style: acc ? `--acc:${acc}` : '' }, dragNum({ value: b[key], min, max, step, log, fmt, onInput: (v) => { b[key] = v; recalc(); ctx.change(); drawDisp(); }, onChange: ctx.commit }));
    const shape = el('div', { class: 'l3shape' }, ...['lowshelf', 'peaking', 'highshelf'].map((t) => el('button', { class: b.type === t ? 'on' : '', html: SHAPE_ICON[t], title: t, onclick: (e) => { b.type = t; [...e.currentTarget.parentElement.children].forEach((x) => x.classList.toggle('on', x === e.currentTarget)); recalc(); ctx.change(); ctx.commit(); drawDisp(); } })));
    const led = el('button', { class: 'l3led' + (b.on !== false ? ' on' : ''), 'aria-label': 'Вкл/выкл полосу', onclick: (e) => { b.on = b.on === false; e.currentTarget.classList.toggle('on', b.on !== false); recalc(); ctx.change(); ctx.commit(); drawDisp(); } });
    cols.append(el('div', { class: 'l3band', style: `--bc:${L3_COLORS[i]}` },
      box('prio', -12, 12, 0.1, (v) => v.toFixed(1), false, '#E8D22B'),
      box('gain', -12, 12, 0.1, (v) => v.toFixed(1), false, '#3F7CF0'),
      box('f', 20, 20000, 1, (v) => Math.round(v), true),
      box('q', 0.1, 8, 0.01, (v) => v.toFixed(2), true),
      shape, led));
  });
  const right = el('div', { class: 'l3right' }, el('div', { class: 'l3bezel' }, disp), cols);
  const root = el('div', { class: 'pl pl-l3' },
    el('div', { class: 'plhead l3top' }, powerBtn(L, ctx), el('b', {}, 'Multimaximizer'), el('span', { class: 'dim' }, 'Threshold −7, Out Ceiling −1, Release 1.00 · экспорт подбирает Threshold под целевой RMS')),
    el('div', { class: 'l3main' }, left, right),
    el('div', { class: 'l3exp' },
      el('label', { class: 'tog' }, (() => { const c = el('input', { type: 'checkbox', checked: M.autoRms }); c.addEventListener('change', () => { M.autoRms = c.checked; ctx.commit(); }); return c; })(), el('span', {}, 'При экспорте подгонять RMS к')),
      dragNum({ value: M.targetRms, min: -18, max: -6, step: 0.1, fmt: (v) => v.toFixed(1) + ' dB', onInput: (v) => { M.targetRms = v; }, onChange: ctx.commit }),
      el('label', { class: 'tog' }, (() => { const c = el('input', { type: 'checkbox', checked: M.fades }); c.addEventListener('change', () => { M.fades = c.checked; ctx.commit(); }); return c; })(), el('span', {}, 'Фейды 50 мс')),
      el('span', { class: 'dim' }, 'Gain полос поднимает или опускает частоты перед лимитером. Priority пока только сохраняется, на звук не влияет.')));
  let drag = null;
  const yOf = (db, h) => h / 2 - db / 18 * (h / 2 - 24);
  function drawDisp() {
    const [x, w, h] = canvas2d(disp);
    const g = x.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#2A2A2C'); g.addColorStop(0.35, '#121214'); g.addColorStop(1, '#0B0B0C');
    x.fillStyle = g; x.fillRect(0, 0, w, h);
    x.font = '11px ui-monospace, Menlo, monospace'; x.fillStyle = '#B9B9B9';
    for (const d of [15, 12, 9, 6, 3, 0, -3, -6, -9, -12, -15, -18]) { const y = yOf(d, h); x.fillStyle = 'rgba(255,255,255,.05)'; x.fillRect(30, Math.round(y), w - 34, 1); x.fillStyle = '#B9B9B9'; x.fillText(String(Math.abs(d)), 6, y + 4); }
    for (const f of [16, 31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]) { const px = 30 + fx(f, w - 34); x.fillStyle = 'rgba(255,255,255,.05)'; x.fillRect(Math.round(px), 10, 1, h - 30); x.fillStyle = '#B9B9B9'; x.fillText(f >= 1000 ? f / 1000 + 'k' : String(f), px - 8, h - 6); }
    const N = 240;
    if (!resp) { const fr = new Float32Array(N); for (let i = 0; i < N; i++) fr[i] = xf(i / (N - 1) * (w - 34), w - 34); resp = eqResponse(L.bands.map((b) => ({ ...b, g: b.gain, on: b.on !== false })), fr); resp.p = eqResponse(L.bands.map((b) => ({ ...b, g: b.prio, on: b.on !== false })), fr); }
    for (const [arr, col] of [[resp.p.tot, 'rgba(232,210,43,.7)'], [resp.tot, '#3F6BFF']]) { x.strokeStyle = col; x.lineWidth = 1.6; x.beginPath(); for (let i = 0; i < N; i++) { const px = 30 + i / (N - 1) * (w - 34), py = yOf(clamp(arr[i], -18, 18), h); i ? x.lineTo(px, py) : x.moveTo(px, py); } x.stroke(); }
    L.bands.forEach((b, i) => {
      const px = 30 + fx(b.f, w - 34), py = yOf(b.gain, h);
      x.save(); x.translate(px, py); x.rotate(Math.PI / 4); x.strokeStyle = L3_COLORS[i]; x.lineWidth = 2; x.fillStyle = b.on === false ? '#222' : 'rgba(0,0,0,.6)'; x.fillRect(-5, -5, 10, 10); x.strokeRect(-5, -5, 10, 10); x.restore();
    });
    x.lineWidth = 1;
  }
  disp.addEventListener('pointerdown', (e) => {
    const r = disp.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    let best = -1, bd = isTouch ? 26 : 14;
    L.bands.forEach((b, i) => { const d = Math.hypot(30 + fx(b.f, r.width - 34) - px, yOf(b.gain, r.height) - py); if (d < bd) { bd = d; best = i; } });
    if (best < 0) return; drag = { i: best, w: r.width, h: r.height }; disp.setPointerCapture(e.pointerId);
  });
  disp.addEventListener('pointermove', (e) => {
    if (!drag) return; const r = disp.getBoundingClientRect(), b = L.bands[drag.i];
    b.f = Math.round(clamp(xf(clamp(e.clientX - r.left - 30, 0, drag.w - 34), drag.w - 34), 20, 20000));
    b.gain = Math.round(clamp((drag.h / 2 - (e.clientY - r.top)) / (drag.h / 2 - 24) * 18, -12, 12) * 10) / 10;
    recalc(); ctx.change(); drawDisp();
  });
  disp.addEventListener('pointerup', () => { if (drag) { drag = null; ctx.commit(); openFx(ctx.target, ctx.key); } });
  requestAnimationFrame(drawDisp);
  const hold = [-120, -120, -120, -120];
  const bar = (c, v01, color, fromTop) => { const [x, w, h] = canvas2d(c); x.fillStyle = '#050505'; x.fillRect(0, 0, w, h); x.fillStyle = color; const k = clamp(v01, 0, 1) * h; fromTop ? x.fillRect(1, 0, w - 2, k) : x.fillRect(1, h - k, w - 2, k); };
  let gr = 0;
  return { el: root, tick: () => {
    const g = S.playing ? Meter.limGr() : 0; gr += (g - gr) * 0.4;
    const pl = S.playing ? linToDb(Meter.pkL) : -120, pr = S.playing ? linToDb(Meter.pkR) : -120;
    const il = pl + gr + L.thresh, ir = pr + gr + L.thresh; // level before the threshold gain
    const sc = (d) => (d + 30) / 30;
    bar(inL, sc(il), '#4FA3E8', false); bar(inR, sc(ir), '#4FA3E8', false);
    bar(outL, sc(pl), '#5ED16E', false); bar(outR, sc(pr), '#5ED16E', false);
    bar(at, gr / 30, '#E04A3A', true);
    [il, ir, pl, pr].forEach((d, i) => { hold[i] = Math.max(hold[i], d); ro[i].textContent = hold[i] < -99 ? '-Inf' : hold[i].toFixed(1); });
    roAt.textContent = gr.toFixed(1);
    if (!S.playing) hold.fill(-120);
  } };
};

/* ---- Audio statistics ---- */
FXUI.stats = (obj, ctx) => {
  const v = {}; const row = (k, label) => el('div', { class: 'strow' }, el('span', {}, label), v[k] = el('b', { class: 'mono' }, '—'));
  const root = el('div', { class: 'pl pl-st' },
    el('div', { class: 'plhead' }, el('b', {}, 'Audio Statistics'), el('span', { class: 'dim' }, 'выход мастера во время воспроизведения')),
    el('div', { class: 'stgrid' }, row('rms', 'RMS, последние 3 с'), row('rmsi', 'RMS с начала воспроизведения'), row('pk', 'Пиковый уровень'), row('gr', 'Ограничение лимитера')),
    el('p', { class: 'note' }, 'Точные значения по каждому региону (RMS, L/R, peak, true peak, LUFS) — в «Экспорт → Только статистика».'),
    el('div', { class: 'btns' }, el('button', { class: 'btn primary', onclick: () => { closeModal(); openExport(); } }, 'Статистика по регионам')));
  return { el: root, tick: () => { v.rms.textContent = S.playing ? fmtDb(Meter.rmsShort(), 2) + ' dB' : '—'; v.rmsi.textContent = S.playing ? fmtDb(Meter.rmsInt(), 2) + ' dB' : '—'; v.pk.textContent = S.playing && Meter.maxPk > -99 ? fmtDb(Meter.maxPk, 2) + ' dB' : '—'; v.gr.textContent = S.playing ? '−' + Meter.limGr().toFixed(1) + ' dB' : '—'; } };
};
