"""Configuration file handling (plain JSON so it is easy to edit by hand)."""

from __future__ import annotations

import copy
import json
from pathlib import Path

from .presets import PRESETS

DEFAULT_MASTER = {
    "target_lufs": -16.0,     # loudness the stream is held at
    "ceiling_db": -1.0,       # limiter ceiling (true-peak-ish safety)
    "ducking": "auto",        # "auto" or "off"
    "duck_depth_db": -9.0,    # how far music steps back under speech
    "reverb_return_db": 0.0,
    "output_trim_db": 0.0,
    "bypass": False,          # A/B: true = plain fader mix, no automation
    "tune_key": "chromatic",  # song key for vocal pitch correction, e.g. "G major"
}

DEFAULT_AUDIO = {
    "input_device": "SQ",          # substring of the Core Audio device name
    "output_device": "BlackHole",  # substring; None = same as input device
    "output_channels": [1, 2],     # 1-based output channels for L/R
    "sample_rate": None,           # None = use the device's rate
    "block_ms": 10.0,
}

CHANNEL_DEFAULTS = {
    "name": "",
    "type": "off",
    "trim_db": 0.0,
    "fader_db": 0.0,
    "mute": False,
    "pan": 0.0,
    "reverb_db": None,    # None = use the source type's default
    "ducks_music": None,  # None = use the source type's default
    "link": False,        # stereo-link with the channel before it
    "solo": False,        # solo in place (never saved)
    "tune": False,        # light pitch correction (vocal channels only)
    "tune_amount": 50.0,  # % of the way to the nearest note
    "tune_speed_ms": 150.0,  # how quickly it corrects; slower keeps vibrato
}

EXAMPLE_CHANNELS = [
    ("Pastor", "speech", 0.0),
    ("Pulpit", "speech", 0.0),
    ("Worship leader", "lead_vocal", 0.0),
    ("BGV 1", "bg_vocal", -0.4),
    ("BGV 2", "bg_vocal", 0.4),
    ("Acoustic", "instrument", -0.3),
    ("Keys L", "instrument", -0.7),
    ("Keys R", "instrument", 0.7),
    ("Bass", "instrument", 0.0),
    ("Elec gtr", "instrument", 0.35),
    ("Kick", "drums", 0.0),
    ("Snare", "drums", 0.0),
    ("OH L", "drums", -0.6),
    ("OH R", "drums", 0.6),
    ("Playback L", "playback", -1.0),
    ("Playback R", "playback", 1.0),
]


def channel(**kw) -> dict:
    ch = copy.deepcopy(CHANNEL_DEFAULTS)
    ch.update(kw)
    return ch


def example_config(n_channels: int = 16) -> dict:
    chans = []
    for i in range(n_channels):
        if i < len(EXAMPLE_CHANNELS):
            name, typ, pan = EXAMPLE_CHANNELS[i]
        else:
            name, typ, pan = f"Ch {i + 1}", "off", 0.0
        link = name.endswith(" R") and i > 0
        chans.append(channel(input=i + 1, name=name, type=typ, pan=pan, link=link))
    return {"audio": dict(DEFAULT_AUDIO), "master": dict(DEFAULT_MASTER), "channels": chans}


def normalize(cfg: dict) -> dict:
    """Fill in missing keys and validate values."""
    out = {
        "audio": {**DEFAULT_AUDIO, **cfg.get("audio", {})},
        "master": {**DEFAULT_MASTER, **cfg.get("master", {})},
        "channels": [],
    }
    for i, ch in enumerate(cfg.get("channels", [])):
        c = {**CHANNEL_DEFAULTS, **ch}
        c.setdefault("input", i + 1)
        c["input"] = int(c["input"])
        if c["input"] < 1:
            raise ValueError(f"channel {i + 1}: input must be 1 or more")
        if c["type"] not in PRESETS:
            raise ValueError(f"channel {i + 1}: unknown type {c['type']!r} "
                             f"(choose from {', '.join(PRESETS)})")
        if not c["name"]:
            c["name"] = f"Ch {c['input']}"
        c["pan"] = max(-1.0, min(1.0, float(c["pan"])))
        c["solo"] = False  # solo never survives a restart
        out["channels"].append(c)
    from .pitch import KEYS
    if out["master"]["tune_key"] not in KEYS:
        raise ValueError(f"master.tune_key must be one of: {', '.join(KEYS)}")
    if out["master"]["ducking"] not in ("auto", "off"):
        raise ValueError("master.ducking must be 'auto' or 'off'")
    return out


def load(path: str | Path) -> dict:
    with open(path) as f:
        return normalize(json.load(f))


def save(cfg: dict, path: str | Path) -> None:
    def clean(v):
        if isinstance(v, float) and v == float("-inf"):
            return None
        return v

    data = copy.deepcopy(cfg)
    data["master"]["bypass"] = False
    for ch in data["channels"]:
        ch["solo"] = False
        for k, v in ch.items():
            ch[k] = clean(v)
    tmp = Path(str(path) + ".tmp")
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    tmp.replace(path)
