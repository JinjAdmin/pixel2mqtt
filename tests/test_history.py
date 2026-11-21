"""python -m tests.test_history - sparkline history: closed stretches cut out, 24/7 values unchanged, back-fill kept,
long windows from statistics."""
import math
import pathlib
import sys
import types

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from pixel2mqtt.ha import HomeAssistant, active_series  # noqa: E402

fails = 0
H = 3600


def ok(name, cond, extra=None):
    global fails
    print(("ok   " if cond else "FAIL ") + name + ("" if cond or extra is None else f"  -> {extra!r}"))
    fails += 0 if cond else 1


def longest_flat(xs):
    best = run = 1
    for a, b in zip(xs, xs[1:]):
        run = run + 1 if a == b else 1
        best = max(best, run)
    return best


# a stock: trades 14:30-21:00 UTC on weekdays, a new price every 15 min; now = Sunday 12:00 UTC
DAY = 86400
now = 5 * DAY + 3 * DAY + 12 * H          # day 0 = a Monday; now = the following Sunday noon
stock, price = [], 7000.0
for d in range(0, 8):
    if d % 7 >= 5:
        continue
    for k in range(26):                    # 6.5 h of 15-minute updates
        price += math.sin(d * 31 + k) * 9
        stock.append((d * DAY + 14.5 * H + k * 900, round(price, 2)))
start = now - 7 * 24 * H
s24 = active_series(stock, start, now, 24 * H, 48)
ok("stock over a weekend: no flat line", longest_flat(s24) <= 3, s24)
ok("stock: ends at the last trade", s24[-1] == stock[-1][1], (s24[-1], stock[-1][1]))
ok("stock: 24 h of movement = the last few sessions", min(s24) < max(s24))

# crypto: changes every 15 minutes around the clock -> same as plain resampling of the last 24 h
crypto = [(now - 7 * DAY + k * 900, 60000 + 500 * math.sin(k / 10)) for k in range(7 * 96)]
c24 = active_series(crypto, now - 7 * DAY, now, 24 * H, 48)
plain = []
for i in range(48):
    lo, hi = now - 24 * H + i * 1800, now - 24 * H + (i + 1) * 1800
    vals = [(min(hi, t2) - max(lo, t1), v) for (t1, v), (t2, _) in zip(crypto, crypto[1:] + [(now, 0)]) if t2 > lo and t1 < hi]
    plain.append(round(sum(w * v for w, v in vals) / sum(w for w, _ in vals), 4))
ok("crypto (24/7): unchanged by the cut", max(abs(a - b) for a, b in zip(c24[:-1], plain[:-1])) < 1e-6, (c24[:3], plain[:3]))
ok("crypto: the last point is the current price", c24[-1] == round(crypto[-1][1], 4))

# a brand-new sensor (data only for the last 3 h): the leading back-fill stays
new = [(now - 3 * H + k * 900, 100 + k) for k in range(12)]
n24 = active_series(new, now - 7 * DAY, now, 24 * H, 48)
ok("new sensor: leading back-fill kept", n24[:40] == [100.0] * 40 and n24[-1] == 111, n24)

# nothing moved at all: one level (no crash)
ok("constant: a level", active_series([(start, 5.0)], start, now, 24 * H, 4) == [5.0] * 4, active_series([(start, 5.0)], start, now, 24 * H, 4))
ok("no data: empty", active_series([], start, now, 24 * H, 4) == [])

# long windows: statistics instead of the recorder
ha = HomeAssistant(types.SimpleNamespace(addon=False))
ha.mode, ha.connected = "url", True
calls = []
ha._recorder = lambda *a, **k: calls.append("recorder") or stock
ha._statistics = lambda eid, s, e, period="hour": calls.append(("stats", period)) or [(t, v) for t, v in stock]
ha.history("sensor.gspc", 24, 48)
ha.history("sensor.gspc", 24 * 30, 48)
ha.history("sensor.gspc", 24 * 120, 48)
ok("24 h: recorder; 30 days: hourly statistics; 120 days: daily", calls == ["recorder", ("stats", "hour"), ("stats", "day")], calls)

print(f"\n{fails} FAILED" if fails else "\nALL PASSED")
sys.exit(1 if fails else 0)
