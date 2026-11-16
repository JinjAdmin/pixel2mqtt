"""Offline tests (no display, no broker): converters, formats, topic rewriting, MQTT helpers.
Runs in CI. The full end-to-end test against pixeld is tests/run_pixeld_host.sh."""
import json
import pathlib
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from pixel2mqtt import formats, stock  # noqa: E402
from pixel2mqtt.bridge import Display, Manager  # noqa: E402
from pixel2mqtt.convert.minipng import write_png  # noqa: E402
from pixel2mqtt.mqtt import topic_matches  # noqa: E402

fails = []


def check(cond, what):
    print(("ok   " if cond else "FAIL ") + what)
    if not cond:
        fails.append(what)


def png(w, h, fill):
    with tempfile.TemporaryDirectory() as d:
        p = pathlib.Path(d) / "t.png"
        write_png(str(p), w, h, [[fill(x, y) for x in range(w)] for y in range(h)])
        return p.read_bytes()


# formats
a = formats.make_anim(png(104, 64, lambda x, y: (x * 2, y * 4, 200)))
fr = formats.parse_pxa(a)
check(len(fr) == 1 and len(fr[0][1]) == 4992, "large PNG -> one 52x32 frame")
small = formats.parse_pxa(formats.make_anim(png(10, 10, lambda x, y: (255, 0, 0))))[0][1]
check(small[:3] == b"\0\0\0" and small[(16 * 52 + 26) * 3] == 255, "small PNG centred on black")
cover = formats.parse_pxa(formats.make_anim(png(20, 10, lambda x, y: (0, 255, 0)), "cover"))[0][1]
check(all(cover[i * 3 + 1] == 255 for i in range(52 * 32)), "cover fills the panel")
w, h, frames = formats.parse_pxi(formats.make_icon(png(12, 9, lambda x, y: (1, 2, 3))))
check((w, h, len(frames)) == (12, 9, 1), "PNG -> PXI1 keeps its size")
w, h, _ = formats.parse_pxi(formats.make_icon(png(100, 100, lambda x, y: (9, 9, 9))))
check((w, h) == (32, 32), "big icon shrinks to fit 52x32")
check(formats.safe_name('a/b"c\\d.') == "a b c d", "safe_name strips path and quote characters")

# stock manifest
names = [n for _, n, _ in stock.ANIMATIONS]
check(len(names) == 59 and len(set(names)) == 59, "59 unique built-in animations")
check(sum(1 for *_, c in stock.ANIMATIONS if c) == 4, "4 clock scenes")
check(all('"' not in n and "/" not in n for n in names), "manifest names are device-safe")

# MQTT helpers
check(topic_matches("a/+/set", "a/text/set") and not topic_matches("a/+/set", "a/b/c/set"), "topic wildcards")
check(topic_matches("a/#", "a/b/c"), "multi-level wildcard")


# topic / payload rewriting
class Cfg:
    base, discovery_prefix, hosts, scan_interval = "pixel2mqtt", "homeassistant", [], 120


class NoStore:
    def devices(self):
        return []


m = Manager(Cfg, NoStore())
d = Display(m, {"id": "x", "name": "Desk", "host": "h", "token": "", "topic": "pixel2mqtt/desk", "uid": "p2m_x"})
check(d.map_topic("govee-pixel/text/state") == "pixel2mqtt/desk/text/state", "state topic rewritten")
check(d.map_topic("govee-pixel/status") is None, "device status not forwarded")
check(d.map_topic("homeassistant/select/govee_pixel_animation/config") == "homeassistant/select/p2m_x_animation/config", "discovery topic rewritten")
p = d.map_payload(json.loads('{"name":"Animation","uniq_id":"govee_pixel_animation","cmd_t":"govee-pixel/animation/set",'
                             '"avty_t":"govee-pixel/status","dev":{"ids":["govee_pixel_h6631"],"name":"Govee Pixel"}}'))
check(p["uniq_id"] == "p2m_x_animation" and p["cmd_t"] == "pixel2mqtt/desk/animation/set", "payload ids and topics")
check(p["dev"] == {"ids": ["p2m_x_h6631"], "name": "Desk", "via_device": "pixel2mqtt_bridge"}, "device block")
check(p["avty"] == [{"t": "pixel2mqtt/bridge/state"}, {"t": "pixel2mqtt/desk/status"}] and "avty_t" not in p, "availability list")


# a stray retained "offline" (e.g. the display's own MQTT will) is undone while the display is reachable
class FakeMQTT:
    def __init__(self):
        self.pubs = []

    def publish(self, t, p, retain=False):
        self.pubs.append((t, p, retain))


