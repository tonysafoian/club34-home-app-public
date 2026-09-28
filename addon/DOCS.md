# 🏛️ Janus Home Automation — Home Assistant Add-on

Janus is the open-source, AI-orchestrated residential estate operating system and executive command deck for Home Assistant.

## Features

- **Ingress Support**: Opens directly inside the Home Assistant left navigation bar.
- **Zero-Config HA Connection**: Uses Home Assistant's internal Supervisor API automatically — no manual token generation needed.
- **Embedded Database**: Runs its own isolated PostgreSQL engine on `/data/postgres` automatically, or connects to your external PostgreSQL instance.
- **AI Concierge & Tools**: Resident intelligence with 40+ estate tools (Home Assistant device control, electricity, water, security, travel, fleet).
- **1-Click Test Mode**: Instant local demo login without setting up Google/Apple OAuth.

## Installation

1. Add this repository to your Home Assistant Add-on Store:
   - Navigate to **Settings ➔ Add-ons ➔ Add-on Store ➔ ⋮ (top right) ➔ Repositories**.
   - Add: `https://github.com/tonysafoian/janus-home-app`
2. Find **Janus** in the add-on list and click **Install**.
3. Toggle **Show in sidebar**.
4. Click **Start**, then click **Open Web UI** (or select Janus from your sidebar).

## Configuration Options

```yaml
enable_demo_login: true
enable_mock_mode: false
gemini_api_key: ""
database_url: ""
```

- `enable_demo_login`: Displays the 1-click Demo / Local Test button on the login screen (default: `true`).
- `enable_mock_mode`: Generates simulated hardware telemetry for offline testing (default: `false`).
- `gemini_api_key`: (Optional) Google Gemini API key to enable Janus Voice AI and autonomous reasoning.
- `database_url`: (Optional) External PostgreSQL connection string. If left blank, Janus uses its built-in embedded PostgreSQL database on `/data/postgres`.
