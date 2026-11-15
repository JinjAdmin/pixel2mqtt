# pixel2mqtt

A small bridge and web editor for **Govee H6631 52×32 pixel displays running custom firmware** (the `pixeld`
daemon from the govee-pixel-light project). It works like zigbee2mqtt: one container talks to your MQTT
broker and Home Assistant for any number of displays. You get:

- **One MQTT login for every display.** pixel2mqtt publishes Home Assistant discovery and state for each display,
  and forwards commands to it. The displays themselves don't need MQTT credentials.
- **A web editor:**
  - upload GIFs, PNGs (or any image the browser can open) and MP3/WAV/OGG sounds;
  - browse each display's animations, icons and sounds, with previews, then play or delete them;
  - draw on a 52×32 canvas and drag icons around on it;
  - draw new icons and add them to the icon library;
  - see each display's free storage;
  - with **Live on display**, the real panel shows the canvas at about 30 fps while you edit.
- **Built-in artwork import.** One button converts the animations and icons that ship inside the display's own
  firmware (59 animations including 4 clock scenes, plus about 85 icons). The conversion uses a scene renderer
  tuned on real hardware: motion direction, layer order, static items and seamless loops.
  *pixel2mqtt contains no artwork.* It reads the files from your own display and writes the results back to it.

Everything you make is **saved on the display** (`.anim`, `.pxi` and sound files), so the displays keep working
when the container is down.

## Requirements
- One or more H6631 displays with the custom firmware and a `pixeld` that has the LAN API (`api: 1` in
  `http://<display>/api/info`).
- An MQTT broker (e.g. Mosquitto) and Home Assistant with the MQTT integration.
- Docker, or Python ≥ 3.8 to run it directly. It uses no third-party packages.

## Quick start (Docker)
```sh
cp .env.example .env        # set MQTT_HOST / MQTT_USER / MQTT_PASSWORD
docker compose up -d --build
```
Open `http://<server>:8099/`, go to **Displays**, click **Scan the network**, then **Adopt**.

The compose file uses `network_mode: host`. Discovery is a UDP broadcast on port 7778, and the live preview sends
UDP to port 7777 on the display. On a bridge network the broadcast can't reach the displays, so list them in
`PIXEL_HOSTS` instead.

Create a dedicated broker user for pixel2mqtt. With Mosquitto:
`mosquitto_passwd /mosquitto/config/passwd pixel2mqtt`, then restart the broker.

### Without Docker
```sh
python -m pixel2mqtt          # reads .env and ./data (or set PIXEL2MQTT_DATA)
```

## Adopting a display
1. **Adopt** asks the display to show a **6-digit code** on its panel for 2 minutes.
2. Type the code in. The display issues an API token, and pixel2mqtt stores it in `data/devices.json`.
   Keep that file private.
3. Choose the Home Assistant name. New displays get the base topic `pixel2mqtt/<name>/`.
   - **Keep existing entities:** if the display was already using MQTT directly (pixeld's built-in client),
     tick this box. pixel2mqtt then keeps pixeld's own `govee-pixel/…` topics and unique ids, so your entities,
     dashboards and automations keep working. Only one display can use these topics.

While pixel2mqtt is connected, the display's own MQTT client stays off. If pixel2mqtt is gone for **5 minutes**,
the display reconnects to MQTT directly, but only if it still has its own `mqtt.conf`. In that case Home Assistant
keeps working without the container. When pixel2mqtt comes back, it takes over again automatically.

## MQTT / Home Assistant
The topics are pixeld's own, with the base replaced by the display's topic. Some examples:

| Topic | Payload |
|---|---|
| `<topic>/animation/set` | an animation name |
| `<topic>/text/set` | text to scroll |
| `<topic>/notify/set` | text, or JSON `{"message","duration","color","sound","animation"}` |
| `<topic>/weather/set`, `climate/set`, `stock/set`, `score/set` | JSON for the info screens |
| `<topic>/chime/set` | a sound name, optionally with a volume |
| `<topic>/status` | `online` / `offline` (pixel2mqtt sets this) |
| `pixel2mqtt/bridge/state` | `online` / `offline` (last will) |

Every entity's availability depends on both the bridge and the display. An upload or delete updates the
**Animation** and **Sound** dropdowns in Home Assistant within a few seconds.

## Configuration
These are environment variables. `.env` in the working directory and `data/.env` are also read.
`data/config.json` (`{"mqtt": {"host": …}, "hosts": […]}`) works too.

| Variable | Default | |
|---|---|---|
| `MQTT_HOST`, `MQTT_PORT`, `MQTT_USER`, `MQTT_PASSWORD` (`MQTT_PASSWORD_FILE`) | –, 1883 | Without `MQTT_HOST`, pixel2mqtt runs as an editor only |
| `PIXEL2MQTT_BASE` | `pixel2mqtt` | Base topic |
| `HA_DISCOVERY_PREFIX` | `homeassistant` | |
| `WEB_PORT` / `WEB_HOST` | `8099` / `0.0.0.0` | |
| `PIXEL_HOSTS` | – | Comma-separated display IPs (`ip` or `ip:port`) to probe directly |
| `SCAN_INTERVAL` | `120` | Seconds between network scans. Scans also follow DHCP address changes. |

The web UI has **no login**. Like zigbee2mqtt's frontend, it's meant for your LAN only, so don't expose it
through a reverse proxy without adding authentication there.

## How it works
- **Display side (pixeld, port 80):**
  - authenticated HTTP API: `/api/info`, `/api/pair`, `/api/storage`, `/api/files/<anims|icons|sounds>[/<file>]`
    (GET/PUT/DELETE), `/api/res` (read-only stock files), `/api/cmd/<name>`, `/api/frame`;
  - `/api/discovery` returns every MQTT message pixeld would publish itself;
  - `/api/events` is a long-poll of everything it publishes afterwards;
  - discovery answers on UDP 7778, and raw frames go to UDP 7777.
- **pixel2mqtt** mirrors `/api/discovery` and `/api/events` to MQTT. It rewrites topics, unique ids and
  availability on the way, and forwards `<topic>/+/set` to `/api/cmd`.
- Uploads are converted in the container:
  - GIF/PNG → `.anim` (`PXA1`: u16 count, then per frame u16 delay plus 52×32 RGB);
  - GIF/PNG → `.pxi` icons (`PXI1`: w, h, u16 count, then per frame u16 delay plus RGBA);
  - sounds are stored as they are, and the display decodes them on first play.

## Tests
`tests/run_pixeld_host.sh <govee-pixel-light dir> [<copy of a display's /usr/res>]` builds pixeld for x86-64
with a stub panel. It then runs pixeld in an unprivileged user and network namespace with a fake root. The tests
cover the API, pairing, uploads, events, the MQTT bridge (against a tiny in-process broker) and, optionally, the
built-in artwork importer. On Linux it needs `zig` and `unshare`.

## Artwork and licences
Govee's artwork belongs to Govee. pixel2mqtt never ships it, and the `.gitignore` blocks converted files.
Imported artwork stays on your own display.
