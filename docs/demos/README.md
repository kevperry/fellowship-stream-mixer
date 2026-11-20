# Demo recordings

Each folder here is one demo on the practice page. Anything in this folder is
**public**: anyone can play or download it from the website.

A demo folder holds:

- one **audio file per channel**, played in name order (`01 Pastor.mp3`, `02 Worship leader.mp3`, …).
  **MP3** and **WAV** both work (M4A, FLAC and OGG too). MP3 is about 6× smaller, so clips can be much
  longer. A stereo MP3 whose two sides are identical counts as one channel. Don't mix MP3s with WAVs
  that aren't 48 kHz.
- `demo.json` *(optional)*: `{"title": "Sunday worship", "description": "One song and the welcome"}`
- `config.json` *(optional)*: the channel settings the demo opens with. Get one from the practice
  page with **Settings → Download settings**.

The easiest way to make one is on the Mac:

```bash
python -m fsm add-demo "path/to/recording" --title "Sunday worship" --start 12:30 --length 3:00 --skip-silent
```

That cuts the clip and converts it to 16-bit 48 kHz WAV, about 5.5 MB per track per minute. It
also writes `demo.json` and `index.json`.

Add `--mp3` to that command to save MP3s instead (about 1.2 MB per track per minute).

You can also upload a folder of MP3 or WAV files through the GitHub website. Use **Add file → Upload
files** here and drag the folder in, then click **Commit changes**. The website takes files up to
25 MB: about 20 minutes of a 160 kbps MP3 track, or about 4 minutes of a 16-bit 48 kHz WAV track. The demo list (`index.json`) rebuilds automatically when the site
publishes.

Keep all demos together under about 900 MB. Only publish recordings you have permission to share,
both from the people on them and for the songs.
