"""Device registry and the MQTT <-> pixeld bridge.

For every adopted display a worker thread mirrors what pixeld would publish itself (GET /api/discovery,
then long-polls /api/events) onto MQTT, rewriting topics and unique ids to that display's settings, and
forwards <topic>/<name>/set commands to POST /api/cmd/<name>.
"""
import json
import logging
import queue
import re
import threading
import time

from .device import APIError, PixelAPI
from .mqtt import topic_matches

log = logging.getLogger("bridge")

DEVICE_BASE, DEVICE_DISC, DEVICE_UID = "govee-pixel", "homeassistant", "govee_pixel"  # what pixeld publishes


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_") or "display"


class Display:
    """One adopted display: settings + live status + worker threads."""

    def __init__(self, mgr, cfg: dict):
        self.mgr, self.cfg = mgr, cfg
        self.api = PixelAPI(cfg["host"], cfg.get("token", ""))
        self.online = False
        self.error = ""
        self.state = {}          # rewritten topic suffix -> last payload (e.g. "animation/state")
        self.seq = 0
        self.storage = None
        self.dev_ids = None     # the display's device identifiers in HA discovery (for entities pixel2mqtt adds)
        self._stop = threading.Event()
        self._cmds = queue.Queue()
        self._need_disc = threading.Event()
        self._threads = []

    # settings
    id = property(lambda s: s.cfg["id"])
    name = property(lambda s: s.cfg.get("name") or "Pixel display")
    topic = property(lambda s: s.cfg["topic"].rstrip("/"))
    uid = property(lambda s: s.cfg["uid"])

    def public(self):
        return {"id": self.id, "name": self.name, "host": self.cfg["host"], "topic": self.topic, "uid": self.uid,
                "online": self.online, "error": self.error, "storage": self.storage,
                "state": {k[:-6]: v for k, v in self.state.items() if k.endswith("/state")}}

    def start(self):
        for target, name in ((self._run, "events"), (self._run_cmds, "cmds")):
            t = threading.Thread(target=target, name=f"{name}-{self.id}", daemon=True)
            t.start()
            self._threads.append(t)

    def stop(self):
        self._stop.set()
        self._cmds.put(None)

    def refresh_discovery(self):
        self._need_disc.set()

    # ------------------------------------------------------------------ rewriting
    def map_topic(self, t: str):
        if t == DEVICE_BASE + "/status":
            return None  # availability is ours
        if t.startswith(DEVICE_BASE + "/"):
            return self.topic + t[len(DEVICE_BASE):]
        if t.startswith(DEVICE_DISC + "/"):
            rest = t[len(DEVICE_DISC) + 1:].replace(DEVICE_UID, self.uid)
            return self.mgr.disc_prefix + "/" + rest
        return None

    def map_payload(self, obj):
        def walk(v):
            if isinstance(v, str):
                if v.startswith(DEVICE_BASE + "/"):
                    return self.topic + v[len(DEVICE_BASE):]
                if v.startswith(DEVICE_UID):
                    return self.uid + v[len(DEVICE_UID):]
                return v
            if isinstance(v, list):
                return [walk(x) for x in v]
            if isinstance(v, dict):
                return {k: walk(x) for k, x in v.items()}
            return v
        obj = walk(obj)
        dev = obj.get("dev") or obj.get("device")
        if isinstance(dev, dict) and "name" in dev:
            dev["name"] = self.name
            dev["via_device"] = "pixel2mqtt_bridge"
        if "avty_t" in obj or "availability_topic" in obj:
            obj.pop("avty_t", None); obj.pop("availability_topic", None)
            obj["avty"] = [{"t": self.mgr.bridge_state_topic}, {"t": self.topic + "/status"}]
            obj["avty_mode"] = "all"
        return obj

    def forward(self, msgs):
        m = self.mgr.mqtt
        for msg in msgs:
            t = self.map_topic(msg["t"])
            if not t:
                continue
            p = msg["p"]
            if t.startswith(self.mgr.disc_prefix + "/") and p.startswith("{"):
                try:
                    obj = self.map_payload(json.loads(p))
                    p = json.dumps(obj, separators=(",", ":"))
                    dev = obj.get("dev") or obj.get("device") or {}
                    ids = dev.get("ids") or dev.get("identifiers") if isinstance(dev, dict) else None
                    if ids and ids != self.dev_ids:
                        self.dev_ids = ids if isinstance(ids, list) else [ids]
                        if self.mgr.bindings:
                            self.mgr.bindings.publish_groups(self.id)
                except ValueError:
                    pass
            if t.startswith(self.topic + "/"):
                self.state[t[len(self.topic) + 1:]] = p
            if m:
                m.publish(t, p, retain=bool(msg.get("r")))

    def set_online(self, on: bool, error=""):
        self.error = error
        if on != self.online:
            log.info("%s (%s) is %s%s", self.name, self.cfg["host"], "online" if on else "offline", f": {error}" if error else "")
        self.online = on
        if self.mgr.mqtt:
            self.mgr.mqtt.publish(self.topic + "/status", "online" if on else "offline", retain=True)

    # ------------------------------------------------------------------ workers
    def _run(self):
        backoff = 2
        while not self._stop.is_set():
            try:
                d = self.api.discovery(self.mgr.owns_mqtt())
                self.seq = d["seq"]
                self.forward(d["msgs"])
                self.set_online(True)
                self._need_disc.clear()
                self.mgr.display_ready(self)   # (re)connected or rebooted: its RAM-only screen values need resending
                try:
                    self.storage = self.api.storage()
                except (OSError, APIError):
                    pass
                backoff = 2
                while not self._stop.is_set() and not self._need_disc.is_set():
                    ev = self.api.events(self.seq, 25, self.mgr.owns_mqtt())
                    if ev.get("reset"):
                        log.info("%s: event stream reset, re-reading discovery", self.name)
                        break
                    self.seq = ev["seq"]
                    self.forward(ev["msgs"])
            except APIError as e:
                if e.status == 401:
                    self.set_online(False, "token rejected: adopt this display again")
                    self._stop.wait(60)
                else:
                    self.set_online(False, str(e))
                    self._stop.wait(backoff)
            except (OSError, ValueError, KeyError) as e:
                self.set_online(False, str(e) or e.__class__.__name__)
                self._stop.wait(backoff)
                backoff = min(backoff * 2, 30)

    def _run_cmds(self):
        while not self._stop.is_set():
            item = self._cmds.get()
            if item is None:
                return
            name, payload = item
            try:
                self.api.cmd(name, payload)
            except (OSError, APIError) as e:
                log.warning("%s: command %s failed: %s", self.name, name, e)

    def command(self, name: str, payload: bytes):
        self._cmds.put((name, payload))


