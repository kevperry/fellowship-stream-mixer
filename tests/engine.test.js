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

test("ducking is automatic; a mic can be told not to duck music", () => {
  const old = engine(["speech", "instrument"], { ducking: "off" });
  run(old, [speech(6, -20), music(6, -24)]);
  assert.ok(old.duckDb < -8);
  const eng = engine(["speech", "instrument"]);
  eng.updateChannel(0, { ducks_music: false });
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
  assert.equal(E.fsmGuessType("BGV 2.wav"), "lead_vocal");
});

test("16 channels at 96 kHz run inside real time", () => {
  const fs = 96000, block = E.fsmBlockSize(fs);
  const chans = ["speech", "speech", "lead_vocal", "lead_vocal", "lead_vocal", "instrument", "instrument",
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
  assert.equal(eng.cfg.channels[0].pan, -1); assert.equal(eng.cfg.channels[1].pan, 1);  // one stereo source
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

test("auto-level range, speed and off", () => {
  const quiet = speech(20, -34);
  const mk = (changes) => { const e = engine(["speech"]); if (changes) e.updateChannel(0, changes); return e; };
  const def = mk(); run(def, [quiet]); assert.ok(def.strips[0].levDb > 10);
  const narrow = mk({ level_range: 3 }); run(narrow, [quiet]);
  assert.ok(narrow.strips[0].levDb > 2.5 && narrow.strips[0].levDb <= 3);
  const four = quiet.subarray(0, 4 * FS);
  const slow = mk({ level_speed: 1 }); run(slow, [four]);
  const fast = mk({ level_speed: 10 }); run(fast, [four]);
  assert.ok(fast.strips[0].levDb > slow.strips[0].levDb + 3);
  def.updateChannel(0, { auto_level: false }); run(def, [quiet.subarray(0, 6 * FS)]);
  assert.equal(def.strips[0].levDb, 0);
  assert.equal(def.readMeters().channels[0].auto_level, false);
});

test("reverb rests when a vocalist talks without music", () => {
  const eng = engine(["lead_vocal", "instrument"]);
  const band = [sung(440, 6, 0.2), music(6, -24)], talk = [speech(6, -20), noise(6, -66, 5)];
  run(eng, band);
  assert.ok(eng.musicActive && eng.revGain === 1);
  run(eng, talk.map((t) => t.subarray(0, Math.floor(0.5 * FS))));
  assert.equal(eng.revGain, 1);
  run(eng, talk);
  assert.ok(!eng.musicActive && eng.revGain === 0 && eng.readMeters().master.reverb_resting);
  run(eng, band.map((t) => t.subarray(0, Math.floor(0.2 * FS))));
  assert.equal(eng.revGain, 1);
  const acap = engine(["lead_vocal", "speech"]);
  run(acap, [speech(5, -20), noise(5, -66, 2)]);
  assert.equal(acap.revGain, 1);
});

test("adaptive EQ cuts boom, never boosts lows; compressor strengths", () => {
  // a talker whose tone matches the spoken-voice target, with per-band tweaks in dB
  const voice = (secs, tweak = {}, seed = 4) => {
    const n = Math.floor(secs * FS), x = new Float64Array(n), target = E.FSM_TONE.eq_presets.speech.target;
    for (const fc of E.FSM_TONE.bands) {
      const b = noise(secs, 0, seed + fc);
      const hi = Math.min(fc * Math.SQRT2, FS * 0.47), lo = fc / Math.SQRT2;
      new E.FilterChain([E.biquad("highpass", lo, FS), E.biquad("highpass", lo, FS), E.biquad("lowpass", hi, FS), E.biquad("lowpass", hi, FS)]).process(b);
      let ss = 0; for (const v of b) ss += v * v;
      const k = Math.pow(10, ((target[fc] ?? -12) + (tweak[fc] || 0)) / 20) / Math.sqrt(ss / n);
      for (let i = 0; i < n; i++) x[i] += b[i] * k;
    }
    let ss = 0, cnt = 0;
    for (let i = 0; i < n; i++) {
      const t = i / FS, ph = Math.sin(2 * Math.PI * 0.25 * t) > -0.6 ? 1 : 0;
      x[i] *= Math.pow(Math.max(0, Math.sin(2 * Math.PI * 4 * t)), 0.7) * ph;
      if (ph) { ss += x[i] * x[i]; cnt++; }
    }
    const k = E.db2lin(-20) / Math.sqrt(ss / cnt), room = noise(secs, -66, seed + 11);
    for (let i = 0; i < n; i++) x[i] = x[i] * k + room[i];
    return x;
  };
  const boomy = voice(40, { 250: 9 });
  const run1 = (x, preset, amount) => {
    const eng = engine(["speech"]); eng.updateChannel(0, { eq_preset: preset, eq_amount: amount });
    run(eng, [x]); return Array.from(eng.strips[0].adapt.gains);
  };
  const g = run1(boomy, "speech", 100), plain = run1(voice(40), "speech", 100);
  assert.ok(plain.every((v) => Math.abs(v) < 1.5), `plain ${plain}`);
  assert.ok(g[1] < plain[1] - 2, `250 Hz ${g[1]} vs ${plain[1]}`);  // same audio gives the same result as Python (checked separately)
  for (const v of [...g, ...plain]) assert.ok(v >= -6 && v <= 3);
  assert.ok(g[0] <= 0 && g[1] <= 0);
  assert.deepEqual(run1(boomy.subarray(0, 8 * FS), "speech", 0), [0, 0, 0, 0, 0, 0, 0]);
  assert.equal(E.fsmDefaultEqPreset("instrument", "Bass DI"), "bass");
  assert.equal(E.fsmDefaultComp("playback"), "light");

  const loud = speech(6, -8), grs = {};
  for (const level of ["off", "light", "mild", "medium", "firm"]) {
    const eng = engine(["speech"]); eng.updateChannel(0, { comp: level, auto_level: false });
    let worst = 0;
    for (let i = 0; i + BLOCK <= loud.length; i += BLOCK) { eng.process([loud.subarray(i, i + BLOCK)]); worst = Math.min(worst, eng.strips[0].grDb); }
    grs[level] = worst;
  }
  assert.equal(grs.off, 0);
  assert.ok(grs.light > grs.mild && grs.mild > grs.medium && grs.medium > grs.firm, JSON.stringify(grs));
  assert.throws(() => engine(["speech"]).updateChannel(0, { comp: "squash" }));
});

test("stream polish eases swells gently and can be switched off", () => {
  const eng = engine(["instrument"]);
  run(eng, [music(6, -24)]);
  assert.ok(eng.polish.grDb > -0.5);
  let worst = 0;
  const swell = music(2, -12);
  for (let i = 0; i + BLOCK <= swell.length; i += BLOCK) { eng.process([swell.subarray(i, i + BLOCK)]); worst = Math.min(worst, eng.polish.grDb); }
  assert.ok(worst < -1 && worst >= -4, `polish ${worst}`);
  eng.updateMaster({ polish: false });
  run(eng, [music(1, -24)]);
  assert.equal(eng.polishMix, 0);
  assert.equal(eng.readMeters().master.polish, false);
});

test("parametric EQ bands and the manual soft gate", () => {
  const tone = (f, secs, lvl = 0.1) => Float64Array.from({ length: Math.floor(secs * FS) }, (_, i) => lvl * Math.sin(2 * Math.PI * f * i / FS));
  const rms = (x) => 10 * Math.log10(x.reduce((a, v) => a + v * v, 0) / x.length);
  const through = (peq, f) => {
    const eng = engine(["instrument"]);
    eng.updateChannel(0, { auto_level: false, comp: "off", eq_amount: 0, peq });
    const x = tone(f, 1.5), out = [];
    for (let i = 0; i + BLOCK <= x.length; i += BLOCK) out.push(...eng.process([x.subarray(i, i + BLOCK)])[0]);
    return rms(out.slice(FS));
  };
  const flat = { hpf: null, bands: [[100, 0, 1], [400, 0, 1], [1000, 0, 1], [8000, 0, 1]] };
  const boost = { hpf: null, bands: [[100, 0, 1], [400, 0, 1], [1000, 6, 1], [8000, 0, 1]] };
  assert.ok(Math.abs(through(boost, 1000) - through(flat, 1000) - 6) < 0.3);
  assert.ok(through({ hpf: 200, bands: flat.bands }, 60) < through(flat, 60) - 15);

  const v = engine(["lead_vocal"]);
  assert.deepEqual(v.strips[0].curve.bands, E.FSM_TONE.curves.vocal.bands);
  assert.throws(() => v.updateChannel(0, { peq: { hpf: 80, bands: [[100, 0, 1]] } }));

  const g = engine(["instrument"]);
  g.updateChannel(0, { gate_threshold: -40, auto_level: false, comp: "off" });
  run(g, [tone(440, 1)]); assert.ok(g.strips[0].gateOpen);
  run(g, [tone(440, 1.5, 0.1 * E.db2lin(-20.5))]);
  assert.ok(!g.strips[0].gateOpen && g.strips[0].gateDb < -2 && g.strips[0].gateDb > -5, `soft ${g.strips[0].gateDb}`);
  run(g, [tone(440, 1.5, 0.1 * E.db2lin(-40))]);
  assert.ok(Math.abs(g.strips[0].gateDb + 12) < 1e-6);
});
