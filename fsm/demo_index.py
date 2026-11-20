"""Builds docs/demos/index.json — the list of demo recordings on the practice page.

Every folder inside docs/demos/ that contains .wav files is one demo:

    docs/demos/
      sunday-worship/
        01 Pastor.wav
        02 Worship leader.wav
        ...
        demo.json      optional: {"title": "...", "description": "..."}
        config.json    optional: channel settings (names, types, Tune ...)

Uses only the Python standard library so it can run on GitHub's servers
without installing anything:  python -m fsm.demo_index
"""

from __future__ import annotations

import json
import re
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEMOS = ROOT / "docs" / "demos"
WEB_UPLOAD_LIMIT = 25 * 1024 * 1024     # biggest file GitHub's website will accept
GIT_FILE_LIMIT = 100 * 1024 * 1024      # biggest file GitHub accepts at all
SITE_BUDGET = 900 * 1024 * 1024         # GitHub Pages sites should stay under 1 GB


def natural_key(name: str):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", name)]


def wav_info(path: Path) -> dict:
    """Sample rate, channels and duration from a WAV header (no audio is read)."""
    with open(path, "rb") as f:
        head = f.read(12)
        if len(head) < 12 or head[:4] not in (b"RIFF", b"RF64") or head[8:12] != b"WAVE":
            raise ValueError("not a WAV file")
        fmt = None
        size_total = path.stat().st_size
        while True:
            ch = f.read(8)
            if len(ch) < 8:
                raise ValueError("no audio data found")
            cid, size = ch[:4], struct.unpack("<I", ch[4:])[0]
            if cid == b"fmt ":
                body = f.read(size)
                _, channels, rate, _, block_align, bits = struct.unpack("<HHIIHH", body[:16])
                fmt = (channels, rate, block_align, bits)
                if size & 1:
                    f.seek(1, 1)
            elif cid == b"data":
                if fmt is None:
                    raise ValueError("no format chunk before the audio")
                data = min(size, size_total - f.tell()) if size not in (0, 0xFFFFFFFF) else size_total - f.tell()
                channels, rate, block_align, bits = fmt
                return {"channels": channels, "rate": rate, "bits": bits,
                        "seconds": data / block_align / rate}
            else:
                f.seek(size + (size & 1), 1)


def build(demos_dir: Path = DEMOS, quiet: bool = False) -> dict:
    demos, problems, total = [], [], 0
    if demos_dir.is_dir():
        for folder in sorted((d for d in demos_dir.iterdir() if d.is_dir()), key=lambda d: natural_key(d.name)):
            wavs = sorted((p for p in folder.iterdir() if p.suffix.lower() == ".wav"), key=lambda p: natural_key(p.name))
            if not wavs:
                continue
            meta = {}
            if (folder / "demo.json").is_file():
                try:
                    meta = json.loads((folder / "demo.json").read_text())
                except json.JSONDecodeError as e:
                    problems.append(f"{folder.name}/demo.json is not valid JSON ({e}); using defaults")
            tracks, seconds, rates, size = [], [], set(), 0
            for w in wavs:
                try:
                    info = wav_info(w)
                except (ValueError, struct.error) as e:
                    problems.append(f"{folder.name}/{w.name}: skipped ({e})")
                    continue
                b = w.stat().st_size
                size += b
                if b > GIT_FILE_LIMIT:
                    problems.append(f"{folder.name}/{w.name} is {b / 2**20:.0f} MB — GitHub refuses files over 100 MB")
                tracks.append(w.name)
                seconds.append(info["seconds"])
                rates.add(info["rate"])
            if not tracks:
                continue
            if len(rates) > 1:
                problems.append(f"{folder.name}: tracks have different sample rates {sorted(rates)}; the page will refuse it")
            total += size
            demos.append({
                "id": folder.name,
                "title": str(meta.get("title") or folder.name.replace("-", " ").replace("_", " ").title()),
                "description": str(meta.get("description") or ""),
                "folder": folder.name,
                "tracks": tracks,
                "config": "config.json" if (folder / "config.json").is_file() else None,
                "seconds": round(min(seconds), 1),
                "rate": min(rates),
                "megabytes": round(size / 2**20, 1),
            })
    if total > SITE_BUDGET:
        problems.append(f"demos total {total / 2**20:.0f} MB — GitHub Pages sites must stay under 1 GB")
    index = {"demos": demos}
    demos_dir.mkdir(parents=True, exist_ok=True)
    (demos_dir / "index.json").write_text(json.dumps(index, indent=2) + "\n")
    if not quiet:
        for d in demos:
            print(f"  {d['title']}: {len(d['tracks'])} tracks, {d['seconds'] / 60:.1f} min, {d['megabytes']} MB")
        print(f"{len(demos)} demo(s), {total / 2**20:.0f} MB in total")
        for p in problems:
            print("  warning:", p, file=sys.stderr)
    return {"index": index, "problems": problems, "bytes": total}


if __name__ == "__main__":
    build()
