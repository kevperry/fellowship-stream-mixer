# Fellowship Stream Mixer

Automatic mixing for church livestreams. It takes the individual channels from
your desk, mixes them for the stream, and keeps that mix balanced and at a steady
volume while the service goes on. Volunteers keep the faders. The fiddly work is
done for them.

> **Status: prototype (v0.1).** Built for an Allen & Heath **SQ‑6** connected to a
> **Mac** over USB, streaming with **OBS**. Try it on a rehearsal or a recorded
> service before relying on it live.

## What it does

You tag each channel once with what's plugged into it: *Speaker/Pastor, Lead
vocal, Background vocal, Instrument, Drums, Playback* or *Off*. From then on,
every 10 ms, it:

| | |
|---|---|
| **Cleans up each source** | Applies a high‑pass filter, EQ and compression suited to the source type. No curves to draw. |
| **Rides the level** | A slow leveler brings a quiet talker up and a loud one down (±12 dB for speech). |
| **Gates idle mics** | Mics nobody is using ease down. The gate threshold follows each mic's noise floor, so there's nothing to set. |
| **Shares gain between speech mics** | Pastor, pulpit and lectern mics share one open mic's worth of gain, so there's no phasing or room boom. The last person who spoke stays up. |
| **Ducks music under speech** | When someone talks, instruments and playback step back (−9 dB by default) and return smoothly afterwards. |
| **Holds stream loudness** | Keeps the stream at a steady loudness target (−16 LUFS by default) and puts a limiter on the output so it never clips. |
| **Adds reverb** | Vocals get a hall reverb send, since direct outs are dry. |
| **Light pitch correction** | Optional, per vocal channel (**Tune**). It finds the note being sung and nudges it toward the nearest note in the song's key. **Amount** (0–100%) sets how far, and **Speed** sets how quickly. Slow speeds leave vibrato and expression alone. In‑tune singing passes through untouched. |
| **Solo** | Hear only the soloed channels (solo in place). Soloing one side of a linked stereo pair solos both. |
| **A/B switch** | One click switches between the automatic mix and a plain fader mix, so you can hear the difference. |

The control panel runs in a web browser. It shows meters, an "active" light and
an **auto** figure per channel (how many dB the mixer is adjusting it right now),
plus stream loudness, ducking state and processor load. Hover over **auto** to
see the breakdown.

All processing happens on the Mac. Nothing is sent to the cloud.

## How it fits together

```
SQ-6 inputs ──direct outs──► USB-B (32×32) ──► Mac: Fellowship Stream Mixer ──► BlackHole 2ch ──► OBS ──► YouTube / Facebook
                                                    ▲
                                       control panel in a browser
                                       (on the Mac, or an iPad on the same Wi‑Fi)
```

Your front‑of‑house mix in the room is untouched. The stream mixer works on its
own copy of the channels.

## Setup (one time)

### 1. SQ‑6: send the channels to the Mac

1. Connect the SQ‑6's rear **USB‑B** port to the Mac. macOS needs no driver; the
   desk shows up as an audio device with "SQ" in its name.
2. On the SQ, open the **I/O** screen. Under outputs, choose **USB‑B** and check
   that USB outputs 1–16 are patched from **Input 1–16 Direct Out**. Patch any you
   need.
3. In the SQ's **Direct Out** settings, choose a source point of **Post‑Preamp**
   (or Post‑HPF), and turn off "follow fader" and "follow mute". The stream mixer
   does its own EQ and dynamics, and your room mix moves shouldn't change the
   stream.
4. Get the **preamp gain** right on the desk, as usual. The mixer copes with level
   differences, but it can't fix clipping or a mic turned way down.

