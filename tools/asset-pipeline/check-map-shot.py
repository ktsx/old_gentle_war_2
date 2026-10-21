#!/usr/bin/env python3
"""check-map-shot.py <screenshot.png> — verify the boot-smoke screenshot of the free map.

Viewport is 1024x768. The tactical view covers the top 480 of the 600 engine rows (y < 614
after the 1.28 scale); with gxtest.map's single GxGrass terrain (tga.ts: green noise) the
centre of the view must be grass: in the sampled region (200..824, 160..560) at least 70 % of
the pixels must be green-dominant (G > R + 15, G > B + 15, G >= 70). A black region means the
terrain pass drew nothing (or the shroud covered it); a grey or uniform one means the texture
did not make it onto the mesh.
"""
import sys
from PIL import Image

im = Image.open(sys.argv[1]).convert("RGB")
region = im.crop((200, 160, 824, 560))
px = list(region.get_flattened_data() if hasattr(region, "get_flattened_data") else region.getdata())
green = sum(1 for r, g, b in px if g >= 70 and g > r + 15 and g > b + 15)
black = sum(1 for r, g, b in px if max(r, g, b) < 16)
ratio = green / len(px)
print(f"map region: {len(px)} px, green-dominant {ratio:.1%}, near-black {black / len(px):.1%}")
if ratio < 0.7:
    print("FAIL: terrain not visible in the tactical view")
    sys.exit(1)
print("OK")
