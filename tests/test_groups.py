"""python -m tests.test_groups - template screens: group members, HA select/number discovery, selection, rotation."""
import json
import pathlib
import sys
import tempfile
import time
import types

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from pixel2mqtt.bindings import Bindings, transform  # noqa: E402
from pixel2mqtt.ha import HomeAssistant  # noqa: E402

fails = 0


def ok(name, cond, extra=None):
    global fails
    print(("ok   " if cond else "FAIL ") + name + ("" if cond or extra is None else f"  -> {extra!r}"))
    fails += 0 if cond else 1


def st(state, **a):
    return {"s": state, "a": a}


# --- display forms
ok("short symbol: index", transform("short_symbol", "^GSPC", None) == "S&P")
ok("short symbol: crypto pair", transform("short_symbol", "BTC-USD", None) == "BTC")
ok("short symbol: stock", transform("short_symbol", "AAPL", None) == "AAPL")
ok("price prefix: $ for USD, none for an index",
   transform("price_prefix", "USD", st("1", symbol="AAPL", currency="USD")) == "$" and transform("price_prefix", "USD", st("1", symbol="^GSPC", currency="USD")) == "")
ok("is crypto", transform("is_crypto", "BTC-USD", None) == 1 and transform("is_crypto", "^GSPC", None) == 0)

# --- member lookup (the real HomeAssistant.members over fake registries)
ha = HomeAssistant(types.SimpleNamespace(addon=False))
ha.connected = True
ha.states = {
    "sensor.gspc": st("6919.95", symbol="^GSPC", currency="USD", change_pct=-3.57, friendly_name="S&P 500", unit_of_measurement="USD"),
    "sensor.btc_usd": st("58298.52", symbol="BTC-USD", currency="USD", change_pct=-5.82, friendly_name="BTC", unit_of_measurement="USD"),
    "sensor.eth_usd": st("1592.26", symbol="ETH-USD", currency="USD", change_pct=-6.1, friendly_name="ETH", unit_of_measurement="USD"),
    "sensor.kitchen_temp": st("21.5", friendly_name="Kitchen temperature", unit_of_measurement="°C"),
}
ha.entities = {"sensor.gspc": {"platform": "easy_stock", "labels": ["tick"]}, "sensor.btc_usd": {"platform": "easy_stock"},
               "sensor.eth_usd": {"platform": "easy_stock", "labels": ["tick"]}, "sensor.kitchen_temp": {"platform": "mqtt", "device_id": "dev1"}}
ha.devices = {"dev1": {"id": "dev1", "name": "Kitchen sensor"}}
ha.labels = {"tick": {"label_id": "tick", "name": "Pixel ticker"}}
ha.history = lambda eid, hours, points, attr=None: [1.0, 2.0, 3.0] if eid == "sensor.btc_usd" else [5.0, 4.0]
names = lambda ms: [m["name"] for m in ms]  # noqa: E731
ok("members by integration (sorted by name)", names(ha.members("integration", "easy_stock")) == ["BTC", "ETH", "S&P 500"], ha.members("integration", "easy_stock"))
ok("members by label name", names(ha.members("label", "pixel ticker")) == ["ETH", "S&P 500"])
ok("members by device name", names(ha.members("device", "Kitchen sensor")) == ["Kitchen temperature"])
ok("members by entity type", len(ha.members("domain", "sensor")) == 4)
ok("members by entity list keep their order", names(ha.members("entities", "sensor.gspc, sensor.btc_usd")) == ["S&P 500", "BTC"])


# --- engine
class FakeMQTT:
    connected = True

    def __init__(self):
        self.pub = {}

    def publish(self, t, p, retain=False):
        self.pub[t] = p


class FakeDisplay:
    def __init__(self):
        self.id, self.topic, self.uid, self.dev_ids, self.online, self.sent = "d1", "pixel2mqtt/desk", "p2m_d1", ["p2m_d1_h6631"], True, []

    def command(self, name, payload):
        self.sent.append(json.loads(payload))


