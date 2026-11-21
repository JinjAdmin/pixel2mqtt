"""Home Assistant access for the screen editor and value bindings (standard library only).

- HA OS add-on: automatic through the Supervisor proxy (SUPERVISOR_TOKEN, needs homeassistant_api in the add-on).
- Docker / anywhere else: HA_URL (e.g. http://homeassistant.local:8123) and HA_TOKEN_FILE (a long-lived token).
- Neither: no HA access; bindings are just names.

One websocket connection keeps the area/device/entity registries and every entity's state current; history comes from
the recorder over REST. The token is never logged or returned by the API.
"""
import base64
import datetime
import json
import logging
import os
import socket
import ssl
import struct
import threading
import time
import urllib.parse
import urllib.request

log = logging.getLogger("ha")


class WSClosed(Exception):
    pass


class WebSocket:
    """Minimal RFC 6455 client: text frames, fragmentation, ping/pong, close."""

    def __init__(self, url: str, timeout=30):
        u = urllib.parse.urlsplit(url)
        port = u.port or (443 if u.scheme == "wss" else 80)
        sock = socket.create_connection((u.hostname, port), timeout=timeout)
        if u.scheme == "wss":
            sock = ssl.create_default_context().wrap_socket(sock, server_hostname=u.hostname)
        self.sock, self.buf = sock, b""
        key = base64.b64encode(os.urandom(16)).decode()
        path = (u.path or "/") + ("?" + u.query if u.query else "")
        host = u.hostname + (f":{u.port}" if u.port else "")
        sock.sendall((f"GET {path} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                      f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        while b"\r\n\r\n" not in self.buf:
            d = sock.recv(4096)
            if not d:
                raise WSClosed("closed during handshake")
            self.buf += d
        head, self.buf = self.buf.split(b"\r\n\r\n", 1)
        if b" 101 " not in head.split(b"\r\n", 1)[0]:
            raise WSClosed("handshake refused: " + head.split(b"\r\n", 1)[0].decode(errors="replace"))
        self.lock = threading.Lock()

    def _read(self, n):
        while len(self.buf) < n:
            d = self.sock.recv(1 << 16)
            if not d:
                raise WSClosed("connection closed")
            self.buf += d
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def _send(self, opcode, data: bytes):
        hdr = bytes([0x80 | opcode])
        n = len(data)
        if n < 126:
            hdr += bytes([0x80 | n])
        elif n < 65536:
            hdr += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            hdr += bytes([0x80 | 127]) + struct.pack(">Q", n)
        mask = os.urandom(4)
        body = bytes(b ^ mask[i & 3] for i, b in enumerate(data))
        with self.lock:
            self.sock.sendall(hdr + mask + body)

    def send(self, obj):
        self._send(1, json.dumps(obj).encode())

    def recv(self):
        msg = b""
        while True:
            b0, b1 = self._read(2)
            op, n = b0 & 0x0F, b1 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._read(8))[0]
            mask = self._read(4) if b1 & 0x80 else None
            data = self._read(n)
            if mask:
                data = bytes(b ^ mask[i & 3] for i, b in enumerate(data))
            if op == 8:
                raise WSClosed("closed by server")
            if op == 9:
                self._send(10, data)
                continue
            if op == 10:
                continue
            msg += data
            if b0 & 0x80:
                return json.loads(msg)

    def close(self):
        try:
            self._send(8, b"")
        except OSError:
            pass
        try:
            self.sock.close()
        except OSError:
            pass


class HomeAssistant:
    def __init__(self, config):
        self.mode, self.rest, self.ws_url, self._token = "none", "", "", ""
        sup = os.environ.get("SUPERVISOR_TOKEN")
        if getattr(config, "addon", False) and sup:
            self.mode, self.rest, self.ws_url, self._token = "supervisor", "http://supervisor/core/api", "ws://supervisor/core/websocket", sup
        else:
            url = (os.environ.get("HA_URL") or "").rstrip("/")
            tf = os.environ.get("HA_TOKEN_FILE") or ""
            if url and tf and os.path.isfile(tf):
                tok = open(tf, encoding="utf-8").read().strip()
                if tok:
                    self.mode, self._token = "url", tok
                    self.rest = url + "/api"
                    self.ws_url = ("wss" if url.startswith("https") else "ws") + url[url.index(":"):] + "/api/websocket"
            elif url:
                self.mode, self.error = "none", "HA_URL is set but HA_TOKEN_FILE is missing or unreadable"
        self.connected = False
        self.error = getattr(self, "error", "")
        self.version = ""
        self.states = {}          # entity_id -> {"s": state, "a": attributes, "t": last_updated}
        self.areas, self.devices, self.entities, self.labels = {}, {}, {}, {}
        self.listeners = []       # fn(entity_id, new_state_dict or None)
        self.on_connect = []      # fn()
        self._ws = None
        self._id = 0
        self._pending = {}
        self._plock = threading.Lock()
        self._stop = threading.Event()

    available = property(lambda s: s.mode != "none")

    def status(self):
        return {"available": self.available, "mode": self.mode, "connected": self.connected, "error": self.error,
                "version": self.version, "entities": len(self.states)}

    # ------------------------------------------------------------------ REST
    def get(self, path, timeout=30):
        req = urllib.request.Request(self.rest + path, headers={"Authorization": "Bearer " + self._token,
                                                                "Content-Type": "application/json"})
        return json.loads(urllib.request.urlopen(req, timeout=timeout).read() or b"null")

    def history(self, entity_id, hours=24, points=32, attr=None):
        """Numeric history from the recorder, resampled to `points` evenly spaced buckets (mean, gaps carried)."""
        if not self.available:
            raise ValueError("no Home Assistant access")
        hours, points = max(0.1, min(float(hours), 24 * 30)), max(2, min(int(points), 64))
        end = datetime.datetime.now(datetime.timezone.utc)
        start = end - datetime.timedelta(hours=hours)
        q = {"filter_entity_id": entity_id, "end_time": end.isoformat()}
        if not attr:
            q.update(minimal_response="", no_attributes="")
        rows = self.get(f"/history/period/{urllib.parse.quote(start.isoformat())}?" + urllib.parse.urlencode(q), timeout=60)
        samples = []
        for r in (rows[0] if rows else []):
            v = (r.get("attributes") or {}).get(attr) if attr else r.get("state")
            try:
                v = float(v)
            except (TypeError, ValueError):
                continue
            ts = r.get("last_changed") or r.get("last_updated")
            if ts:
                samples.append((datetime.datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp(), v))
        if not samples:
            return []
        t0, span = start.timestamp(), hours * 3600
        sums, counts = [0.0] * points, [0] * points
        for ts, v in samples:
            i = min(points - 1, max(0, int((ts - t0) / span * points)))
            sums[i] += v
            counts[i] += 1
        out, last = [], samples[0][1]
        for i in range(points):
            if counts[i]:
                last = sums[i] / counts[i]
            out.append(round(last, 4))
        return out

    # ------------------------------------------------------------------ websocket
    def start(self):
        if self.available:
            threading.Thread(target=self._run, name="ha", daemon=True).start()

    def stop(self):
        self._stop.set()
        if self._ws:
            self._ws.close()

    def _call(self, typ, timeout=60, **kw):
        """Request/response over the shared websocket (from any thread)."""
        ws = self._ws
        if not ws:
            raise ConnectionError("not connected to Home Assistant")
        with self._plock:
            self._id += 1
            mid = self._id
            ev = threading.Event()
            self._pending[mid] = [ev, None]
        ws.send(dict(kw, id=mid, type=typ))
        if not ev.wait(timeout):
            self._pending.pop(mid, None)
            raise TimeoutError(typ)
        msg = self._pending.pop(mid)[1]
        if not msg.get("success", True):
            raise ValueError((msg.get("error") or {}).get("message", "request failed"))
        return msg.get("result")

    def _run(self):
        backoff = 2
        while not self._stop.is_set():
            try:
                ws = WebSocket(self.ws_url, timeout=30)
                hello = ws.recv()
                self.version = hello.get("ha_version", "")
                ws.send({"type": "auth", "access_token": self._token})
                r = ws.recv()
                if r.get("type") != "auth_ok":
                    raise PermissionError("Home Assistant rejected the token")
                self._ws = ws
                ws.sock.settimeout(45)
                reader = threading.Thread(target=self._reader, args=(ws,), name="ha-reader", daemon=True)
                reader.start()
                self._load_all()
                for t in ("state_changed", "area_registry_updated", "device_registry_updated", "entity_registry_updated", "label_registry_updated"):
                    self._call("subscribe_events", event_type=t)
                self.connected, self.error, backoff = True, "", 2
                log.info("connected to Home Assistant %s (%d entities)", self.version, len(self.states))
                for fn in list(self.on_connect):
                    try:
                        fn()
                    except Exception:  # noqa: BLE001
                        log.exception("on_connect handler failed")
                reader.join()
            except PermissionError as e:
                self.error = str(e)
                self._stop.wait(300)
            except Exception as e:  # noqa: BLE001
                self.error = str(e) or e.__class__.__name__
                log.warning("Home Assistant connection: %s", self.error)
            finally:
                self.connected = False
                if self._ws:
                    self._ws.close()
                self._ws = None
                with self._plock:
                    for p in self._pending.values():
                        p[1] = {"success": False, "error": {"message": "disconnected"}}
                        p[0].set()
            self._stop.wait(backoff)
            backoff = min(backoff * 2, 60)

    def _reader(self, ws):
        idle = 0
        while not self._stop.is_set():
            try:
                msg = ws.recv()
                idle = 0
            except socket.timeout:
                idle += 1
                if idle > 1:
                    return   # no pong: reconnect
                try:
                    ws.send({"id": self._next_id(), "type": "ping"})
                except OSError:
                    return
                continue
            except (WSClosed, OSError, ValueError):
                return
            if msg.get("type") == "event":
                self._event(msg.get("event") or {})
            elif msg.get("type") in ("result", "pong"):
                with self._plock:
                    p = self._pending.get(msg.get("id"))
                if p:
                    p[1] = msg
                    p[0].set()

    def _next_id(self):
        with self._plock:
            self._id += 1
            return self._id

    def _event(self, ev):
        et, data = ev.get("event_type"), ev.get("data") or {}
        if et == "state_changed":
            eid, ns = data.get("entity_id"), data.get("new_state")
            if ns is None:
                self.states.pop(eid, None)
            else:
                self.states[eid] = {"s": ns.get("state"), "a": ns.get("attributes") or {}, "t": ns.get("last_updated")}
            for fn in list(self.listeners):
                try:
                    fn(eid, self.states.get(eid))
                except Exception:  # noqa: BLE001
                    log.exception("state listener failed")
        elif et.endswith("_registry_updated"):
            def reload(which=et.split("_")[0]):
                self._reload_registry(which)
                for fn in list(getattr(self, "on_registry", [])):
                    fn()
            threading.Thread(target=reload, daemon=True).start()

    def _reload_registry(self, which):
        try:
            if which == "area":
                self.areas = {a["area_id"]: a for a in self._call("config/area_registry/list")}
            elif which == "label":
                self.labels = {lb["label_id"]: lb for lb in self._call("config/label_registry/list")}
            elif which == "device":
                self.devices = {d["id"]: d for d in self._call("config/device_registry/list")}
            else:
                self.entities = {e["entity_id"]: e for e in self._call("config/entity_registry/list")}
        except Exception as e:  # noqa: BLE001
            log.debug("registry reload %s: %s", which, e)

    def _load_all(self):
        self.states = {s["entity_id"]: {"s": s.get("state"), "a": s.get("attributes") or {}, "t": s.get("last_updated")}
                       for s in self._call("get_states")}
        for w in ("area", "device", "entity", "label"):
            self._reload_registry(w)
        for fn in list(getattr(self, "on_registry", [])):
            fn()

    # ------------------------------------------------------------------ for the editor
    def registry(self):
        """Compact areas/devices/entities with live state, for the entity picker."""
        areas = [{"id": a["area_id"], "name": a.get("name") or a["area_id"]} for a in self.areas.values()]
        devs = []
        for d in self.devices.values():
            if d.get("disabled_by"):
                continue
            devs.append({"id": d["id"], "name": d.get("name_by_user") or d.get("name") or "", "area": d.get("area_id"),
                         "mf": d.get("manufacturer") or "", "model": d.get("model") or ""})
        ents = []
        for eid, st in self.states.items():
            reg = self.entities.get(eid) or {}
            if reg.get("disabled_by") or reg.get("hidden_by"):
                continue
            a = st["a"]
            dev = self.devices.get(reg.get("device_id")) or {}
            ents.append({
                "id": eid, "name": a.get("friendly_name") or reg.get("name") or reg.get("original_name") or eid,
                "device": reg.get("device_id"), "area": reg.get("area_id") or dev.get("area_id"),
                "integration": reg.get("platform") or eid.split(".")[0], "state": st["s"],
                "unit": a.get("unit_of_measurement"), "dc": a.get("device_class"), "sc": a.get("state_class"),
                "attrs": sorted(k for k in a if k not in ("friendly_name", "icon", "entity_picture", "supported_features")),
                "labels": list(reg.get("labels") or []),
            })
        labels = [{"id": k, "name": v.get("name") or k} for k, v in self.labels.items()]
        return {"areas": areas, "devices": devs, "entities": ents, "labels": labels}

    # ------------------------------------------------------------------ groups (template screens)
    def members(self, by, match):
        """Entities in a screen group, sorted by name: [{id, name}].
        by: integration (platform), label (id or name), device (id or name), domain (entity type, e.g. sensor),
        entities (comma-separated entity ids)."""
        match = (match or "").strip()
        if not match:
            return []
        m = match.lower()
        want_ids = [x.strip() for x in match.split(",") if x.strip()] if by == "entities" else None
        label_ids = {k for k, v in self.labels.items() if k.lower() == m or (v.get("name") or "").lower() == m} if by == "label" else set()
        out = []
        for eid, st in self.states.items():
            reg = self.entities.get(eid) or {}
            if reg.get("disabled_by") or reg.get("hidden_by"):
                continue
            dev = self.devices.get(reg.get("device_id")) or {}
            if by == "integration":
                ok = (reg.get("platform") or "").lower() == m
            elif by == "label":
                ok = bool(label_ids & set(reg.get("labels") or [])) or bool(label_ids & set(dev.get("labels") or []))
            elif by == "device":
                ok = bool(dev) and (dev.get("id") == match or (dev.get("name_by_user") or dev.get("name") or "").lower() == m)
            elif by == "domain":
                ok = eid.split(".")[0] == m
            elif by == "entities":
                ok = eid in want_ids
            else:
                ok = False
            if ok:
                out.append({"id": eid, "name": st["a"].get("friendly_name") or reg.get("name") or reg.get("original_name") or eid})
        if want_ids:
            return sorted(out, key=lambda e: want_ids.index(e["id"]))
        return sorted(out, key=lambda e: e["name"].lower())

    def state(self, entity_id):
        st = self.states.get(entity_id)
        return None if st is None else {"state": st["s"], "attributes": st["a"], "last_updated": st["t"]}
