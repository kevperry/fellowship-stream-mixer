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

// ---- solo and pitch correction -------------------------------------------------

function sung(freq, seconds, level = 0.1) {
  const n = Math.floor(seconds * FS), x = new Float64Array(n), room = noise(seconds, -66, 21);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let h = 1; h <= 7; h++) v += Math.sin(2 * Math.PI * freq * h * i / FS) / h;
    x[i] = v * level + room[i];
  }
  return x;
}
function centsOf(y, ref) {
  // measure with a fresh corrector's detector (amount 0 leaves the signal alone)
  const pc = new E.PitchCorrector(FS, BLOCK);
  let f = null;
  for (let i = y.length - 20 * BLOCK; i + BLOCK <= y.length; i += BLOCK) { pc.process(y.subarray(i, i + BLOCK), true, 0, 40, E.fsmScaleNotes("chromatic")); f = pc.f0 || f; }
  return 1200 * Math.log2(f / ref);
}
function tune(x, amount, key = "chromatic") {
  const pc = new E.PitchCorrector(FS, BLOCK), y = new Float64Array(x.length);
  for (let i = 0; i + BLOCK <= x.length; i += BLOCK) y.set(pc.process(x.subarray(i, i + BLOCK), true, amount, 40, E.fsmScaleNotes(key)), i);
  return { y, pc };
}

test("pitch correction amounts", () => {
  const x = sung(440 * Math.pow(2, 30 / 1200), 2);
  assert.ok(Math.abs(centsOf(x, 440) - 30) < 2);
  for (const [amount, expect] of [[1, 0], [0.5, 15], [0, 30]]) {
    const c = centsOf(tune(x, amount).y, 440);
    assert.ok(Math.abs(c - expect) < 2, `amount ${amount}: ${c}`);
  }
});

test("in-tune singing passes through untouched", () => {
  const x = sung(440, 1), { y } = tune(x, 1), D = Math.floor(0.02 * FS);
  for (let i = D; i + BLOCK < y.length - BLOCK; i += 37) assert.ok(Math.abs(y[i] - x[i - D]) < 1e-9);
});

test("pitch correction respects the key", () => {
  const { pc } = tune(sung(277.18 * Math.pow(2, 20 / 1200), 1.5), 1, "C major");
  assert.equal(pc.note, 62);
  assert.equal(E.FSM_KEYS.length, 25);
  assert.equal(E.fsmNoteName(69), "A4");
});

test("solo in place with linked pairs, and tune only on vocals", () => {
  const eng = new E.Engine({ channels: [
    { input: 1, type: "instrument", pan: -1 }, { input: 2, type: "instrument", pan: 1, link: true },
    { input: 3, type: "lead_vocal" }, { input: 4, type: "speech" }] }, FS, BLOCK);
  const tracks = [music(3, -24), music(3, -24), sung(440 * Math.pow(2, 25 / 1200), 3, 0.2), noise(3, -66, 3)];
  eng.updateChannel(2, { tune: true, tune_amount: 100, tune_speed_ms: 40 });
  eng.updateChannel(3, { tune: true });
  run(eng, tracks);
  assert.ok(eng.strips[2].tuning && !eng.strips[3].tuning && eng.strips[3].tuner === null);
  assert.ok(Math.abs(eng.strips[2].tuner.cents + 25) < 3);
  const mt = eng.readMeters().channels[2];
  assert.equal(mt.tune_note, "A4");

  eng.updateChannel(0, { solo: true });
  run(eng, tracks.map((t) => t.subarray(0, FS)));
  assert.ok(eng.strips[0].gainPrev > 0 && eng.strips[1].gainPrev > 0, "linked partner plays");
  assert.equal(eng.strips[2].gainPrev, 0);
  assert.ok(eng.readMeters().master.solo_active);
  eng.clearSolo();
  run(eng, tracks.map((t) => t.subarray(0, FS)));
  assert.ok(!eng.anySolo && eng.strips[2].gainPrev > 0);
  assert.equal(E.fsmNormalize({ channels: [{ type: "speech", solo: true }] }).channels[0].solo, false);
  assert.throws(() => eng.updateMaster({ tune_key: "H major" }));
});

test("link gangs faders and settings but not pan", () => {
  const chans = [{ input: 1, name: "Keys L", type: "instrument", pan: -1, fader_db: -3 },
    { input: 2, name: "Keys R", type: "instrument", pan: 1, fader_db: 2 }, { input: 3, name: "Bass", type: "instrument" }];
  const eng = new E.Engine({ channels: chans }, FS, BLOCK);
  eng.updateChannel(1, { link: true });
  assert.equal(eng.cfg.channels[1].fader_db, -3);
  eng.updateChannel(1, { fader_db: -7.5 });
  eng.updateChannel(0, { mute: true, pan: -0.5 });
  const [a, b, c] = eng.cfg.channels;
  assert.ok(a.fader_db === -7.5 && b.fader_db === -7.5 && a.mute && b.mute && eng.strips[1].mute);
  assert.equal(b.pan, 1); assert.equal(c.fader_db, 0);
  // the page keeps its own copy of the settings and uses the same rule
  const page = JSON.parse(JSON.stringify(eng.cfg.channels));
  assert.deepEqual(E.fsmGang(page, 0, { fader_db: 4 }), [0, 1]);
  assert.equal(page[1].fader_db, 4);
  const loaded = E.fsmNormalize({ channels: [{ type: "playback", fader_db: -4, link: true }, { type: "instrument", fader_db: 3, pan: 1, link: true }] }).channels;
  assert.ok(!loaded[0].link && loaded[1].type === "playback" && loaded[1].fader_db === -4 && loaded[1].pan === 1);
});
