/*
 * A short synthetic "service" so people can try the mixer without a recording:
 * a worship song (vocal, keys, bass) followed by the pastor speaking over a soft
 * keys pad. Generated in the browser as 16-bit WAV files.
 */
/* global FilterChain, biquad */
"use strict";

function makeDemoTracks() {
  const fs = 48000, secs = 36, n = fs * secs, split = 18 * fs;
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const room = (db) => { const g = Math.pow(10, db / 20); return Float32Array.from({ length: n }, () => gauss() * g); };

  // chord progression (I - V - vi - IV in D), 2 s per chord
  const chords = [[146.8, 185.0, 220.0], [110.0, 138.6, 164.8], [123.5, 146.8, 185.0], [98.0, 123.5, 146.8]];
  const chordAt = (t) => chords[Math.floor(t / 2) % 4];
  const melody = [293.7, 329.6, 370.0, 329.6, 293.7, 246.9, 220.0, 246.9, 293.7, 370.0, 440.0, 370.0];

  const keysL = new Float32Array(n), keysR = new Float32Array(n), bass = new Float32Array(n);
  const vox = room(-64), pastor = room(-66), pulpit = room(-63);
  let voxPhase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / fs, worship = i < split;
    const ch = chordAt(t);
    const env = worship ? 0.8 + 0.2 * Math.sin(2 * Math.PI * t / 2) : 0.25; // soft pad under the sermon
    let k = 0;
    for (const f of ch) k += Math.sin(2 * Math.PI * f * 2 * t) + 0.3 * Math.sin(2 * Math.PI * f * 4 * t);
    keysL[i] = 0.05 * env * k; keysR[i] = 0.05 * env * (k * 0.9 + 0.1 * Math.sin(2 * Math.PI * ch[0] * 6 * t));
    if (worship) {
      const nb = (t % 0.5) / 0.5;
      bass[i] = 0.18 * Math.exp(-3 * nb) * Math.sin(2 * Math.PI * ch[0] / 2 * t);
      // a real singer drifts a little sharp or flat on some notes (for the Tune demo)
      const ni = Math.floor(t / 0.75) % melody.length;
      const note = melody[ni] * Math.pow(2, [0, 28, -22, 15, 0, -30, 20, 0, -18, 25, -12, 0][ni] / 1200);
      const ph = (t % 0.75) / 0.75;
      const a = Math.min(1, ph * 12) * (ph < 0.9 ? 1 : (1 - ph) * 10);
      const f = note * (1 + 0.006 * Math.sin(2 * Math.PI * 5.5 * t)); // gentle vibrato
      voxPhase += 2 * Math.PI * f / fs;                                   // integrate the phase
      let v = 0;
      for (let h = 1; h <= 6; h++) v += Math.sin(voxPhase * h) / (h * h);
      vox[i] += 0.12 * a * v;
    }
  }
  // the pastor: speech-shaped noise in syllables and phrases, a little quiet on purpose
  const sp = Float64Array.from({ length: n - split }, gauss);
  new FilterChain([biquad("highpass", 180, fs), biquad("peak", 700, fs, 9, 1.2),
    biquad("peak", 2200, fs, 6, 1.5), biquad("lowpass", 5000, fs)]).process(sp);
  let ss = 0;
  for (let i = 0; i < sp.length; i++) ss += sp[i] * sp[i];
  const norm = 1 / Math.sqrt(ss / sp.length);
  for (let i = 0; i < sp.length; i++) {
    const t = i / fs;
    const syll = Math.pow(Math.max(0, Math.sin(2 * Math.PI * 3.7 * t + Math.sin(t))), 0.8);
    const phrase = Math.sin(2 * Math.PI * 0.22 * t) > -0.5 ? 1 : 0;
    pastor[split + i] += 0.045 * norm * sp[i] * syll * phrase;
  }

  const tracks = [["01 Pastor headset", pastor], ["02 Pulpit", pulpit], ["03 Worship leader vocal", vox],
    ["04 Keys L", keysL], ["05 Keys R", keysR], ["06 Bass", bass]];
  return tracks.map(([name, data]) => new File([encodeWav16(data, fs)], name + ".wav", { type: "audio/wav" }));
}

function encodeWav16(x, fs) {
  const buf = new ArrayBuffer(44 + x.length * 2), dv = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < 4; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); dv.setUint32(4, 36 + x.length * 2, true); w(8, "WAVE");
  w(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, fs, true); dv.setUint32(28, fs * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  w(36, "data"); dv.setUint32(40, x.length * 2, true);
  for (let i = 0; i < x.length; i++) dv.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), true);
  return buf;
}
