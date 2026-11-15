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


class Config:
    def __init__(self):
        _load_dotenv(pathlib.Path(".env"))
        self.data_dir = pathlib.Path(os.environ.get("PIXEL2MQTT_DATA", "data"))
        self.data_dir.mkdir(parents=True, exist_ok=True)
        _load_dotenv(self.data_dir / ".env")
        f = {}
        cf = self.data_dir / "config.json"
        if cf.is_file():
            f = json.loads(cf.read_text(encoding="utf-8"))
        mq = f.get("mqtt", {})

        def get(env, fallback, default=""):
            return os.environ.get(env) or (fallback if fallback not in (None, "") else default)

        self.mqtt_host = get("MQTT_HOST", mq.get("host"))
        self.mqtt_port = int(get("MQTT_PORT", mq.get("port"), 1883))
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
