/*
 * Fellowship Stream Mixer — browser engine.
 *
 * A JavaScript port of fsm/engine.py + fsm/dsp.py + fsm/presets.py so the mixer
 * can run inside a web page (AudioWorklet). Keep the two in step: the source
 * type presets below must match fsm/presets.py (a Python test checks this).
 *
 * This file is loaded three ways: as a <script> in the page, as an AudioWorklet
 * module (it shares one global scope with worklet.js), and from Node for tests.
 */
"use strict";

const FSM_EPS = 1e-12;
const db2lin = (db) => Math.pow(10, db / 20);
const lin2db = (x, floor = -120) => Math.max(20 * Math.log10(Math.max(x, FSM_EPS)), floor);

// BEGIN PRESETS (JSON — must match fsm/presets.py; -Infinity is written as null)
const FSM_PRESETS = {
  "speech": {"label": "Speaker / Pastor", "hpf": 90, "hpf_order": 4, "eq": [["peak", 220, -2.0, 1.0], ["peak", 3200, 2.5, 0.9], ["highshelf", 9000, 1.5, 0.7]], "target_db": -20.0, "leveler_range": 12.0, "comp_above": 3.0, "ratio": 3.0, "gate_range": -12.0, "gate_hold": 0.3, "automix": true, "ducks_music": true, "duckable": false, "reverb_db": null},
  "lead_vocal": {"label": "Lead vocal", "hpf": 100, "hpf_order": 4, "eq": [["peak", 300, -2.0, 1.0], ["peak", 3500, 2.0, 1.0], ["highshelf", 10000, 2.0, 0.7]], "target_db": -20.0, "leveler_range": 9.0, "comp_above": 3.0, "ratio": 3.0, "gate_range": -10.0, "gate_hold": 0.4, "automix": false, "ducks_music": false, "duckable": false, "reverb_db": -16.0},
  "bg_vocal": {"label": "Background vocal", "hpf": 140, "hpf_order": 4, "eq": [["peak", 250, -3.0, 1.0], ["peak", 3000, -1.0, 1.0], ["highshelf", 10000, 1.5, 0.7]], "target_db": -25.0, "leveler_range": 9.0, "comp_above": 2.0, "ratio": 4.0, "gate_range": -15.0, "gate_hold": 0.4, "automix": false, "ducks_music": false, "duckable": false, "reverb_db": -14.0},
  "instrument": {"label": "Instrument", "hpf": 40, "hpf_order": 2, "eq": [["peak", 350, -1.5, 0.8]], "target_db": -24.0, "leveler_range": 6.0, "comp_above": 4.0, "ratio": 2.0, "gate_range": 0.0, "gate_hold": 0.5, "automix": false, "ducks_music": false, "duckable": true, "reverb_db": null},
  "drums": {"label": "Drums", "hpf": 45, "hpf_order": 2, "eq": [["peak", 400, -2.0, 1.0]], "target_db": -26.0, "leveler_range": 4.0, "comp_above": 6.0, "ratio": 2.0, "gate_range": 0.0, "gate_hold": 0.5, "automix": false, "ducks_music": false, "duckable": true, "reverb_db": null},
  "playback": {"label": "Playback (video / tracks)", "hpf": 25, "hpf_order": 2, "eq": [], "target_db": -22.0, "leveler_range": 6.0, "comp_above": 6.0, "ratio": 1.5, "gate_range": 0.0, "gate_hold": 0.5, "automix": false, "ducks_music": false, "duckable": true, "reverb_db": null},
  "off": {"label": "Off", "hpf": 20, "hpf_order": 2, "eq": [], "target_db": -24.0, "leveler_range": 0.0, "comp_above": 20.0, "ratio": 1.0, "gate_range": 0.0, "gate_hold": 0.5, "automix": false, "ducks_music": false, "duckable": false, "reverb_db": null}
};
// END PRESETS
const FSM_TYPE_ORDER = ["speech", "lead_vocal", "bg_vocal", "instrument", "drums", "playback", "off"];

const FSM_DEFAULT_MASTER = {
  target_lufs: -16, ceiling_db: -1, ducking: "auto", duck_depth_db: -9,
  reverb_return_db: 0, output_trim_db: 0, bypass: false, tune_key: "chromatic",
};
const FSM_DEFAULT_AUDIO = {
  input_device: "SQ", output_device: "BlackHole", output_channels: [1, 2],
  sample_rate: null, block_ms: 10.0,
};
const FSM_CHANNEL_DEFAULTS = {
  name: "", type: "off", trim_db: 0, fader_db: 0, mute: false, pan: 0,
  reverb_db: null, ducks_music: null, link: false,
  solo: false, tune: false, tune_amount: 50, tune_speed_ms: 150,
};

// ---------------------------------------------------------------- filters

