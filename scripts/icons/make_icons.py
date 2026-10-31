"""Draws the AM icons and writes every size the builds use.

    python3 scripts/icons/make_icons.py        (needs Pillow)

Client: a round chat-bubble face on the app's pink -> lavender gradient
(樱粉 / 薰衣草 from client/src/lib/theme.ts). Server: the same face on mint
-> sea blue (薄荷 / 海盐蓝) with a small server badge, so the two exes look
related but are easy to tell apart, even at 16 px in the tray.
"""
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
S = 1024  # drawing size; everything is scaled down from this

CLIENT = ((0xF4, 0x6F, 0xA8), (0x8B, 0x6C, 0xF0))
SERVER = ((0x2B, 0xC2, 0x9F), (0x3A, 0x8D, 0xDF))
INK = (0x3B, 0x2A, 0x4F)


def gradient(c1, c2):
    """Diagonal gradient, top-left c1 to bottom-right c2."""
    g = Image.new("RGBA", (S, S))
    px = g.load()
    for y in range(S):
        for x in range(S):
            t = (x + y) / (2 * (S - 1))
            px[x, y] = tuple(round(a + (b - a) * t) for a, b in zip(c1, c2)) + (255,)
    return g


def squircle_mask(inset=40, radius=240):
    m = Image.new("L", (S, S), 0)
    ImageDraw.Draw(m).rounded_rectangle((inset, inset, S - inset, S - inset), radius, fill=255)
    return m


def bubble_mask():
    """Round speech bubble with a small tail at the bottom left."""
    m = Image.new("L", (S, S), 0)
    d = ImageDraw.Draw(m)
    d.ellipse((190, 200, 834, 760), fill=255)
    d.polygon([(300, 640), (250, 840), (450, 720)], fill=255)
    return m.filter(ImageFilter.GaussianBlur(6)).point(lambda v: 255 if v > 128 else 0)


def face(d, dx=0):
    # eyes
    for cx in (412 + dx, 612 + dx):
        d.ellipse((cx - 38, 418, cx + 38, 520), fill=INK)
        d.ellipse((cx - 20, 434, cx + 4, 462), fill=(255, 255, 255))
    # blush
    for cx in (330 + dx, 694 + dx):
        d.ellipse((cx - 52, 528, cx + 52, 576), fill=(255, 160, 190, 200))
    # "w" mouth
    d.arc((452 + dx, 520, 512 + dx, 580), 10, 170, fill=INK, width=18)
    d.arc((512 + dx, 520, 572 + dx, 580), 10, 170, fill=INK, width=18)


def sparkle(d, cx, cy, r, fill):
    d.polygon([(cx, cy - r), (cx + r * 0.28, cy - r * 0.28), (cx + r, cy), (cx + r * 0.28, cy + r * 0.28),
               (cx, cy + r), (cx - r * 0.28, cy + r * 0.28), (cx - r, cy), (cx - r * 0.28, cy - r * 0.28)], fill=fill)


def server_badge(img):
    """Little white server box with two drives and green lights, bottom right."""
    shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((618, 618, 950, 950), 70, fill=(20, 40, 70, 110))
    img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(18)))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((610, 600, 940, 930), 70, fill=(255, 255, 255))
    for top in (650, 780):
        d.rounded_rectangle((660, top, 890, top + 100), 30, fill=(0xE4, 0xF4, 0xF1))
        d.ellipse((690, top + 30, 730, top + 70), fill=(0x2B, 0xC2, 0x9F))
        d.rounded_rectangle((760, top + 40, 860, top + 60), 10, fill=(0x9F, 0xC9, 0xC2))


def draw(colors, server):
    bg = gradient(*colors)
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    img.paste(bg, (0, 0), squircle_mask())
    # soft highlight on the upper half
    hl = Image.new("L", (S, S), 0)
    ImageDraw.Draw(hl).ellipse((-200, -520, 1100, 420), fill=70)
    hl = ImageChops.multiply(hl.filter(ImageFilter.GaussianBlur(60)), squircle_mask())
    img.alpha_composite(Image.merge("RGBA", (*[Image.new("L", (S, S), 255)] * 3, hl)))
    # bubble with a soft shadow
    bm = bubble_mask()
    shadow = Image.new("RGBA", (S, S), (40, 20, 60, 0))
    shadow.putalpha(bm.filter(ImageFilter.GaussianBlur(26)).point(lambda v: v * 0.35))
    img.alpha_composite(shadow, (0, 22))
    white = Image.new("RGBA", (S, S), (255, 255, 255, 255))
    img.paste(white, (0, 0), bm)
    d = ImageDraw.Draw(img, "RGBA")
    face(d)
    sparkle(d, 810, 250, 70, (255, 255, 255, 235))
    sparkle(d, 880, 380, 34, (255, 255, 255, 200))
    if server:
        server_badge(img)
    return img


def save_png(img, path, size):
    path.parent.mkdir(parents=True, exist_ok=True)
    img.resize((size, size), Image.LANCZOS).save(path)
    print("wrote", path.relative_to(ROOT))


def save_ico(img, path):
    sizes = [16, 24, 32, 48, 64, 128, 256]
    img.resize((256, 256), Image.LANCZOS).save(path, sizes=[(s, s) for s in sizes])
    print("wrote", path.relative_to(ROOT))


def main():
    client = draw(CLIENT, server=False)
    server = draw(SERVER, server=True)
    icons = ROOT / "client/src-tauri/icons"
    save_png(client, icons / "32x32.png", 32)
    save_png(client, icons / "128x128.png", 128)
    save_png(client, icons / "128x128@2x.png", 256)
    save_png(client, icons / "icon.png", 512)
    save_ico(client, icons / "icon.ico")
    save_png(client, ROOT / "client/src/assets/logo.png", 256)
    save_png(server, ROOT / "server/cmd/am-server/winres/icon.png", 256)
    save_ico(server, ROOT / "server/internal/desktop/icon.ico")
    save_png(server, ROOT / "server/internal/admin/web/favicon.png", 64)


if __name__ == "__main__":
    main()
