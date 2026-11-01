"""Cleans the outline of AI portrait images and writes them as WebP.

    python3 scripts/portraits/clean_pack.py <input folder> <output folder>

Image generators leave white specks and half-transparent white fringe around
the cut-out character. This only touches pixels within BAND px of the
transparent background, so the face, clothes and everything inside the
character stay exactly as drawn:

1. Specks: small separate blobs (under MIN_BLOB px) are removed.
2. Fringe: bright pixels on the very edge that are half transparent, or that
   stick out into the background (mostly transparent neighbours), are removed.
3. Halo: the generator drew on white, so the outer 2 px of the dark line art
   are washed out to grey. Those pixels take the colour of the darkest line
   art next to them (alpha unchanged).
4. The outermost pixel ring gets a slightly softer alpha, so the edge is not
   jagged. The soft glow around the portrait is drawn by the client (CSS).

Output is lossless WebP, so every pixel inside the outline stays identical.
File names keep their emotion key; a shared prefix like "dafeiyu_" is
dropped ("dafeiyu_happy.png" -> "happy.webp"). Needs Pillow and numpy.
"""
import sys
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

BAND = 3        # px from the background that may be changed
MIN_BLOB = 40   # blobs smaller than this many px are specks
BRIGHT = 200    # min(r, g, b) above this counts as "white"


def components(mask):
    """Labels 8-connected regions of a boolean mask; returns (labels, sizes)."""
    h, w = mask.shape
    labels = np.zeros((h, w), np.int32)
    sizes = [0]
    for y0, x0 in zip(*np.nonzero(mask)):
        if labels[y0, x0]:
            continue
        n = len(sizes)
        labels[y0, x0] = n
        q = deque([(y0, x0)])
        size = 0
        while q:
            y, x = q.popleft()
            size += 1
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    yy, xx = y + dy, x + dx
                    if 0 <= yy < h and 0 <= xx < w and mask[yy, xx] and not labels[yy, xx]:
                        labels[yy, xx] = n
                        q.append((yy, xx))
        sizes.append(size)
    return labels, np.array(sizes)


def near_background(alpha, band):
    """Opaque-ish pixels within `band` px of fully transparent ones."""
    bg = Image.fromarray(((alpha == 0) * 255).astype(np.uint8))
    grown = np.array(bg.filter(ImageFilter.MaxFilter(2 * band + 1))) > 0
    return grown & (alpha > 0)


def clean(img):
    a = np.array(img.convert("RGBA"))
    rgb, alpha = a[..., :3].astype(int), a[..., 3].copy()

    # 1. specks: every blob except the big ones
    labels, sizes = components(alpha > 0)
    small = np.isin(labels, np.nonzero(sizes < MIN_BLOB)[0][1:])
    alpha[small] = 0

    bright = rgb.min(axis=2) > BRIGHT
    for _ in range(2):
        band = near_background(alpha, 1)
        # 2a. half-transparent white fringe
        alpha[band & bright & (alpha < 255)] = 0
        # 2b. white pixels sticking out: at least 5 of 8 neighbours transparent
        clear = (alpha == 0).astype(int)
        p = np.pad(clear, 1)
        around = sum(p[1 + dy:p.shape[0] - 1 + dy, 1 + dx:p.shape[1] - 1 + dx]
                     for dy in (-1, 0, 1) for dx in (-1, 0, 1) if dy or dx)
        alpha[band & bright & (around >= 5)] = 0

    # 3. grey halo -> colour of the line art next to it
    halo = near_background(alpha, 2)
    luma = rgb @ np.array([299, 587, 114]) // 1000
    dark = np.array(Image.fromarray(luma.astype(np.uint8)).filter(ImageFilter.MinFilter(5))).astype(int)
    darkest = np.stack([np.array(Image.fromarray(rgb[..., c].astype(np.uint8)).filter(ImageFilter.MinFilter(5)))
                        for c in range(3)], axis=2)
    wash = halo & (luma - dark > 40)
    a[..., :3][wash] = darkest[wash]

    # 4. soften the outermost ring only
    ring = near_background(alpha, 1)
    soft = np.array(Image.fromarray(alpha).filter(ImageFilter.GaussianBlur(0.7)))
    alpha[ring] = np.minimum(alpha[ring], soft[ring])

    # never touch anything deeper than BAND px
    keep = ~near_background(a[..., 3], BAND) & (a[..., 3] > 0)
    alpha[keep] = a[..., 3][keep]
    a[..., 3] = alpha
    return Image.fromarray(a, "RGBA")


def key_of(path):
    stem = path.stem.lower()
    return stem.rsplit("_", 1)[-1] if "_" in stem else stem


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    dst.mkdir(parents=True, exist_ok=True)
    for f in sorted(src.iterdir()):
        if f.suffix.lower() not in (".png", ".webp", ".gif"):
            continue
        out = dst / (key_of(f) + ".webp")
        clean(Image.open(f)).save(out, "WEBP", lossless=True, quality=100, method=6, exact=True)
        print(f.name, "->", out.name)


if __name__ == "__main__":
    main()