function biquad(kind, f0, fs, gainDb = 0, q = 0.7071) {
  f0 = Math.min(f0, 0.45 * fs);
  const A = Math.pow(10, gainDb / 40);
  const w0 = 2 * Math.PI * f0 / fs;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const alpha = sw / (2 * q);
  let b, a;
  if (kind === "highpass") {
    b = [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2]; a = [1 + alpha, -2 * cw, 1 - alpha];
  } else if (kind === "lowpass") {
    b = [(1 - cw) / 2, 1 - cw, (1 - cw) / 2]; a = [1 + alpha, -2 * cw, 1 - alpha];
  } else if (kind === "peak") {
    b = [1 + alpha * A, -2 * cw, 1 - alpha * A]; a = [1 + alpha / A, -2 * cw, 1 - alpha / A];
  } else if (kind === "highshelf" || kind === "lowshelf") {
    const sq = 2 * Math.sqrt(A) * alpha;
    if (kind === "highshelf") {
      b = [A * ((A + 1) + (A - 1) * cw + sq), -2 * A * ((A - 1) + (A + 1) * cw), A * ((A + 1) + (A - 1) * cw - sq)];
      a = [(A + 1) - (A - 1) * cw + sq, 2 * ((A - 1) - (A + 1) * cw), (A + 1) - (A - 1) * cw - sq];
    } else {
      b = [A * ((A + 1) - (A - 1) * cw + sq), 2 * A * ((A - 1) - (A + 1) * cw), A * ((A + 1) - (A - 1) * cw - sq)];
      a = [(A + 1) + (A - 1) * cw + sq, -2 * ((A - 1) + (A + 1) * cw), (A + 1) + (A - 1) * cw - sq];
    }
  } else {
    throw new Error("unknown filter " + kind);
  }
  return [b[0] / a[0], b[1] / a[0], b[2] / a[0], a[1] / a[0], a[2] / a[0]];
}

function highpassSections(freq, fs, order) {
  if (order <= 2) return [biquad("highpass", freq, fs, 0, 0.7071)];
  return [biquad("highpass", freq, fs, 0, 0.5412), biquad("highpass", freq, fs, 0, 1.3066)];
}

class FilterChain {
  constructor(sections) {
    this.s = sections;
    this.z = sections.map(() => new Float64Array(2));
  }
  /** Filters ``x`` in place. */
  process(x) {
    const n = x.length;
    for (let k = 0; k < this.s.length; k++) {
      const [b0, b1, b2, a1, a2] = this.s[k];
      const z = this.z[k];
      let z1 = z[0], z2 = z[1];
      for (let i = 0; i < n; i++) {
        const xi = x[i];
        const y = b0 * xi + z1;
        z1 = b1 * xi - a1 * y + z2;
        z2 = b2 * xi - a2 * y;
        x[i] = y;
      }
      z[0] = z1; z[1] = z2;
    }
    return x;
  }
}

function meanSquareDb(x, floor = -120) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.max(10 * Math.log10(s / x.length + FSM_EPS), floor);
}

// ---------------------------------------------------------------- loudness

class LoudnessMeter {
  constructor(fs, block) {
    const sec = () => [biquad("highshelf", 1681.974, fs, 3.9998, 0.7072), biquad("highpass", 38.1355, fs, 0, 0.5003)];
    this.fl = new FilterChain(sec());
    this.fr = new FilterChain(sec());
    this.mLen = Math.max(1, Math.round(0.4 * fs / block));
    this.sLen = Math.max(1, Math.round(3.0 * fs / block));
    this.ring = new Float64Array(this.sLen);
    this.pos = 0; this.count = 0;
    this.momentary = -120; this.shortTerm = -120;
    this.tl = new Float64Array(block); this.tr = new Float64Array(block);
  }
  update(L, R) {
    this.tl.set(L); this.tr.set(R);
    this.fl.process(this.tl); this.fr.process(this.tr);
    let sl = 0, sr = 0;
    const n = L.length;
    for (let i = 0; i < n; i++) { sl += this.tl[i] * this.tl[i]; sr += this.tr[i] * this.tr[i]; }
    this.ring[this.pos] = sl / n + sr / n;
    this.pos = (this.pos + 1) % this.sLen;
    this.count = Math.min(this.count + 1, this.sLen);
    let m = 0, s = 0;
    const mc = Math.min(this.mLen, this.count);
    for (let k = 0; k < this.count; k++) {
      const v = this.ring[(this.pos - 1 - k + this.sLen) % this.sLen];
      s += v;
      if (k < mc) m += v;
    }
    this.momentary = -0.691 + 10 * Math.log10(m / mc + FSM_EPS);
    this.shortTerm = -0.691 + 10 * Math.log10(s / this.count + FSM_EPS);
  }
}

// ---------------------------------------------------------------- limiter

class Limiter {
  constructor(fs, block, ceilingDb = -1, lookaheadMs = 4, releaseMs = 200) {
    this.n = block;
    this.L = Math.max(2, Math.min(block, Math.round(lookaheadMs * fs / 1000)));
    this.r = 1 / (releaseMs * fs / 1000);
    this.ceiling = db2lin(ceilingDb);
    this.prevL = new Float64Array(block); this.prevR = new Float64Array(block);
    this.greq = new Float64Array(2 * block);
    this.h = new Float64Array(block);
    this.hTail = new Float64Array(this.L - 1).fill(1);
    this.dq = new Int32Array(2 * block);
    this.gLast = 1; this.lastMinGain = 1;
  }
  setCeiling(db) { this.ceiling = db2lin(db); }
  process(L, R, outL, outR) {
    const n = this.n, Lw = this.L, c = this.ceiling;
    const greq = this.greq, h = this.h, dq = this.dq;
    for (let i = 0; i < 2 * n; i++) {
      const l = i < n ? this.prevL[i] : L[i - n];
      const r = i < n ? this.prevR[i] : R[i - n];
      const p = Math.max(Math.abs(l), Math.abs(r));
      greq[i] = p > c ? c / p : 1;
    }
    // forward sliding minimum (monotonic deque): h[i] = min(greq[i .. i+Lw-1])
    let head = 0, tail = 0;
    for (let j = 0; j < n + Lw - 1; j++) {
      while (tail > head && greq[dq[tail - 1]] >= greq[j]) tail--;
      dq[tail++] = j;
      const i = j - Lw + 1;
      if (i >= 0) {
        while (dq[head] < i) head++;
        h[i] = greq[dq[head]];
      }
    }
    // backward moving average over Lw values (previous block's tail first) + release
    let sum = 0;
    const tl = this.hTail.length;
    for (let k = 0; k < tl; k++) sum += this.hTail[k];
    let g = this.gLast, gmin = 1;
    for (let i = 0; i < n; i++) {
      sum += h[i];
      const avg = sum / Lw;
      const drop = i - (Lw - 1);
      sum -= drop < 0 ? this.hTail[i] : h[drop];
      g = Math.min(avg, g + this.r, 1);
      if (g < gmin) gmin = g;
      let ol = this.prevL[i] * g, or = this.prevR[i] * g;
      outL[i] = ol > c ? c : ol < -c ? -c : ol;
      outR[i] = or > c ? c : or < -c ? -c : or;
    }
    for (let k = 0; k < tl; k++) this.hTail[k] = h[n - tl + k];
    this.gLast = g; this.lastMinGain = gmin;
    this.prevL.set(L); this.prevR.set(R);
  }
}

