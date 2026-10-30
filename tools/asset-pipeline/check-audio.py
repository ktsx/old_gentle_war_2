#!/usr/bin/env python3
"""check-audio.py — judge the audio CI step from ui-script.js output.

The step prints GX_audioStats() (web_audio_bridge.cpp) at three points as
    js: "AUDIOCHECK <when> {...json...}"
and the counters are cumulative:
  menu   the shell track came from the archive and is audible: a stream is ready, none failed,
         and the output level (max RMS on the master bus) is above silence
  click  a UI sample played and ended (2D end-of-sample callback)
  game   world (3D) samples played and ended — their end-of-sample callbacks free the engine's 3D
         channels — no sound failed to decode, and voices do not pile up

usage: check-audio.py <ui-script log>; exit 1 on failure
"""
import json
import re
import sys

text = open(sys.argv[1], encoding="utf-8", errors="replace").read()
stats = {}
for m in re.finditer(r'js: ("AUDIOCHECK .*")\s*$', text, re.M):
    _, when, payload = json.loads(m.group(1)).split(" ", 2)
    stats[when] = json.loads(payload)

checks = {
    "menu": lambda s: [
        ("context running", s["state"] == "running"),
        ("a stream ready", s["streamsReady"] >= 1),
        ("no stream failed", s["streamErrors"] == 0),
        ("audible (max RMS >= 0.003)", s["maxRms"] >= 0.003),
    ],
    "click": lambda s: [
        ("a 2D sample started", s["started2D"] >= 1),
        ("a 2D sample ended", s["eos"] - s["eos3D"] - s["eosStream"] >= 1),
    ],
    "game": lambda s: [
        ("3D samples started", s["started3D"] >= 1),
        ("3D samples ended", s["eos3D"] >= 1),
        ("no decode errors", s["decodeErrors"] == 0),
        ("voices bounded (< 40 playing)", s["playing"] < 40),
    ],
}

failed = []
for when, fn in checks.items():
    s = stats.get(when)
    if s is None:
        print(f"{when}: no stats printed")
        failed.append(when)
        continue
    results = fn(s)
    bad = [name for name, ok in results if not ok]
    print(f"{when}: {'ok' if not bad else 'FAIL (' + ', '.join(bad) + ')'} {json.dumps(s, separators=(',', ':'))}")
    if bad:
        failed.append(when)

print("AUDIO CHECK: " + ("FAIL " + ", ".join(failed) if failed else "OK"))
sys.exit(1 if failed else 0)
