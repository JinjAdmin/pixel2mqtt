"""End-to-end test against a host-built pixeld (see run_pixeld_host.sh): device API, pairing, files, events,
the MQTT bridge (with a tiny in-process broker) and optionally the built-in-artwork importer."""
import hashlib
import json
import os
import pathlib
import re
import socket
import struct
import sys
import threading
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from pixel2mqtt import formats, stock  # noqa: E402
from pixel2mqtt.bridge import Manager  # noqa: E402
from pixel2mqtt.config import Store  # noqa: E402
from pixel2mqtt.convert.minipng import write_png  # noqa: E402
from pixel2mqtt.device import APIError, PixelAPI, scan  # noqa: E402
from pixel2mqtt.mqtt import MQTTClient, topic_matches  # noqa: E402

HOST = "127.0.0.1"
LOG = pathlib.Path(os.environ["P2M_PIXELD_LOG"])
fails = []


def check(cond, what):
    print(("ok   " if cond else "FAIL ") + what, flush=True)
    if not cond:
        fails.append(what)


def expect_status(fn, status, what):
    try:
        fn()
        check(False, f"{what} -> expected {status}")
    except APIError as e:
        check(e.status == status, f"{what} -> {e.status} {e.message}")


def png_bytes(w, h, fill):
    p = pathlib.Path("/tmp/p2m_test.png")
    write_png(str(p), w, h, [[fill(x, y) for x in range(w)] for y in range(h)])
    return p.read_bytes()


# ------------------------------------------------------------------ tiny MQTT broker (QoS 0)
class Broker:
    def __init__(self, port=1883):
        self.srv = socket.socket(); self.srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.srv.bind((HOST, port)); self.srv.listen(5)
        self.clients, self.retained, self.log, self.lock = [], {}, [], threading.Lock()
        threading.Thread(target=self.accept, daemon=True).start()

    def accept(self):
        while True:
            c, _ = self.srv.accept()
            st = {"sock": c, "subs": []}
            with self.lock:
                self.clients.append(st)
            threading.Thread(target=self.serve, args=(st,), daemon=True).start()

    def route(self, topic, payload, retain):
        with self.lock:
            self.log.append((topic, payload, retain))
            if retain:
                self.retained[topic] = payload
            for c in self.clients:
                if any(topic_matches(f, topic) for f in c["subs"]):
                    self.send_pub(c, topic, payload)

    @staticmethod
    def send_pub(c, topic, payload):
        t = topic.encode(); body = struct.pack(">H", len(t)) + t + payload
        n, lb = len(body), bytearray()
        while True:
            d, n = n % 128, n // 128
            lb.append(d | (128 if n else 0))
            if not n:
                break
        try:
            c["sock"].sendall(b"\x30" + bytes(lb) + body)
        except OSError:
            pass

    def serve(self, c):
        s, buf = c["sock"], b""
        while True:
            try:
                d = s.recv(65536)
            except OSError:
                return
            if not d:
                return
            buf += d
            while len(buf) >= 2:
                n, mul, i = 0, 1, 1
                while True:
                    if i >= len(buf):
                        n = -1; break
                    b = buf[i]; i += 1; n += (b & 127) * mul; mul *= 128
                    if not b & 128:
                        break
                if n < 0 or len(buf) < i + n:
                    break
                t, fl, body = buf[0] >> 4, buf[0] & 15, buf[i:i + n]; buf = buf[i + n:]
                if t == 1:
                    s.sendall(b"\x20\x02\x00\x00")
                elif t == 8:
                    pid, j, new = body[:2], 2, []
                    while j < len(body):
                        ln = struct.unpack(">H", body[j:j + 2])[0]; new.append(body[j + 2:j + 2 + ln].decode()); j += 3 + ln
                    c["subs"] += new
                    s.sendall(b"\x90\x03" + pid + b"\x00")
                    with self.lock:
                        for tp, pl in list(self.retained.items()):
                            if any(topic_matches(f, tp) for f in new):
                                self.send_pub(c, tp, pl)
                elif t == 3:
                    ln = struct.unpack(">H", body[:2])[0]
                    self.route(body[2:2 + ln].decode(), body[2 + ln:], bool(fl & 1))
                elif t == 12:
                    s.sendall(b"\xd0\x00")


def pairing_code():
    for _ in range(20):
        m = re.findall(r"pairing code (\d{6})", LOG.read_text(errors="replace"))
        if m:
            return m[-1]
        time.sleep(0.1)
    raise RuntimeError("no pairing code in the pixeld log")


