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

// BEGIN PRESETS (generated from fsm/presets.py by `python -m fsm.jsdata`; -Infinity is null)
const FSM_PRESETS = {
  "speech": {"label": "Speaker / Pastor", "hpf": 90, "hpf_order": 4, "target_db": -20.0, "leveler_range": 12.0, "gate_range": -12.0, "gate_hold": 0.3, "automix": true, "ducks_music": true, "duckable": false, "reverb_db": null},
  "lead_vocal": {"label": "Vocal", "hpf": 100, "hpf_order": 4, "target_db": -20.0, "leveler_range": 9.0, "gate_range": -10.0, "gate_hold": 0.4, "automix": false, "ducks_music": false, "duckable": false, "reverb_db": -16.0},
  "instrument": {"label": "Instrument", "hpf": 40, "hpf_order": 2, "target_db": -24.0, "leveler_range": 6.0, "gate_range": 0.0, "gate_hold": 0.5, "automix": false, "ducks_music": false, "duckable": true, "reverb_db": null},
  "drums": {"label": "Drums", "hpf": 45, "hpf_order": 2, "target_db": -26.0, "leveler_range": 4.0, "gate_range": 0.0, "gate_hold": 0.5, "automix": false, "ducks_music": false, "duckable": true, "reverb_db": null},
  "playback": {"label": "Playback (video / tracks)", "hpf": 25, "hpf_order": 2, "target_db": -22.0, "leveler_range": 6.0, "gate_range": 0.0, "gate_hold": 0.5, "automix": false, "ducks_music": false, "duckable": true, "reverb_db": null},
  "off": {"label": "Off", "hpf": 20, "hpf_order": 2, "target_db": -24.0, "leveler_range": 0.0, "gate_range": 0.0, "gate_hold": 0.5, "automix": false, "ducks_music": false, "duckable": false, "reverb_db": null}
};
// END PRESETS
// BEGIN TONE (generated from fsm/tone.py by `python -m fsm.jsdata`)
const FSM_TONE = {"bands": [125, 250, 500, 1000, 2000, 4000, 8000], "eq_presets": {"speech": {"label": "Spoken voice", "tolerance": 2.0, "target": {"250": 1, "500": 0, "1000": -5, "2000": -7, "4000": -10, "8000": -14}}, "vocal": {"label": "Vocal", "tolerance": 2.0, "target": {"250": -2, "500": 0, "1000": -6, "2000": -8, "4000": -13, "8000": -12}}, "keys": {"label": "Keys / piano", "tolerance": 4.0, "target": {"125": -10, "250": -2, "500": 0, "1000": -6, "2000": -10}}, "guitar": {"label": "Guitar", "tolerance": 4.0, "target": {"125": -2, "250": 3, "500": 0, "1000": -2, "2000": -2, "4000": -7}}, "bass": {"label": "Bass", "tolerance": 4.0, "target": {"125": 33, "250": 26, "500": 0}}, "drums": {"label": "Drum kit / overheads", "tolerance": 4.0, "target": {"250": 5, "500": 0, "1000": -6, "2000": -7, "4000": -6, "8000": -8}}, "instrument": {"label": "Instrument (general)", "tolerance": 4.0, "target": {"125": 2, "250": 2, "500": 0, "1000": -2, "2000": -4, "4000": -6, "8000": -8}}, "off": {"label": "Off (flat)", "tolerance": 2.0, "target": {}}}, "max_cut": 6.0, "tolerance": 2.0, "max_boost": {"125": 0.0, "250": 0.0, "500": 1.5, "1000": 3.0, "2000": 3.0, "4000": 3.0, "8000": 3.0}, "comp_levels": {"off": {"label": "Off", "ratio": 1.0, "above": 0.0}, "light": {"label": "Light", "ratio": 1.5, "above": 6.0}, "mild": {"label": "Mild", "ratio": 2.0, "above": 4.0}, "medium": {"label": "Medium", "ratio": 3.0, "above": 3.0}, "firm": {"label": "Firm", "ratio": 4.0, "above": 2.0}}};
// END TONE
const FSM_TYPE_ORDER = ["speech", "lead_vocal", "instrument", "drums", "playback", "off"];
const FSM_MUSIC_TYPES = ["instrument", "drums", "playback"];
const FSM_RENAMED_TYPES = { bg_vocal: "lead_vocal" };

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
  auto_level: true, level_range: null, level_speed: null,
  eq_preset: null, eq_amount: 50, comp: null,
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
const FSM_VOCAL_TYPES = ["lead_vocal"];
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

