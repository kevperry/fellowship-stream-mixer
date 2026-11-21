"""Turn a multitrack recording into a demo for the practice website.

    python -m fsm add-demo "path/to/recording" --title "Sunday worship" --start 12:30 --length 3:00

Cuts the clip, writes one 16-bit 48 kHz WAV per channel into
docs/demos/<name>/, optionally drops silent tracks and copies your channel
settings, then refreshes docs/demos/index.json.
"""

from __future__ import annotations

import json
import math
import re
import shutil
from pathlib import Path

import numpy as np

from . import config as cfgmod
from .demo_index import DEMOS, WEB_UPLOAD_LIMIT, build

AUDIO_EXTS = {".wav", ".flac", ".aif", ".aiff", ".w64", ".caf", ".mp3", ".ogg"}


def parse_time(s: str | None) -> float | None:
    """'90', '1:30' or '1:02:30' -> seconds."""
    if s in (None, ""):
        return None
    parts = [float(p) for p in str(s).split(":")]
    if len(parts) > 3 or any(p < 0 for p in parts):
        raise ValueError(f"can't read the time {s!r} — use seconds, m:ss or h:mm:ss")
    secs = 0.0
    for p in parts:
        secs = secs * 60 + p
    return secs


def slugify(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return s or "demo"


def _safe_name(text: str) -> str:
    return re.sub(r'[\\/:*?"<>|]+', "-", text).strip() or "Track"


def add_demo(source: str | Path, title: str, description: str = "", start: str | None = None,
             length: str | None = None, config_path: str | Path | None = None, skip_silent: bool = False,
             rate: int = 48000, folder: str | None = None, overwrite: bool = False, mp3: bool = False,
             demos_dir: Path = DEMOS) -> Path:
    import soundfile as sf
    from scipy.signal import resample_poly

    source = Path(source)
    files = ([source] if source.is_file() else
             sorted((p for p in source.iterdir() if p.suffix.lower() in AUDIO_EXTS and not p.name.startswith("_")),
                    key=lambda p: [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", p.name)]))
    if not files:
        raise SystemExit(f"No audio files found in {source}")

    infos = [sf.info(str(f)) for f in files]
    src_rate = infos[0].samplerate
    if any(i.samplerate != src_rate for i in infos):
        raise SystemExit("All tracks must share one sample rate.")
    total = min(i.frames for i in infos) / src_rate
    t0 = parse_time(start) or 0.0
    dur = parse_time(length)
    if t0 >= total:
        raise SystemExit(f"--start {start} is past the end of the recording ({total / 60:.1f} min).")
    dur = total - t0 if dur is None else min(dur, total - t0)

    cfg = cfgmod.load(config_path) if config_path else None
    by_input = {c["input"]: c for c in cfg["channels"]} if cfg else {}

    out_dir = demos_dir / (folder or slugify(title))
    if out_dir.exists():
        if not overwrite:
            raise SystemExit(f"{out_dir} already exists. Choose another --title/--folder, or add --replace.")
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)

    g = math.gcd(int(rate), int(src_rate))
    up, down = int(rate) // g, int(src_rate) // g
    kept_channels, written, skipped, big = [], [], [], []
    n_in = 0
    for f, info in zip(files, infos):
        a, b = int(t0 * src_rate), int((t0 + dur) * src_rate)
        data, _ = sf.read(str(f), start=a, stop=b, dtype="float64", always_2d=True)
        for c in range(data.shape[1]):
            n_in += 1
            x = data[:, c]
            if up != down:
                x = resample_poly(x, up, down)
            peak = float(np.max(np.abs(x))) if len(x) else 0.0
            src_ch = by_input.get(n_in)
            label = src_ch["name"] if src_ch else (f.stem if data.shape[1] == 1 else f"{f.stem} {c + 1}")
            if skip_silent and peak < 10 ** (-60 / 20):
                skipped.append(label)
                continue
            idx = len(written) + 1
            if mp3:   # ~160 kbps: about 1.2 MB per track per minute, a sixth the size of WAV
                name = f"{idx:02d} {_safe_name(label)}.mp3"
                sf.write(str(out_dir / name), np.clip(x, -1.0, 1.0), int(rate), format="MP3",
                         bitrate_mode="CONSTANT", compression_level=0.5)
            else:
                name = f"{idx:02d} {_safe_name(label)}.wav"
                sf.write(str(out_dir / name), np.clip(x, -1.0, 1.0), int(rate), subtype="PCM_16")
            size = (out_dir / name).stat().st_size
            if size > WEB_UPLOAD_LIMIT:
                big.append((name, size))
            written.append(name)
            if src_ch:
                ch = dict(src_ch)
                ch["input"] = idx
                kept_channels.append(ch)

    if not written:
        shutil.rmtree(out_dir)
        raise SystemExit("Every track was silent — nothing to add.")

    (out_dir / "demo.json").write_text(json.dumps({"title": title, "description": description}, indent=2) + "\n")
    if cfg:
        cfg["channels"] = kept_channels
        cfgmod.save(cfg, out_dir / "config.json")

    print(f"Added {len(written)} tracks ({dur / 60:.1f} min) to {out_dir}")
    if skipped:
        print(f"Left out silent tracks: {', '.join(skipped)}")
    for name, size in big:
        print(f"  note: {name} is {size / 2**20:.0f} MB — too big to upload through the GitHub website "
              f"(25 MB limit), but fine with git. A shorter --length, or --mp3, keeps tracks under 25 MB.")
    result = build(demos_dir, quiet=True)
    for p in result["problems"]:
        print("  warning:", p)
    print(f"All demos together: {result['bytes'] / 2**20:.0f} MB (keep under about 900 MB).")
    return out_dir
