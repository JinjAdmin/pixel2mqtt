"""HA controls: screen settings promoted to Home Assistant entities.

A control is {param, name, type, min, max, step, unit, options, line, value}:
- param  "screen.<directive>" (time, order, bg, stale), "el.<element id>.<option>" (an element option on .scr
         line `line`), or "value.<name>.hours" (a history value's window).
- type   number | select | switch | text.
A command from HA is checked against the control, written into the stored .scr (or the binding) and sent.
"""
import re

TYPES = ("number", "select", "switch", "text")
DIRECTIVES = ("time", "order", "bg", "stale")
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
DUR_RE = re.compile(r"^\d+[smhd]$")
PARAM_RE = re.compile(r"^(screen\.(time|order|bg|stale)|el\.[A-Za-z0-9_-]{1,40}\.[a-z]{1,12}|value\.[a-z0-9_.-]{1,31}\.hours)$")
COLOR_KEYS = ("color", "fill", "bg")
MAX_HOURS = 24 * 366
HOURS_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*([hd]?)\s*$", re.I)


def is_hours(c):
    return c["param"].startswith("value.")


def parse_hours(s):
    """'12h', '7d', '24' -> hours (a number), or None."""
    m = HOURS_RE.match(str(s))
    if not m:
        return None
    h = float(m.group(1)) * (24 if m.group(2).lower() == "d" else 1)
    return _whole(h) if 0 < h <= MAX_HOURS else None


def fmt_hours(h):
    h = _whole(float(h))
    return f"{_whole(h / 24)}d" if h >= 48 and h % 24 == 0 else f"{h}h"


def _f(v, default):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _whole(x):
    return int(x) if float(x).is_integer() else x


def clean_controls(items):
    """The editor's list -> a validated one (unknown params and duplicates dropped)."""
    out, seen = [], set()
    for c in items or []:
        if not isinstance(c, dict):
            continue
        p, t = str(c.get("param", "")), c.get("type")
        if not PARAM_RE.match(p) or t not in TYPES or p in seen:
            continue
        if p.startswith("el.") and not isinstance(c.get("line"), int):
            continue
        seen.add(p)
        k = {"param": p, "name": str(c.get("name") or p)[:60].strip(), "type": t}
        if p.startswith("el."):
            k["line"] = c["line"]
        if t == "number":
            lo, hi = _f(c.get("min"), 0), _f(c.get("max"), 100)
            k.update(min=_whole(min(lo, hi)), max=_whole(max(lo, hi)), step=_whole(_f(c.get("step"), 1) or 1), unit=str(c.get("unit") or "")[:8])
        if t == "select":
            opts = [str(o).strip()[:40] for o in (c.get("options") or []) if str(o).strip()]
            if p.startswith("value."):
                opts = [o for o in opts if parse_hours(o) is not None]
            if not opts:
                continue
            k["options"] = list(dict.fromkeys(opts))[:50]
        if not p.startswith("value."):
            k["value"] = c.get("value")
        out.append(k)
    return out


def coerce(c, raw):
    """A command payload -> the value to store, or None if it isn't valid for this control."""
    raw = str(raw).strip()
    t, key = c["type"], c["param"].rsplit(".", 1)[-1]
    if is_hours(c):
        if t == "select" and raw not in c["options"]:
            return None
        h = parse_hours(raw)
        if h is None:
            return None
        if t == "number":
            h = max(float(c["min"]), min(float(c["max"]), h))
        return _whole(max(1, min(MAX_HOURS, h)))
    if t == "number":
        try:
            v = max(float(c["min"]), min(float(c["max"]), float(raw)))
        except (TypeError, ValueError):
            return None
        return _whole(round(v, 4))
    if t == "switch":
        return {"on": True, "off": False, "1": True, "0": False, "true": True, "false": False}.get(raw.lower())
    if t == "select" and raw not in c["options"]:
        return None
    if '"' in raw or "\n" in raw or not raw or len(raw) > 63:
        return None
    if key in COLOR_KEYS and not COLOR_RE.match(raw):
        return None
    if key == "stale" and not DUR_RE.match(raw):
        return None
    return raw.lower() if key in COLOR_KEYS else raw


def state_text(c, v):
    """The value as HA expects it on the state topic."""
    if v is None:
        return ""
    if is_hours(c) and c["type"] != "number":
        return next((o for o in c.get("options", []) if parse_hours(o) == parse_hours(v)), fmt_hours(v))
    if c["type"] == "switch":
        return "ON" if v in (True, 1, "1", "true", "on") else "OFF"
    return str(_whole(v)) if isinstance(v, float) else str(v)


# ---------------------------------------------------------------- .scr patching
def tokens(line):
    """Split a .scr line at spaces outside quotes; tokens are kept raw (quotes included)."""
    out, cur, q, esc = [], "", False, False
    for ch in line:
        if esc:
            cur += ch
            esc = False
        elif ch == "\\" and q:
            cur += ch
            esc = True
        elif ch == '"':
            cur += ch
            q = not q
        elif ch in " \t" and not q:
            if cur:
                out.append(cur)
            cur = ""
        else:
            cur += ch
    if cur:
        out.append(cur)
    return out


def _unq(v):
    if len(v) >= 2 and v[0] == '"' and v[-1] == '"':
        return v[1:-1].replace('\\"', '"').replace("\\\\", "\\")
    return v


def _opt(k, v, quote=False):
    v = str(v)
    return f'{k}="' + v.replace("\\", "\\\\").replace('"', '\\"') + '"' if quote or re.search(r'[\s"]', v) else f"{k}={v}"


def _scr_val(c, v):
    if c["type"] == "switch":
        return "1" if v else "0"
    return str(_whole(v)) if isinstance(v, float) else str(v)


def patch_scr(text, c, v):
    """Write control `c` = `v` into the .scr text. Returns the new text (unchanged if the target is gone)."""
    lines = text.split("\n")
    p = c["param"]
    if p.startswith("screen."):
        key, val = p.split(".", 1)[1], _scr_val(c, v)
        for i, ln in enumerate(lines):
            if ln.split(" ", 1)[0] == key:
                lines[i] = f"{key} {val}"
                return "\n".join(lines)
        at = next((i + 1 for i, ln in enumerate(lines) if ln.startswith("name ")), 1)
        lines.insert(at, f"{key} {val}")
        return "\n".join(lines)
    key = p.rsplit(".", 1)[1]
    i = c["line"] - 1
    if not 0 <= i < len(lines) or not lines[i].strip() or lines[i].lstrip().startswith("#"):
        return text
    toks = tokens(lines[i])
    new = _scr_val(c, v)
    for j, t in enumerate(toks):
        if t.startswith(key + "="):
            old = _unq(t[len(key) + 1:])
            if key == "color" and ";" in old:          # colour rules: the control sets the default (the last one)
                new = old.rsplit(";", 1)[0] + ";" + new
            elif key == "fill" and ".." in old:        # a gradient: the control sets its start
                new = new + ".." + old.split("..", 1)[1]
            toks[j] = _opt(key, new, quote=t[len(key) + 1:].startswith('"'))   # keep the original quoting
            break
    else:
        toks.append(_opt(key, new))
    lines[i] = " ".join(toks)
    return "\n".join(lines)
