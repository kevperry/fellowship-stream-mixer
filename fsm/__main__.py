"""Command line: python -m fsm <command>"""

from __future__ import annotations

import argparse
import json
import signal
import sys
import threading
import webbrowser
from pathlib import Path

from . import config as cfgmod


def main(argv=None):
    ap = argparse.ArgumentParser(prog="fsm", description="Fellowship Stream Mixer — automatic livestream mixing")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("devices", help="list audio devices")

    p = sub.add_parser("init", help="write a starter config file")
    p.add_argument("path", nargs="?", default="config.json")
    p.add_argument("--channels", type=int, default=16)

    p = sub.add_parser("run", help="mix live from the desk (or play a recording with --play)")
    p.add_argument("--config", default="config.json")
    p.add_argument("--play", metavar="PATH", help="multitrack file or folder to play instead of live input")
    p.add_argument("--loop", action="store_true", help="loop the --play recording")
    p.add_argument("--no-audio", action="store_true", help="with --play: don't use the sound card")
    p.add_argument("--output", metavar="DEVICE",
                   help="output device name or number (with --play the default is your Mac's speakers/headphones)")
    p.add_argument("--host", default="127.0.0.1",
                   help="use 0.0.0.0 to reach the control panel from a phone or iPad on the same network")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--no-browser", action="store_true")

    p = sub.add_parser("render", help="mix a multitrack recording to a stereo file")
    p.add_argument("input", help="multichannel file or a folder of tracks")
    p.add_argument("output", help="stereo .wav to write")
    p.add_argument("--config", default="config.json")
    p.add_argument("--bypass", action="store_true", help="render the plain fader mix for comparison")

    p = sub.add_parser("add-demo", help="add a short multitrack clip to the practice website's demo list")
    p.add_argument("input", help="multichannel file or a folder of tracks")
    p.add_argument("--title", required=True, help='name shown on the page, e.g. "Sunday worship"')
    p.add_argument("--description", default="", help="one line shown under the title")
    p.add_argument("--start", help="where the clip starts: seconds, m:ss or h:mm:ss (default: the beginning)")
    p.add_argument("--length", help="how long the clip is, e.g. 3:00 (default: to the end)")
    p.add_argument("--config", help="a config.json whose channel names/types/tune settings the demo should open with")
    p.add_argument("--skip-silent", action="store_true", help="leave out tracks with nothing on them")
    p.add_argument("--folder", help="folder name under docs/demos (default: made from the title)")
    p.add_argument("--replace", action="store_true", help="replace a demo that already has this folder name")
    p.add_argument("--mp3", action="store_true", help="save tracks as MP3 (about 6x smaller than WAV)")

    sub.add_parser("demo-index", help="rebuild docs/demos/index.json after adding or removing demo files")

    args = ap.parse_args(argv)

    if args.cmd == "add-demo":
        from .demos import add_demo
        add_demo(args.input, args.title, args.description, args.start, args.length, args.config,
                 args.skip_silent, folder=args.folder, overwrite=args.replace, mp3=args.mp3)
        print("Next: commit and push (or upload the folder on GitHub) to publish it.")
        return

    if args.cmd == "demo-index":
        from .demo_index import build
        build()
        return

    if args.cmd == "devices":
        from .audio_io import list_devices
        print(list_devices())
        return

    if args.cmd == "init":
        path = Path(args.path)
        if path.exists():
            sys.exit(f"{path} already exists — not overwriting it.")
        cfgmod.save(cfgmod.example_config(args.channels), path)
        print(f"Wrote {path}. Edit the channel names and types, or change them in the control panel.")
        return

    cfg = cfgmod.load(args.config)
    from .engine import Engine

    def factory(fs, block):
        return Engine(cfg, fs, block)

    if args.cmd == "render":
        from .audio_io import FileSource, render
        if args.bypass:
            cfg["master"]["bypass"] = True
        eng = render(factory, FileSource(args.input), args.output, cfg["audio"]["block_ms"])
        m = eng.read_meters()["master"]
        print(f"Wrote {args.output}  (last short-term loudness {m['short_term']} LUFS)")
        return

    # run
    from .audio_io import FileSource, run_files, run_live
    from .server import ControlServer

    server = ControlServer(args.host, args.port, args.config)
    server.start()
    url = f"http://{'localhost' if args.host in ('127.0.0.1', '0.0.0.0') else args.host}:{args.port}"
    stop = threading.Event()
    signal.signal(signal.SIGINT, lambda *a: stop.set())
    signal.signal(signal.SIGTERM, lambda *a: stop.set())

    def ready(engine):
        server.engine = engine
        print(f"Control panel: {url}   (Ctrl+C to stop)")
        if not args.no_browser:
            webbrowser.open(url)

    try:
        audio = dict(cfg["audio"])
        if args.play:
            # Practice: listen on the Mac's own output unless told otherwise.
            audio["output_device"] = args.output
            audio["output_channels"] = [1, 2]
            run_files(factory, FileSource(args.play, loop=args.loop), audio, stop, ready,
                      play=not args.no_audio)
        else:
            if args.output:
                audio["output_device"] = args.output
            run_live(factory, audio, stop, ready)
    finally:
        server.stop()


if __name__ == "__main__":
    main()
