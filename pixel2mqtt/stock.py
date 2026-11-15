"""Import the display's own built-in Govee artwork (from /usr/res on the device) as tuned pixeld assets.

No artwork ships with pixel2mqtt. This module holds only *knowledge*: which stock file becomes which
animation/icon, friendly names, clock-time positions, and (in convert/graffiti.py) the scene renderer with
every fix found on real hardware (motion direction, A=0 = static, item-1-on-top stacking, loop smoothing).
The importer reads the stock files from the device itself, converts them here, and uploads the results.
Verified: converting the stock files of firmware 1.00.91 reproduces the hand-tuned set byte for byte.
"""
import logging

from . import formats
from .convert import anim_convert as ac

log = logging.getLogger("stock")

RES = "/usr/res"

# (stock file under /usr/res, animation name, clock sidecar "cx cy Label" or None)
ANIMATIONS = [
    ("alarm/alarm_clock.gif", "Alarm Clock", None),
    ("awaken/default_effect.txt", "Wake", None),
    ("sleep/default_effect.txt", "Sleep", None),
    ("gif/default_effect.txt", "Neon Heart", None),
    ("load/loading.gif", "Loading Dots", None),
    ("dreamview/Apex victory.txt", "Apex victory", None),
    ("dreamview/Banana.txt", "Banana", None),
    ("dreamview/Blue lucky balls.txt", "Blue lucky balls", None),
    ("dreamview/Danger Approaching.txt", "Danger Approaching", None),
    ("dreamview/Defeat.txt", "Defeat", None),
    ("dreamview/Eliminated.txt", "Eliminated", None),
    ("dreamview/Escaped.txt", "Escaped", None),
    ("dreamview/Fight.txt", "Fight", None),
    ("dreamview/Game Time.txt", "Game Time", None),
    ("dreamview/Gliding.txt", "Gliding", None),
    ("dreamview/Go.txt", "Go", None),
    ("dreamview/Golden lucky balls.txt", "Golden lucky balls", None),
    ("dreamview/Green Shell.txt", "Green Shell", None),
    ("dreamview/Invincible.txt", "Invincible", None),
    ("dreamview/Kill_enemy.txt", "Kill enemy", None),
    ("dreamview/Knocked.txt", "Knocked", None),
    ("dreamview/Ko.txt", "KO", None),
    ("dreamview/lol_loading.txt", "Hourglass", None),
    ("dreamview/Matching.txt", "Blue Wave", None),
    ("dreamview/Med Kit.txt", "Med Kit", None),
    ("dreamview/Merciless Killer.txt", "Merciless Killer", None),
    ("dreamview/Red Shell.txt", "Red Shell", None),
    ("dreamview/Round.txt", "Round 1", None),
    ("dreamview/Shield battery.txt", "Shield battery", None),
    ("dreamview/Three-star.txt", "Three-star", None),
    ("dreamview/Triple Mushrooms.txt", "Triple Mushrooms", None),
    ("dreamview/Victory.txt", "Victory", None),
    ("dreamview/Winning streak.txt", "Winning streak", None),
    ("looplay/default_effect_1.txt", "Number Board", None),
    ("looplay/default_effect_2.txt", "Starry Night", None),
    ("looplay/default_effect_3.txt", "Dragon", None),
    ("looplay/default_effect_4.txt", "Campfire", None),
    ("looplay/default_effect_5.txt", "Winking Smiley", None),
    ("looplay/default_effect_6.txt", "Moon", None),
    ("looplay/default_effect_7.txt", "Coffee Cat", None),
    ("music_mode/beat_1_boxer.gif", "Boxer 1", None),
    ("music_mode/beat_2_boxer.gif", "Boxer 2", None),
    ("music_mode/no_beat_boxer.gif", "Boxer Idle", None),
    ("music_mode/chicken.gif", "Chicken", None),
    ("music_mode/dance.gif", "Dance", None),
    ("music_mode/love_close.gif", "Love Close", None),
    ("music_mode/love_open.gif", "Love Open", None),
    ("music_mode/Pac-man-eating_pot.gif", "Pac-Man", None),   # the other Pac-man-* GIFs are sprite fragments
    ("remind/game_victory.gif", "Game Victory", None),
    ("remind/humidity_high.gif", "Humidity High", None),
    ("remind/humidity_low.gif", "Humidity Low", None),
    ("remind/nba_start.gif", "NBA Start", None),
    ("remind/nfl_start.gif", "NFL Start", None),
    ("remind/temp_high.gif", "Temp High", None),
    ("remind/temp_low.gif", "Temp Low", None),
    # clock scenes: also offered in the "Clock style" select, with the time drawn at (cx, cy)
    ("show_time/LameTa_TimeClock_effect.txt", "Lighthouse", "15 6 Lighthouse"),
    ("show_time/LunHui_TimeClock_effect.txt", "Sunset Rings", "26 16 Sunset Rings"),
    ("show_time/Night_TimeClock_effect.txt", "Blue Rings", "26 16 Blue Rings"),
    ("show_time/Sunny_TimeClock_effect.txt", "Sunflowers", "26 6 Sunflowers"),
]
# not imported: dreamview/Loading.txt (superseded by load/loading.gif), Pac-man sprite fragments