// ---------------------------------------------------------------- reverb

function fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

function seededNormal(seed) {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) + 1) / 4294967297;
  };
  return () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
}

function syntheticIR(fs, rt60 = 1.6, predelayMs = 18, seed = 7) {
  const randn = seededNormal(seed);
  const n = Math.floor(fs * rt60 * 1.1);
  const pre = Math.floor(predelayMs * fs / 1000);
  const fade = Math.floor(0.01 * fs);
  const out = [];
  for (let c = 0; c < 2; c++) {
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = randn() * Math.exp(-6.9078 * (i / fs) / rt60);
    new FilterChain([biquad("lowpass", 6000, fs, 0, 0.6)]).process(x);
    new FilterChain([biquad("highpass", 180, fs, 0, 0.6)]).process(x);
    for (let i = 0; i < fade; i++) x[i] *= i / (fade - 1);
    const y = new Float64Array(n + pre);
    y.set(x, pre);
    out.push(y);
  }
  let e = 0;
  for (const y of out) for (let i = 0; i < y.length; i++) e += y[i] * y[i];
  const k = 0.5 / Math.sqrt(e / 2);
  for (const y of out) for (let i = 0; i < y.length; i++) y[i] *= k;
  return out;
}

/** Mono in, stereo out uniformly partitioned convolution (block must be a power of two). */
class Reverb {
  constructor(fs, block, rt60 = 1.6) {
    this.n = block;
    const N2 = 2 * block;
    const ir = syntheticIR(fs, rt60);
    this.P = Math.ceil(ir[0].length / block);
    this.H = [];
    for (let p = 0; p < this.P; p++) {
      const pair = [];
      for (let c = 0; c < 2; c++) {
        const re = new Float64Array(N2), im = new Float64Array(N2);
        for (let i = 0; i < block; i++) re[i] = ir[c][p * block + i] || 0;
        fft(re, im, false);
        pair.push([re, im]);
      }
      this.H.push(pair);
    }
    this.fdl = Array.from({ length: this.P }, () => [new Float64Array(N2), new Float64Array(N2)]);
    this.idx = 0;
    this.prevIn = new Float64Array(block);
    this.acc = [[new Float64Array(N2), new Float64Array(N2)], [new Float64Array(N2), new Float64Array(N2)]];
    this.active = 0;
  }
  process(mono, outL, outR) {
    const n = this.n, N2 = 2 * n;
    let energy = 0;
    for (let i = 0; i < n; i++) energy += Math.abs(mono[i]);
    // skip the work once the input has been silent for longer than the tail
    this.active = energy > 1e-9 ? this.P + 1 : Math.max(0, this.active - 1);
    if (this.active === 0) { outL.fill(0); outR.fill(0); this.prevIn.fill(0); return; }
    this.idx = (this.idx + 1) % this.P;
    const [xr, xi] = this.fdl[this.idx];
    for (let i = 0; i < n; i++) { xr[i] = this.prevIn[i]; xr[n + i] = mono[i]; }
    xi.fill(0);
    fft(xr, xi, false);
    this.prevIn.set(mono);
    for (let c = 0; c < 2; c++) {
      const [ar, ai] = this.acc[c];
      ar.fill(0); ai.fill(0);
      for (let p = 0; p < this.P; p++) {
        const [fr, fi] = this.fdl[(this.idx - p + this.P) % this.P];
        const [hr, hi] = this.H[p][c];
        for (let k = 0; k < N2; k++) {
          ar[k] += fr[k] * hr[k] - fi[k] * hi[k];
          ai[k] += fr[k] * hi[k] + fi[k] * hr[k];
        }
      }
      fft(ar, ai, true);
      const out = c === 0 ? outL : outR;
      for (let i = 0; i < n; i++) out[i] = ar[n + i];
    }
  }
}


// ---------------------------------------------------------------- pitch correction
// Port of fsm/pitch.py: YIN pitch detection + a delay-line shifter that jumps by
// exactly one pitch period (phase-aligned) when its read point reaches the edge.

const FSM_NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const FSM_SCALES = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10] };
const FSM_KEYS = ["chromatic"].concat(...FSM_NOTE_NAMES.map((n) => [`${n} major`, `${n} minor`]));
const FSM_VOCAL_TYPES = ["lead_vocal", "bg_vocal"];
const PITCH_FMIN = 70, PITCH_FMAX = 1000, DEADBAND_CENTS = 3;

function fsmScaleNotes(key) {
  if (key === "chromatic") return [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const [root, scale] = key.split(" ");
  const r = FSM_NOTE_NAMES.indexOf(root);
  return FSM_SCALES[scale].map((i) => (r + i) % 12).sort((a, b) => a - b);
}
function fsmNoteName(m) { m = Math.round(m); return FSM_NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1); }

