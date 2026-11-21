"""Value bindings for info screens: Home Assistant entities -> named values on the displays.

data/bindings.json: {"displays": {<display id>: {"screens": {<screen name>: {<value name>: spec}},
                                                 "groups": {<screen name>: group}}}}
spec:  {"entity": "sensor.x", "kind": "state" | "attr" | "history", "attr": "...", "hours": 24, "points": 32}
       {"kind": "const", "value": "BTC"}
       {"kind": "group", "source": "state" | "attr" | "history", "attr": "...", "hours", "points", "fmt": "..."}
group: {"name": "Market ticker", "by": "integration" | "label" | "device" | "domain" | "entities", "match": "easy_stock",
        "rotate": 8, "selected": "rotate" | <entity id>}

A screen with a group is a template: its "group" bindings read from the group's current member, which is the one
picked in Home Assistant's select for that screen, or every member in turn every `rotate` seconds ("Rotate").
Rotation runs whether or not the screen is showing, and a member's values always go out together in one message.

Values go to the display's `values` command (the same path as <topic>/values/set): flat JSON, at most 8 KB per
message, at most about one message per second per display. Everything is resent when a display (re)connects or
Home Assistant reconnects, and every 10 minutes (pixeld's fresh()/stale/needs mean "recently sent"). Sending a
screen activates its bindings; deleting it drops the ones nothing else uses.
"""
import json
import logging
import os
import re
import threading
import time

log = logging.getLogger("bindings")
MAX_MSG = 8192   # pixeld takes up to 16 KB per values message (HTTP and MQTT); stay well under
UNSET = object()
ROTATE = "rotate"
ROTATE_LABEL = "Rotate"


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
    if kind == "const":   # a fixed value (e.g. a ticker symbol)
        v = spec.get("value")
        n = _num(v) if isinstance(v, str) and v.strip() else None
        return n if n is not None else (_trunc(str(v)) if v not in (None, "") else None)
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


# display forms for group values (the editor offers these per mapping)
INDEXES = {"^GSPC": "S&P", "^DJI": "DOW", "^IXIC": "NASDAQ", "^NDX": "NDX", "^RUT": "RUSSELL", "^VIX": "VIX", "^FTSE": "FTSE",
           "^N225": "NIKKEI", "^GDAXI": "DAX"}
DOLLARS = {"USD", "CAD", "AUD", "NZD", "HKD", "SGD", "MXN"}


def transform(fmt, v, st):
    """short_symbol: ^GSPC -> S&P, BTC-USD -> BTC; price_prefix: "$" for dollar prices, none for indexes;
    is_crypto: 1 for crypto pairs (BTC-USD), else 0. Anything else returns v unchanged."""
    attrs = (st or {}).get("a") or {}
    if fmt == "short_symbol":
        s = str(v if v is not None else attrs.get("symbol", "")).strip()
        if s.upper() in INDEXES:
            return INDEXES[s.upper()]
        s = re.sub(r"(-(USD|USDT|USDC|EUR|GBP))$|=X$", "", s, flags=re.I).lstrip("^")
        return _trunc(s) or None
    if fmt == "price_prefix":
        if str(attrs.get("symbol", "")).startswith("^"):
            return ""
        cur = str(attrs.get("currency") or (v if isinstance(v, str) else "")).upper()
        return "$" if cur in DOLLARS else ""
    if fmt == "is_crypto":
        sym = str(v if isinstance(v, str) else attrs.get("symbol", "")).upper()
        return 1 if re.search(r"-(USD|USDT|USDC|EUR|GBP|BTC|ETH)$", sym) else 0
    return v


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


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_") or "screen"


