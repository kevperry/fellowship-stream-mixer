"""Source types.

Each channel is tagged once with what is plugged into it. The tag decides how
that channel is cleaned up (EQ, gate, compression), how loud it should sit in
the mix, and how it reacts to the other channels (gain sharing, ducking).
The tone (adaptive EQ) and compressor are set up in tone.py.

Levels are in dBFS RMS measured on 10 ms blocks after the high-pass filter.
"""

from __future__ import annotations

NEG_INF = float("-inf")

PRESETS: dict[str, dict] = {
    "speech": {
        "label": "Speaker / Pastor",
        "hpf": 90, "hpf_order": 4,
        "target_db": -20.0,      # where the leveler holds an active channel
        "leveler_range": 12.0,   # +/- dB the leveler may move
        "gate_range": -12.0,     # how far an idle channel is pulled down (0 = no gate)
        "gate_hold": 0.30,
        "automix": True,         # shares gain with other speech mics
        "ducks_music": True,     # music steps back while this mic is active
        "duckable": False,
        "reverb_db": NEG_INF,
    },
    "lead_vocal": {
        "label": "Vocal",
        "hpf": 100, "hpf_order": 4,
        "target_db": -20.0, "leveler_range": 9.0,
        "gate_range": -10.0, "gate_hold": 0.40,
        "automix": False, "ducks_music": False, "duckable": False,
        "reverb_db": -16.0,
    },
    "instrument": {
        "label": "Instrument",
        "hpf": 40, "hpf_order": 2,
        "target_db": -24.0, "leveler_range": 6.0,
        "gate_range": 0.0, "gate_hold": 0.5,
        "automix": False, "ducks_music": False, "duckable": True,
        "reverb_db": NEG_INF,
    },
    "drums": {
        "label": "Drums",
        "hpf": 45, "hpf_order": 2,
        "target_db": -26.0, "leveler_range": 4.0,
        "gate_range": 0.0, "gate_hold": 0.5,
        "automix": False, "ducks_music": False, "duckable": True,
        "reverb_db": NEG_INF,
    },
    "playback": {
        "label": "Playback (video / tracks)",
        "hpf": 25, "hpf_order": 2,
        "target_db": -22.0, "leveler_range": 6.0,
        "gate_range": 0.0, "gate_hold": 0.5,
        "automix": False, "ducks_music": False, "duckable": True,
        "reverb_db": NEG_INF,
    },
    "off": {
        "label": "Off",
        "hpf": 20, "hpf_order": 2,
        "target_db": -24.0, "leveler_range": 0.0,
        "gate_range": 0.0, "gate_hold": 0.5,
        "automix": False, "ducks_music": False, "duckable": False,
        "reverb_db": NEG_INF,
    },
}

TYPE_ORDER = ["speech", "lead_vocal", "instrument", "drums", "playback", "off"]

# Types that count as "music is playing" (the vocal reverb rests when none are).
MUSIC_TYPES = ("instrument", "drums", "playback")

# Older settings files may use types that no longer exist.
RENAMED_TYPES = {"bg_vocal": "lead_vocal"}
