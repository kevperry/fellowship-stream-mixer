import time

import numpy as np
import pytest

from fsm import config as cfgmod
from fsm.dsp import Limiter, db2lin, power_db
from fsm.engine import Engine

FS = 48000
BLOCK = 480


# ---- synthetic test signals ------------------------------------------------

def speech_like(seconds, level_db=-20.0, seed=0, talk=True):
    """Band-limited noise with a syllable rhythm and pauses, roughly speech-shaped."""
    rng = np.random.default_rng(seed)
    n = int(seconds * FS)
    t = np.arange(n) / FS
    noise = rng.standard_normal(n)
    # crude band-limit to 200 Hz - 4 kHz
    from scipy.signal import butter, sosfilt
    noise = sosfilt(butter(4, [200, 4000], "bandpass", fs=FS, output="sos"), noise)
    syll = np.clip(np.sin(2 * np.pi * 4.0 * t), 0, None) ** 0.7
    phrase = (np.sin(2 * np.pi * 0.25 * t) > -0.6).astype(float)  # pauses
    x = noise * syll * phrase if talk else noise * 0
    rms = np.sqrt(np.mean(x[phrase > 0] ** 2)) if talk else 1
    return x / rms * db2lin(level_db) + room_noise(seconds, seed=seed + 11)


def music_like(seconds, level_db=-24.0):
    n = int(seconds * FS)
    t = np.arange(n) / FS
    x = sum(np.sin(2 * np.pi * f * t) for f in (110, 220, 277.2, 329.6, 440))
    x /= np.sqrt(np.mean(x ** 2))
    return x * db2lin(level_db)


def room_noise(seconds, level_db=-66.0, seed=1):
    rng = np.random.default_rng(seed)
    return rng.standard_normal(int(seconds * FS)) * db2lin(level_db)


def make_engine(types, **master):
    chans = [cfgmod.channel(input=i + 1, name=t, type=t) for i, t in enumerate(types)]
    cfg = cfgmod.normalize({"channels": chans, "master": master})
    return Engine(cfg, FS, BLOCK)


def run(engine, inputs):
    """inputs: (n, C) array; returns stereo output (n, 2)."""
    n = inputs.shape[0] // BLOCK * BLOCK
    out = np.zeros((n, 2))
    for i in range(0, n, BLOCK):
        out[i:i + BLOCK] = engine.process(inputs[i:i + BLOCK])
    return out


# ---- tests -------------------------------------------------------------------

