"""The automatic mixing engine.

Signal flow for every channel (one 10 ms block at a time):

    input -> trim -> high-pass + EQ (by source type)
          -> leveler (slowly rides the channel towards its target level)
          -> compressor (catches peaks above the target)
          -> gate (idle mics ease down; threshold follows the noise floor)
          -> gain sharing (speech mics share one "open mic" worth of gain)
          -> ducking (music steps back while someone is speaking)
          -> fader / mute -> pan -> stereo bus (+ reverb send)

Stereo bus:

    -> loudness leveler (holds the stream at the target LUFS)
    -> look-ahead limiter -> output

All control decisions are made once per block and the resulting gain is
ramped smoothly across the block, so nothing clicks or zippers.
"""

from __future__ import annotations

import math
import queue
import threading
import time
from collections import deque

import numpy as np

from . import config as cfgmod
from .dsp import (FilterChain, Limiter, LoudnessMeter, Reverb, biquad, db2lin,
                  highpass_sections, lin2db, power_db)
from .pitch import KEYS, VOCAL_TYPES, PitchCorrector, note_name, scale_notes
from .presets import PRESETS

NOISE_FLOOR_MIN = -85.0
NOISE_FLOOR_MAX = -45.0
GATE_OPEN_ABOVE_FLOOR = 10.0
GATE_CLOSE_ABOVE_FLOOR = 6.0
NOISE_WINDOW_S = 20

# Settings that a stereo-linked pair shares (everything except pan, name, solo).
GANGED = ("fader_db", "mute", "trim_db", "reverb_db", "type", "tune", "tune_amount",
          "tune_speed_ms", "ducks_music")


def link_group(channels: list, index: int) -> range:
    """Indices of the run of channels stereo-linked with ``index``."""
    lo = index
    while lo > 0 and channels[lo].get("link"):
        lo -= 1
    hi = index
    while hi + 1 < len(channels) and channels[hi + 1].get("link"):
        hi += 1
    return range(lo, hi + 1)


def gang(channels: list, index: int, changes: dict) -> list[int]:
    """Apply validated ``changes`` to channel ``index`` and its linked partners.

    Returns the indices that changed. Ticking Link copies the left channel's
    settings onto the newly linked one; after that, ganged settings move together.
    """
    ch = dict(channels[index])
    ch.update(changes)
    if ch.get("link") and index == 0:
        ch["link"] = False
    channels[index] = ch
    updated = {index}
    group = link_group(channels, index)
    if changes.get("link") and index > 0:
        src = channels[group[0]]
        for k in group:
            if k != group[0]:
                channels[k] = {**channels[k], **{g: src[g] for g in GANGED if g in src}}
                updated.add(k)
    else:
        shared = {k: v for k, v in changes.items() if k in GANGED}
        if shared:
            for k in group:
                if k != index:
                    channels[k] = {**channels[k], **shared}
                    updated.add(k)
    return sorted(updated)


def _clip(v, lo, hi):
    return lo if v < lo else hi if v > hi else v