disp, mq = FakeDisplay(), FakeMQTT()
mgr = types.SimpleNamespace(displays={"d1": disp}, mqtt=mq, disc_prefix="homeassistant", bridge_state_topic="pixel2mqtt/bridge/state")
MAP = {"market.symbol": {"kind": "group", "source": "attr", "attr": "symbol", "fmt": "short_symbol"},
       "market.price": {"kind": "group", "source": "state"},
       "market.change": {"kind": "group", "source": "attr", "attr": "change_pct"},
       "market.spark": {"kind": "group", "source": "history", "hours": 24, "points": 48},
       "market.prefix": {"kind": "group", "source": "attr", "attr": "currency", "fmt": "price_prefix"},
       "market.crypto": {"kind": "group", "source": "attr", "attr": "symbol", "fmt": "is_crypto"}}
with tempfile.TemporaryDirectory() as tmp:
    b = Bindings(pathlib.Path(tmp), mgr, ha)
    b.start()
    b.activate("d1", "Market chart", MAP, {"name": "Market ticker", "by": "integration", "match": "easy_stock", "rotate": 2})
    sel = json.loads(mq.pub.get("homeassistant/select/p2m_d1/grp_market_chart/config", "{}"))
    num = json.loads(mq.pub.get("homeassistant/number/p2m_d1/grp_market_chart_rotate/config", "{}"))
    ok("HA select: Rotate + every member, on the display's device", sel.get("ops") == ["Rotate", "BTC", "ETH", "S&P 500"] and sel.get("dev") == {"ids": ["p2m_d1_h6631"]}, sel)
    ok("HA number: rotate seconds", num.get("min") == 2 and num.get("max") == 600 and mq.pub.get("pixel2mqtt/desk/group/market_chart/rotate_state") == "2")
    ok("selected state is Rotate", mq.pub.get("pixel2mqtt/desk/group/market_chart/selected") == "Rotate")
    time.sleep(1.4)
    first = disp.sent[0] if disp.sent else {}
    ok("first member's whole set in one message", first == {"market.symbol": "BTC", "market.price": [58298.52, "USD"], "market.change": -5.82,
                                                          "market.spark": [1.0, 2.0, 3.0], "market.prefix": "$", "market.crypto": 1}, first)
    n = len(disp.sent)
    time.sleep(3.6)
    nxt = [m for m in disp.sent[n:] if "market.symbol" in m]
    ok("Rotate moves to the next member, all values together", nxt and nxt[0].get("market.symbol") == "ETH" and len(nxt[0]) == 6, nxt[:1])
    # pick one in HA (the select's command topic)
    hit = b.on_command(disp, "pixel2mqtt/desk/group/market_chart/select")
    ok("command topic maps to the screen", hit == ("Market chart", "select"))
    b.select("d1", "Market chart", "S&P 500")
    time.sleep(1.3)
    last = [m for m in disp.sent if "market.symbol" in m][-1]
    ok("choosing S&P 500 sends its set", last.get("market.symbol") == "S&P" and last.get("market.prefix") == "" and last.get("market.crypto") == 0, last)
    ok("selection is saved", json.loads((pathlib.Path(tmp) / "bindings.json").read_text())["displays"]["d1"]["groups"]["Market chart"]["selected"] == "sensor.gspc")
    ok("selected state shows the member", mq.pub.get("pixel2mqtt/desk/group/market_chart/selected") == "S&P 500")
    n = len(disp.sent)
    time.sleep(2.5)
    ok("a fixed member doesn't rotate", not [m for m in disp.sent[n:] if "market.symbol" in m])
    ha.states["sensor.gspc"] = st("6950.00", symbol="^GSPC", currency="USD", change_pct=-3.1, friendly_name="S&P 500", unit_of_measurement="USD")
    for fn in ha.listeners:
        fn("sensor.gspc", ha.states["sensor.gspc"])
    time.sleep(1.3)
    ok("the shown member's changes go out", disp.sent and disp.sent[-1].get("market.price") == [6950, "USD"], disp.sent[-1:])
    b.set_rotate("d1", "Market chart", "15")
    ok("rotate seconds saved and published", b.groups("d1")["Market chart"]["rotate"] == 15 and mq.pub["pixel2mqtt/desk/group/market_chart/rotate_state"] == "15")
    ok("preview for any member", b.preview(MAP, "sensor.eth_usd")["market.symbol"] == "ETH")
    b.deactivate("d1", "Market chart")
    ok("removing the screen removes the HA entities", mq.pub.get("homeassistant/select/p2m_d1/grp_market_chart/config") == "")
    b.stop()

print(f"\n{fails} FAILED" if fails else "\nALL PASSED")
sys.exit(1 if fails else 0)
