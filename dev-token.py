#!/usr/bin/env python3
"""Local dev convenience: seed the browser's localStorage with the TickTick token
so http://localhost:3008/_dev.html opens straight into the console.

Writes _dev.html and _devtoken.js, both gitignored. The token is read from
SleeperService/config.json and never printed.

    python dev-token.py          # write the bootstrap
    python dev-token.py --clean  # remove it again
"""
import json
import pathlib
import sys

HERE = pathlib.Path(__file__).parent
CFG = pathlib.Path(r"C:\Users\Chris\claude\SleeperService\config.json")
FILES = [HERE / "_dev.html", HERE / "_devtoken.js"]

if "--clean" in sys.argv:
    for f in FILES:
        if f.exists():
            f.unlink()
            print("removed", f.name)
    raise SystemExit(0)

token = (json.loads(CFG.read_text(encoding="utf-8")).get("ticktick_token") or "").strip()
if not token:
    raise SystemExit(f"no ticktick_token in {CFG}")

(HERE / "_devtoken.js").write_text(
    "localStorage.setItem('bridge.token', %s);\n" % json.dumps(token), encoding="utf-8")
(HERE / "_dev.html").write_text(
    "<!doctype html><meta charset=utf-8>"
    "<script src='_devtoken.js'></script>"
    "<script>location.replace('./index.html')</script>\n", encoding="utf-8")
print("wrote _dev.html + _devtoken.js (gitignored); open http://localhost:3008/_dev.html")
