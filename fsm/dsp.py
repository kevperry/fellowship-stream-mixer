"""Small DSP building blocks used by the mixing engine.

Everything here works on whole audio blocks with numpy/scipy so that the
per-sample work stays out of the Python interpreter.
"""

from __future__ import annotations

import math

import numpy as np
from scipy.signal import sosfilt

EPS = 1e-12


def db2lin(db):
    return np.power(10.0, np.asarray(db, dtype=np.float64) / 20.0)


def lin2db(x, floor: float = -120.0):
    return np.maximum(20.0 * np.log10(np.maximum(np.asarray(x, dtype=np.float64), EPS)), floor)


def power_db(x, axis=0, floor: float = -120.0):
    """RMS level in dBFS along ``axis``."""
    ms = np.mean(np.square(x, dtype=np.float64), axis=axis)
    return np.maximum(10.0 * np.log10(ms + EPS), floor)


# --------------------------------------------------------------------------
# Biquads (RBJ audio EQ cookbook)
# --------------------------------------------------------------------------

def biquad(kind: str, f0: float, fs: float, gain_db: float = 0.0, q: float = 0.7071) -> np.ndarray:
    """Return one second-order section [b0, b1, b2, 1, a1, a2]."""
    f0 = min(f0, 0.45 * fs)
    a = 10.0 ** (gain_db / 40.0)
    w0 = 2.0 * math.pi * f0 / fs
    cw, sw = math.cos(w0), math.sin(w0)
    alpha = sw / (2.0 * q)

    if kind == "highpass":
        b = [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2]
        den = [1 + alpha, -2 * cw, 1 - alpha]
    elif kind == "lowpass":
        b = [(1 - cw) / 2, 1 - cw, (1 - cw) / 2]
        den = [1 + alpha, -2 * cw, 1 - alpha]
    elif kind == "peak":
        b = [1 + alpha * a, -2 * cw, 1 - alpha * a]
        den = [1 + alpha / a, -2 * cw, 1 - alpha / a]
    elif kind in ("highshelf", "lowshelf"):
        sq = 2.0 * math.sqrt(a) * alpha
        if kind == "highshelf":
            b = [a * ((a + 1) + (a - 1) * cw + sq),
                 -2 * a * ((a - 1) + (a + 1) * cw),
                 a * ((a + 1) + (a - 1) * cw - sq)]
            den = [(a + 1) - (a - 1) * cw + sq,
                   2 * ((a - 1) - (a + 1) * cw),
                   (a + 1) - (a - 1) * cw - sq]
        else:
            b = [a * ((a + 1) - (a - 1) * cw + sq),
                 2 * a * ((a - 1) - (a + 1) * cw),
                 a * ((a + 1) - (a - 1) * cw - sq)]
            den = [(a + 1) + (a - 1) * cw + sq,
                   -2 * ((a - 1) + (a + 1) * cw),
                   (a + 1) + (a - 1) * cw - sq]
    else:
        raise ValueError(f"unknown filter kind {kind!r}")

    a0 = den[0]
    return np.array([b[0] / a0, b[1] / a0, b[2] / a0, 1.0, den[1] / a0, den[2] / a0])


def highpass_sections(freq: float, fs: float, order: int) -> list[np.ndarray]:
    """Butterworth high-pass of order 2 or 4 as biquads."""
    if order <= 2:
        return [biquad("highpass", freq, fs, q=0.7071)]
    return [biquad("highpass", freq, fs, q=0.5412), biquad("highpass", freq, fs, q=1.3066)]


class FilterChain:
    """A cascade of biquads with persistent state for block processing."""

    def __init__(self, sections: list[np.ndarray], channels: int = 1):
        self.sos = np.array(sections, dtype=np.float64) if sections else None
        self.channels = channels
        if self.sos is not None:
            self.zi = np.zeros((len(self.sos), 2) if channels == 1 else (len(self.sos), 2, channels))

    def process(self, x: np.ndarray) -> np.ndarray:
        if self.sos is None:
            return x
        y, self.zi = sosfilt(self.sos, x, axis=0, zi=self.zi)
        return y


# --------------------------------------------------------------------------
# Loudness (ITU-R BS.1770 style K-weighting, block-based)
# --------------------------------------------------------------------------