class PitchCorrector {
  constructor(fs, block) {
    this.fs = fs; this.n = block; this.dt = block / fs;
    this.tauMin = Math.max(2, Math.floor(fs / PITCH_FMAX));
    this.tauMax = Math.floor(fs / PITCH_FMIN);
    this.H = Math.floor(0.06 * fs);
    this.buf = new Float64Array(this.H + block);  // [history | current block]
    this.center = 0.02 * fs;
    this.d = this.center;
    this.period = 0.005 * fs;
    this.cents = 0; this.note = null; this.f0 = null; this.detune = 0;
    this.xfLeft = 0; this.xfLen = 1; this.xfOff = 0;
    let N = 1; while (N < 2 * this.tauMax) N <<= 1;
    this.N = N;
    this.re = new Float64Array(N); this.im = new Float64Array(N);
    this.cmnd = new Float64Array(this.tauMax + 1);
    this.out = new Float64Array(block);
  }
  _load(x) {
    this.buf.copyWithin(0, this.n);
    this.buf.set(x, this.H);
  }
  push(x) { this._load(x); this.f0 = null; }

  /** YIN on the last 2*tauMax samples. Returns frequency or null. */
  _yin() {
    const W = this.tauMax, N = this.N, re = this.re, im = this.im, buf = this.buf;
    const base = buf.length - 2 * W;
    re.fill(0); im.fill(0);
    for (let j = 0; j < 2 * W; j++) re[j] = buf[base + j];   // x
    for (let j = 0; j < W; j++) im[j] = buf[base + j];       // x0 (packed in the imaginary part)
    fft(re, im, false);
    // unpack X and X0 from Z = X + iX0, form conj(X0)*X, inverse-transform
    const pr = new Float64Array(N), pi = new Float64Array(N);
    for (let k = 0; k < N; k++) {
      const k2 = (N - k) & (N - 1);
      const xr = 0.5 * (re[k] + re[k2]), xi = 0.5 * (im[k] - im[k2]);
      const yr = 0.5 * (im[k] + im[k2]), yi = -0.5 * (re[k] - re[k2]);
      pr[k] = yr * xr + yi * xi;
      pi[k] = yr * xi - yi * xr;
    }
    fft(pr, pi, true);
    const cm = this.cmnd;
    let e0 = 0;
    for (let j = 0; j < W; j++) e0 += buf[base + j] * buf[base + j];
    let et = e0, run = 0;
    cm[0] = 1;
    for (let tau = 1; tau <= W; tau++) {
      const a = buf[base + tau - 1], b = buf[base + tau - 1 + W];
      et += b * b - a * a;
      const d = Math.max(0, e0 + et - 2 * pr[tau]);
      run += d;
      cm[tau] = run > 1e-20 ? d * tau / run : 1;
    }
    let tau = -1;
    for (let t = this.tauMin; t < W; t++) {
      if (cm[t] < 0.15) { tau = t; while (tau + 1 < W && cm[tau + 1] < cm[tau]) tau++; break; }
    }
    if (tau < 0) { tau = this.tauMin; for (let t = this.tauMin; t < W; t++) if (cm[t] < cm[tau]) tau = t; }
    if (cm[tau] > 0.25) return null;
    let tf = tau;
    if (tau >= 1 && tau < W) {
      const a = cm[tau - 1], b = cm[tau], c = cm[tau + 1], den = a - 2 * b + c;
      if (Math.abs(den) > 1e-12) tf = tau + Math.max(-1, Math.min(1, 0.5 * (a - c) / den));
    }
    return this.fs / tf;
  }

  _target(midi, allowed) {
    if (this.note !== null && allowed.includes(((this.note % 12) + 12) % 12) && Math.abs(midi - this.note) < 0.7) return this.note;
    const base = Math.floor(midi);
    let best = null;
    for (let m = base - 2; m <= base + 2; m++) {
      if (allowed.includes(((m % 12) + 12) % 12) && (best === null || Math.abs(m - midi) < Math.abs(best - midi))) best = m;
    }
    return best;
  }

  process(x, active, amount, speedMs, allowed) {
    const n = this.n, fs = this.fs, H = this.H;
    this._load(x);
    let f0 = null;
    if (active) {
      const W = this.tauMax, base = this.buf.length - 2 * W;
      let e1 = 0, e2 = 0;
      for (let j = 0; j < W; j++) { const a = this.buf[base + j], b = this.buf[base + W + j]; e1 += a * a; e2 += b * b; }
      if (e1 > 0.25 * e2 && e2 > 0.25 * e1) f0 = this._yin();
    }
    this.f0 = f0;
    let want = 0;
    if (f0) {
      this.period = fs / f0;
      const midi = 69 + 12 * Math.log2(f0 / 440);
      this.note = this._target(midi, allowed);
      this.detune = (midi - this.note) * 100;
      want = Math.abs(this.detune) < DEADBAND_CENTS ? 0 : -this.detune * Math.max(0, Math.min(1, amount));
    } else { this.note = null; this.detune = 0; }
    const k = 1 - Math.exp(-this.dt / Math.max(0.005, speedMs / 1000));
    this.cents = Math.max(-100, Math.min(100, this.cents + (want - this.cents) * k));

    const ratio = Math.pow(2, this.cents / 1200), slope = 1 - ratio, T = this.period;
    const lo = this.center - T / 2, hi = this.center + T / 2;
    const buf = this.buf, last = buf.length - 1.000001;
    const read = (p) => { p = p < 0 ? 0 : p > last ? last : p; const i = p | 0, f = p - i; return buf[i] * (1 - f) + buf[i + 1] * f; };
    let d = this.d;
    const out = this.out;
    for (let i = 0; i < n; i++) {
      d += slope;
      if ((slope < 0 && d < lo) || (slope > 0 && d > hi)) {
        let off = d < lo ? T : -T;
        if (!(lo - T <= d && d <= hi + T)) off = this.center - d;
        d += off;
        this.xfLen = Math.max(32, Math.min(T, 0.005 * fs)) | 0;
        this.xfLeft = this.xfLen; this.xfOff = off;
      }
      let y = read(H + i - d);
      if (this.xfLeft > 0) {
        const w = (this.xfLen - this.xfLeft + 1) / this.xfLen;
        y = w * y + (1 - w) * read(H + i - (d - this.xfOff));
        this.xfLeft--;
      }
      out[i] = y;
    }
    this.d = d;
    return out;
  }
}

