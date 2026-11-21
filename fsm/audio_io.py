"""Getting audio in and out: the live sound card, or multitrack files."""

from __future__ import annotations

import re
import sys
import threading
import time
import traceback
from pathlib import Path

import numpy as np

AUDIO_EXTS = {".wav", ".flac", ".aif", ".aiff", ".w64", ".caf", ".mp3", ".ogg"}


def _sd():
    try:
        import sounddevice as sd
    except OSError as e:  # PortAudio missing (only happens on Linux)
        raise SystemExit(f"Could not load the audio driver library: {e}")
    return sd


# ---------------------------------------------------------------------------
# Devices
# ---------------------------------------------------------------------------

def list_devices() -> str:
    sd = _sd()
    lines = []
    for i, d in enumerate(sd.query_devices()):
        lines.append(f"[{i:2d}] {d['name']}  (in {d['max_input_channels']}, "
                     f"out {d['max_output_channels']}, {int(d['default_samplerate'])} Hz)")
    return "\n".join(lines)


def find_device(name, kind: str):
    """Find a device by number or by (case-insensitive) part of its name."""
    sd = _sd()
    key = "max_input_channels" if kind == "input" else "max_output_channels"
    devices = sd.query_devices()
    if name is None or name == "":
        idx = sd.default.device[0 if kind == "input" else 1]
        return idx, devices[idx]
    if isinstance(name, int) or str(name).isdigit():
        idx = int(name)
        return idx, devices[idx]
    matches = [(i, d) for i, d in enumerate(devices)
               if str(name).lower() in d["name"].lower() and d[key] > 0]
    if not matches:
        raise SystemExit(f"No {kind} device matching {name!r}. Run `python -m fsm devices` to see them.")
    return matches[0]


# ---------------------------------------------------------------------------
# Multitrack file source (for practising with a recorded service)
# ---------------------------------------------------------------------------

def _natural_key(p: Path):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", p.name)]


class FileSource:
    """Reads one multichannel file, or a folder of mono/stereo files, block by block.

    Files in a folder become consecutive inputs in name order
    (``Track 1.wav, Track 2.wav, ... Track 10.wav``).
    """

    def __init__(self, path: str | Path, loop: bool = False):
        import soundfile as sf

        path = Path(path)
        files = ([path] if path.is_file() else
                 sorted((p for p in path.iterdir()
                         if p.suffix.lower() in AUDIO_EXTS and not p.name.startswith("_")), key=_natural_key))
        if not files:
            raise SystemExit(f"No audio files found in {path}")
        self.files = [sf.SoundFile(str(f)) for f in files]
        rates = {f.samplerate for f in self.files}
        if len(rates) != 1:
            raise SystemExit(f"All files must share one sample rate (found {sorted(rates)})")
        self.samplerate = rates.pop()
        self.channels = sum(f.channels for f in self.files)
        self.frames = min(f.frames for f in self.files)
        self.names = [f.name for f in self.files]
        self.loop = loop
        self.position = 0

    def read(self, n: int) -> np.ndarray | None:
        if self.position >= self.frames:
            if not self.loop:
                return None
            for f in self.files:
                f.seek(0)
            self.position = 0
        cols = []
        for f in self.files:
            data = f.read(n, dtype="float32", always_2d=True, fill_value=0.0)
            cols.append(data)
        self.position += n
        return np.concatenate(cols, axis=1)

    def close(self):
        for f in self.files:
            f.close()


# ---------------------------------------------------------------------------
# Runners
# ---------------------------------------------------------------------------

class _Guard:
    """Keeps an exception inside the audio callback from killing the stream."""

    def __init__(self):
        self.last_error = None
        self.errors = 0

    def report(self):
        self.errors += 1
        if self.errors <= 3:
            traceback.print_exc()
        self.last_error = traceback.format_exc(limit=2)