class Strip:
    """State and control logic for one input channel."""

    def __init__(self, ch: dict, fs: float, block: int):
        self.fs = fs
        self.block = block
        self.dt = block / fs
        self.blocks_per_s = max(1, round(fs / block))
        self.type = None
        self.tuner = None
        self.tune_mix = 0.0
        self.configure(ch)

        self.nf_ring: deque[float] = deque(maxlen=NOISE_WINDOW_S)
        self.nf_cur = math.inf
        self.nf_count = 0
        self.noise_floor = -70.0
        self.gate_open = False
        self.hold = 0.0
        self.gate_db = self.p["gate_range"]
        self.gr_db = 0.0
        self.am_db = 0.0
        self.am_env = -120.0
        self.gain_prev = 0.0
        self.bypass_gain_prev = 0.0
        self.level = -120.0

    # ---- configuration ------------------------------------------------
    def configure(self, ch: dict) -> None:
        self.cfg = dict(ch)
        new_type = ch["type"]
        if new_type != self.type:
            self.type = new_type
            self.p = PRESETS[new_type]
            sections = highpass_sections(self.p["hpf"], self.fs, self.p["hpf_order"])
            sections += [biquad(k, f, self.fs, g, q) for (k, f, g, q) in self.p["eq"]]
            self.chain = FilterChain(sections)
            self.avg_db = self.p["target_db"]
            self.lev_db = 0.0
        self.col = int(ch["input"]) - 1
        self.trim = float(db2lin(ch.get("trim_db", 0.0)))
        self.fader_db = float(ch.get("fader_db", 0.0))
        self.mute = bool(ch.get("mute", False))
        theta = (float(ch.get("pan", 0.0)) + 1.0) * math.pi / 4.0
        self.pan_l, self.pan_r = math.cos(theta), math.sin(theta)
        rv = ch.get("reverb_db")
        rv = self.p["reverb_db"] if rv is None else rv
        self.send = 0.0 if (rv is None or rv <= -60) else float(db2lin(rv))
        dm = ch.get("ducks_music")
        self.ducks_music = self.p["ducks_music"] if dm is None else bool(dm)
        self.link = bool(ch.get("link", False))
        self.solo = bool(ch.get("solo", False))
        self.tune = bool(ch.get("tune", False))
        self.tune_amount = float(ch.get("tune_amount", 50.0)) / 100.0
        self.tune_speed_ms = float(ch.get("tune_speed_ms", 150.0))
        if self.type in VOCAL_TYPES and self.tuner is None:
            self.tuner = PitchCorrector(self.fs, self.block)

    @property
    def tuning(self) -> bool:
        return self.tune and self.type in VOCAL_TYPES

    def apply_tune(self, x: np.ndarray, allowed) -> np.ndarray:
        """Light pitch correction, crossfaded in/out over 30 ms when switched."""
        if self.tuner is None:
            return x
        prev = self.tune_mix
        step = self.dt / 0.03
        self.tune_mix = min(1.0, prev + step) if self.tuning else max(0.0, prev - step)
        if prev == 0.0 and self.tune_mix == 0.0:
            self.tuner.push(x)
            return x
        wet = self.tuner.process(x, self.gate_open, self.tune_amount, self.tune_speed_ms, allowed)
        m = prev + (self.tune_mix - prev) * (np.arange(1, len(x) + 1) / len(x))
        return x * (1.0 - m) + wet * m

    @property
    def on(self) -> bool:
        return self.type != "off" and not self.mute

    # ---- per-block control --------------------------------------------
    def detect(self, level: float) -> None:
        dt, p = self.dt, self.p
        self.level = level

        # Noise floor: lowest 10 ms level seen in the last ~20 seconds.
        # Digital silence (a channel muted at the desk) is ignored.
        if level > -100.0:
            self.nf_cur = min(self.nf_cur, level)
        self.nf_count += 1
        if self.nf_count >= self.blocks_per_s:
            self.nf_ring.append(self.nf_cur)
            self.nf_cur = math.inf
            self.nf_count = 0
        nf = min(self.nf_cur, min(self.nf_ring, default=math.inf))
        self.noise_floor = _clip(nf, NOISE_FLOOR_MIN, NOISE_FLOOR_MAX)

        # Gate with hysteresis and hold.
        if level > self.noise_floor + GATE_OPEN_ABOVE_FLOOR:
            self.gate_open = True
            self.hold = p["gate_hold"]
        elif level < self.noise_floor + GATE_CLOSE_ABOVE_FLOOR:
            self.hold -= dt
            if self.hold <= 0:
                self.gate_open = False
        rng = p["gate_range"]
        target = 0.0 if (self.gate_open or rng == 0) else rng
        if self.gate_db < target:
            self.gate_db = min(target, self.gate_db + 400.0 * dt)          # opens in ~30 ms
        else:
            self.gate_db = max(target, self.gate_db - abs(rng) / 0.25 * dt)  # closes in 250 ms

        # Leveler: only learns while the source is actually active.
        if p["leveler_range"] > 0 and self.gate_open and level > self.noise_floor + GATE_CLOSE_ABOVE_FLOOR:
            self.avg_db += (level - self.avg_db) * (dt / 1.5)
            want = _clip(p["target_db"] - self.avg_db, -p["leveler_range"], p["leveler_range"])
            step = 3.0 * dt  # at most 3 dB per second
            self.lev_db += _clip(want - self.lev_db, -step, step)

        # Smoothed level for gain sharing: fast up, ~20 dB/s down, so a talker
        # keeps their share between syllables.
        lv = level + self.lev_db
        self.am_env = lv if lv > self.am_env else max(lv, self.am_env - 20.0 * dt)

        # Compressor (soft knee) on the leveled signal.
        x = level + self.lev_db
        over = x - (p["target_db"] + p["comp_above"])
        knee = 6.0
        slope = 1.0 / p["ratio"] - 1.0
        if over <= -knee / 2:
            static = 0.0
        elif over < knee / 2:
            static = slope * (over + knee / 2) ** 2 / (2 * knee)
        else:
            static = slope * over
        if static < self.gr_db:
            self.gr_db = static
        else:
            self.gr_db = min(static, self.gr_db + 30.0 * dt)