// ---------------------------------------------------------------- engine

const NF_MIN = -85, NF_MAX = -45, OPEN_ABOVE = 10, CLOSE_ABOVE = 6, NOISE_WINDOW_S = 20;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

class Strip {
  constructor(ch, fs, block) {
    this.fs = fs; this.block = block; this.dt = block / fs;
    this.blocksPerS = Math.max(1, Math.round(fs / block));
    this.type = null;
    this.tuner = null; this.tuneMix = 0;
    this.configure(ch);
    this.nfRing = []; this.nfCur = Infinity; this.nfCount = 0; this.noiseFloor = -70;
    this.gateOpen = false; this.hold = 0; this.gateDb = this.p.gate_range;
    this.grDb = 0; this.amDb = 0; this.amEnv = -120;
    this.gainPrev = 0; this.bypassGainPrev = 0; this.level = -120;
    this.buf = new Float64Array(block);
    this.raw = new Float64Array(block);
  }
  configure(ch) {
    this.cfg = Object.assign({}, ch);
    if (ch.type !== this.type) {
      this.type = ch.type;
      this.p = FSM_PRESETS[ch.type];
      const sections = highpassSections(this.p.hpf, this.fs, this.p.hpf_order)
        .concat(this.p.eq.map(([k, f, g, q]) => biquad(k, f, this.fs, g, q)));
      this.chain = new FilterChain(sections);
      this.avgDb = this.p.target_db; this.levDb = 0;
    }
    this.col = (ch.input | 0) - 1;
    this.trim = db2lin(ch.trim_db || 0);
    this.faderDb = Number(ch.fader_db || 0);
    this.mute = !!ch.mute;
    const th = (Number(ch.pan || 0) + 1) * Math.PI / 4;
    this.panL = Math.cos(th); this.panR = Math.sin(th);
    let rv = ch.reverb_db;
    if (rv === null || rv === undefined) rv = this.p.reverb_db;
    this.send = rv === null || rv <= -60 ? 0 : db2lin(rv);
    this.ducksMusic = ch.ducks_music === null || ch.ducks_music === undefined ? this.p.ducks_music : !!ch.ducks_music;
    this.link = !!ch.link;
    this.solo = !!ch.solo;
    this.tune = !!ch.tune;
    this.tuneAmount = Number(ch.tune_amount ?? 50) / 100;
    this.tuneSpeedMs = Number(ch.tune_speed_ms ?? 150);
    if (FSM_VOCAL_TYPES.includes(this.type) && !this.tuner) this.tuner = new PitchCorrector(this.fs, this.block);
  }
  get tuning() { return this.tune && FSM_VOCAL_TYPES.includes(this.type); }

  /** Light pitch correction on this.buf, crossfaded over 30 ms when switched. */
  applyTune(allowed) {
    if (!this.tuner) return;
    const prev = this.tuneMix, step = this.dt / 0.03;
    this.tuneMix = this.tuning ? Math.min(1, prev + step) : Math.max(0, prev - step);
    if (prev === 0 && this.tuneMix === 0) { this.tuner.push(this.buf); return; }
    const wet = this.tuner.process(this.buf, this.gateOpen, this.tuneAmount, this.tuneSpeedMs, allowed);
    const n = this.buf.length, dm = (this.tuneMix - prev) / n;
    for (let i = 0; i < n; i++) { const m = prev + dm * (i + 1); this.buf[i] = this.buf[i] * (1 - m) + wet[i] * m; }
  }
  get on() { return this.type !== "off" && !this.mute; }

  detect(level) {
    const dt = this.dt, p = this.p;
    this.level = level;
    if (level > -100) this.nfCur = Math.min(this.nfCur, level);
    if (++this.nfCount >= this.blocksPerS) {
      this.nfRing.push(this.nfCur);
      if (this.nfRing.length > NOISE_WINDOW_S) this.nfRing.shift();
      this.nfCur = Infinity; this.nfCount = 0;
    }
    const nf = Math.min(this.nfCur, ...this.nfRing);
    this.noiseFloor = clamp(nf, NF_MIN, NF_MAX);

    if (level > this.noiseFloor + OPEN_ABOVE) { this.gateOpen = true; this.hold = p.gate_hold; }
    else if (level < this.noiseFloor + CLOSE_ABOVE) { this.hold -= dt; if (this.hold <= 0) this.gateOpen = false; }
    const rng = p.gate_range;
    const target = this.gateOpen || rng === 0 ? 0 : rng;
    if (this.gateDb < target) this.gateDb = Math.min(target, this.gateDb + 400 * dt);
    else this.gateDb = Math.max(target, this.gateDb - Math.abs(rng) / 0.25 * dt);

    if (p.leveler_range > 0 && this.gateOpen && level > this.noiseFloor + CLOSE_ABOVE) {
      this.avgDb += (level - this.avgDb) * (dt / 1.5);
      const want = clamp(p.target_db - this.avgDb, -p.leveler_range, p.leveler_range);
      const step = 3 * dt;
      this.levDb += clamp(want - this.levDb, -step, step);
    }

    const lv = level + this.levDb;
    this.amEnv = lv > this.amEnv ? lv : Math.max(lv, this.amEnv - 20 * dt);

    const over = lv - (p.target_db + p.comp_above);
    const knee = 6, slope = 1 / p.ratio - 1;
    let stat;
    if (over <= -knee / 2) stat = 0;
    else if (over < knee / 2) stat = slope * Math.pow(over + knee / 2, 2) / (2 * knee);
    else stat = slope * over;
    this.grDb = stat < this.grDb ? stat : Math.min(stat, this.grDb + 30 * dt);
  }
}

