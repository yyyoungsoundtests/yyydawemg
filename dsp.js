// ===== Эфир: AudioWorklet processors =====
// Fixed latencies (samples), mirrored in app.js: DECLICK 64, DEESS 720, DUCKER 1024, LIMITER 69.
const dbLin = (d) => Math.pow(10, d / 20);
const linDb = (l) => 20 * Math.log10(Math.max(l, 1e-9));
const tc = (ms) => 1 - Math.exp(-1 / (Math.max(0.01, ms) / 1000 * sampleRate));
function knee(over, ratio, w) {
  const k = 1 - 1 / ratio;
  if (over <= -w / 2) return 0;
  if (over >= w / 2) return over * k;
  const x = over + w / 2; return k * x * x / (2 * w);
}
class BQ {
  constructor() { this.b0 = 1; this.b1 = this.b2 = this.a1 = this.a2 = 0; this.z1 = this.z2 = 0; }
  set(type, f, q = 0.7071) {
    const w = 2 * Math.PI * Math.min(Math.max(f, 10), sampleRate * 0.45) / sampleRate, cs = Math.cos(w), sn = Math.sin(w), al = sn / (2 * q);
    let b0, b1, b2; const a0 = 1 + al, a1 = -2 * cs, a2 = 1 - al;
    if (type === 'lp') { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0; }
    else { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
    return this;
  }
  run(x) { const y = this.b0 * x + this.z1; this.z1 = this.b1 * x - this.a1 * y + this.z2; this.z2 = this.b2 * x - this.a2 * y; return y; }
}
// 2nd-order allpass with Q=0.7071 — same phase as an LR4 crossover sum (cheap phase compensation)
class AP2 {
  constructor() { this.b0 = 1; this.b1 = this.a1 = 0; this.z1 = this.z2 = 0; }
  set(f, q = 0.7071) {
    const w = 2 * Math.PI * Math.min(Math.max(f, 10), sampleRate * 0.45) / sampleRate, cs = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
    this.b0 = (1 - al) / a0; this.b1 = -2 * cs / a0; this.b2 = 1; this.a1 = -2 * cs / a0; this.a2 = (1 - al) / a0;
    return this;
  }
  run(x) { const y = this.b0 * x + this.z1; this.z1 = this.b1 * x - this.a1 * y + this.z2; this.z2 = this.b2 * x - this.a2 * y; return y; }
}
// Linkwitz-Riley 4th order split; lo+hi is an allpass
class LR4 {
  constructor() { this.l1 = new BQ(); this.l2 = new BQ(); this.h1 = new BQ(); this.h2 = new BQ(); }
  set(f) { this.l1.set('lp', f); this.l2.set('lp', f); this.h1.set('hp', f); this.h2.set('hp', f); }
  split(x) { this.lo = this.l2.run(this.l1.run(x)); this.hi = this.h2.run(this.h1.run(x)); }
  ap(x) { this.split(x); return this.lo + this.hi; }
}

function makeFFT(n) {
  const rev = new Uint32Array(n), cos = new Float32Array(n / 2), sin = new Float32Array(n / 2);
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) { let r = 0, x = i; for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; } rev[i] = r; }
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = Math.sin(2 * Math.PI * i / n); }
  return function fft(re, im, inverse) {
    for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    const sg = inverse ? -1 : 1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half, c = cos[k], s = sg * sin[k];
          const a = re[l], b = im[l];
          const tr = a * c + b * s, ti = b * c - a * s;
          re[l] = re[j] - tr; im[l] = im[j] - ti; re[j] += tr; im[j] += ti;
        }
      }
    }
    if (inverse) { const k = 1 / n; for (let i = 0; i < n; i++) { re[i] *= k; im[i] *= k; } }
  };
}

