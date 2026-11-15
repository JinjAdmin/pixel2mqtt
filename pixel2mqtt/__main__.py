"""python -m pixel2mqtt"""
import logging
import os
import signal
import threading

from . import __version__
from .bridge import Manager
from .config import Config, Store
from .mqtt import MQTTClient
from .web import serve


def main():
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO").upper(),
                        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s")
    log = logging.getLogger("pixel2mqtt")
    cfg = Config()
    log.info("pixel2mqtt %s - %s", __version__, cfg.describe())
    store = Store(cfg.data_dir)
    mgr = Manager(cfg, store)
    mqtt = None
    if cfg.mqtt_host:
        mqtt = MQTTClient(cfg.mqtt_host, cfg.mqtt_port, cfg.mqtt_user, cfg.mqtt_password, client_id=f"{cfg.base}-bridge",
                          will=(f"{cfg.base}/bridge/state", "offline", True))
    else:
        log.warning("MQTT_HOST not set: running as editor only (no Home Assistant bridge)")
    mgr.start(mqtt)
    if mqtt:
        mqtt.start()
    stop = threading.Event()
    threading.Thread(target=mgr.scan_loop, args=(stop, cfg.scan_interval), daemon=True, name="scan").start()
    srv = serve(mgr, cfg)
    for s in (signal.SIGINT, signal.SIGTERM):
        signal.signal(s, lambda *_: stop.set())
    while not stop.wait(1):  # short waits so Ctrl+C is handled on Windows too
        pass
    log.info("stopping")
    mgr.shutdown()
    if mqtt:
        mqtt.stop()
    srv.shutdown()


if __name__ == "__main__":
    main()
