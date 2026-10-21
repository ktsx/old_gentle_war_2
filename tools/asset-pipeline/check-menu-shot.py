#!/usr/bin/env python3
"""check-menu-shot.py <screenshot.png> — verify the boot-smoke screenshot of the free-asset main menu.

Viewport is 1024x768; the layout is authored at 800x600, so multiply by 1.28.

1. Menu panel region (380..640, 258..520) must contain lit button text (max channel >= 150):
   catches a black screen, a stuck fade and disabled (dim) buttons.
2. The "logo" is a colour-order probe (tools/asset-pipeline/tga.ts): red / green / blue stripes
   at logo x 45 / 128 / 211 of 256, logo rect (250,40)-(550,110) in 800x600. A channel-order
   bug in the texture upload path (the WebGL2 no-swizzle bug) swaps red and blue here.
"""
import sys
from PIL import Image

im = Image.open(sys.argv[1]).convert("RGB")
ok = True

region = im.crop((380, 258, 640, 520))
px = region.get_flattened_data() if hasattr(region, "get_flattened_data") else region.getdata()
mx = max(max(p) for p in px)
print(f"menu region max channel: {mx}")
if mx < 150:
    print("FAIL: menu buttons not lit"); ok = False

def dominant(p):
    return max(range(3), key=lambda i: p[i])

y = int(75 * 1.28)
for name, lx, want in (("red", 45, 0), ("green", 128, 1), ("blue", 211, 2)):
    x = int((250 + lx) * 1.28)
    p = im.getpixel((x, y))
    d = dominant(p)
    print(f"logo {name} stripe at ({x},{y}): {p} -> {'RGB'[d]}")
    if d != want or p[d] < 150:
        print(f"FAIL: expected {name} dominant"); ok = False

sys.exit(0 if ok else 1)