// Music ducker: input 0 = music (stereo), input 1 = voice sidechain.
// Mid is processed in the frequency domain, Side passes untouched. Latency = N samples.
class EfirDucker extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const N = this.N = 1024, H = this.H = 256;
    this.fft = makeFFT(N);
    this.win = new Float32Array(N);
    for (let i = 0; i < N; i++) this.win[i] = Math.sqrt(0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
    this.inM = new Float32Array(N); this.inV = new Float32Array(N);
    this.stM = new Float32Array(H); this.stV = new Float32Array(H);
    this.side = new Float32Array(N); this.ri = 0;
    this.acc = new Float32Array(N); this.outQ = new Float32Array(H); this.pos = 0;
    this.re = new Float32Array(N); this.im = new Float32Array(N);
    this.mRe = new Float32Array(N / 2 + 1); this.mIm = new Float32Array(N / 2 + 1);
    this.pm = new Float32Array(N / 2 + 1); this.pv = new Float32Array(N / 2 + 1);
    this.p = Object.assign({ on: true, depth: 8, sens: 6, attack: 10, release: 150, lo: 150, hi: 8000, gate: -50 }, options && options.processorOptions && options.processorOptions.p);
    // bands: log spaced 30 Hz .. nyquist
    const nb = 28, edges = [];
    for (let i = 0; i <= nb; i++) edges.push(30 * Math.pow((sampleRate / 2) / 30, i / nb));
    const bins = [];
    for (const f of edges) bins.push(Math.min(N / 2 + 1, Math.max(1, Math.round(f * N / sampleRate))));
    this.bLo = []; this.bHi = []; this.bF = [];
    for (let i = 0; i < nb; i++) {
      const a = i === 0 ? 0 : bins[i], b = i === nb - 1 ? N / 2 + 1 : bins[i + 1];
      if (b > a) { this.bLo.push(a); this.bHi.push(b); this.bF.push(Math.sqrt(edges[i] * edges[i + 1])); }
    }
    this.nb = this.bLo.length;
    this.cur = new Float32Array(this.nb); this.red = new Float32Array(this.nb);
    // per-bin interpolation between band centres
    this.bin0 = new Int32Array(N / 2 + 1); this.binT = new Float32Array(N / 2 + 1);
    const cen = []; for (let b = 0; b < this.nb; b++) cen.push((this.bLo[b] + this.bHi[b] - 1) / 2);
    for (let k = 0; k <= N / 2; k++) {
      let b = 0; while (b < this.nb - 1 && cen[b + 1] <= k) b++;
      if (b === this.nb - 1 || k <= cen[0]) { this.bin0[k] = k <= cen[0] ? 0 : b; this.binT[k] = 0; }
      else { this.bin0[k] = b; this.binT[k] = (k - cen[b]) / (cen[b + 1] - cen[b]); }
    }
    this.frames = 0;
    this.coefs();
    this.port.onmessage = (e) => { Object.assign(this.p, e.data); this.coefs(); };
  }
  coefs() {
    const fr = sampleRate / this.H;
    this.aA = Math.exp(-1 / (Math.max(1, this.p.attack) / 1000 * fr));
    this.aR = Math.exp(-1 / (Math.max(5, this.p.release) / 1000 * fr));
  }
  frame() {
    const N = this.N, H = this.H, p = this.p;
    this.inM.copyWithin(0, H); this.inM.set(this.stM, N - H);
    this.inV.copyWithin(0, H); this.inV.set(this.stV, N - H);
    const re = this.re, im = this.im, w = this.win;
    let ve = 0;
    for (let i = 0; i < N; i++) { re[i] = this.inM[i] * w[i]; im[i] = this.inV[i] * w[i]; ve += this.inV[i] * this.inV[i]; }
    this.fft(re, im, false);
    const half = N / 2;
    for (let k = 0; k <= half; k++) {
      const n = (N - k) % N, a = re[k], b = im[k], c = re[n], d = im[n];
      const mr = (a + c) * 0.5, mi = (b - d) * 0.5, vr = (b + d) * 0.5, vi = (c - a) * 0.5;
      this.mRe[k] = mr; this.mIm[k] = mi; this.pm[k] = mr * mr + mi * mi; this.pv[k] = vr * vr + vi * vi;
    }
    const vDb = 10 * Math.log10(ve / N + 1e-20);
    const presence = Math.min(1, Math.max(0, (vDb - p.gate) / 10));
    const nb = this.nb, red = this.red;
    let meanV = 0, cnt = 0;
    const mb = new Float32Array(nb), vb = new Float32Array(nb);
    for (let b = 0; b < nb; b++) {
      let em = 0, ev = 0;
      for (let k = this.bLo[b]; k < this.bHi[b]; k++) { em += this.pm[k]; ev += this.pv[k]; }
      mb[b] = 10 * Math.log10(em + 1e-20); vb[b] = 10 * Math.log10(ev + 1e-20);
      if (this.bF[b] >= p.lo && this.bF[b] <= p.hi) { meanV += vb[b]; cnt++; }
    }
    meanV = cnt ? meanV / cnt : -200;
    let maxR = 0;
    for (let b = 0; b < nb; b++) {
      let r = 0;
      if (p.on && presence > 0 && this.bF[b] >= p.lo && this.bF[b] <= p.hi) {
        const drive = Math.min(1, Math.max(0, (vb[b] - meanV + 12) / 18));
        const comp = Math.min(1, Math.max(0, (mb[b] - vb[b] + p.sens + 6) / 12));
        r = p.depth * drive * comp * presence;
      }
      const c = this.cur[b];
      this.cur[b] = r > c ? r + (c - r) * this.aA : r + (c - r) * this.aR;
      red[b] = this.cur[b];
      if (red[b] > maxR) maxR = red[b];
    }
    for (let k = 0; k <= half; k++) {
      const b0 = this.bin0[k], t = this.binT[k];
      const r = t > 0 ? red[b0] * (1 - t) + red[b0 + 1] * t : red[b0];
      const g = r > 0.001 ? Math.pow(10, -r / 20) : 1;
      re[k] = this.mRe[k] * g; im[k] = this.mIm[k] * g;
    }
    im[0] = 0; im[half] = 0;
    for (let k = 1; k < half; k++) { re[N - k] = re[k]; im[N - k] = -im[k]; }
    this.fft(re, im, true);
    const acc = this.acc;
    for (let i = 0; i < N; i++) acc[i] += re[i] * w[i] * 0.5;
    this.outQ.set(acc.subarray(0, H));
    acc.copyWithin(0, H); acc.fill(0, N - H);
    if (++this.frames % 8 === 0) this.port.postMessage({ gr: maxR, bands: Array.from(red), freqs: this.bF });
  }
  process(inputs, outputs) {
    if (this.p.dead) return false;
    const mi = inputs[0] || [], vi = inputs[1] || [], out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    const ml = mi[0], mr = mi[1] || mi[0], vl = vi[0], vr = vi[1] || vi[0];
    const H = this.H, N = this.N;
    for (let i = 0; i < L.length; i++) {
      const l = ml ? ml[i] : 0, r = mr ? mr[i] : 0;
      const v = vl ? (vl[i] + vr[i]) * 0.5 : 0;
      this.stM[this.pos] = (l + r) * 0.5; this.stV[this.pos] = v;
      const sd = this.side[this.ri]; this.side[this.ri] = (l - r) * 0.5; this.ri = (this.ri + 1) % N;
      const m = this.outQ[this.pos];
      L[i] = m + sd; if (R !== L) R[i] = m - sd;
      if (++this.pos === H) { this.pos = 0; this.frame(); }
    }
    return true;
  }
}
registerProcessor('efir-ducker', EfirDucker);

