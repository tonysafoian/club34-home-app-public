# Detailed Setup & Deployment Guide

This document walks you through configuring each subsystem of Household OS.

---

## 1. Database Setup (PostgreSQL + pgvector)

Household OS uses PostgreSQL for structured data and `pgvector` for AI semantic memory embeddings.

### Local Development Services with Docker Compose
Household OS provides a `docker-compose.yml` that boots PostgreSQL (with `pgvector`), Redis, and an Eclipse-Mosquitto MQTT broker:

```bash
docker compose up -d
```

Verify `pgvector` is installed:
```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

Run schema migrations:
```bash
npm run migrate
```

---

## 2. Smart Home Integration (Home Assistant)

1. Open Home Assistant → Click your Profile (bottom left) → **Long-Lived Access Tokens**.
2. Create a token named `Household OS`.
3. Add the token and URL to your `.env`:
   ```env
   HA_URL=http://homeassistant.local:8123
   HA_TOKEN=eyJhbGciOi...
   ```

---

## 3. AI Assistant Configuration (Janus)

Janus uses an LLM provider for conversational reasoning and embeddings for memory.

### Required:
- **`GEMINI_API_KEY`**: Obtain from Google AI Studio. Required for `text-embedding-004` long-term semantic memory.
- **`OPENROUTER_API_KEY`**: Obtain from OpenRouter for model routing (or use direct Gemini endpoints).

---

## 4. Vehicle Fleet (Tesla API)

1. Register an application on the [Tesla Developer Portal](https://developer.tesla.com/).
2. Set your redirect URI to:
   ```
   http://localhost:5000/api/tesla/callback
   ```
3. Set `TESLA_CLIENT_ID` and `TESLA_CLIENT_SECRET` in `.env`.

---

## 5. Production Deployment

Household OS runs on any standard Node.js hosting platform (Replit, Render, Railway, Docker, or self-hosted VPS).

### Building for Production:
```bash
npm run build
npm start
```