def clean_group(g, old=None):
    if not isinstance(g, dict) or not str(g.get("match", "")).strip() or g.get("by") not in ("integration", "label", "device", "domain", "entities"):
        return None
    old = old or {}
    rot = g.get("rotate", old.get("rotate", 8))
    try:
        rot = max(2, min(600, int(float(rot))))
    except (TypeError, ValueError):
        rot = 8
    return {"name": str(g.get("name") or "Group")[:48], "by": g["by"], "match": str(g["match"]).strip()[:200], "rotate": rot,
            "selected": old.get("selected", g.get("selected", ROTATE)) or ROTATE}


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
        self.gidx, self.gnext = {}, {}   # (display, screen) -> rotation index / time of the next step
        self._disc = {}                  # (display, screen) -> last discovery payloads published

    # ------------------------------------------------------------------ store
    def _save(self):
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data, indent=1), encoding="utf-8")
        os.replace(tmp, self.path)

    def _disp(self, dev_id):
        return self.data["displays"].get(dev_id, {})

    def screens(self, dev_id):
        return self._disp(dev_id).get("screens", {})

    def groups(self, dev_id):
        return self._disp(dev_id).get("groups", {})

    def active(self, dev_id):
        """{value name: spec} for everything the display's screens use."""
        out = {}
        for b in self.screens(dev_id).values():
            out.update(b)
        return out

    @staticmethod
    def _clean_bindings(bindings):
        clean = {}
        for name, spec in (bindings or {}).items():
            if not isinstance(spec, dict):
                continue
            kind = spec.get("kind", "state")
            if kind == "const":
                clean[name] = {"kind": "const", "value": str(spec.get("value", ""))[:63]}
                continue
            if kind == "group":
                s = {"kind": "group", "source": spec.get("source", "state") if spec.get("source") in ("state", "attr", "history") else "state"}
                if spec.get("attr"):
                    s["attr"] = str(spec["attr"])
                if s["source"] == "history":
                    s["hours"], s["points"] = float(spec.get("hours", 24)), int(spec.get("points", 48))
                if spec.get("fmt") in ("short_symbol", "price_prefix", "is_crypto"):
                    s["fmt"] = spec["fmt"]
                clean[name] = s
                continue
            if not spec.get("entity"):
                continue
            s = {"entity": str(spec["entity"]), "kind": kind}
            if kind == "attr":
                s["attr"] = str(spec.get("attr", ""))
            if kind == "history":
                s["hours"], s["points"] = float(spec.get("hours", 24)), int(spec.get("points", 32))
                if spec.get("attr"):
                    s["attr"] = str(spec["attr"])
            clean[name] = s
        return clean

    def activate(self, dev_id, screen, bindings: dict, group=None):
        clean = self._clean_bindings(bindings)
        with self.lock:
            before = set(self.active(dev_id))
            d = self.data["displays"].setdefault(dev_id, {"screens": {}})
            d.setdefault("screens", {})[screen] = clean
            g = clean_group(group, d.get("groups", {}).get(screen))
            if g:
                d.setdefault("groups", {})[screen] = g
            else:
                d.get("groups", {}).pop(screen, None)
            self._save()
            self._drop_unused(dev_id, before)
        if not g:
            self._unpublish(dev_id, screen)
        self.publish_groups(dev_id)
        self.refresh(dev_id, force=True)

    def deactivate(self, dev_id, screen):
        with self.lock:
            before = set(self.active(dev_id))
            d = self._disp(dev_id)
            d.get("screens", {}).pop(screen, None)
            d.get("groups", {}).pop(screen, None)
            self._save()
            self._drop_unused(dev_id, before)
        self._unpublish(dev_id, screen)

    def forget_display(self, dev_id):
        for screen in list(self.groups(dev_id)):
            self._unpublish(dev_id, screen)
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

    # ------------------------------------------------------------------ groups
    def members(self, dev_id, screen):
        g = self.groups(dev_id).get(screen)
        return self.ha.members(g["by"], g["match"]) if g else []

    @staticmethod
    def option_labels(members):
        """Members -> unique option labels for HA's select: [(label, entity id)]."""
        out, seen = [], {}
        for m in members:
            base = (m["name"] or m["id"])[:60]
            n = seen.get(base.lower(), 0) + 1
            seen[base.lower()] = n
            out.append((base if n == 1 else f"{base} ({n})", m["id"]))
        return out

    def current(self, dev_id, screen, members=None):
        """The group member a screen shows now (entity id), or None."""
        g = self.groups(dev_id).get(screen)
        if not g:
            return None
        ms = members if members is not None else self.members(dev_id, screen)
        if not ms:
            return None
        sel = g.get("selected", ROTATE)
        if sel != ROTATE and any(m["id"] == sel for m in ms):
            return sel
        return ms[self.gidx.get((dev_id, screen), 0) % len(ms)]["id"]

    def select(self, dev_id, screen, option):
        """From HA's select (an option label) or the editor (an entity id or 'rotate')."""
        g = self.groups(dev_id).get(screen)
        if not g:
            return
        if option.strip().lower() == ROTATE:
            sel = ROTATE
        else:
            labels = self.option_labels(self.members(dev_id, screen))
            sel = next((eid for lab, eid in labels if lab == option or eid == option), None)
            if sel is None:
                log.info("%s: no group member %r", screen, option)
                return
        with self.lock:
            g["selected"] = sel
            self._save()
        self.gnext[(dev_id, screen)] = time.time() + g["rotate"]
        self._publish_state(dev_id, screen)
        self.refresh_screen(dev_id, screen)

    def set_rotate(self, dev_id, screen, secs):
        g = self.groups(dev_id).get(screen)
        if not g:
            return
        try:
            secs = max(2, min(600, int(float(secs))))
        except (TypeError, ValueError):
            return
        with self.lock:
            g["rotate"] = secs
            self._save()
        self.gnext[(dev_id, screen)] = time.time() + secs
        self._publish_state(dev_id, screen)

    def _rotate_tick(self):
        now = time.time()
        for dev_id in list(self.data["displays"]):
            for screen, g in list(self.groups(dev_id).items()):
                if g.get("selected", ROTATE) != ROTATE:
                    continue
                k = (dev_id, screen)
                if k not in self.gnext:
                    self.gnext[k] = now + g["rotate"]
                    continue
                if now >= self.gnext[k]:
                    self.gidx[k] = self.gidx.get(k, 0) + 1
                    self.gnext[k] = now + g["rotate"]
                    self.refresh_screen(dev_id, screen)

    # ------------------------------------------------------------------ Home Assistant discovery (select + number per group)
    def _topics(self, d, screen):
        base = f"{d.topic}/group/{slug(screen)}"
        return {"select_cmd": base + "/select", "select_state": base + "/selected",
                "rotate_cmd": base + "/rotate", "rotate_state": base + "/rotate_state",
                "select_cfg": f"{self.mgr.disc_prefix}/select/{d.uid}/grp_{slug(screen)}/config",
                "number_cfg": f"{self.mgr.disc_prefix}/number/{d.uid}/grp_{slug(screen)}_rotate/config"}

    def publish_groups(self, dev_id=None):
        m = getattr(self.mgr, "mqtt", None)
        if not m or not getattr(m, "connected", False):
            return
        for did in ([dev_id] if dev_id else list(self.data["displays"])):
            d = self.mgr.displays.get(did)
            if not d or not getattr(d, "dev_ids", None):
                continue
            for screen, g in list(self.groups(did).items()):
                t = self._topics(d, screen)
                opts = [ROTATE_LABEL] + [lab for lab, _ in self.option_labels(self.members(did, screen))]
                dev = {"ids": d.dev_ids}
                avty = {"avty": [{"t": self.mgr.bridge_state_topic}, {"t": d.topic + "/status"}], "avty_mode": "all"}
                sel = dict({"name": g["name"], "uniq_id": f"{d.uid}_grp_{slug(screen)}", "cmd_t": t["select_cmd"], "stat_t": t["select_state"],
                            "ops": opts, "icon": "mdi:format-list-bulleted", "dev": dev}, **avty)
                num = dict({"name": f"{g['name']} rotate seconds", "uniq_id": f"{d.uid}_grp_{slug(screen)}_rotate", "cmd_t": t["rotate_cmd"],
                            "stat_t": t["rotate_state"], "min": 2, "max": 600, "step": 1, "unit_of_meas": "s", "mode": "box",
                            "icon": "mdi:timer-sync-outline", "ent_cat": "config", "dev": dev}, **avty)
                payloads = (json.dumps(sel), json.dumps(num))
                if self._disc.get((did, screen)) != payloads:
                    m.publish(t["select_cfg"], payloads[0], retain=True)
                    m.publish(t["number_cfg"], payloads[1], retain=True)
                    self._disc[(did, screen)] = payloads
                self._publish_state(did, screen)

    def _publish_state(self, dev_id, screen):
        m, d, g = getattr(self.mgr, "mqtt", None), self.mgr.displays.get(dev_id), self.groups(dev_id).get(screen)
        if not m or not getattr(m, "connected", False) or not d or not g:
            return
        t = self._topics(d, screen)
        sel = g.get("selected", ROTATE)
        label = ROTATE_LABEL if sel == ROTATE else next((lab for lab, eid in self.option_labels(self.members(dev_id, screen)) if eid == sel), ROTATE_LABEL)
        m.publish(t["select_state"], label, retain=True)
        m.publish(t["rotate_state"], str(g["rotate"]), retain=True)

    def _unpublish(self, dev_id, screen):
        m, d = getattr(self.mgr, "mqtt", None), self.mgr.displays.get(dev_id)
        self._disc.pop((dev_id, screen), None)
        if m and getattr(m, "connected", False) and d:
            t = self._topics(d, screen)
            for k in ("select_cfg", "number_cfg", "select_state", "rotate_state"):
                m.publish(t[k], "", retain=True)

    def on_command(self, d, topic):
        """<display topic>/group/<slug>/select|rotate -> (screen, kind) if it's ours, else None."""
        rest = topic[len(d.topic) + 1:]
        parts = rest.split("/")
        if len(parts) != 3 or parts[0] != "group" or parts[2] not in ("select", "rotate"):
            return None
        screen = next((s for s in self.groups(d.id) if slug(s) == parts[1]), None)
        return (screen, parts[2]) if screen else None

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

    def compute(self, spec, fresh_history=False, entity=None):
        """A binding's value now. entity: the group member for "group" bindings."""
        if spec.get("kind") == "group":
            if not entity:
                return None
            src = dict(spec, kind=spec.get("source", "state"), entity=entity)
            v = self.compute(src, fresh_history)
            if spec.get("fmt") == "short_symbol" and src["kind"] == "state" and isinstance(v, list):
                v = v[0]
            return transform(spec.get("fmt"), v, self.ha.states.get(entity)) if spec.get("fmt") else v
        if spec.get("kind") == "history":
            return value_of(spec, None, self._history(spec, 0 if fresh_history else self._hist_period(spec)))
        return value_of(spec, self.ha.states.get(spec.get("entity", "")))

    def preview(self, bindings: dict, member=None):
        """{name: spec} -> {name: value} now (the editor's Live preview). member: the group member to preview."""
        out = {}
        for n, s in bindings.items():
            if not isinstance(s, dict):
                continue
            if s.get("kind") == "group":
                out[n] = self.compute(s, entity=member)
            elif s.get("entity") or s.get("kind") == "const":
                out[n] = self.compute(s)
        return out

    @staticmethod
    def _needs_ha(spec):
        return spec.get("kind") != "const"

    def refresh(self, dev_id, force=False, only=None, screens=None):
        """Recompute the display's values; queue the ones that changed (or all of them with force).
        only(spec, entity) filters bindings; screens limits it to some screens."""
        if not self.ha.connected and any(self._needs_ha(s) for s in self.active(dev_id).values()):
            return   # without HA only fixed values can be computed; wait (an HA reconnect resends everything)
        with self.lock:
            sent, p = self.sent.setdefault(dev_id, {}), self.pending.setdefault(dev_id, {})
            for screen, b in list(self.screens(dev_id).items()):
                if screens is not None and screen not in screens:
                    continue
                member = self.current(dev_id, screen) if screen in self.groups(dev_id) else None
                for name, spec in b.items():
                    ent = member if spec.get("kind") == "group" else spec.get("entity")
                    if only is not None and not only(spec, ent):
                        continue
                    v = self.compute(spec, entity=ent)
                    if force or sent.get(name, UNSET) != v:
                        p[name] = v

    def refresh_screen(self, dev_id, screen):
        """A group's member changed: send all of that screen's group values together."""
        self.refresh(dev_id, force=True, screens={screen}, only=lambda s, e: s.get("kind") == "group")

    def resend_all(self, dev_id):
        with self.lock:
            self.sent[dev_id] = {}
            self._full_at[dev_id] = time.time()
        self.refresh(dev_id, force=True)

    # ------------------------------------------------------------------ wiring
    def start(self):
        self.ha.listeners.append(self._on_state)
        self.ha.on_connect.append(lambda: [self.resend_all(d) for d in list(self.data["displays"])])
        if not hasattr(self.ha, "on_registry"):
            self.ha.on_registry = []
        self.ha.on_registry.append(self.publish_groups)
        threading.Thread(target=self._flush_loop, name="values", daemon=True).start()
        threading.Thread(target=self._history_loop, name="history", daemon=True).start()

    def stop(self):
        self._stop.set()

    def _on_state(self, entity_id, _st):
        for dev_id in list(self.data["displays"]):
            self.refresh(dev_id, only=lambda s, e: e == entity_id and s.get("kind") not in ("history", "const") and s.get("source") != "history")

    def _history_loop(self):
        tick = min(30.0, self.resend_every / 2)
        while not self._stop.wait(tick):
            for dev_id in list(self.data["displays"]):
                if self.active(dev_id) and time.time() - self._full_at.get(dev_id, 0) >= self.resend_every:
                    self.resend_all(dev_id)
                else:
                    self.refresh(dev_id, only=lambda s, e: s.get("kind") == "history" or s.get("source") == "history")

    def _flush_loop(self):
        while not self._stop.wait(1.0):
            try:
                self._rotate_tick()
            except Exception:  # noqa: BLE001
                log.exception("group rotation failed")
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
