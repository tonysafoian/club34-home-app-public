# 🎛️ Crestron & Estate Subsystems Integration Guide

Luxury residences often feature centralized **Crestron automation processors** controlling lighting panels, motorized window shades, HVAC, gas fireplaces, and radiant floor heating.

Janus bridges modern web and AI voice control to enterprise Crestron hardware by leveraging Home Assistant as an IP/CIP gateway.

---

## 🏛️ Architecture: Crestron to Janus

```
┌────────────────────────────────┐
│      Crestron Processor        │
│      (CP3 / CP4 / AV4)         │
│  - Centralized Lighting Panels │
│  - Thermostats & Radiant Heat  │
│  - Motorized Shades            │
│  - Gas Fireplace Relays        │
└───────────────┬────────────────┘
                │ Ethernet (Local CIP Protocol)
                ▼
┌────────────────────────────────┐
│      Home Assistant Core       │
│  - Crestron-to-HA Component    │
│  - Digital/Analog Join Mapping │
│  - Normalized `light.*`,       │
│    `climate.*`, `switch.*`     │
└───────────────┬────────────────┘
                │ WebSocket / REST Stream
                ▼
┌────────────────────────────────┐
│      Janus & Janus      │
│  - Interactive Dashboard UI    │
│  - Natural Language Voice AI   │
│  - Multimodal Tool Calling     │
└────────────────────────────────┘
```

---

## 🔌 1. Crestron IP / CIP Bridge Configuration

The Crestron processor communicates with Home Assistant over Ethernet using the **Crestron CIP (Computer Interface Protocol)** on port `41794`:

1. **Crestron SIMPL Windows Program**:
   * Add an **Ethernet Intersystem Communications (EISc)** symbol to your program.
   * Configure the IP address of your Home Assistant server.
   * Assign Digital, Analog, and Serial joins for the circuits you wish to expose.

2. **Home Assistant Configuration (`configuration.yaml`)**:
   ```yaml
   crestron:
     port: 41794
     lights:
       - name: "Primary Bedroom Chandelier"
         type: dimmer
         join: 101
         dim_join: 201
       - name: "Great Room Sconces"
         type: switch
         join: 102
     climate:
       - name: "Primary Bedroom HVAC"
         current_temp_join: 210
         target_temp_join: 211
         mode_join: 212
     switches:
       - name: "Living Room Fireplace"
         join: 105
   ```

---

## 💡 2. Estate Lighting & Scenes

Once bridged into Home Assistant, Crestron lighting circuits appear natively in Janus:
* **Dimmer Sliders**: Real-time slider control for 0–100% lighting levels.
* **Architectural Scenes**: Trigger centralized lighting moods (*"Entertain"*, *"Evening Relax"*, *"Goodnight All Off"*).
* **Govee Architectural Light Integration**: Combine high-voltage Crestron dimmers with low-voltage exterior Govee landscape lighting into unified estate scenes.

---

## 🌡️ 3. Thermostats, Radiant Heat & Fireplaces

### Crestron Horizon & CHV Thermostats
* Monitored across all zones in `/home-systems?section=thermostats`.
* Supports dual setpoint heating/cooling deadbands.

### Radiant Heated Floors & Benches
* Primary bathroom floors, heated towel warmers, and shower bench heating relays are mapped as dedicated climate/switch controls.
* Automated pre-heat schedules configured to warm the bathroom floor 30 minutes before wake-up alarms.

### Gas Fireplace Relays
* Direct millivolt gas fireplace valves connected to Crestron relay modules (e.g. C2N-UNI8IO or DIN-8SW8).
* Safety timeout: Fireplaces automatically shut off after 3 hours of continuous operation if unmonitored.