*(Menu names vary a little between SQ firmware versions. The aim is "direct outs
1–16 → USB‑B 1–16, taken post‑preamp".)*

### 2. Mac: install the pieces

1. **Python 3.11 or newer.** Install from [python.org](https://www.python.org/downloads/macos/),
   or with Homebrew: `brew install python`.
2. **BlackHole 2ch**, a free virtual cable from the mixer to OBS:
   `brew install blackhole-2ch`, or download it from existential.audio.
3. Open **Audio MIDI Setup** (in Applications → Utilities). Set **BlackHole 2ch**
   to the same sample rate as the SQ (normally 96 kHz).
4. Get this project onto the Mac: `git clone` it or download the ZIP.

### 3. Start it

Double‑click **`start.command`** in Finder. The first time, it installs what it
needs and creates `config.json`. After that, it opens the control panel in your
browser. If macOS blocks the file, right‑click it and choose **Open**.

The first time, macOS asks whether **Terminal may use the microphone**. Click
**Allow**, because that's how the app hears the SQ. If you miss the prompt, turn
it on in System Settings → Privacy & Security → Microphone, then restart the app.

You can also run it from Terminal:

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m fsm devices          # list audio devices
python -m fsm init config.json # create a starter config (first time only)
python -m fsm run              # start mixing; the panel opens at http://localhost:8765
```

### 4. OBS

In OBS, add an **Audio Input Capture** source and pick **BlackHole 2ch**. Turn
off any other audio sources that carry the band or the mics, so nothing is
doubled. If the sound and picture drift apart, adjust the source's **Sync
Offset** under Advanced Audio Properties. The mixer adds about 20–30 ms.

### 5. Tag your channels

In the control panel, name each channel and choose its type. Click **Save
settings**. Some tips:

- Use **Speaker / Pastor** for every spoken‑word mic: pastor's headset, pulpit,
  announcements, prayer mic. These share gain and duck the music.
- Use **Lead vocal** for the worship leader. Lead vocals are *not* ducked, and
  they don't duck the band, so singing over the band works as expected.
- For a stereo pair, such as keys L/R, playback L/R or overheads, tick **Link** on
  the right‑hand channel. Both sides then move together.
- Set any channel you don't use to **Off**.

## During a service

- **Faders** set the balance you want; the mixer keeps things around it. Double‑click
  a fader to reset it to 0.
- **Music ducking** → set it to **Off** during the worship set if the pastor's
  headset picks up the band and keeps ducking it. Set it back to **Auto** for the
  sermon. You can also turn off one mic's ducking in `config.json`
  (`"ducks_music": false`).
- **Solo** is for checking a channel. On the live app it changes **what the
  stream hears**, the same as on the practice page. While anything is soloed,
  a flashing **SOLO ACTIVE** button appears; click it to clear every solo. Solo
  is never saved, so a restart always comes back un‑soloed.
- **Tune** appears on Lead and Background vocal channels. Start around
  **Amount 40–60%, Speed 150–250 ms** for a natural sound. Set **Song key**
  for each song so notes are pulled toward the right scale, or leave it on
  *Chromatic*. The strip shows the note it hears and the correction in cents
  (¢). Tuning adds about 20 ms of delay to that one channel.
- **Auto mix: ON/OFF** switches to a plain fader mix, for comparison or if
  something sounds wrong.
- To control it from an **iPad or phone**, start it with `--host 0.0.0.0`. Then
  open `http://<the Mac's name>.local:8765` on any device on the same network.
  Anyone on that network can then change the mix, so use it on the church's
  private network only.

## Practise in your browser (no install)

**https://kevperry.github.io/fellowship-stream-mixer/**

Open the page, then drop in your multitrack WAV or MP3 files, or click **Try the demo**.
It's the same mixer, running in the browser, with the same control panel plus
play, pause, seek and loop. Your audio is read straight from your computer and
never uploaded. Chrome, Edge or Safari on a laptop or desktop work best.

### Publishing your own demo recordings

Short clips you put in `docs/demos/` appear on the page under **Demo
recordings**, for anyone to play. They open with their own channel settings
and stream from the website. They're public, so publish only recordings you
have permission to share, from the people on them and for the songs.

```bash
# on the Mac: cut a 3-minute clip, convert it, keep your channel settings
python -m fsm add-demo "path/to/recording" --title "Sunday worship" \
    --description "Opening song and welcome" --start 12:30 --length 3:00 \
    --config config.json --skip-silent --mp3
git add docs/demos && git commit -m "Add Sunday worship demo" && git push
```

You can also skip the Mac. On GitHub, open `docs/demos`, choose **Add file →
Upload files**, and drag in a folder of WAV files (25 MB per file, about 4
minutes of 16‑bit 48 kHz). The demo list rebuilds when the site publishes. See
`docs/demos/README.md` for the details and size limits; keep all demos together
under about 900 MB.

The site is published by `.github/workflows/pages.yml`. In the repository's
**Settings → Pages**, set **Source** to **GitHub Actions**.

When the mix sounds right, use **Settings → Download settings**. Put the file in
the project folder on the Mac as `config.json`, and the live mixer starts from
those settings on Sunday. Channel *n* in the recording becomes input *n* on the
desk, so record with channel 1 on track 1, and so on.

The page lives in `docs/`. `docs/engine.js` is a JavaScript port of the Python
engine; a test checks that their source‑type presets stay identical.

## Practise on the Mac without the desk

Record a service as multitrack, then play it back through the mixer at home.
You can record on the SQ to USB, or in Logic, GarageBand or Reaper over USB.

```bash
# listen in real time with the control panel (plays through the Mac's speakers/headphones;
# add --output BlackHole to feed OBS instead)
python -m fsm run --play "path/to/recording folder" --loop

# or mix it straight to a file, for before/after comparisons
python -m fsm render "path/to/recording folder" automix.wav
python -m fsm render "path/to/recording folder" plain.wav --bypass
```

The recording can be one multichannel WAV, or a folder of per‑track files. They
are read in name order, so `Track 1, Track 2, … Track 10`.

## Configuration reference (`config.json`)

| Key | Meaning |
|---|---|
| `audio.input_device` | Part of the input device's name (`"SQ"`) or its number from `fsm devices`. |
| `audio.output_device` | Where the stereo mix goes (`"BlackHole"`). |
| `audio.output_channels` | Which output channels get L/R, numbered from 1 (default `[1, 2]`). |
| `audio.block_ms` | Processing block size. Raise it to 20 if you hear dropouts. |
| `master.target_lufs` | Stream loudness target. −16 is a good default; YouTube normalises to −14. |
| `master.ducking` / `duck_depth_db` | `"auto"` or `"off"`, and how far music dips under speech. |
| `channels[].input` | The desk channel / USB channel number. |
| `channels[].type` | `speech`, `lead_vocal`, `bg_vocal`, `instrument`, `drums`, `playback`, `off`. |
| `channels[].fader_db`, `mute`, `pan`, `trim_db` | Usual channel controls. `trim_db` adjusts input level before processing. |
| `channels[].reverb_db` | Reverb send; `null` uses the source type's default. |
| `channels[].ducks_music` | Override whether this mic ducks the music (`true`/`false`/`null`). |
| `channels[].link` | Stereo‑link with the channel before it. |
| `channels[].tune`, `tune_amount`, `tune_speed_ms` | Pitch correction on/off (vocal types only), strength 0–100 %, and speed in ms (10–500). |
| `master.tune_key` | `"chromatic"` or a key such as `"G major"`, `"E minor"`, `"Bb major"`. |

The per‑type sound (EQ, compression, targets) lives in `fsm/presets.py` if you
want to adjust it.

## Troubleshooting

- **"No input device matching 'SQ'"**: run `python -m fsm devices` and put the
  exact name, or its number, in `audio.input_device`.
- **Meters move but OBS hears nothing**: check that OBS is capturing BlackHole 2ch
  and that `output_device` is `"BlackHole"`.
- **Crackles or the dropout counter climbing**: set `block_ms` to 20. Close other
  heavy apps. Check that BlackHole and the SQ run at the same sample rate.
- **Nothing on the inputs at all**: check the macOS microphone permission for
  Terminal, and the USB‑B patch on the SQ.
- **If the input and output are separate devices and you get glitches over long
  services**: create an **Aggregate Device** in Audio MIDI Setup with the SQ (as
  clock source) plus BlackHole 2ch, with drift correction on BlackHole. Use it as
  both `input_device` and `output_device`, with `output_channels` set to
  `[33, 34]`, since BlackHole's channels come after the SQ's 32.

## Development

```bash
pip install pytest
python -m pytest -q                              # Python engine
node --test tests/engine.test.js tests/wav.test.js   # browser engine + WAV reader
```

The tests use synthetic speech, music and room noise to check the following:
the limiter never exceeds its ceiling, loudness reaches the target, idle mics
close, gain sharing favours the talker, music ducks and recovers, the leveler
lifts a quiet talker, the A/B switch crossfades cleanly, and file rendering works.
They also check that 16 channels run well inside real time.

Code map: `fsm/engine.py` (mixing logic), `fsm/dsp.py` (filters, loudness meter,
limiter, reverb), `fsm/presets.py` (source types), `fsm/audio_io.py` (sound card
and files), `fsm/server.py` + `fsm/web/` (control panel).

## Ideas for next steps

- Record the raw multitrack from inside the app, for practice and tuning.
- Smarter speech detection, so a pastor's headset picking up the band doesn't
  trigger ducking during worship.
- Scene modes (Worship / Sermon / Announcements) with one click.
- Read channel names straight from the SQ over its network protocol.
- A native Mac app (no Terminal) once the sound is proven.
