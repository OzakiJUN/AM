# Generates the AM icon (assets/icon.png, server/internal/desktop/icon.ico,
# admin panel favicon). Run: python3 assets/make_icon.py  (needs Pillow)
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BLUE = (36, 67, 143)
AMBER = (245, 165, 36)
WHITE = (255, 255, 255)
FONT = "/usr/share/fonts/opentype/inter/InterDisplay-Bold.otf"

def draw(size, text=True):
    S = 1024
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=230, fill=BLUE)
    # rising sun behind the bubble, top right
    d.ellipse([560, 110, 900, 450], fill=AMBER)
    # speech bubble
    d.rounded_rectangle([150, 270, 874, 760], radius=170, fill=WHITE)
    d.polygon([(250, 700), (215, 905), (430, 745)], fill=WHITE)
    if text:
        f = ImageFont.truetype(FONT, 300)
        bbox = d.textbbox((0, 0), "AM", font=f)
        w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
        d.text(((S - w) / 2 - bbox[0], 515 - h / 2 - bbox[1]), "AM", font=f, fill=BLUE)
    return im.resize((size, size), Image.LANCZOS)

big = draw(256)
big.save(os.path.join(HERE, "icon.png"))
sizes = [16, 24, 32, 48, 64, 128, 256]
imgs = [draw(s, text=s >= 32) for s in sizes]
imgs[-1].save(os.path.join(ROOT, "server/internal/desktop/icon.ico"), sizes=[(s, s) for s in sizes], append_images=imgs[:-1])
draw(64).save(os.path.join(ROOT, "server/internal/admin/web/favicon.png"))
print("ok")
