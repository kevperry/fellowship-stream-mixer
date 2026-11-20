"""Light pitch correction for vocals.

Two parts:

* **Detection** — the YIN algorithm finds the singer's pitch every block
  (10 ms), using an FFT so it stays cheap.
* **Shifting** — a delay-line pitch shifter. The read point drifts slowly
  through a short delay line to raise or lower pitch; when it reaches the
  edge of its range it jumps by exactly one detected pitch period, with a
  short crossfade. Because the jump is one period, the old and new read
  points are in phase and the join is inaudible on sung notes. At no
  correction the read point stands still, so the voice passes through
  untouched (just delayed ~20 ms).

The correction is deliberately gentle: ``amount`` sets how far towards the
nearest note the voice is pulled (0-100 %), and ``speed_ms`` how quickly. Slow
speeds leave vibrato and expression alone and only nudge held notes.
"""

from __future__ import annotations

import math

import numpy as np

NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
SCALES = {"major": (0, 2, 4, 5, 7, 9, 11), "minor": (0, 2, 3, 5, 7, 8, 10)}
KEYS = ["chromatic"] + [f"{n} {s}" for n in NOTE_NAMES for s in ("major", "minor")]
VOCAL_TYPES = ("lead_vocal", "bg_vocal")

FMIN, FMAX = 70.0, 1000.0
DEADBAND_CENTS = 3.0


def scale_notes(key: str) -> tuple[int, ...]:
    """Pitch classes (0 = C) allowed in ``key``."""
    if key == "chromatic":
        return tuple(range(12))
    root, scale = key.split()
    r = NOTE_NAMES.index(root)
    return tuple(sorted((r + i) % 12 for i in SCALES[scale]))


def note_name(midi: float) -> str:
    m = int(round(midi))
    return f"{NOTE_NAMES[m % 12]}{m // 12 - 1}"


def yin(frame: np.ndarray, fs: float, tau_min: int, tau_max: int, threshold: float = 0.15):
    """Return (frequency, clarity) or (None, clarity) if no clear pitch.

    ``frame`` must be at least 2 * tau_max long.
    """
    w = tau_max
    x = frame[-2 * w:]
    x0 = x[:w]
    size = 1 << int(math.ceil(math.log2(len(x) + w)))
    acf = np.fft.irfft(np.conj(np.fft.rfft(x0, size)) * np.fft.rfft(x, size), size)[: tau_max + 1]
    cs = np.concatenate([[0.0], np.cumsum(x * x)])
    taus = np.arange(tau_max + 1)
    energy = cs[taus + w] - cs[taus]
    d = cs[w] + energy - 2.0 * acf
    d[0] = 0.0
    d = np.maximum(d, 0.0)
    run = np.cumsum(d[1:])
    cmnd = np.ones(tau_max + 1)
    cmnd[1:] = d[1:] * taus[1:] / np.maximum(run, 1e-20)

    seg = cmnd[tau_min: tau_max]
    below = np.nonzero(seg < threshold)[0]
    if below.size:
        tau = tau_min + int(below[0])
        while tau + 1 < tau_max and cmnd[tau + 1] < cmnd[tau]:
            tau += 1
    else:
        tau = tau_min + int(np.argmin(seg))
    clarity = 1.0 - float(cmnd[tau])
    if cmnd[tau] > 0.25:
        return None, clarity
    # parabolic interpolation for a sub-sample period
    if 1 <= tau < tau_max:
        a, b, c = cmnd[tau - 1], cmnd[tau], cmnd[tau + 1]
        den = a - 2 * b + c
        shift = 0.5 * (a - c) / den if abs(den) > 1e-12 else 0.0
        tau_f = tau + max(-1.0, min(1.0, shift))
    else:
        tau_f = float(tau)
    return fs / tau_f, clarity


