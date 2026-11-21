"""Records the raw desk channels (and the finished stream mix) during a service.

Each input becomes its own WAV file, numbered to match the desk input
(``01 Pastor.wav``, ``02 Pulpit.wav`` ...), in a dated folder. The folder also
gets ``_stream mix.wav`` (what went to the stream) and ``config.json`` (the
settings when recording started), so it can be dropped straight into the
practice page or played back with ``python -m fsm run --play``.

The audio thread only copies each block into a queue; a background thread does
all the disk writing, so a slow disk can never interrupt the live mix.
"""

from __future__ import annotations

import copy
import queue
import re
import shutil
import threading
import time
from datetime import datetime
from pathlib import Path

import numpy as np

from . import config as cfgmod

MIN_FREE_BYTES = 2 * 1024 ** 3        # stop before the disk is completely full
MIX_NAME = "_stream mix.wav"          # leading "_": not a track to mix


def _safe(text: str) -> str:
    return re.sub(r'[\\/:*?"<>|]+', "-", text).strip() or "Input"


class Recorder:
    def __init__(self, root: str | Path = "recordings"):
        self.root = Path(root)
        self.active = False
        self.folder: Path | None = None
        self.started = 0.0
        self.frames = 0
        self.bytes_per_frame = 0
        self.dropped = 0
        self.error: str | None = None
        self._q: queue.Queue | None = None
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()

    # ---- control (UI thread) ---------------------------------------------
    def start(self, engine, n_inputs: int) -> Path:
        import soundfile as sf

        with self._lock:
            if self.active:
                return self.folder
            self.error = None
            self.root.mkdir(parents=True, exist_ok=True)
            if shutil.disk_usage(self.root).free < MIN_FREE_BYTES:
                raise RuntimeError("Not enough free disk space to record (need at least 2 GB).")
            folder = self.root / datetime.now().strftime("%Y-%m-%d %H.%M.%S")
            folder.mkdir()
            cfg = engine.snapshot_config()
            names = {c["input"]: c["name"] for c in cfg["channels"]}
            fs = int(engine.fs)
            files = []
            for k in range(1, n_inputs + 1):
                name = f"{k:02d} {_safe(names.get(k, f'Input {k}'))}.wav"
                files.append(sf.SoundFile(str(folder / name), "w", samplerate=fs, channels=1, subtype="PCM_24"))
            mix = sf.SoundFile(str(folder / MIX_NAME), "w", samplerate=fs, channels=2, subtype="PCM_24")
            # settings as they were when recording started; input numbers already match the tracks
            snap = copy.deepcopy(cfg)
            snap["master"]["bypass"] = False
            cfgmod.save(snap, folder / "config.json")

            self._q = queue.Queue(maxsize=int(10 * fs / engine.block))   # ~10 s of slack
            self.frames = 0
            self.dropped = 0
            self.bytes_per_frame = 3 * (n_inputs + 2)
            self.folder = folder
            self.started = time.time()
            self._thread = threading.Thread(target=self._writer, args=(files, mix), daemon=True)
            self._thread.start()
            self.active = True
            return folder

    def stop(self) -> Path | None:
        with self._lock:
            if not self.active:
                return self.folder
            self.active = False
            self._q.put(None)
        self._thread.join(timeout=30)
        return self.folder

    # ---- audio thread -------------------------------------------------------
    def push(self, inputs: np.ndarray, mix: np.ndarray) -> None:
        """Called once per block from the audio callback. Never blocks."""
        if not self.active:
            return
        try:
            self._q.put_nowait((np.array(inputs, dtype=np.float32, copy=True),
                                np.array(mix, dtype=np.float32, copy=True)))
        except queue.Full:
            self.dropped += 1

    # ---- writer thread ------------------------------------------------------
    def _writer(self, files, mix_file) -> None:
        n = len(files)
        last_check = time.time()
        try:
            while True:
                item = self._q.get()
                if item is None:
                    break
                x, y = item
                for k, f in enumerate(files):
                    f.write(x[:, k] if k < x.shape[1] else np.zeros(len(x), np.float32))
                mix_file.write(y)
                self.frames += len(x)
                if time.time() - last_check > 5:
                    last_check = time.time()
                    if shutil.disk_usage(self.root).free < MIN_FREE_BYTES:
                        self.error = "Recording stopped: the disk is nearly full."
                        self.active = False
                        break
        except Exception as e:   # disk removed, permissions...
            self.error = f"Recording stopped: {e}"
            self.active = False
        finally:
            for f in files + [mix_file]:
                try:
                    f.close()
                except Exception:
                    pass
        _ = n

    # ---- status -------------------------------------------------------------
    def status(self, fs: float | None = None) -> dict:
        free = None
        try:
            free = shutil.disk_usage(self.root if self.root.exists() else Path(".")).free
        except OSError:
            pass
        secs = self.frames / fs if fs else time.time() - self.started if self.active else 0.0
        return {
            "active": self.active,
            "seconds": round(secs, 1),
            "bytes": self.frames * self.bytes_per_frame,
            "folder": str(self.folder) if self.folder else None,
            "dropped": self.dropped,
            "error": self.error,
            "free_bytes": free,
        }
