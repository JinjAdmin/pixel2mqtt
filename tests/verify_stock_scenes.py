"""LOCAL check (needs a private copy of a display's /usr/res): every built-in animation, imported as layers and
baked by the editor's renderer (static/scene.js via Node), must equal pixel2mqtt's stock conversion byte for byte.

  python tests/verify_stock_scenes.py <usr/res mirror> [<expected .anim dir>]
"""
import json
import pathlib
import subprocess
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from pixel2mqtt import scenes, stock  # noqa: E402

res = pathlib.Path(sys.argv[1])
expect = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else None
bad = 0
with tempfile.TemporaryDirectory() as tmp:
    for src, name, _ in stock.ANIMATIONS:
        data = (res / src).read_bytes()
        sc = scenes.scene_from_stock(data)
        j = pathlib.Path(tmp) / "s.json"; out = pathlib.Path(tmp) / "s.anim"
        j.write_text(json.dumps(sc))
        subprocess.run(["node", str(pathlib.Path(__file__).with_name("bake_scene.js")), str(j), str(out)], check=True)
        got = out.read_bytes()
        want = (expect / f"{name}.anim").read_bytes() if expect else stock.anim_bytes(data)
        kind = "layers" if len(sc["layers"]) > 1 or sc["layers"][0]["speed"] or sc["layers"][0]["name"] != "Frames" else "frames"
        ok = got == want
        bad += not ok
        print(f"{'ok  ' if ok else 'DIFF'} {name:20s} {len(sc['layers'])} layer(s) {kind}" + ("" if ok else f"  got {len(got)} want {len(want)} bytes"))
print(f"\n{bad} difference(s)" if bad else "\nALL IDENTICAL")
sys.exit(1 if bad else 0)
