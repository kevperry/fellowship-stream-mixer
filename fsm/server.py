"""A tiny web server for the control panel (no extra dependencies)."""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import config as cfgmod
from .pitch import KEYS
from .presets import PRESETS, TYPE_ORDER

WEB_DIR = Path(__file__).parent / "web"
CONTENT_TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript",
                 ".css": "text/css", ".svg": "image/svg+xml"}


class ControlServer:
    def __init__(self, host: str, port: int, config_path: str | None):
        self.engine = None
        self.config_path = config_path
        self.status = "starting"
        app = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _send(self, code, body: bytes, ctype="application/json"):
                self.send_response(code)
                self.send_header("Content-Type", ctype)
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _json(self, code, obj):
                self._send(code, json.dumps(obj, allow_nan=False, default=str).encode())

            def do_GET(self):
                path = self.path.split("?")[0]
                if path == "/api/state":
                    eng = app.engine
                    if eng is None:
                        return self._json(200, {"status": app.status})
                    return self._json(200, {"status": "running", "meters": _finite(eng.read_meters())})
                if path == "/api/config":
                    eng = app.engine
                    if eng is None:
                        return self._json(503, {"error": app.status})
                    return self._json(200, {
                        "config": _finite(eng.snapshot_config()),
                        "types": [{"id": t, "label": PRESETS[t]["label"],
                                   "reverb_db": _f(PRESETS[t]["reverb_db"]),
                                   "ducks_music": PRESETS[t]["ducks_music"]} for t in TYPE_ORDER],
                        "can_save": app.config_path is not None,
                        "keys": KEYS,
                    })
                name = "index.html" if path in ("/", "") else path.lstrip("/")
                f = (WEB_DIR / name).resolve()
                if WEB_DIR.resolve() in f.parents and f.is_file():
                    return self._send(200, f.read_bytes(), CONTENT_TYPES.get(f.suffix, "application/octet-stream"))
                self._send(404, b"not found", "text/plain")

            def do_POST(self):
                eng = app.engine
                if eng is None:
                    return self._json(503, {"error": app.status})
                try:
                    length = int(self.headers.get("Content-Length", 0))
                    body = json.loads(self.rfile.read(length) or b"{}")
                    path = self.path.split("?")[0]
                    if path == "/api/channel":
                        idx = int(body["index"])
                        if not 0 <= idx < len(eng.strips):
                            raise ValueError("no such channel")
                        return self._json(200, _finite(eng.update_channel(idx, body["changes"])))
                    if path == "/api/clear_solo":
                        eng.clear_solo()
                        return self._json(200, {"ok": True})
                    if path == "/api/master":
                        return self._json(200, _finite(eng.update_master(body)))
                    if path == "/api/save":
                        if not app.config_path:
                            raise ValueError("started without a config file")
                        snap = eng.snapshot_config()
                        snap["master"]["bypass"] = False  # always start with automation on
                        cfgmod.save(snap, app.config_path)
                        return self._json(200, {"saved": app.config_path})
                    self._json(404, {"error": "not found"})
                except (ValueError, KeyError, TypeError) as e:
                    self._json(400, {"error": str(e)})

        self.httpd = ThreadingHTTPServer((host, port), Handler)
        self.httpd.daemon_threads = True
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def start(self):
        self.thread.start()

    def stop(self):
        self.httpd.shutdown()


def _f(v):
    return None if isinstance(v, float) and (v != v or v in (float("inf"), float("-inf"))) else v


def _finite(obj):
    if isinstance(obj, dict):
        return {k: _finite(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_finite(v) for v in obj]
    return _f(obj)
