"""The channel strips + Channel settings panel code is shared by the Mac app's
control panel and the practice page; the two copies must stay identical."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_console_js_is_the_same_in_both_pages():
    a = (ROOT / "fsm" / "web" / "console.js").read_text()
    b = (ROOT / "docs" / "console.js").read_text()
    assert a == b, "copy fsm/web/console.js to docs/console.js"
