# 🏛️ Household OS (Janus)

<div align="center">

**The open-source, AI-orchestrated estate operating system.**

*IoT automation, multi-agent household coordination, electric vehicle fleet management, and long-term semantic memory in a unified residential command deck.*

[![CI & Security Audit](https://github.com/tonysafoian/club34-home-app-public/actions/workflows/ci.yml/badge.svg)](https://github.com/tonysafoian/club34-home-app-public/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Gitleaks: Clean](https://img.shields.io/badge/Security-Gitleaks%20Verified%20(0%20Leaks)-brightgreen.svg)](SECURITY.md)
[![Node.js](https://img.shields.io/badge/Node.js-20+-68a063.svg)](package.json)
[![React](https://img.shields.io/badge/React-18.x-61dafb.svg)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6.svg)](tsconfig.json)
[![Docker Ready](https://img.shields.io/badge/Docker-Compose%20Ready-2496ed.svg)](docker-compose.yml)

[5-Minute Quickstart](QUICKSTART.md) • [Executive Guide (Non-Technical / PDF)](docs/EXECUTIVE_GUIDE.md) • [System Architecture](ARCHITECTURE.md) • [Customization Guide](docs/CUSTOMIZATION.md) • [Mock Mode](docs/MOCK_MODE.md) • [Roadmap](ROADMAP.md)

</div>

---

## 🌟 Why Household OS?

Most residential smart home platforms (Home Assistant, Homebridge, Apple Home) are great at controlling individual switches, but they stop short of being a **true residential operating system**. 

Household OS bridges the gap between hardware telemetry and daily estate operations:

* 🧠 **Janus Voice AI**: A resident AI orchestrator with long-term semantic memory (`pgvector`) that executes real-world actions across connected hardware.
* 🏡 **Interactive Estate Topology**: 2D property floor plans and irrigation maps with clickable zone pins for lighting, HVAC, and valves.
* ⚡ **Electrical & Energy Telemetry**: Generac backup generator monitoring, Emporia Vue 16-channel circuit breaker tracking, utility rate tariffs, and power anomaly insights.
* 🎛️ **Crestron & Estate Lighting**: Centralized Crestron lighting scenes, commercial thermostats, radiant heated floors, and gas fireplaces bridged into Home Assistant.
* 🛡️ **Enterprise Observability**: Real-time monitoring for FortiGate firewalls, Ruckus Wi-Fi, and Verkada/UniFi cameras.
* 🎭 **Batteries-Included Mock Engine**: **No smart home hardware? No problem.** The system automatically simulates telemetry so anyone can run and test the complete app locally.

---

## 📐 System Architecture

```mermaid
flowchart TD
    subgraph Clients["Edge & Mobile Clients"]
        Web[Web PWA Dashboard]
        WallTouch[In-Wall Touchpanels]
        Voice[Voice Audio Stream]
    end

    subgraph Core["Household OS Application Layer"]
        Server[Express App Server :5000]
        WS[WebSocket Real-time Event Hub]
        Janus[Janus AI Tool Orchestrator]
    end

    subgraph Data["Persistence & Event Streaming"]
        PG[(PostgreSQL 16 + pgvector)]
        Redis[(Redis 7 Pub/Sub & Cache)]
    end

    subgraph Hardware["Estate Integrations & Devices"]
        HA[Home Assistant / Nabu Casa]
        Tesla[Tesla Fleet API]
        Pool[iAquaLink / Zodiac Pool]
        Net[FortiGate & Ruckus]
        Cam[Verkada & UniFi Protect]
        LLM[Google Gemini 2.5 / OpenRouter]
    end

    Clients -->|HTTPS / WSS| Core
    Core --> PG
    Core <--> Redis
    Janus -->|pgvector Semantic Retrieval| PG
    Janus -->|Structured Function Calls| LLM
    Core <-->|WebSocket & REST| HA
    Core <-->|OAuth2 API| Tesla
    Core <-->|Cloud API| Pool
    Core <-->|REST & RTSP| Net
    Core <-->|Video RTSP| Cam
```

---

## ⚡ 5-Minute Quickstart

Get Household OS running locally in 3 commands:

```bash
# 1. Clone repository
git clone https://github.com/tonysafoian/club34-home-app-public.git
cd club34-home-app-public

# 2. Boot backing services (PostgreSQL 16 with pgvector, Redis 7, Mosquitto MQTT)
docker compose up -d

# 3. Configure environment, install dependencies, and launch dev server
cp .env.example .env
npm install
npm run migrate
npm run dev
```

Open **[http://localhost:5000](http://localhost:5000)** in your browser!

> [!TIP]
> **Zero Hardware Required**: With default credentials in `.env`, Household OS runs in **Mock Mode**, generating realistic synthetic telemetry for the dashboard, vehicle fleet, and pool equipment.

---

## 📖 Comprehensive Documentation

| Guide | Description |
| :--- | :--- |
| **[EXECUTIVE_GUIDE.md](docs/EXECUTIVE_GUIDE.md)** | **Executive & Non-Technical Guide** — Complete visual overview & printable PDF brochure. |
| **[QUICKSTART.md](QUICKSTART.md)** | Step-by-step local setup, Docker containers, and database seeding. |
| **[LLM_SETUP.md](docs/LLM_SETUP.md)** | **AI & LLM Setup Guide** — Free Gemini API key, OpenRouter, and local Ollama. |
| **[HARDWARE_SETUP.md](docs/HARDWARE_SETUP.md)** | **Home Assistant Hardware & Architecture Guide** — Mini PCs, Zigbee/Z-Wave radios, and estate topology. |
| **[ARCHITECTURE.md](ARCHITECTURE.md)** | Full technical breakdown of frontend, backend, database schema, and Janus AI. |
| **[CUSTOMIZATION.md](docs/CUSTOMIZATION.md)** | **"Bring Your Own Estate"** — How to customize floor plans, SVG maps, members, and zones. |
| **[MOCK_MODE.md](docs/MOCK_MODE.md)** | Guide to zero-hardware simulation and graceful degradation. |
| **[SETUP.md](SETUP.md)** | Detailed production configuration for external APIs and hardware. |
| **[ROADMAP.md](ROADMAP.md)** | Upcoming features: Local Whisper voice, Matter/Thread, and mobile apps. |

### Subsystem Integration Runbooks
* **[AI & LLM Providers (Janus)](docs/LLM_SETUP.md)**: Free Google AI Studio keys, OpenRouter, and local Ollama setup.
* **[Home Assistant Hardware Setup](docs/HARDWARE_SETUP.md)**: Physical hardware tiers, Zigbee/Z-Wave USB coordinators, and network architecture.
* **[Electrical, Backup Power & Energy](docs/integrations/electrical-power.md)**: Generac standby generators, Emporia Vue 16-channel circuit CTs, and utility rate tariffs.
* **[Crestron & Estate Subsystems](docs/integrations/crestron-ha.md)**: Crestron 3/4-series processors, lighting scenes, thermostats, fireplaces, and radiant floor heat.
* **[Home Assistant Core Bridge](docs/integrations/home-assistant.md)**: Token creation, WebSocket event streaming, and entity mapping.
* **[Janus Voice AI](docs/integrations/ai-janus.md)**: Gemini 2.5 Flash, OpenRouter, and local Ollama setup.
* **[Vehicle Fleet](docs/integrations/vehicle-fleet.md)**: Tesla Fleet API developer setup, partner keys, and charging control.
* **[Pool & Spa Hydrology](docs/integrations/pool-spa.md)**: iAquaLink / Zodiac hydrology, heater scheduling, and pump speeds.
* **[Enterprise Network & Surveillance](docs/integrations/enterprise-network.md)**: FortiGate firewalls, Ruckus APs, and Verkada/UniFi cameras.

### Deployment & Self-Hosting
* **[Homelab & Docker Guide](docs/deployment/homelab-docker.md)**: Deploying on Unraid, Proxmox, TrueNAS, and Raspberry Pi 5.
* **[Cloud Hosting](docs/deployment/cloud-deployment.md)**: One-click deployment to Railway, Fly.io, or Render.
* **[Remote Access & SSL](docs/deployment/reverse-proxy-ssl.md)**: Cloudflare Zero Trust Tunnels, Tailscale, and Caddy.

---

## 🔒 Security & Privacy First

* **Zero Historical Credentials**: Created as a clean slate release branch with zero commit history leaks.
* **Gitleaks Pre-Commit Enforcement**: Configured with `.pre-commit-config.yaml` to prevent future secret commits.
* **Role-Based Access Control**: Strict multi-tiered access (`admin`, `family`, `guest`, `staff`).
* **Local-First Architecture**: Your smart home telemetry remains on your local network and database.

---

## 🤝 Contributing

We welcome contributions from smart home enthusiasts, hardware hackers, and AI developers!
1. Check out our **[Contributing Guidelines](CONTRIBUTING.md)** and **[Code of Conduct](CODE_OF_CONDUCT.md)**.
2. Open a **[Hardware Adapter Request](.github/ISSUE_TEMPLATE/device_adapter_request.md)** to add support for new smart home protocols.
3. Submit a Pull Request adhering to our test and Gitleaks security standards.

---

## 📄 License

This project is open-source under the [MIT License](LICENSE).
