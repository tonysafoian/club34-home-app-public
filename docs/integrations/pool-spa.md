# 🏊 Pool & Spa (Hydrology & Climate) Integration Guide

Janus provides dedicated management for residential swimming pools, spas, solar heating loops, and water features.

---

## 🌊 1. iAquaLink / Zodiac Setup

Janus includes native support for Zodiac / Jandy iAquaLink systems via cloud API:

1. Locate your iAquaLink web login credentials (the same username and password used in the mobile app).
2. Add them to `.env`:
   ```env
   IAQUALINK_USERNAME=your_email@example.com
   IAQUALINK_PASSWORD=your_iaqualink_password
   IAQUALINK_API_KEY=your_optional_api_key_or_leave_blank
   ```

---

## 🎛️ 2. Managed Systems & Telemetry

When connected, the Pool & Spa dashboard (`/iaqualink`) provides:

| Metric / Control | Functionality |
| :--- | :--- |
| **Water Temperatures** | Live pool and spa temperatures; target temperature sliders (e.g. Spa to 102°F). |
| **Heater Selection** | Toggle between Gas Heater, Heat Pump, and Solar Heating valves. |
| **Variable Speed Pumps** | Real-time RPM monitoring, energy wattage draw, and cleaning/filtration speed presets. |
| **Auxiliary Water Features** | Instant toggles for waterfalls, sheer descents, spa jets, and bubblers. |
| **Sanitization & Chemistry** | Salt level (ppm), chlorinator output percentage, and sanitization cycle times. |

---

## 🤖 3. Intelligent Automation Rules

Janus can automate pool and spa routines using contextual sensors:
- **Solar Optimization**: Only activate solar heating valves when ambient roof temperature exceeds pool water temperature by > 8°F.
- **Smart Spa Pre-Heat**: Voice command *"Janus, heat up the spa"* sets target to 102°F, turns on spa jets, and notifies the resident via mobile notification when the target temperature is reached.
- **Freeze Protection**: Automatically engages low-speed pump circulation if ambient temperature drops below 34°F.

---

## 🔄 4. Connecting Pentair, Hayward, or Custom Controllers

If your estate uses Pentair IntelliCenter or Hayward OmniLogic:
1. Connect the system to your Home Assistant instance using the respective Home Assistant integration (e.g., `pentair`, `hayward_omnilogic`).
2. Janus will automatically discover the `climate.*` and `switch.*` entities and surface them on the main dashboard.
