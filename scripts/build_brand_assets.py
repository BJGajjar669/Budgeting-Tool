"""Builds the web assets in public/brand/ from brand/budgify-logo.png.

    python3 scripts/build_brand_assets.py      (needs Pillow: pip install pillow)

The source logo sits on a white background. The icon's outside is made transparent by
flood-filling from the edges (so the white wallet inside it stays white), and the wordmark
gets a "colour to alpha" pass plus a light-ink variant for dark mode.
"""
from collections import deque
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "brand" / "budgify-logo.png"
OUT = ROOT / "public" / "brand"
ICON_BOX = (446, 90, 1088, 712)       # left, top, right, bottom (with margin)
WORD_BOX = (337, 736, 1207, 977)
DARK_INK = (240, 239, 236)


def unmix_white(r, g, b):
    """Colour-to-alpha against white: returns straight (un-premultiplied) RGBA."""
    a = max(255 - r, 255 - g, 255 - b)
    if a == 0:
        return (0, 0, 0, 0)
    f = 255 / a
    return tuple(max(0, min(255, round(255 - (255 - c) * f))) for c in (r, g, b)) + (a,)


def icon(img):
    im = img.crop(ICON_BOX).convert("RGBA")
    w, h = im.size
    px = im.load()
    light = lambda x, y: min(px[x, y][:3]) > 150
    seen = set()
    q = deque((x, y) for x in range(w) for y in (0, h - 1)) + deque((x, y) for y in range(h) for x in (0, w - 1))
    while q:
        x, y = q.popleft()
        if (x, y) in seen or not (0 <= x < w and 0 <= y < h) or not light(x, y):
            continue
        seen.add((x, y))
        q.extend(((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)))
    for x, y in seen:
        px[x, y] = unmix_white(*px[x, y][:3])
    im = im.crop(im.getbbox())
    side = max(im.size)
    sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    sq.paste(im, ((side - im.width) // 2, (side - im.height) // 2))
    return sq


def wordmark(img):
    im = img.crop(WORD_BOX).convert("RGBA")
    px = im.load()
    for y in range(im.height):
        for x in range(im.width):
            px[x, y] = unmix_white(*px[x, y][:3])
    im = im.crop(im.getbbox())
    dark = im.copy()
    dp = dark.load()
    for y in range(dark.height):
        for x in range(dark.width):
            r, g, b, a = dp[x, y]
            if a and not (g > r + 40 and g > b):  # keep the green leaf, lighten the ink
                dp[x, y] = DARK_INK + (a,)
    return im, dark


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    img = Image.open(SRC).convert("RGB")
    ic = icon(img)
    ic.resize((512, 512), Image.LANCZOS).save(OUT / "icon-512.png", optimize=True)
    ic.resize((192, 192), Image.LANCZOS).save(OUT / "icon-192.png", optimize=True)
    ic.resize((32, 32), Image.LANCZOS).save(OUT / "favicon-32.png", optimize=True)
    touch = Image.new("RGBA", (180, 180), (236, 253, 245, 255))  # brand background #ECFDF5
    small = ic.resize((150, 150), Image.LANCZOS)
    touch.alpha_composite(small, (15, 15))
    touch.convert("RGB").save(OUT / "apple-touch-icon.png", optimize=True)
    light, dark = wordmark(img)
    h = 120
    size = (round(light.width * h / light.height), h)
    light.resize(size, Image.LANCZOS).save(OUT / "wordmark.png", optimize=True)
    dark.resize(size, Image.LANCZOS).save(OUT / "wordmark-dark.png", optimize=True)
    print("wrote", sorted(p.name for p in OUT.iterdir()))


if __name__ == "__main__":
    main()
