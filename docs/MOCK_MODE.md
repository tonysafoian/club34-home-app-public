# 🎭 Mock Mode & Graceful Hardware Degradation

One of the greatest obstacles when developing or contributing to smart home software is the hardware dependency barrier: **most developers do not own the exact mix of smart home controllers, vehicle models, or enterprise cameras that a system integrates with.**

Janus solves this with an integrated **Mock Engine and Graceful Degradation Framework**.

---

## 💡 How Graceful Degradation Works

Every hardware connector in Janus checks for valid credentials upon startup. If a credential or endpoint is missing:
1. **The application never crashes or halts**.
2. Unconfigured hardware routes switch into **Simulated / Mock Mode**.
3. Realistic, synthetic state data is streamed to the dashboard so UI components, animations, and controls function seamlessly.

---

## 📊 Subsystem Mock Behavior Matrix

| Subsystem | Required Credentials | Behavior When Unset |
| :--- | :--- | :--- |
| **Home Assistant** | `HA_URL`, `HA_TOKEN` | Generates simulated lighting groups, HVAC zones (70°F), and solar generation graphs (8.4 kW). Toggle switches respond optimistically. |
| **Tesla Fleet API** | `TESLA_CLIENT_ID`, `TESLA_CLIENT_SECRET` | Displays a simulated electric vehicle (82% SoC, 280 miles range, 68°F cabin). Climate start/stop actions simulate state changes. |
| **Pool & Spa (iAquaLink)** | `IAQUALINK_API_KEY`, `IAQUALINK_USERNAME` | Generates a simulated 82°F pool, 101°F spa, 2,400 RPM variable speed pump, and salt chlorinator status. |
| **Verkada & UniFi Cameras** | Camera API Tokens / RTSP URLs | Displays high-resolution estate placeholder camera snapshots with timestamp overlays. |
| **Enterprise Network** | `FORTIGATE_API_TOKEN`, `RUCKUS_PASSWORD` | Generates synthetic throughput metrics (Gigabit fiber load, 34 connected Wi-Fi clients). |
| **Janus Voice AI** | `GEMINI_API_KEY` | Generates structured text responses and mock system actions for testing tool routing without consuming API tokens. |

---

## 🛠️ Testing Scenarios Using Mock Mode

### Scenario A: Full Offline / Airplane Development
You can develop UI components, test responsive layouts, or build new feature pages completely offline:
1. Ensure Docker is running PostgreSQL and Redis.
2. Leave all external API keys blank in `.env`.
3. Run `npm run dev`.
4. The entire dashboard is interactive with realistic dummy data.

### Scenario B: Hybrid Development (Real HA + Mock Tesla)
If you have a local Home Assistant instance but do not have a Tesla developer account:
1. Fill in `HA_URL` and `HA_TOKEN`.
2. Leave `TESLA_CLIENT_ID` blank.
3. The dashboard will control your real lights and thermostats while rendering the simulated Tesla fleet widget.

---

## 🧪 Unit Testing with Vitest
Mock mode is also used by our automated test suite in `server/lib/__tests__/`. Tests execute against in-memory fixture generators, ensuring fast, deterministic CI pipeline runs without network calls.
