"""Value bindings for info screens: Home Assistant entities -> named values on the displays.

data/bindings.json: {"displays": {<display id>: {"screens": {<screen name>: {<value name>: spec}}}}}
spec: {"entity": "sensor.x", "kind": "state" | "attr" | "history", "attr": "...", "hours": 24, "points": 32}

Values go to the display's `values` command (the same path as <topic>/values/set): flat JSON, at most 8 KB per
message, at most about one message per second per display. Everything is resent when a display (re)connects or
Home Assistant reconnects, and every 10 minutes (pixeld's fresh()/stale/needs mean "recently sent"). Sending a screen activates its bindings; deleting it drops the ones nothing else uses.
"""
import json
import logging
import os
import threading
import time

log = logging.getLogger("bindings")
MAX_MSG = 8192   # pixeld takes up to 16 KB per values message (HTTP and MQTT); stay well under
UNSET = object()


def _trunc(s: str, n=63) -> str:
    b = s.encode("utf-8")[:n]
    return b.decode("utf-8", "ignore")


def _num(v):
    if isinstance(v, bool):
        return 1 if v else 0
    if isinstance(v, (int, float)):
        return v
    try:
        f = float(v)
        return int(f) if f.is_integer() and "." not in str(v) and "e" not in str(v).lower() else f
    except (TypeError, ValueError):
        return None


def value_of(spec, st, history=None):
    """One binding's value in the display's format (number, string, [number, unit], list of numbers, or None)."""
    kind = spec.get("kind", "state")
    if kind == "history":
        return list(history)[-64:] if history else None
    if st is None:
        return None
    if kind == "attr":
        v = (st.get("a") or {}).get(spec.get("attr", ""))
        if v is None:
            return None
        if isinstance(v, (bool, int, float)):
            return _num(v)
        if isinstance(v, list) and v and all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in v):
            return v[-64:]
        n = _num(v) if isinstance(v, str) else None
        if n is not None:
            return n
        return _trunc(v if isinstance(v, str) else json.dumps(v, separators=(",", ":")))
    s = st.get("s")
    if s in (None, "", "unknown", "unavailable"):
        return None
    n = _num(s)
    if n is not None:
        unit = (st.get("a") or {}).get("unit_of_measurement")
        return [n, unit] if unit else n
    return _trunc(str(s))


def split_messages(values: dict):
    """{name: value} -> JSON payloads of at most MAX_MSG bytes each."""
    out, cur = [], {}
    for k, v in values.items():
        trial = dict(cur, **{k: v})
        if cur and len(json.dumps(trial, separators=(",", ":"), ensure_ascii=False).encode()) > MAX_MSG:
            out.append(cur)
            cur = {k: v}
        else:
            cur = trial
    if cur:
        out.append(cur)
    return [json.dumps(m, separators=(",", ":"), ensure_ascii=False).encode() for m in out]


