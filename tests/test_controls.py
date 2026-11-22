"""python -m tests.test_controls - HA controls: the model, .scr patching, HA command -> resend, group built-ins."""
import json
import pathlib
import sys
import tempfile
import time
import types

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from pixel2mqtt import controls as ctl  # noqa: E402
from pixel2mqtt.bindings import Bindings  # noqa: E402

fails = 0


def ok(name, cond, extra=None):
    global fails
    print(("ok   " if cond else "FAIL ") + name + ("" if cond or extra is None else f"  -> {extra!r}"))
    fails += 0 if cond else 1


# --- model
cl = ctl.clean_controls([
    {"param": "screen.time", "name": "T", "type": "number", "min": 30, "max": 2, "step": 1, "unit": "s", "value": 10},
    {"param": "el.ab12.font", "name": "F", "type": "select", "options": ["tiny", "small", "small", ""], "line": 7, "value": "small"},
    {"param": "el.ab12.color", "type": "text", "value": "#ffffff"},                      # no line: dropped
    {"param": "screen.time", "type": "number"},                                          # duplicate: dropped
    {"param": "screen.name", "type": "text"},                                            # not controllable
    {"param": "el.cd34.pulse", "type": "switch", "line": 9, "value": True},
    {"param": "value.market.spark.hours", "type": "number", "min": 1, "max": 720},
    {"param": "el.ef.font", "type": "select", "options": [], "line": 3},                 # select without options
])
ok("clean: valid ones kept, in order", [c["param"] for c in cl] == ["screen.time", "el.ab12.font", "el.cd34.pulse", "value.market.spark.hours"], cl)
ok("clean: range ordered, options de-duplicated", cl[0]["min"] == 2 and cl[0]["max"] == 30 and cl[1]["options"] == ["tiny", "small"])
num, font, sw = cl[0], cl[1], cl[2]
ok("coerce: number clamped", ctl.coerce(num, "99") == 30 and ctl.coerce(num, "abc") is None and ctl.coerce(num, "4.0") == 4)
ok("coerce: select only its options", ctl.coerce(font, "big") is None and ctl.coerce(font, "tiny") == "tiny")
ok("coerce: switch", ctl.coerce(sw, "ON") is True and ctl.coerce(sw, "OFF") is False and ctl.coerce(sw, "maybe") is None)
col = {"param": "el.x.color", "type": "text"}
ok("coerce: colours must be #rrggbb, no quotes", ctl.coerce(col, "#FF8800") == "#ff8800" and ctl.coerce(col, "red") is None and ctl.coerce({"param": "screen.stale", "type": "text"}, '1h"') is None)
ok("state text", ctl.state_text(sw, True) == "ON" and ctl.state_text(num, 4.0) == "4")

# --- .scr patching
SCR = "\n".join(["PXS1", "name Ticker", "", 'text 1 2 font=small color="t.change>0:#28dc50;#b4b4b4" "{t.symbol}"',
                 "bar 0 20 52 3 value=t.p fill=#00a0ff..#ff0000", "rect 0 0 4 4", "# a comment", ""])
t = ctl.patch_scr(SCR, {"param": "el.a.font", "type": "select", "line": 4}, "big")
ok("element option replaced", 'font=big color="t.change>0:#28dc50;#b4b4b4" "{t.symbol}"' in t, t)
t = ctl.patch_scr(SCR, {"param": "el.a.color", "type": "text", "line": 4}, "#ffffff")
ok("colour rules: the default changes, the rules stay", 'color="t.change>0:#28dc50;#ffffff"' in t, t)
t = ctl.patch_scr(SCR, {"param": "el.b.fill", "type": "select", "line": 5}, "#00ff00")
ok("gradient: the start changes", "fill=#00ff00..#ff0000" in t, t)
t = ctl.patch_scr(SCR, {"param": "el.c.fill", "type": "switch", "line": 6}, True)
ok("missing option appended", "rect 0 0 4 4 fill=1" in t, t)
ok("a comment or a missing line is left alone", ctl.patch_scr(SCR, {"param": "el.c.fill", "type": "switch", "line": 7}, True) == SCR
   and ctl.patch_scr(SCR, {"param": "el.c.fill", "type": "switch", "line": 70}, True) == SCR)