/** Power of two closest to 10 ms (512 at 44.1/48 kHz, 1024 at 96 kHz). */
function fsmBlockSize(fs) {
  return Math.pow(2, Math.max(6, Math.round(Math.log2(fs * 0.01))));
}

class Engine {
  constructor(cfg, fs, block) {
    this.cfg = fsmNormalize(cfg);
    this.fs = fs; this.block = block; this.dt = block / fs;
    this.strips = this.cfg.channels.map((ch) => new Strip(ch, fs, block));
    this.nInputs = Math.max(0, ...this.strips.map((s) => s.col + 1));
    this.reverb = new Reverb(fs, block);
    this.preMeter = new LoudnessMeter(fs, block);
    this.postMeter = new LoudnessMeter(fs, block);
    this.limiter = new Limiter(fs, block, this.cfg.master.ceiling_db);
    this.agcDb = 0; this.agcPrev = 1;
    this.duckDb = 0; this.duckHold = 0; this.speechActive = false; this.anySolo = false;
    this.bypassMix = this.cfg.master.bypass ? 1 : 0;
    const n = block;
    this.mixL = new Float64Array(n); this.mixR = new Float64Array(n);
    this.bypL = new Float64Array(n); this.bypR = new Float64Array(n);
    this.send = new Float64Array(n);
    this.wetL = new Float64Array(n); this.wetR = new Float64Array(n);
    this.outL = new Float64Array(n); this.outR = new Float64Array(n);
    this.load = 0; this.xruns = 0;
    this.resetPeaks();
    this.meters = null;
  }

  updateChannel(i, changes) {
    const ch = Object.assign({}, this.cfg.channels[i], fsmValidateChannel(changes));
    if (ch.link && i === 0) ch.link = false;
    this.cfg.channels[i] = ch;
    this.strips[i].configure(ch);
    return ch;
  }
  clearSolo() {
    this.cfg.channels.forEach((ch, i) => { if (ch.solo) this.updateChannel(i, { solo: false }); });
  }
  updateMaster(changes) {
    Object.assign(this.cfg.master, fsmValidateMaster(changes));
    this.limiter.setCeiling(this.cfg.master.ceiling_db);
    return Object.assign({}, this.cfg.master);
  }