m.mqtt = FakeMQTT()
m.displays[d.id] = d
d.online = True
m._on_message("pixel2mqtt/desk/status", b"offline", True)
check(m.mqtt.pubs == [("pixel2mqtt/desk/status", "online", True)], "stray offline repaired")
m.mqtt.pubs.clear()
m._on_message("pixel2mqtt/desk/status", b"online", True)
d.online = False
m._on_message("pixel2mqtt/desk/status", b"offline", True)
check(m.mqtt.pubs == [], "real offline / own online left alone")

# renames: remembered per display, chained, and applied to import jobs
from pixel2mqtt import renames as renames_mod  # noqa: E402
with tempfile.TemporaryDirectory() as td:
    r = renames_mod.Renames(pathlib.Path(td))
    r.record("dev", "anims", "App 1234abcd", "Night Train")
    r.record("dev", "anims", "Night Train", "Night Train 2")
    check(r.for_display("dev", "anims") == {"App 1234abcd": "Night Train 2"}, "rename chain keeps the original")
    check(r.original("dev", "anims", "Night Train 2") == "App 1234abcd", "original name lookup")
    r.record("dev", "anims", "Night Train 2", "App 1234abcd")
    check(r.for_display("dev", "anims") == {}, "renaming back forgets the entry")


class NoRes:
    def res(self, path):
        raise RuntimeError("404")


names = [f for k, f, _ in stock.plan(NoRes(), {"Dragon": "My Dragon"}) if k == "anims"]
check("My Dragon.anim" in names and "Dragon.anim" not in names, "import writes renamed animations under the new name")

# dedupe: identical animations collapse to the real-named one; only_app never deletes real names
class FakeFiles:
    def __init__(self, files):
        self.f = dict(files)

    def files(self, kind):
        return [{"name": n, "size": len(d)} for n, d in self.f.items()]

    def get_file(self, kind, name):
        return self.f[name]

    def delete_file(self, kind, name):
        del self.f[name]


fa = FakeFiles({"App 1111.anim": b"AAAA", "Blue Rings.anim": b"AAAA", "Blue Rings.clock": b"1 2 X",
                "Copy of Rings.anim": b"AAAA", "App 2222.anim": b"BBBB", "Other.anim": b"CC"})
r = stock.dedupe(fa, only_app=True)
check(r["removed"] == ["App 1111.anim"] and "Copy of Rings.anim" in fa.f, "auto dedupe removes only App copies")
r = stock.dedupe(fa)
check(r["removed"] == ["Copy of Rings.anim"] and r["kept"]["Copy of Rings.anim"] == "Blue Rings.anim"
      and sorted(fa.f) == ["App 2222.anim", "Blue Rings.anim", "Blue Rings.clock", "Other.anim"], "full dedupe keeps one per group")

# Home Assistant add-on mode: options file, Supervisor MQTT login, Ingress-only access
import os  # noqa: E402
from pixel2mqtt import config as config_mod  # noqa: E402
with tempfile.TemporaryDirectory() as td:
    opts = pathlib.Path(td) / "options.json"
    opts.write_text(json.dumps({"base_topic": "p2m", "allow_direct_access": False, "mqtt_host": ""}))
    saved = (config_mod.ADDON_OPTIONS, config_mod._supervisor_mqtt, dict(os.environ))
    config_mod.ADDON_OPTIONS = opts
    config_mod._supervisor_mqtt = lambda: {"host": "core-mosquitto", "port": 1883, "user": "addons", "password": "x"}
    for k in ("MQTT_HOST", "MQTT_PORT", "MQTT_USER", "MQTT_PASSWORD", "PIXEL2MQTT_BASE", "PIXEL2MQTT_DATA"):
        os.environ.pop(k, None)
    os.environ["SUPERVISOR_TOKEN"] = "test"
    os.environ["PIXEL2MQTT_DATA"] = str(pathlib.Path(td) / "data")
    cwd = os.getcwd()
    os.chdir(td)   # no stray .env from the working directory
    try:
        c = config_mod.Config()
        check(c.addon and c.mqtt_host == "core-mosquitto" and c.mqtt_user == "addons" and c.base == "p2m",
              "add-on: options and the Supervisor's MQTT login are used")
        check(c.allowed_clients == {"172.30.32.2", "127.0.0.1", "::1"}, "add-on: web UI only via Ingress by default")
        opts.write_text(json.dumps({"allow_direct_access": True, "mqtt_host": "10.0.0.5", "mqtt_user": "me"}))
        c = config_mod.Config()
        check(c.allowed_clients is None and c.mqtt_host == "10.0.0.5" and c.mqtt_user == "me",
              "add-on: direct access and a manual broker can be chosen")
    finally:
        os.chdir(cwd)
        config_mod.ADDON_OPTIONS, config_mod._supervisor_mqtt = saved[0], saved[1]
        os.environ.clear(); os.environ.update(saved[2])

print(f"\n{len(fails)} failure(s)" if fails else "\nALL PASSED")
sys.exit(1 if fails else 0)
