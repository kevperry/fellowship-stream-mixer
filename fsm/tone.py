"""Adaptive EQ and compressor settings.

Adaptive EQ
-----------
While a channel is active, its long-term tone is measured in seven octave
bands (125 Hz - 8 kHz). The EQ then slowly moves each band towards a target
tonal balance for that kind of source, so a boomy lapel mic gets its low-mids
cut, a dull handheld gets a touch of presence, and different mics end up
sounding like they belong together.

* Targets are *shapes* (relative dB between bands); overall level is the
  leveler's job, so the average correction is always zero.
* Each preset only listens to the bands where that source has real content.
* Corrections are gentle: cuts up to 6 dB, boosts up to 3 dB and only from
  1 kHz up (lows are cut-only), moving at most 1 dB per second, scaled by
  the channel's Amount.

Targets: spoken voice follows the long-term average speech spectrum (Byrne et
al., 1994) with a little broadcast presence; vocal, keys, guitar, bass and
drums were taken from professionally mixed worship stems and smoothed.
"""

from __future__ import annotations

import math

import numpy as np

from .dsp import FilterChain, biquad

BANDS = (125, 250, 500, 1000, 2000, 4000, 8000)

# Target shape per preset, in dB per band (only the bands listed are used).
# Shapes are relative to 500 Hz; only the shape matters. Vocal, keys, guitar, bass and
# drum-kit shapes are whole-song averages of the band stems, measured the same way the
# live EQ measures. Bands that vary a lot between instruments of the same kind are left
# out: guitar stops at 4 kHz (electric vs acoustic), bass only manages its low end, and
# the drum kit leaves 125 Hz alone (kick patterns vary from song to song).
EQ_PRESETS: dict[str, dict] = {
    "speech": {"label": "Spoken voice", "tolerance": 2.0, "target": {250: 1, 500: 0, 1000: -5, 2000: -7, 4000: -10, 8000: -14}},
    "vocal": {"label": "Vocal", "tolerance": 2.0, "target": {250: -2, 500: 0, 1000: -6, 2000: -8, 4000: -13, 8000: -12}},
    "keys": {"label": "Keys / piano", "tolerance": 4.0, "target": {125: -10, 250: -2, 500: 0, 1000: -6, 2000: -10}},
    "guitar": {"label": "Guitar", "tolerance": 4.0, "target": {125: -2, 250: 3, 500: 0, 1000: -2, 2000: -2, 4000: -7}},
    "bass": {"label": "Bass", "tolerance": 4.0, "target": {125: 33, 250: 26, 500: 0}},
    "drums": {"label": "Drum kit / overheads", "tolerance": 4.0, "target": {250: 5, 500: 0, 1000: -6, 2000: -7, 4000: -6, 8000: -8}},
    "instrument": {"label": "Instrument (general)", "tolerance": 4.0, "target": {125: 2, 250: 2, 500: 0, 1000: -2, 2000: -4, 4000: -6, 8000: -8}},
    "off": {"label": "Off (flat)", "target": {}},
}
EQ_ORDER = ["speech", "vocal", "keys", "guitar", "bass", "drums", "instrument", "off"]

TOLERANCE_DB = 2.0       # default: differences this small are natural variation, left alone.
#                          Instruments use 4 dB: their tone changes with what is being played.
MAX_CUT = 6.0
MAX_BOOST = {125: 0.0, 250: 0.0, 500: 1.5, 1000: 3.0, 2000: 3.0, 4000: 3.0, 8000: 3.0}
SLEW_DB_PER_S = 0.5
LISTEN_SECONDS = 20.0    # averaging time of the tone measurement (follows the source, not the song section)
WARMUP_SECONDS = 3.0     # active sound heard before any correction starts (instruments: 8 s)
HOP = 4                  # measure every 4th block (staggered across channels)

# Compressor strength: (ratio, threshold above the channel's target level in dB)
COMP_LEVELS: dict[str, dict] = {
    "off": {"label": "Off", "ratio": 1.0, "above": 0.0},
    "light": {"label": "Light", "ratio": 1.5, "above": 6.0},
    "mild": {"label": "Mild", "ratio": 2.0, "above": 4.0},
    "medium": {"label": "Medium", "ratio": 3.0, "above": 3.0},
    "firm": {"label": "Firm", "ratio": 4.0, "above": 2.0},
}
COMP_ORDER = ["off", "light", "mild", "medium", "firm"]