t = ctl.patch_scr(SCR, {"param": "screen.time", "type": "number"}, 20)
ok("missing directive goes after name", t.split("\n")[2] == "time 20", t)
ok("directive replaced", ctl.patch_scr(t, {"param": "screen.time", "type": "number"}, 9).split("\n")[2] == "time 9")
ok("tokens keep quoted spaces", ctl.tokens('text 1 2 color="a b" "x \\" y"') == ["text", "1", "2", 'color="a b"', '"x \\" y"'])


# --- engine: HA command -> stored, sent, state published; removal clears discovery
class FakeMQTT:
    connected = True

    def __init__(self):
        self.pub = {}

    def publish(self, t, p, retain=False):
        self.pub[t] = p


class FakeAPI:
    def __init__(self):
        self.files = {}

    def put_file(self, kind, name, data):
        self.files[(kind, name)] = data.decode()


class FakeDisplay:
    def __init__(self):
        self.id, self.name, self.topic, self.uid, self.dev_ids, self.online, self.sent = "d1", "Desk", "pixel2mqtt/desk", "p2m_d1", ["p2m_d1_h6631"], True, []
        self.api = FakeAPI()

    def command(self, name, payload):
        self.sent.append(json.loads(payload))


ha = types.SimpleNamespace(connected=True, listeners=[], on_connect=[], on_registry=[], states={"sensor.btc": {"s": "5", "a": {}}},
                           history=lambda eid, hours, points, attr=None: [float(hours)] * 3, members=lambda by, match: [])
disp, mq = FakeDisplay(), FakeMQTT()
mgr = types.SimpleNamespace(displays={"d1": disp}, mqtt=mq, disc_prefix="homeassistant", bridge_state_topic="pixel2mqtt/bridge/state")
TICK = "\n".join(["PXS1", "name Ticker", "", "text 1 2 font=small \"{btc.price}\"", "spark 0 21 52 11 series=btc.spark", ""])
BIND = {"btc.price": {"entity": "sensor.btc", "kind": "state"}, "btc.spark": {"entity": "sensor.btc", "kind": "history", "hours": 24, "points": 48}}
CTL = [{"param": "el.k1.font", "name": "Ticker font", "type": "select", "options": ["small", "big"], "line": 4, "value": "small"},
       {"param": "value.btc.spark.hours", "name": "Ticker history", "type": "number", "min": 1, "max": 720, "step": 1, "unit": "h"},
       {"param": "value.btc.price.hours", "name": "not history", "type": "number", "min": 1, "max": 9}]
