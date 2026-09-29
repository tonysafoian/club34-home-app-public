#!/usr/bin/env bash
set -e

CONFIG_PATH=/data/options.json

LOG_LEVEL=$(jq -r '.log_level // "info"' "$CONFIG_PATH" 2>/dev/null || echo "info")
ENABLE_DEMO_LOGIN=$(jq -r '.enable_demo_login // true' "$CONFIG_PATH" 2>/dev/null || echo "true")
ENABLE_MOCK_MODE=$(jq -r '.enable_mock_mode // false' "$CONFIG_PATH" 2>/dev/null || echo "false")
GEMINI_KEY=$(jq -r '.gemini_api_key // empty' "$CONFIG_PATH" 2>/dev/null || true)
CUSTOM_DB_URL=$(jq -r '.database_url // empty' "$CONFIG_PATH" 2>/dev/null || true)

echo "===================================================="
echo " 🏛️ Starting Janus Home Automation (v1.0.3)"
echo "===================================================="

# Set up database
if [ -n "$CUSTOM_DB_URL" ]; then
    echo "[janus] Using configured external DATABASE_URL"
    export DATABASE_URL="$CUSTOM_DB_URL"
else
    echo "[janus] No external database configured. Starting embedded PostgreSQL on /data/postgres..."
    export PGDATA=/data/postgres
    mkdir -p "$PGDATA" /run/postgresql
    chown -R postgres:postgres "$PGDATA" /run/postgresql
    chmod 700 "$PGDATA"

    if [ ! -f "$PGDATA/PG_VERSION" ]; then
        echo "[janus] Initializing fresh embedded database cluster..."
        su-exec postgres initdb -D "$PGDATA" -E UTF8
    fi

    echo "[janus] Starting embedded PostgreSQL service..."
    su-exec postgres pg_ctl -D "$PGDATA" -l "$PGDATA/postgres.log" start

    # Wait for postgres readiness
    until su-exec postgres pg_isready -h localhost -p 5432 >/dev/null 2>&1; do
        sleep 1
    done

    # Ensure janus database exists
    su-exec postgres psql -h localhost -U postgres -tc "SELECT 1 FROM pg_database WHERE datname = 'janus_db'" | grep -q 1 || \
        su-exec postgres createdb -h localhost -U postgres janus_db

    export DATABASE_URL="postgres://postgres@localhost:5432/janus_db"
fi

# Auto-configure Home Assistant connection via Supervisor token
if [ -n "$SUPERVISOR_TOKEN" ]; then
    echo "[janus] Supervisor token detected — auto-connecting to Home Assistant Core at http://supervisor/core"
    export HA_URL="http://supervisor/core"
    export HA_TOKEN="$SUPERVISOR_TOKEN"
fi

if [ -n "$GEMINI_KEY" ]; then
    export GEMINI_API_KEY="$GEMINI_KEY"
fi

export PORT=5080
export NODE_ENV=production
export ENABLE_DEMO_LOGIN="$ENABLE_DEMO_LOGIN"
export MOCK_MODE="$ENABLE_MOCK_MODE"

echo "[janus] Applying database migrations..."
node dist/run-migrations.js || npm run migrate || echo "[janus] Note: migration step finished."

echo "[janus] Launching Janus command deck on port $PORT..."
exec node dist/index.js
