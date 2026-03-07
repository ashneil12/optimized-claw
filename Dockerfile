FROM node:22-bookworm@sha256:cd7bcd2e7a1e6f72052feb023c7f6b722205d3fcab7bbcbd2d1bfdab10b1e935

# OCI base-image metadata for downstream image consumers.
# If you change these annotations, also update:
# - docs/install/docker.md ("Base image metadata" section)
# - https://docs.openclaw.ai/install/docker
LABEL org.opencontainers.image.base.name="docker.io/library/node:22-bookworm" \
  org.opencontainers.image.base.digest="sha256:cd7bcd2e7a1e6f72052feb023c7f6b722205d3fcab7bbcbd2d1bfdab10b1e935" \
  org.opencontainers.image.source="https://github.com/openclaw/openclaw" \
  org.opencontainers.image.url="https://openclaw.ai" \
  org.opencontainers.image.documentation="https://docs.openclaw.ai/install/docker" \
  org.opencontainers.image.licenses="MIT" \
  org.opencontainers.image.title="OpenClaw" \
  org.opencontainers.image.description="OpenClaw gateway and CLI runtime container image"

# Install Bun (required for build scripts)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

# Pre-download pnpm via corepack with retries (npm registry returns 403 transiently on GH Actions)
RUN for i in 1 2 3 4 5; do corepack prepare pnpm@10.23.0 --activate && break || echo "Retry $i..." && sleep $((i * 5)); done

WORKDIR /app
RUN chown node:node /app

ARG OPENCLAW_DOCKER_APT_PACKAGES=""
RUN if [ -n "$OPENCLAW_DOCKER_APT_PACKAGES" ]; then \
  apt-get update && \
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $OPENCLAW_DOCKER_APT_PACKAGES && \
  apt-get clean && \
  rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
  fi

COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY --chown=node:node ui/package.json ./ui/package.json
COPY --chown=node:node patches ./patches
COPY --chown=node:node scripts ./scripts

USER node
# Reduce OOM risk on low-memory hosts during dependency installation.
# Docker builds on small VMs may otherwise fail with "Killed" (exit 137).
# Retry loop guards against transient npm registry 403s on GH Actions.
RUN for i in 1 2 3 4 5; do NODE_OPTIONS=--max-old-space-size=2048 pnpm install --frozen-lockfile && break || echo "pnpm install retry $i..." && sleep $((i * 10)); done

# Optionally install Chromium and Xvfb for browser automation.
# Build with: docker build --build-arg OPENCLAW_INSTALL_BROWSER=1 ...
# Adds ~300MB but eliminates the 60-90s Playwright install on every container start.
# Must run after pnpm install so playwright-core is available in node_modules.
USER root
ARG OPENCLAW_INSTALL_BROWSER=""
RUN if [ -n "$OPENCLAW_INSTALL_BROWSER" ]; then \
  apt-get update && \
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xvfb && \
  mkdir -p /home/node/.cache/ms-playwright && \
  PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright \
  node /app/node_modules/playwright-core/cli.js install --with-deps chromium && \
  chown -R node:node /home/node/.cache/ms-playwright && \
  apt-get clean && \
  rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
  fi

# Optionally install Docker CLI for sandbox container management.
# Build with: docker build --build-arg OPENCLAW_INSTALL_DOCKER_CLI=1 ...
# Adds ~50MB. Only the CLI is installed — no Docker daemon.
# Required for agents.defaults.sandbox to function in Docker deployments.
ARG OPENCLAW_INSTALL_DOCKER_CLI=""
ARG OPENCLAW_DOCKER_GPG_FINGERPRINT="9DC858229FC7DD38854AE2D88D81803C0EBFCD88"
RUN if [ -n "$OPENCLAW_INSTALL_DOCKER_CLI" ]; then \
  apt-get update && \
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg && \
  install -m 0755 -d /etc/apt/keyrings && \
  # Verify Docker apt signing key fingerprint before trusting it as a root key.
  # Update OPENCLAW_DOCKER_GPG_FINGERPRINT when Docker rotates release keys.
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /tmp/docker.gpg.asc && \
  expected_fingerprint="$(printf '%s' "$OPENCLAW_DOCKER_GPG_FINGERPRINT" | tr '[:lower:]' '[:upper:]' | tr -d '[:space:]')" && \
  actual_fingerprint="$(gpg --batch --show-keys --with-colons /tmp/docker.gpg.asc | awk -F: '$1 == "fpr" { print toupper($10); exit }')" && \
  if [ -z "$actual_fingerprint" ] || [ "$actual_fingerprint" != "$expected_fingerprint" ]; then \
  echo "ERROR: Docker apt key fingerprint mismatch (expected $expected_fingerprint, got ${actual_fingerprint:-<empty>})" >&2; \
  exit 1; \
  fi && \
  gpg --dearmor -o /etc/apt/keyrings/docker.gpg /tmp/docker.gpg.asc && \
  rm -f /tmp/docker.gpg.asc && \
  chmod a+r /etc/apt/keyrings/docker.gpg && \
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable\n' \
  "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/docker.list && \
  apt-get update && \
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  docker-ce-cli docker-compose-plugin && \
  apt-get clean && \
  rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
  fi

