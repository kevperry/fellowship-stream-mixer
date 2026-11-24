"""Works out the key of the song being played, for Tune's "Auto-detect" setting.

Every ~0.1 s the music channels are analysed: mainly piano/keys and guitar
(they carry the chords), with bass, vocals and playback counting a little; drums
and speech mics are ignored. These are with an FFT and their energy is folded into the 12 pitch
classes (C, C#, ... B), building a "chroma" profile that is averaged over about
30 seconds of music. First the *scale* is found: the 7-note major
scale (one of 12) whose notes best match the profile. That's robust to the
overtones of real instruments, and it's all Tune needs. Then major vs. its
relative minor (same notes) is chosen with the Krumhansl-Kessler key profiles,
just for the name shown.

A new key only takes over after it has clearly won for several seconds, and the
profile starts fresh after a long gap without music (a new song).
"""

from __future__ import annotations

import math

import numpy as np

from .pitch import NOTE_NAMES

# Krumhansl & Kessler (1982) probe-tone profiles, starting on the tonic.
MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
KEY_NAMES = [f"{NOTE_NAMES[r]} major" for r in range(12)] + [f"{NOTE_NAMES[r]} minor" for r in range(12)]

AVERAGE_SECONDS = 30.0     # how much music the profile remembers
MIN_SECONDS = 12.0         # music heard before any key is reported (a full chord cycle)
CHANGE_SECONDS = 6.0       # a new key must win this long before it takes over
NEW_SONG_GAP = 20.0        # this long without music: start listening fresh
MIN_CORRELATION = 0.6      # below this the result isn't trusted


def _templates() -> np.ndarray:
    rows = [np.roll(MAJOR, r) for r in range(12)] + [np.roll(MINOR, r) for r in range(12)]
    t = np.array(rows)
    t = t - t.mean(axis=1, keepdims=True)
    return t / np.linalg.norm(t, axis=1, keepdims=True)


TEMPLATES = _templates()


MAJOR_SCALE = np.array([1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 0, 1], dtype=float)
SCALES = np.array([np.roll(MAJOR_SCALE, r) for r in range(12)])
SCALES_Z = (SCALES - SCALES.mean(axis=1, keepdims=True))
SCALES_Z /= np.linalg.norm(SCALES_Z, axis=1, keepdims=True)


def score_scales(chroma: np.ndarray) -> np.ndarray:
    """Correlation of the chroma profile with each of the 12 major-scale note sets."""
    c = np.asarray(chroma, dtype=np.float64)
    c = c - c.mean()
    n = np.linalg.norm(c)
    return np.zeros(12) if n < 1e-12 else SCALES_Z @ (c / n)


def name_key(chroma: np.ndarray, scale_root: int) -> str:
    """Major or its relative minor (same notes), whichever the key profiles prefer."""
    k = score_keys(chroma)
    major, minor = scale_root, 12 + (scale_root + 9) % 12
    return KEY_NAMES[major] if k[major] >= k[minor] else KEY_NAMES[minor]


def both_names(root: int) -> str:
    """A major scale and its relative minor use the same notes: name both."""
    minor = NOTE_NAMES[(root + 9) % 12].replace("Ab", "G#")    # spelled the usual way
    return f"{NOTE_NAMES[root]} major / {minor} minor"


def score_keys(chroma: np.ndarray) -> np.ndarray:
    """Pearson correlation of a 12-bin chroma profile with each of the 24 keys."""
    c = np.asarray(chroma, dtype=np.float64)
    c = c - c.mean()
    n = np.linalg.norm(c)
    if n < 1e-12:
        return np.zeros(24)
    return TEMPLATES @ (c / n)


class KeyDetector:
    def __init__(self, fs: float, block: int):
        self.fs, self.block = fs, block
        self.dt = block / fs
        self.N = 1 << int(round(math.log2(0.17 * fs)))       # ~170 ms window: 8192 @ 48 kHz
        self.buf = np.zeros(self.N)
        self.win = np.hanning(self.N)
        self.hop = max(1, round(0.1 / self.dt))
        freqs = np.fft.rfftfreq(self.N, 1.0 / fs)
        use = (freqs >= 65.0) & (freqs <= 1000.0)              # C2 .. B5: fundamentals, fewer overtones
        self.bins = np.nonzero(use)[0]
        midi = 69.0 + 12.0 * np.log2(freqs[self.bins] / 440.0)
        self.pc = np.mod(np.round(midi).astype(int), 12)
        # bins far from a semitone centre are mostly leakage: weight them down
        self.wt = np.cos(np.pi * (midi - np.round(midi))) ** 2
        self.reset()

    def reset(self) -> None:
        self.chroma = np.zeros(12)
        self.heard = 0.0
        self.quiet = 0.0
        self.count = 0
        self.key: str | None = None
        self.root: int | None = None              # major-scale root of the detected notes
        self.confidence = 0.0
        self.candidate: str | None = None
        self.candidate_time = 0.0
        self.scores = np.zeros(12)

    def process(self, x: np.ndarray, music_active: bool) -> None:
        self.buf = np.concatenate([self.buf[len(x):], x])
        self.count += 1
        if not music_active:
            self.quiet += self.dt
            if self.quiet > NEW_SONG_GAP and self.heard > 0:
                self.reset()
            return
        self.quiet = 0.0
        if self.count % self.hop:
            return
        spec = np.abs(np.fft.rfft(self.buf * self.win))[self.bins]
        if spec.max() < 1e-9:
            return
        frame = np.bincount(self.pc, weights=spec * self.wt, minlength=12)
        frame /= frame.sum() + 1e-12
        step = self.hop * self.dt
        self.heard += step
        a = max(step / AVERAGE_SECONDS, step / self.heard)  # running mean at first, then ~30 s
        self.chroma += (frame - self.chroma) * a
        if self.heard < MIN_SECONDS:
            return
        self.scores = score_scales(self.chroma)
        best = int(np.argmax(self.scores))
        r = float(self.scores[best])
        name = name_key(self.chroma, best)
        if self.key is not None and self.root == best:
            self.key, self.confidence = name, r       # same notes; the name may settle major/minor
            self.candidate, self.candidate_time = None, 0.0
            return
        if r < MIN_CORRELATION:
            self.candidate, self.candidate_time = None, 0.0
            return
        if self.key is None:
            self.key, self.root, self.confidence = name, best, r
            return
        if r - float(self.scores[self.root]) < 0.05:
            return
        if best != self.candidate:
            self.candidate, self.candidate_time = best, 0.0
        self.candidate_time += step
        if self.candidate_time >= CHANGE_SECONDS:
            self.key, self.root, self.confidence = name, best, r
            self.candidate, self.candidate_time = None, 0.0
