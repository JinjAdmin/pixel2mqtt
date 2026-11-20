"""Client for pixeld's LAN API (see pixeld-h6631: src/api.c, docs/API.md) plus LAN discovery and UDP frames."""
import http.client
import json
import socket
import time
import urllib.parse

DISCOVERY_PORT = 7778
FRAME_PORT = 7777
FRAME_BYTES = 52 * 32 * 3


class APIError(Exception):
    def __init__(self, status, message):
        super().__init__(f"{status}: {message}")
        self.status, self.message = status, message


class PixelAPI:
    def __init__(self, host: str, token: str = "", timeout: float = 15):
        self.host, self.token, self.timeout = host, token, timeout  # host may be "ip" or "ip:port"

    @property
    def addr(self):
        h, _, p = self.host.partition(":")
        return h, int(p or 80)

    def request(self, method, path, body=None, timeout=None, ctype="application/octet-stream"):
        conn = http.client.HTTPConnection(*self.addr, timeout=timeout or self.timeout)
        headers = {"Connection": "close"}
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        if body is not None:
            if isinstance(body, str):
                body = body.encode()
            headers["Content-Type"] = ctype
            headers["Content-Length"] = str(len(body))
        try:
            conn.request(method, path, body=body, headers=headers)
            r = conn.getresponse()
            data = r.read()
        finally:
            conn.close()
        if r.status >= 400:
            try:
                msg = json.loads(data).get("error", "")
            except ValueError:
                msg = data[:200].decode(errors="replace")
            raise APIError(r.status, msg)
        return data

    def json(self, method, path, body=None, timeout=None):
        return json.loads(self.request(method, path, body, timeout) or b"null")

    @staticmethod
    def q(s: str) -> str:
        return urllib.parse.quote(s, safe="")

    # endpoints
    def info(self):
        return self.json("GET", "/api/info", timeout=4)

    def pair_start(self):
        return self.json("POST", "/api/pair", b"")

    def pair_confirm(self, code: str) -> str:
        return self.json("POST", "/api/pair?code=" + self.q(code), b"")["token"]

    def unpair(self):
        return self.json("DELETE", "/api/pair")

    def storage(self):
        return self.json("GET", "/api/storage")

    def discovery(self, owns_mqtt=False):
        return self.json("GET", "/api/discovery" + ("?mqtt=1" if owns_mqtt else ""))

    def events(self, since: int, wait: int = 25, owns_mqtt=False):
        """owns_mqtt: we are connected to the broker, so pixeld keeps its own MQTT client off."""
        return self.json("GET", f"/api/events?since={since}&wait={wait}&mqtt={1 if owns_mqtt else 0}", timeout=wait + 15)

    def cmd(self, name: str, payload) -> None:
        self.request("POST", "/api/cmd/" + name, payload if payload is not None else b"")

    def files(self, kind: str):
        return self.json("GET", f"/api/files/{kind}")

    def get_file(self, kind: str, name: str) -> bytes:
        return self.request("GET", f"/api/files/{kind}/{self.q(name)}", timeout=60)

    def put_file(self, kind: str, name: str, data: bytes) -> None:
        self.request("PUT", f"/api/files/{kind}/{self.q(name)}", data, timeout=120)

    def delete_file(self, kind: str, name: str) -> None:
        self.request("DELETE", f"/api/files/{kind}/{self.q(name)}")

    def res(self, path: str):
        """Stock resource under /usr/res: bytes for a file, a list of dicts for a directory."""
        data = self.request("GET", "/api/res?path=" + self.q(path), timeout=60)
        if data[:1] == b"[":
            try:
                return json.loads(data)
            except ValueError:
                pass
        return data

    def screens(self):
        """Info screens on the display with their errors, visibility and missing values (GET /api/screens)."""
        return self.json("GET", "/api/screens")

    def frame(self) -> bytes:
        return self.request("GET", "/api/frame")


_udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)


def send_frame(host: str, rgb: bytes) -> None:
    """Show one 52x32 RGB frame (row-major from the top-left). The panel resumes its mode 3 s after the last one."""
    if len(rgb) != FRAME_BYTES:
        raise ValueError("frame must be 4992 bytes")
    _udp.sendto(rgb, (host.partition(":")[0], FRAME_PORT))


def scan(extra_hosts=(), timeout: float = 1.5):
    """Broadcast for pixeld displays on UDP 7778 and probe extra_hosts over HTTP. Returns {ip: info}."""
    found = {}
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    s.settimeout(0.2)
    try:
        for target in ("255.255.255.255",) + tuple(h for h in extra_hosts if h):
            try:
                s.sendto(b"pixel2mqtt?", (target, DISCOVERY_PORT))
            except OSError:
                pass
        end = time.time() + timeout
        while time.time() < end:
            try:
                data, (ip, _) = s.recvfrom(2048)
            except socket.timeout:
                continue
            except OSError:
                break
            try:
                info = json.loads(data)
                if info.get("app") == "pixeld":
                    found[ip] = info
            except ValueError:
                pass
    finally:
        s.close()
    for h in extra_hosts:  # unicast HTTP fallback (works across subnets / Docker bridge networks)
        if h and h not in found:
            try:
                info = PixelAPI(h).info()
                if info.get("app") == "pixeld":
                    found[h] = info
            except (OSError, APIError, ValueError):
                pass
    return found