class Engine:
    def __init__(self, cfg: dict, fs: float, block: int):
        self.cfg = cfgmod.normalize(cfg)
        self.fs = float(fs)
        self.block = int(block)
        self.dt = self.block / self.fs
        self.strips = [Strip(ch, self.fs, self.block) for ch in self.cfg["channels"]]
        self.n_inputs = max([s.col + 1 for s in self.strips], default=0)

        self.reverb = Reverb(self.fs, self.block)
        self.pre_meter = LoudnessMeter(self.fs, self.block)
        self.post_meter = LoudnessMeter(self.fs, self.block)
        m = self.cfg["master"]
        self.limiter = Limiter(self.fs, self.block, m["ceiling_db"])
        self.agc_db = 0.0
        self.agc_prev = 1.0
        self.duck_db = 0.0
        self.duck_hold = 0.0
        self.speech_active = False
        self.any_solo = False
        self.bypass_mix = 1.0 if m["bypass"] else 0.0

        self._pending: queue.SimpleQueue = queue.SimpleQueue()
        self._lock = threading.Lock()
        self._ramp = (np.arange(1, self.block + 1) / self.block)[:, None]
        self._reset_peaks()
        self.load = 0.0
        self.xruns = 0
        self._meters: dict = {}

    # ---- thread-safe control API (called from the UI thread) ----------
    def update_channel(self, index: int, changes: dict) -> dict:
        """Change one channel (and its stereo-linked partner). Returns {index: channel} of all changed."""
        with self._lock:
            chans = self.cfg["channels"]
            updated = gang(chans, index, _validate_channel_changes(changes))
            for k in updated:
                self._pending.put(("channel", k, dict(chans[k])))
            return {k: dict(chans[k]) for k in updated}

    def clear_solo(self) -> None:
        for i, ch in enumerate(self.cfg["channels"]):
            if ch.get("solo"):
                self.update_channel(i, {"solo": False})

    def update_master(self, changes: dict) -> dict:
        with self._lock:
            self.cfg["master"].update(_validate_master_changes(changes))
            return dict(self.cfg["master"])

    def snapshot_config(self) -> dict:
        with self._lock:
            return {"audio": dict(self.cfg["audio"]),
                    "master": dict(self.cfg["master"]),
                    "channels": [dict(c) for c in self.cfg["channels"]]}

    def _apply_pending(self) -> None:
        while True:
            try:
                kind, idx, ch = self._pending.get_nowait()
            except queue.Empty:
                break
            if kind == "channel":
                self.strips[idx].configure(ch)
        self.limiter.set_ceiling(self.cfg["master"]["ceiling_db"])

    # ---- processing ---------------------------------------------------
    def process(self, x: np.ndarray) -> np.ndarray:
        """Process one block. ``x`` is (block, n_device_inputs); returns (block, 2)."""
        t0 = time.perf_counter()
        self._apply_pending()
        n, dt = self.block, self.dt
        m = self.cfg["master"]
        strips = self.strips
        C = len(strips)

        raw = np.zeros((n, C))
        eq = np.zeros((n, C))
        for i, s in enumerate(strips):
            if s.col < x.shape[1]:
                raw[:, i] = x[:, s.col] * s.trim
            if s.type != "off":
                eq[:, i] = s.chain.process(raw[:, i])

        levels = power_db(eq, axis=0) if C else np.zeros(0)
        # Stereo-linked pairs follow the louder side so the image stays put.
        for i, s in enumerate(strips):
            if s.link and i > 0:
                levels[i] = levels[i - 1] = max(levels[i], levels[i - 1])
        for s, lvl in zip(strips, levels):
            s.detect(float(lvl))

        allowed = scale_notes(m.get("tune_key", "chromatic"))
        for i, s in enumerate(strips):
            if s.tuner is not None and s.type != "off":
                eq[:, i] = s.apply_tune(eq[:, i], allowed)

        # Solo in place: while anything is soloed only soloed channels are heard.
        # Soloing either side of a stereo-linked pair solos both.
        soloed = [s.solo for s in strips]
        for i, s in enumerate(strips):
            if s.link and i > 0 and (soloed[i] or soloed[i - 1]):
                soloed[i] = soloed[i - 1] = True
        any_solo = any(sl and s.type != "off" for sl, s in zip(soloed, strips))
        self.any_solo = any_solo
        audible = [s.on and (sl or not any_solo) for s, sl in zip(strips, soloed)]

        self._gain_sharing()
        self._ducking(m)

        new_gain = np.zeros(C)
        for i, s in enumerate(strips):
            if audible[i]:
                total = s.lev_db + s.gr_db + s.gate_db + s.am_db + s.fader_db
                if s.p["duckable"]:
                    total += self.duck_db
                new_gain[i] = db2lin(total)
        prev_gain = np.array([s.gain_prev for s in strips])
        g = prev_gain + (new_gain - prev_gain) * self._ramp
        out = eq * g
        for s, v in zip(strips, new_gain):
            s.gain_prev = float(v)

        pan_l = np.array([s.pan_l for s in strips])
        pan_r = np.array([s.pan_r for s in strips])
        mix = np.stack([out @ pan_l, out @ pan_r], axis=1) if C else np.zeros((n, 2))

        sends = np.array([s.send for s in strips])
        wet = self.reverb.process(out @ sends if C else np.zeros(n))
        mix += wet * db2lin(m["reverb_return_db"])

        # Stream loudness leveler (open loop: measure the bus, steer the gain).
        self.pre_meter.update(mix)
        st = self.pre_meter.short_term
        if st > -50.0:
            want = _clip(m["target_lufs"] - st, -12.0, 15.0)
            diff = want - self.agc_db
            rate = 1.5 if diff > 0 else (4.0 if diff < -3 else 2.0)
            self.agc_db += _clip(diff, -rate * dt, rate * dt)
        agc = float(db2lin(self.agc_db + m["output_trim_db"]))
        proc = mix * (self.agc_prev + (agc - self.agc_prev) * self._ramp)
        self.agc_prev = agc

        # A/B bypass: plain fader mix of the raw inputs, crossfaded in 50 ms.
        b_target = 1.0 if m["bypass"] else 0.0
        b_prev = self.bypass_mix
        self.bypass_mix = b_target if abs(b_target - b_prev) <= dt / 0.05 else b_prev + math.copysign(dt / 0.05, b_target - b_prev)
        if b_prev == 0.0 and self.bypass_mix == 0.0:
            final = proc
            for s in strips:
                s.bypass_gain_prev = 0.0
        else:
            bg_new = np.array([float(db2lin(s.fader_db)) if a else 0.0 for s, a in zip(strips, audible)])
            bg_prev = np.array([s.bypass_gain_prev for s in strips])
            bo = raw * (bg_prev + (bg_new - bg_prev) * self._ramp)
            for s, v in zip(strips, bg_new):
                s.bypass_gain_prev = float(v)
            byp = np.stack([bo @ pan_l, bo @ pan_r], axis=1) * db2lin(m["output_trim_db"])
            bx = b_prev + (self.bypass_mix - b_prev) * self._ramp
            final = proc * (1.0 - bx) + byp * bx

        y = self.limiter.process(final)
        self.post_meter.update(y)

        self._accumulate_meters(raw, out, y)
        elapsed = time.perf_counter() - t0
        self.load = 0.9 * self.load + 0.1 * (elapsed / dt)
        return y

    def _gain_sharing(self) -> None:
        """Speech mics share gain in proportion to how much each is being used."""
        am = [s for s in self.strips if s.on and s.p["automix"]]
        for s in self.strips:
            if s not in am:
                s.am_db = 0.0
        if len(am) < 2:
            for s in am:
                s.am_db = 0.0
            return
        if not any(s.gate_open for s in am):
            return  # nobody talking: keep the last talker's mic up ("last mic hold")
        powers = np.array([10.0 ** (s.am_env / 10.0) for s in am])
        share = 10.0 * np.log10(powers / powers.sum() + 1e-12)
        for s, want in zip(am, share):
            want = max(float(want), -20.0)
            if want > s.am_db:
                s.am_db = min(want, s.am_db + 200.0 * self.dt)
            else:
                s.am_db = max(want, s.am_db - 40.0 * self.dt)

    def _ducking(self, m: dict) -> None:
        dt = self.dt
        self.speech_active = any(s.on and s.ducks_music and s.gate_open for s in self.strips)
        if m["ducking"] == "auto" and self.speech_active:
            self.duck_hold = 0.5
        else:
            self.duck_hold -= dt
        want = m["duck_depth_db"] if self.duck_hold > 0 else 0.0
        if want < self.duck_db:
            self.duck_db = max(want, self.duck_db - 40.0 * dt)
        else:
            self.duck_db = min(want, self.duck_db + 8.0 * dt)

    # ---- metering -----------------------------------------------------
    def _reset_peaks(self) -> None:
        C = len(self.strips)
        self._pk_in = np.zeros(C)
        self._pk_out = np.zeros(C)
        self._pk_master = np.zeros(2)

    def _accumulate_meters(self, raw, out, y) -> None:
        C = len(self.strips)
        if C:
            self._pk_in = np.maximum(self._pk_in, np.max(np.abs(raw), axis=0))
            self._pk_out = np.maximum(self._pk_out, np.max(np.abs(out), axis=0))
        self._pk_master = np.maximum(self._pk_master, np.max(np.abs(y), axis=0))
        out_lvl = power_db(out, axis=0) if C else []
        self._meters = {
            "channels": [
                {
                    "in_peak": float(lin2db(self._pk_in[i])),
                    "out_peak": float(lin2db(self._pk_out[i])),
                    "out_level": float(out_lvl[i]),
                    "level": round(s.level, 1),
                    "noise_floor": round(s.noise_floor, 1),
                    "active": bool(s.gate_open),
                    "gate_db": round(s.gate_db, 1),
                    "leveler_db": round(s.lev_db, 1),
                    "comp_db": round(s.gr_db, 1),
                    "share_db": round(s.am_db, 1),
                    "duck_db": round(self.duck_db, 1) if s.p["duckable"] else 0.0,
                    "solo": s.solo,
                    "tune_note": (note_name(s.tuner.note) if s.tuning and s.tuner and s.tuner.note is not None else None),
                    "tune_cents": round(s.tuner.cents, 1) if s.tuning and s.tuner else 0.0,
                }
                for i, s in enumerate(self.strips)
            ],
            "master": {
                "peak_l": float(lin2db(self._pk_master[0])),
                "peak_r": float(lin2db(self._pk_master[1])),
                "momentary": round(self.post_meter.momentary, 1),
                "short_term": round(self.post_meter.short_term, 1),
                "loudness_gain_db": round(self.agc_db, 1),
                "limiter_db": round(float(lin2db(self.limiter.last_min_gain)), 1),
                "speech_active": bool(self.speech_active),
                "duck_db": round(self.duck_db, 1),
                "bypass": bool(self.cfg["master"]["bypass"]),
                "solo_active": bool(self.any_solo),
                "dsp_load": round(self.load * 100.0, 1),
                "xruns": self.xruns,
                "sample_rate": self.fs,
                "block": self.block,
            },
        }

    def read_meters(self) -> dict:
        """Latest meter values; peak readings are held until read."""
        m = self._meters
        self._reset_peaks()
        return m