SM = RES + "/show_mode"
# icon name -> stock file (all used by pixeld's info/countdown/stopwatch/analog-clock screens)
ICONS = {
    **{f"wx_{k}": f"{SM}/weather/15x18_{v}.gif" for k, v in
       {"sunny": "sunny", "cloudy": "cloudy", "fog": "fog", "hail": "hail", "rain": "rain", "snow": "snow", "thunder": "thurder_rain"}.items()},
    **{f"wxs_{k}": f"{SM}/weather/{v}_16x12.gif" for k, v in
       {"sunny": "sunny", "cloudy": "cloudy", "fog": "flog", "hail": "hail", "rain": "rain", "snow": "snow", "thunder": "thunderstorm"}.items()},
    "env_temp": f"{SM}/envir/temperature.png",
    "env_hum": f"{SM}/envir/humidity.png",
    "fin_rise": f"{SM}/finance/rise_9x9.png",
    "fin_fall": f"{SM}/finance/fall_9x9.png",
    "fin_flat": f"{SM}/finance/flat_9x9.png",
    "hourglass": f"{SM}/countdown/countdown_hourglass_14x24.gif",
    "stopwatch": f"{SM}/stopwatch/stopwatch_round_50x30.gif",
    "clk_face": f"{SM}/time/clock/clock_face_30x30.png",
    "clk_left": f"{SM}/time/clock/clock_left_5x25.png",
    "clk_right": f"{SM}/time/clock/clock_right_9x25.png",
}
# plus every team logo: show_mode/NFL/team_15x5_<TEAM>.png -> nfl_<team>, NBA/team_20x9_<TEAM>.png -> nba_<team>
TEAM_DIRS = [("NFL", "team_15x5_", "nfl_"), ("NBA", "team_20x9_", "nba_")]


def anim_bytes(stock: bytes) -> bytes:
    return formats.pxa(ac.convert(formats.Blob(stock)))


def icon_bytes(stock: bytes) -> bytes:
    # same as govee-pixel-light/tools/icon_pack.py: GIF black = transparent, PNGs keep their alpha, no resizing
    return formats.pxi(formats.decode(stock, black_transparent=True))


def plan(api):
    """List of (kind, device file name, fetch-and-convert callable) for everything importable from this device."""
    jobs = []
    for src, name, clock in ANIMATIONS:
        jobs.append(("anims", name + ".anim", lambda s=src: anim_bytes(api.res(f"{RES}/{s}"))))
        if clock:
            jobs.append(("anims", name + ".clock", lambda c=clock: (c + "\n").encode()))
    for name, path in sorted(ICONS.items()):
        jobs.append(("icons", name + ".pxi", lambda p=path: icon_bytes(api.res(p))))
    for d, prefix, out in TEAM_DIRS:
        try:
            listing = api.res(f"{SM}/{d}")
        except Exception as e:  # noqa: BLE001 - older/newer firmware may lack a folder
            log.warning("no %s logos: %s", d, e)
            continue
        if not isinstance(listing, list):
            continue
        for ent in sorted(listing, key=lambda e: e["name"]):
            n = ent["name"]
            if n.startswith(prefix) and n.endswith(".png"):
                icon = out + n[len(prefix):-4].lower()
                jobs.append(("icons", icon + ".pxi", lambda p=f"{SM}/{d}/{n}": icon_bytes(api.res(p))))
    return jobs


def run(api, progress=None, overwrite=False):
    """Import everything. progress(done, total, message). Returns {"imported": n, "skipped": n, "failed": [..]}."""
    existing = {}
    for kind in ("anims", "icons"):
        existing[kind] = {f["name"] for f in api.files(kind)}
    jobs = plan(api)
    res = {"imported": 0, "skipped": 0, "failed": []}
    for i, (kind, name, make) in enumerate(jobs):
        if progress:
            progress(i, len(jobs), name)
        if not overwrite and name in existing[kind]:
            res["skipped"] += 1
            continue
        try:
            api.put_file(kind, name, make())
            res["imported"] += 1
        except Exception as e:  # noqa: BLE001 - keep going, report at the end
            log.warning("import %s failed: %s", name, e)
            res["failed"].append(f"{name}: {e}")
    if progress:
        progress(len(jobs), len(jobs), "done")
    return res