  /** inputs: array of channel arrays (index = device input - 1), each ``block`` long. */
  process(inputs) {
    const t0 = (typeof performance !== "undefined" ? performance : Date).now();
    const n = this.block, dt = this.dt, m = this.cfg.master;
    const strips = this.strips;

    const levels = [];
    for (const s of strips) {
      const src = inputs[s.col];
      if (src) for (let i = 0; i < n; i++) s.raw[i] = src[i] * s.trim;
      else s.raw.fill(0);
      if (s.type !== "off") { s.buf.set(s.raw); s.chain.process(s.buf); levels.push(meanSquareDb(s.buf)); }
      else { s.buf.fill(0); levels.push(-120); }
    }
    for (let i = 1; i < strips.length; i++) {
      if (strips[i].link) levels[i] = levels[i - 1] = Math.max(levels[i], levels[i - 1]);
    }
    strips.forEach((s, i) => s.detect(levels[i]));

    const allowed = fsmScaleNotes(m.tune_key || "chromatic");
    for (const s of strips) if (s.tuner && s.type !== "off") s.applyTune(allowed);

    // solo in place; soloing either side of a linked pair solos both
    const soloed = strips.map((s) => s.solo);
    for (let i = 1; i < strips.length; i++) {
      if (strips[i].link && (soloed[i] || soloed[i - 1])) soloed[i] = soloed[i - 1] = true;
    }
    this.anySolo = strips.some((s, i) => soloed[i] && s.type !== "off");
    const audible = strips.map((s, i) => s.on && (soloed[i] || !this.anySolo));
    this.gainSharing();
    this.ducking(m);

    const mixL = this.mixL, mixR = this.mixR, send = this.send;
    mixL.fill(0); mixR.fill(0); send.fill(0);
    strips.forEach((s, si) => {
      let g = 0;
      if (audible[si]) {
        let total = s.levDb + s.grDb + s.gateDb + s.amDb + s.faderDb;
        if (s.p.duckable) total += this.duckDb;
        g = db2lin(total);
      }
      const g0 = s.gainPrev, dg = (g - g0) / n;
      let pk = 0, ss = 0;
      if (g0 !== 0 || g !== 0) {
        for (let i = 0; i < n; i++) {
          const v = s.buf[i] * (g0 + dg * (i + 1));
          s.buf[i] = v;
          mixL[i] += v * s.panL; mixR[i] += v * s.panR;
          if (s.send) send[i] += v * s.send;
          const a = Math.abs(v); if (a > pk) pk = a; ss += v * v;
        }
      } else s.buf.fill(0);
      s.gainPrev = g;
      s._outPk = pk; s._outMs = ss / n;
    });

    this.reverb.process(send, this.wetL, this.wetR);
    const rr = db2lin(m.reverb_return_db);
    for (let i = 0; i < n; i++) { mixL[i] += this.wetL[i] * rr; mixR[i] += this.wetR[i] * rr; }

    this.preMeter.update(mixL, mixR);
    const st = this.preMeter.shortTerm;
    if (st > -50) {
      const want = clamp(m.target_lufs - st, -12, 15);
      const diff = want - this.agcDb;
      const rate = diff > 0 ? 1.5 : diff < -3 ? 4 : 2;
      this.agcDb += clamp(diff, -rate * dt, rate * dt);
    }
    const agc = db2lin(this.agcDb + m.output_trim_db);
    const a0 = this.agcPrev, da = (agc - a0) / n;
    for (let i = 0; i < n; i++) { const g = a0 + da * (i + 1); mixL[i] *= g; mixR[i] *= g; }
    this.agcPrev = agc;

    // A/B bypass with a 50 ms crossfade
    const bTarget = m.bypass ? 1 : 0, bPrev = this.bypassMix, step = dt / 0.05;
    this.bypassMix = Math.abs(bTarget - bPrev) <= step ? bTarget : bPrev + Math.sign(bTarget - bPrev) * step;
    if (!(bPrev === 0 && this.bypassMix === 0)) {
      const bypL = this.bypL, bypR = this.bypR;
      bypL.fill(0); bypR.fill(0);
      const trim = db2lin(m.output_trim_db);
      strips.forEach((s, si) => {
        const g = audible[si] ? db2lin(s.faderDb) : 0, g0 = s.bypassGainPrev, dg = (g - g0) / n;
        for (let i = 0; i < n; i++) {
          const v = s.raw[i] * (g0 + dg * (i + 1)) * trim;
          bypL[i] += v * s.panL; bypR[i] += v * s.panR;
        }
        s.bypassGainPrev = g;
      });
      const db = (this.bypassMix - bPrev) / n;
      for (let i = 0; i < n; i++) {
        const b = bPrev + db * (i + 1);
        mixL[i] = mixL[i] * (1 - b) + bypL[i] * b;
        mixR[i] = mixR[i] * (1 - b) + bypR[i] * b;
      }
    } else {
      for (const s of strips) s.bypassGainPrev = 0;
    }

    this.limiter.process(mixL, mixR, this.outL, this.outR);
    this.postMeter.update(this.outL, this.outR);
    this.accumulateMeters();
    const el = ((typeof performance !== "undefined" ? performance : Date).now() - t0) / 1000;
    this.load = 0.9 * this.load + 0.1 * (el / dt);
    return [this.outL, this.outR];
  }

  gainSharing() {
    const am = this.strips.filter((s) => s.on && s.p.automix);
    for (const s of this.strips) if (!am.includes(s)) s.amDb = 0;
    if (am.length < 2) { for (const s of am) s.amDb = 0; return; }
    if (!am.some((s) => s.gateOpen)) return; // last mic hold
    const pw = am.map((s) => Math.pow(10, s.amEnv / 10));
    const tot = pw.reduce((a, b) => a + b, 0);
    am.forEach((s, i) => {
      const want = Math.max(10 * Math.log10(pw[i] / tot + FSM_EPS), -20);
      s.amDb = want > s.amDb ? Math.min(want, s.amDb + 200 * this.dt) : Math.max(want, s.amDb - 40 * this.dt);
    });
  }

  ducking(m) {
    const dt = this.dt;
    this.speechActive = this.strips.some((s) => s.on && s.ducksMusic && s.gateOpen);
    if (m.ducking === "auto" && this.speechActive) this.duckHold = 0.5; else this.duckHold -= dt;
    const want = this.duckHold > 0 ? m.duck_depth_db : 0;
    this.duckDb = want < this.duckDb ? Math.max(want, this.duckDb - 40 * dt) : Math.min(want, this.duckDb + 8 * dt);
  }

  resetPeaks() {
    this.pkIn = new Float64Array(this.strips.length);
    this.pkOut = new Float64Array(this.strips.length);
    this.pkMaster = [0, 0];
  }

  accumulateMeters() {
    const n = this.block;
    this.strips.forEach((s, i) => {
      let pk = 0;
      for (let k = 0; k < n; k++) { const a = Math.abs(s.raw[k]); if (a > pk) pk = a; }
      if (pk > this.pkIn[i]) this.pkIn[i] = pk;
      if (s._outPk > this.pkOut[i]) this.pkOut[i] = s._outPk;
    });
    for (let k = 0; k < n; k++) {
      const l = Math.abs(this.outL[k]), r = Math.abs(this.outR[k]);
      if (l > this.pkMaster[0]) this.pkMaster[0] = l;
      if (r > this.pkMaster[1]) this.pkMaster[1] = r;
    }
  }

