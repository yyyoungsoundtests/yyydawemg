'use strict';
/* Эфир — растяжение по времени без изменения высоты тона.
   mode 'st'     — алгоритм типа SoundTouch (TDStretch): фиксированные sequence/seek/overlap, зависят от темпа.
   mode 'speech' — речевой режим: длина кусков и окно поиска подстраиваются под период основного тона голоса
                   (2–3 периода на кусок, перекрытие в один период), меньше «эха» и двоения на речи. */

// Normalised cross-correlation of a[ao..ao+n) and b[bo..bo+n), stepping by `step`
function nxcorr(a, ao, b, bo, n, step) {
  let s = 0, ea = 0, eb = 0;
  for (let i = 0; i < n; i += step) { const x = a[ao + i], y = b[bo + i]; s += x * y; ea += x * x; eb += y * y; }
  return s / Math.sqrt(ea * eb + 1e-12);
}
// Pitch period (samples) around pos, or 0 if unvoiced
function pitchPeriod(x, pos, sr) {
  const win = Math.round(sr * 0.03), lo = Math.round(sr / 400), hi = Math.round(sr / 70);
  if (pos < 0 || pos + win + hi >= x.length) return 0;
  let e = 0; for (let i = 0; i < win; i += 2) e += x[pos + i] * x[pos + i];
  if (e < win / 2 * 1e-6) return 0;
  let best = 0, bl = 0;
  for (let lag = lo; lag <= hi; lag += 2) { const c = nxcorr(x, pos, x, pos + lag, win, 2); if (c > best) { best = c; bl = lag; } }
  if (best < 0.55) return 0;
  // refine ±1
  for (const d of [-1, 1]) { const c = nxcorr(x, pos, x, pos + bl + d, win, 1); if (c > best) { best = c; bl += d; } }
  return bl;
}
async function stretchAudio(chs, sr, tempo, mode = 'st', onProgress) {
  const nch = chs.length, N = chs[0].length;
  const mid = new Float32Array(N);
  for (let c = 0; c < nch; c++) { const d = chs[c]; for (let i = 0; i < N; i++) mid[i] += d[i] / nch; }
  const ms = (v) => Math.round(v * sr / 1000);
  // SoundTouch automatic parameters
  const t = Math.min(2, Math.max(0.5, tempo));
  const stSeq = ms(Math.min(90, Math.max(40, 90 - (50 / 1.5) * (t - 0.5))));
  const stSeek = ms(Math.min(20, Math.max(15, 20 - (5 / 1.5) * (t - 0.5))));
  const stOv = ms(8);
  const outLen = Math.ceil(N / tempo) + sr;
  const out = Array.from({ length: nch }, () => new Float32Array(outLen));
  let inPos = 0, outPos = 0, prevEnd = -1; // prevEnd: input index where the natural continuation of the last copied piece starts
  let midOv = null, ov = stOv;
  let iter = 0;
  while (true) {
    let seq = stSeq, seek = stSeek, o = stOv;
    if (mode === 'speech') {
      const T0 = pitchPeriod(mid, Math.round(inPos), sr);
      if (T0) { seq = Math.min(ms(45), Math.max(ms(15), 3 * T0)); o = Math.min(ms(12), Math.max(ms(3), T0)); seek = Math.min(ms(12), Math.max(ms(3), T0)); }
      else { seq = ms(22); o = ms(6); seek = ms(8); }
    }
    const nominal = Math.round(inPos);
    if (nominal + seq + seek + o >= N) break;
    // find best start near the nominal position: match its first `o` samples with the natural continuation of the previous piece
    let best = nominal, bc = -2;
    if (prevEnd >= 0) {
      const a0 = Math.max(0, nominal - seek), a1 = nominal + seek;
      const coarse = 4;
      for (let p = a0; p <= a1; p += coarse) { const c = nxcorr(mid, p, mid, prevEnd, o, 2); if (c > bc) { bc = c; best = p; } }
      for (let p = Math.max(0, best - coarse); p <= best + coarse; p++) { const c = nxcorr(mid, p, mid, prevEnd, o, 1); if (c > bc) { bc = c; best = p; } }
    }
    // overlap region: crossfade previous tail with the new piece's head (equal-gain for correlated audio)
    for (let c = 0; c < nch; c++) {
      const x = chs[c], y = out[c];
      if (prevEnd >= 0) {
        for (let i = 0; i < o; i++) { const w = (i + 0.5) / o; y[outPos + i] = x[prevEnd + i] * (1 - w) + x[best + i] * w; }
      } else for (let i = 0; i < o; i++) y[outPos + i] = x[best + i];
      for (let i = o; i < seq - o; i++) y[outPos + i] = x[best + i];
    }
    outPos += seq - o;
    prevEnd = best + seq - o;
    inPos += (seq - o) * tempo;
    if (++iter % 200 === 0) { onProgress && onProgress(inPos / N); await new Promise((r) => setTimeout(r, 0)); }
  }
  // tail: copy what is left after the last piece
  const rest = Math.max(0, N - prevEnd);
  const tailLen = Math.max(0, Math.round((N - inPos) / tempo));
  for (let c = 0; c < nch; c++) {
    const x = chs[c], y = out[c];
    if (prevEnd < 0) { y.set(x.subarray(0, Math.min(N, outLen))); continue; }
    const n = Math.min(rest, tailLen + ms(8), outLen - outPos);
    for (let i = 0; i < n; i++) y[outPos + i] = x[prevEnd + i];
  }
  const total = prevEnd < 0 ? Math.min(N, outLen) : Math.min(outLen, outPos + Math.min(rest, tailLen + ms(8)));
  onProgress && onProgress(1);
  return out.map((y) => y.slice(0, total));
}