with tempfile.TemporaryDirectory() as tmp:
    b = Bindings(pathlib.Path(tmp), mgr, ha)
    b.start()
    b.activate("d1", "Ticker", BIND, None, CTL, TICK)
    fc = json.loads(mq.pub.get("homeassistant/select/p2m_d1/scr_ticker_el_k1_font/config", "{}"))
    hc = json.loads(mq.pub.get("homeassistant/number/p2m_d1/scr_ticker_value_btc_spark_hours/config", "{}"))
    ok("select entity on the display's device, stable unique_id", fc.get("uniq_id") == "p2m_d1_scr_ticker_el_k1_font" and fc.get("ops") == ["small", "big"] and fc.get("dev") == {"ids": ["p2m_d1_h6631"]}, fc)
    ok("number entity with range and unit", hc.get("min") == 1 and hc.get("max") == 720 and hc.get("unit_of_meas") == "h", hc)
    ok("a non-history value can't be an hours control", len(b.controls("d1", "Ticker")) == 2)
    ok("initial states", mq.pub.get("pixel2mqtt/desk/control/ticker/el_k1_font/state") == "small" and mq.pub.get("pixel2mqtt/desk/control/ticker/value_btc_spark_hours/state") == "24")
    hit = b.on_control(disp, "pixel2mqtt/desk/control/ticker/el_k1_font/set")
    ok("command topic -> screen and param", hit == ("Ticker", "el.k1.font"), hit)
    b.set_control("d1", "Ticker", "el.k1.font", "big")
    time.sleep(0.3)
    sent = disp.api.files.get(("screens", "Ticker.scr"), "")
    ok("HA command: .scr patched and sent right away", 'font=big "{btc.price}"' in sent, sent)
    ok("... saved and its state published", 'font=big' in json.loads((pathlib.Path(tmp) / "bindings.json").read_text())["displays"]["d1"]["controls"]["Ticker"]["scr"]
       and mq.pub["pixel2mqtt/desk/control/ticker/el_k1_font/state"] == "big")
    ok("an invalid command changes nothing", b.set_control("d1", "Ticker", "el.k1.font", "huge") is False)
    time.sleep(1.2)
    n = len(disp.sent)
    b.set_control("d1", "Ticker", "value.btc.spark.hours", "72")
    time.sleep(1.3)
    ok("history window: new values go out right away", any(m.get("btc.spark") == [72.0] * 3 for m in disp.sent[n:]), disp.sent[n:])
    ok("... it's the binding's hours (the editor's 'last hours')", b.screens("d1")["Ticker"]["btc.spark"]["hours"] == 72 and mq.pub["pixel2mqtt/desk/control/ticker/value_btc_spark_hours/state"] == "72")
    b.activate("d1", "Ticker", BIND, None, CTL[1:], TICK)
    ok("removing a control clears its discovery", mq.pub.get("homeassistant/select/p2m_d1/scr_ticker_el_k1_font/config") == ""
       and mq.pub.get("homeassistant/number/p2m_d1/scr_ticker_value_btc_spark_hours/config", "") != "")
    b.deactivate("d1", "Ticker")
    ok("deleting the screen clears the rest", mq.pub.get("homeassistant/number/p2m_d1/scr_ticker_value_btc_spark_hours/config") == "")

    # groups: the member select and rotate number are built-in controls with their original ids and topics
    b.ha.members = lambda by, match: [{"id": "sensor.btc", "name": "BTC"}]
    b.activate("d1", "Market chart", {"m.spark": {"kind": "group", "source": "history", "hours": 24}}, {"name": "Market ticker", "by": "integration", "match": "x", "rotate": 8},
               [{"param": "value.m.spark.hours", "name": "Market chart history", "type": "number", "min": 1, "max": 720}], TICK)
    sel = json.loads(mq.pub.get("homeassistant/select/p2m_d1/grp_market_chart/config", "{}"))
    rot = json.loads(mq.pub.get("homeassistant/number/p2m_d1/grp_market_chart_rotate/config", "{}"))
    ok("group select keeps its unique_id and topics", sel.get("uniq_id") == "p2m_d1_grp_market_chart" and sel.get("cmd_t") == "pixel2mqtt/desk/group/market_chart/select", sel)
    ok("rotate number keeps its unique_id and topics", rot.get("uniq_id") == "p2m_d1_grp_market_chart_rotate" and rot.get("cmd_t") == "pixel2mqtt/desk/group/market_chart/rotate", rot)
    ok("group screens take controls too", "homeassistant/number/p2m_d1/scr_market_chart_value_m_spark_hours/config" in mq.pub)
    # the reported bug: a history window as a select. State must follow the applied window, hours stay numbers.
    win = {"param": "value.m.spark.hours", "name": "Chart window", "type": "select", "options": ["24", "168", "720"], "value": 24}
    b.activate("d1", "Market chart", {"m.spark": {"kind": "group", "source": "history", "hours": 24}}, {"name": "Market ticker", "by": "integration", "match": "x", "rotate": 8}, [win], TICK)
    st_t = "pixel2mqtt/desk/control/market_chart/value_m_spark_hours/state"
    for opt in ("168", "720", "24"):
        b.set_control("d1", "Market chart", "value.m.spark.hours", opt)
        h = b.screens("d1")["Market chart"]["m.spark"]["hours"]
        ok(f"select {opt}: hours stored as a number, state follows", h == int(opt) and not isinstance(h, str) and mq.pub[st_t] == opt, (h, mq.pub[st_t]))
    ok("no stale stored value for a history control", "value" not in b.controls("d1", "Market chart")[0])
    b.set_control("d1", "Market chart", "value.m.spark.hours", "720")
    b2 = Bindings(pathlib.Path(tmp), mgr, ha)
    mq.pub[st_t] = "?"
    b2.publish_groups("d1")
    ok("after a restart the state is the applied window", mq.pub[st_t] == "720", mq.pub[st_t])
    b.activate("d1", "Market chart", {"m.spark": {"kind": "group", "source": "history", "hours": 48}}, {"name": "Market ticker", "by": "integration", "match": "x", "rotate": 8}, [win], TICK)
    sc = json.loads(mq.pub["homeassistant/select/p2m_d1/scr_market_chart_value_m_spark_hours/config"])
    ok("editor sends a window that isn't an option: state is still valid in HA", mq.pub[st_t] == "2d" and "2d" in sc["ops"], (mq.pub[st_t], sc["ops"]))
    fr = dict(win, options=["1h", "6h", "24h", "3d", "7d", "30d", "bogus"])
    b.activate("d1", "Market chart", {"m.spark": {"kind": "group", "source": "history", "hours": 24}}, {"name": "Market ticker", "by": "integration", "match": "x", "rotate": 8}, [fr], TICK)
    ok("friendly options: bad ones dropped", b.controls("d1", "Market chart")[0]["options"] == ["1h", "6h", "24h", "3d", "7d", "30d"] and mq.pub[st_t] == "24h")
    b.set_control("d1", "Market chart", "value.m.spark.hours", "7d")
    ok("'7d' -> 168 hours, state '7d'", b.screens("d1")["Market chart"]["m.spark"]["hours"] == 168 and mq.pub[st_t] == "7d")
    ok("parse_hours", [ctl.parse_hours(x) for x in ("12h", "3d", "36", "0", "x", "1.5h")] == [12, 72, 36, None, None, 1.5])
    b.rename_screen("d1", "Market chart", "Markets")
    ok("rename moves the entities", mq.pub.get("homeassistant/select/p2m_d1/grp_market_chart/config") == "" and "homeassistant/select/p2m_d1/grp_markets/config" in mq.pub
       and mq.pub.get("homeassistant/number/p2m_d1/scr_market_chart_value_m_spark_hours/config") == "" and b.controls("d1", "Markets"))
    b.stop()

# an older bindings.json (no "controls") loads and publishes as before
with tempfile.TemporaryDirectory() as tmp:
    (pathlib.Path(tmp) / "bindings.json").write_text(json.dumps({"displays": {"d1": {"screens": {"G": {}}, "groups": {"G": {"name": "G member", "by": "domain", "match": "sensor", "rotate": 8, "selected": "rotate"}}}}}))
    mq.pub.clear()
    b = Bindings(pathlib.Path(tmp), mgr, ha)
    b.publish_groups()
    ok("old data: group entities published as before", json.loads(mq.pub.get("homeassistant/select/p2m_d1/grp_g/config", "{}")).get("uniq_id") == "p2m_d1_grp_g")

print(f"\n{fails} FAILED" if fails else "\nALL PASSED")
sys.exit(1 if fails else 0)
