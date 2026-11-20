"""Source types.

Each channel is tagged once with what is plugged into it. The tag decides how
that channel is cleaned up (EQ, gate, compression), how loud it should sit in
the mix, and how it reacts to the other channels (gain sharing, ducking).

Levels are in dBFS RMS measured on 10 ms blocks after EQ.
"""

from __future__ import annotations

NEG_INF = float("-inf")

PRESETS: dict[str, dict] = {
    "speech": {
        "label": "Speaker / Pastor",
        "hpf": 90, "hpf_order": 4,
        "eq": [("peak", 220, -2.0, 1.0), ("peak", 3200, 2.5, 0.9), ("highshelf", 9000, 1.5, 0.7)],
        "target_db": -20.0,      # where the leveler holds an active channel
        "leveler_range": 12.0,   # +/- dB the leveler may move
        "comp_above": 3.0,       # compressor threshold relative to target
        "ratio": 3.0,
        "gate_range": -12.0,     # how far an idle channel is pulled down (0 = no gate)
        "gate_hold": 0.30,
        "automix": True,         # shares gain with other speech mics
        "ducks_music": True,     # music steps back while this mic is active
        "duckable": False,
        "reverb_db": NEG_INF,
    },
    "lead_vocal": {
        "label": "Lead vocal",
        "hpf": 100, "hpf_order": 4,
        "eq": [("peak", 300, -2.0, 1.0), ("peak", 3500, 2.0, 1.0), ("highshelf", 10000, 2.0, 0.7)],
        "target_db": -20.0, "leveler_range": 9.0,
        "comp_above": 3.0, "ratio": 3.0,
        "gate_range": -10.0, "gate_hold": 0.40,
        "automix": False, "ducks_music": False, "duckable": False,
        "reverb_db": -16.0,
    },
    "bg_vocal": {
        "label": "Background vocal",
        "hpf": 140, "hpf_order": 4,
        "eq": [("peak", 250, -3.0, 1.0), ("peak", 3000, -1.0, 1.0), ("highshelf", 10000, 1.5, 0.7)],
        "target_db": -25.0, "leveler_range": 9.0,
        "comp_above": 2.0, "ratio": 4.0,
        "gate_range": -15.0, "gate_hold": 0.40,
        "automix": False, "ducks_music": False, "duckable": False,
        "reverb_db": -14.0,
    },
    "instrument": {
        "label": "Instrument",
        "hpf": 40, "hpf_order": 2,
        "eq": [("peak", 350, -1.5, 0.8)],
        "target_db": -24.0, "leveler_range": 6.0,
        "comp_above": 4.0, "ratio": 2.0,
        "gate_range": 0.0, "gate_hold": 0.5,
        "automix": False, "ducks_music": False, "duckable": True,
        "reverb_db": NEG_INF,
    },
    "drums": {
        "label": "Drums",
        "hpf": 45, "hpf_order": 2,
        "eq": [("peak", 400, -2.0, 1.0)],
        "target_db": -26.0, "leveler_range": 4.0,
        "comp_above": 6.0, "ratio": 2.0,
        "gate_range": 0.0, "gate_hold": 0.5,
        "automix": False, "ducks_music": False, "duckable": True,
        "reverb_db": NEG_INF,
    },
    "playback": {
        "label": "Playback (video / tracks)",
        "hpf": 25, "hpf_order": 2,
        "eq": [],
        "target_db": -22.0, "leveler_range": 6.0,
        "comp_above": 6.0, "ratio": 1.5,
        "gate_range": 0.0, "gate_hold": 0.5,
        "automix": False, "ducks_music": False, "duckable": True,
        "reverb_db": NEG_INF,
    },
    "off": {
        "label": "Off",
        "hpf": 20, "hpf_order": 2, "eq": [],
        "target_db": -24.0, "leveler_range": 0.0,
        "comp_above": 20.0, "ratio": 1.0,
        "gate_range": 0.0, "gate_hold": 0.5,
        "automix": False, "ducks_music": False, "duckable": False,
        "reverb_db": NEG_INF,
    },
}

TYPE_ORDER = ["speech", "lead_vocal", "bg_vocal", "instrument", "drums", "playback", "off"]
