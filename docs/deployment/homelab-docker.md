# 🖥️ Self-Hosting with Docker & Homelab Guide

Janus is designed for self-hosting on residential homelab hardware, including:
- **Unraid**
- **Proxmox VE (Debian / Ubuntu VM or LXC)**
- **TrueNAS SCALE**
- **Raspberry Pi 5 (8GB) / Mini PCs (Intel N100, NUC)**

---

## 📦 Production Docker Architecture

A production deployment runs three primary components:
1. **Janus Application Container**: The Node.js Express server + built React SPA.
2. **PostgreSQL 16 + pgvector**: Database with vector search extensions.
3. **Redis 7**: Pub/Sub real-time event cache.

---

## 🚀 Homelab Deployment via Docker Compose

### 1. Create Deployment Directory
```bash
mkdir -p /opt/household-os && cd /opt/household-os
```

### 2. Download Production Compose File
Create `docker-compose.prod.yml`:
```yaml
services:
  app:
    image: ghcr.io/tonysafoian/janus-home-app:latest
    container_name: household-app
    restart: unless-stopped
    ports:
      - "5000:5000"
    env_file:
      - .env
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy

  postgres:
    image: pgvector/pgvector:pg16
    container_name: household-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-change_me_secure_password}
      POSTGRES_DB: household_db
    volumes:
      - /opt/household-os/data/postgres:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d household_db"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    container_name: household-redis
    restart: unless-stopped
    volumes:
      - /opt/household-os/data/redis:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5
```

### 3. Launch Services
```bash
docker compose -f docker-compose.prod.yml up -d
```

---

## 💾 Backup & Data Retention

To ensure your estate notes, member profiles, and historical energy telemetry are safely backed up:

### Automated Daily PostgreSQL Dump
```bash
# Add to crontab: 0 3 * * * (daily at 3:00 AM)
docker exec household-postgres pg_dump -U postgres household_db | gzip > /opt/backups/household_db_$(date +\%F).sql.gz
```
