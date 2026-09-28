# 🏠 Home Assistant Integration Guide

Janus acts as an executive command layer on top of [Home Assistant](https://www.home-assistant.io/), providing high-level scene orchestration, estate mapping, and conversational voice control.

---

## 🔑 1. Generating a Long-Lived Access Token

To connect Janus to your Home Assistant instance:

1. Log into your Home Assistant web dashboard.
2. Click on your user profile icon (bottom-left corner of the sidebar).
3. Scroll down to the **Long-Lived Access Tokens** section.
4. Click **Create Token**.
5. Give the token a descriptive name, such as `Household-OS`.
6. Copy the generated token string immediately.

---

## ⚙️ 2. Environment Configuration

Add your Home Assistant URL and token to `.env`:

```env
# If running on the same local network:
HA_URL=http://homeassistant.local:8123

# If running remotely via Nabu Casa Home Assistant Cloud:
HA_URL=https://your-unique-id.ui.nabu.casa

# The token generated in Step 1:
HA_TOKEN=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

---

## 📡 3. Communication Architecture

Janus uses a hybrid **WebSocket + REST** protocol:

1. **Persistent WebSocket (`/api/websocket`)**:
   - Subscribes to the `state_changed` event stream.
   - Any physical switch flicked, door sensor opened, or temperature shift in your home is streamed to Janus in real time and pushed to the browser dashboard via WebSocket.

2. **REST API (`/api/services/<domain>/<service>`)**:
   - Used for executing service commands (e.g. `light.turn_on`, `climate.set_temperature`, `cover.close_cover`).

---

## 🏷️ 4. Entity Mapping

Janus automatically groups Home Assistant entities by domain:

| Domain | Supported Features |
| :--- | :--- |
| `light.*` | On/off, brightness slider, RGB color picker, color temperature. |
| `switch.*` | On/off toggles (appliances, pumps, landscape lighting). |
| `climate.*` | Current temperature, target temperature, HVAC mode (Heat/Cool/Auto/Off), fan speed. |
| `cover.*` | Motorized shades, garage doors, motorized gates (Open/Close/Stop, position percentage). |
| `sensor.*` | Power consumption (kW), solar production, water flow rates, humidity, battery levels. |
| `media_player.*` | Play/pause, volume slider, track metadata, speaker grouping (Sonos, AirPlay). |

---

## 🛠️ Troubleshooting

* **Connection Refused**: Ensure that the Home Assistant machine allows HTTP/WebSocket traffic from your server's IP address. If using Docker, check that `HA_URL` uses the host's actual IP address rather than `127.0.0.1` (since `127.0.0.1` inside a container refers to the container itself).
* **SSL / TLS Errors**: If using a self-signed certificate on your local Home Assistant, configure Node.js with `NODE_TLS_REJECT_UNAUTHORIZED=0` in development (never in production).
