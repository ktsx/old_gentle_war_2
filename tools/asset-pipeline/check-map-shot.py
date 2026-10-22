#!/usr/bin/env python3
"""check-map-shot.py <screenshot.png> — verify the boot-smoke screenshot of the free map.

Viewport is 1024x768. The tactical view covers the top 480 of the 600 engine rows (y < 614
after the 1.28 scale); with gxtest.map's single GxGrass terrain (tga.ts: green noise) the
centre of the view must be grass: in the sampled region (200..824, 160..560) at least 70 % of
the pixels must be green-dominant (G > R + 15, G > B + 15, G >= 70). A black region means the
terrain pass drew nothing (or the shroud covered it); a grey or uniform one means the texture
did not make it onto the mesh. The control bar must be drawn with the money display lit.
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
ok = ratio >= 0.7
if not ok:
    print("FAIL: terrain not visible in the tactical view")

# The control bar (assets-free/windows/ControlBar.wnd.json, body from y=470 of 600 -> 602 of 768)
# must cover the bottom of the screen (dark, not grass) and show the money display:
# MoneyDisplay sits at (360,438)-(440,457) in the 800x600 layout, i.e. (461,561)-(563,585) here,
# and ControlBar writes "$ <money>" into it in bright text.
bar = im.crop((0, 610, 1024, 768))
bpx = list(bar.get_flattened_data() if hasattr(bar, "get_flattened_data") else bar.getdata())
bar_green = sum(1 for r, g, b in bpx if g >= 70 and g > r + 15 and g > b + 15) / len(bpx)
money = im.crop((461, 561, 563, 585))
mpx = list(money.get_flattened_data() if hasattr(money, "get_flattened_data") else money.getdata())
money_max = max(max(p) for p in mpx)
print(f"control bar: green {bar_green:.1%} (must be < 10%), money display max channel {money_max} (must be >= 180)")
if bar_green >= 0.1:
    print("FAIL: control bar not drawn over the bottom of the screen"); ok = False
if money_max < 180:
    print("FAIL: money display text not visible"); ok = False

sys.exit(0 if ok else 1)
