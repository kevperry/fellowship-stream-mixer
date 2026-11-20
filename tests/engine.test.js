// Tests for the browser engine (docs/engine.js). Run: node --test tests/
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const E = require("../docs/engine.js");

const FS = 48000;
const BLOCK = E.fsmBlockSize(FS);

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) + 1) / 4294967297;
  };
}
function noise(seconds, db, seed) {
  const r = rng(seed), n = Math.floor(seconds * FS), x = new Float64Array(n), g = E.db2lin(db);
  for (let i = 0; i < n; i++) x[i] = Math.sqrt(-2 * Math.log(r())) * Math.cos(2 * Math.PI * r()) * g;
  return x;
}
function speech(seconds, db, seed = 1) {
  // band-limited noise with syllables and pauses, plus room noise
  const x = noise(seconds, 0, seed);
  new E.FilterChain([E.biquad("highpass", 200, FS), E.biquad("lowpass", 4000, FS)]).process(x);
  let ss = 0, cnt = 0;
  for (let i = 0; i < x.length; i++) {
    const t = i / FS;
    const syll = Math.pow(Math.max(0, Math.sin(2 * Math.PI * 4 * t)), 0.7);
    const phrase = Math.sin(2 * Math.PI * 0.25 * t) > -0.6 ? 1 : 0;
    x[i] *= syll * phrase;
    if (phrase) { ss += x[i] * x[i]; cnt++; }
  }
  const k = E.db2lin(db) / Math.sqrt(ss / cnt);
  const room = noise(seconds, -66, seed + 11);
  for (let i = 0; i < x.length; i++) x[i] = x[i] * k + room[i];
  return x;
}
function music(seconds, db) {
  const n = Math.floor(seconds * FS), x = new Float64Array(n);
  const f = [110, 220, 277.2, 329.6, 440];
  for (let i = 0; i < n; i++) for (const fr of f) x[i] += Math.sin(2 * Math.PI * fr * i / FS);
  const k = E.db2lin(db) / Math.sqrt(f.length / 2);
  for (let i = 0; i < n; i++) x[i] *= k;
  return x;
}
function engine(types, master = {}) {
  const channels = types.map((t, i) => ({ input: i + 1, name: t, type: t }));
  return new E.Engine({ channels, master }, FS, BLOCK);
}
function run(eng, tracks) {
  const n = Math.floor(tracks[0].length / BLOCK) * BLOCK;
  let peak = 0;
  for (let i = 0; i < n; i += BLOCK) {
    const [l, r] = eng.process(tracks.map((t) => t.subarray(i, i + BLOCK)));
    for (let k = 0; k < BLOCK; k++) peak = Math.max(peak, Math.abs(l[k]), Math.abs(r[k]));
  }
  return peak;
}

test("block size is a power of two around 10 ms", () => {
  assert.equal(E.fsmBlockSize(48000), 512);
  assert.equal(E.fsmBlockSize(44100), 512);
  assert.equal(E.fsmBlockSize(96000), 1024);
});

test("fft round trip", () => {
  const re = Float64Array.from({ length: 64 }, (_, i) => Math.sin(i) + i * 0.01), im = new Float64Array(64);
  const orig = re.slice();
  E.fft(re, im, false); E.fft(re, im, true);
  for (let i = 0; i < 64; i++) assert.ok(Math.abs(re[i] - orig[i]) < 1e-9);
});

test("limiter never exceeds the ceiling and is transparent below it", () => {
  const lim = new E.Limiter(FS, BLOCK, -1);
  const hot = noise(2, 4, 3);
  const L = new Float64Array(BLOCK), R = new Float64Array(BLOCK);
  let peak = 0;
  for (let i = 0; i + BLOCK <= hot.length; i += BLOCK) {
    lim.process(hot.subarray(i, i + BLOCK), hot.subarray(i, i + BLOCK), L, R);
    for (const v of L) peak = Math.max(peak, Math.abs(v));
  }
  assert.ok(peak <= E.db2lin(-1) + 1e-12, `peak ${peak}`);

  const quiet = new E.Limiter(FS, BLOCK, -1);
  const x = Float64Array.from({ length: BLOCK * 6 }, (_, i) => 0.3 * Math.sin(i * 0.05));
  const outs = [];
  for (let i = 0; i < x.length; i += BLOCK) {
    quiet.process(x.subarray(i, i + BLOCK), x.subarray(i, i + BLOCK), L, R);
    outs.push(...L);
  }
  for (let i = BLOCK; i < x.length; i++) assert.ok(Math.abs(outs[i] - x[i - BLOCK]) < 1e-9);
});

