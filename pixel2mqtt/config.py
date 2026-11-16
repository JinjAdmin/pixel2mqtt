"""Settings (environment, optional .env and data/config.json) and the device store (data/devices.json)."""
import json
import os
import pathlib
import threading


def _load_dotenv(path: pathlib.Path):
    """KEY=VALUE lines; real environment variables win. Values are never logged."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
            v = v[1:-1]
        os.environ.setdefault(k.strip(), v)


ADDON_OPTIONS = pathlib.Path("/data/options.json")
INGRESS_PROXY = "172.30.32.2"   # Home Assistant Supervisor's Ingress proxy


def _supervisor_mqtt():
    """Home Assistant add-on: the MQTT broker login the Supervisor hands out (Mosquitto add-on), or {}."""
    import urllib.request
    token = os.environ.get("SUPERVISOR_TOKEN")
    if not token:
        return {}
    req = urllib.request.Request("http://supervisor/services/mqtt", headers={"Authorization": "Bearer " + token})
    try:
        d = json.loads(urllib.request.urlopen(req, timeout=10).read()).get("data") or {}
    except (OSError, ValueError):
        return {}
    return {"host": d.get("host", ""), "port": d.get("port", 1883), "user": d.get("username", ""),
            "password": d.get("password", "")}


class Config:
    def __init__(self):
        # Home Assistant add-on mode: options from /data/options.json, MQTT login from the Supervisor, data in /data
        self.addon = bool(os.environ.get("SUPERVISOR_TOKEN")) and ADDON_OPTIONS.is_file()
        if self.addon and ADDON_OPTIONS == pathlib.Path("/data/options.json"):
            os.environ["PIXEL2MQTT_DATA"] = "/data"   # the add-on's persistent folder (the image defaults to /app/data)
        _load_dotenv(pathlib.Path(".env"))
        self.data_dir = pathlib.Path(os.environ.get("PIXEL2MQTT_DATA", "data"))
        self.data_dir.mkdir(parents=True, exist_ok=True)
        _load_dotenv(self.data_dir / ".env")
        f = {}
        cf = self.data_dir / "config.json"
        if cf.is_file():
            f = json.loads(cf.read_text(encoding="utf-8"))
        if self.addon:
            o = json.loads(ADDON_OPTIONS.read_text(encoding="utf-8"))
            f = dict(f)
            for k in ("base_topic", "discovery_prefix", "hosts", "scan_interval"):
                if o.get(k) not in (None, "", []):
                    f[k] = o[k]
            # an explicit broker in the options wins over the Mosquitto add-on
            manual = {k: o.get("mqtt_" + k) for k in ("host", "port", "user", "password") if o.get("mqtt_" + k)}
            f["mqtt"] = manual if manual.get("host") else _supervisor_mqtt()
            self.allow_direct = bool(o.get("allow_direct_access"))
        mq = f.get("mqtt", {})

        def get(env, fallback, default=""):
            return os.environ.get(env) or (fallback if fallback not in (None, "") else default)

        # default: a broker on the same host (network_mode: host, like zigbee2mqtt/govee2mqtt setups);
        # MQTT_HOST=none runs pixel2mqtt as an editor only
        self.mqtt_host = get("MQTT_HOST", mq.get("host"), "localhost")
        if self.mqtt_host.lower() in ("none", "off", "disabled"):
            self.mqtt_host = ""
        self.mqtt_port = int(get("MQTT_PORT", mq.get("port"), 1883))
        self.mqtt_client_id = get("MQTT_CLIENT_ID", mq.get("client_id"))  # empty: random per start
        self.mqtt_user = get("MQTT_USER", mq.get("user"))
        pw = get("MQTT_PASSWORD", mq.get("password"))
        pwf = os.environ.get("MQTT_PASSWORD_FILE")
        if not pw and pwf and os.path.isfile(pwf):
            pw = open(pwf, encoding="utf-8").read().strip()
        self.mqtt_password = pw
        self.base = get("PIXEL2MQTT_BASE", f.get("base_topic"), "pixel2mqtt")
        self.discovery_prefix = get("HA_DISCOVERY_PREFIX", f.get("discovery_prefix"), "homeassistant")
        self.web_host = get("WEB_HOST", f.get("web_host"), "0.0.0.0")
        self.web_port = int(get("WEB_PORT", f.get("web_port"), 8466))
        hosts = get("PIXEL_HOSTS", ",".join(f.get("hosts", [])))
        self.hosts = [h.strip() for h in hosts.split(",") if h.strip()]
        self.scan_interval = int(get("SCAN_INTERVAL", f.get("scan_interval"), 120))
        # add-on: the web UI is only reachable through Home Assistant (Ingress) unless the user opts in
        self.allowed_clients = None
        if self.addon and not self.allow_direct:
            self.allowed_clients = {INGRESS_PROXY, "127.0.0.1", "::1"}

    def describe(self):
        return {"mqtt": f"{self.mqtt_user + '@' if self.mqtt_user else ''}{self.mqtt_host}:{self.mqtt_port}" if self.mqtt_host else "disabled",
                "base_topic": self.base, "discovery_prefix": self.discovery_prefix, "hosts": self.hosts}


class Store:
    """data/devices.json - adopted displays, including their API tokens (keep this file private)."""

    def __init__(self, data_dir: pathlib.Path):
        self.path = data_dir / "devices.json"
        self.lock = threading.Lock()

    def devices(self):
        if not self.path.is_file():
            return []
        return json.loads(self.path.read_text(encoding="utf-8")).get("devices", [])

    def _write(self, devs):
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"devices": devs}, indent=2), encoding="utf-8")
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
        os.replace(tmp, self.path)

    def save_device(self, cfg):
        with self.lock:
            devs = [d for d in self.devices() if d["id"] != cfg["id"]] + [cfg]
            self._write(devs)

    def delete_device(self, dev_id):
        with self.lock:
            self._write([d for d in self.devices() if d["id"] != dev_id])
