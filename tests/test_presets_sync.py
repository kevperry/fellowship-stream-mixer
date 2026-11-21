"""The browser engine (docs/engine.js) carries generated copies of the presets and
tone settings. This test fails if they drift from fsm/presets.py and fsm/tone.py;
fix it with:  python -m fsm.jsdata"""

import json
import re

from fsm.jsdata import ENGINE_JS, render
from fsm.presets import TYPE_ORDER


def test_js_tables_match_python():
    src = ENGINE_JS.read_text()
    assert render(src) == src, "run: python -m fsm.jsdata"


def test_js_type_order_matches_python():
    order = json.loads(re.search(r"FSM_TYPE_ORDER = (\[.*?\]);", ENGINE_JS.read_text()).group(1))
    assert order == TYPE_ORDER
