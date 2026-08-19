#!/usr/bin/env python3
"""Generate Bridge's PWA icons: the reactor core on the console's own background.

Run once; re-run only if the mark changes.
    python make_icons.py
"""
import os
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "icons")
os.makedirs(OUT, exist_ok=True)

BG = (5, 7, 13, 255)
CYAN = (36, 214, 240)


def render(size: int, pad_ratio: float) -> Image.Image:
    """pad_ratio shrinks the mark so a maskable icon survives Android's circle crop."""
    S = size * 4                      # supersample, then downscale for clean edges
    img = Image.new("RGBA", (S, S), BG)
    d = ImageDraw.Draw(img)
    c = S / 2
    r_max = (S / 2) * pad_ratio

    # concentric rings — the same three the console draws around the core
    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    for i, (frac, alpha, w) in enumerate([(1.0, 90, 3), (0.72, 130, 3), (0.46, 180, 3)]):
        r = r_max * frac
        gd.ellipse([c - r, c + -r, c + r, c + r], outline=CYAN + (alpha,), width=int(w * size / 48))

    # the orb
    r = r_max * 0.24
    gd.ellipse([c - r, c - r, c + r, c + r], fill=CYAN + (255,))
    r2 = r * 0.42
    gd.ellipse([c - r2 - r * 0.18, c - r2 - r * 0.18, c + r2 - r * 0.18, c + r2 - r * 0.18],
               fill=(255, 255, 255, 255))

    blurred = glow.filter(ImageFilter.GaussianBlur(S / 90))
    img.alpha_composite(blurred)
    img.alpha_composite(glow)
    return img.resize((size, size), Image.LANCZOS)


for size in (180, 192, 512):
    render(size, 0.80).save(os.path.join(OUT, f"icon-{size}.png"))
    print("icons/icon-%d.png" % size)

# maskable: same mark, pulled well inside the safe zone
render(512, 0.56).save(os.path.join(OUT, "icon-maskable-512.png"))
print("icons/icon-maskable-512.png")