// Brickwall limiter with inter-sample peak estimation.
// Gain = moving average of (min-hold of required gain, with release), so it is
// guaranteed to be at or below the required gain when the peak leaves the delay line.
class EfirLimiter extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.LA = 64; this.SZ = 256; this.D = this.LA + 5;
    // 4x oversampling taps (windowed sinc, 12 taps per phase) for inter-sample peaks
    this.taps = [];
    for (let ph = 1; ph < 4; ph++) {
      const f = new Float32Array(12), frac = ph / 4;
      for (let k = 0; k < 12; k++) { const x = (k - 5) - frac, w = 0.5 + 0.5 * Math.cos(Math.PI * x / 7); f[k] = (Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)) * w; }
      this.taps.push(f);
    }
    this.dl = [new Float32Array(this.SZ), new Float32Array(this.SZ)]; this.wi = 0;
    this.h = [new Float32Array(12), new Float32Array(12)];
    this.qv = new Float32Array(this.SZ); this.qi = new Float64Array(this.SZ); this.qh = 0; this.qt = 0; this.n = 0;
    this.ring = new Float32Array(this.LA).fill(1); this.rp = 0; this.sum = this.LA;
    this.e = 1; this.minEnv = 1; this.cntr = 0;
    this.p = Object.assign({ on: true, gain: 0, ceiling: -1, release: 80, arc: true }, options && options.processorOptions && options.processorOptions.p);
    this.slow = 0;
    // multiband stage state: 5 LR4 splits + allpass phase compensation per channel
    this.mbCh = [0, 1].map(() => ({ sp: [0, 1, 2, 3, 4].map(() => new LR4()), ap: [0, 1, 2, 3, 4].map(() => [0, 1, 2, 3, 4].map(() => new AP2())) }));
    this.bgr = new Float32Array(6); this.bmx = new Float32Array(6); this.bo = [0, 1, 2, 3, 4, 5];
    this.coefs();
    this.port.onmessage = (e) => { Object.assign(this.p, e.data); this.coefs(); };
  }
  coefs() {
    const bands = this.p.bands;
    if (bands && bands.length === 6) {
      // order bands by frequency; crossovers at geometric midpoints
      this.bo = [0, 1, 2, 3, 4, 5].sort((a, b) => bands[a].f - bands[b].f);
      this.xo = [0, 1, 2, 3, 4].map((i) => Math.sqrt(bands[this.bo[i]].f * bands[this.bo[i + 1]].f));
      for (const ch of this.mbCh) { ch.sp.forEach((x, i) => x.set(this.xo[i])); ch.ap.forEach((row) => row.forEach((x, i) => x.set(this.xo[i]))); }
      const sep = { Low: 1, Medium: -2, High: -4 }[this.p.separation] ?? -2;
      this.bthr = this.bo.map((k) => this.p.ceiling + sep + (bands[k].prio || 0));
      this.bg = this.bo.map((k) => (bands[k].on === false ? 1 : Math.pow(10, (bands[k].gain || 0) / 20)));
      this.bA = tc(0.4); this.bR = tc(Math.max(20, this.p.release * 1.2));
      this.mbOn = true;
    } else this.mbOn = false;
    this.g = Math.pow(10, this.p.gain / 20);
    this.ceil = Math.pow(10, this.p.ceiling / 20);
    this.ceilIn = this.ceil * Math.pow(10, -0.1 / 20);
    this.rel = 1 - Math.exp(-1 / (Math.max(5, this.p.release) / 1000 * sampleRate));
  }
  process(inputs, outputs) {
    if (this.p.dead) return false;
    const inp = inputs[0] || [], out = outputs[0];
    const iL = inp[0], iR = inp[1] || inp[0];
    const oL = out[0], oR = out[1] || out[0];
    const SZ = this.SZ, LA = this.LA, ceil = this.ceil, ci = this.ceilIn;
    if (this.p.arc) {
      // Auto release: longer release when the limiter has been working for a while (less pumping)
      const grNow = -20 * Math.log10(Math.max(1e-6, this.e));
      this.slow += (grNow - this.slow) * 0.02;
      const ms = Math.max(5, this.p.release) * (0.8 + Math.min(1.2, this.slow / 10));
      this.rel = 1 - Math.exp(-1 / (ms / 1000 * sampleRate));
    }
    for (let i = 0; i < oL.length; i++) {
      if (this.p.on === false) {
        this.dl[0][this.wi] = iL ? iL[i] : 0; this.dl[1][this.wi] = iR ? iR[i] : 0;
        const ri = (this.wi - this.D + SZ) % SZ;
        oL[i] = this.dl[0][ri]; if (oR !== oL) oR[i] = this.dl[1][ri];
        this.wi = (this.wi + 1) % SZ; continue;
      }
      let x0 = iL ? iL[i] * this.g : 0, x1 = iR ? iR[i] * this.g : 0;
      if (this.mbOn) {
        // split both channels into 6 bands, limit each band on its own (priority raises its threshold), sum back
        const B0 = this._b0 || (this._b0 = new Float32Array(6)), B1 = this._b1 || (this._b1 = new Float32Array(6));
        for (let c = 0; c < 2; c++) {
          const st = this.mbCh[c], dst = c ? B1 : B0; let rest = c ? x1 : x0;
          for (let k = 0; k < 5; k++) {
            st.sp[k].split(rest); dst[k] = st.sp[k].lo; rest = st.sp[k].hi;
            for (let j = 0; j < k; j++) dst[j] = st.ap[j][k].run(dst[j]);
          }
          dst[5] = rest;
        }
        x0 = 0; x1 = 0;
        for (let k = 0; k < 6; k++) {
          const a0 = B0[k] * this.bg[k], a1 = B1[k] * this.bg[k];
          const lv = 20 * Math.log10(Math.max(Math.abs(a0), Math.abs(a1), 1e-9));
          const t = Math.max(0, lv - this.bthr[k]);
          this.bgr[k] += (t - this.bgr[k]) * (t > this.bgr[k] ? this.bA : this.bR);
          if (this.bgr[k] > this.bmx[k]) this.bmx[k] = this.bgr[k];
          const gg = Math.pow(10, -this.bgr[k] / 20);
          x0 += a0 * gg; x1 += a1 * gg;
        }
      }
      this.dl[0][this.wi] = x0; this.dl[1][this.wi] = x1;
      let pk = 0;
      for (let c = 0; c < 2; c++) {
        const h = this.h[c]; h.copyWithin(0, 1); h[11] = c ? x1 : x0;
        let m = Math.abs(h[5]);
        for (let q = 0; q < 3; q++) {
          const f = this.taps[q]; let v = 0;
          for (let k = 0; k < 12; k++) v += h[k] * f[k];
          v = Math.abs(v); if (v > m) m = v;
        }
        if (m > pk) pk = m;
      }
      const req = pk > ci ? ci / pk : 1;
      const n = this.n++;
      while (this.qt > this.qh && this.qv[(this.qt - 1) % SZ] >= req) this.qt--;
      this.qv[this.qt % SZ] = req; this.qi[this.qt % SZ] = n; this.qt++;
      while (this.qi[this.qh % SZ] <= n - LA) this.qh++;
      const hold = this.qv[this.qh % SZ];
      this.e = hold < this.e ? hold : this.e + (hold - this.e) * this.rel;
      this.sum += this.e - this.ring[this.rp]; this.ring[this.rp] = this.e; this.rp = (this.rp + 1) % LA;
      const env = Math.min(1, this.sum / LA);
      const ri = (this.wi - this.D + SZ) % SZ;
      let y0 = this.dl[0][ri] * env, y1 = this.dl[1][ri] * env;
      if (y0 > ceil) y0 = ceil; else if (y0 < -ceil) y0 = -ceil;
      if (y1 > ceil) y1 = ceil; else if (y1 < -ceil) y1 = -ceil;
      oL[i] = y0; if (oR !== oL) oR[i] = y1;
      this.wi = (this.wi + 1) % SZ;
      if (env < this.minEnv) this.minEnv = env;
    }
    if (++this.cntr % 16 === 0) {
      const bands = new Array(6); for (let k = 0; k < 6; k++) bands[this.bo[k]] = this.bmx[k];
      this.port.postMessage({ gr: -20 * Math.log10(this.minEnv), bands }); this.minEnv = 1; this.bmx.fill(0);
    }
    return true;
  }
}
registerProcessor('efir-limiter', EfirLimiter);

