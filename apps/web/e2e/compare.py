#!/usr/bin/env python3
"""Compares two folders of PNGs pixel by pixel (P1, criterion 6: with no layout saved, both screens look exactly as today).
Usage: compare.py <before-dir> <after-dir>   Exit 1 when any picture differs, naming where.
Anti-aliasing noise is allowed: a pixel counts as different only when a channel is off by more than NOISE (the same code
rendered twice differs by 1 on a few corner pixels)."""
import sys
from pathlib import Path
from PIL import Image, ImageChops

before, after = Path(sys.argv[1]), Path(sys.argv[2])
NOISE = 2
bad = 0
for p in sorted(before.glob('*.png')):
    q = after / p.name
    if not q.exists():
        print(f'MISSING  {p.name}')
        bad += 1
        continue
    a, b = Image.open(p).convert('RGB'), Image.open(q).convert('RGB')
    if a.size != b.size:
        print(f'SIZE     {p.name}: {a.size} vs {b.size}')
        bad += 1
        continue
    diff = ImageChops.difference(a, b)
    loud = diff.point(lambda v: 255 if v > NOISE else 0).convert('L') if False else None
    mask = Image.merge('RGB', [c.point(lambda v: 255 if v > NOISE else 0) for c in diff.split()]).convert('L')
    box = mask.getbbox()
    if box:
        n = sum(1 for v in mask.getdata() if v)
        print(f'DIFFERS  {p.name}: {n} pixels, within {box}')
        bad += 1
    else:
        print(f'same     {p.name}')
sys.exit(1 if bad else 0)