test("stream loudness reaches the target", () => {
  const eng = engine(["speech"], { target_lufs: -16 });
  const peak = run(eng, [speech(40, -32)]);
  const m = eng.readMeters().master;
  assert.ok(Math.abs(m.short_term + 16) < 1.5, JSON.stringify(m));
  assert.ok(peak <= E.db2lin(-1) + 1e-9);
});

test("idle mic is gated, talking mic stays open", () => {
  const eng = engine(["lead_vocal", "lead_vocal"]);
  run(eng, [speech(15, -22), noise(15, -66, 1)]);
  const [talking, idle] = eng.strips;
  assert.equal(idle.gateDb, idle.p.gate_range);
  assert.equal(idle.gateOpen, false);
  assert.ok(talking.noiseFloor < -50);
});

test("speech mics share gain", () => {
  const eng = engine(["speech", "speech"], { ducking: "off" });
  const a = speech(10, -20), b = noise(10, -66, 4);
  const [talk, idle] = eng.strips;
  let minTalk = 0; const idleShares = [];
  for (let i = 0; i + BLOCK <= a.length; i += BLOCK) {
    eng.process([a.subarray(i, i + BLOCK), b.subarray(i, i + BLOCK)]);
    if (i > 2 * FS) { minTalk = Math.min(minTalk, talk.amDb); idleShares.push(idle.amDb); }
  }
  idleShares.sort((x, y) => x - y);
  assert.ok(minTalk > -3, `talker dipped to ${minTalk}`);
  assert.ok(idleShares[idleShares.length >> 1] < -10);
});

test("music ducks under speech and recovers", () => {
  const eng = engine(["speech", "instrument"], { duck_depth_db: -9 });
  const sp = new Float64Array(15 * FS);
  sp.set(noise(5, -66, 2)); sp.set(speech(10, -20), 5 * FS);
  run(eng, [sp, music(15, -24)]);
  assert.ok(eng.duckDb < -8);
  run(eng, [noise(4, -66, 9), music(4, -24)]);
  assert.ok(eng.duckDb > -0.5);
});

test("ducking can be switched off", () => {
  const eng = engine(["speech", "instrument"], { ducking: "off" });
  run(eng, [speech(6, -20), music(6, -24)]);
  assert.equal(eng.duckDb, 0);
});

test("leveler lifts a quiet talker", () => {
  const eng = engine(["speech"]);
  run(eng, [speech(30, -32)]);
  assert.ok(eng.strips[0].levDb > 6);
});

test("bypass crossfade and reverb stay clean", () => {
  const eng = engine(["lead_vocal", "instrument"]);
  const v = speech(4, -20), mu = music(4, -24);
  let prev = 0, maxJump = 0;
  for (let i = 0; i + BLOCK <= v.length; i += BLOCK) {
    if (i >= 2 * FS && !eng.cfg.master.bypass) eng.updateMaster({ bypass: true });
    const [l] = eng.process([v.subarray(i, i + BLOCK), mu.subarray(i, i + BLOCK)]);
    for (const s of l) { assert.ok(Number.isFinite(s)); maxJump = Math.max(maxJump, Math.abs(s - prev)); prev = s; }
  }
  assert.ok(maxJump < 0.5);
});

test("config validation", () => {
  const eng = engine(["speech", "instrument"]);
  eng.updateChannel(1, { type: "playback", mute: true });
  assert.equal(eng.strips[1].type, "playback");
  assert.throws(() => eng.updateChannel(0, { type: "kazoo" }));
  assert.equal(E.fsmGuessType("03 Pastor Lav.wav"), "speech");
  assert.equal(E.fsmGuessType("Kick In.wav"), "drums");
  assert.equal(E.fsmGuessType("Click.wav"), "off");
  assert.equal(E.fsmGuessType("BGV 2.wav"), "bg_vocal");
});

test("16 channels at 96 kHz run inside real time", () => {
  const fs = 96000, block = E.fsmBlockSize(fs);
  const chans = ["speech", "speech", "lead_vocal", "bg_vocal", "bg_vocal", "instrument", "instrument",
    "instrument", "instrument", "instrument", "drums", "drums", "drums", "drums", "playback", "playback"]
    .map((t, i) => ({ input: i + 1, type: t, reverb_db: t.includes("vocal") ? -14 : null }));
  const eng = new E.Engine({ channels: chans }, fs, block);
  const r = rng(5);
  const ins = Array.from({ length: 16 }, () => Float64Array.from({ length: block }, () => (r() - 0.5) * 0.1));
  for (let i = 0; i < 30; i++) eng.process(ins);
  const t0 = performance.now(), N = 200;
  for (let i = 0; i < N; i++) eng.process(ins);
  const per = (performance.now() - t0) / N;
  console.log(`  16 ch @ 96 kHz: ${per.toFixed(2)} ms per ${(1000 * block / fs).toFixed(1)} ms block`);
  assert.ok(per < 1000 * block / fs * 0.6);
});
