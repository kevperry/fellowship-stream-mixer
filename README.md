# Fellowship Stream Mixer

Automatic mixing for church livestreams. It takes the individual channels from
your desk, mixes them for the stream, and keeps that mix balanced and at a steady
volume while the service goes on. Volunteers keep the faders. The fiddly work is
done for them.

> **Status: prototype (v0.1).** Built for an Allen & Heath **SQ‑6** connected to a
> **Mac** over USB, streaming with **OBS**. Try it on a rehearsal or a recorded
> service before relying on it live.

## What it does

You tag each channel once with what's plugged into it: *Speaker/Pastor, Vocal,
Instrument, Drums, Playback* or *Off*. From then on,
every 10 ms, it:

| | |
|---|---|
| **Cleans up each source** | A high‑pass filter suited to the source type, then an **adaptive EQ** and a **mild compressor** (below). No curves to draw. |
| **Adaptive EQ** | While a channel is active, it measures the channel's tone in seven bands (125 Hz–8 kHz) and slowly steers it toward a target sound for that kind of source. Boomy mics get their low‑mids cut, and dull ones get a touch of presence. Presets: Spoken voice, Vocal, Keys/piano, Guitar, Bass, Drum kit/overheads, Instrument (general), Off. It's deliberately gentle: it averages about 20 seconds of sound, ignores small differences (±2 dB for voices, ±4 dB for instruments), cuts at most 6 dB, boosts at most 3 dB and only from 1 kHz up, and moves at most 0.5 dB per second. |
| **Mild compressor** | On every channel: Off, Light (1.5:1), **Mild (2:1, default)**, Medium (3:1) or Firm (4:1), set relative to the channel's level target. Playback defaults to Light. |
| **Rides the level** | A slow leveler brings a quiet talker up and a loud one down (±12 dB for speech). |
| **Gates idle mics** | Mics nobody is using ease down. The gate threshold follows each mic's noise floor, so there's nothing to set. |
| **Shares gain between speech mics** | Pastor, pulpit and lectern mics share one open mic's worth of gain, so there's no phasing or room boom. The last person who spoke stays up. |
| **Ducks music under speech** | When someone talks, instruments and playback step back (−9 dB) and return smoothly afterwards. Always automatic; untick **Ducks music** on a speech mic that picks up the band. |
| **Rests the reverb between songs** | While no instrument, drums or playback is playing, the vocal reverb sends fade out, so a worship leader talking or praying is heard dry. The reverb returns the moment music starts, and the last note's tail rings out naturally. |
| **Stream polish** | A gentle finish on the final mix: a 30 Hz rumble filter, a 1 dB dip at 300 Hz (mud) and a 1 dB lift above 8 kHz (clarity on phone speakers), plus 1.5:1 glue compression that only eases swells more than 4 dB above the mix's recent level, at most 4 dB. On by default; switch it in the master section. |
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

Each channel strip has just the name, meters, **fader**, **pan**, **Mute** and
**Solo**. Click a channel's name to select it. Everything else for that channel
opens in **Channel settings** at the top right of the screen: name, source type,
Link, the automatic level, EQ, compressor, reverb send, and Tune or Ducks music
where they apply. Name each channel and choose its type there, then click
**Save settings**. Some tips:

- Use **Speaker / Pastor** for every spoken‑word mic: pastor's headset, pulpit,
  announcements, prayer mic. These share gain and duck the music.
- Use **Vocal** for every singer, worship leader and backing vocals alike.
  Vocals are *not* ducked, and they don't duck the band, so singing over the
  band works as expected.
- For a stereo pair, such as keys L/R, playback L/R or overheads, click **Link ◂**
  at the bottom of the right‑hand channel's strip. The two become **one stereo
  strip** (for example *IN 3/4 · Keys*) with one fader, one Mute/Solo and one
  set of Channel settings. The left side is panned hard left and the right side
  hard right. A pair named *Keys L* / *Keys R* shows as *Keys*; renaming the pair
  renames both sides. **Unlink** at the bottom of the stereo strip splits it
  back into two channels. A channel can only join a single channel, not one
  that's already part of a pair. The automatic mixing treats the pair as one,
  so the stereo image stays put.
