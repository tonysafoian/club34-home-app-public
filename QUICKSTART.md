# 🚀 Janus — 5-Minute Quickstart

Get Janus running on your local machine in under five minutes.

---

## ⚡ Prerequisites

Before you begin, ensure you have installed:
- [Node.js](https://nodejs.org/) (version **20.x** or higher)
- [npm](https://docs.npmjs.com/) or [pnpm](https://pnpm.io/)
- [Docker](https://www.docker.com/) & Docker Compose (for PostgreSQL, Redis, and MQTT)
- [Git](https://git-scm.com/)

> [!TIP]
> **No smart home hardware? No problem!** Janus includes a comprehensive **Mock Engine**. If you do not configure Home Assistant, Tesla, or pool hardware, the platform automatically generates simulated telemetry so you can test all features immediately.

---

## 🛠️ Step-by-Step Setup

### 1. Clone the Repository
```bash
git clone https://github.com/tonysafoian/janus-home-app.git
cd janus-home-app
```

### 2. Boot Local Backing Services
Start PostgreSQL 16 with `pgvector`, Redis 7, and the Mosquitto MQTT broker:
```bash
docker compose up -d
```

Verify that the containers are healthy:
```bash
docker compose ps
```

You should see:
- `household-postgres` on port `5432` (healthy)
- `household-redis` on port `6379` (healthy)
- `household-mqtt` on port `1883` (healthy)

### 3. Configure Your Environment
Copy the example environment template:
```bash
cp .env.example .env
```

The default values in `.env.example` are pre-configured to connect to the local Docker containers:
```env
PORT=5000
DATABASE_URL=postgres://postgres:postgres@localhost:5432/household_db
PUBLIC_BASE_URL=http://localhost:5000
```

*(Optional)* If you want to enable the AI Executive Assistant (Janus), add your Google AI Studio API key:
```env
GEMINI_API_KEY=your_gemini_api_key_here
```

### 4. Install Dependencies & Push Database Schema
```bash
# Install npm dependencies
npm install

# Push the schema migrations to PostgreSQL
npm run migrate
```

### 5. Seed Example Data (Optional)
To populate sample family profiles and sports roster data:
```bash
# Seed sample household members
docker exec -i household-postgres psql -U postgres -d household_db < scripts/seed-household-members.example.sql
```

### 6. Launch the Server
```bash
npm run build
npm start # or npm run dev
```

Open **[http://localhost:5000](http://localhost:5000)** (or your configured port).

> [!TIP]
> **No OAuth Setup Required for Testing!**
> On the login screen, click **`[⚡ Enter Demo / Local Test Mode]`**. This immediately signs you in as an Admin with full access to the command deck, mock telemetry, system controls, and settings without configuring Google or Apple OAuth credentials.

---

## 📦 Option B: Install as a Home Assistant Add-on (1-Click)

If you run **Home Assistant OS** or **Supervised**:

1. In Home Assistant, go to **Settings ➔ Add-ons ➔ Add-on Store**.
2. Click the three dots **⋮** in the top right ➔ **Repositories**.
3. Add repository: `https://github.com/tonysafoian/janus-home-app`
4. Find **Janus** in the store list and click **Install**.
5. Toggle **Show in sidebar**, click **Start**, and enjoy! Janus will automatically discover Home Assistant and embed itself in your sidebar.

---

## 🎯 Exploring the Dashboard

1. **Bypass Login**: Click `Enter Demo / Local Test Mode` on the welcome screen.
2. **Dashboard Home**: View real-time weather, estate zones, and active household status.
3. **Janus AI Assistant**: Tap the microphone icon or press `Space` to speak with Janus.
3. **Estate Systems**: Explore HVAC thermostats, lighting groups, and water/irrigation maps.
4. **Pool & Spa**: Monitor water temperatures, heater status, and filter pump cycles.
5. **Vehicle Fleet**: View simulated battery telemetry and vehicle climate status.
6. **Electrical & Energy Telemetry**: Monitor solar production, backup generator status, and real-time circuit power draw.

---

## 🧪 Running Automated Tests

```bash
# Run unit and integration tests with Vitest
npm test

# Run Gitleaks secret verification
gitleaks dir --verbose
```

---

## 📚 What to Read Next

- [LLM_SETUP.md](docs/LLM_SETUP.md) — Free Google Gemini key setup, OpenRouter, and local Ollama guide.
- [HARDWARE_SETUP.md](docs/HARDWARE_SETUP.md) — Home Assistant hardware requirements, Zigbee/Z-Wave USB coordinators, and network architecture.
- [CUSTOMIZATION.md](docs/CUSTOMIZATION.md) — How to adapt the floor plan SVG, household members, and zones for your own estate.
- [MOCK_MODE.md](docs/MOCK_MODE.md) — How the graceful degradation and hardware simulation work.
- [SETUP.md](SETUP.md) — Connecting physical Home Assistant, Tesla, and camera hardware.
- [ARCHITECTURE.md](ARCHITECTURE.md) — Deep dive into the dataflow, database schemas, and AI memory architecture.