class Bindings:
    def __init__(self, data_dir, mgr, ha):
        self.path = data_dir / "bindings.json"
        self.mgr, self.ha = mgr, ha
        self.lock = threading.RLock()
        self.data = {"displays": {}}
        if self.path.is_file():
            try:
                self.data = json.loads(self.path.read_text(encoding="utf-8"))
            except ValueError:
                log.warning("bindings.json is unreadable; starting empty")
        self.sent = {}       # display id -> {name: last value sent}
        self.pending = {}    # display id -> {name: value} waiting to go out
        self.hist = {}       # (entity, attr, hours, points) -> (fetched_at, list)
        self._stop = threading.Event()
        self.resend_every = 600          # s: keep values fresh on the display even when nothing changes
        self._full_at = {}               # display id -> time of the last full resend

    # ------------------------------------------------------------------ store
    def _save(self):
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data, indent=1), encoding="utf-8")
        os.replace(tmp, self.path)

    def screens(self, dev_id):
        return self.data["displays"].get(dev_id, {}).get("screens", {})

    def active(self, dev_id):
        """{value name: spec} for everything the display's screens use."""
        out = {}
        for b in self.screens(dev_id).values():
            out.update(b)
        return out

    def activate(self, dev_id, screen, bindings: dict):
        clean = {}
        for name, spec in (bindings or {}).items():
            if not isinstance(spec, dict) or not spec.get("entity"):
                continue
            s = {"entity": str(spec["entity"]), "kind": spec.get("kind", "state")}
            if s["kind"] == "attr":
                s["attr"] = str(spec.get("attr", ""))
            if s["kind"] == "history":
                s["hours"], s["points"] = float(spec.get("hours", 24)), int(spec.get("points", 32))
                if spec.get("attr"):
                    s["attr"] = str(spec["attr"])
            clean[name] = s
        with self.lock:
            before = set(self.active(dev_id))
            self.data["displays"].setdefault(dev_id, {"screens": {}})["screens"][screen] = clean
            self._save()
            self._drop_unused(dev_id, before)
        self.refresh(dev_id, force=True)

    def deactivate(self, dev_id, screen):
        with self.lock:
            before = set(self.active(dev_id))
            self.data["displays"].get(dev_id, {}).get("screens", {}).pop(screen, None)
            self._save()
            self._drop_unused(dev_id, before)

    def forget_display(self, dev_id):
        with self.lock:
            self.data["displays"].pop(dev_id, None)
            self._save()
            self.sent.pop(dev_id, None)
            self.pending.pop(dev_id, None)

    def _drop_unused(self, dev_id, before):
        gone = before - set(self.active(dev_id))
        if gone:   # null deletes the value on the display
            p = self.pending.setdefault(dev_id, {})
            for n in gone:
                p[n] = None
                self.sent.get(dev_id, {}).pop(n, None)

    # ------------------------------------------------------------------ values
    def _history(self, spec, max_age):
        key = (spec["entity"], spec.get("attr"), spec.get("hours", 24), spec.get("points", 32))
        hit = self.hist.get(key)
        if hit and time.time() - hit[0] < max_age:
            return hit[1]
        try:
            vals = self.ha.history(spec["entity"], spec.get("hours", 24), spec.get("points", 32), spec.get("attr"))
        except Exception as e:  # noqa: BLE001
            log.debug("history %s: %s", spec["entity"], e)
            return hit[1] if hit else None
        self.hist[key] = (time.time(), vals)
        return vals

    @staticmethod
    def _hist_period(spec):
        return max(60.0, float(spec.get("hours", 24)) * 3600 / max(2, int(spec.get("points", 32))))

    def compute(self, spec, fresh_history=False):
        if spec.get("kind") == "history":
            return value_of(spec, None, self._history(spec, 0 if fresh_history else self._hist_period(spec)))
        return value_of(spec, self.ha.states.get(spec["entity"]))

    def preview(self, bindings: dict):
        """{name: spec} -> {name: value} now (the editor's Live preview)."""
        return {n: self.compute(s) for n, s in bindings.items() if isinstance(s, dict) and s.get("entity")}

    def refresh(self, dev_id, force=False, only=None):
        """Recompute the display's values; queue the ones that changed (or all of them with force)."""
        if not self.ha.connected:
            return
        with self.lock:
            sent, p = self.sent.setdefault(dev_id, {}), self.pending.setdefault(dev_id, {})
            for name, spec in self.active(dev_id).items():
                if only is not None and not only(spec):
                    continue
                v = self.compute(spec)
                if force or sent.get(name, UNSET) != v:
                    p[name] = v

    def resend_all(self, dev_id):
        with self.lock:
            self.sent[dev_id] = {}
            self._full_at[dev_id] = time.time()
        self.refresh(dev_id, force=True)

    # ------------------------------------------------------------------ wiring
    def start(self):
        self.ha.listeners.append(self._on_state)
        self.ha.on_connect.append(lambda: [self.resend_all(d) for d in list(self.data["displays"])])
        threading.Thread(target=self._flush_loop, name="values", daemon=True).start()
        threading.Thread(target=self._history_loop, name="history", daemon=True).start()

    def stop(self):
        self._stop.set()

    def _on_state(self, entity_id, _st):
        for dev_id in list(self.data["displays"]):
            self.refresh(dev_id, only=lambda s: s["entity"] == entity_id and s.get("kind") != "history")

    def _history_loop(self):
        tick = min(30.0, self.resend_every / 2)
        while not self._stop.wait(tick):
            for dev_id in list(self.data["displays"]):
                if self.active(dev_id) and time.time() - self._full_at.get(dev_id, 0) >= self.resend_every:
                    self.resend_all(dev_id)
                else:
                    self.refresh(dev_id, only=lambda s: s.get("kind") == "history")

    def _flush_loop(self):
        while not self._stop.wait(1.0):
            for dev_id in list(self.pending):
                d = self.mgr.displays.get(dev_id)
                if not d or not d.online:
                    continue
                with self.lock:
                    p = self.pending.get(dev_id)
                    if not p:
                        continue
                    msgs = split_messages(p)
                    first = json.loads(msgs[0])
                    for k in first:
                        p.pop(k, None)
                    sent = self.sent.setdefault(dev_id, {})
                    for k, v in first.items():
                        if v is None:
                            sent.pop(k, None)
                        else:
                            sent[k] = v
                d.command("values", msgs[0])
