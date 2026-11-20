"""The browser engine (docs/engine.js) carries a copy of the source-type presets.
This test fails if the copy drifts from fsm/presets.py."""

import json
import math
import re
from pathlib import Path

from fsm.presets import PRESETS, TYPE_ORDER

ROOT = Path(__file__).resolve().parents[1]


def _js_presets():
    src = (ROOT / "docs" / "engine.js").read_text()
    block = re.search(r"// BEGIN PRESETS.*?\n(.*?)// END PRESETS", src, re.S).group(1)
    body = block.split("=", 1)[1].strip().rstrip(";")
    return json.loads(body)


def _py_presets():
    out = {}
    for name, p in PRESETS.items():
        q = dict(p)
        q["eq"] = [list(e) for e in p["eq"]]
        q["reverb_db"] = None if math.isinf(p["reverb_db"]) else p["reverb_db"]
        out[name] = q
    return out


def test_js_presets_match_python():
    assert _js_presets() == _py_presets()


def test_js_type_order_matches_python():
    src = (ROOT / "docs" / "engine.js").read_text()
    order = json.loads(re.search(r"FSM_TYPE_ORDER = (\[.*?\]);", src).group(1))
    assert order == TYPE_ORDER