// ---------------------------------------------------------------- adaptive EQ & compressor
// Port of fsm/tone.py. Targets and limits come from FSM_TONE (generated from Python).

const EQ_SLEW_DB_PER_S = 0.5, EQ_LISTEN_SECONDS = 20, EQ_WARMUP_SECONDS = 3, EQ_HOP = 4;

function fsmDefaultEqPreset(type, name) {
  const n = (name || "").toLowerCase(), has = (...w) => w.some((x) => n.includes(x));
  if (type === "speech") return "speech";
  if (type === "lead_vocal") return "vocal";
  if (type === "drums") return has("kick", "kik", "snare", "snr", "tom", "hat", "hh", "cajon") ? "off" : "drums";
  if (type === "instrument") {
    if (has("bass")) return "bass";
    if (has("gtr", "guitar", "acoustic", "electric", "ag ", "eg ")) return "guitar";
    if (has("key", "piano", "organ", "synth", "pad", "rhodes", "nord")) return "keys";
    return "instrument";
  }
  return "off";
}
function fsmDefaultComp(type) { return type === "playback" ? "light" : type === "off" ? "off" : "mild"; }

class AdaptiveEQ {
  constructor(fs, block, stagger = 0) {
    this.fs = fs; this.n = block; this.dt = block / fs;
    this.N = 1 << Math.max(9, Math.round(Math.log2(0.043 * fs)));
    this.buf = new Float64Array(this.N);
    this.win = Float64Array.from({ length: this.N }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (this.N - 1)));
    this.re = new Float64Array(this.N); this.im = new Float64Array(this.N);
    const bands = FSM_TONE.bands;
    this.bandBins = bands.map((fc) => {
      const lo = Math.ceil(fc / Math.SQRT2 * this.N / fs), hi = Math.ceil(fc * Math.SQRT2 * this.N / fs);
      return [lo, Math.min(hi, this.N / 2 + 1)];
    });
    this.meas = null; this.heard = 0;
    this.gains = new Float64Array(bands.length);
    this.applied = new Float64Array(bands.length);
    this.chain = new FilterChain(this._sections(this.applied));
    this.count = stagger % EQ_HOP;
  }
  _sections(g) { return FSM_TONE.bands.map((fc, i) => biquad("peak", fc, this.fs, g[i], 1.2)); }

  measure(x, active) {
    this.buf.copyWithin(0, x.length);
    this.buf.set(x, this.N - x.length);
    this.count++;
    if (!active || this.count % EQ_HOP) return;
    const re = this.re, im = this.im;
    for (let i = 0; i < this.N; i++) { re[i] = this.buf[i] * this.win[i]; im[i] = 0; }
    fft(re, im, false);
    const band = this.bandBins.map(([lo, hi]) => {
      let s = 0;
      for (let k = lo; k < hi; k++) s += re[k] * re[k] + im[k] * im[k];
      return 10 * Math.log10(s + 1e-20);
    });
    this.heard += EQ_HOP * this.dt;
    if (!this.meas) this.meas = band;
    else {
      const a = Math.max(EQ_HOP * this.dt / EQ_LISTEN_SECONDS, EQ_HOP * this.dt / this.heard);
      for (let i = 0; i < band.length; i++) this.meas[i] += (band[i] - this.meas[i]) * a;
    }
  }

  targetGains(preset, amount) {
    const bands = FSM_TONE.bands, want = new Float64Array(bands.length);
    const target = (FSM_TONE.eq_presets[preset] || FSM_TONE.eq_presets.off).target;
    const idx = bands.map((fc, i) => i).filter((i) => String(bands[i]) in target);
    const tolP = (FSM_TONE.eq_presets[preset] || {}).tolerance ?? FSM_TONE.tolerance;
    const warmup = tolP <= FSM_TONE.tolerance ? EQ_WARMUP_SECONDS : 8;
    if (!this.meas || this.heard < warmup || !idx.length || amount <= 0) return want;
    const dev = idx.map((i) => this.meas[i] - target[String(bands[i])]);
    const mean = dev.reduce((a, b) => a + b, 0) / dev.length;
    idx.forEach((i, j) => {
      const tol = FSM_TONE.eq_presets[preset].tolerance ?? FSM_TONE.tolerance;
      const dv = dev[j] - mean, d = Math.sign(dv) * Math.max(0, Math.abs(dv) - tol);
      want[i] = Math.max(-FSM_TONE.max_cut, Math.min(FSM_TONE.max_boost[String(bands[i])], -d * amount));
    });
    return want;
  }

  /** Filters ``x`` in place. */
  process(x, active, preset, amount) {
    this.measure(x, active);
    const want = this.targetGains(preset, amount), step = EQ_SLEW_DB_PER_S * this.dt;
    let maxDiff = 0, maxAbs = 0;
    for (let i = 0; i < want.length; i++) {
      this.gains[i] += clamp(want[i] - this.gains[i], -step, step);
      maxDiff = Math.max(maxDiff, Math.abs(this.gains[i] - this.applied[i]));
    }
    if (maxDiff > 0.05) { this.applied.set(this.gains); this.chain.s = this._sections(this.applied); }
    for (let i = 0; i < this.applied.length; i++) maxAbs = Math.max(maxAbs, Math.abs(this.applied[i]));
    if (maxAbs >= 0.01) this.chain.process(x);
  }
}