class LoudnessMeter:
    """Momentary (400 ms) and short-term (3 s) loudness of a stereo signal."""

    def __init__(self, fs: float, block: int):
        sections = [
            biquad("highshelf", 1681.974, fs, gain_db=3.9998, q=0.7072),
            biquad("highpass", 38.1355, fs, q=0.5003),
        ]
        self.filter = FilterChain(sections, channels=2)
        self.m_len = max(1, round(0.4 * fs / block))
        self.s_len = max(1, round(3.0 * fs / block))
        self.ring = np.zeros(self.s_len)
        self.pos = 0
        self.count = 0
        self.momentary = -120.0
        self.short_term = -120.0

    def update(self, stereo: np.ndarray) -> None:
        k = self.filter.process(stereo)
        self.ring[self.pos] = float(np.sum(np.mean(np.square(k), axis=0)))
        self.pos = (self.pos + 1) % self.s_len
        self.count = min(self.count + 1, self.s_len)

        idx_m = (self.pos - 1 - np.arange(min(self.m_len, self.count))) % self.s_len
        idx_s = (self.pos - 1 - np.arange(self.count)) % self.s_len
        self.momentary = -0.691 + 10.0 * math.log10(np.mean(self.ring[idx_m]) + EPS)
        self.short_term = -0.691 + 10.0 * math.log10(np.mean(self.ring[idx_s]) + EPS)


# --------------------------------------------------------------------------
# Look-ahead peak limiter
# --------------------------------------------------------------------------

class Limiter:
    """Brick-wall limiter with one block of look-ahead (adds one block of latency).

    For every sample the required gain is ``ceiling / |x|``. A forward-looking
    minimum over L samples followed by a backward moving average of L samples
    gives a smooth attack that is guaranteed never to exceed the ceiling, and a
    linear release lets the gain recover afterwards.
    """

    def __init__(self, fs: float, block: int, ceiling_db: float = -1.0,
                 lookahead_ms: float = 4.0, release_ms: float = 200.0):
        self.block = block
        self.L = int(max(2, min(block, round(lookahead_ms * fs / 1000.0))))
        self.release_step = 1.0 / (release_ms * fs / 1000.0)
        self.ceiling = float(db2lin(ceiling_db))
        self.prev = np.zeros((block, 2))
        self.h_tail = np.ones(self.L - 1)
        self.g_last = 1.0
        self.last_min_gain = 1.0

    def set_ceiling(self, ceiling_db: float) -> None:
        self.ceiling = float(db2lin(ceiling_db))

    def process(self, x: np.ndarray) -> np.ndarray:
        n = self.block
        L = self.L
        buf = np.concatenate([self.prev, x], axis=0)
        peak = np.max(np.abs(buf), axis=1)
        g_req = np.minimum(1.0, self.ceiling / np.maximum(peak, EPS))

        # forward min: h[i] = min(g_req[i : i+L]) for i in [0, n)
        windows = np.lib.stride_tricks.sliding_window_view(g_req[: n + L - 1], L)
        h = windows.min(axis=1)

        # backward average over L values of h (uses previous block's tail)
        hh = np.concatenate([self.h_tail, h])
        c = np.cumsum(np.concatenate([[0.0], hh]))
        g_avg = (c[L:] - c[:-L]) / L
        self.h_tail = h[-(L - 1):]

        # linear release: g[i] = min(g_avg[i], g[i-1] + r), vectorised
        r = self.release_step
        idx = np.arange(n)
        cm = np.minimum.accumulate(g_avg - idx * r)
        g = np.minimum(idx * r + np.minimum(self.g_last + r, cm), 1.0)
        g = np.minimum(g, g_avg)
        self.g_last = float(g[-1])
        self.last_min_gain = float(g.min())

        out = self.prev * g[:, None]
        self.prev = x.copy()
        return np.clip(out, -self.ceiling, self.ceiling)


# --------------------------------------------------------------------------
# Convolution reverb (uniformly partitioned, synthetic room impulse)
# --------------------------------------------------------------------------

