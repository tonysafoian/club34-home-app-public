# ☁️ Cloud Deployment Guide (Railway, Fly.io, Render)

If you prefer hosting the web dashboard and AI orchestrator in the cloud rather than on a local homelab server, this guide outlines the cloud deployment workflow.

---

## 🚂 Option 1: Railway (Easiest)

[Railway](https://railway.app/) provides one-click PostgreSQL with `pgvector`, Redis, and Node.js hosting:

1. Create a new Project on Railway.
2. Add a **PostgreSQL** service. In database settings, execute:
   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   ```
3. Add a **Redis** service.
4. Deploy the GitHub repository [`tonysafoian/janus-home-app`](https://github.com/tonysafoian/janus-home-app).
5. Attach the following Railway environment variables:
   * `DATABASE_URL`: `${{Postgres.DATABASE_URL}}`
   * `REDIS_URL`: `${{Redis.REDIS_URL}}`
   * `PORT`: `5000`
   * `NODE_ENV`: `production`
   * Add your `GEMINI_API_KEY`, `HA_URL`, and `HA_TOKEN`.

Railway will automatically build the React assets and boot the Express server with zero configuration.

---

## 🪰 Option 2: Fly.io

[Fly.io](https://fly.io/) allows deploying applications close to your physical home across edge regions:

1. Install `flyctl`:
   ```bash
   brew install flyctl
   ```
2. Initialize app:
   ```bash
   fly launch
   ```
3. Attach managed Postgres and Redis:
   ```bash
   fly postgres create --vm-size shared-cpu-1x --volume-size 10
   fly redis create
   ```
4. Deploy:
   ```bash
   fly deploy
   ```

---

## 🔗 Connecting Cloud App to Local Smart Home

When Janus is deployed in the cloud:
- **Home Assistant**: Connect via [Nabu Casa Home Assistant Cloud](https://www.nabucasa.com/) (`https://your-id.ui.nabu.casa`) or a Cloudflare Tunnel.
- **Tesla Fleet API**: Tesla requires a public domain with SSL for OAuth callbacks, making cloud hosting ideal.
- **Local Cameras**: Local RTSP streams can be bridged using WebRTC or Tailscale subnet routing.