// ---------- De-crackle (light click repair). Latency 64 ----------
class EfirDeclick extends AudioWorkletProcessor {
  constructor(o) {
    super();
    this.p = Object.assign({ on: true, amount: 3, quality: 1, only: false }, o && o.processorOptions && o.processorOptions.p);
    this.SZ = 256; this.L = 64;
    this.buf = [new Float32Array(256), new Float32Array(256)]; this.org = [new Float32Array(256), new Float32Array(256)];
    this.lev = [0.001, 0.001]; this.w = 0; this.clicks = 0; this.cnt = 0;
    this.port.onmessage = (e) => Object.assign(this.p, e.data);
  }
  process(inputs, outputs) {
    if (this.p.dead) return false;
    const inp = inputs[0] || [], out = outputs[0], SZ = this.SZ, M = SZ - 1, p = this.p;
    const k = 16 - Math.min(10, Math.max(0, p.amount)), hw = [0, 1, 2][p.quality | 0] ?? 1;
    for (let i = 0; i < out[0].length; i++) {
      const w = this.w;
      for (let c = 0; c < 2; c++) {
        const ch = inp[c] || inp[0], x = ch ? ch[i] : 0, b = this.buf[c];
        b[w] = x; this.org[c][w] = x;
        if (p.on) {
          const q = (w - 8) & M;
          const ed = (j) => Math.abs(b[j & M] - 0.5 * (b[(j - 1) & M] + b[(j + 1) & M]));
          const e = ed(q), side = Math.max(ed(q - 3), ed(q + 3));
          if (e > k * this.lev[c] + 0.004 && e > 3 * side) {
            const a = (q - hw - 1) & M, z = (q + hw + 1) & M, n = 2 * hw + 2;
            for (let j = 1; j < n; j++) b[(a + j) & M] = b[a] + (b[z] - b[a]) * j / n;
            this.clicks++;
          } else this.lev[c] += (e - this.lev[c]) * 0.003;
        }
        const r = (w - this.L) & M;
        const o = out[c] || out[0];
        o[i] = p.on && p.only ? this.org[c][r] - b[r] : b[r];
      }
      this.w = (w + 1) & M;
    }
    if (++this.cnt % 94 === 0) { this.port.postMessage({ cps: this.clicks / 2 }); this.clicks = 0; }
    return true;
  }
}
registerProcessor('efir-declick', EfirDeclick);

// ---------- Vocal leveler (gate + one-knob compressor + safety limiter). No latency ----------
class EfirVox extends AudioWorkletProcessor {
  constructor(o) {
    super();
    this.p = Object.assign({ on: true, gate: -80, comp: -12, gain: 0 }, o && o.processorOptions && o.processorOptions.p);
    this.pw = 0; this.gr = 0; this.gg = 0; this.hold = 0; this.cnt = 0; this.mx = 0; this.out = 0;
    this.a10 = tc(10); this.aA = tc(5); this.aR = tc(160); this.gA = tc(2); this.gR = tc(150);
    this.port.onmessage = (e) => Object.assign(this.p, e.data);
  }
  process(inputs, outputs) {
    if (this.p.dead) return false;
    const inp = inputs[0] || [], out = outputs[0], p = this.p;
    const iL = inp[0], iR = inp[1] || inp[0], oL = out[0], oR = out[1] || out[0];
    // the Comp fader works like a one-knob leveller: threshold sits 8 dB under it, make-up follows automatically
    const thr = p.comp - 8, make = -thr * 0.38, og = dbLin(p.gain);
    for (let i = 0; i < oL.length; i++) {
      let l = iL ? iL[i] : 0, r = iR ? iR[i] : 0;
      if (p.on) {
        const m = 0.5 * (l * l + r * r);
        this.pw += (m - this.pw) * this.a10;
        const lvl = 10 * Math.log10(this.pw + 1e-12);
        // gate (downward expander, 30 dB range, 60 ms hold)
        let gt = 0;
        if (p.gate > -79) {
          if (lvl > p.gate) this.hold = 0.06 * sampleRate; else if (this.hold > 0) this.hold--;
          gt = this.hold > 0 ? 0 : 30;
        }
        this.gg += (gt - this.gg) * (gt < this.gg ? this.gA : this.gR);
        const t = knee(lvl - thr, 4, 8);
        this.gr += (t - this.gr) * (t > this.gr ? this.aA : this.aR);
        const g = dbLin(-this.gr - this.gg + make) * og;
        l *= g; r *= g;
        if (this.gr > this.mx) this.mx = this.gr;
        const a = Math.max(Math.abs(l), Math.abs(r)); if (a > this.out) this.out = a;
      }
      oL[i] = l; if (oR !== oL) oR[i] = r;
    }
    if (++this.cnt % 8 === 0) { this.port.postMessage({ gr: this.mx, gate: this.gg > 15, out: linDb(this.out) }); this.mx = 0; this.out = 0; }
    return true;
  }
}
registerProcessor('efir-vox', EfirVox);

// ---------- De-esser (wide/split band, allround/single vocal). Latency 720 ----------
class EfirDeess extends AudioWorkletProcessor {
  constructor(o) {
    super();
    this.p = Object.assign({ on: true, thr: -20, range: 6, f1: 5500, f2: 12000, mode: 'vocal', band: 'split', link: 1, look: 5 }, o && o.processorOptions && o.processorOptions.p);
    this.D = 720; this.SZ = 1024;
    this.ring = [new Float32Array(1024), new Float32Array(1024)]; this.w = 0;
    this.det = [[new BQ(), new BQ(), new BQ()], [new BQ(), new BQ(), new BQ()]];
    this.split = [new LR4(), new LR4()];
    this.pb = [0, 0]; this.pf = [0, 0]; this.gr = [0, 0];
    this.aP = tc(1); this.aA = tc(0.5); this.aR = tc(45);
    this.cnt = 0; this.mx = 0; this.lv = -120;
    this.coefs();
    this.port.onmessage = (e) => { Object.assign(this.p, e.data); this.coefs(); };
  }
  coefs() {
    const p = this.p;
    for (const d of this.det) { d[0].set('hp', p.f1); d[1].set('hp', p.f1); d[2].set('lp', Math.max(p.f2, p.f1 * 1.05)); }
    for (const s of this.split) s.set(p.f1);
    this.la = Math.round(Math.min(15, Math.max(0, p.look)) / 1000 * sampleRate);
    if (this.la > this.D) this.la = this.D;
  }
  process(inputs, outputs) {
    if (this.p.dead) return false;
    const inp = inputs[0] || [], out = outputs[0], p = this.p, M = this.SZ - 1, D = this.D;
    const iL = inp[0], iR = inp[1] || inp[0], oL = out[0], oR = out[1] || out[0];
    for (let i = 0; i < oL.length; i++) {
      const w = this.w;
      this.ring[0][w] = iL ? iL[i] : 0; this.ring[1][w] = iR ? iR[i] : 0;
      const dq = (w - (D - this.la)) & M, rq = (w - D) & M;
      const dl = this.ring[0][dq], dr = this.ring[1][dq], mid = 0.5 * (dl + dr);
      for (let c = 0; c < 2; c++) {
        const x = (c ? dr : dl) * (1 - p.link) + mid * p.link;
        const f = this.det[c], b = f[2].run(f[1].run(f[0].run(x)));
        this.pb[c] += (b * b - this.pb[c]) * this.aP;
        this.pf[c] += (x * x - this.pf[c]) * this.aP;
        const lvl = 10 * Math.log10(this.pb[c] + 1e-12);
        let over = lvl - p.thr;
        if (p.mode === 'vocal') {
          const rel = lvl - 10 * Math.log10(this.pf[c] + 1e-12);
          over *= Math.min(1, Math.max(0, (rel + 14) / 10));
        }
        const t = p.on ? Math.min(p.range, Math.max(0, over)) : 0;
        this.gr[c] += (t - this.gr[c]) * (t > this.gr[c] ? this.aA : this.aR);
        if (lvl > this.lv) this.lv = lvl;
      }
      let yl = this.ring[0][rq], yr = this.ring[1][rq];
      const gl = dbLin(-this.gr[0]), gr = dbLin(-this.gr[1]);
      if (p.band === 'split') {
        // LR4 split: lo + hi is flat, only the band above f1 is turned down
        const a = this.split[0], b = this.split[1];
        a.split(yl); b.split(yr);
        yl = a.lo + a.hi * gl; yr = b.lo + b.hi * gr;
      } else { yl *= gl; yr *= gr; }
      oL[i] = yl; if (oR !== oL) oR[i] = yr;
      const g = Math.max(this.gr[0], this.gr[1]); if (g > this.mx) this.mx = g;
      this.w = (w + 1) & M;
    }
    if (++this.cnt % 4 === 0) { this.port.postMessage({ gr: this.mx, lvl: this.lv }); this.mx = 0; this.lv = -120; }
    return true;
  }
}
registerProcessor('efir-deess', EfirDeess);

