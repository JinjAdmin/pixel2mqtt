"""Value bindings for info screens: Home Assistant entities -> named values on the displays.

data/bindings.json: {"displays": {<display id>: {"screens": {<screen name>: {<value name>: spec}},
                                                 "groups": {<screen name>: group},
                                                 "controls": {<screen name>: {"scr": text, "list": [control]}}}}}
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

from . import controls as ctl

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


# ------------------------------------------------------------------ weather forecasts
PERIODS = ("now", "today", "tonight", "d1", "d2", "d3")
FIELDS = ("temp", "high", "low", "condition", "day")


def _day_name(iso):
    import datetime
    try:
        return datetime.datetime.fromisoformat(str(iso).replace("Z", "+00:00")).strftime("%a").upper()
    except ValueError:
        return None


def forecast_value(fc, st, period, field):
    """One value from a weather entity's forecasts (see HomeAssistant.forecasts), like the old template package:
    - now: the current hour of the hourly forecast (temp, condition); without one, the entity's own reading;
    - twice_daily (NWS): today = the first period if it's daytime (late in the day: no high), tonight = the first
      night, day N = the Nth daytime period after today, and its low the night after it;
    - daily (Met and others): today = the first day, day N = the Nth after it, lows from templow.
    Temperatures come as [value, unit] (unit from temperature_unit)."""
    fc = fc or {}
    unit = fc.get("unit") or ((st or {}).get("a") or {}).get("temperature_unit") or ""

    def temp(p, key="temperature"):
        v = (p or {}).get(key)
        return None if v is None else ([v, unit] if unit else v)

    if period == "now":
        h = (fc.get("hourly") or [None])[0]
        a = (st or {}).get("a") or {}
        if field in ("temp", "high", "low"):
            return temp(h) if h else (temp(a) if a.get("temperature") is not None else None)
        if field == "condition":
            return (h or {}).get("condition") or (st or {}).get("s")
        if field == "day":
            return _day_name((h or {}).get("datetime")) if h else None
        return None
    td, dl = fc.get("twice_daily"), fc.get("daily")
    if td:
        days, nights = [p for p in td if p.get("is_daytime")], [p for p in td if not p.get("is_daytime")]
        first_day = td[0] if td[0].get("is_daytime") else None
        later_days = [p for p in (td[1:] if first_day else td) if p.get("is_daytime")]
        if period == "today":
            if field in ("temp", "high"):
                return temp(first_day)
            if field == "low":
                return temp(nights[0]) if nights else None
            if field == "condition":
                return ((days or td)[0]).get("condition")
            if field == "day":
                return _day_name(td[0].get("datetime"))
        elif period == "tonight":
            n = nights[0] if nights else None
            if field in ("temp", "low"):
                return temp(n)
            if field == "high":
                return None
            if field == "condition":
                return (n or {}).get("condition")
            if field == "day":
                return _day_name((n or {}).get("datetime"))
        else:
            k = int(period[1:])
            d = later_days[k - 1] if len(later_days) >= k else None
            if field in ("temp", "high"):
                return temp(d)
            if field == "low":
                return temp(nights[k]) if len(nights) > k else None
            if field == "condition":
                return (d or {}).get("condition")
            if field == "day":
                return _day_name((d or {}).get("datetime"))
        return None
    if dl:
        k = 0 if period in ("today", "tonight") else int(period[1:])
        d = dl[k] if len(dl) > k else None
        if field == "temp":
            return temp(d, "templow") if period == "tonight" else temp(d)
        if field == "high":
            return None if period == "tonight" else temp(d)
        if field == "low":
            return temp(d, "templow")
        if field == "condition":
            return (d or {}).get("condition")
        if field == "day":
            return _day_name((d or {}).get("datetime"))
    return None


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
            if kind == "forecast":
                if spec.get("entity") and spec.get("period") in PERIODS and spec.get("field") in FIELDS:
                    clean[name] = {"kind": "forecast", "entity": str(spec["entity"]), "period": spec["period"], "field": spec["field"]}
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

    def activate(self, dev_id, screen, bindings: dict, group=None, controls=None, scr=None):
        clean = self._clean_bindings(bindings)
        cl = ctl.clean_controls(controls)
        with self.lock:
            before = set(self.active(dev_id))
            d = self.data["displays"].setdefault(dev_id, {"screens": {}})
            d.setdefault("screens", {})[screen] = clean
            g = clean_group(group, d.get("groups", {}).get(screen))
            if g:
                d.setdefault("groups", {})[screen] = g
            else:
                d.get("groups", {}).pop(screen, None)
            cl = [c for c in cl if not c["param"].startswith("value.") or self._is_history(clean.get(c["param"][6:-6], {}))]
            if cl:
                d.setdefault("controls", {})[screen] = {"scr": scr or "", "list": cl}
            else:
                d.get("controls", {}).pop(screen, None)
            self._save()
            self._drop_unused(dev_id, before)
        self.publish_groups(dev_id)   # also clears entities the screen no longer has
        self.refresh(dev_id, force=True)

    def deactivate(self, dev_id, screen):
        self._unpublish(dev_id, screen)
        with self.lock:
            before = set(self.active(dev_id))
            d = self._disp(dev_id)
            d.get("screens", {}).pop(screen, None)
            d.get("groups", {}).pop(screen, None)
            d.get("controls", {}).pop(screen, None)
            self._save()
            self._drop_unused(dev_id, before)

    def rename_screen(self, dev_id, old, new):
        with self.lock:
            d = self._disp(dev_id)
            if old not in d.get("screens", {}):
                return
        self._unpublish(dev_id, old)
        with self.lock:
            d["screens"][new] = d["screens"].pop(old)
            for k in ("groups", "controls"):
                v = d.get(k, {}).pop(old, None)
                if v:
                    d[k][new] = v
            self._save()
        self.publish_groups(dev_id)

    def forget_display(self, dev_id):
        for screen in list(self.screens(dev_id)):
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

    # ------------------------------------------------------------------ HA controls (screen settings as HA entities)
    def controls(self, dev_id, screen=None):
        c = self._disp(dev_id).get("controls", {})
        return c if screen is None else c.get(screen, {}).get("list", [])

    @staticmethod
    def _is_history(spec):
        return spec.get("kind") == "history" or (spec.get("kind") == "group" and spec.get("source") == "history")

    def control_value(self, dev_id, screen, c):
        if c["param"].startswith("value."):
            spec = self.screens(dev_id).get(screen, {}).get(c["param"][6:-6], {})
            return spec.get("hours")
        return c.get("value")

    def set_control(self, dev_id, screen, param, raw, upload=True):
        """A command from HA (or the API): validate, store, apply right away, publish the new state."""
        with self.lock:
            entry = self._disp(dev_id).get("controls", {}).get(screen)
            c = next((c for c in (entry or {}).get("list", []) if c["param"] == param), None)
            v = ctl.coerce(c, raw) if c else None
            if v is None:
                log.info("%s: ignored %s = %r", screen, param, raw)
                return False
            if param.startswith("value."):
                spec = self.screens(dev_id).get(screen, {}).get(param[6:-6])
                if not spec or not self._is_history(spec):
                    return False
                spec["hours"] = v
            else:
                c["value"] = v
                entry["scr"] = ctl.patch_scr(entry["scr"], c, v)
                scr = entry["scr"]
            self._save()
        self._publish_state(dev_id, screen)
        if param.startswith("value."):
            name = param[6:-6]
            self.refresh(dev_id, force=True, screens={screen}, only=lambda s, e: s is self.screens(dev_id)[screen].get(name))
        elif upload:
            d = self.mgr.displays.get(dev_id)
            if d is not None and scr.startswith("PXS1"):
                threading.Thread(target=self._upload, args=(d, screen, scr), daemon=True).start()
        return True

    @staticmethod
    def _upload(d, screen, scr):
        try:
            d.api.put_file("screens", screen + ".scr", scr.encode("utf-8"))
        except Exception as e:  # noqa: BLE001
            log.warning("%s: could not send %s: %s", d.name if hasattr(d, "name") else d.id, screen, e)

    def _entities(self, d, screen):
        """Every HA entity of a screen: [(config topic, config, state topic, state, command topic)].
        A group's member select and rotate number are built-in controls; they keep their original ids and topics."""
        out, did = [], d.id
        dev = {"ids": d.dev_ids}
        avty = {"avty": [{"t": self.mgr.bridge_state_topic}, {"t": d.topic + "/status"}], "avty_mode": "all"}
        g = self.groups(did).get(screen)
        if g:
            t = self._topics(d, screen)
            labels = self.option_labels(self.members(did, screen))
            sel = g.get("selected", ROTATE)
            cur = ROTATE_LABEL if sel == ROTATE else next((lab for lab, eid in labels if eid == sel), ROTATE_LABEL)
            out.append((t["select_cfg"], dict({"name": g["name"], "uniq_id": f"{d.uid}_grp_{slug(screen)}", "cmd_t": t["select_cmd"], "stat_t": t["select_state"],
                                               "ops": [ROTATE_LABEL] + [lab for lab, _ in labels], "icon": "mdi:format-list-bulleted", "dev": dev}, **avty),
                        t["select_state"], cur, t["select_cmd"]))
            out.append((t["number_cfg"], dict({"name": f"{g['name']} rotate seconds", "uniq_id": f"{d.uid}_grp_{slug(screen)}_rotate", "cmd_t": t["rotate_cmd"],
                                               "stat_t": t["rotate_state"], "min": 2, "max": 600, "step": 1, "unit_of_meas": "s", "mode": "box",
                                               "icon": "mdi:timer-sync-outline", "ent_cat": "config", "dev": dev}, **avty),
                        t["rotate_state"], str(g["rotate"]), t["rotate_cmd"]))
        for c in self.controls(did, screen):
            ps = slug(c["param"])
            base = f"{d.topic}/control/{slug(screen)}/{ps}"
            cfg = dict({"name": c["name"], "uniq_id": f"{d.uid}_scr_{slug(screen)}_{ps}", "cmd_t": base + "/set", "stat_t": base + "/state", "dev": dev}, **avty)
            if c["type"] == "number":
                cfg.update(min=c["min"], max=c["max"], step=c["step"], mode="box")
                if c.get("unit"):
                    cfg["unit_of_meas"] = c["unit"]
            elif c["type"] == "select":
                cfg["ops"] = c["options"]
            elif c["type"] == "text":
                cfg["max"] = 63
            out.append((f"{self.mgr.disc_prefix}/{c['type']}/{d.uid}/scr_{slug(screen)}_{ps}/config", cfg,
                        base + "/state", ctl.state_text(c, self.control_value(did, screen, c)), base + "/set"))
        return out

    def on_control(self, d, topic):
        """<display topic>/control/<screen slug>/<param slug>/set -> (screen, param) if it's ours."""
        parts = topic[len(d.topic) + 1:].split("/")
        if len(parts) != 4 or parts[0] != "control" or parts[3] != "set":
            return None
        for screen, entry in self.controls(d.id).items():
            if slug(screen) == parts[1]:
                for c in entry.get("list", []):
                    if slug(c["param"]) == parts[2]:
                        return screen, c["param"]
        return None

    # ------------------------------------------------------------------ Home Assistant discovery
    def _topics(self, d, screen):
        base = f"{d.topic}/group/{slug(screen)}"
        return {"select_cmd": base + "/select", "select_state": base + "/selected",
                "rotate_cmd": base + "/rotate", "rotate_state": base + "/rotate_state",
                "select_cfg": f"{self.mgr.disc_prefix}/select/{d.uid}/grp_{slug(screen)}/config",
                "number_cfg": f"{self.mgr.disc_prefix}/number/{d.uid}/grp_{slug(screen)}_rotate/config"}

    def publish_groups(self, dev_id=None):
        """Discovery + state for every screen's HA entities (group built-ins and controls); clears ones that are gone."""
        m = getattr(self.mgr, "mqtt", None)
        if not m or not getattr(m, "connected", False):
            return
        for did in ([dev_id] if dev_id else list(self.data["displays"])):
            d = self.mgr.displays.get(did)
            if not d or not getattr(d, "dev_ids", None):
                continue
            screens = set(self.groups(did)) | set(self.controls(did)) | {s for (x, s) in self._disc if x == did}
            for screen in screens:
                ents = self._entities(d, screen) if screen in self.screens(did) else []
                now = {cfg_t: (json.dumps(cfg), st_t) for cfg_t, cfg, st_t, _, _ in ents}
                old = self._disc.get((did, screen), {})
                for cfg_t, (payload, _) in now.items():
                    if old.get(cfg_t, (None,))[0] != payload:
                        m.publish(cfg_t, payload, retain=True)
                for cfg_t, (_, st_t) in old.items():
                    if cfg_t not in now:
                        m.publish(cfg_t, "", retain=True)
                        m.publish(st_t, "", retain=True)
                if now:
                    self._disc[(did, screen)] = now
                else:
                    self._disc.pop((did, screen), None)
                for _, _, st_t, state, _ in ents:
                    m.publish(st_t, state, retain=True)

    def _publish_state(self, dev_id, screen):
        m, d = getattr(self.mgr, "mqtt", None), self.mgr.displays.get(dev_id)
        if not m or not getattr(m, "connected", False) or not d or not getattr(d, "dev_ids", None):
            return
        for _, _, st_t, state, _ in self._entities(d, screen):
            m.publish(st_t, state, retain=True)

    def _unpublish(self, dev_id, screen):
        m, d = getattr(self.mgr, "mqtt", None), self.mgr.displays.get(dev_id)
        old = self._disc.pop((dev_id, screen), {})
        if not m or not getattr(m, "connected", False) or not d:
            return
        topics = {cfg_t: st_t for cfg_t, (_, st_t) in old.items()}
        if getattr(d, "dev_ids", None):
            topics.update({cfg_t: st_t for cfg_t, _, st_t, _, _ in self._entities(d, screen)})
        for cfg_t, st_t in topics.items():
            m.publish(cfg_t, "", retain=True)
            m.publish(st_t, "", retain=True)

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
        if spec.get("kind") == "forecast":
            eid = spec.get("entity", "")
            return forecast_value(self.ha.forecasts(eid), self.ha.states.get(eid), spec.get("period"), spec.get("field"))
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
            self.refresh(dev_id, only=lambda s, e: e == entity_id and s.get("kind") not in ("history", "const", "forecast") and s.get("source") != "history")

    def _history_loop(self):
        tick = min(30.0, self.resend_every / 2)
        while not self._stop.wait(tick):
            for dev_id in list(self.data["displays"]):
                if self.active(dev_id) and time.time() - self._full_at.get(dev_id, 0) >= self.resend_every:
                    self.resend_all(dev_id)
                else:
                    self.refresh(dev_id, only=lambda s, e: s.get("kind") in ("history", "forecast") or s.get("source") == "history")

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