# ── Agent CLI tooling ─────────────────────────────────────────────────
# Installed unconditionally — all agents share the gateway container.
#
# Media:      ffmpeg (stream merging), imagemagick (image ops)
# Documents:  pandoc (doc conversion), poppler-utils (pdftotext),
#             ghostscript (PDF manipulation), wkhtmltopdf (HTML→PDF)
# Data:       jq (JSON), sqlite3 (local queries), ripgrep (code search)
# Files:      zip, unzip, wget, rsync, tree
# System:     htop, procps (ps/top)
# Runtime:    python3 + pip (yt-dlp dependency)
RUN apt-get update && \
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  python3 python3-pip \
  ffmpeg imagemagick \
  pandoc poppler-utils ghostscript wkhtmltopdf \
  jq sqlite3 ripgrep \
  zip unzip wget rsync tree \
  htop procps && \
  pip3 install --break-system-packages yt-dlp && \
  apt-get clean && \
  rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

USER node
COPY --chown=node:node . .
# Normalize copied plugin/agent paths so plugin safety checks do not reject
# world-writable directories inherited from source file modes.
RUN for dir in /app/extensions /app/.agent /app/.agents; do \
  if [ -d "$dir" ]; then \
  find "$dir" -type d -exec chmod 755 {} +; \
  find "$dir" -type f -exec chmod 644 {} +; \
  fi; \
  done
RUN pnpm build
# Force pnpm for UI build (Bun may fail on ARM/Synology architectures)
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:build

# Expose the CLI binary without requiring npm global writes as non-root.
USER root
RUN ln -sf /app/openclaw.mjs /usr/local/bin/openclaw \
  && chmod 755 /app/openclaw.mjs

# Install qmd — the local-first memory search sidecar used when
# memory.backend = "qmd" (OPENCLAW_QMD_ENABLED=true).
# Must be installed at build time so the binary is present in the image;
# omitting this causes spawn ENOENT errors every 5 minutes at runtime.
# Uses bun (already installed) to install the package, then creates a shim
# at /usr/local/bin/qmd that runs the TypeScript source via bun run.
RUN /root/.bun/bin/bun install --trust -g https://github.com/tobi/qmd \
  && QMD_SRC=$(find /root/.bun /home -path "*/node_modules/@tobilu/qmd/src/qmd.ts" 2>/dev/null | head -1) \
  && if [ -z "$QMD_SRC" ]; then echo "ERROR: qmd source not found after install" && exit 1; fi \
  && printf '#!/bin/sh\nexec /root/.bun/bin/bun run %s "$@"\n' "$QMD_SRC" > /usr/local/bin/qmd \
  && chmod +x /usr/local/bin/qmd \
  && qmd --version

ENV NODE_ENV=production

# Make our custom entrypoint executable
RUN chmod +x /app/docker-entrypoint.sh

# Pre-bake Honcho memory plugin into the image (patched fork).
# Uses github:ashneil12/openclaw-honcho-multiagent instead of vanilla npm,
# which includes fixes for user message capture, session key routing,
# and OpenClaw message wrapper parsing.
# Installing at build time (as root) ensures correct uid=0 ownership.
# The entrypoint copies it to the data volume on startup, avoiding the
# runtime npm install that creates files with uid=1000 (rejected by the
# plugin scanner as "suspicious ownership").
RUN mkdir -p /app/prebaked-plugins \
  && cd /tmp \
  && git clone --depth=1 https://github.com/ashneil12/openclaw-honcho-multiagent.git honcho-fork \
  && mv honcho-fork /app/prebaked-plugins/openclaw-honcho \
  && cd /app/prebaked-plugins/openclaw-honcho \
  && npm install --omit=dev --ignore-scripts 2>/dev/null \
  && if [ ! -f openclaw.plugin.json ]; then \
  echo '{"id":"openclaw-honcho","kind":"memory","uiHints":{"apiKey":{"label":"Honcho API Key","sensitive":true,"placeholder":"hch-v3-...","help":"API key for Honcho memory service"},"baseUrl":{"label":"Base URL","placeholder":"https://api.honcho.dev","help":"Honcho API base URL","advanced":true},"workspaceId":{"label":"Workspace ID","placeholder":"openclaw","help":"Honcho workspace/app identifier","advanced":true}},"configSchema":{"type":"object","additionalProperties":false,"properties":{"apiKey":{"type":"string"},"baseUrl":{"type":"string"},"workspaceId":{"type":"string"}}}}' > openclaw.plugin.json; \
  fi

# Run entrypoint as root — the gateway process stays root for Docker socket access,
# npm global installs, and Honcho plugin ownership (uid=0 required by plugin scanner).
USER root

# Our custom entrypoint handles config generation, onboarding, model
# enforcement, security file deployment, and permission fixes.
ENTRYPOINT ["/app/docker-entrypoint.sh"]

# Start gateway server with default config.
# Binds to loopback (127.0.0.1) by default for security.
#
# IMPORTANT: With Docker bridge networking (-p 18789:18789), loopback bind
# makes the gateway unreachable from the host. Either:
#   - Use --network host, OR
#   - Override --bind to "lan" (0.0.0.0) and set auth credentials
#
# Built-in probe endpoints for container health checks:
#   - GET /healthz (liveness) and GET /readyz (readiness)
#   - aliases: /health and /ready
# For external access from host/ingress, override bind to "lan" and set auth.
HEALTHCHECK --interval=3m --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:18789/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "openclaw.mjs", "gateway", "--allow-unconfigured"]