def run_live(engine_factory, audio: dict, stop: threading.Event, on_ready=None, recorder=None):
    """Mix the live inputs of the sound card (the SQ over USB) to the output device."""
    sd = _sd()
    in_idx, in_dev = find_device(audio.get("input_device"), "input")
    out_name = audio.get("output_device") or in_idx
    out_idx, out_dev = find_device(out_name, "output")

    fs = float(audio.get("sample_rate") or in_dev["default_samplerate"])
    block = int(round(fs * float(audio.get("block_ms", 10.0)) / 1000.0))
    engine = engine_factory(fs, block)

    n_in = max(engine.n_inputs, 1)
    if n_in > in_dev["max_input_channels"]:
        raise SystemExit(f"The config uses input {n_in} but {in_dev['name']!r} only has "
                         f"{in_dev['max_input_channels']} inputs.")
    out_ch = [int(c) - 1 for c in audio.get("output_channels", [1, 2])]
    n_out = max(out_ch) + 1
    if n_out > out_dev["max_output_channels"]:
        raise SystemExit(f"Output channels {audio.get('output_channels')} don't exist on "
                         f"{out_dev['name']!r} ({out_dev['max_output_channels']} outputs).")

    guard = _Guard()

    def callback(indata, outdata, frames, t, status):
        if status:
            engine.xruns += 1
        outdata.fill(0)
        try:
            y = engine.process(indata)
            if recorder is not None:
                recorder.push(indata, y)
            if len(out_ch) > 1:
                outdata[:, out_ch[0]] = y[:, 0]
                outdata[:, out_ch[1]] = y[:, 1]
            else:  # a single mono output gets the sum
                outdata[:, out_ch[0]] = 0.5 * (y[:, 0] + y[:, 1])
        except Exception:
            guard.report()

    device = in_idx if in_idx == out_idx else (in_idx, out_idx)
    print(f"Input : {in_dev['name']}  ({n_in} channels used)")
    print(f"Output: {out_dev['name']}  (channels {audio.get('output_channels', [1, 2])})")
    print(f"Audio : {int(fs)} Hz, {block} samples per block ({1000 * block / fs:.1f} ms)")
    with sd.Stream(device=device, samplerate=fs, blocksize=block, dtype="float32",
                   channels=(n_in, n_out), latency="low", callback=callback):
        if on_ready:
            on_ready(engine)
        while not stop.is_set():
            stop.wait(0.25)
    return engine


def run_files(engine_factory, source: FileSource, audio: dict, stop: threading.Event,
              on_ready=None, play: bool = True, recorder=None):
    """Play a multitrack recording through the mixer in real time."""
    fs = float(source.samplerate)
    block = int(round(fs * float(audio.get("block_ms", 10.0)) / 1000.0))
    engine = engine_factory(fs, block)
    if engine.n_inputs > source.channels:
        print(f"Warning: config uses input {engine.n_inputs} but the recording has "
              f"{source.channels} tracks; missing inputs are silent.", file=sys.stderr)
    guard = _Guard()
    print(f"Playing {len(source.files)} file(s), {source.channels} tracks, {int(fs)} Hz, "
          f"{source.frames / fs / 60:.1f} min")

    def next_block():
        x = source.read(block)
        if x is None:
            stop.set()
            return np.zeros((block, 2), dtype=np.float32)
        try:
            y = engine.process(x)
            if recorder is not None:
                recorder.push(x, y)
            return y
        except Exception:
            guard.report()
            return np.zeros((block, 2), dtype=np.float32)

    if play:
        sd = _sd()
        out_idx, out_dev = find_device(audio.get("output_device"), "output")
        out_ch = [int(c) - 1 for c in audio.get("output_channels", [1, 2])]
        n_out = max(out_ch) + 1

        def callback(outdata, frames, t, status):
            if status:
                engine.xruns += 1
            outdata.fill(0)
            y = next_block()
            outdata[:, out_ch[0]] = y[:, 0]
            if len(out_ch) > 1:
                outdata[:, out_ch[1]] = y[:, 1]

        print(f"Output: {out_dev['name']}")
        with sd.OutputStream(device=out_idx, samplerate=fs, blocksize=block, dtype="float32",
                             channels=n_out, latency="low", callback=callback):
            if on_ready:
                on_ready(engine)
            while not stop.is_set():
                stop.wait(0.25)
    else:
        # No sound card: just run in real time so the control panel can be tried out.
        if on_ready:
            on_ready(engine)
        period = block / fs
        t_next = time.perf_counter()
        while not stop.is_set():
            next_block()
            t_next += period
            delay = t_next - time.perf_counter()
            if delay > 0:
                time.sleep(delay)
    source.close()
    return engine


def render(engine_factory, source: FileSource, out_path: str, block_ms: float = 10.0,
           progress=True):
    """Mix a multitrack recording to a stereo file as fast as possible."""
    import soundfile as sf

    fs = float(source.samplerate)
    block = int(round(fs * block_ms / 1000.0))
    engine = engine_factory(fs, block)
    total = source.frames
    written = 0
    first = True
    with sf.SoundFile(out_path, "w", samplerate=int(fs), channels=2, subtype="PCM_24") as out:
        while True:
            x = source.read(block)
            if x is None:
                break
            y = engine.process(x)
            if first:      # the limiter delays everything by one block
                first = False
                continue
            out.write(y)
            written += block
            if progress and written % (block * 3000) == 0:
                print(f"  {100 * written / total:5.1f}%", file=sys.stderr)
        tail = engine.process(np.zeros((block, max(source.channels, 1)), dtype=np.float32))
        out.write(tail[: max(0, min(block, total - written))])
    source.close()
    return engine