// ---------- 4-band dynamics (compressor + limiter per band), LR4 crossovers. No latency ----------
class EfirMB extends AudioWorkletProcessor {
  constructor(o) {
    super();
    this.p = Object.assign({ on: true, xo: [100, 580, 4500], bands: [] }, o && o.processorOptions && o.processorOptions.p);
    this.ch = [0, 1].map(() => ({ mid: new LR4(), lo: new LR4(), hi: new LR4(), apLo: new LR4(), apHi: new LR4() }));
    this.st = [0, 1, 2, 3].map(() => ({ gc: 0, gl: 0 }));
    this.mx = new Float32Array(4); this.lv = new Float32Array(4).fill(-120); this.cnt = 0;
    this.coefs();
    this.port.onmessage = (e) => { Object.assign(this.p, e.data); this.coefs(); };
  }
  coefs() {
    const [f1, f2, f3] = this.p.xo;
    for (const c of this.ch) { c.mid.set(f2); c.lo.set(f1); c.hi.set(f3); c.apLo.set(f3); c.apHi.set(f1); }
    this.k = this.p.bands.map((b) => ({ cA: tc(b.cAtt), cR: tc(b.cRel), lA: tc(b.lAtt), lR: tc(b.lRel), g: dbLin(b.gain || 0), mix: (b.mix ?? 100) / 100 }));
  }
  process(inputs, outputs) {
    if (this.p.dead) return false;
    const inp = inputs[0] || [], out = outputs[0], p = this.p;
    const iL = inp[0], iR = inp[1] || inp[0], oL = out[0], oR = out[1] || out[0];
    const B = p.bands, K = this.k;
    const bl = [0, 0, 0, 0], br = [0, 0, 0, 0];
    for (let i = 0; i < oL.length; i++) {
      const xl = iL ? iL[i] : 0, xr = iR ? iR[i] : 0;
      if (!p.on || B.length < 4) { oL[i] = xl; if (oR !== oL) oR[i] = xr; continue; }
      for (let c = 0; c < 2; c++) {
        const f = this.ch[c], dst = c ? br : bl;
        f.mid.split(c ? xr : xl);
        const lo = f.apLo.ap(f.mid.lo), hi = f.apHi.ap(f.mid.hi);
        f.lo.split(lo); f.hi.split(hi);
        dst[0] = f.lo.lo; dst[1] = f.lo.hi; dst[2] = f.hi.lo; dst[3] = f.hi.hi;
      }
      let yl = 0, yr = 0;
      for (let b = 0; b < 4; b++) {
        const s = this.st[b], cfg = B[b], kk = K[b];
        const a = Math.max(Math.abs(bl[b]), Math.abs(br[b])), lvl = linDb(a);
        if (lvl > this.lv[b]) this.lv[b] = lvl;
        let g = 1;
        if (cfg.on !== false) {
          const tcmp = knee(lvl - cfg.cThr, cfg.cRatio, 6);
          s.gc += (tcmp - s.gc) * (tcmp > s.gc ? kk.cA : kk.cR);
          const tl = knee(lvl - s.gc - cfg.lThr, cfg.lRatio, 2);
          s.gl += (tl - s.gl) * (tl > s.gl ? kk.lA : kk.lR);
          const gr = s.gc + s.gl; if (gr > this.mx[b]) this.mx[b] = gr;
          g = (1 - kk.mix) + kk.mix * dbLin(-gr) * kk.g;
        }
        yl += bl[b] * g; yr += br[b] * g;
      }
      oL[i] = yl; if (oR !== oL) oR[i] = yr;
    }
    if (++this.cnt % 8 === 0) { this.port.postMessage({ gr: Array.from(this.mx), lvl: Array.from(this.lv) }); this.mx.fill(0); this.lv.fill(-120); }
    return true;
  }
}
registerProcessor('efir-mb', EfirMB);

