#!/usr/bin/env python3
"""Regenerate app icons from build/icon-source.jpeg (requires Pillow; pyoxipng optional, for lossless
PNG recompression: pip install pyoxipng).

macOS: Apple icon grid -- 824x824 rounded-rect tile (corner radius 185, ~22.5%) centred on a transparent
1024 canvas (100px margin) with a soft drop shadow. Windows/Linux: near-full-bleed tile (944px, 40px margin,
radius 160). Sizes <= 48 get an unsharp mask after the Lanczos downscale so they stay legible.
Outputs: build/icon.png (1024 mac-style master), build/icon.icns, build/icon.ico and build/icons/<n>x<n>.png
(Linux 16..512; icons/256x256.png is also the Windows/Linux window icon). No metadata is written: images are
rebuilt from raw pixels (no EXIF/ICC/text chunks) and PNGs are recompressed losslessly with oxipng when available.
The source JPEG had its APPn/COM segments removed losslessly (no EXIF, MakerNote, thumbnail, ICC; sRGB data).
"""
import io
import os
import struct
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'build')
SRC = Image.open(os.path.join(HERE, 'icon-source.jpeg')).convert('RGB')

def tile(canvas, size, radius, shadow):
    art = SRC.resize((size, size), Image.LANCZOS).convert('RGBA')
    mask = Image.new('L', (size * 4, size * 4), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size * 4 - 1, size * 4 - 1), radius * 4, fill=255)
    mask = mask.resize((size, size), Image.LANCZOS)  # supersampled anti-aliased corners
    out = Image.new('RGBA', (canvas, canvas), (0, 0, 0, 0))
    off = (canvas - size) // 2
    if shadow:
        sh = Image.new('RGBA', (canvas, canvas), (0, 0, 0, 0))
        sh.paste((0, 0, 0, 70), (off, off + 12), mask)
        out = Image.alpha_composite(out, sh.filter(ImageFilter.GaussianBlur(14)))
    layer = Image.new('RGBA', (canvas, canvas), (0, 0, 0, 0))
    layer.paste(art, (off, off), mask)
    out = Image.alpha_composite(out, layer)
    # hairline border so the white tile reads on white backgrounds
    ring = Image.new('RGBA', (canvas, canvas), (0, 0, 0, 0))
    ImageDraw.Draw(ring).rounded_rectangle((off, off, off + size - 1, off + size - 1), radius, outline=(0, 0, 0, 40), width=3)
    return Image.alpha_composite(out, ring)

def scaled(master, n):
    im = master.resize((n, n), Image.LANCZOS)
    if n <= 48:
        im = im.filter(ImageFilter.UnsharpMask(radius=1, percent=80 if n <= 32 else 50, threshold=2))
    return im

mac = tile(1024, 824, 185, True)
win = tile(1024, 944, 160, False)
# All PNG-encoded ICNS entries (16..512 @1x and @2x, 1024 = 512@2x); written by hand because Pillow omits 16/32 @1x.
ICNS = [('icp4', 16), ('icp5', 32), ('ic11', 32), ('ic12', 64), ('ic07', 128), ('ic13', 256),
        ('ic08', 256), ('ic14', 512), ('ic09', 512), ('ic10', 1024)]
try:
    import oxipng
except ImportError:
    oxipng = None
def png(im):
    b = io.BytesIO(); im.save(b, 'PNG', optimize=True); d = b.getvalue()
    return oxipng.optimize_from_memory(d, level=6, strip=oxipng.StripChunks.all()) if oxipng else d
def save_png(im, path):
    with open(path, 'wb') as f: f.write(png(im))
chunks = b''.join(struct.pack('>4sI', t.encode(), len(d) + 8) + d for t, d in ((t, png(scaled(mac, n))) for t, n in ICNS))
with open(os.path.join(HERE, 'icon.icns'), 'wb') as f:
    f.write(b'icns' + struct.pack('>I', len(chunks) + 8) + chunks)
save_png(mac, os.path.join(HERE, 'icon.png'))
ico = [scaled(win, n) for n in (16, 24, 32, 48, 64, 128, 256)]
ico[-1].save(os.path.join(HERE, 'icon.ico'), sizes=[(i.width, i.height) for i in ico], append_images=ico[:-1])
os.makedirs(os.path.join(HERE, 'icons'), exist_ok=True)
for n in (16, 24, 32, 48, 64, 128, 256, 512):
    save_png(scaled(win, n), os.path.join(HERE, 'icons', f'{n}x{n}.png'))