// ---------------------------------------------------------------- engine

const NF_MIN = -85, NF_MAX = -45, OPEN_ABOVE = 10, CLOSE_ABOVE = 6, NOISE_WINDOW_S = 20;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

class Strip {
  constructor(ch, fs, block, stagger = 0) {
    this.fs = fs; this.block = block; this.dt = block / fs;
    this.blocksPerS = Math.max(1, Math.round(fs / block));
    this.type = null;
    this.tuner = null; this.tuneMix = 0;
    this.adapt = new AdaptiveEQ(fs, block, stagger);
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
      const sections = highpassSections(this.p.hpf, this.fs, this.p.hpf_order);
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
    this.autoLevel = ch.auto_level === undefined ? true : !!ch.auto_level;
    this.levelRange = ch.level_range === null || ch.level_range === undefined ? null : Number(ch.level_range);
    this.levelSpeed = ch.level_speed === null || ch.level_speed === undefined ? 3 : Number(ch.level_speed);
    this.eqPreset = ch.eq_preset === null || ch.eq_preset === undefined ? fsmDefaultEqPreset(this.type, ch.name) : ch.eq_preset;
    this.eqAmount = Number(ch.eq_amount ?? 50) / 100;
    this.comp = ch.comp === null || ch.comp === undefined ? fsmDefaultComp(this.type) : ch.comp;
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

    // leveler: adjustable range and speed per channel; switched off, it glides back to 0 dB
    const levRange = this.levelRange === null ? p.leveler_range : this.levelRange;
    const rate = this.levelSpeed;
    let levWant = 0;
    if (this.autoLevel && levRange > 0) {
      if (this.gateOpen && level > this.noiseFloor + CLOSE_ABOVE) {
        const tau = clamp(4.5 / rate, 0.5, 4);
        this.avgDb += (level - this.avgDb) * (dt / tau);
        levWant = clamp(p.target_db - this.avgDb, -levRange, levRange);
      } else {
        levWant = clamp(this.levDb, -levRange, levRange);
      }
    }
    this.levDb += clamp(levWant - this.levDb, -rate * dt, rate * dt);

    const lv = level + this.levDb;
    this.amEnv = lv > this.amEnv ? lv : Math.max(lv, this.amEnv - 20 * dt);

    const comp = FSM_TONE.comp_levels[this.comp];
    const over = lv - (p.target_db + comp.above);
    const knee = 6, slope = 1 / comp.ratio - 1;
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
    this.strips = this.cfg.channels.map((ch, i) => new Strip(ch, fs, block, i));
    this.nInputs = Math.max(0, ...this.strips.map((s) => s.col + 1));
    this.reverb = new Reverb(fs, block);
    this.preMeter = new LoudnessMeter(fs, block);
    this.postMeter = new LoudnessMeter(fs, block);
    this.limiter = new Limiter(fs, block, this.cfg.master.ceiling_db);
    this.agcDb = 0; this.agcPrev = 1;
    this.duckDb = 0; this.duckHold = 0; this.speechActive = false; this.anySolo = false;
    this.musicHold = 0; this.musicActive = false; this.revGain = 1;
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
    const updated = fsmGang(this.cfg.channels, i, fsmValidateChannel(changes));
    for (const k of updated) this.strips[k].configure(this.cfg.channels[k]);
    return this.cfg.channels[i];
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
      if (s.type !== "off") {
        s.buf.set(s.raw); s.chain.process(s.buf);
        s.adapt.process(s.buf, s.gateOpen && s.level > s.noiseFloor + 12, s.eqPreset, s.eqAmount);
        levels.push(meanSquareDb(s.buf));
      }
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
    const revPrev = this.revGain;
    this.reverbRest();

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

    const rg0 = revPrev, drg = (this.revGain - revPrev) / n;
    if (rg0 !== 1 || drg !== 0) for (let i = 0; i < n; i++) send[i] *= rg0 + drg * (i + 1);
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

  /** Rest the reverb sends while no music is playing (see fsm/engine.py _reverb_rest). */
  reverbRest() {
    const dt = this.dt;
    const music = this.strips.filter((s) => s.on && FSM_MUSIC_TYPES.includes(s.type));
    if (!music.length) this.musicActive = true;
    else {
      if (music.some((s) => s.level > s.noiseFloor + 15)) this.musicHold = 1; else this.musicHold -= dt;
      this.musicActive = this.musicHold > 0;
    }
    this.revGain = this.musicActive ? Math.min(1, this.revGain + dt / 0.1) : Math.max(0, this.revGain - dt / 0.3);
  }

  ducking(m) {
    const dt = this.dt;
    this.speechActive = this.strips.some((s) => s.on && s.ducksMusic && s.gateOpen);
    if (this.speechActive) this.duckHold = 0.5; else this.duckHold -= dt;  // always automatic
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
        gate_db: r1(s.gateDb), leveler_db: r1(s.levDb), auto_level: s.autoLevel, comp_db: r1(s.grDb),
        eq_gains: Array.from(s.adapt.gains, r1), eq_preset: s.eqPreset, comp: s.comp,
        share_db: r1(s.amDb), duck_db: s.p.duckable ? r1(this.duckDb) : 0, solo: s.solo,
        tune_note: s.tuning && s.tuner && s.tuner.note !== null ? fsmNoteName(s.tuner.note) : null,
        tune_cents: s.tuning && s.tuner ? r1(s.tuner.cents) : 0,
      })),
      master: {
        peak_l: lin2db(this.pkMaster[0]), peak_r: lin2db(this.pkMaster[1]),
        momentary: r1(this.postMeter.momentary), short_term: r1(this.postMeter.shortTerm),
        loudness_gain_db: r1(this.agcDb), limiter_db: r1(lin2db(this.limiter.lastMinGain)),
        speech_active: this.speechActive, duck_db: r1(this.duckDb),
        music_active: this.musicActive, reverb_resting: this.revGain < 0.5,
        bypass: !!this.cfg.master.bypass, solo_active: this.anySolo, dsp_load: r1(this.load * 100), xruns: this.xruns,
        sample_rate: this.fs, block: this.block,
      },
    };
    this.resetPeaks();
    return out;
  }
}