// ---------- Opto + discrete (VCA) mastering compressor with transformer colour. No latency ----------
class EfirSH extends AudioWorkletProcessor {
  constructor(o) {
    super();
    this.p = Object.assign({ on: true, oOn: true, oThr: -12, oGain: 0, dOn: true, dThr: -12, dRatio: 3, dAtt: 30, dRec: 0.1, dGain: 0, xf: 0, mix: 1 }, o && o.processorOptions && o.processorOptions.p);
    this.pw = 0; this.of = 0; this.os = 0; this.df = 0; this.ds = 0; this.dc = [0, 0, 0, 0];
    this.cnt = 0; this.mo = 0; this.md = 0;
    this.coefs();
    this.port.onmessage = (e) => { Object.assign(this.p, e.data); this.coefs(); };
  }
  coefs() {
    const p = this.p;
    this.aRms = tc(5); this.oA = tc(10); this.oR = tc(70); this.sA = tc(250); this.sR = tc(1800);
    this.dA = tc(p.dAtt); this.dual = p.dRec < 0;
    this.dR = tc(this.dual ? 100 : p.dRec * 1000); this.dsA = tc(300); this.dsR = tc(1200);
    this.og = dbLin(p.oGain); this.dg = dbLin(p.dGain);
    this.drive = [0.55, 0.9, 1.3][p.xf | 0] || 0.55; this.even = [0.01, 0.04, 0.07][p.xf | 0] || 0.01;
    this.dcA = tc(1000 / (2 * Math.PI * 12) );
  }
  sat(x, c) {
    const k = this.drive, y = Math.tanh(k * x) / k + this.even * x * x;
    this.dc[c] += (y - this.dc[c]) * 0.0016; // DC blocker (~12 Hz)
    return y - this.dc[c];
  }
  process(inputs, outputs) {
    if (this.p.dead) return false;
    const inp = inputs[0] || [], out = outputs[0], p = this.p;
    const iL = inp[0], iR = inp[1] || inp[0], oL = out[0], oR = out[1] || out[0];
    for (let i = 0; i < oL.length; i++) {
      const xl = iL ? iL[i] : 0, xr = iR ? iR[i] : 0;
      if (!p.on) { oL[i] = xl; if (oR !== oL) oR[i] = xr; continue; }
      let l = xl, r = xr;
      if (p.oOn) {
        this.pw += (0.5 * (l * l + r * r) - this.pw) * this.aRms;
        const t = knee(10 * Math.log10(this.pw + 1e-12) - p.oThr, 2.5, 10);
        this.of += (t - this.of) * (t > this.of ? this.oA : this.oR);
        this.os += (t - this.os) * (t > this.os ? this.sA : this.sR);
        const gr = Math.max(this.of, this.os); if (gr > this.mo) this.mo = gr;
        const g = dbLin(-gr) * this.og; l *= g; r *= g;
      }
      if (p.dOn) {
        const t = knee(linDb(Math.max(Math.abs(l), Math.abs(r))) - p.dThr, p.dRatio, 4);
        this.df += (t - this.df) * (t > this.df ? this.dA : this.dR);
        let gr = this.df;
        if (this.dual) { this.ds += (t - this.ds) * (t > this.ds ? this.dsA : this.dsR); gr = Math.max(this.df, this.ds); }
        if (gr > this.md) this.md = gr;
        const g = dbLin(-gr) * this.dg; l *= g; r *= g;
      }
      l = this.sat(l, 0); r = this.sat(r, 1);
      oL[i] = xl * (1 - p.mix) + l * p.mix; if (oR !== oL) oR[i] = xr * (1 - p.mix) + r * p.mix;
    }
    if (++this.cnt % 8 === 0) { this.port.postMessage({ o: this.mo, d: this.md }); this.mo = 0; this.md = 0; }
    return true;
  }
}
registerProcessor('efir-sh', EfirSH);

// ---------- Opto leveler in the style of a classic tube optical compressor. No latency ----------
// Peak Reduction drives the sidechain, Gain is output make-up, Compress ≈ 3:1, Limit ≈ 20:1.
// Optical cell: ~10 ms attack, two-stage release (fast ~60 ms, then slow 0.5–5 s depending on how long it worked).
class EfirLA2A extends AudioWorkletProcessor {
  constructor(o) {
    super();
    this.p = Object.assign({ on: true, peak: 40, gain: 50, limit: false }, o && o.processorOptions && o.processorOptions.p);
    this.pw = 0; this.fast = 0; this.slow = 0; this.hist = 0; this.cnt = 0; this.mx = 0; this.out = 0; this.hp = [0, 0];
    this.aRms = tc(4); this.aA = tc(10); this.aF = tc(60); this.sA = tc(400);
    this.port.onmessage = (e) => Object.assign(this.p, e.data);
  }
  process(inputs, outputs) {
    if (this.p.dead) return false;
    const inp = inputs[0] || [], out = outputs[0], p = this.p;
    const iL = inp[0], iR = inp[1] || inp[0], oL = out[0], oR = out[1] || out[0];
    const drive = p.peak * 0.42, ratio = p.limit ? 20 : 3, mk = dbLin((p.gain - 40) * 0.45);
    // release of the slow stage grows with how long the cell has been lit (memory effect)
    const sR = tc(500 + 4500 * Math.min(1, this.hist / 10));
    for (let i = 0; i < oL.length; i++) {
      let l = iL ? iL[i] : 0, r = iR ? iR[i] : 0;
      if (p.on) {
        // sidechain with gentle high-frequency emphasis
        const m = 0.5 * (l + r), hpv = m - this.hp[0]; this.hp[0] += hpv * 0.06;
        const sc = m + 0.6 * hpv;
        this.pw += (sc * sc - this.pw) * this.aRms;
        const lvl = 10 * Math.log10(this.pw + 1e-12) + drive - 18;
        const t = knee(lvl, ratio, 10);
        this.fast += (t - this.fast) * (t > this.fast ? this.aA : this.aF);
        this.slow += (t * 0.6 - this.slow) * (t * 0.6 > this.slow ? this.sA : sR);
        const gr = Math.max(this.fast, this.slow);
        if (gr > this.mx) this.mx = gr;
        const g = dbLin(-gr) * mk;
        l *= g; r *= g;
        const a = Math.max(Math.abs(l), Math.abs(r)); if (a > this.out) this.out = a;
      }
      oL[i] = l; if (oR !== oL) oR[i] = r;
    }
    this.hist += ((this.mx > 3 ? 1 : 0) * 10 - this.hist) * 0.002;
    if (++this.cnt % 8 === 0) { this.port.postMessage({ gr: this.mx, out: linDb(this.out) }); this.mx = 0; this.out = 0; }
    return true;
  }
}
registerProcessor('efir-la2a', EfirLA2A);

