# Household OS (Janus) 🏛️

An executive-grade, AI-powered Smart Home and Household Operating System built with React, Node.js, Express, Drizzle ORM, and PostgreSQL with `pgvector`.

![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat&logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React-20232A?style=flat&logo=react&logoColor=61DAFB)
![Express](https://img.shields.io/badge/Express-000000?style=flat&logo=express&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-316192?style=flat&logo=postgresql&logoColor=white)
![Home Assistant](https://img.shields.io/badge/Home_Assistant-41BDF5?style=flat&logo=home-assistant&logoColor=white)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)

---

## Architecture Overview

```
                      ┌────────────────────────────────────────┐
                      │    Household OS Web UI (React + Vite)   │
                      │  Dashboard · Security · Family · Admin │
                      └───────────────────┬────────────────────┘
                                          │ HTTP / WebSocket
                                          ▼
                      ┌────────────────────────────────────────┐
                      │         Express.js API Backend         │
                      │   Auth · Tools · Webhooks · Automation │
                      └───────┬───────────────┬────────────────┘
                              │               │
            ┌─────────────────┴────┐     ┌────┴─────────────────┐
            │ PostgreSQL (Drizzle) │     │   Janus AI Engine    │
            │ + pgvector (Memory)  │     │ Gemini / OpenRouter  │
            └──────────────────────┘     └────┬─────────────────┘
                                              │
     ┌──────────────────┬─────────────────────┼──────────────────┬─────────────────┐
     ▼                  ▼                     ▼                  ▼                 ▼
Home Assistant     Tesla Fleet       Network Monitoring      Messaging         Security
(Lights/Climate)   (EV Charging)     (Firewall / Wi-Fi)    (WhatsApp/Email)   (Cameras/Gate)
```

---

## Key Features

### 1. Unified Smart Home Control
- **Home Assistant Bridge:** Real-time visibility and service calls for lights, smart locks, switches, and multi-zone HVAC.
- **EV Fleet Management:** Telemetry, charge limits, battery range alerts, and arrival/departure logging via the Tesla Fleet API.
- **Network Observability:** Firewall interface health, SD-WAN failover tracking, and wireless client load.
- **Energy & Circuit Monitoring:** Daily circuit snapshots and utility tracking.

### 2. Janus: Multimodal AI Assistant with Long-Term Memory
- **Semantic Memory:** Automatically stores and recalls household preferences, facts, and past conversations using Google `text-embedding-004` and PostgreSQL `pgvector`.
- **Multichannel Communication:** Native web chat, WhatsApp two-way bot via webhooks, and inbound email parsing and triage.
- **Tool Execution Engine:** Schema-validated tool execution for calendar scheduling, search, device control, and briefing creation.

### 3. Family Operations & Automation
- **Morning Briefing:** Automated daily weather, air quality, wardrobe recommendations, and schedule digest.
- **Household Routines:** Automated closet light timeouts, bathroom fan timers, and climate range alerts.
- **Time & Contractor Management:** Contractor hours logging, expense tracking, and weekly payment approvals.
- **Community Sports & Pickup Hub:** Complete pickup basketball scheduling platform with player roster tokens, versioned legal e-waiver signing, RSVP tracking, and calendar export.

---

## Quickstart Guide

### Prerequisites
- **Node.js** (v20+ recommended)
- **PostgreSQL** (v15+ with the `pgvector` extension enabled)
- (Optional) **Home Assistant** instance for smart home features

### 1. Clone & Install
```bash
git clone https://github.com/tonysafoian/club34-home-app-public.git
cd club34-home-app-public
npm install
```

### 2. Configure Environment Variables
Copy the example configuration:
```bash
cp .env.example .env
```
Edit `.env` and set your `DATABASE_URL` and `JWT_SECRET`:
```env
DATABASE_URL=postgres://username:password@localhost:5432/household_db
JWT_SECRET=your-random-32-byte-secret-key
```

### 3. Initialize the Database
Push the schema migrations to PostgreSQL:
```bash
npm run db:push
```

### 4. Run Development Server
```bash
npm run dev
```
Open [http://localhost:5000](http://localhost:5000) in your browser.

---

## Graceful Degradation & Mock Mode

Household OS is designed modularly. If you do not configure an integration (such as Tesla, Verkada, or FortiGate), the application gracefully disables those endpoints and continues operating without errors.

---

## Documentation

- [SETUP.md](SETUP.md): Detailed installation guide, database setup, and provider credential configuration.
- [EXTERNAL_API.md](EXTERNAL_API.md): Read/write HTTP API specifications for third-party integrations and smart devices.
- [CONTRIBUTING.md](CONTRIBUTING.md): Guidelines for submitting pull requests and reporting issues.

---

## License

This project is licensed under the [MIT License](LICENSE).
