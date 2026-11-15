"""Image/animation conversion to pixeld's on-device formats.

.anim (PXA1): b"PXA1", u16 n, then n x (u16 delay_ms + 52*32*3 RGB, row-major from the top-left)
.pxi  (PXI1): b"PXI1", u8 w, u8 h, u16 n, then n x (u16 delay_ms + w*h*4 RGBA)
All little-endian. pixeld clamps delays to >= 20 ms and loads at most 600 animation / 64 icon frames.
"""
import io
import pathlib
import re
import struct

from .convert import anim_convert as ac
from .convert.minipng import read_png

W, H = 52, 32
MAX_ANIM_FRAMES, MAX_ICON_FRAMES = 600, 64
SOUND_EXT = (".mp3", ".wav", ".ogg")


class Blob:
    """Stands in for a pathlib.Path where the vendored converters call .read_bytes()."""
    def __init__(self, data: bytes, name: str = "upload"):
        self.data, self.name, self.stem = data, name, pathlib.PurePath(name).stem

    def read_bytes(self):
        return self.data


def safe_name(name: str) -> str:
    """File stem usable on the device and inside HA option lists."""
    name = re.sub(r'[\x00-\x1f\x7f/\\"]+', " ", name).strip().strip(".")
    name = re.sub(r"\s+", " ", name)
    return name[:60] or "untitled"


# ------------------------------------------------------------------ decoding
def is_gif(d: bytes) -> bool:
    return d[:6] in (b"GIF87a", b"GIF89a")


def is_png(d: bytes) -> bool:
    return d[:8] == b"\x89PNG\r\n\x1a\n"


def is_govee_scene(d: bytes) -> bool:
    return not is_png(d) and b"\x89PNG\r\n\x1a\n" in d


def decode(d: bytes, black_transparent=False):
    """-> list of (delay_ms, rows) with rows = list of lists of (r, g, b, a) at the source size."""
    if is_gif(d):
        out = []
        for delay, canvas in ac.decode_gif(d):
            out.append((delay, [[(r, g, b, 0 if black_transparent and (r, g, b) == (0, 0, 0) else 255) for r, g, b in row] for row in canvas]))
            if len(out) >= MAX_ANIM_FRAMES:
                break
        return out
    if is_png(d):
        return [(1000, read_png(d)[2])]
    raise ValueError("unsupported image (GIF or 8-bit PNG expected)")


# ------------------------------------------------------------------ geometry
def _scale(rows, nw, nh):
    """Area-average resample of RGBA rows to nw x nh (alpha-weighted)."""
    h, w = len(rows), len(rows[0])
    if (w, h) == (nw, nh):
        return rows
    out = []
    for y in range(nh):
        y0, y1 = y * h / nh, (y + 1) * h / nh
        row = []
        for x in range(nw):
            x0, x1 = x * w / nw, (x + 1) * w / nw
            acc = [0.0, 0.0, 0.0, 0.0]; tot = 0.0
            sy = int(y0)
            while sy < y1 and sy < h:
                wy = min(y1, sy + 1) - max(y0, sy)
                sx = int(x0)
                while sx < x1 and sx < w:
                    wgt = wy * (min(x1, sx + 1) - max(x0, sx))
                    r, g, b, a = rows[sy][sx]
                    wa = wgt * a
                    acc[0] += r * wa; acc[1] += g * wa; acc[2] += b * wa; acc[3] += wa
                    tot += wgt
                    sx += 1
                sy += 1
            if acc[3] > 0:
                row.append((round(acc[0] / acc[3]), round(acc[1] / acc[3]), round(acc[2] / acc[3]), round(acc[3] / tot)))
            else:
                row.append((0, 0, 0, 0))
        out.append(row)
    return out