// ---------- Auto Balance: automatic tonal balancing EQ (recover / tame / bias / brighten / boost). Latency 1024 ----------
// Measures the spectrum in 28 log bands, compares its shape with a balanced-master target curve and slowly
// lifts what is missing (Recover) and pulls down what sticks out, incl. narrow resonances (Tame).
class EfirTonal extends AudioWorkletProcessor {
  constructor(o) {
    super();
    const N = this.N = 1024, H = this.H = 256;
    this.fft = makeFFT(N);
    this.win = new Float32Array(N);
    for (let i = 0; i < N; i++) this.win[i] = Math.sqrt(0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
    this.inL = new Float32Array(N); this.inR = new Float32Array(N);
    this.stL = new Float32Array(H); this.stR = new Float32Array(H);
    this.aL = new Float32Array(N); this.aR = new Float32Array(N);
    this.oL = new Float32Array(H); this.oR = new Float32Array(H); this.pos = 0;
    this.re = new Float32Array(N); this.im = new Float32Array(N);
    this.p = Object.assign({ on: true, recover: 30, tame: 40, bias: 0, brighten: 0, boost: 0 }, o && o.processorOptions && o.processorOptions.p);
    const nb = 28, edges = [];
    for (let i = 0; i <= nb; i++) edges.push(30 * Math.pow((sampleRate / 2) / 30, i / nb));
    this.bLo = []; this.bHi = []; this.bF = [];
    for (let i = 0; i < nb; i++) {
      const a = Math.max(1, Math.round(edges[i] * N / sampleRate)), b = Math.min(N / 2 + 1, Math.max(a + 1, Math.round(edges[i + 1] * N / sampleRate)));
      this.bLo.push(a); this.bHi.push(b); this.bF.push(Math.sqrt(edges[i] * edges[i + 1]));
    }
    this.nb = nb;
    this.slow = new Float32Array(nb).fill(-90); this.fast = new Float32Array(nb).fill(-90);
    this.corr = new Float32Array(nb); this.tgt = new Float32Array(nb);
    this.bin0 = new Int32Array(N / 2 + 1); this.binT = new Float32Array(N / 2 + 1);
    const cen = this.bLo.map((a, b) => (a + this.bHi[b] - 1) / 2);
    for (let k = 0; k <= N / 2; k++) {
      let b = 0; while (b < nb - 1 && cen[b + 1] <= k) b++;
      if (k <= cen[0]) { this.bin0[k] = 0; this.binT[k] = 0; }
      else if (b >= nb - 1) { this.bin0[k] = nb - 1; this.binT[k] = 0; }
      else { this.bin0[k] = b; this.binT[k] = (k - cen[b]) / (cen[b + 1] - cen[b]); }
    }
    const fr = sampleRate / H;
    this.aS = 1 - Math.exp(-1 / (0.9 * fr)); this.aF = 1 - Math.exp(-1 / (0.15 * fr)); this.aC = 1 - Math.exp(-1 / (0.35 * fr));
    this.frames = 0;
    this.port.onmessage = (e) => Object.assign(this.p, e.data);
  }
  frame() {
    const N = this.N, H = this.H, p = this.p, nb = this.nb, half = N / 2;
    this.inL.copyWithin(0, H); this.inL.set(this.stL, N - H);
    this.inR.copyWithin(0, H); this.inR.set(this.stR, N - H);
    const re = this.re, im = this.im, w = this.win;
    for (let i = 0; i < N; i++) { re[i] = this.inL[i] * w[i]; im[i] = this.inR[i] * w[i]; }
    this.fft(re, im, false);
    // band power of L and R from the packed spectrum
    let tot = 0; const lvl = this._lvl || (this._lvl = new Float32Array(nb));
    for (let b = 0; b < nb; b++) {
      let e = 0;
      for (let k = this.bLo[b]; k < this.bHi[b]; k++) {
        const n = (N - k) % N, a = re[k], bb = im[k], c = re[n], d = im[n];
        const lr = (a + c) * 0.5, li = (bb - d) * 0.5, rr = (bb + d) * 0.5, ri = (c - a) * 0.5;
        e += lr * lr + li * li + rr * rr + ri * ri;
      }
      tot += e; lvl[b] = 10 * Math.log10(e + 1e-20);
    }
    const active = 10 * Math.log10(tot / N + 1e-20) > -62;
    if (active) for (let b = 0; b < nb; b++) { this.slow[b] += (lvl[b] - this.slow[b]) * this.aS; this.fast[b] += (lvl[b] - this.fast[b]) * this.aF; }
    // target: flat to 150 Hz, then -3.5 dB/oct (energy per band), tilted by Brighten
    let mT = 0, mM = 0, cnt = 0;
    for (let b = 0; b < nb; b++) {
      const f = this.bF[b];
      this.tgt[b] = (f > 150 ? -3.5 * Math.log2(f / 150) : 0) + (p.brighten / 100) * 1.5 * Math.log2(f / 1000);
      if (f > 60 && f < 12000) { mT += this.tgt[b]; mM += this.slow[b]; cnt++; }
    }
    mT /= cnt; mM /= cnt;
    const wR = (p.recover / 100) * (p.bias < 0 ? 1 + p.bias / 100 : 1), wT = (p.tame / 100) * (p.bias > 0 ? 1 - p.bias / 100 : 1);
    const raw = this._raw || (this._raw = new Float32Array(nb));
    for (let b = 0; b < nb; b++) {
      const f = this.bF[b];
      let d = (this.tgt[b] - mT) - (this.slow[b] - mM);
      d = d > 0 ? d * wR * 0.6 : d * wT * 0.7;
      // narrow resonances poking out of their neighbours
      if (b > 0 && b < nb - 1) { const r = this.fast[b] - 0.5 * (this.fast[b - 1] + this.fast[b + 1]); if (r > 4) d -= (r - 4) * wT * 0.8; }
      if (f < 40 || f > 16000) d *= 0.3;
      raw[b] = Math.max(-6, Math.min(4, d));
    }
    for (let b = 0; b < nb; b++) {
      const sm = 0.25 * (raw[Math.max(0, b - 1)] + raw[Math.min(nb - 1, b + 1)]) + 0.5 * raw[b];
      const t = p.on && active ? sm : (p.on ? this.corr[b] : 0);
      this.corr[b] += (t - this.corr[b]) * this.aC;
    }
    const boost = dbLin(p.on ? p.boost : 0);
    for (let k = 0; k <= half; k++) {
      const b0 = this.bin0[k], t = this.binT[k];
      const c = t > 0 ? this.corr[b0] * (1 - t) + this.corr[b0 + 1] * t : this.corr[b0];
      const g = dbLin(c) * boost;
      re[k] *= g; im[k] *= g;
      if (k > 0 && k < half) { re[N - k] *= g; im[N - k] *= g; }
    }
    this.fft(re, im, true);
    for (let i = 0; i < N; i++) { this.aL[i] += re[i] * w[i] * 0.5; this.aR[i] += im[i] * w[i] * 0.5; }
    this.oL.set(this.aL.subarray(0, H)); this.oR.set(this.aR.subarray(0, H));
    this.aL.copyWithin(0, H); this.aL.fill(0, N - H); this.aR.copyWithin(0, H); this.aR.fill(0, N - H);
    if (++this.frames % 8 === 0) {
      const meas = new Array(nb), tg = new Array(nb);
      for (let b = 0; b < nb; b++) { meas[b] = this.slow[b] - mM; tg[b] = this.tgt[b] - mT; }
      this.port.postMessage({ corr: Array.from(this.corr), meas, tgt: tg, freqs: this.bF, active });
    }
  }
  process(inputs, outputs) {
    if (this.p.dead) return false;
    const inp = inputs[0] || [], out = outputs[0];
    const iL = inp[0], iR = inp[1] || inp[0], oL = out[0], oR = out[1] || out[0], H = this.H;
    for (let i = 0; i < oL.length; i++) {
      this.stL[this.pos] = iL ? iL[i] : 0; this.stR[this.pos] = iR ? iR[i] : 0;
      oL[i] = this.oL[this.pos]; if (oR !== oL) oR[i] = this.oR[this.pos];
      if (++this.pos === H) { this.pos = 0; this.frame(); }
    }
    return true;
  }
}
registerProcessor('efir-tonal', EfirTonal);

// ---------- R-Compressor style: clean feed-forward compressor with ARC, Electro and Warm modes. No latency ----------
// ARC — release adapts to the material; Electro — release speeds up at small gain reduction (more natural on voice);
// Warm — softer, wider knee (no added harmonics: everything stays clean).
class EfirRComp extends AudioWorkletProcessor {
  constructor(o) {
    super();
    this.p = Object.assign({ on: true, thresh: 0, ratio: 4.01, attack: 5.02, release: 50.2, gain: 0, mix: 100, trim: 0, arc: true, electro: true, warm: true }, o && o.processorOptions && o.processorOptions.p);
    this.pw = 0; this.gr = 0; this.slow = 0; this.cnt = 0; this.mx = 0; this.pin = 0; this.pout = 0;
    this.aR = tc(1);
    this.port.onmessage = (e) => Object.assign(this.p, e.data);
  }
  process(inputs, outputs) {
    if (this.p.dead) return false;
    const inp = inputs[0] || [], out = outputs[0], p = this.p;
    const iL = inp[0], iR = inp[1] || inp[0], oL = out[0], oR = out[1] || out[0];
    const aA = tc(Math.max(0.05, p.attack)), knW = p.warm ? 10 : 3, ratio = Math.max(1, p.ratio);
    const makeup = dbLin(p.gain + p.trim), mix = Math.min(1, Math.max(0, p.mix / 100));
    // release for this block: ARC lengthens it when compression has been going on for a while
    let rel = Math.max(5, p.release);
    if (p.arc) rel *= 0.7 + Math.min(1.6, this.slow / 6);
    const aRelBase = tc(rel), aRelFast = tc(rel * 0.45);
    for (let i = 0; i < oL.length; i++) {
      const l = iL ? iL[i] : 0, r = iR ? iR[i] : 0;
      if (!p.on) { oL[i] = l; if (oR !== oL) oR[i] = r; continue; }
      this.pw += (0.5 * (l * l + r * r) - this.pw) * this.aR;
      const pk = Math.max(Math.abs(l), Math.abs(r));
      const lvl = Math.max(10 * Math.log10(this.pw + 1e-12) + 3, 20 * Math.log10(pk + 1e-9) - 3);
      const t = knee(lvl - p.thresh, ratio, knW);
      const aRel = p.electro && this.gr < 3 ? aRelFast : aRelBase;
      this.gr += (t - this.gr) * (t > this.gr ? aA : aRel);
      const g = dbLin(-this.gr) * makeup;
      oL[i] = l * (1 - mix) + l * g * mix; if (oR !== oL) oR[i] = r * (1 - mix) + r * g * mix;
      if (this.gr > this.mx) this.mx = this.gr;
      if (pk > this.pin) this.pin = pk;
      const po = Math.max(Math.abs(oL[i]), Math.abs(oR[i])); if (po > this.pout) this.pout = po;
    }
    this.slow += (this.mx - this.slow) * 0.01;
    if (++this.cnt % 8 === 0) { this.port.postMessage({ gr: this.mx, inp: linDb(this.pin), out: linDb(this.pout) }); this.mx = 0; this.pin = 0; this.pout = 0; }
    return true;
  }
}
registerProcessor('efir-rcomp', EfirRComp);

// ---------- Bus compressor for the master: clean VCA glue, stereo-linked, sidechain high-pass so bass doesn't pump ----------
class EfirBusComp extends AudioWorkletProcessor {
  constructor(o) {
    super();
    this.p = Object.assign({ on: true, thresh: -14, ratio: 2, attack: 10, release: 0.3, auto: true, makeup: 0, mix: 100, schp: 90 }, o && o.processorOptions && o.processorOptions.p);
    this.hp = [new BQ(), new BQ()]; this.pw = 0; this.gr = 0; this.g2 = 0; this.cnt = 0; this.mx = 0;
    this.coefs();
    this.port.onmessage = (e) => { Object.assign(this.p, e.data); this.coefs(); };
  }
  coefs() { for (const h of this.hp) h.set('hp', Math.max(20, this.p.schp)); this.aRms = tc(5); }
  process(inputs, outputs) {
    if (this.p.dead) return false;
    const inp = inputs[0] || [], out = outputs[0], p = this.p;
    const iL = inp[0], iR = inp[1] || inp[0], oL = out[0], oR = out[1] || out[0];
    const aA = tc(Math.max(0.1, p.attack)), aR = tc(p.release * 1000), aRf = tc(100), aRs = tc(1200);
    const mk = dbLin(p.makeup), mix = Math.min(1, Math.max(0, p.mix / 100));
    for (let i = 0; i < oL.length; i++) {
      const l = iL ? iL[i] : 0, r = iR ? iR[i] : 0;
      if (!p.on) { oL[i] = l; if (oR !== oL) oR[i] = r; continue; }
      const sl = this.hp[0].run(l), sr = this.hp[1].run(r);
      this.pw += (0.5 * (sl * sl + sr * sr) - this.pw) * this.aRms;
      const t = knee(10 * Math.log10(this.pw + 1e-12) + 3 - p.thresh, p.ratio, 6);
      let gr;
      if (p.auto) { // auto release: fast stage for transients, slow stage for sustained level
        this.gr += (t - this.gr) * (t > this.gr ? aA : aRf);
        this.g2 += (t * 0.7 - this.g2) * (t * 0.7 > this.g2 ? tc(Math.max(30, p.attack * 6)) : aRs);
        gr = Math.max(this.gr, this.g2);
      } else { this.gr += (t - this.gr) * (t > this.gr ? aA : aR); gr = this.gr; }
      if (gr > this.mx) this.mx = gr;
      const g = dbLin(-gr) * mk;
      oL[i] = l * (1 - mix) + l * g * mix; if (oR !== oL) oR[i] = r * (1 - mix) + r * g * mix;
    }
    if (++this.cnt % 8 === 0) { this.port.postMessage({ gr: this.mx }); this.mx = 0; }
    return true;
  }
}
registerProcessor('efir-buscomp', EfirBusComp);