- Set any channel you don't use to **Off**.

## During a service

- **Faders** set the balance you want; the mixer keeps things around it. Double‑click
  a fader to reset it to 0.
- **Music ducking is automatic.** If a speech mic picks up the band and keeps
  ducking it, such as a pastor's headset during worship, select that channel and
  untick **Ducks music** under Auto level.
- **Reverb** rests automatically while no music is playing, and the master
  section shows "Reverb resting — no music". If the band's mics pick up the PA
  strongly, the mixer may think music is still playing; lowering or muting those
  channels between songs helps.
- **Auto level** (in Channel settings) shows one line, for example *Target
  −20 dBFS · ±9 dB · now +1.5*: the level it aims for on that type of channel
  (about −20 dBFS average for speech and vocals, −24 for instruments, −26 for
  drums, −22 for playback), how far it may move the channel, and what it's doing
  right now. Hover the line for more. Your fader sits on top. Its controls:
  - **Auto level**: untick it to stop the mixer riding this channel, for example
    a playback track that's already mixed. Gating, compression and your fader
    still apply.
  - **Range**: how far it may turn the channel up or down. The default depends
    on the source type: ±12 dB for speech, ±9 for vocals, ±6 for instruments and
    playback, ±4 for drums.
  - **Speed**: how quickly it rides, in dB per second (default 3). Slower is
    smoother; faster catches sudden changes, such as a quiet prayer followed by
    a loud announcement.

  **Reset** puts all three back. Linked stereo pairs share these
  settings.
- **Parametric EQ** (in Channel settings): a high‑pass filter plus four bands,
  drawn as a curve from 20 Hz to 20 kHz. Drag a numbered point to change its
  frequency and gain, use the mouse wheel on it to make it narrower or wider (Q),
  and double‑click it to flatten that band. Drag the dashed **HPF** line to move
  the high‑pass filter, or untick **HPF** to switch it off.
  - **Source curve** picks a suggested starting curve for the kind of source:
    Spoken voice, Vocal, Keys/piano, Guitar, Bass, Drum kit/overheads or
    Instrument. Once you drag anything, the curve shows as *edited*; **Reset to
    suggested** puts it back.
  - **Auto EQ** is the adaptive EQ's amount (0–100 %, default 50 %). It measures
    the source *before* your curve, so it never undoes your moves. Its small
    automatic corrections appear as the faint dashed line.
- **Compressor** (in Channel settings) shows its gain reduction. **Reverb
  send** is there too.
- **Gate:** the small **Gate** slider at the bottom of each strip sets a
  threshold. Below it, a **soft gate** eases the channel down: gently just
  under the threshold, down to the full depth further below. Far left (or
  double‑click) is **auto**, which follows the mic's background noise. A line
  on the strip's meter marks the threshold: dashed for auto, solid blue when
  you've set it, gold while the gate is closing. **Depth**, **Hold** and
  **Release** are in Channel settings; **Auto gate** resets them. The EQ preset starts from the source type and the channel's
  name. A channel named *Bass* gets the Bass preset, *Acoustic Gtr* gets Guitar,
  and *Keys* gets Keys/piano. Single drum mics (*Kick*, *Snare*, *Tom*, *Hat*)
  start with EQ Off, because the kit target is for overheads or a stereo kit. Linked pairs share these settings.
- **Solo** is for checking a channel. On the live app it changes **what the
  stream hears**, the same as on the practice page. While anything is soloed,
  a flashing **SOLO ACTIVE** button appears; click it to clear every solo. Solo
  is never saved, so a restart always comes back un‑soloed.
