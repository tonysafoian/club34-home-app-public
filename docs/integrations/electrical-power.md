# ⚡ Electrical, Backup Generator & Power Telemetry Guide

Household OS treats electricity not merely as a sensor reading, but as a critical operational pillar. This guide explains how to integrate whole-home standby generators, circuit-level wattage monitors, and utility rate tariff schedules.

---

## 🔋 1. Whole-Home Backup Generator (Generac Mobile Link / Genmon)

For estates with standby power systems, Household OS provides real-time generator observability:

### Monitored States & Sensors
| Metric | Entity Pattern | Description |
| :--- | :--- | :--- |
| **Operational Status** | `sensor.generator_status` | `READY`, `RUNNING_UTILITY_LOSS`, `EXERCISING`, or `FAULT`. |
| **Grid Power State** | `binary_sensor.utility_power` | `ON` (Utility Active) or `OFF` (Utility Grid Down). |
| **Transfer Switch** | `sensor.transfer_switch` | `UTILITY` or `STANDBY_GENERATOR`. |
| **Battery Voltage** | `sensor.generator_battery` | Voltage of starter battery (e.g. 13.8V). |
| **Engine RPM & Hours** | `sensor.generator_run_hours` | Cumulative engine runtime for maintenance tracking. |

### Integration Options
1. **Generac Mobile Link**: Connect via Home Assistant's official `generac` cloud integration.
2. **Genmon (Local Modbus/RS-232 Controller)**: For zero-cloud, instant local serial monitoring, connect an RS-232/RS-485 controller to the Generac Evolution/Nexus controller and broadcast telemetry via MQTT.

### Janus Power-Outage Routine
When `utility_power` switches to `OFF`:
1. Janus announces over smart speakers: *"Utility grid failure detected. Standby generator has started."*
2. Household OS triggers load-shedding automations (e.g., turning off pool heaters and lowering secondary AC zones to conserve generator fuel).

---

## ⚡ 2. Circuit-Level Monitoring (Emporia Vue 2/3)

Whole-home CT clamps track power consumption across individual circuits in real time:

### High-Draw Monitored Loads:
- HVAC Heat Pumps & Air Handlers
- Electric Vehicle Wall Connectors (EVSE)
- Pool & Spa Variable Speed Pumps
- Electric Water Heaters & Radiant Heat Floor Relays
- Sub-Panels (Guest House, Detached Garage, AV Server Rack)

### Connecting to Home Assistant:
1. **ESPHome Firmware (Local)**: Flash the Emporia Vue with open-source ESPHome firmware to stream per-second wattage directly over local Wi-Fi.
2. **Emporia Cloud Integration**: Connect using your Emporia cloud credentials.

---

## 💰 3. Utility Rate Tariffs & Billing Insights

Household OS correlates kilowatt-hour consumption with your local electric utility rate structure (e.g., Time-of-Use tariffs):
- **On-Peak vs. Off-Peak Tracking**: Visualized in `/home-systems?section=electricity-cost`.
- **Historical Bill Audits**: Compare utility statements against measured breaker panel data to identify energy anomalies.