class Manager:
    def __init__(self, config, store):
        self.config, self.store = config, store
        self.mqtt = None
        self.base = config.base.rstrip("/")
        self.disc_prefix = config.discovery_prefix
        self.bridge_state_topic = self.base + "/bridge/state"
        self.displays = {}
        self.found = {}        # ip -> info from the last scan
        self.bindings = None   # screen value bindings (set by __main__)
        self.lock = threading.Lock()

    def display_ready(self, d):
        if self.bindings:
            self.bindings.resend_all(d.id)

    def owns_mqtt(self):
        return bool(self.mqtt and self.mqtt.connected)

    # ------------------------------------------------------------------ lifecycle
    def start(self, mqtt):
        self.mqtt = mqtt
        if mqtt:
            mqtt.on_connect = self._on_connect
            mqtt.on_message = self._on_message
            mqtt.subscribe(self.disc_prefix + "/status")
        for cfg in self.store.devices():
            self._add(cfg)

    def _add(self, cfg):
        d = Display(self, cfg)
        self.displays[d.id] = d
        if self.mqtt:
            self.mqtt.subscribe(d.topic + "/+/set")
            self.mqtt.subscribe(d.topic + "/status")   # to undo a stray "offline" (see _on_message)
            self.mqtt.subscribe(d.topic + "/group/+/select")   # screen groups (template screens): HA select / number
            self.mqtt.subscribe(d.topic + "/group/+/rotate")
        d.start()
        return d

    def _on_connect(self):
        self.mqtt.publish(self.bridge_state_topic, "online", retain=True)
        self._publish_bridge_device()
        for d in self.displays.values():
            d.refresh_discovery()
            self.mqtt.publish(d.topic + "/status", "online" if d.online else "offline", retain=True)
        if self.bindings:
            self.bindings._disc.clear()
            self.bindings.publish_groups()

    def _publish_bridge_device(self):
        cfg = {"name": "Bridge state", "uniq_id": "pixel2mqtt_bridge_state", "stat_t": self.bridge_state_topic,
               "dev_cla": "connectivity", "pl_on": "online", "pl_off": "offline", "ent_cat": "diagnostic",
               "dev": {"ids": ["pixel2mqtt_bridge"], "name": "pixel2mqtt", "mf": "pixel2mqtt", "mdl": "Bridge"}}
        self.mqtt.publish(f"{self.disc_prefix}/binary_sensor/pixel2mqtt_bridge/state/config", json.dumps(cfg), retain=True)

    def _on_message(self, topic, payload, retained):
        if topic == self.disc_prefix + "/status":
            if payload == b"online":
                self._publish_bridge_device()
                for d in self.displays.values():
                    d.refresh_discovery()
                if self.bindings:
                    self.bindings._disc.clear()
                    self.bindings.publish_groups()
            return
        for d in list(self.displays.values()):
            if topic == d.topic + "/status":
                # Availability is ours. Something else can still write "offline" here, e.g. the display's own MQTT
                # will when it hands its direct connection over to us. Put it right while the display is reachable.
                if payload != b"online" and d.online:
                    log.info("%s: status was set to %r by someone else; republishing online", d.name, payload)
                    self.mqtt.publish(d.topic + "/status", "online", retain=True)
                return
            if self.bindings and topic.startswith(d.topic + "/group/"):
                hit = self.bindings.on_command(d, topic)
                if hit:
                    screen, what = hit
                    text = payload.decode("utf-8", "replace").strip()
                    if what == "select":
                        self.bindings.select(d.id, screen, text)
                    else:
                        self.bindings.set_rotate(d.id, screen, text)
                return
            if topic_matches(d.topic + "/+/set", topic):
                d.command(topic[len(d.topic) + 1:-4], payload)
                return

    def shutdown(self):
        for d in self.displays.values():
            d.stop()
        if self.mqtt and self.mqtt.connected:
            for d in self.displays.values():
                d.online = False   # so _on_message doesn't "repair" our own offline
                self.mqtt.publish(d.topic + "/status", "offline", retain=True)
            self.mqtt.publish(self.bridge_state_topic, "offline", retain=True)

    # ------------------------------------------------------------------ adoption
    def adopt_start(self, host):
        PixelAPI(host).pair_start()

    def adopt_confirm(self, host, code, name=None, topic=None, uid=None, keep_legacy=False):
        api = PixelAPI(host)
        info = api.info()
        if info["id"] in self.displays:
            raise ValueError("this display is already adopted")
        token = api.pair_confirm(code.strip())
        name = (name or "").strip() or info.get("name") or "Pixel display"
        if keep_legacy:  # pixeld's own topics/ids: existing HA entities and automations keep working
            topic, uid = DEVICE_BASE, DEVICE_UID
        topic = (topic or f"{self.base}/{slug(name)}").strip().strip("/")
        uid = slug(uid or f"p2m_{info['id']}")
        for d in self.displays.values():
            if d.topic == topic:
                raise ValueError(f"topic {topic} is already used by {d.name}")
        cfg = {"id": info["id"], "name": name, "host": host, "token": token, "topic": topic, "uid": uid}
        self.store.save_device(cfg)
        return self._add(cfg)

    def remove(self, dev_id, unpair=True):
        d = self.displays.pop(dev_id, None)
        if not d:
            return
        d.stop()
        if self.mqtt:
            self.mqtt.unsubscribe(d.topic + "/+/set")
            self.mqtt.unsubscribe(d.topic + "/status")
            self.mqtt.publish(d.topic + "/status", "offline", retain=True)
        if unpair:
            try:
                d.api.unpair()
            except (OSError, APIError):
                pass
        self.store.delete_device(dev_id)
        if self.bindings:
            self.bindings.forget_display(dev_id)

    def scan(self):
        from .device import scan
        hosts = list(self.config.hosts) + [d.cfg["host"] for d in self.displays.values()]
        found = scan(hosts)
        adopted = {d.id for d in self.displays.values()}
        with self.lock:
            self.found = {ip: dict(info, adopted=info.get("id") in adopted) for ip, info in found.items()}
        # follow DHCP changes: same id at a new address
        for ip, info in found.items():
            d = self.displays.get(info.get("id"))
            if d and d.cfg["host"] != ip:
                log.info("%s moved %s -> %s", d.name, d.cfg["host"], ip)
                d.cfg["host"] = ip; d.api.host = ip
                self.store.save_device(d.cfg)
        return self.found

    def scan_loop(self, stop: threading.Event, every=120):
        while not stop.is_set():
            try:
                self.scan()
            except Exception:  # noqa: BLE001
                log.exception("scan failed")
            stop.wait(every)
