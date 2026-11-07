#!/usr/bin/env python3
"""Puts the Abilities view beside the prototype's own picture, from what abilities-compare.mjs wrote (proto.png, ours-proto.png).
Usage: abilities-compose.py <dir>   Writes, next to them: side-by-side (both whole, half size), cards (each row of cards, the prototype
above ours), detail (the right column, the prototype left of ours), filters (enlarged twice) and difference (where they differ, six
times as loud)."""
import sys
from pathlib import Path
from PIL import Image, ImageChops

d = Path(sys.argv[1])
a = Image.open(d / 'proto.png').convert('RGB')
b = Image.open(d / 'ours-proto.png').convert('RGB')

# Both whole, at half size.
out = Image.new('RGB', (1930, 540), (60, 0, 0))
out.paste(a.resize((960, 540), Image.LANCZOS), (0, 0))
out.paste(b.resize((960, 540), Image.LANCZOS), (970, 0))
out.save(d / 'side-by-side.png')

# The cards, row by row, the prototype above ours.
rows = Image.new('RGB', (1260, 2 * 340 * 2 + 30), (60, 0, 0))
y = 0
for top in (160, 505):
    rows.paste(a.crop((30, top, 1290, top + 340)), (0, y))
    rows.paste(b.crop((30, top, 1290, top + 340)), (0, y + 345))
    y += 700
rows.save(d / 'cards.png')

# The right column: the prototype left, ours right.
col = Image.new('RGB', (1130, 700), (60, 0, 0))
col.paste(a.crop((1350, 30, 1910, 730)), (0, 0))
col.paste(b.crop((1350, 30, 1910, 730)), (570, 0))
col.save(d / 'detail.png')

# The filters, enlarged twice.
f = Image.new('RGB', (1220, 230), (60, 0, 0))
f.paste(a.crop((30, 95, 640, 150)).resize((1220, 110), Image.LANCZOS), (0, 0))
f.paste(b.crop((30, 95, 640, 150)).resize((1220, 110), Image.LANCZOS), (0, 120))
f.save(d / 'filters.png')

# Where they differ.
ImageChops.difference(a, b).point(lambda v: min(255, v * 6)).save(d / 'difference.png')
print('written to', d)
