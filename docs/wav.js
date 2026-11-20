/*
 * Streaming WAV reader: reads a few hundred milliseconds at a time straight from
 * the File on disk, so even hour-long multitracks don't have to fit in memory.
 * Supports PCM 8/16/24/32-bit, float 32/64-bit, WAVE_FORMAT_EXTENSIBLE and RF64.
 */
"use strict";

class WavReader {
  static async open(file) {
    const r = new WavReader();
    r.file = file;
    r.name = file.name;
    const read = async (off, len) => new DataView(await file.slice(off, off + len).arrayBuffer());
    const str = (dv, off) => String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3));

    const head = await read(0, 12);
    if (head.byteLength < 12) throw new Error(`${file.name}: file is too short`);
    const riff = str(head, 0);
    if ((riff !== "RIFF" && riff !== "RF64") || str(head, 8) !== "WAVE") {
      throw new Error(`${file.name}: not a WAV file (export your tracks as .wav)`);
    }
    let pos = 12, ds64Data = null, fmt = null;
    while (pos + 8 <= file.size) {
      const ch = await read(pos, 8);
      const id = str(ch, 0);
      const size = ch.getUint32(4, true);
      if (id === "ds64") {
        const d = await read(pos + 8, 16);
        ds64Data = d.getUint32(8, true) + d.getUint32(12, true) * 2 ** 32;
      } else if (id === "fmt ") {
        const d = await read(pos + 8, Math.min(size, 40));
        let format = d.getUint16(0, true);
        const channels = d.getUint16(2, true), rate = d.getUint32(4, true);
        const blockAlign = d.getUint16(12, true), bits = d.getUint16(14, true);
        if (format === 0xFFFE && size >= 26) format = d.getUint16(24, true);
        fmt = { format, channels, rate, blockAlign, bits };
      } else if (id === "data") {
        if (!fmt) throw new Error(`${file.name}: no format chunk before the audio data`);
        let dataSize = size === 0xFFFFFFFF && ds64Data !== null ? ds64Data : size;
        const remaining = file.size - (pos + 8);
        // recorders that were stopped abruptly can leave a zero or wrong size
        if (dataSize === 0 || dataSize > remaining) dataSize = remaining;
        r.dataOffset = pos + 8;
        r.frames = Math.floor(dataSize / fmt.blockAlign);
        break;
      }
      pos += 8 + size + (size & 1);
    }
    if (r.dataOffset === undefined) throw new Error(`${file.name}: no audio data found`);
    const ok = (fmt.format === 1 && [8, 16, 24, 32].includes(fmt.bits)) || (fmt.format === 3 && [32, 64].includes(fmt.bits));
    if (!ok) throw new Error(`${file.name}: unsupported WAV encoding (format ${fmt.format}, ${fmt.bits}-bit)`);
    Object.assign(r, fmt);
    r.duration = r.frames / r.rate;
    return r;
  }

  /** Returns one Float32Array per channel, ``frames`` long (zero-padded past the end). */
  async read(start, frames) {
    const out = Array.from({ length: this.channels }, () => new Float32Array(frames));
    if (start >= this.frames) return out;
    const n = Math.min(frames, this.frames - start);
    const buf = await this.file.slice(this.dataOffset + start * this.blockAlign,
      this.dataOffset + (start + n) * this.blockAlign).arrayBuffer();
    const C = this.channels, ba = this.blockAlign, bytes = this.bits >> 3;
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    for (let c = 0; c < C; c++) {
      const o = out[c];
      let p = c * bytes;
      if (this.format === 3 && this.bits === 32) for (let i = 0; i < n; i++, p += ba) o[i] = dv.getFloat32(p, true);
      else if (this.format === 3) for (let i = 0; i < n; i++, p += ba) o[i] = dv.getFloat64(p, true);
      else if (this.bits === 16) for (let i = 0; i < n; i++, p += ba) o[i] = dv.getInt16(p, true) / 32768;
      else if (this.bits === 24) for (let i = 0; i < n; i++, p += ba) {
        let v = u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16);
        if (v & 0x800000) v -= 0x1000000;
        o[i] = v / 8388608;
      }
      else if (this.bits === 32) for (let i = 0; i < n; i++, p += ba) o[i] = dv.getInt32(p, true) / 2147483648;
      else for (let i = 0; i < n; i++, p += ba) o[i] = (u8[p] - 128) / 128;
    }
    return out;
  }
}

/** Sort "Track 1, Track 2, … Track 10" the way people expect. */
function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

if (typeof module !== "undefined" && module.exports) module.exports = { WavReader, naturalCompare };