- **Tune** appears on Vocal channels. Start around
  **Amount 40–60%, Speed 150–250 ms** for a natural sound. Set **Song key**
  for each song so notes are pulled toward the right scale, or leave it on
  *Chromatic*. Channel settings shows the note it hears and the correction in
  cents (¢). Tuning adds about 20 ms of delay to that one channel.
- **Auto mix: ON/OFF** switches to a plain fader mix, for comparison or if
  something sounds wrong.
- To control it from an **iPad or phone**, start it with `--host 0.0.0.0`. Then
  open `http://<the Mac's name>.local:8765` on any device on the same network.
  Anyone on that network can then change the mix, so use it on the church's
  private network only.

## Recording a service

Click **● Record** in the control panel. Every desk input the mixer uses is
saved as its own 24‑bit WAV file, numbered to match the desk (`01 Pastor.wav`,
`02 Pulpit.wav` …). The finished stream mix is saved alongside as
`_stream mix.wav`, and the settings at that moment as `config.json`. Everything
goes into a dated folder under `recordings/`. Click **■ Stop recording** when
you're done; quitting the mixer also stops and saves it.

- The panel shows the running time, the size so far and the free disk space.
  Recording stops by itself before the disk fills (it keeps 2 GB free).
- Disk use is about **9 GB per hour** for 16 channels at 48 kHz, or **19 GB per
  hour** at 96 kHz, which is the SQ's USB rate. An external SSD is a good home
  for `record_dir`.
- Writing to disk happens in the background, so a slow disk can't interrupt the
  live mix. If the disk ever falls behind, the panel counts the gaps.
- Drop the whole folder onto the practice page, or play it with
  `python -m fsm run --play "recordings/<folder>"`. It opens with that service's
  channel settings, and the stream‑mix file is skipped.
- Recordings stay on the Mac and aren't uploaded anywhere. `recordings/` is
  excluded from git.

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
| `audio.record_dir` | Where the Record button saves (default `recordings`). |
| `master.polish` | Stream polish on/off (default on). |
| `audio.block_ms` | Processing block size. Raise it to 20 if you hear dropouts. |
| `master.target_lufs` | Stream loudness target. −16 is a good default; YouTube normalises to −14. |
| `master.duck_depth_db` | How far music dips under speech (default −9). Ducking itself is always automatic. |
| `channels[].input` | The desk channel / USB channel number. |
| `channels[].type` | `speech`, `lead_vocal` (shown as Vocal), `instrument`, `drums`, `playback`, `off`. |
| `channels[].fader_db`, `mute`, `pan`, `trim_db` | Usual channel controls. `trim_db` adjusts input level before processing. |
| `channels[].reverb_db` | Reverb send; `null` uses the source type's default. |
| `channels[].ducks_music` | Override whether this mic ducks the music (`true`/`false`/`null`). |
| `channels[].link` | Join the channel before it as one stereo strip: fader, mute and all settings are shared; linking sets the pans to hard left/right. |
| `channels[].tune`, `tune_amount`, `tune_speed_ms` | Pitch correction on/off (vocal types only), strength 0–100 %, and speed in ms (10–500). |
| `channels[].auto_level`, `level_range`, `level_speed` | Ride this channel's level (true/false); how far, in ± dB (`null` = the source type's default); how fast, in dB per second (`null` = 3). |
| `channels[].eq_preset`, `eq_amount`, `comp` | Adaptive EQ target (`speech`, `vocal`, `keys`, `guitar`, `bass`, `drums`, `instrument`, `off`; `null` = automatic), strength 0–100 %, and compressor (`off`, `light`, `mild`, `medium`, `firm`; `null` = automatic). |
| `channels[].peq` | Your EQ curve: `{"hpf": Hz or null, "bands": [[Hz, dB, Q] × 4]}`; `null` = the suggested curve for the EQ preset. |
| `channels[].gate_threshold`, `gate_depth`, `gate_hold_ms`, `gate_release_ms` | Gate threshold in dBFS (`null` = automatic), depth in dB, hold and release in ms (`null` = the source type's default). |
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