// ---------------------------------------------------------------- stereo link

/** Settings a stereo-linked pair shares (everything except pan, name, solo). */
const FSM_GANGED = ["fader_db", "mute", "trim_db", "reverb_db", "type", "tune", "tune_amount",
  "tune_speed_ms", "ducks_music", "auto_level", "level_range", "level_speed", "eq_preset", "eq_amount", "comp"];

function fsmLinkGroup(channels, index) {
  let lo = index, hi = index;
  while (lo > 0 && channels[lo].link) lo--;
  while (hi + 1 < channels.length && channels[hi + 1].link) hi++;
  const out = [];
  for (let k = lo; k <= hi; k++) out.push(k);
  return out;
}

/** Apply validated changes to a channel and its linked partners; returns the changed indices. */
function fsmGang(channels, index, changes) {
  const ch = Object.assign({}, channels[index], changes);
  if (ch.link && index === 0) ch.link = false;
  channels[index] = ch;
  const updated = new Set([index]);
  const group = fsmLinkGroup(channels, index);
  if (changes.link && index > 0) {
    const src = channels[group[0]];
    for (const k of group) {
      if (k === group[0]) continue;
      const copy = {};
      for (const g of FSM_GANGED) if (g in src) copy[g] = src[g];
      channels[k] = Object.assign({}, channels[k], copy);
      updated.add(k);
    }
  } else {
    const shared = {};
    for (const [k, v] of Object.entries(changes)) if (FSM_GANGED.includes(k)) shared[k] = v;
    if (Object.keys(shared).length) {
      for (const k of group) if (k !== index) { channels[k] = Object.assign({}, channels[k], shared); updated.add(k); }
    }
  }
  return [...updated].sort((a, b) => a - b);
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
    else if (k === "auto_level") out[k] = !!v;
    else if (k === "eq_preset") { if (v !== null && !(v in FSM_TONE.eq_presets)) throw new Error(`unknown EQ preset ${v}`); out[k] = v; }
    else if (k === "eq_amount") out[k] = fsmNum(v, 0, 100);
    else if (k === "comp") { if (v !== null && !(v in FSM_TONE.comp_levels)) throw new Error(`unknown compressor setting ${v}`); out[k] = v; }
    else if (k === "level_range") out[k] = v === null ? null : fsmNum(v, 0, 24);
    else if (k === "level_speed") out[k] = v === null ? null : fsmNum(v, 0.5, 12);
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
    if (known.type in FSM_RENAMED_TYPES) known.type = FSM_RENAMED_TYPES[known.type];
    Object.assign(c, fsmValidateChannel(known));
    if (!c.name) c.name = `Ch ${c.input}`;
    c.solo = false; // solo never survives a reload
    out.channels.push(c);
  });
  // a stereo-linked channel shares its left partner's settings (except pan, name, solo)
  out.channels.forEach((c, i) => {
    if (i === 0) { c.link = false; return; }
    if (c.link) for (const g of FSM_GANGED) c[g] = out.channels[i - 1][g];
  });
  return out;
}