def main():
    api = PixelAPI(HOST)
    info = api.info()
    check(info["app"] == "pixeld" and info["id"] == "020000aabbcc" and not info["paired"], f"info {info}")
    expect_status(api.storage, 401, "storage without token")
    found = scan([HOST])
    check(HOST in found and found[HOST]["id"] == info["id"], "UDP 7778 discovery answers")

    # pairing
    api.pair_start()
    check(api.info()["pairing"], "pairing flag set")
    expect_status(lambda: api.pair_confirm("000000" if pairing_code() != "000000" else "111111"), 403, "wrong code")
    tok = api.pair_confirm(pairing_code())
    check(len(tok) == 32, "token issued")
    api.token = tok
    check(not api.info()["pairing"], "pairing ended")
    st = api.storage()
    check(st["data"]["total"] > 0 and st["udisk"]["free"] > 0, f"storage {st['udisk']}")

    # discovery capture + events
    d = api.discovery()
    topics = [m["t"] for m in d["msgs"]]
    check(len(d["msgs"]) > 30 and "homeassistant/select/govee_pixel_animation/config" in topics, f"discovery has {len(d['msgs'])} msgs")
    seq = d["seq"]
    api.cmd("text", "Hello test")
    ev = api.events(seq, 2)
    check(any(m["t"] == "govee-pixel/text/state" and m["p"] == "Hello test" for m in ev["msgs"]), "cmd text -> state event")
    seq = ev["seq"]
    t0 = time.time(); ev = api.events(seq, 2)
    check(not ev["msgs"] and 1.5 < time.time() - t0 < 4, "long-poll waits when idle")

    # files: animation from a PNG, round trip, rescan -> discovery with the new option
    anim = formats.make_anim(png_bytes(80, 40, lambda x, y: (x * 3, y * 6, 128, 255)))
    check(len(formats.parse_pxa(anim)) == 1, "PNG -> PXA1 (scaled to fit)")
    api.put_file("anims", "Test Pattern.anim", anim)
    check(api.get_file("anims", "Test Pattern.anim") == anim, "anim round trip")
    big = os.urandom(3 << 20)
    api.put_file("sounds", "big_noise.wav", big)
    check(hashlib.md5(api.get_file("sounds", "big_noise.wav")).digest() == hashlib.md5(big).digest(), "3 MB streamed upload intact")
    time.sleep(2.5)
    ev = api.events(seq, 5)
    opts = [m for m in ev["msgs"] if m["t"] == "homeassistant/select/govee_pixel_animation/config"]
    check(opts and "Test Pattern" in json.loads(opts[-1]["p"])["ops"], "rescan republished Animation options")
    snd = [m for m in ev["msgs"] if m["t"] == "homeassistant/select/govee_pixel_sound/config"]
    check(snd and "big noise" in json.loads(snd[-1]["p"])["ops"], "uploaded sound in Doorbell sound options")
    seq = ev["seq"]
    expect_status(lambda: api.put_file("anims", "bad.anim", b"nope" * 10), 400, "non-PXA1 .anim rejected")
    expect_status(lambda: api.put_file("anims", 'qu"ote.anim', anim), 400, "quote in name rejected")
    expect_status(lambda: api.put_file("anims", "../evil.anim", anim), 400, "path in name rejected")
    expect_status(lambda: api.put_file("anims", "x.sh", b"#!"), 400, "wrong extension rejected")
    names = [f["name"] for f in api.files("anims")]
    check("Test Pattern.anim" in names, "listing")
    api.cmd("animation", "Test Pattern")
    fr = api.frame()
    check(len(fr) == 4992 and fr[:3] == anim[8:11], "frame endpoint shows the animation")
    from pixel2mqtt.device import send_frame
    send_frame(HOST, bytes([200, 0, 100]) * (52 * 32)); time.sleep(0.3)
    check(api.frame()[:3] == bytes([200, 0, 100]), "UDP 7777 live frame shown")
    time.sleep(3.3)
    check(api.frame()[:3] == anim[8:11], "back to the animation 3 s after the last live frame")
    api.delete_file("sounds", "big_noise.wav")
    expect_status(lambda: api.get_file("sounds", "big_noise.wav"), 404, "deleted")

    # icons
    ico = formats.make_icon(png_bytes(12, 10, lambda x, y: (255, 0, 0, 255 if (x + y) % 2 else 0)))
    api.put_file("icons", "checker.pxi", ico)
    check(formats.parse_pxi(api.get_file("icons", "checker.pxi"))[:2] == (12, 10), "icon round trip")

    # stock resources
    expect_status(lambda: api.res("/usr/res/../etc/passwd"), 400, "res traversal blocked")
    expect_status(lambda: api.res("/etc"), 400, "res outside /usr/res blocked")

    # scenes the Govee app left in /mnt/UDISK/data (fixtures from run_pixeld_host.sh; synthetic bytes)
    lst = api.res("/mnt/UDISK/data/big_data")
    check(isinstance(lst, list) and [e["name"] for e in lst] == ["cached1"], "app scene folder listed")
    check(api.res("/mnt/UDISK/data/big_data/cached1") == b"P]GIF89a-synthetic-test-data", "app scene readable")
    expect_status(lambda: api.res("/mnt/UDISK/data/multimedia.db"), 400, "other app data blocked")
    expect_status(lambda: api.res("/mnt/UDISK/data/big_data/../multimedia.db"), 400, "app folder traversal blocked")
    expect_status(lambda: api.res("/mnt/UDISK/anims"), 400, "rest of UDISK blocked")
    sc = stock.app_scenes(api)
    check(list(sc.values()) == [b"GIF89a-synthetic-test-data"], "app_scenes strips the cache prefix")

    import urllib.request
    page = lambda: urllib.request.urlopen(f"http://{HOST}/").read().decode()  # noqa: E731
    check("paired, not connected" in page(), "editor-only polling does not take over MQTT")

    # ---------------------------------------------------------------- bridge with a broker
    broker = Broker()
    data = pathlib.Path("/tmp/p2m_data"); data.mkdir(exist_ok=True)
    (data / "devices.json").write_text(json.dumps({"devices": [
        {"id": info["id"], "name": "Desk Pixel", "host": HOST, "token": tok, "topic": "pixel2mqtt/desk", "uid": "p2m_test"}]}))

    class C:
        base, discovery_prefix, hosts, scan_interval = "pixel2mqtt", "homeassistant", [], 120
    mgr = Manager(C, Store(data))
    mq = MQTTClient(HOST, 1883, client_id="p2m-test", will=("pixel2mqtt/bridge/state", "offline", True))
    mgr.start(mq); mq.start()
    time.sleep(3)
    r = broker.retained
    cfg = r.get("homeassistant/select/p2m_test_animation/config")
    check(cfg is not None, "bridge published rewritten discovery")
    if cfg:
        c = json.loads(cfg)
        check(c["cmd_t"] == "pixel2mqtt/desk/animation/set" and c["uniq_id"] == "p2m_test_animation", "topics + unique ids rewritten")
        check(c["dev"]["ids"] == ["p2m_test_h6631"] and c["dev"]["name"] == "Desk Pixel", "device block rewritten")
        check(c.get("avty") == [{"t": "pixel2mqtt/bridge/state"}, {"t": "pixel2mqtt/desk/status"}], "availability = bridge + display")
        check("Test Pattern" in c["ops"], "options include uploaded animation")
    check("Managed by pixel2mqtt: yes" in page(), "bridge with a broker takes over MQTT")
    check(r.get("pixel2mqtt/desk/status") == b"online" and r.get("pixel2mqtt/bridge/state") == b"online", "availability online")
    check(not any(t.startswith("govee-pixel/") or "govee_pixel" in t for t, _, _ in broker.log), "no unrewritten topics leaked")
    pub = MQTTClient(HOST, 1883, client_id="tester"); pub.start(); time.sleep(0.5)
    pub.publish("pixel2mqtt/desk/text/set", "via MQTT")
    time.sleep(1.5)
    check(r.get("pixel2mqtt/desk/text/state") == b"via MQTT", "MQTT command -> display -> state back")
    pub.publish("homeassistant/status", "online"); time.sleep(1.5)
    check(sum(1 for t, _, _ in broker.log if t == "homeassistant/select/p2m_test_animation/config") >= 2, "HA restart -> discovery re-sent")
    mgr.shutdown(); mq.stop(); pub.stop()
    time.sleep(0.5)
    check(r.get("pixel2mqtt/desk/status") == b"offline", "display offline on shutdown")

    # ---------------------------------------------------------------- built-in artwork importer
    mirror = os.environ.get("P2M_RES_MIRROR")
    if mirror:
        t0 = time.time()
        res = stock.run(api, lambda d, n, m: None)
        check(not res["failed"] and res["imported"] > 140, f"stock import {res['imported']} files in {time.time() - t0:.0f}s, failed {res['failed'][:3]}")
        for kind, exp_env in (("anims", "P2M_EXPECT_ANIMS"), ("icons", "P2M_EXPECT_ICONS")):
            exp = os.environ.get(exp_env)
            if not exp:
                continue
            bad = []
            for f in sorted(pathlib.Path(exp).iterdir()):
                if f.suffix in (".anim", ".clock", ".pxi") and api.get_file(kind, f.name) != f.read_bytes():
                    bad.append(f.name)
            check(not bad, f"imported {kind} identical to the hand-tuned set ({len(bad)} differ: {bad[:5]})")
        again = stock.run(api)
        check(again["imported"] == 0 and again["skipped"] == res["imported"], "second import skips existing files")

    print(f"\n{len(fails)} failure(s)" if fails else "\nALL PASSED")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
