ARG BUILD_FROM=ghcr.io/home-assistant/alpine:3.19
FROM ${BUILD_FROM}

LABEL \
    io.hass.version="1.0.5" \
    io.hass.type="addon" \
    io.hass.arch="aarch64|amd64" \
    org.opencontainers.image.title="Janus" \
    org.opencontainers.image.description="AI-orchestrated residential estate operating system and command deck." \
    org.opencontainers.image.source="https://github.com/tonysafoian/janus-home-app" \
    org.opencontainers.image.licenses="Apache-2.0"

# Install Node.js 20, PostgreSQL 16 server & client, git, and system dependencies
RUN (grep -q community /etc/apk/repositories || echo "https://dl-cdn.alpinelinux.org/alpine/v3.19/community" >> /etc/apk/repositories) && \
    apk update && \
    apk add --no-cache \
    nodejs \
    npm \
    git \
    postgresql16 \
    postgresql16-client \
    postgresql16-contrib \
    bash \
    curl \
    jq \
    su-exec && \
    (apk add --no-cache postgresql-pgvector || apk add --no-cache pgvector || true)

WORKDIR /app

# Home Assistant executes docker build with the add-on subdirectory (janus/) as context.
# Clone the repository directly so all pre-built bundles, migrations, and manifests are present.
# BUILD_VERSION busts Docker layer caching on version bumps.
ARG BUILD_VERSION="1.0.5"
ARG REPO_URL="https://github.com/tonysafoian/janus-home-app.git"
RUN git clone --depth 1 -b main "${REPO_URL}" /tmp/repo && \
    cp -r /tmp/repo/* /app/ && \
    cp -r /tmp/repo/.* /app/ 2>/dev/null || true && \
    rm -rf /tmp/repo

# Install production runtime dependencies only (fast, reliable, no compiler needed)
RUN npm ci --omit=dev

# Make startup script executable
RUN chmod a+x /app/janus/run.sh

EXPOSE 5080

CMD [ "/app/janus/run.sh" ]
