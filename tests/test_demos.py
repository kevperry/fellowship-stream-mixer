import json

import numpy as np
import pytest
import soundfile as sf

from fsm import config as cfgmod
from fsm.demo_index import build, wav_info
from fsm.demos import add_demo, parse_time, slugify


def test_parse_time_and_slug():
    assert parse_time("90") == 90 and parse_time("1:30") == 90 and parse_time("1:02:03") == 3723
    assert parse_time(None) is None
    with pytest.raises(ValueError):
        parse_time("1:2:3:4")
    assert slugify("Sunday Worship — 3 Nov!") == "sunday-worship-3-nov"


def test_add_demo_cuts_converts_and_indexes(tmp_path):
    src = tmp_path / "rec"
    src.mkdir()
    fs = 96000
    t = np.arange(fs * 10) / fs
    sf.write(src / "Track 1.wav", 0.2 * np.sin(2 * np.pi * 220 * t), fs, subtype="PCM_24")
    sf.write(src / "Track 2.wav", np.zeros_like(t), fs, subtype="PCM_24")                        # silent
    sf.write(src / "Track 10.wav", np.stack([0.1 * np.sin(2 * np.pi * 330 * t)] * 2, 1), fs)     # stereo
    cfg = cfgmod.normalize({"channels": [
        cfgmod.channel(input=1, name="Lead", type="lead_vocal", tune=True),
        cfgmod.channel(input=2, name="Spare", type="off"),
        cfgmod.channel(input=3, name="Keys L", type="instrument"),
        cfgmod.channel(input=4, name="Keys R", type="instrument", link=True)]})
    cfgmod.save(cfg, tmp_path / "config.json")
    demos = tmp_path / "demos"

    out = add_demo(src, "Sunday Worship", "a test", start="0:02", length="3", config_path=tmp_path / "config.json",
                   skip_silent=True, demos_dir=demos)
    names = sorted(p.name for p in out.glob("*.wav"))
    assert names == ["01 Lead.wav", "02 Keys L.wav", "03 Keys R.wav"]
    info = sf.info(str(out / "01 Lead.wav"))
    assert info.samplerate == 48000 and info.subtype == "PCM_16" and abs(info.duration - 3.0) < 0.01
    saved = cfgmod.load(out / "config.json")
    assert [(c["input"], c["name"], c["tune"]) for c in saved["channels"]] == [(1, "Lead", True), (2, "Keys L", False), (3, "Keys R", False)]

    index = json.loads((demos / "index.json").read_text())["demos"]
    assert len(index) == 1
    d = index[0]
    assert d["title"] == "Sunday Worship" and d["folder"] == "sunday-worship" and d["config"] == "config.json"
    assert d["tracks"] == names and d["rate"] == 48000 and abs(d["seconds"] - 3.0) < 0.01

    with pytest.raises(SystemExit):
        add_demo(src, "Sunday Worship", demos_dir=demos)          # already exists
    add_demo(src, "Sunday Worship", demos_dir=demos, overwrite=True, length="1")


def test_index_handles_uploaded_folders_without_metadata(tmp_path):
    demos = tmp_path / "demos"
    (demos / "easter_morning").mkdir(parents=True)
    sf.write(demos / "easter_morning" / "b.wav", np.zeros(4800), 48000)
    sf.write(demos / "easter_morning" / "a.wav", np.zeros(9600), 48000)
    (demos / "easter_morning" / "notes.txt").write_text("ignored")
    (demos / "empty").mkdir()
    r = build(demos, quiet=True)
    [d] = r["index"]["demos"]
    assert d["title"] == "Easter Morning" and d["tracks"] == ["a.wav", "b.wav"] and d["seconds"] == 0.1
    assert d["config"] is None
    assert wav_info(demos / "easter_morning" / "a.wav")["rate"] == 48000


def test_mp3_demos(tmp_path):
    from fsm.demo_index import mp3_info
    src = tmp_path / "rec"
    src.mkdir()
    t = np.arange(48000 * 6) / 48000
    sf.write(src / "Track 1.wav", 0.2 * np.sin(2 * np.pi * 220 * t), 48000)
    sf.write(src / "Track 2.mp3", 0.2 * np.sin(2 * np.pi * 330 * t), 48000, format="MP3")   # MP3 input works too
    demos = tmp_path / "demos"
    out = add_demo(src, "Mp3 Test", length="5", demos_dir=demos, mp3=True)
    files = sorted(p.name for p in out.iterdir() if p.suffix == ".mp3")
    assert files == ["01 Track 1.mp3", "02 Track 2.mp3"]
    info = mp3_info(out / files[0])
    assert info["rate"] == 48000 and abs(info["seconds"] - 5.0) < 0.1
    [d] = json.loads((demos / "index.json").read_text())["demos"]
    assert d["tracks"] == files and abs(d["seconds"] - 5.0) < 0.1 and d["rate"] == 48000
    assert (out / files[0]).stat().st_size < 150_000   # ~160 kbps, far smaller than the 480 KB WAV