def fit(rows, max_w, max_h, mode="contain"):
    """contain: shrink to fit (never enlarge); cover: fill the box and crop; stretch; none: crop around the centre."""
    h, w = len(rows), len(rows[0])
    if mode == "stretch":
        return _scale(rows, max_w, max_h)
    if mode == "cover":
        s = max(max_w / w, max_h / h)
        nw, nh = max(1, round(w * s)), max(1, round(h * s))
        rows = _scale(rows, nw, nh)
        ox, oy = (nw - max_w) // 2, (nh - max_h) // 2
        return [r[ox:ox + max_w] for r in rows[oy:oy + max_h]]
    if mode == "contain" and (w > max_w or h > max_h):
        s = min(max_w / w, max_h / h)
        return _scale(rows, max(1, round(w * s)), max(1, round(h * s)))
    if w > max_w or h > max_h:  # none: centre crop
        ox, oy = max(0, (w - max_w) // 2), max(0, (h - max_h) // 2)
        return [r[ox:ox + max_w] for r in rows[oy:oy + max_h]]
    return rows


def _flatten_centered(rows, prev=None, keep_prev=False):
    """Centre RGBA rows on a 52x32 frame; transparent pixels are black, or keep the previous frame."""
    canvas = [r[:] for r in prev] if (keep_prev and prev) else [[(0, 0, 0)] * W for _ in range(H)]
    ac.place(canvas, rows, alpha=True)
    return canvas


# ------------------------------------------------------------------ encoders
def pxa(frames) -> bytes:
    """frames: list of (delay_ms, 52x32 rows of (r,g,b[,a])) -> PXA1 bytes."""
    out = io.BytesIO()
    out.write(b"PXA1" + struct.pack("<H", len(frames)))
    for delay, fr in frames:
        out.write(struct.pack("<H", max(ac.MIN_DELAY, min(ac.MAX_DELAY, int(delay)))))
        out.write(bytes(c for row in fr for px in row for c in px[:3]))
    return out.getvalue()


def pxi(frames) -> bytes:
    """frames: list of (delay_ms, rows of (r,g,b,a)) all the same size -> PXI1 bytes."""
    h, w = len(frames[0][1]), len(frames[0][1][0])
    out = io.BytesIO()
    out.write(b"PXI1" + struct.pack("<BBH", w, h, len(frames)))
    for delay, rows in frames:
        out.write(struct.pack("<H", max(20, min(60000, int(delay)))))
        out.write(bytes(c for row in rows for px in row for c in px))
    return out.getvalue()


def _merge_short(frames, min_ms=20):
    """Drop frames shorter than pixeld's minimum by adding their time to the previous frame."""
    out = []
    for d, f in frames:
        if out and d < min_ms:
            out[-1] = (out[-1][0] + d, out[-1][1])
        else:
            out.append((max(d, min_ms), f))
    return out


def make_anim(data: bytes, fit_mode="contain") -> bytes:
    """GIF / PNG / Govee scene -> PXA1."""
    if is_govee_scene(data):
        return pxa(ac.convert(Blob(data)))  # graffiti renderer (tuned for Govee's scenes)
    frames = decode(data)
    out, prev = [], None
    gif = is_gif(data)
    for delay, rows in frames:
        canvas = _flatten_centered(fit(rows, W, H, fit_mode), prev, keep_prev=not gif)
        out.append((delay, canvas)); prev = canvas
    return pxa(_merge_short(out)[:MAX_ANIM_FRAMES])


def make_icon(data: bytes, max_w=W, max_h=H, fit_mode="contain") -> bytes:
    """GIF / PNG -> PXI1 (GIFs: pure black = transparent, as with Govee's icons)."""
    frames = decode(data, black_transparent=True)[:MAX_ICON_FRAMES]
    return pxi([(d, fit(rows, max_w, max_h, fit_mode)) for d, rows in frames])


def parse_pxa(d: bytes):
    assert d[:4] == b"PXA1", "not PXA1"
    n = struct.unpack("<H", d[4:6])[0]
    out, pos, fs = [], 6, W * H * 3
    for _ in range(n):
        out.append((struct.unpack("<H", d[pos:pos + 2])[0], d[pos + 2:pos + 2 + fs])); pos += 2 + fs
    return out


def parse_pxi(d: bytes):
    assert d[:4] == b"PXI1", "not PXI1"
    w, h, n = struct.unpack("<BBH", d[4:8])
    out, pos, fs = [], 8, w * h * 4
    for _ in range(n):
        out.append((struct.unpack("<H", d[pos:pos + 2])[0], d[pos + 2:pos + 2 + fs])); pos += 2 + fs
    return w, h, out