  readMeters() {
    const r1 = (v) => Math.round(v * 10) / 10;
    const out = {
      channels: this.strips.map((s, i) => ({
        in_peak: lin2db(this.pkIn[i]), out_peak: lin2db(this.pkOut[i]),
        out_level: Math.max(10 * Math.log10(s._outMs + FSM_EPS), -120),
        level: r1(s.level), noise_floor: r1(s.noiseFloor), active: s.gateOpen,
        gate_db: r1(s.gateDb), leveler_db: r1(s.levDb), comp_db: r1(s.grDb),
        share_db: r1(s.amDb), duck_db: s.p.duckable ? r1(this.duckDb) : 0, solo: s.solo,
        tune_note: s.tuning && s.tuner && s.tuner.note !== null ? fsmNoteName(s.tuner.note) : null,
        tune_cents: s.tuning && s.tuner ? r1(s.tuner.cents) : 0,
      })),
      master: {
        peak_l: lin2db(this.pkMaster[0]), peak_r: lin2db(this.pkMaster[1]),
        momentary: r1(this.postMeter.momentary), short_term: r1(this.postMeter.shortTerm),
        loudness_gain_db: r1(this.agcDb), limiter_db: r1(lin2db(this.limiter.lastMinGain)),
        speech_active: this.speechActive, duck_db: r1(this.duckDb),
        bypass: !!this.cfg.master.bypass, solo_active: this.anySolo, dsp_load: r1(this.load * 100), xruns: this.xruns,
        sample_rate: this.fs, block: this.block,
      },
    };
    this.resetPeaks();
    return out;
  }
}

// ---------------------------------------------------------------- config helpers

function fsmNum(v, lo, hi) {
  v = Number(v);
  if (!Number.isFinite(v)) throw new Error("not a number");
  return clamp(v, lo, hi);
}

function fsmValidateChannel(ch) {
  const out = {};
  for (const [k, v] of Object.entries(ch)) {
    if (k === "name") out[k] = String(v).slice(0, 32);
    else if (k === "type") { if (!(v in FSM_PRESETS)) throw new Error(`unknown type ${v}`); out[k] = v; }
    else if (k === "trim_db") out[k] = fsmNum(v, -24, 24);
    else if (k === "fader_db") out[k] = fsmNum(v, -60, 12);
    else if (k === "pan") out[k] = fsmNum(v, -1, 1);
    else if (k === "reverb_db") out[k] = v === null ? null : fsmNum(v, -60, 0);
    else if (k === "mute" || k === "link" || k === "solo" || k === "tune") out[k] = !!v;
    else if (k === "tune_amount") out[k] = fsmNum(v, 0, 100);
    else if (k === "tune_speed_ms") out[k] = fsmNum(v, 10, 500);
    else if (k === "ducks_music") out[k] = v === null ? null : !!v;
    else if (k === "input") out[k] = Math.max(1, v | 0);
    else throw new Error(`unknown channel setting ${k}`);
  }
  return out;
}

function fsmValidateMaster(m) {
  const out = {};
  for (const [k, v] of Object.entries(m)) {
    if (k === "target_lufs") out[k] = fsmNum(v, -30, -8);
    else if (k === "ceiling_db") out[k] = fsmNum(v, -6, 0);
    else if (k === "duck_depth_db") out[k] = fsmNum(v, -24, 0);
    else if (k === "reverb_return_db" || k === "output_trim_db") out[k] = fsmNum(v, -24, 12);
    else if (k === "ducking") { if (v !== "auto" && v !== "off") throw new Error("ducking must be auto or off"); out[k] = v; }
    else if (k === "bypass") out[k] = !!v;
    else if (k === "tune_key") { if (!FSM_KEYS.includes(v)) throw new Error(`unknown key ${v}`); out[k] = v; }
    else throw new Error(`unknown master setting ${k}`);
  }
  return out;
}

function fsmNormalize(cfg) {
  cfg = cfg || {};
  const out = {
    audio: Object.assign({}, FSM_DEFAULT_AUDIO, cfg.audio || {}),
    master: Object.assign({}, FSM_DEFAULT_MASTER, fsmValidateMaster(Object.assign({}, cfg.master || {}))),
    channels: [],
  };
  (cfg.channels || []).forEach((ch, i) => {
    const c = Object.assign({}, FSM_CHANNEL_DEFAULTS, { input: i + 1 });
    const known = {};
    for (const k of Object.keys(ch)) if (k in FSM_CHANNEL_DEFAULTS || k === "input") known[k] = ch[k];
    Object.assign(c, fsmValidateChannel(known));
    if (!c.name) c.name = `Ch ${c.input}`;
    c.solo = false; // solo never survives a reload
    out.channels.push(c);
  });
  return out;
}

/** Guess a source type from a track name like "03 Pastor Lav.wav". */
function fsmGuessType(name) {
  const s = name.toLowerCase();
  const has = (...w) => w.some((x) => s.includes(x));
  if (has("click", "cue", "talkback", "tb ")) return "off";
  if (has("pastor", "preach", "speak", "pulpit", "lectern", "podium", "announce", "host", "lav", "headset", "prayer")) return "speech";
  if (has("bgv", "bv", "backing", "harmony", "choir")) return "bg_vocal";
  if (has("vox", "vocal", "voc", "lead", "wl", "sing")) return "lead_vocal";
  if (has("kick", "snare", "tom", "hat", "oh", "overhead", "drum", "cajon", "perc")) return "drums";
  if (has("track", "playback", "pb", "video", "laptop", "media", "propres", "spotify", "ipad")) return "playback";
  return "instrument";
}

// Worklet files load as ES modules, so share what worklet.js needs explicitly.
if (typeof AudioWorkletGlobalScope !== "undefined") {
  Object.assign(globalThis, { Engine, fsmBlockSize });
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { PitchCorrector, fsmScaleNotes, fsmNoteName, FSM_KEYS, Engine, Limiter, Reverb, LoudnessMeter, FilterChain, biquad, fft, db2lin, lin2db,
    fsmBlockSize, fsmNormalize, fsmGuessType, FSM_PRESETS, FSM_TYPE_ORDER, FSM_CHANNEL_DEFAULTS };
}
