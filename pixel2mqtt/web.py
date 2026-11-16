"""Web editor + REST API (standard library http.server)."""
import collections
import json
import logging
import mimetypes
import pathlib
import threading
import time
import urllib.parse
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import formats, scenes, stock
from .device import FRAME_BYTES, APIError, send_frame

log = logging.getLogger("web")
STATIC = pathlib.Path(__file__).resolve().parent / "static"
KINDS = ("anims", "icons", "sounds")
MAX_UPLOAD = 48 << 20


class Jobs:
    def __init__(self):
        self.jobs = {}

    def start(self, title, fn):
        jid = uuid.uuid4().hex[:12]
        job = {"id": jid, "title": title, "done": 0, "total": 0, "message": "starting", "finished": False, "result": None, "error": None}
        self.jobs[jid] = job

        def progress(done, total, msg):
            job.update(done=done, total=total, message=msg)

        def run():
            try:
                job["result"] = fn(progress)
            except Exception as e:  # noqa: BLE001
                log.exception("job %s failed", title)
                job["error"] = str(e)
            job["finished"] = True
        threading.Thread(target=run, daemon=True, name=f"job-{jid}").start()
        return job


class FileCache:
    """Small LRU of device files for editor previews."""
    def __init__(self, max_bytes=32 << 20):
        self.max, self.size, self.d = max_bytes, 0, collections.OrderedDict()
        self.lock = threading.Lock()

    def get(self, key):
        with self.lock:
            v = self.d.get(key)
            if v is not None:
                self.d.move_to_end(key)
            return v

    def put(self, key, v):
        with self.lock:
            if key in self.d:
                self.size -= len(self.d.pop(key))
            self.d[key] = v; self.size += len(v)
            while self.size > self.max and self.d:
                self.size -= len(self.d.popitem(last=False)[1])

    def drop(self, dev_id, kind, name):
        with self.lock:
            for k in [k for k in self.d if k[:3] == (dev_id, kind, name)]:
                self.size -= len(self.d.pop(k))


