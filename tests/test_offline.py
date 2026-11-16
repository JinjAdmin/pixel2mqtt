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

print(f"\n{len(fails)} failure(s)" if fails else "\nALL PASSED")
sys.exit(1 if fails else 0)
