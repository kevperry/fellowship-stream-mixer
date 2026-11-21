"""Copies the source-type presets and tone settings into the browser engine.

The practice page (docs/engine.js) carries its own copy of these tables. Run

    python -m fsm.jsdata

after changing fsm/presets.py or fsm/tone.py; tests/test_presets_sync.py fails
if the two drift apart.
"""

from __future__ import annotations

import json
import math
import re
from pathlib import Path

from .presets import PRESETS
from .tone import BANDS, COMP_LEVELS, EQ_PRESETS, MAX_BOOST, MAX_CUT, TOLERANCE_DB

ENGINE_JS = Path(__file__).resolve().parents[1] / "docs" / "engine.js"


def _presets() -> dict:
    out = {}
    for name, p in PRESETS.items():
        q = dict(p)
        q["reverb_db"] = None if math.isinf(p["reverb_db"]) else p["reverb_db"]
        out[name] = q
    return out


def _tone() -> dict:
    return {
        "bands": list(BANDS),
        "eq_presets": {k: {"label": v["label"], "tolerance": v.get("tolerance", TOLERANCE_DB),
                           "target": {str(b): t for b, t in v["target"].items()}}
                       for k, v in EQ_PRESETS.items()},
        "max_cut": MAX_CUT,
        "tolerance": TOLERANCE_DB,
        "max_boost": {str(b): v for b, v in MAX_BOOST.items()},
        "comp_levels": COMP_LEVELS,
    }


def blocks() -> dict[str, str]:
    def entries(d):
        return ",\n".join(f"  {json.dumps(k)}: {json.dumps(v)}" for k, v in d.items())
    return {
        "PRESETS": "const FSM_PRESETS = {\n" + entries(_presets()) + "\n};\n",
        "TONE": "const FSM_TONE = " + json.dumps(_tone()) + ";\n",
    }


def render(src: str) -> str:
    for name, body in blocks().items():
        pat = re.compile(rf"(// BEGIN {name}[^\n]*\n)(.*?)(// END {name})", re.S)
        if not pat.search(src):
            raise SystemExit(f"docs/engine.js has no BEGIN/END {name} markers")
        src = pat.sub(lambda m: m.group(1) + body + m.group(3), src)
    return src


def main() -> None:
    src = ENGINE_JS.read_text()
    new = render(src)
    if new != src:
        ENGINE_JS.write_text(new)
        print("Updated docs/engine.js")
    else:
        print("docs/engine.js already up to date")


if __name__ == "__main__":
    main()