def test_limiter_never_exceeds_ceiling():
    lim = Limiter(FS, BLOCK, ceiling_db=-1.0)
    rng = np.random.default_rng(3)
    x = rng.standard_normal((FS * 2, 2)) * 1.5  # far too hot
    x[FS // 2: FS // 2 + 10] = 4.0               # big transient
    peak = 0.0
    for i in range(0, len(x), BLOCK):
        y = lim.process(x[i:i + BLOCK])
        peak = max(peak, float(np.max(np.abs(y))))
    assert peak <= db2lin(-1.0) + 1e-9


def test_limiter_is_transparent_below_ceiling():
    lim = Limiter(FS, BLOCK, ceiling_db=-1.0)
    x = np.tile(np.sin(np.linspace(0, 200 * np.pi, BLOCK * 20))[:, None] * 0.3, (1, 2))
    y = np.concatenate([lim.process(x[i:i + BLOCK]) for i in range(0, len(x), BLOCK)])
    assert np.allclose(y[BLOCK:], x[:-BLOCK], atol=1e-9)  # just delayed by one block


def test_stream_loudness_reaches_target():
    eng = make_engine(["speech"], target_lufs=-16.0)
    out = run(eng, speech_like(40, level_db=-32)[:, None])
    m = eng.read_meters()["master"]
    assert abs(m["short_term"] - (-16.0)) < 1.5, m
    assert np.max(np.abs(out)) <= db2lin(-1.0) + 1e-9


def test_idle_mic_is_gated_and_talking_mic_is_open():
    eng = make_engine(["lead_vocal", "lead_vocal"])
    x = np.stack([speech_like(15, -22), room_noise(15)], axis=1)
    run(eng, x)
    talking, idle = eng.strips
    assert idle.gate_db == pytest.approx(idle.p["gate_range"])
    assert not idle.gate_open
    assert talking.noise_floor < -50


def test_gain_sharing_between_speech_mics():
    eng = make_engine(["speech", "speech"], ducking="off")
    x = np.stack([speech_like(10, -20), room_noise(10)], axis=1)
    talking, idle = eng.strips
    shares = []
    for i in range(0, x.shape[0], BLOCK):
        eng.process(x[i:i + BLOCK])
        if i > 2 * FS:
            shares.append((talking.am_db, idle.am_db))
    shares = np.array(shares)
    assert shares[:, 0].min() > -3.0       # the talker is never pulled down much
    assert np.median(shares[:, 1]) < -10.0  # the idle mic mostly stays down


def test_music_ducks_under_speech_and_recovers():
    eng = make_engine(["speech", "instrument"], duck_depth_db=-9.0)
    secs = 10
    speech = np.concatenate([room_noise(5), speech_like(secs, -20)])
    music = music_like(5 + secs)
    run(eng, np.stack([speech, music], axis=1))
    assert eng.duck_db < -8.0
    assert eng.strips[1].p["duckable"]
    # speaker stops: music comes back within a few seconds
    run(eng, np.stack([room_noise(4), music_like(4)], axis=1))
    assert eng.duck_db > -0.5


def test_ducking_off():
    eng = make_engine(["speech", "instrument"], ducking="off")
    run(eng, np.stack([speech_like(6, -20), music_like(6)], axis=1))
    assert eng.duck_db == 0.0


def test_leveler_brings_up_a_quiet_talker():
    eng = make_engine(["speech"])
    run(eng, speech_like(30, level_db=-32)[:, None])
    s = eng.strips[0]
    assert s.lev_db > 6.0


def test_bypass_crossfade_and_reverb_are_clean():
    eng = make_engine(["lead_vocal", "instrument"])
    x = np.stack([speech_like(4, -20), music_like(4)], axis=1)
    a = run(eng, x[: 2 * FS])
    eng.update_master({"bypass": True})
    b = run(eng, x[2 * FS:])
    y = np.concatenate([a, b])
    assert np.all(np.isfinite(y))
    # no big jump at the switch
    d = np.abs(np.diff(y[:, 0]))
    assert d.max() < 0.5


def test_channel_changes_apply_from_another_thread():
    eng = make_engine(["speech", "instrument"])
    eng.update_channel(1, {"type": "playback", "fader_db": -6, "mute": True})
    run(eng, np.zeros((BLOCK * 2, 2)))
    assert eng.strips[1].type == "playback" and eng.strips[1].mute
    with pytest.raises(ValueError):
        eng.update_channel(0, {"type": "kazoo"})


def test_render_roundtrip(tmp_path):
    import soundfile as sf
    from fsm.audio_io import FileSource, render

    folder = tmp_path / "tracks"
    folder.mkdir()
    secs = 3
    sf.write(folder / "Track 1.wav", speech_like(secs, -20), FS)
    sf.write(folder / "Track 2.wav", music_like(secs), FS)
    sf.write(folder / "Track 10.wav", room_noise(secs), FS)
    src = FileSource(folder)
    assert [n.split("/")[-1] for n in src.names] == ["Track 1.wav", "Track 2.wav", "Track 10.wav"]

    cfg = cfgmod.normalize({"channels": [
        cfgmod.channel(input=1, type="speech"),
        cfgmod.channel(input=2, type="instrument"),
        cfgmod.channel(input=3, type="bg_vocal")]})
    out = tmp_path / "mix.wav"
    render(lambda fs, b: Engine(cfg, fs, b), src, str(out), progress=False)
    y, fs = sf.read(out)
    assert fs == FS and y.shape == (secs * FS, 2)
    assert power_db(y[:, 0]) > -40


def test_sixteen_channels_run_well_inside_real_time():
    types = [t for t, *_ in []] or ["speech", "speech", "lead_vocal", "bg_vocal", "bg_vocal",
                                    "instrument", "instrument", "instrument", "instrument",
                                    "instrument", "drums", "drums", "drums", "drums",
                                    "playback", "playback"]
    eng = make_engine(types)
    rng = np.random.default_rng(0)
    x = rng.standard_normal((BLOCK, 16)) * 0.05
    for _ in range(20):
        eng.process(x)
    t0 = time.perf_counter()
    n = 300
    for _ in range(n):
        eng.process(x)
    per_block = (time.perf_counter() - t0) / n
    print(f"\n16 ch @ 48 kHz: {per_block * 1000:.2f} ms per 10 ms block")
    assert per_block < 0.010


# ---- solo -------------------------------------------------------------------

def test_solo_in_place_and_linked_pairs():
    chans = [cfgmod.channel(input=1, type="instrument", pan=-1.0),
             cfgmod.channel(input=2, type="instrument", pan=1.0, link=True),
             cfgmod.channel(input=3, type="playback")]
    eng = Engine(cfgmod.normalize({"channels": chans}), FS, BLOCK)
    x = np.stack([music_like(3), music_like(3), music_like(3)], axis=1)
    run(eng, x)
    eng.update_channel(2, {"solo": True})
    run(eng, x[: FS])
    assert eng.any_solo
    assert eng.strips[0].gain_prev == 0 and eng.strips[1].gain_prev == 0
    assert eng.strips[2].gain_prev > 0
    # solo the left of a linked pair: both sides play, playback goes quiet
    eng.update_channel(2, {"solo": False})
    eng.update_channel(0, {"solo": True})
    run(eng, x[: FS])
    assert eng.strips[0].gain_prev > 0 and eng.strips[1].gain_prev > 0
    assert eng.strips[2].gain_prev == 0
    assert eng.read_meters()["master"]["solo_active"]
    eng.clear_solo()
    run(eng, x[: FS])
    assert not eng.any_solo and eng.strips[2].gain_prev > 0


def test_solo_is_never_saved(tmp_path):
    cfg = cfgmod.normalize({"channels": [cfgmod.channel(input=1, type="speech", solo=True)]})
    assert cfgmod.normalize({"channels": [cfgmod.channel(input=1, type="speech", solo=True)]})["channels"][0]["solo"] is False
    cfg["channels"][0]["solo"] = True
    cfgmod.save(cfg, tmp_path / "c.json")
    assert cfgmod.load(tmp_path / "c.json")["channels"][0]["solo"] is False


# ---- pitch correction ------------------------------------------------------

def sung(freq, seconds, level=0.1, vibrato=0.0):
    t = np.arange(int(seconds * FS)) / FS
    ph = 2 * np.pi * np.cumsum(freq * (1 + vibrato * np.sin(2 * np.pi * 5.5 * t))) / FS
    return sum(np.sin(h * ph) / h for h in range(1, 8)) * level + room_noise(seconds, seed=21)


def detected_cents(y, ref):
    from fsm.pitch import yin
    f, _ = yin(y[-int(0.1 * FS):], FS, FS // 1000, FS // 70)
    return 1200 * np.log2(f / ref)


def test_pitch_corrector_amounts():
    from fsm.pitch import PitchCorrector, scale_notes
    x = sung(440 * 2 ** (30 / 1200), 2.0)
    for amount, expect in ((1.0, 0.0), (0.5, 15.0), (0.0, 30.0)):
        pc = PitchCorrector(FS, BLOCK)
        y = np.concatenate([pc.process(x[i:i + BLOCK], True, amount, 40, scale_notes("chromatic"))
                            for i in range(0, len(x) - BLOCK + 1, BLOCK)])
        assert abs(detected_cents(y, 440) - expect) < 2.0, (amount, detected_cents(y, 440))


def test_pitch_corrector_leaves_in_tune_singing_untouched():
    from fsm.pitch import PitchCorrector, scale_notes
    x = sung(440, 1.0)
    pc = PitchCorrector(FS, BLOCK)
    y = np.concatenate([pc.process(x[i:i + BLOCK], True, 1.0, 40, scale_notes("chromatic"))
                        for i in range(0, len(x) - BLOCK + 1, BLOCK)])
    d = int(0.02 * FS)
    assert np.allclose(y[d:], x[: len(y) - d], atol=1e-9)  # exactly the input, 20 ms later


def test_pitch_corrector_respects_key():
    from fsm.pitch import PitchCorrector, scale_notes
    x = sung(277.18 * 2 ** (20 / 1200), 1.5)   # C#4 a little sharp
    pc = PitchCorrector(FS, BLOCK)
    for i in range(0, len(x) - BLOCK + 1, BLOCK):
        pc.process(x[i:i + BLOCK], True, 1.0, 40, scale_notes("C major"))
    assert pc.note == 62  # C# is not in C major; D is the nearest note in the key


def test_tune_in_the_engine_only_on_vocals_and_switches_cleanly():
    eng = make_engine(["lead_vocal", "speech"])
    eng.update_channel(0, {"tune": True, "tune_amount": 100, "tune_speed_ms": 40})
    eng.update_channel(1, {"tune": True})  # ignored: not a vocal channel
    x = np.stack([sung(440 * 2 ** (25 / 1200), 4.0, level=0.2), room_noise(4.0)], axis=1)
    y = run(eng, x)
    s0, s1 = eng.strips
    assert s0.tuning and not s1.tuning and s1.tuner is None
    assert abs(s0.tuner.cents + 25) < 3
    m = eng.read_meters()["channels"][0]
    assert m["tune_note"] == "A4" and m["tune_cents"] < -20
    eng.update_channel(0, {"tune": False})
    y2 = run(eng, x[:FS])
    assert np.all(np.isfinite(y)) and np.all(np.isfinite(y2))
    assert s0.tune_mix == 0.0
    with pytest.raises(ValueError):
        eng.update_master({"tune_key": "H major"})
    eng.update_master({"tune_key": "G major"})


# ---- stereo link gangs faders and settings -----------------------------------

def test_link_gangs_faders_and_settings_but_not_pan():
    chans = [cfgmod.channel(input=1, name="Keys L", type="instrument", pan=-1, fader_db=-3),
             cfgmod.channel(input=2, name="Keys R", type="instrument", pan=1, fader_db=2),
             cfgmod.channel(input=3, name="Bass", type="instrument")]
    eng = Engine(cfgmod.normalize({"channels": chans}), FS, BLOCK)
    changed = eng.update_channel(1, {"link": True})            # R takes L's settings
    assert set(changed) == {1} and changed[1]["fader_db"] == -3 and changed[1]["pan"] == 1
    changed = eng.update_channel(1, {"fader_db": -7.5})        # move either fader: both move
    assert set(changed) == {0, 1}
    changed = eng.update_channel(0, {"mute": True, "reverb_db": -20, "pan": -0.5, "name": "Keys left"})
    c0, c1, c2 = eng.snapshot_config()["channels"]
    assert c0["fader_db"] == c1["fader_db"] == -7.5 and c0["mute"] and c1["mute"]
    assert c1["reverb_db"] == -20 and c1["pan"] == 1 and c1["name"] == "Keys R"
    assert c2["fader_db"] == 0 and not c2["mute"]               # unlinked neighbour untouched
    eng.update_channel(1, {"link": False})
    eng.update_channel(1, {"fader_db": 0})
    assert eng.snapshot_config()["channels"][0]["fader_db"] == -7.5
    run(eng, np.zeros((BLOCK * 2, 3)))                          # pending strip updates apply cleanly
    assert eng.strips[0].mute and eng.strips[1].fader_db == 0


def test_loading_a_config_lines_up_linked_pairs():
    cfg = cfgmod.normalize({"channels": [
        cfgmod.channel(input=1, type="playback", fader_db=-4, pan=-1, link=True),   # first can't link
        cfgmod.channel(input=2, type="instrument", fader_db=3, pan=1, link=True)]})
    c0, c1 = cfg["channels"]
    assert c0["link"] is False and c1["type"] == "playback" and c1["fader_db"] == -4 and c1["pan"] == 1


# ---- auto-level controls -----------------------------------------------------

def test_auto_level_range_speed_and_off():
    quiet = speech_like(20, level_db=-34)[:, None]          # wants about +14 dB
    default = make_engine(["speech"]); run(default, quiet)
    assert default.strips[0].lev_db > 10                     # speech default range is 12

    narrow = make_engine(["speech"]); narrow.update_channel(0, {"level_range": 3}); run(narrow, quiet)
    assert 2.5 < narrow.strips[0].lev_db <= 3.0

    slow = make_engine(["speech"]); slow.update_channel(0, {"level_speed": 1}); run(slow, quiet[: 4 * FS])
    fast = make_engine(["speech"]); fast.update_channel(0, {"level_speed": 10}); run(fast, quiet[: 4 * FS])
    assert fast.strips[0].lev_db > slow.strips[0].lev_db + 3

    default.update_channel(0, {"auto_level": False})        # switched off: glides back to 0 dB
    run(default, quiet[: 6 * FS])
    assert default.strips[0].lev_db == 0.0
    assert default.read_meters()["channels"][0]["auto_level"] is False

    narrow.update_channel(0, {"level_range": None})          # back to the type's default range
    run(narrow, quiet[: 8 * FS])
    assert narrow.strips[0].lev_db > 6
    with pytest.raises(ValueError):
        narrow.update_channel(0, {"level_speed": "fast"})
