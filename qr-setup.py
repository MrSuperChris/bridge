#!/usr/bin/env python3
"""Show a QR code that sets Bridge up on a phone or tablet in one scan.

Typing a 35-character token on a tablet keyboard is bad enough that setup gets
abandoned. This renders a QR of <site>#t=<token>; you scan it with the device
camera, tap the link, and Bridge configures itself and strips the token from the
address bar.

The token rides in the URL *fragment*, which browsers never send to the server,
so GitHub Pages never receives it. It is still a live credential on screen for as
long as the window is open — close it when you are done.

    python qr-setup.py                 # QR for the live GitHub Pages site
    python qr-setup.py --local         # QR for http://<your-LAN-ip>:3008
    python qr-setup.py --clean         # delete the generated PNG

The PNG is written next to this file and is gitignored. It CONTAINS THE TOKEN —
it is deleted by --clean, and overwritten each run.
"""
import argparse
import json
import pathlib
import socket
import subprocess
import sys

import segno

HERE = pathlib.Path(__file__).parent
CFG = pathlib.Path(r"C:\Users\Chris\claude\SleeperService\config.json")
OUT = HERE / "_setup-qr.png"
SITE = "https://mrsuperchris.github.io/bridge/"


def lan_url(port: int = 3008) -> str:
    """Best-effort LAN address. The UDP connect never sends a packet; it just asks
    the OS which interface would be used to reach the internet."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return f"http://{s.getsockname()[0]}:{port}/"
    finally:
        s.close()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--local", action="store_true", help="point at the LAN dev server")
    ap.add_argument("--clean", action="store_true", help="delete the generated PNG")
    args = ap.parse_args()

    if args.clean:
        if OUT.exists():
            OUT.unlink()
            print("removed", OUT.name)
        else:
            print("nothing to remove")
        return 0

    token = (json.loads(CFG.read_text(encoding="utf-8")).get("ticktick_token") or "").strip()
    if not token:
        print(f"no ticktick_token in {CFG}", file=sys.stderr)
        return 1

    base = lan_url() if args.local else SITE
    url = f"{base}#t={token}"

    # Error correction M: survives phone-camera-at-an-angle without bloating the grid.
    segno.make(url, error="m").save(OUT, scale=9, border=3,
                                    dark="#0b0f18", light="#ffffff")

    print(f"wrote {OUT.name}  ->  {base}#t=<token>")
    print("Scan it with the iPad or Android camera, then tap the link.")
    print("The PNG contains a live credential. Run --clean when you are done.")

    # Open in the default image viewer so it is on screen ready to scan.
    try:
        subprocess.Popen(["cmd", "/c", "start", "", str(OUT)], shell=False)
    except Exception:
        print("(open it yourself:", OUT, ")")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
