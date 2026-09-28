# syntax=docker/dockerfile:1
# Multi-stage Dockerfile for Household OS (Janus)

# ── Stage 1: Build ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and configurations
COPY . .

# Build server bundle (dist/index.js) and frontend assets (dist/public)
RUN npm run build

# ── Stage 2: Production Runner ────────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=5000

# Install runtime utilities (curl for container healthcheck)
RUN apk add --no-cache curl

# Install production dependencies only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy compiled bundles from builder
COPY --from=builder /app/dist ./dist

# Copy migrations and schema files needed by migration runner
COPY --from=builder /app/migrations ./migrations
COPY --from=builder /app/scripts/run-migrations.ts ./scripts/run-migrations.ts
COPY --from=builder /app/tsconfig.json /app/tsconfig.scripts.json ./
COPY --from=builder /app/shared ./shared

# Mount volume for persistent local object storage
VOLUME ["/app/data"]

EXPOSE 5000

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:5000/api/health || exit 1

# Apply migrations on boot, then start the production server
CMD ["npm", "start"]
