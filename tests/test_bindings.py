"""python -m tests.test_bindings - value bindings: conversion, 1 KB batching, throttling, resend and cleanup (no HA, no display)."""
import json
import pathlib
import sys
import tempfile
import time
import types

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from pixel2mqtt.bindings import Bindings, split_messages, value_of  # noqa: E402

fails = 0


def ok(name, cond, extra=None):
    global fails
    print(("ok   " if cond else "FAIL ") + name + ("" if cond or extra is None else f"  -> {extra!r}"))
    fails += 0 if cond else 1


# --- conversion to the display's value formats
ok("number with unit", value_of({"kind": "state"}, {"s": "41.7", "a": {"unit_of_measurement": "%"}}) == [41.7, "%"])
ok("integer state", value_of({"kind": "state"}, {"s": "42", "a": {}}) == 42)
ok("text state", value_of({"kind": "state"}, {"s": "running", "a": {}}) == "running")
ok("unavailable -> null", value_of({"kind": "state"}, {"s": "unavailable", "a": {}}) is None)
ok("text cut to 63 bytes", len(value_of({"kind": "state"}, {"s": "é" * 40, "a": {}}).encode()) <= 63)
ok("attribute number", value_of({"kind": "attr", "attr": "temperature"}, {"s": "sunny", "a": {"temperature": 48}}) == 48)
ok("attribute bool", value_of({"kind": "attr", "attr": "x"}, {"s": "", "a": {"x": True}}) == 1)
ok("attribute list of numbers", value_of({"kind": "attr", "attr": "p"}, {"s": "", "a": {"p": list(range(100))}}) == list(range(36, 100)))
ok("history list", value_of({"kind": "history"}, None, [1, 2, 3]) == [1, 2, 3])

# --- batching
big = {f"value.{i:02d}": "x" * 60 for i in range(40)}
msgs = split_messages(big)
ok("split into <= 1 KB messages", all(len(m) <= 1024 for m in msgs) and len(msgs) > 1, [len(m) for m in msgs])
ok("nothing lost in the split", sum(len(json.loads(m)) for m in msgs) == 40)


# --- engine with a fake HA and display
class FakeDisplay:
    def __init__(self):
        self.online, self.sent = True, []

    def command(self, name, payload):
        self.sent.append((name, json.loads(payload), time.time()))


ha = types.SimpleNamespace(connected=True, states={
    "sensor.p": {"s": "40", "a": {"unit_of_measurement": "%"}}, "sensor.s": {"s": "running", "a": {}}},
    listeners=[], on_connect=[], history=lambda *a: [1.0, 2.0])
disp = FakeDisplay()
mgr = types.SimpleNamespace(displays={"d1": disp})
with tempfile.TemporaryDirectory() as tmp:
    b = Bindings(pathlib.Path(tmp), mgr, ha)
    b.start()
    b.activate("d1", "Printer", {"printer.progress": {"entity": "sensor.p"}, "printer.status": {"entity": "sensor.s"}})
    time.sleep(1.4)
    ok("activate sends the values", disp.sent and disp.sent[0][0] == "values" and disp.sent[0][1] == {"printer.progress": [40, "%"], "printer.status": "running"}, disp.sent)
    ok("saved to bindings.json", "Printer" in json.loads((pathlib.Path(tmp) / "bindings.json").read_text())["displays"]["d1"]["screens"])
    n = len(disp.sent)
    ha.states["sensor.p"] = {"s": "41", "a": {"unit_of_measurement": "%"}}
    for fn in ha.listeners:
        fn("sensor.p", ha.states["sensor.p"])
    time.sleep(1.3)
    ok("a state change sends only that value", disp.sent[n:] and disp.sent[-1][1] == {"printer.progress": [41, "%"]}, disp.sent[n:])
    n = len(disp.sent)
    b.resend_all("d1")
    time.sleep(1.3)
    ok("reconnect resends everything", disp.sent[n:] and set(disp.sent[-1][1]) == {"printer.progress", "printer.status"})
    # many values: one message per second
    b.activate("d1", "Big", {f"big.v{i:02d}": {"entity": "sensor.s"} for i in range(60)})
    time.sleep(3.5)
    times = [t for _, _, t in disp.sent[-3:]]
    ok("throttled to about 1 message/s", len(times) == 3 and min(b2 - a2 for a2, b2 in zip(times, times[1:])) > 0.8, times)
    n = len(disp.sent)
    b.deactivate("d1", "Big")
    time.sleep(1.3)
    gone = {k: v for _, m, _ in disp.sent[n:] for k, v in m.items()}
    ok("removing a screen deletes its values (null)", gone and all(v is None for v in gone.values()) and "printer.status" not in gone, list(gone)[:3])
    b.stop()

print(f"\n{fails} FAILED" if fails else "\nALL PASSED")
sys.exit(1 if fails else 0)