def synthetic_ir(fs: float, rt60: float = 1.6, predelay_ms: float = 18.0,
                 seed: int = 7) -> np.ndarray:
    """A smooth, slightly dark stereo hall-like impulse response."""
    rng = np.random.default_rng(seed)
    n = int(fs * rt60 * 1.1)
    t = np.arange(n) / fs
    decay = np.exp(-6.9078 * t / rt60)  # -60 dB at rt60
    ir = rng.standard_normal((n, 2)) * decay[:, None]
    # darken: lowpass that closes as the tail decays (approximated in two bands)
    lp = FilterChain([biquad("lowpass", 6000.0, fs, q=0.6)], channels=2)
    ir = lp.process(ir)
    hp = FilterChain([biquad("highpass", 180.0, fs, q=0.6)], channels=2)
    ir = hp.process(ir)
    # soft onset to avoid a hard transient
    fade = int(0.01 * fs)
    ir[:fade] *= np.linspace(0, 1, fade)[:, None]
    pre = np.zeros((int(predelay_ms * fs / 1000.0), 2))
    ir = np.concatenate([pre, ir])
    ir /= math.sqrt(np.sum(ir ** 2) / 2.0)
    return ir * 0.5


class Reverb:
    """Mono in, stereo out partitioned FFT convolution."""

    def __init__(self, fs: float, block: int, rt60: float = 1.6):
        self.block = block
        ir = synthetic_ir(fs, rt60)
        parts = math.ceil(len(ir) / block)
        ir = np.pad(ir, ((0, parts * block - len(ir)), (0, 0)))
        seg = ir.reshape(parts, block, 2)
        # spectra of zero-padded partitions: (parts, block+1, 2)
        self.H = np.fft.rfft(np.concatenate([seg, np.zeros_like(seg)], axis=1), axis=1)
        self.fdl = np.zeros((parts, block + 1), dtype=np.complex128)
        self.prev_in = np.zeros(block)
        self.parts = parts

    def process(self, mono: np.ndarray) -> np.ndarray:
        n = self.block
        X = np.fft.rfft(np.concatenate([self.prev_in, mono]))
        self.prev_in = mono.copy()
        self.fdl = np.roll(self.fdl, 1, axis=0)
        self.fdl[0] = X
        Y = np.einsum("pk,pkc->kc", self.fdl, self.H)
        y = np.fft.irfft(Y, n=2 * n, axis=0)
        return y[n:]


# --------------------------------------------------------------------------
# Stream polish: gentle tone balance + glue compression on the final mix
# --------------------------------------------------------------------------

class Polish:
    """Gentle finishing for the stream mix.

    Tone: 30 Hz rumble filter, -1 dB at 300 Hz (mud), +1 dB shelf above 8 kHz (air).
    Glue: 1.5:1 soft-knee compression that only acts when the mix rises more than
    4 dB above its own recent average, at most 4 dB, ~20 ms attack / ~300 ms release.
    """

    THRESHOLD_ABOVE = 4.0
    RATIO = 1.5
    KNEE = 6.0
    MAX_GR = 4.0

    def __init__(self, fs: float, block: int):
        self.dt = block / fs
        self.tone = FilterChain([
            biquad("highpass", 30.0, fs, q=0.7071),
            biquad("peak", 300.0, fs, -1.0, 0.8),
            biquad("highshelf", 8000.0, fs, 1.0, 0.7),
        ], channels=2)
        self.program_db = None
        self.gr_db = 0.0
        self.gain_prev = 1.0
        self.ramp = (np.arange(1, block + 1) / block)[:, None]

    def process(self, x: np.ndarray) -> np.ndarray:
        y = self.tone.process(x)
        level = float(10.0 * np.log10(np.max(np.mean(y * y, axis=0)) + EPS))
        if level > -50.0:   # learn the program level from real programme, not silence
            if self.program_db is None:
                self.program_db = level
            self.program_db += (level - self.program_db) * (self.dt / 3.0)
        static = 0.0
        if self.program_db is not None:
            over = level - (self.program_db + self.THRESHOLD_ABOVE)
            slope = 1.0 / self.RATIO - 1.0
            if over >= self.KNEE / 2:
                static = slope * over
            elif over > -self.KNEE / 2:
                static = slope * (over + self.KNEE / 2) ** 2 / (2 * self.KNEE)
            static = max(static, -self.MAX_GR)
        tau = 0.02 if static < self.gr_db else 0.3
        self.gr_db += (static - self.gr_db) * (1.0 - math.exp(-self.dt / tau))
        g = float(db2lin(self.gr_db))
        out = y * (self.gain_prev + (g - self.gain_prev) * self.ramp)
        self.gain_prev = g
        return out
