#!/usr/bin/env python3
"""Generate a simple square PWA icon (full-bleed, glyph kept inside the maskable safe zone).

  python3 tools/make-icon.py games/my-game/icon.png "MG" "#e0a030" [--size 512]

Or just drop your own 512x512 PNG at the path referenced by games.json.
"""
import os
import sys
from PIL import Image, ImageDraw, ImageFont

FONTS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "C:/Windows/Fonts/arialbd.ttf",
]

def font(size):
    for f in FONTS:
        try:
            return ImageFont.truetype(f, size)
        except OSError:
            pass
    return ImageFont.load_default()

def shade(rgb, k):
    return tuple(max(0, min(255, int(c * k))) for c in rgb)

def make(out, text, color, size=512):
    rgb = tuple(int(color.lstrip('#')[i:i + 2], 16) for i in (0, 2, 4))
    top, bot = shade(rgb, 1.15), shade(rgb, 0.55)
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        t = y / (size - 1)
        row = tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3))
        for x in range(size):
            px[x, y] = row
    d = ImageDraw.Draw(img)
    fs = int(size * (0.38 if len(text) <= 2 else 0.26))
    f = font(fs)
    box = d.textbbox((0, 0), text, font=f)
    w, h = box[2] - box[0], box[3] - box[1]
    pos = ((size - w) / 2 - box[0], (size - h) / 2 - box[1])
    d.text((pos[0] + size * 0.012, pos[1] + size * 0.016), text, font=f, fill=shade(rgb, 0.3))
    d.text(pos, text, font=f, fill=(255, 255, 255))
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    img.save(out)

if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    size = 512
    if "--size" in sys.argv:
        size = int(sys.argv[sys.argv.index("--size") + 1])
        args = [a for a in args if a != str(size)]
    if len(args) < 3:
        sys.exit(__doc__)
    make(args[0], args[1], args[2], size)
