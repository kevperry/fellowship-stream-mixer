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


def _candidate_folders(demos_dir: Path) -> list[Path]:
    """docs/demos/* subfolders, plus WAVs placed straight into docs/demos or docs/demo
    (or docs/demo/* subfolders), since uploads through the website often land there."""
    out = []
    roots = [demos_dir]
    if demos_dir == DEMOS:
        roots.append(DEMOS.parent / "demo")
    for root in roots:
        if not root.is_dir():
            continue
        if root != demos_dir or any(p.suffix.lower() in AUDIO_EXTS for p in root.iterdir()):
            out.append(root)
        out += sorted((d for d in root.iterdir() if d.is_dir()), key=lambda d: natural_key(d.name))
    return out


AUDIO_EXTS = {".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".oga", ".opus"}
_MP3_BITRATES = {  # kbps, MPEG-1 layer III and MPEG-2/2.5 layer III
    1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
}
_MP3_RATES = {3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000]}


def mp3_info(path: Path) -> dict:
    """Sample rate and duration of an MP3 from its first frame (and Xing/Info header if present)."""
    data = path.read_bytes()[: 256 * 1024]
    size = path.stat().st_size
    pos = 0
    if data[:3] == b"ID3" and len(data) >= 10:
        tag = (data[6] << 21) | (data[7] << 14) | (data[8] << 7) | data[9]
        pos = 10 + tag
        if pos > len(data):
            data = path.read_bytes()[: pos + 64 * 1024]
    while pos + 4 <= len(data):
        if data[pos] == 0xFF and (data[pos + 1] & 0xE0) == 0xE0:
            ver = (data[pos + 1] >> 3) & 3          # 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
            layer = (data[pos + 1] >> 1) & 3       # 1 = layer III
            br_i = data[pos + 2] >> 4
            sr_i = (data[pos + 2] >> 2) & 3
            if ver != 1 and layer == 1 and 0 < br_i < 15 and sr_i < 3:
                rate = _MP3_RATES[ver][sr_i]
                spf = 1152 if ver == 3 else 576
                mono = (data[pos + 3] >> 6) == 3
                side = (17 if mono else 32) if ver == 3 else (9 if mono else 17)
                x = pos + 4 + side
                if data[x:x + 4] in (b"Xing", b"Info") and data[x + 7] & 1:
                    frames = struct.unpack(">I", data[x + 8:x + 12])[0]
                    return {"rate": rate, "seconds": frames * spf / rate, "channels": 1 if mono else 2}
                kbps = _MP3_BITRATES[1 if ver == 3 else 2][br_i]
                return {"rate": rate, "seconds": (size - pos) * 8 / (kbps * 1000), "channels": 1 if mono else 2}
        pos += 1
    raise ValueError("not an MP3 file")


def audio_info(path: Path) -> dict:
    ext = path.suffix.lower()
    if ext == ".wav":
        return wav_info(path)
    if ext == ".mp3":
        info = mp3_info(path)
        info["rate"] = 48000  # the browser decodes compressed files at 48 kHz
        return info
    return {"rate": 48000, "seconds": None, "channels": None}  # other formats: decoded by the browser


def build(demos_dir: Path = DEMOS, quiet: bool = False) -> dict:
    demos, problems, total = [], [], 0
    if demos_dir.is_dir() or demos_dir == DEMOS:
        for folder in _candidate_folders(demos_dir):
            wavs = sorted((p for p in folder.iterdir() if p.suffix.lower() in AUDIO_EXTS and p.is_file()),
                          key=lambda p: natural_key(p.name))
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
                    info = audio_info(w)
                except (ValueError, struct.error) as e:
                    problems.append(f"{folder.name}/{w.name}: skipped ({e})")
                    continue
                b = w.stat().st_size
                size += b
                if b > GIT_FILE_LIMIT:
                    problems.append(f"{folder.name}/{w.name} is {b / 2**20:.0f} MB — GitHub refuses files over 100 MB")
                tracks.append(w.name)
                if info["seconds"] is not None:
                    seconds.append(info["seconds"])
                rates.add(info["rate"])
            if not tracks:
                continue
            if len(rates) > 1:
                problems.append(f"{folder.name}: tracks have different sample rates {sorted(rates)}; the page will refuse it")
            total += size
            try:
                rel = folder.relative_to(demos_dir.parent).as_posix()
            except ValueError:
                rel = folder.name
            demos.append({
                "id": rel.replace("/", "-"),
                "path": rel,
                "title": str(meta.get("title") or folder.name.replace("-", " ").replace("_", " ").title()),
                "description": str(meta.get("description") or ""),
                "folder": folder.name,
                "tracks": tracks,
                "config": "config.json" if (folder / "config.json").is_file() else None,
                "seconds": round(min(seconds), 1) if seconds else None,
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