def default_eq_preset(source_type: str, name: str = "") -> str:
    """The EQ preset a channel starts with, from its source type and name."""
    n = (name or "").lower()
    if source_type == "speech":
        return "speech"
    if source_type == "lead_vocal":
        return "vocal"
    if source_type == "drums":
        # the kit shape suits overheads / a stereo kit, not a single close mic
        if any(w in n for w in ("kick", "kik", "snare", "snr", "tom", "hat", "hh", "cajon")):
            return "off"
        return "drums"
    if source_type == "instrument":
        if "bass" in n:
            return "bass"
        if any(w in n for w in ("gtr", "guitar", "acoustic", "electric", "ag ", "eg ")):
            return "guitar"
        if any(w in n for w in ("key", "piano", "organ", "synth", "pad", "rhodes", "nord")):
            return "keys"
        return "instrument"
    return "off"  # playback is already mixed; "off" channels are silent


def default_comp(source_type: str) -> str:
    return {"playback": "light", "off": "off"}.get(source_type, "mild")


class AdaptiveEQ:
    def __init__(self, fs: float, block: int, stagger: int = 0):
        self.fs, self.n = fs, block
        self.dt = block / fs
        self.N = 1 << max(9, round(math.log2(0.043 * fs)))    # ~43 ms window: 2048 @ 48 kHz
        self.buf = np.zeros(self.N)
        self.win = np.hanning(self.N)
        freqs = np.fft.rfftfreq(self.N, 1.0 / fs)
        self.band_bins = [np.nonzero((freqs >= fc / math.sqrt(2)) & (freqs < fc * math.sqrt(2)))[0] for fc in BANDS]
        self.meas = None                                   # smoothed band levels (dB)
        self.heard = 0.0                                   # seconds of active sound measured
        self.gains = np.zeros(len(BANDS))                  # current correction per band
        self.applied = np.zeros(len(BANDS))                # gains the filters were built with
        self.chain = FilterChain(self._sections(self.applied))
        self.count = stagger % HOP

    def _sections(self, gains):
        return [biquad("peak", fc, self.fs, float(g), 1.2) for fc, g in zip(BANDS, gains)]

    def measure(self, x: np.ndarray, active: bool) -> None:
        self.buf = np.concatenate([self.buf[len(x):], x])
        self.count += 1
        if not active or self.count % HOP:
            return
        spec = np.abs(np.fft.rfft(self.buf * self.win)) ** 2
        band = np.array([10.0 * math.log10(spec[b].sum() + 1e-20) for b in self.band_bins])
        self.heard += HOP * self.dt
        if self.meas is None:
            self.meas = band
        else:   # a plain running mean at first, then a ~20 s moving average
            self.meas += (band - self.meas) * max(HOP * self.dt / LISTEN_SECONDS, HOP * self.dt / self.heard)

    def target_gains(self, preset: str, amount: float) -> np.ndarray:
        want = np.zeros(len(BANDS))
        target = EQ_PRESETS.get(preset, EQ_PRESETS["off"])["target"]
        p = EQ_PRESETS.get(preset, EQ_PRESETS["off"])
        warmup = WARMUP_SECONDS if p.get("tolerance", TOLERANCE_DB) <= TOLERANCE_DB else 8.0
        if self.meas is None or self.heard < warmup or not target or amount <= 0:
            return want
        idx = [i for i, fc in enumerate(BANDS) if fc in target]
        dev = np.array([self.meas[i] - target[BANDS[i]] for i in idx])
        dev -= dev.mean()                                  # shape only, not level
        for j, i in enumerate(idx):
            tol = EQ_PRESETS[preset].get("tolerance", TOLERANCE_DB)
            d = math.copysign(max(0.0, abs(dev[j]) - tol), dev[j])
            want[i] = max(-MAX_CUT, min(MAX_BOOST[BANDS[i]], -d * amount))
        return want

    def process(self, x: np.ndarray, active: bool, preset: str, amount: float) -> np.ndarray:
        self.measure(x, active)
        want = self.target_gains(preset, amount)
        step = SLEW_DB_PER_S * self.dt
        self.gains += np.clip(want - self.gains, -step, step)
        if np.max(np.abs(self.gains - self.applied)) > 0.05:
            self.applied = self.gains.copy()
            self.chain.sos = np.array(self._sections(self.applied))   # filter state is kept
        if np.max(np.abs(self.applied)) < 0.01:
            return x                                       # flat: unity filters keep a zero state
        return self.chain.process(x)


