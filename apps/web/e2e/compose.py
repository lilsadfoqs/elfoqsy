#!/usr/bin/env python3
"""Joins the browser tests' pictures of the two windows (<name>.left.png, <name>.right.png) into one picture per step, at half
size, side by side as the two monitors sit, for the report: compose.py <from-dir> <to-dir>."""
import sys
from pathlib import Path
from PIL import Image

src, dst = Path(sys.argv[1]), Path(sys.argv[2])
dst.mkdir(parents=True, exist_ok=True)
GAP = 16
for left in sorted(src.glob('*.left.png')):
    right = left.with_name(left.name.replace('.left.png', '.right.png'))
    if not right.exists():
        continue
    a, b = Image.open(left).convert('RGB'), Image.open(right).convert('RGB')
    half = lambda im: im.resize((im.width // 2, im.height // 2), Image.LANCZOS)
    a, b = half(a), half(b)
    out = Image.new('RGB', (a.width + GAP + b.width, a.height), (0, 0, 0))
    out.paste(a, (0, 0))
    out.paste(b, (a.width + GAP, 0))
    out = out.quantize(colors=128, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    out.save(dst / left.name.replace('.left.png', '.png'), optimize=True)
    print(left.name.replace('.left.png', ''))
