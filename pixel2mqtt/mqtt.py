"""Minimal MQTT 3.1.1 client (QoS 0, retain, last will, auto-reconnect). Standard library only."""
import logging
import socket
import struct
import threading
import time

log = logging.getLogger("mqtt")


def _str(s: str) -> bytes:
    b = s.encode()
    return struct.pack(">H", len(b)) + b


def _len(n: int) -> bytes:
    out = bytearray()
    while True:
        d, n = n % 128, n // 128
        out.append(d | (128 if n else 0))
        if not n:
            return bytes(out)


def topic_matches(filt: str, topic: str) -> bool:
    f, t = filt.split("/"), topic.split("/")
    for i, part in enumerate(f):
        if part == "#":
            return True
        if i >= len(t) or (part != "+" and part != t[i]):
            return False
    return len(f) == len(t)


class MQTTClient:
    def __init__(self, host, port=1883, user="", password="", client_id="pixel2mqtt", will=None, keepalive=30):
        self.host, self.port, self.user, self.password = host, int(port), user or "", password or ""
        self.client_id, self.will, self.keepalive = client_id, will, keepalive
        self.on_connect = None          # callback()
        self.on_message = None          # callback(topic: str, payload: bytes, retained: bool)
        self.connected = False
        self.last_error = ""
        self._subs = []
        self._sock = None
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None

    # ------------------------------------------------------------------ public
    def start(self):
        self._thread = threading.Thread(target=self._run, name="mqtt", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        if self.connected:
            try:
                self._send(b"\xe0\x00")
            except OSError:
                pass
        if self._sock:
            try:
                self._sock.close()
            except OSError:
                pass

    def subscribe(self, filt: str):
        if filt not in self._subs:
            self._subs.append(filt)
            if self.connected:
                self._send_subscribe([filt])

    def unsubscribe(self, filt: str):
        if filt in self._subs:
            self._subs.remove(filt)
            if self.connected:
                body = struct.pack(">H", 2) + _str(filt)
                self._send(b"\xa2" + _len(len(body)) + body)

    def publish(self, topic: str, payload, retain=False) -> bool:
        if isinstance(payload, str):
            payload = payload.encode()
        body = _str(topic) + payload
        try:
            self._send(bytes([0x30 | (1 if retain else 0)]) + _len(len(body)) + body)
            return True
        except OSError:
            return False

    # ------------------------------------------------------------------ internals
    def _send(self, data: bytes):
        with self._lock:
            if not self._sock:
                raise OSError("not connected")
            self._sock.sendall(data)

    def _send_subscribe(self, filters):
        body = struct.pack(">H", 1) + b"".join(_str(f) + b"\x00" for f in filters)
        self._send(b"\x82" + _len(len(body)) + body)

    def _connect(self):
        s = socket.create_connection((self.host, self.port), timeout=10)
        s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        flags = 0x02
        payload = _str(self.client_id)
        if self.will:
            topic, msg, retain = self.will
            flags |= 0x04 | (0x20 if retain else 0)
            payload += _str(topic) + struct.pack(">H", len(msg.encode())) + msg.encode()
        if self.user:
            flags |= 0x80
            payload += _str(self.user)
        if self.password:
            flags |= 0x40
            payload += _str(self.password)
        var = _str("MQTT") + bytes([4, flags]) + struct.pack(">H", self.keepalive)
        s.sendall(b"\x10" + _len(len(var) + len(payload)) + var + payload)
        ack = self._read_exact(s, 4)
        if ack[0] != 0x20:
            raise OSError("no CONNACK")
        if ack[3] != 0:
            codes = {1: "bad protocol", 2: "client id rejected", 3: "server unavailable", 4: "bad username or password", 5: "not authorised"}
            raise PermissionError(f"connection refused: {codes.get(ack[3], ack[3])}")
        s.settimeout(self.keepalive / 2)
        self._sock = s

    @staticmethod
    def _read_exact(s, n):
        b = bytearray()
        while len(b) < n:
            c = s.recv(n - len(b))
            if not c:
                raise OSError("connection closed")
            b += c
        return bytes(b)

    def _run(self):
        backoff = 2
        while not self._stop.is_set():
            try:
                self._connect()
            except PermissionError as e:
                self.last_error = str(e)
                log.error("MQTT %s:%s: %s (retrying in 60 s)", self.host, self.port, e)
                self._stop.wait(60)
                continue
            except OSError as e:
                self.last_error = str(e)
                log.warning("MQTT %s:%s: %s (retrying in %d s)", self.host, self.port, e, backoff)
                self._stop.wait(backoff)
                backoff = min(backoff * 2, 60)
                continue
            backoff = 2
            self.connected, self.last_error = True, ""
            log.info("MQTT connected to %s:%s", self.host, self.port)
            try:
                if self._subs:
                    self._send_subscribe(list(self._subs))
                if self.on_connect:
                    self.on_connect()
                self._loop()
            except OSError as e:
                if not self._stop.is_set():
                    log.warning("MQTT connection lost: %s", e)
            finally:
                self.connected = False
                with self._lock:
                    try:
                        self._sock.close()
                    except OSError:
                        pass
                    self._sock = None

    def _loop(self):
        s = self._sock
        buf = bytearray()
        last_ping = time.time()
        while not self._stop.is_set():
            if time.time() - last_ping > self.keepalive / 2:
                self._send(b"\xc0\x00")
                last_ping = time.time()
            try:
                chunk = s.recv(65536)
            except socket.timeout:
                continue
            if not chunk:
                raise OSError("closed by broker")
            buf += chunk
            while True:
                if len(buf) < 2:
                    break
                n, mul, i = 0, 1, 1
                while True:
                    if i >= len(buf):
                        n = -1
                        break
                    d = buf[i]
                    i += 1
                    n += (d & 127) * mul
                    mul *= 128
                    if not d & 128:
                        break
                if n < 0 or len(buf) < i + n:
                    break
                ptype, flags, body = buf[0] >> 4, buf[0] & 15, bytes(buf[i:i + n])
                del buf[:i + n]
                if ptype == 3:
                    tl = struct.unpack(">H", body[:2])[0]
                    topic = body[2:2 + tl].decode(errors="replace")
                    off = 2 + tl + (2 if (flags >> 1) & 3 else 0)
                    if self.on_message:
                        try:
                            self.on_message(topic, body[off:], bool(flags & 1))
                        except Exception:  # never let a handler kill the connection
                            log.exception("message handler failed for %s", topic)