# --------------------------------------------------------------------------
# Parametric EQ: suggested starting curves per source
# --------------------------------------------------------------------------
# A channel's EQ is a high-pass filter plus four peaking bands. Until you change it,
# a channel follows the suggested curve for its EQ preset; your own curve is stored
# in the channel's "peq" setting. (The adaptive EQ then makes its small automatic
# corrections on top.) Bands are (frequency Hz, gain dB, Q).

EQ_CURVES: dict[str, dict] = {
    "speech": {"hpf": 90, "hpf_order": 4,
               "bands": [(180, -1.5, 1.0), (400, -1.5, 1.4), (3000, 2.5, 1.0), (9000, 1.5, 0.7)]},
    "vocal": {"hpf": 100, "hpf_order": 4,
              "bands": [(160, 1.5, 1.4), (300, -2.5, 2.0), (2800, 3.0, 1.4), (10000, 2.5, 1.2)]},
    "keys": {"hpf": 40, "hpf_order": 2,
             "bands": [(120, -1.0, 1.0), (350, -2.0, 1.0), (2500, 1.0, 1.0), (8000, 1.0, 0.8)]},
    "guitar": {"hpf": 80, "hpf_order": 2,
               "bands": [(200, -2.0, 1.0), (800, -1.0, 1.4), (3000, 2.0, 1.0), (8000, 1.0, 0.8)]},
    "bass": {"hpf": 35, "hpf_order": 2,
             "bands": [(80, 2.0, 1.0), (250, -3.0, 1.2), (800, 1.0, 1.4), (2500, 1.0, 1.0)]},
    "drums": {"hpf": 50, "hpf_order": 2,
              "bands": [(100, 1.0, 1.0), (400, -3.0, 1.0), (4000, 1.0, 1.0), (10000, 2.0, 0.8)]},
    "instrument": {"hpf": 40, "hpf_order": 2,
                   "bands": [(120, 0.0, 1.0), (250, -1.5, 1.0), (3000, 1.0, 1.0), (8000, 0.0, 0.8)]},
    "off": {"hpf": None, "hpf_order": 2,
            "bands": [(100, 0.0, 1.0), (400, 0.0, 1.0), (2000, 0.0, 1.0), (8000, 0.0, 1.0)]},
}
PEQ_LIMITS = {"hpf": (20.0, 400.0), "freq": (20.0, 20000.0), "gain": (-15.0, 15.0), "q": (0.3, 8.0)}


def resolve_curve(peq, preset: str, type_hpf: float, type_order: int) -> dict:
    """The curve a channel actually uses: its own, or the suggested one for its preset."""
    base = EQ_CURVES.get(preset, EQ_CURVES["off"])
    order = base["hpf_order"] if preset != "off" else type_order
    if peq:
        return {"hpf": peq.get("hpf"), "hpf_order": order, "bands": [tuple(b) for b in peq["bands"]]}
    return {"hpf": base["hpf"] if base["hpf"] is not None else type_hpf, "hpf_order": order,
            "bands": list(base["bands"])}


def hpf_sections(curve: dict, fs: float) -> list:
    from .dsp import highpass_sections
    return highpass_sections(curve["hpf"], fs, curve["hpf_order"]) if curve.get("hpf") else []


def band_sections(curve: dict, fs: float) -> list:
    """The four bands as filters (always four, so dragging one never resets the others)."""
    return [biquad("peak", f, fs, g, q) for f, g, q in curve["bands"]]
