#!/bin/bash
# Double-click this file in Finder to start the mixer.
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  echo "First run: setting things up (this takes a minute)..."
  python3 -m venv .venv || { echo "Python 3 is not installed. See README.md."; read -r; exit 1; }
  .venv/bin/pip install -q -r requirements.txt
fi
if [ ! -f config.json ]; then
  .venv/bin/python -m fsm init config.json
fi
.venv/bin/python -m fsm run --config config.json "$@"
echo "Mixer stopped. Press Return to close this window."
read -r
