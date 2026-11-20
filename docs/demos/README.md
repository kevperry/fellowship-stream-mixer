# Demo recordings

Each folder here is one demo on the practice page. Anything in this folder is
**public**: anyone can play or download it from the website.

A demo folder holds:

- one **WAV file per channel**, played in name order (`01 Pastor.wav`, `02 Worship leader.wav`, …)
- `demo.json` *(optional)*: `{"title": "Sunday worship", "description": "One song and the welcome"}`
- `config.json` *(optional)*: the channel settings the demo opens with. Get one from the practice
  page with **Settings → Download settings**.

The easiest way to make one is on the Mac:

```bash
python -m fsm add-demo "path/to/recording" --title "Sunday worship" --start 12:30 --length 3:00 --skip-silent
```

That cuts the clip and converts it to 16-bit 48 kHz WAV, about 5.5 MB per track per minute. It
also writes `demo.json` and `index.json`.

You can also upload a folder of WAV files through the GitHub website. Use **Add file → Upload
files** here and drag the folder in. The website takes files up to 25 MB, which is about 4 minutes
of a 16-bit 48 kHz track. The demo list (`index.json`) rebuilds automatically when the site
publishes.

Keep all demos together under about 900 MB. Only publish recordings you have permission to share,
both from the people on them and for the songs.