# ---- validation helpers ----------------------------------------------------

def _num(v, lo, hi):
    v = float(v)
    if math.isnan(v):
        raise ValueError("not a number")
    return max(lo, min(hi, v))


def _validate_channel_changes(ch: dict) -> dict:
    out = {}
    for k, v in ch.items():
        if k == "name":
            out[k] = str(v)[:32]
        elif k == "type":
            if v not in PRESETS:
                raise ValueError(f"unknown type {v!r}")
            out[k] = v
        elif k == "trim_db":
            out[k] = _num(v, -24, 24)
        elif k == "fader_db":
            out[k] = _num(v, -60, 12)
        elif k == "pan":
            out[k] = _num(v, -1, 1)
        elif k == "reverb_db":
            out[k] = None if v is None else _num(v, -60, 0)
        elif k in ("mute", "link", "solo", "tune"):
            out[k] = bool(v)
        elif k == "tune_amount":
            out[k] = _num(v, 0, 100)
        elif k == "tune_speed_ms":
            out[k] = _num(v, 10, 500)
        elif k == "ducks_music":
            out[k] = None if v is None else bool(v)
        else:
            raise ValueError(f"unknown channel setting {k!r}")
    return out


def _validate_master_changes(m: dict) -> dict:
    out = {}
    for k, v in m.items():
        if k == "target_lufs":
            out[k] = _num(v, -30, -8)
        elif k == "ceiling_db":
            out[k] = _num(v, -6, 0)
        elif k == "duck_depth_db":
            out[k] = _num(v, -24, 0)
        elif k in ("reverb_return_db", "output_trim_db"):
            out[k] = _num(v, -24, 12)
        elif k == "ducking":
            if v not in ("auto", "off"):
                raise ValueError("ducking must be 'auto' or 'off'")
            out[k] = v
        elif k == "bypass":
            out[k] = bool(v)
        elif k == "tune_key":
            if v not in KEYS:
                raise ValueError(f"unknown key {v!r}")
            out[k] = v
        else:
            raise ValueError(f"unknown master setting {k!r}")
    return out
