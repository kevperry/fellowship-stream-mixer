// Tests for the streaming WAV reader (docs/wav.js). Run: node --test tests/*.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { WavReader, naturalCompare } = require("../docs/wav.js");

function wav({ format, bits, channels, rate, frames, extensible = false, junk = 0 }, sample) {
  const bytes = bits / 8, ba = bytes * channels, fmtSize = extensible ? 40 : 16;
  const size = 12 + (junk ? 8 + junk : 0) + 8 + fmtSize + 8 + frames * ba;
  const dv = new DataView(new ArrayBuffer(size));
  let p = 0;
  const w = (s) => { for (const ch of s) dv.setUint8(p++, ch.charCodeAt(0)); };
  const u32 = (v) => { dv.setUint32(p, v, true); p += 4; }, u16 = (v) => { dv.setUint16(p, v, true); p += 2; };
  w("RIFF"); u32(size - 8); w("WAVE");
  if (junk) { w("JUNK"); u32(junk); p += junk; }
  w("fmt "); u32(fmtSize); u16(extensible ? 0xFFFE : format); u16(channels); u32(rate); u32(rate * ba); u16(ba); u16(bits);
  if (extensible) { u16(22); u16(bits); u32(0); u16(format); p += 14; }
  w("data"); u32(frames * ba);
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) {
    const v = sample(i, c);
    if (format === 3 && bits === 32) dv.setFloat32(p, v, true);
    else if (bits === 16) dv.setInt16(p, Math.round(v * 32767), true);
    else if (bits === 24) { const x = Math.round(v * 8388607) & 0xFFFFFF; dv.setUint8(p, x & 255); dv.setUint8(p + 1, (x >> 8) & 255); dv.setUint8(p + 2, x >> 16); }
    p += bytes;
  }
  return new File([dv.buffer], "t.wav");
}

const sig = (i, c) => Math.sin(i * 0.01 + c) * 0.5;

for (const [label, opts] of [
  ["16-bit mono", { format: 1, bits: 16, channels: 1 }],
  ["24-bit stereo with a JUNK chunk", { format: 1, bits: 24, channels: 2, junk: 28 }],
  ["32-bit float, 4 channels, WAVE_FORMAT_EXTENSIBLE", { format: 3, bits: 32, channels: 4, extensible: true }],
]) {
  test(`reads ${label}`, async () => {
    const f = wav({ ...opts, rate: 96000, frames: 5000 }, sig);
    const r = await WavReader.open(f);
    assert.equal(r.rate, 96000); assert.equal(r.channels, opts.channels); assert.equal(r.frames, 5000);
    const chunk = await r.read(1000, 2000);
    const tol = opts.bits === 16 ? 1e-4 : 1e-6;
    for (let c = 0; c < opts.channels; c++) for (let i = 0; i < 2000; i += 97) {
      assert.ok(Math.abs(chunk[c][i] - sig(1000 + i, c)) < tol, `${label} ch${c} i${i}`);
    }
    const tail = await r.read(4900, 500);  // runs past the end -> zero padded
    assert.equal(tail[0].length, 500); assert.equal(tail[0][300], 0);
  });
}

test("rejects non-WAV files", async () => {
  await assert.rejects(WavReader.open(new File([new Uint8Array(64)], "x.mp3")), /not a WAV/);
});

test("natural sort order", () => {
  assert.deepEqual(["Track 10.wav", "Track 2.wav", "Track 1.wav"].sort(naturalCompare),
    ["Track 1.wav", "Track 2.wav", "Track 10.wav"]);
});
