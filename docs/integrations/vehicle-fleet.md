# 🚗 Vehicle Fleet & Tesla Fleet API Integration Guide

Household OS provides comprehensive electric vehicle (EV) fleet orchestration, including real-time battery status, cabin pre-conditioning, smart charging schedules, and geofenced estate entry/exit.

---

## 🔑 1. Tesla Developer Portal Setup

Tesla requires developer registration to communicate with vehicles via the modern **Fleet API**:

1. Log into the [Tesla Developer Portal](https://developer.tesla.com/).
2. Create an Application:
   * **Application Name**: `Household OS`
   * **Redirect URI**: `https://yourdomain.com/api/tesla/callback` (or `http://localhost:5000/api/tesla/callback` for local development).
   * **Scopes**:
     * `openid`
     * `offline_access`
     * `vehicle_device_data`
     * `vehicle_cmds`
     * `vehicle_charging_cmds`
3. Note your **Client ID** and **Client Secret**.

---

## 🔐 2. Partner Cryptographic Key Generation

Tesla Fleet API requires a signed public key hosted on your public web domain to authorize end-to-end command dispatch.

Household OS includes an automated key generation endpoint:
```bash
# Generate a new EC prime256v1 keypair via API
curl -X POST http://localhost:5000/api/tesla/setup?action=generate-key \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

This dynamically generates:
- An **EC Private Key** (securely stored in PostgreSQL `tesla_config`).
- A **Public Key PEM**.

Host the public key at your estate's public domain:
```
https://yourdomain.com/.well-known/appspecific/com.tesla.3p.public-key.pem
```

---

## ⚙️ 3. Environment Configuration

Add your Tesla developer credentials to `.env`:

```env
TESLA_CLIENT_ID=your_tesla_client_id
TESLA_CLIENT_SECRET=your_tesla_client_secret
TESLA_REDIRECT_URI=http://localhost:5000/api/tesla/callback
```

---

## ⚡ 4. Supported Features

| Feature | Description |
| :--- | :--- |
| **Battery & Range Telemetry** | Live State of Charge (SoC %), estimated range in miles/km, charging rate (kW). |
| **Climate Pre-Conditioning** | Remotely turn on cabin HVAC, set target temperature, and activate defrost. |
| **Smart Charging Management** | Start/stop charging sessions, set charge limit (e.g. 80%), and schedule off-peak charging. |
| **Security & Physical Controls** | Lock/unlock doors, trigger flash/honk, and toggle Sentry Mode. |

---

## 🔌 5. Non-Tesla Vehicles

Household OS is designed to be vehicle-agnostic:
- **Home Assistant EV Integrations**: If you drive a Rivian, BMW, Ford Mach-E, or Porsche, you can expose their battery and climate entities to Home Assistant. Household OS will map them automatically into the vehicle widget.
- **Enode / Smartcar Bridge**: You can easily implement a custom adapter in `server/routes/vehicles.ts`.
