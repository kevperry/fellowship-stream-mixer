/*
 * AudioWorklet processor. engine.js is loaded into the same worklet scope first,
 * so Engine and friends are available here as globals.
 *
 * The page streams the multitrack to us in chunks; we cut it into ~10 ms blocks,
 * run the mixer and play the result 128 samples at a time.
 */
/* global sampleRate, registerProcessor, AudioWorkletProcessor, currentTime */
"use strict";

const { Engine, fsmBlockSize } = globalThis;

class FsmProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { config } = options.processorOptions;
    this.block = fsmBlockSize(sampleRate);
    this.engine = new Engine(config, sampleRate, this.block);
    this.nIn = Math.max(1, options.processorOptions.channels | 0);
    this.inBlock = Array.from({ length: this.nIn }, () => new Float32Array(this.block));
    this.queue = [];            // [{ data: Float32Array[], offset }]
    this.queued = 0;            // frames waiting
    this.position = 0;          // frames played (timeline position)
    this.outL = new Float32Array(this.block);
    this.outR = new Float32Array(this.block);
    this.outPos = this.block;
    this.playing = false;
    this.ended = false;
    this.requested = false;
    this.lastMeters = 0;
    this.underruns = 0;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(msg) {
    try {
      switch (msg.type) {
        case "chunk":
          if (msg.generation !== this.generation) return; // stale data from before a seek
          this.queue.push({ data: msg.data, offset: 0, frames: msg.frames });
          this.queued += msg.frames;
          this.requested = false;
          if (msg.eof) this.ended = true;
          break;
        case "seek":
          this.generation = msg.generation;
          this.queue = []; this.queued = 0; this.ended = false; this.requested = false;
          this.position = msg.frame;
          this.started = false;
          break;
        case "play": this.playing = true; break;
        case "pause": this.playing = false; break;
        case "channel": {
          const ch = this.engine.updateChannel(msg.index, msg.changes);
          this.port.postMessage({ type: "channel", index: msg.index, channel: ch, id: msg.id });
          break;
        }
        case "master": {
          const m = this.engine.updateMaster(msg.changes);
          this.port.postMessage({ type: "master", master: m, id: msg.id });
          break;
        }
      }
    } catch (err) {
      this.port.postMessage({ type: "error", message: String(err && err.message || err), id: msg.id });
    }
  }

  pull() {
    const n = this.block;
    let got = 0;
    while (got < n && this.queue.length) {
      const c = this.queue[0];
      const take = Math.min(n - got, c.frames - c.offset);
      for (let ch = 0; ch < this.nIn; ch++) {
        const src = c.data[ch];
        if (src) this.inBlock[ch].set(src.subarray(c.offset, c.offset + take), got);
        else this.inBlock[ch].fill(0, got, got + take);
      }
      c.offset += take; got += take; this.queued -= take;
      if (c.offset >= c.frames) this.queue.shift();
    }
    for (let ch = 0; ch < this.nIn; ch++) this.inBlock[ch].fill(0, got);
    return got;
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    for (let i = 0; i < L.length; i++) {
      if (this.outPos >= this.block) {
        const canPlay = this.playing && (this.queued >= this.block || (this.ended && this.queued > 0));
        if (canPlay) {
          const got = this.pull();
          const [yl, yr] = this.engine.process(this.inBlock);
          this.outL.set(yl); this.outR.set(yr);
          this.position += got;
          this.started = true;
          if (this.ended && this.queued === 0) this.port.postMessage({ type: "ended" });
        } else {
          if (this.playing && this.started && !this.ended) { this.underruns++; this.engine.xruns = this.underruns; }
          this.outL.fill(0); this.outR.fill(0);
        }
        this.outPos = 0;
      }
      L[i] = this.outL[this.outPos];
      if (R !== L) R[i] = this.outR[this.outPos];
      this.outPos++;
    }
    if (!this.requested && !this.ended && this.queued < sampleRate * 2) {
      this.requested = true;
      this.port.postMessage({ type: "need" });
    }
    if (currentTime - this.lastMeters > 0.08) {
      this.lastMeters = currentTime;
      this.port.postMessage({ type: "meters", meters: this.engine.readMeters(), position: this.position });
    }
    return true;
  }
}

registerProcessor("fsm-mixer", FsmProcessor);
