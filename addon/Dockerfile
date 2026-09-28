ARG BUILD_FROM=ghcr.io/home-assistant/alpine:3.19
FROM ${BUILD_FROM}

# Install Node.js 20, PostgreSQL 16, and system dependencies
RUN apk add --no-cache \
    nodejs \
    npm \
    postgresql16 \
    postgresql16-contrib \
    bash \
    curl \
    jq \
    su-exec

WORKDIR /app

# Copy dependency manifests
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci

# Copy application code
COPY . .

# Build frontend and server
RUN npm run build

# Make startup script executable
RUN chmod a+x /app/addon/run.sh

WORKDIR /app

EXPOSE 5080

CMD [ "/app/addon/run.sh" ]
