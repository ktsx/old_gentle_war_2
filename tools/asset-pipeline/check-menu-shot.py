#!/usr/bin/env python3
"""check-menu-shot.py <screenshot.png> — fail unless the main-menu panel region shows lit button text.

The free-asset main menu draws its buttons at (380..640, 258..520) of the 1024x768 viewport;
button text is light grey on dark grey. A black screen, a stuck fade or disabled (dim) buttons
all leave the region below the threshold.
"""
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert("RGB")
region = im.crop((380, 258, 640, 520))
mx = max(max(p) for p in region.get_flattened_data()) if hasattr(region, "get_flattened_data") else max(max(p) for p in region.getdata())
print(f"max channel in menu region: {mx}")
sys.exit(0 if mx >= 150 else 1)
