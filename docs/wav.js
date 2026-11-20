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

/**
 * A File-like object for a WAV on the website. Reads only the bytes it needs with
 * HTTP range requests, so demos start playing without downloading every track.
 * If the server ignores ranges, it falls back to downloading the whole file once.
 */
class RemoteFile {
  constructor(url, name) { this.url = url; this.name = name; }

  static async open(url, name) {
    const f = new RemoteFile(url, name);
    const res = await fetch(url, { headers: { Range: "bytes=0-65535" } });
    if (res.status === 206) {
      const cr = res.headers.get("Content-Range") || "";
      f.head = await res.arrayBuffer();
      f.size = Number(cr.split("/")[1]);
      if (!Number.isFinite(f.size)) { f.size = undefined; }
    }
    if (res.status === 200 || (res.status === 206 && f.size === undefined)) {
      // no usable range support: take the whole file
      const full = res.status === 200 ? res : await fetch(url);
      f.whole = await full.arrayBuffer();
      f.size = f.whole.byteLength;
    } else if (res.status !== 206) {
      throw new Error(`${name}: couldn't download it (HTTP ${res.status})`);
    }
    return f;
  }

  slice(a, b) {
    a = Math.max(0, a); b = Math.min(this.size, b);
    return {
      arrayBuffer: async () => {
        if (b <= a) return new ArrayBuffer(0);
        if (this.whole) return this.whole.slice(a, b);
        if (this.head && b <= this.head.byteLength) return this.head.slice(a, b);
        for (let attempt = 0; ; attempt++) {
          try {
            const res = await fetch(this.url, { headers: { Range: `bytes=${a}-${b - 1}` } });
            if (res.status === 206) return await res.arrayBuffer();
            if (res.ok) { this.whole = await res.arrayBuffer(); return this.whole.slice(a, b); }
            throw new Error(`HTTP ${res.status}`);
          } catch (e) {
            if (attempt >= 2) throw new Error(`${this.name}: download failed (${e.message})`);
            await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
          }
        }
      },
    };
  }
}

/**
 * MP3 / M4A / FLAC / OGG: the browser decodes the whole file up front (at 48 kHz),
 * then this serves it with the same read() interface as WavReader.
 */
const DECODE_RATE = 48000;
const COMPRESSED_EXT = /\.(mp3|m4a|aac|mp4|flac|ogg|oga|opus)$/i;
const AUDIO_EXT = /\.(wav|mp3|m4a|aac|mp4|flac|ogg|oga|opus)$/i;

class DecodedReader {
  /** ``source`` is a File/Blob or a URL string. */
  static async open(source, name) {
    const r = new DecodedReader();
    r.name = name || source.name;
    let bytes;
    if (typeof source === "string") {
      const res = await fetch(source);
      if (!res.ok) throw new Error(`${r.name}: couldn't download it (HTTP ${res.status})`);
      bytes = await res.arrayBuffer();
    } else {
      bytes = await source.arrayBuffer();
    }
    const Ctx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
    const ctx = new Ctx(1, 1, DECODE_RATE);
    let buf;
    try {
      buf = await new Promise((res, rej) => {
        const p = ctx.decodeAudioData(bytes, res, rej);
        if (p && p.then) p.then(res, rej);
      });
    } catch (e) {
      throw new Error(`${r.name}: this browser can't read that file (try MP3 or WAV)`);
    }
    r.rate = buf.sampleRate;
    r.channels = buf.numberOfChannels;
    r.frames = buf.length;
    r.duration = buf.duration;
    r.data = Array.from({ length: r.channels }, (_, c) => buf.getChannelData(c));
    // Many apps export a mono mic as a stereo file with identical sides: treat it as one channel.
    if (r.channels === 2) {
      const [L, R] = r.data;
      let same = true;
      for (let i = 0, step = Math.max(1, Math.floor(L.length / 20000)); i < L.length; i += step) {
        if (Math.abs(L[i] - R[i]) > 1e-3) { same = false; break; }
      }
      if (same) { r.data = [L]; r.channels = 1; }
    }
    return r;
  }

  async read(start, frames) {
    return this.data.map((d) => {
      const out = new Float32Array(frames);
      if (start < d.length) out.set(d.subarray(start, Math.min(d.length, start + frames)));
      return out;
    });
  }
}

/** Opens any supported audio file (File, RemoteFile, or URL for compressed files). */
async function openAudio(file) {
  return COMPRESSED_EXT.test(file.name)
    ? DecodedReader.open(file.url || file, file.name)
    : WavReader.open(file);
}

/** Sort "Track 1, Track 2, … Track 10" the way people expect. */
function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

if (typeof module !== "undefined" && module.exports) module.exports = { WavReader, RemoteFile, DecodedReader, openAudio, naturalCompare, AUDIO_EXT, COMPRESSED_EXT };