def make_handler(mgr, config):
    jobs, cache = Jobs(), FileCache()
    store = scenes.SceneStore(config.data_dir)
    stock_src = {name: src for src, name, _ in stock.ANIMATIONS}

    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "pixel2mqtt"

        def log_message(self, fmt, *args):  # quiet: frames arrive 30x a second
            pass

        # ------------------------------------------------------------ helpers
        def send(self, code, body=b"", ctype="application/json"):
            if isinstance(body, (dict, list)):
                body = json.dumps(body).encode()
            elif isinstance(body, str):
                body = body.encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def err(self, code, msg):
            self.send(code, {"error": msg})

        def body(self):
            n = int(self.headers.get("Content-Length") or 0)
            if n > MAX_UPLOAD:
                raise ValueError("upload too large")
            return self.rfile.read(n) if n else b""

        def jbody(self):
            b = self.body()
            return json.loads(b) if b else {}

        def display(self, dev_id):
            d = mgr.displays.get(dev_id)
            if not d:
                raise KeyError("unknown display")
            return d

        # ------------------------------------------------------------ routing
        def do_GET(self):
            self.route("GET")

        def do_HEAD(self):
            self.route("GET")

        def do_POST(self):
            self.route("POST")

        def do_DELETE(self):
            self.route("DELETE")

        def do_PUT(self):
            self.route("PUT")

        def route(self, method):
            url = urllib.parse.urlsplit(self.path)
            parts = [urllib.parse.unquote(p) for p in url.path.strip("/").split("/") if p]
            q = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items()}
            try:
                if not parts or parts[0] != "api":
                    return self.static(url.path)
                self.api(method, parts[1:], q)
            except KeyError as e:
                self.err(404, str(e).strip("'"))
            except APIError as e:
                self.err(502 if e.status >= 500 else e.status, f"display: {e.message}")
            except (ValueError, AssertionError) as e:
                self.err(400, str(e))
            except OSError as e:
                self.err(504, f"display unreachable: {e}")

        def static(self, path):
            rel = path.lstrip("/") or "index.html"
            f = (STATIC / rel).resolve()
            if STATIC not in f.parents or not f.is_file():
                return self.err(404, "not found")
            ctype = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype in ("application/javascript",):
                ctype += "; charset=utf-8"
            self.send(200, f.read_bytes(), ctype)

        def api(self, m, p, q):
            if p == ["status"] and m == "GET":
                return self.send(200, {
                    "config": config.describe(),
                    "mqtt": {"connected": bool(mgr.mqtt and mgr.mqtt.connected), "error": mgr.mqtt.last_error if mgr.mqtt else "MQTT not configured"},
                    "displays": [d.public() for d in mgr.displays.values()],
                    "found": mgr.found,
                })
            if p == ["scan"] and m == "POST":
                return self.send(200, mgr.scan())
            if p == ["adopt"] and m == "POST":
                b = self.jbody()
                mgr.adopt_start(b["host"])
                return self.send(200, {"ok": True})
            if p == ["adopt", "confirm"] and m == "POST":
                b = self.jbody()
                d = mgr.adopt_confirm(b["host"], b["code"], b.get("name"), b.get("topic"), b.get("uid"), bool(b.get("keep_legacy")))
                return self.send(200, d.public())
            if p == ["scenes"] and m == "GET":
                return self.send(200, store.list())
            if p[:1] == ["scenes"] and len(p) == 2:
                if m == "GET":
                    return self.send(200, store.get(p[1]))
                if m in ("PUT", "POST"):
                    return self.send(200, {"ok": True, "name": store.put(p[1], self.body())})
                if m == "DELETE":
                    store.delete(p[1])
                    return self.send(200, {"ok": True})
            if p == ["layer-frames"] and m == "POST":  # image/GIF -> frames for a new editor layer
                return self.send(200, {"frames": scenes.decode_layer_frames(self.body(), int(q.get("max", 256)))})
            if p[:1] == ["jobs"] and len(p) == 2:
                return self.send(200, jobs.jobs[p[1]])
            if p[:1] == ["displays"] and len(p) >= 2:
                return self.display_api(m, self.display(p[1]), p[2:], q)
            raise KeyError("unknown endpoint")

        def display_api(self, m, d, p, q):
            api = d.api
            if not p and m == "DELETE":
                mgr.remove(d.id)
                return self.send(200, {"ok": True})
            if p == ["storage"]:
                d.storage = api.storage()
                return self.send(200, d.storage)
            if p == ["frame"] and m == "POST":  # live preview -> UDP 7777
                b = self.body()
                if len(b) != FRAME_BYTES:
                    raise ValueError("frame must be 4992 bytes (52x32 RGB)")
                send_frame(d.cfg["host"], b)
                return self.send(204)
            if p == ["frame"] and m == "GET":
                return self.send(200, api.frame(), "application/octet-stream")
            if p[:1] == ["cmd"] and len(p) == 2 and m == "POST":
                api.cmd(p[1], self.body())
                return self.send(200, {"ok": True})
            if p == ["scene"] and m == "GET":  # open a display animation as editable layers
                name = q.get("anim", "")
                src = stock_src.get(name)
                if src:  # a built-in: rebuild its layers from the stock file on the display
                    try:
                        return self.send(200, json.dumps(scenes.scene_from_stock(api.res(f"{stock.RES}/{src}"))))
                    except APIError:
                        pass  # stock file missing on this display: fall back to the baked frames
                if name.startswith("App "):  # a scene the Govee app left on the display: rebuild its layers
                    data = stock.app_scenes(api).get(name)
                    if data is not None:
                        try:
                            return self.send(200, json.dumps(scenes.scene_from_stock(data)))
                        except Exception:  # noqa: BLE001 - not convertible as layers: use the baked frames
                            pass
                return self.send(200, json.dumps(scenes.scene_from_pxa(api.get_file("anims", name + ".anim"))))
            if p == ["import-stock"] and m == "POST":
                b = self.jbody()
                job = jobs.start("Import built-in animations and icons",
                                 lambda prog: stock.run(api, prog, overwrite=bool(b.get("overwrite"))))
                return self.send(200, job)
            if p == ["upload"] and m == "POST":
                return self.upload(d, q)
            if p[:1] == ["files"] and len(p) >= 2:
                kind = p[1]
                if kind not in KINDS:
                    raise KeyError("unknown kind")
                if len(p) == 2:
                    return self.send(200, api.files(kind))
                name = "/".join(p[2:])
                if m == "GET":
                    size = q.get("size", "")
                    key = (d.id, kind, name, size)
                    data = cache.get(key) if size else None
                    if data is None:
                        data = api.get_file(kind, name)
                        if size:
                            cache.put(key, data)
                    return self.send(200, data, "application/octet-stream")
                if m == "DELETE":
                    api.delete_file(kind, name)
                    cache.drop(d.id, kind, name)
                    return self.send(200, {"ok": True})
            raise KeyError("unknown endpoint")

        def upload(self, d, q):
            kind, data = q.get("kind", ""), self.body()
            if not data:
                raise ValueError("empty upload")
            raw_name = q.get("name") or "untitled"
            if kind == "anims":
                out = data if data[:4] == b"PXA1" else formats.make_anim(data, q.get("fit", "contain"))
                name = formats.safe_name(raw_name.rsplit(".", 1)[0] if raw_name.lower().endswith((".gif", ".png", ".anim", ".txt")) else raw_name) + ".anim"
                info = {"frames": len(formats.parse_pxa(out))}
            elif kind == "icons":
                out = data if data[:4] == b"PXI1" else formats.make_icon(data, fit_mode=q.get("fit", "contain"))
                name = formats.safe_name(raw_name.rsplit(".", 1)[0] if raw_name.lower().endswith((".gif", ".png", ".pxi")) else raw_name) + ".pxi"
                w, h, fr = formats.parse_pxi(out)
                info = {"frames": len(fr), "w": w, "h": h}
            elif kind == "sounds":
                stem, _, ext = raw_name.rpartition(".")
                if "." + ext.lower() not in formats.SOUND_EXT:
                    raise ValueError("sounds must be .mp3, .wav or .ogg")
                out, name, info = data, formats.safe_name(stem).replace(" ", "_") + "." + ext.lower(), {}
            else:
                raise ValueError("kind must be anims, icons or sounds")
            d.api.put_file(kind, name, out)
            cache.drop(d.id, kind, name)
            log.info("uploaded %s/%s (%d bytes) to %s", kind, name, len(out), d.name)
            return self.send(200, dict(info, ok=True, name=name, bytes=len(out)))

    return H


def serve(mgr, config):
    srv = ThreadingHTTPServer((config.web_host, config.web_port), make_handler(mgr, config))
    srv.daemon_threads = True
    log.info("web editor on http://%s:%d/", config.web_host, config.web_port)
    t = threading.Thread(target=srv.serve_forever, name="web", daemon=True)
    t.start()
    return srv
