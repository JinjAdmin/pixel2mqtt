"""python -m tests.test_forecast - forecast bindings: NWS twice_daily (day and late evening), Met daily, now."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from pixel2mqtt.bindings import forecast_value  # noqa: E402

fails = 0


def ok(name, cond, extra=None):
    global fails
    print(("ok   " if cond else "FAIL ") + name + ("" if cond or extra is None else f"  -> {extra!r}"))
    fails += 0 if cond else 1


def P(day, iso, t, cond):
    return {"is_daytime": day, "datetime": iso, "temperature": t, "condition": cond}


st = {"s": "cloudy", "a": {"temperature": 48, "temperature_unit": "°F"}}
hourly = [{"datetime": "2026-11-21T15:00:00-05:00", "temperature": 58, "condition": "cloudy"}]
# daytime: Saturday day, Sat night, Sun, Sun night, Mon, Mon night, Tue, Tue night
day = {"unit": "°F", "hourly": hourly, "twice_daily": [
    P(True, "2026-11-21T06:00:00-05:00", 65, "cloudy"), P(False, "2026-11-21T18:00:00-05:00", 49, "rainy"),
    P(True, "2026-11-22T06:00:00-05:00", 62, "rainy"), P(False, "2026-11-22T18:00:00-05:00", 50, "cloudy"),
    P(True, "2026-11-23T06:00:00-05:00", 65, "partlycloudy"), P(False, "2026-11-23T18:00:00-05:00", 32, "clear-night"),
    P(True, "2026-11-24T06:00:00-05:00", 51, "sunny"), P(False, "2026-11-24T18:00:00-05:00", 27, "clear-night")]}
v = lambda fc, p, f: forecast_value(fc, st, p, f)  # noqa: E731
ok("now = the current hour (not the station reading)", v(day, "now", "temp") == [58, "°F"])
ok("today high/low/condition/day", (v(day, "today", "high"), v(day, "today", "low"), v(day, "today", "condition"), v(day, "today", "day"))
   == ([65, "°F"], [49, "°F"], "cloudy", "SAT"))
ok("tonight", (v(day, "tonight", "temp"), v(day, "tonight", "high"), v(day, "tonight", "condition")) == ([49, "°F"], None, "rainy"))
ok("+1 day: Sunday, its low the night after it", (v(day, "d1", "day"), v(day, "d1", "high"), v(day, "d1", "low")) == ("SUN", [62, "°F"], [50, "°F"]))
ok("+3 days", (v(day, "d3", "day"), v(day, "d3", "high"), v(day, "d3", "low")) == ("TUE", [51, "°F"], [27, "°F"]))
# late evening: the first period is tonight, so there's no high for today, and +1 is still Sunday
late = dict(day, twice_daily=day["twice_daily"][1:])
ok("late in the day: today has no high", v(late, "today", "high") is None and v(late, "today", "low") == [49, "°F"])
ok("late in the day: +1 is still tomorrow", (v(late, "d1", "day"), v(late, "d1", "low")) == ("SUN", [50, "°F"]))
# Met-style daily
met = {"unit": "°C", "hourly": [], "daily": [
    {"datetime": "2026-11-21T11:00:00+00:00", "temperature": 18, "templow": 11, "condition": "partlycloudy"},
    {"datetime": "2026-11-22T11:00:00+00:00", "temperature": 14, "templow": 10, "condition": "rainy"}]}
ok("daily: today high/low", (v(met, "today", "high"), v(met, "today", "low")) == ([18, "°C"], [11, "°C"]))
ok("daily: tonight = today's low", v(met, "tonight", "temp") == [11, "°C"] and v(met, "tonight", "high") is None)
ok("daily: +1", (v(met, "d1", "day"), v(met, "d1", "condition"), v(met, "d1", "low")) == ("SUN", "rainy", [10, "°C"]))
ok("daily: beyond the forecast -> none", v(met, "d3", "high") is None)
ok("now without an hourly forecast: the entity's reading", v(met, "now", "temp") == [48, "°C"] or v(met, "now", "temp") == [48, "°F"])

print(f"\n{fails} FAILED" if fails else "\nALL PASSED")
sys.exit(1 if fails else 0)
