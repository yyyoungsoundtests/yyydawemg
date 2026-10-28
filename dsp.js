// ===== AudioWorklet processors: spectral ducker + true-peak limiter =====
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
    if (++this.frames % 8 === 0) this.port.postMessage({ gr: maxR });
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
    this.p = Object.assign({ gain: 0, ceiling: -1, release: 80 }, options && options.processorOptions && options.processorOptions.p);
    this.coefs();
    this.port.onmessage = (e) => { Object.assign(this.p, e.data); this.coefs(); };
  }
  coefs() {
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
    for (let i = 0; i < oL.length; i++) {
      const x0 = iL ? iL[i] * this.g : 0, x1 = iR ? iR[i] * this.g : 0;
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
    if (++this.cntr % 16 === 0) { this.port.postMessage({ gr: -20 * Math.log10(this.minEnv) }); this.minEnv = 1; }
    return true;
  }
}
registerProcessor('efir-limiter', EfirLimiter);