/** Guess a source type from a track name like "03 Pastor Lav.wav". */
function fsmGuessType(name) {
  const s = name.toLowerCase();
  const has = (...w) => w.some((x) => s.includes(x));
  if (has("click", "cue", "talkback", "tb ")) return "off";
  if (has("pastor", "preach", "speak", "pulpit", "lectern", "podium", "announce", "host", "lav", "headset", "prayer")) return "speech";
  if (has("vox", "vocal", "voc", "lead", "wl", "sing", "bgv", "bv", "backing", "harmony", "choir")) return "lead_vocal";
  if (has("kick", "snare", "tom", "hat", "oh", "overhead", "drum", "cajon", "perc")) return "drums";
  if (has("track", "playback", "pb", "video", "laptop", "media", "propres", "spotify", "ipad")) return "playback";
  return "instrument";
}

// Worklet files load as ES modules, so share what worklet.js needs explicitly.
if (typeof AudioWorkletGlobalScope !== "undefined") {
  Object.assign(globalThis, { Engine, fsmBlockSize });
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { AdaptiveEQ, FSM_TONE, fsmDefaultEqPreset, fsmDefaultComp, fsmGang, fsmLinkGroup, FSM_GANGED, PitchCorrector, fsmScaleNotes, fsmNoteName, FSM_KEYS, Engine, Limiter, Reverb, LoudnessMeter, FilterChain, biquad, fft, db2lin, lin2db,
    fsmBlockSize, fsmNormalize, fsmGuessType, FSM_PRESETS, FSM_TYPE_ORDER, FSM_CHANNEL_DEFAULTS };
}