class PitchCorrector:
    def __init__(self, fs: float, block: int):
        self.fs = fs
        self.n = block
        self.dt = block / fs
        self.tau_min = max(2, int(fs / FMAX))
        self.tau_max = int(fs / FMIN)
        self.H = int(0.06 * fs)                      # history kept for reading and detection
        self.hist = np.zeros(self.H)
        self.center = 0.02 * fs                      # nominal delay (latency) of the shifter
        self.d = self.center
        self.period = 0.005 * fs
        self.cents = 0.0                             # correction currently applied
        self.note = None                             # target MIDI note
        self.f0 = None
        self.detune = 0.0                            # how far off the singer is (cents)
        self.xf_left = 0
        self.xf_len = 1
        self.xf_off = 0.0

    def push(self, x: np.ndarray) -> None:
        """Keep the history current while correction is switched off."""
        self.hist = np.concatenate([self.hist, x])[-self.H:]
        self.f0 = None

    def _target(self, midi: float, allowed: tuple[int, ...]) -> int:
        # stay on the current note through small scoops (hysteresis)
        if self.note is not None and self.note % 12 in allowed and abs(midi - self.note) < 0.7:
            return self.note
        base = int(math.floor(midi))
        cands = [m for m in range(base - 2, base + 3) if m % 12 in allowed]
        return min(cands, key=lambda m: abs(m - midi))

    def process(self, x: np.ndarray, active: bool, amount: float, speed_ms: float,
                allowed: tuple[int, ...]) -> np.ndarray:
        n, fs, H = self.n, self.fs, self.H
        buf = np.concatenate([self.hist, x])

        # ---- detect and decide the correction
        f0 = None
        if active:
            frame = buf[-2 * self.tau_max:]
            half = self.tau_max
            e1, e2 = float(np.dot(frame[:half], frame[:half])), float(np.dot(frame[half:], frame[half:]))
            # skip note onsets/endings, where half the window is silence and the estimate is biased
            if e1 > 0.25 * e2 and e2 > 0.25 * e1:
                f0, _ = yin(frame, fs, self.tau_min, self.tau_max)
        self.f0 = f0
        if f0 is not None:
            self.period = fs / f0
            midi = 69.0 + 12.0 * math.log2(f0 / 440.0)
            self.note = self._target(midi, allowed)
            self.detune = (midi - self.note) * 100.0
            # within a few cents is in tune: leave it alone
            want = 0.0 if abs(self.detune) < DEADBAND_CENTS else -self.detune * max(0.0, min(1.0, amount))
        else:
            self.note = None
            self.detune = 0.0
            want = 0.0
        k = 1.0 - math.exp(-self.dt / max(0.005, speed_ms / 1000.0))
        self.cents += (want - self.cents) * k
        self.cents = max(-100.0, min(100.0, self.cents))

        # ---- shift: read point drifts at (1 - ratio) samples per sample
        ratio = 2.0 ** (self.cents / 1200.0)
        slope = 1.0 - ratio
        T = self.period
        d = self.d + slope * np.arange(1, n + 1)
        lo, hi = self.center - T / 2, self.center + T / 2
        events = []
        if self.xf_left > 0:
            events.append((0, self.xf_off, self.xf_len - self.xf_left))
        start = 0
        for _ in range(16):
            seg = d[start:]
            out_lo, out_hi = seg < lo, seg > hi
            if slope <= 0 and out_lo.any():
                k_i, off = start + int(np.argmax(out_lo)), T
            elif slope >= 0 and out_hi.any():
                k_i, off = start + int(np.argmax(out_hi)), -T
            else:
                break
            if not (lo - T <= d[k_i] <= hi + T):     # far out of range (big period change): recentre
                off = self.center - d[k_i]
            d[k_i:] += off
            events.append((k_i, off, 0))
            start = k_i + 1
            if start >= n:
                break

        idx = np.arange(n)
        y = _read(buf, H + idx - d)
        xf_len = int(max(32, min(T, 0.005 * fs)))
        self.xf_left = 0
        for j, (k_i, off, done) in enumerate(events):
            total = self.xf_len if (k_i == 0 and done) else xf_len
            end = min(n, k_i + total - done, events[j + 1][0] if j + 1 < len(events) else n)
            if end <= k_i:
                continue
            span = np.arange(k_i, end)
            w = (done + span - k_i + 1) / total
            old = _read(buf, H + span - (d[span] - off))
            y[span] = w * y[span] + (1.0 - w) * old
            remaining = total - done - (end - k_i)
            if j == len(events) - 1 and remaining > 0 and end == n:
                self.xf_left, self.xf_len, self.xf_off = remaining, total, off

        self.d = float(d[-1])
        self.hist = buf[-H:]
        return y


def _read(buf: np.ndarray, pos: np.ndarray) -> np.ndarray:
    pos = np.clip(pos, 0.0, len(buf) - 1.000001)
    i = pos.astype(np.int64)
    f = pos - i
    return buf[i] * (1.0 - f) + buf[i + 1] * f
