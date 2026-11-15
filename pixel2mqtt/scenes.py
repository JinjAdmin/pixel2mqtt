"""Layered scenes for the editor (see static/scene.js for the model).

- Govee "graffiti_2d"/"diydial" scene files are converted into editable layers with the exact semantics of
  convert/graffiti.py (motion direction/speed, tiling, opacity, blink, stacking, timed frame groups), so baking an
  unmodified import reproduces the stock animation.
- GIFs, Govee PNG containers and .anim files become a single layer with frames.
- Saved scenes live in <data>/scenes/<name>.json.
"""
import base64
import json
import os
import pathlib
import re
import struct

from . import formats
from .convert import anim_convert as ac
from .convert import graffiti

W, H = 52, 32


def _b64(b: bytes) -> str:
    return base64.b64encode(bytes(b)).decode()


def _frame(rows, delay, black_transparent=True, opacity=100):
    """rows of (r,g,b[,a]) -> scene frame dict; black = transparent and opacity are baked into alpha (graffiti rules)."""
    h, w = len(rows), len(rows[0])
    out = bytearray(w * h * 4)
    i = 0
    for row in rows:
        for p in row:
            r, g, b = p[0], p[1], p[2]
            a = p[3] if len(p) > 3 else 255
            a = a * min(100, opacity) // 100
            if black_transparent and r == 0 and g == 0 and b == 0:
                a = 0
            out[i:i + 4] = bytes((r, g, b, a))
            i += 4
    return {"w": w, "h": h, "delay": int(delay), "rgba": _b64(out)}


def _layer(name, frames, tile=False, track=None, blink=0):
    lay = {"name": name, "visible": True, "x": 0, "y": 0, "tile": bool(tile), "dir": [0, 0], "speed": 0,
           "opacity": 100, "blink": int(blink), "frames": frames}
    if track is not None and track.rate:
        lay["dir"] = [track.dx, track.dy]
        lay["speed"] = track.rate * 1000.0     # px per second
        lay["span"] = track.span               # wrap distance used for loop fitting (as graffiti.py)
    return lay


def scene_from_graffiti(d: bytes):
    bg, gtype, (bgs, layers, fgs) = graffiti.parse_graffiti(graffiti.unwrap(d))
    out = []
    # bottom to top, in graffiti.py's drawing order
    for n, it in enumerate(reversed(bgs)):
        out.append(_layer(f"Background {len(bgs) - n}", [_frame(it.rows, it.D or 100, opacity=it.B)], tile=True,
                          track=graffiti._track_for([it])))
    if layers:
        if gtype:  # timed frame sequence sharing one motion track
            tiles = {bool(it.K) for it in layers}
            out.append(_layer("Frames", [_frame(it.rows, max(20, it.D), opacity=it.B) for it in layers],
                              tile=tiles.pop() if len(tiles) == 1 else bool(layers[0].K),
                              track=graffiti._track_for(layers)))
            out[-1]["timed"] = True  # loop length counts the sequence, as graffiti.py does
        else:
            for n, it in enumerate(reversed(layers)):
                out.append(_layer(f"Layer {len(layers) - n}", [_frame(it.rows, it.D or 100, opacity=it.B)],
                                  tile=bool(it.K), track=graffiti._track_for([it]),
                                  blink=max(20, it.D) if it.E == 1 else 0))
    for n, it in enumerate(reversed(fgs)):
        out.append(_layer(f"Foreground {len(fgs) - n}", [_frame(it.rows, it.D or 100, opacity=it.B)],
                          tile=bool(it.K), track=graffiti._track_for([it])))
    return {"version": 1, "w": W, "h": H, "bg": list(bg), "layers": out}


def scene_from_frames(frames, name="Frames"):
    """frames: list of (delay_ms, 52x32 rows of (r,g,b)) -> one opaque layer."""
    return {"version": 1, "w": W, "h": H, "bg": [0, 0, 0],
            "layers": [_layer(name, [_frame(rows, d, black_transparent=False) for d, rows in frames])]}


def scene_from_stock(d: bytes):
    """Any stock animation file: layered Govee scene if possible, else its frames (GIF, PNG container)."""
    try:
        return scene_from_graffiti(d)
    except Exception:  # noqa: BLE001 - not a graffiti scene (GIF with a .txt name, plain PNG container, ...)
        return scene_from_frames(ac.convert(formats.Blob(d)))


def scene_from_pxa(d: bytes):
    frames = []
    for delay, rgb in formats.parse_pxa(d):
        frames.append((delay, [[tuple(rgb[(y * W + x) * 3:(y * W + x) * 3 + 3]) for x in range(W)] for y in range(H)]))
    return scene_from_frames(frames, "Animation")


def decode_layer_frames(data: bytes, max_side=256, max_frames=120):
    """Image upload -> frames for a new layer (keeps the source size up to max_side; real alpha kept)."""
    frames = formats.decode(data)[:max_frames]
    out = []
    for delay, rows in frames:
        rows = formats.fit(rows, max_side, max_side, "contain")
        out.append(_frame(rows, delay, black_transparent=False))
    return out


class SceneStore:
    def __init__(self, data_dir: pathlib.Path):
        self.dir = data_dir / "scenes"
        self.dir.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _name(name: str) -> str:
        n = formats.safe_name(name)
        if not n or n.startswith("."):
            raise ValueError("bad scene name")
        return n

    def list(self):
        out = []
        for p in sorted(self.dir.glob("*.json"), key=lambda p: p.stem.lower()):
            st = p.stat()
            out.append({"name": p.stem, "size": st.st_size, "mtime": int(st.st_mtime)})
        return out

    def get(self, name: str) -> bytes:
        p = self.dir / (self._name(name) + ".json")
        if not p.is_file():
            raise KeyError("no such scene")
        return p.read_bytes()

    def put(self, name: str, body: bytes):
        s = json.loads(body)  # validate
        if not isinstance(s.get("layers"), list) or not s.get("w") or not s.get("h"):
            raise ValueError("not a scene")
        p = self.dir / (self._name(name) + ".json")
        tmp = p.with_suffix(".tmp")
        tmp.write_bytes(body)
        os.replace(tmp, p)
        return p.stem

    def delete(self, name: str):
        p = self.dir / (self._name(name) + ".json")
        if p.is_file():
            p.unlink()
